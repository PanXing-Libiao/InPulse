import { SearchProjectionCapacityError } from "../modules/search/search-projection.write-port.js";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  schemaRegistry,
  taskCompletionRequestSchema,
  taskCompletionResponseSchema,
} from "@inpulse/api-contract";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
} from "../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../idempotency/http-service.js";
import { TaskManagementError } from "../modules/tasks/index.js";
import { RecordDraftError } from "../modules/change-records/index.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { TaskCompletionWorkflow } from "./task-completion.workflow.js";
export interface CompletionHttpRequest {
  params: unknown;
  query?: unknown;
  body: unknown;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
@Injectable()
export class TaskCompletionHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TaskCompletionWorkflow)
    private readonly workflow: TaskCompletionWorkflow,
  ) {}
  async handle(request: CompletionHttpRequest) {
    const requestId = randomUUID();
    try {
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new TaskManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源校验",
        );
      const path = schemaRegistry.TaskCompletionPath.schema.safeParse(
          request.params,
        ),
        body = taskCompletionRequestSchema.safeParse(request.body),
        headers = schemaRegistry.RecordDraftVersionHeaders.schema.safeParse({
          "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
          "if-match": getHeader(request.headers, "if-match"),
        });
      if (
        !path.success ||
        !body.success ||
        !headers.success ||
        Object.keys(request.query ?? {}).length
      )
        throw new TaskManagementError(
          422,
          "TASK_COMPLETION_VALIDATION_FAILED",
          "请检查完成方式、任务版本和记录内容",
        );
      if (
        Number(headers.data["if-match"].slice(1, -1)) !==
        body.data.expectedRowVersion
      )
        throw new TaskManagementError(
          422,
          "TASK_COMPLETION_VERSION_MISMATCH",
          "任务版本头与请求内容必须一致",
        );
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new TaskManagementError(
          400,
          "TASK_CONTENT_TYPE_INVALID",
          "请使用 application/json",
        );
      const actor = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new TaskManagementError(
            401,
            "TASK_SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
        await this.workflow.authorize(tx, actor.userId, path.data.taskId);
        return actor.userId;
      };
      const result = await this.idempotency.run({
        operationId: "completeTask",
        actorId: actor,
        request: {
          method: "POST",
          path: "/tasks/{taskId}/complete",
          pathParams: { taskId: String(path.data.taskId) },
          query: {},
          headers: request.headers,
          body: body.data,
        },
        execute: async (tx, actorId) => {
          const response = await this.workflow.execute(
              tx,
              actorId,
              path.data.taskId,
              body.data,
              requestId,
            ),
            record = response.record,
            task = response.task;
          return {
            responseStatus: 200,
            responseSchemaRef: "TaskCompletionResponse",
            responseHasBody: true,
            responseBody: response,
            replayAuthContext: {
              projectId: task.projectId,
              moduleId: task.moduleId,
              featureId: task.featureId,
              taskId: task.id,
              impactFeatureIds:
                "impactFeatureIds" in task ? task.impactFeatureIds : [],
              record: record
                ? {
                    projectId: record.projectId,
                    recordId: record.id,
                    moduleId: record.moduleId,
                    featureId: record.featureId,
                    taskId: record.taskId,
                    impactFeatureIds: record.impactFeatureIds,
                    leftoverItemIds: record.leftovers.map(
                      (leftover) => leftover.id,
                    ),
                  }
                : null,
            },
          };
        },
        replayAuthorizer: async (record, tx) =>
          this.workflow.replay(
            tx,
            await actor(tx),
            path.data.taskId,
            record.replayAuthContext,
          ),
      });
      return {
        status: result.responseStatus,
        body: taskCompletionResponseSchema.parse(result.responseBody),
      };
    } catch (error) {
      const known =
        error instanceof TaskManagementError ||
        error instanceof RecordDraftError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof SearchProjectionCapacityError ||
        error instanceof IdempotencyHttpError;
      return {
        status: known ? error.status : 500,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code: known ? error.code : "INTERNAL_ERROR",
          message: known
            ? error.message
            : "暂时无法完成任务，未完成的操作已回滚",
          details: {},
          requestId,
        }),
      };
    }
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  routeRegistry,
  schemaRegistry,
  taskStatusRequestSchema,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../database/transaction-context.js";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
} from "../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../idempotency/http-service.js";
import {
  TaskStatusCommandPort,
  TaskManagementError,
  type TaskStatusResource,
} from "../modules/tasks/index.js";
import { RecordDraftError } from "../modules/change-records/index.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import { TaskCompletionWorkflow } from "./task-completion.workflow.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
export type CompatibilityStatusOperation =
  "transitionTask" | "transitionModuleTask";
/** Legacy envelopes remain unchanged; COMPLETE shares the new cross-domain transaction. */
@Injectable()
export class TaskStatusCompatibilityHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TaskCompletionWorkflow)
    private readonly completion: TaskCompletionWorkflow,
    @Inject(TaskStatusCommandPort)
    private readonly statuses: TaskStatusCommandPort,
  ) {}
  async handle(
    operation: CompatibilityStatusOperation,
    request: CompletionHttpRequest,
  ) {
    const requestId = randomUUID();
    try {
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new TaskManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const route = routeRegistry.find(
          (route) => route.operationId === operation,
        )!,
        moduleScope = operation === "transitionModuleTask";
      if (route.request.path === "none" || route.request.headers === "none")
        throw Error("Status contract incomplete");
      const parsedPath = schemaRegistry[route.request.path].schema.safeParse(
          request.params,
        ),
        parsedHeaders = schemaRegistry[route.request.headers].schema.safeParse({
          "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
          "if-match": getHeader(request.headers, "if-match"),
        }),
        parsedCommand = taskStatusRequestSchema.safeParse(request.body);
      if (
        !parsedPath.success ||
        !parsedHeaders.success ||
        !parsedCommand.success ||
        Object.keys(request.query ?? {}).length
      )
        throw new TaskManagementError(
          422,
          "TASK_VALIDATION_FAILED",
          "请检查状态命令与版本",
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
          "请求必须使用 application/json",
        );
      const resource = {
          ...(parsedPath.data as TaskStatusResource),
          ...(moduleScope ? { featureId: null } : {}),
        },
        command = parsedCommand.data;
      const actor = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new TaskManagementError(
            401,
            "TASK_SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
        const actual = await this.completion.authorize(
          tx,
          actor.userId,
          resource.taskId,
        );
        if (
          actual.projectId !== resource.projectId ||
          actual.moduleId !== resource.moduleId ||
          actual.featureId !== resource.featureId
        )
          throw new TaskManagementError(
            404,
            "TASK_NOT_FOUND",
            "任务不存在或无法访问",
          );
        if (command.action !== "COMPLETE")
          await this.statuses.authorize(tx, actor.userId, resource);
        return actor.userId;
      };
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: actor,
        request: {
          method: "POST",
          path: route.path,
          pathParams: Object.fromEntries(
            Object.entries(resource)
              .filter(([, value]) => value !== null)
              .map(([key, value]) => [key, String(value)]),
          ),
          query: {},
          headers: request.headers,
          body: command,
        },
        execute: async (tx, actorId) => {
          const version = Number(
            getHeader(request.headers, "if-match")!.slice(1, -1),
          );
          const task =
            command.action === "COMPLETE"
              ? (
                  await this.completion.execute(
                    tx,
                    actorId,
                    resource.taskId,
                    {
                      mode: "WITHOUT_RECORD",
                      expectedRowVersion: version,
                      completionReason: command.completionReason,
                      note: command.note,
                    },
                    requestId,
                  )
                ).task
              : await this.statuses.apply(
                  tx,
                  actorId,
                  resource,
                  version,
                  command,
                  requestId,
                );
          return {
            responseStatus: 200,
            responseSchemaRef: moduleScope ? "ModuleTaskItem" : "TaskItem",
            responseHasBody: true,
            responseBody: task,
            replayAuthContext: {
              projectId: task.projectId,
              moduleId: task.moduleId,
              featureId: task.featureId,
              taskId: task.id,
              impactFeatureIds:
                "impactFeatureIds" in task ? task.impactFeatureIds : [],
              completion: command.action === "COMPLETE",
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await actor(tx),
            saved =
              schemaRegistry.TaskStatusCompatibilityReplayContext.schema.parse(
                record.replayAuthContext,
              );
          if (
            saved.taskId !== resource.taskId ||
            saved.projectId !== resource.projectId ||
            saved.moduleId !== resource.moduleId ||
            saved.featureId !== resource.featureId ||
            saved.completion !== (command.action === "COMPLETE")
          )
            throw new TaskManagementError(
              404,
              "TASK_NOT_FOUND",
              "任务不存在或无法访问",
            );
          if (saved.completion) {
            const { completion: _completion, ...resources } = saved;
            await this.completion.replay(tx, actorId, resource.taskId, {
              ...resources,
              record: null,
            });
          } else
            await this.statuses.replay(tx, actorId, {
              projectId: saved.projectId,
              moduleId: saved.moduleId,
              taskId: saved.taskId,
              ...(moduleScope
                ? { impactFeatureIds: saved.impactFeatureIds }
                : { featureId: saved.featureId }),
            });
        },
      });
      return {
        status: result.responseStatus,
        body: (moduleScope
          ? schemaRegistry.ModuleTaskItem
          : schemaRegistry.TaskItem
        ).schema.parse(result.responseBody),
      };
    } catch (error) {
      const known =
        error instanceof TaskManagementError ||
        error instanceof RecordDraftError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError;
      return {
        status: known ? error.status : 500,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "暂时无法完成任务状态操作",
          details: {},
          requestId,
        }),
      };
    }
  }
}

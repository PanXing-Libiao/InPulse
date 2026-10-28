import { SearchProjectionCapacityError } from "../modules/search/search-projection.write-port.js";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  schemaRegistry,
  leftoverTaskRequestSchema,
  leftoverTaskResponseSchema,
} from "@inpulse/api-contract";
import { SessionAuthService } from "../auth/session-auth.service.js";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
} from "../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../idempotency/http-service.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { TaskManagementError } from "../modules/tasks/index.js";
import { RecordDraftError } from "../modules/change-records/index.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import {
  LeftoverTaskWorkflow,
  LeftoverTaskError,
} from "./leftover-task.workflow.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
export type LeftoverOperation =
  "convertLeftoverToTask" | "previewLeftoverTask" | "getLeftoverTaskSource";
@Injectable()
export class LeftoverTaskHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(LeftoverTaskWorkflow)
    private readonly workflow: LeftoverTaskWorkflow,
  ) {}
  async handle(operation: LeftoverOperation, request: CompletionHttpRequest) {
    const requestId = randomUUID();
    try {
      const source = operation === "getLeftoverTaskSource";
      const path = (
        source
          ? schemaRegistry.TaskCompletionPath
          : schemaRegistry.RecordDraftResourcePath
      ).schema.safeParse(request.params);
      const previewQuery =
        operation === "previewLeftoverTask"
          ? schemaRegistry.LeftoverTaskPreviewQuery.schema.safeParse(
              request.query ?? {},
            )
          : null;
      if (
        !path.success ||
        (previewQuery === null
          ? Object.keys(request.query ?? {}).length > 0
          : !previewQuery.success)
      )
        throw new TaskManagementError(
          422,
          "LEFTOVER_VALIDATION_FAILED",
          "请求参数不正确",
        );
      const leftoverItemId = previewQuery?.success
        ? previewQuery.data.leftoverItemId
        : undefined;
      if (operation !== "convertLeftoverToTask") {
        return {
          status: 200,
          body: await this.uow.run(async (tx) => {
            const actor = await this.auth.resolveActorInTransaction(
              tx,
              getHeader(request.headers, "cookie"),
            );
            if (!actor)
              throw new TaskManagementError(
                401,
                "LEFTOVER_SESSION_REQUIRED",
                "请重新登录",
              );
            if ("taskId" in path.data)
              return schemaRegistry.LeftoverTaskSource.schema.parse(
                await this.workflow.source(tx, actor.userId, path.data.taskId),
              );
            return schemaRegistry.LeftoverTaskPreview.schema.parse(
              await this.workflow.preview(
                tx,
                actor.userId,
                path.data.projectId,
                path.data.recordId,
                leftoverItemId,
              ),
            );
          }),
        };
      }
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new TaskManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const body = leftoverTaskRequestSchema.safeParse(request.body),
        headers = schemaRegistry.RecordDraftVersionHeaders.schema.safeParse({
          "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
          "if-match": getHeader(request.headers, "if-match"),
        });
      if (!body.success || !headers.success || !("recordId" in path.data))
        throw new TaskManagementError(
          422,
          "LEFTOVER_VALIDATION_FAILED",
          "请检查任务信息和版本",
        );
      if (
        Number(headers.data["if-match"].slice(1, -1)) !==
        body.data.expectedRowVersion
      )
        throw new TaskManagementError(
          422,
          "LEFTOVER_VERSION_MISMATCH",
          "记录版本头与请求不一致",
        );
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new TaskManagementError(
          400,
          "LEFTOVER_CONTENT_TYPE_INVALID",
          "请使用 application/json",
        );
      const { projectId, recordId } = path.data;
      const actor = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new TaskManagementError(
            401,
            "LEFTOVER_SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
        await this.workflow.authorize(tx, actor.userId, projectId);
        return actor.userId;
      };
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: actor,
        request: {
          method: "POST",
          path: "/projects/{projectId}/change-records/{recordId}/leftover-task",
          pathParams: {
            projectId: String(projectId),
            recordId: String(recordId),
          },
          query: {},
          headers: request.headers,
          body: body.data,
        },
        execute: async (tx, actorId) => {
          const response = await this.workflow.execute(
            tx,
            actorId,
            projectId,
            recordId,
            body.data,
            requestId,
          );
          const {
            recordVersion: _version,
            recordRowVersion: _row,
            leftoverRowVersion: _leftover,
            ...context
          } = response;
          return {
            responseStatus: 200,
            responseSchemaRef: "LeftoverTaskResponse",
            responseHasBody: true,
            responseBody: response,
            replayAuthContext: context,
          };
        },
        replayAuthorizer: async (record, tx) =>
          this.workflow.replay(
            tx,
            await actor(tx),
            projectId,
            recordId,
            record.replayAuthContext,
          ),
      });
      return {
        status: result.responseStatus,
        body: leftoverTaskResponseSchema.parse(result.responseBody),
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
          message: known ? error.message : "暂时无法转换遗留问题",
          details: error instanceof LeftoverTaskError ? error.details : {},
          requestId,
        }),
      };
    }
  }
}

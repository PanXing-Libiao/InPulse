import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { routeRegistry, schemaRegistry } from "@inpulse/api-contract";
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
import { TaskDeletionCommandPort } from "../modules/tasks/task-deletion.command-port.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import { RecordDraftError } from "../modules/change-records/record-drafts.service.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import { TaskDeletionWorkflow } from "./task-deletion.workflow.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";

export type TaskDeletionOperation = "deleteModuleTask";

interface TaskDeletionResource {
  projectId: number;
  moduleId: number;
  taskId: number;
}

/**
 * ADR-096：删除任务的 HTTP 接入。请求/响应校验、同源、CSRF 与幂等与其它任务
 * 写命令同口径；版本门禁用 `If-Match`，重放前复核当前认证与「项目可写 + 父级
 * 归属」的原操作权限（任务已删除，不能再按任务可读性复核，同 ADR-049 的
 * `projectDeleteReplayAuthorizer` 处理）。
 */
@Injectable()
export class TaskDeletionHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TaskDeletionWorkflow)
    private readonly deletion: TaskDeletionWorkflow,
    @Inject(TaskDeletionCommandPort)
    private readonly commands: TaskDeletionCommandPort,
  ) {}

  async handle(
    operation: TaskDeletionOperation,
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
      )!;
      if (
        route.request.path === "none" ||
        route.request.headers === "none" ||
        !("contentTypes" in route.request.body)
      )
        throw Error("Delete contract incomplete");
      const bodyContentType = route.request.body.contentTypes[0];
      if (bodyContentType === undefined)
        throw Error("Delete contract incomplete");
      const parsedPath = schemaRegistry[route.request.path].schema.safeParse(
          request.params,
        ),
        parsedHeaders = schemaRegistry[route.request.headers].schema.safeParse({
          "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
          "if-match": getHeader(request.headers, "if-match"),
        }),
        parsedCommand = schemaRegistry.DeleteTaskRequest.schema.safeParse(
          request.body,
        );
      if (
        !parsedPath.success ||
        !parsedHeaders.success ||
        !parsedCommand.success ||
        Object.keys(request.query ?? {}).length
      )
        throw new TaskManagementError(
          422,
          "TASK_VALIDATION_FAILED",
          "请检查删除原因与任务版本",
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
      const resource = parsedPath.data as TaskDeletionResource,
        command = parsedCommand.data as { reason: string | null };
      // 这里只做认证：重放路径同样会执行该回调，而任务行已被物理删除，
      // 带 taskId 的授权复核只允许出现在首次执行的 execute 中。
      const actor = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new TaskManagementError(
            401,
            "TASK_SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
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
          await this.commands.authorize(tx, actorId, resource, resource.taskId);
          const version = Number(
            getHeader(request.headers, "if-match")!.slice(1, -1),
          );
          const body = await this.deletion.delete(
            actorId,
            resource,
            resource.taskId,
            version,
            command.reason,
            requestId,
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "TaskDeletionResponse",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: {
              projectId: resource.projectId,
              moduleId: resource.moduleId,
              taskId: resource.taskId,
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          const current = await this.mutation.verify(tx, request.headers);
          if (!current)
            throw new TaskManagementError(
              401,
              "TASK_SESSION_REQUIRED",
              "登录或CSRF状态已失效",
            );
          const saved = schemaRegistry.TaskDeletionReplayContext.schema.parse(
            record.replayAuthContext,
          );
          if (
            saved.projectId !== resource.projectId ||
            saved.moduleId !== resource.moduleId ||
            saved.taskId !== resource.taskId
          )
            throw new TaskManagementError(
              404,
              "TASK_NOT_FOUND",
              "任务不存在或无法访问",
            );
          // 任务行已被物理删除，不能再按任务可读性复核；改为复核原操作权限
          // （项目可写与父级归属），删除成功不应让合法重放退化成 404。
          await this.commands.authorize(tx, current.userId, {
            projectId: saved.projectId,
            moduleId: saved.moduleId,
          });
        },
      });
      return {
        status: result.responseStatus,
        body: schemaRegistry.TaskDeletionResponse.schema.parse(
          result.responseBody,
        ),
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
          message: known ? error.message : "暂时无法删除任务",
          details: {},
          requestId,
        }),
      };
    }
  }
}

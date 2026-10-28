import { SearchProjectionCapacityError } from "../search/public/search-projection-errors.js";
import { ProjectCapabilityAccessError } from "../projects/index.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  type TaskEditRequest,
} from "@inpulse/api-contract";
import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
import { SessionAuthService } from "../../auth/session-auth.service.js";

import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../../auth/csrf.http.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../../idempotency/http-service.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  TasksManagementService,
  TaskManagementError,
  type TaskOperation,
} from "./tasks-management.service.js";

export interface TasksHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly body?: unknown;
  readonly params: unknown;
  readonly query: unknown;
}

@Injectable()
export class TasksHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TasksManagementService)
    private readonly tasks: TasksManagementService,
  ) {}

  async handle(
    operation:
      | "listTasks"
      | "getTask"
      | "listTaskAssignees"
      | "listModuleTasks"
      | "getModuleTask"
      | "listModuleTaskAssignees"
      | "getTaskStatusHistory"
      | "getModuleTaskStatusHistory"
      | TaskOperation,
    request: TasksHttpRequest,
  ): Promise<{ status: number; body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === operation,
      )!;
      const write = route.method !== "GET";
      const moduleScope = operation.includes("ModuleTask");
      const create =
        operation === "createTask" || operation === "createModuleTask";
      if (
        write &&
        mutationSameOriginValidationError(request.headers) !== undefined
      )
        throw new TaskManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const actor = write
        ? undefined
        : await this.auth.resolveActor(getHeader(request.headers, "cookie"));
      if (!write && !actor)
        throw new TaskManagementError(401, "TASK_SESSION_REQUIRED", "请先登录");
      const parse = (
        ref: keyof typeof schemaRegistry,
        value: unknown,
      ): unknown => {
        const parsed = schemaRegistry[ref].schema.safeParse(value);
        if (!parsed.success) {
          throw new TaskInputError(
            Object.fromEntries(
              parsed.error.issues.map((issue) => [
                issue.path.join("."),
                issue.message,
              ]),
            ),
          );
        }
        return parsed.data;
      };
      if (Object.keys((request.query ?? {}) as object).length)
        throw new TaskInputError({ query: "此接口不接受查询参数" });
      if (route.request.path === "none")
        throw new Error("task route requires path schema");
      const path = parse(route.request.path, request.params) as {
        projectId: number;
        moduleId: number;
        featureId: number | null;
        taskId?: number;
      };
      if (moduleScope) path.featureId = null;
      if (!write) {
        const body = await this.tasks.read(
          actor!.userId,
          path,
          path.taskId,
          operation === "listTaskAssignees" ||
            operation === "listModuleTaskAssignees",
          operation.endsWith("StatusHistory"),
        );
        return { status: 200, body };
      }
      const headers = {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
        ...(create
          ? {}
          : { "if-match": getHeader(request.headers, "if-match") }),
      };
      if (route.request.headers === "none")
        throw new Error("task route requires header schema");
      parse(route.request.headers, headers);
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
      if (!("contentTypes" in route.request.body))
        throw new Error("task route requires body schema");
      const input = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      ) as TaskEditRequest & {
        impactFeatureIds?: number[];
      };
      const resolve = async (tx: TransactionContext): Promise<number> => {
        const current = await this.mutation.verify(tx, request.headers);
        if (!current)
          throw new TaskManagementError(
            401,
            "TASK_SESSION_REQUIRED",
            "登录或 CSRF 状态已失效",
          );
        await this.tasks.authorize(tx, current.userId, path, path.taskId);

        return current.userId;
      };
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: resolve,
        request: {
          method: route.method,
          path: route.path,
          pathParams: Object.fromEntries(
            Object.entries(path)
              .filter(([, value]) => value !== null)
              .map(([key, value]) => [key, String(value)]),
          ),
          query: {},
          headers: request.headers,
          body: input,
        },
        execute: async (tx, actorId) => {
          const body = await this.tasks.execute(tx, {
            operation: operation as TaskOperation,
            actorId,
            projectId: path.projectId,
            moduleId: path.moduleId,
            featureId: path.featureId,
            ...(path.taskId === undefined
              ? {}
              : {
                  taskId: path.taskId,
                  version: Number(
                    getHeader(request.headers, "if-match")!.slice(1, -1),
                  ),
                }),
            edit: input,
            ...(input.impactFeatureIds === undefined
              ? {}
              : { impactFeatureIds: input.impactFeatureIds }),
            requestId,
          });
          return {
            responseStatus: 200,
            responseSchemaRef: moduleScope ? "ModuleTaskItem" : "TaskItem",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: {
              projectId: body.projectId,
              moduleId: body.moduleId,
              taskId: body.id,
              ...(body.scopeType === "MODULE"
                ? { impactFeatureIds: body.impactFeatureIds }
                : { featureId: body.featureId }),
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await resolve(tx);
          await this.tasks.replay(tx, actorId, record.replayAuthContext);
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
      let status = 500;
      let code = "INTERNAL_ERROR";
      let message = "暂时无法完成任务操作";
      let details: Record<string, string> = {};
      if (
        error instanceof TaskManagementError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof SearchProjectionCapacityError ||
        error instanceof IdempotencyHttpError
      )
        ({ status, code, message } = error);
      else if (error instanceof TaskInputError) {
        status = 422;
        code = "TASK_VALIDATION_FAILED";
        message = "请检查输入字段";
        details = error.fields;
      } else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint_name" in error &&
        error.constraint_name === "tasks_project_code_unique"
      ) {
        status = 409;
        code = "TASK_CODE_CONFLICT";
        message = "任务编号发生冲突，请联系管理员核对编号序列";
      }
      return {
        status,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code,
          message,
          details,
          requestId,
        }),
      };
    }
  }
}

class TaskInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("invalid task input");
  }
}

import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  taskGroupItemSchema,
  type TaskGroupMergeRequest,
} from "@inpulse/api-contract";
import { SessionAuthService } from "../../auth/session-auth.service.js";
import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
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
import { ProjectCapabilityAccessError } from "../projects/index.js";
import {
  TaskGroupsService,
  TaskGroupCommandError,
} from "./task-groups.service.js";

const MERGE_OPERATION_ID = "mergeTaskGroup";

export interface TaskGroupHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly params: unknown;
  readonly query: unknown;
  readonly body?: unknown;
}

class TaskGroupInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Invalid task group input");
  }
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === constraint
  );
}

/**
 * F-23 合并接口的 HTTP 边界：同源/CSRF、契约校验、幂等执行与错误映射。
 * 业务写入全部发生在 `TaskGroupsService` 的同一事务内。
 */
@Injectable()
export class TaskGroupsHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TaskGroupsService) private readonly taskGroups: TaskGroupsService,
  ) {}

  async handle(
    request: TaskGroupHttpRequest,
  ): Promise<{ status: number; body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === MERGE_OPERATION_ID,
      )!;
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new TaskGroupCommandError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const parse = (
        ref: keyof typeof schemaRegistry,
        value: unknown,
      ): unknown => {
        const parsed = schemaRegistry[ref].schema.safeParse(value);
        if (!parsed.success) {
          throw new TaskGroupInputError(
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
        throw new TaskGroupInputError({ query: "此接口不接受查询参数" });
      if (route.request.path !== "none")
        throw new Error("mergeTaskGroup must not bind path parameters");
      if (route.request.headers === "none")
        throw new Error("mergeTaskGroup requires a header schema");
      parse(route.request.headers, {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
      });
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new TaskGroupCommandError(
          400,
          "TASK_MERGE_CONTENT_TYPE_INVALID",
          "请求必须使用 application/json",
        );
      if (!("contentTypes" in route.request.body))
        throw new Error("mergeTaskGroup requires a body schema");
      const input = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      ) as TaskGroupMergeRequest;
      const resolve = async (tx: TransactionContext): Promise<number> => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new TaskGroupCommandError(
            401,
            "TASK_MERGE_SESSION_REQUIRED",
            "登录或 CSRF 状态已失效",
          );
        return actor.userId;
      };
      const result = await this.idempotency.run({
        operationId: MERGE_OPERATION_ID,
        actorId: resolve,
        request: {
          method: route.method,
          path: route.path,
          pathParams: {},
          query: {},
          headers: request.headers,
          body: input,
        },
        execute: async (tx, actorId) => {
          const body = await this.taskGroups.execute(
            tx,
            actorId,
            input,
            requestId,
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "TaskGroupItem",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: {
              projectId: body.projectId,
              groupId: body.id,
              taskIds: body.members.map((member) => member.taskId),
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          await this.taskGroups.replay(
            tx,
            await resolve(tx),
            record.replayAuthContext,
          );
        },
      });
      return {
        status: result.responseStatus,
        body: taskGroupItemSchema.parse(result.responseBody),
      };
    } catch (error) {
      let status = 500;
      let code = "INTERNAL_ERROR";
      let message = "暂时无法完成任务合并";
      let details: Record<string, string> = {};
      if (
        error instanceof TaskGroupCommandError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError
      )
        ({ status, code, message } = error);
      else if (error instanceof TaskGroupInputError) {
        status = 422;
        code = "TASK_MERGE_VALIDATION_FAILED";
        message = "请检查合并请求字段";
        details = error.fields;
      } else if (
        uniqueViolation(error, "task_group_members_one_active_group_unique") ||
        uniqueViolation(error, "task_group_members_group_task_unique")
      ) {
        status = 409;
        code = "TASK_ALREADY_MERGED";
        message = "分支任务已属于聚合组，请先解除原关系";
      } else if (
        uniqueViolation(error, "task_group_members_one_active_main_unique")
      ) {
        status = 409;
        code = "TASK_GROUP_STATE_CONFLICT";
        message = "聚合组主任务已变化，请重新加载后再合并";
      } else if (uniqueViolation(error, "task_groups_project_code_unique")) {
        status = 409;
        code = "TASK_GROUP_CODE_CONFLICT";
        message = "聚合组编号发生冲突，请联系管理员核对编号序列";
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

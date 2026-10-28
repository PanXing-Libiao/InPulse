import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  taskGroupUnmergeResponseSchema,
  type TaskGroupUnmergeRequest,
} from "@inpulse/api-contract";
import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
} from "../../auth/csrf.http.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../../idempotency/http-service.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ProjectCapabilityAccessError } from "../projects/index.js";
import {
  TaskGroupCommandError,
  TaskGroupsService,
} from "./task-groups.service.js";
import type { TaskGroupHttpRequest } from "./task-groups-http.service.js";

const UNMERGE_OPERATION_ID = "unmergeTaskGroup";

class TaskGroupUnmergeInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Invalid task group unmerge input");
  }
}

/**
 * F-24 解除合并接口的 HTTP 边界：同源/CSRF、契约校验、幂等执行与错误映射。
 * 业务写入全部发生在 `TaskGroupsService.unmerge` 的同一事务内。
 */
@Injectable()
export class TaskGroupUnmergeHttpService {
  constructor(
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
        (entry) => entry.operationId === UNMERGE_OPERATION_ID,
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
          throw new TaskGroupUnmergeInputError(
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
        throw new TaskGroupUnmergeInputError({
          query: "此接口不接受查询参数",
        });
      if (route.request.path !== "none")
        throw new Error("unmergeTaskGroup must not bind path parameters");
      if (route.request.headers === "none")
        throw new Error("unmergeTaskGroup requires a header schema");
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
          "TASK_UNMERGE_CONTENT_TYPE_INVALID",
          "请求必须使用 application/json",
        );
      if (!("contentTypes" in route.request.body))
        throw new Error("unmergeTaskGroup requires a body schema");
      const input = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      ) as TaskGroupUnmergeRequest;
      const resolve = async (tx: TransactionContext): Promise<number> => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new TaskGroupCommandError(
            401,
            "TASK_UNMERGE_SESSION_REQUIRED",
            "登录或 CSRF 状态已失效",
          );
        return actor.userId;
      };
      const result = await this.idempotency.run({
        operationId: UNMERGE_OPERATION_ID,
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
          const body = await this.taskGroups.unmerge(
            tx,
            actorId,
            input,
            requestId,
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "TaskGroupUnmergeResponse",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: {
              projectId: body.group.projectId,
              groupId: body.group.id,
              // 结果资源是来源任务与主任务；两者恒不相同，仍按契约归一化为升序去重数组。
              taskIds: [
                ...new Set([input.sourceTaskId, body.group.mainTaskId]),
              ].sort((a, b) => a - b),
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          await this.taskGroups.replayUnmerge(
            tx,
            await resolve(tx),
            record.replayAuthContext,
          );
        },
      });
      return {
        status: result.responseStatus,
        body: taskGroupUnmergeResponseSchema.parse(result.responseBody),
      };
    } catch (error) {
      const known =
        error instanceof TaskGroupCommandError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError;
      const invalid = error instanceof TaskGroupUnmergeInputError;
      return {
        status: known ? error.status : invalid ? 422 : 500,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code: known
            ? error.code
            : invalid
              ? "TASK_UNMERGE_VALIDATION_FAILED"
              : "INTERNAL_ERROR",
          message: known
            ? error.message
            : invalid
              ? "请检查解除合并请求字段"
              : "暂时无法完成解除合并",
          details: invalid ? error.fields : {},
          requestId,
        }),
      };
    }
  }
}

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
import { RecordDraftError } from "../modules/change-records/record-drafts.service.js";
import {
  ModuleDeletionError,
  moduleDeletionMissing,
} from "../modules/modules/module-deletion.command-port.js";
import { ProjectRoleGateService } from "../modules/projects/project-role-gate.service.js";
import { ProjectCapabilityAccessError } from "../modules/projects/project-member-permission-policy.service.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
import { ScopeDeletionWorkflow } from "./scope-deletion.workflow.js";

export type ScopeDeletionOperation = "deleteModule";

interface ModuleDeletionResource {
  readonly projectId: number;
  readonly moduleId: number;
}

/**
 * ADR-096 / ADR-109：模块删除的 HTTP 接入。请求/响应校验、同源、CSRF、
 * If-Match 版本门禁与数据库级幂等与其它写命令同口径；资源存在性检查与
 * 版本解析只在首次执行的 execute 中完成，重放前只复核当前认证与
 * 「当前仍是系统管理员或本项目组长」的实时角色。
 */
@Injectable()
export class ScopeDeletionHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(ScopeDeletionWorkflow)
    private readonly deletion: ScopeDeletionWorkflow,
    @Inject(ProjectRoleGateService)
    private readonly roles: ProjectRoleGateService,
  ) {}

  async handle(
    operation: ScopeDeletionOperation,
    request: CompletionHttpRequest,
  ) {
    const requestId = randomUUID();
    const missing = () => moduleDeletionMissing();
    const validationFailed = () =>
      new ModuleDeletionError(
        422,
        "MODULE_VALIDATION_FAILED",
        "请检查删除原因与模块版本",
      );
    try {
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new TaskManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const route = routeRegistry.find(
        (definition) => definition.operationId === operation,
      );
      if (!route) throw new Error("路由未登记：" + operation);
      if (route.request.path === "none" || route.request.headers === "none")
        throw new Error("Module delete contract incomplete");
      const parsedPath = schemaRegistry[route.request.path].schema.safeParse(
        request.params,
      );
      const parsedHeaders = schemaRegistry[
        route.request.headers
      ].schema.safeParse({
        "x-csrf-token": getHeader(request.headers, "x-csrf-token") ?? "",
        "if-match": getHeader(request.headers, "if-match") ?? "",
      });
      const parsedBody = schemaRegistry.DeleteModuleRequest.schema.safeParse(
        request.body,
      );
      if (
        !parsedPath.success ||
        !parsedHeaders.success ||
        !parsedBody.success ||
        Object.keys(request.query ?? {}).length
      )
        throw validationFailed();
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new ModuleDeletionError(
          400,
          "MODULE_CONTENT_TYPE_INVALID",
          "请求必须使用 application/json",
        );
      const path = parsedPath.data as ModuleDeletionResource;
      const scope: ModuleDeletionResource = {
        projectId: path.projectId,
        moduleId: path.moduleId,
      };
      const command = parsedBody.data as { reason: string | null };
      const version = Number(
        getHeader(request.headers, "if-match")!.slice(1, -1),
      );
      const actor = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new ModuleDeletionError(
            401,
            "MODULE_SESSION_REQUIRED",
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
            Object.entries(scope).map(([key, value]) => [key, String(value)]),
          ),
          query: {},
          headers: request.headers,
          body: command,
        },
        execute: async (tx, actorId) => ({
          responseStatus: 200,
          responseSchemaRef: "ModuleDeletionResponse",
          responseHasBody: true,
          responseBody: await this.deletion.deleteModule(
            actorId,
            scope.projectId,
            scope.moduleId,
            version,
            command.reason,
            requestId,
          ),
          replayAuthContext: { ...scope },
        }),
        replayAuthorizer: async (record, tx) => {
          const current = await this.mutation.verify(tx, request.headers);
          if (!current)
            throw new ModuleDeletionError(
              401,
              "MODULE_SESSION_REQUIRED",
              "登录或CSRF状态已失效",
            );
          const saved = schemaRegistry.ModuleDeletionReplayContext.schema.parse(
            record.replayAuthContext,
          );
          if (
            saved.projectId !== scope.projectId ||
            saved.moduleId !== scope.moduleId
          )
            throw missing();
          const role = await this.roles.scopeDeleterReplayRole(
            tx,
            current.userId,
            saved.projectId,
            {
              code: "MODULE_DELETE_FORBIDDEN",
              message: "当前平台权限配置不允许该成员删除模块",
            },
          );
          if (role === "NOT_MEMBER") throw missing();
        },
      });
      return {
        status: result.responseStatus,
        body: schemaRegistry.ModuleDeletionResponse.schema.parse(
          result.responseBody,
        ),
      };
    } catch (error) {
      if (
        error instanceof ModuleDeletionError ||
        error instanceof TaskManagementError ||
        error instanceof RecordDraftError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError
      ) {
        return {
          status: error.status,
          body: schemaRegistry.ErrorResponse.schema.parse({
            code: error.code,
            message: error.message,
            details: {},
            requestId,
          }),
        };
      }
      return {
        status: 500,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code: "INTERNAL_ERROR",
          message: "暂时无法删除模块",
          details: {},
          requestId,
        }),
      };
    }
  }
}

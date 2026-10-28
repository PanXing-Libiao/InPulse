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
  FeatureDeletionError,
  featureDeletionMissing,
} from "../modules/features/feature-deletion.command-port.js";
import {
  ModuleDeletionError,
  moduleDeletionMissing,
} from "../modules/modules/module-deletion.command-port.js";
import { ProjectRoleGateService } from "../modules/projects/project-role-gate.service.js";
import { ProjectCapabilityAccessError } from "../modules/projects/project-member-permission-policy.service.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
import { ScopeDeletionWorkflow } from "./scope-deletion.workflow.js";

export type ScopeDeletionOperation = "deleteModule" | "deleteFeature";

/** 模块删除命令的资源引用；功能删除命令在其后追加 featureId。 */
type ScopeDeletionResource =
  | { readonly projectId: number; readonly moduleId: number }
  | {
      readonly projectId: number;
      readonly moduleId: number;
      readonly featureId: number;
    };

/**
 * ADR-096：删除模块与删除功能的 HTTP 接入。请求/响应校验、同源、CSRF、`If-Match`
 * 版本门禁与数据库级幂等与其它写命令同口径；资源存在性检查与版本解析只在首次
 * 执行的 `execute` 中完成，重放前只复核当前认证与「当前仍是系统管理员或本项目
 * 组长」的实时角色（资源已被物理删除，按可读性复核会把合法重放变成 404）。
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
    const isModule = operation === "deleteModule";
    const missing = () =>
      isModule ? moduleDeletionMissing() : featureDeletionMissing();
    const validationFailed = () =>
      isModule
        ? new ModuleDeletionError(
            422,
            "MODULE_VALIDATION_FAILED",
            "请检查删除原因与模块版本",
          )
        : new FeatureDeletionError(
            422,
            "FEATURE_VALIDATION_FAILED",
            "请检查删除原因与功能版本",
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
      if (!route) throw new Error(`路由未登记：${operation}`);
      if (route.request.path === "none" || route.request.headers === "none")
        throw new Error("Scope delete contract incomplete");
      const parsedPath = schemaRegistry[route.request.path].schema.safeParse(
        request.params,
      );
      const parsedHeaders = schemaRegistry[
        route.request.headers
      ].schema.safeParse({
        "x-csrf-token": getHeader(request.headers, "x-csrf-token") ?? "",
        "if-match": getHeader(request.headers, "if-match") ?? "",
      });
      const parsedBody = isModule
        ? schemaRegistry.DeleteModuleRequest.schema.safeParse(request.body)
        : schemaRegistry.DeleteFeatureRequest.schema.safeParse(request.body);
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
        throw isModule
          ? new ModuleDeletionError(
              400,
              "MODULE_CONTENT_TYPE_INVALID",
              "请求必须使用 application/json",
            )
          : new FeatureDeletionError(
              400,
              "FEATURE_CONTENT_TYPE_INVALID",
              "请求必须使用 application/json",
            );
      const path = parsedPath.data as {
        projectId: number;
        moduleId: number;
        featureId?: number | undefined;
      };
      if (!isModule && path.featureId === undefined) throw missing();
      const scope: ScopeDeletionResource =
        path.featureId === undefined
          ? { projectId: path.projectId, moduleId: path.moduleId }
          : {
              projectId: path.projectId,
              moduleId: path.moduleId,
              featureId: path.featureId,
            };
      const command = parsedBody.data as { reason: string | null };
      const version = Number(
        getHeader(request.headers, "if-match")!.slice(1, -1),
      );
      // 这里只做认证：重放路径同样会执行该回调，而模块/功能行此时已被物理删除，
      // 带资源归属的授权复核只允许出现在首次执行的 execute 中。
      const actor = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw isModule
            ? new ModuleDeletionError(
                401,
                "MODULE_SESSION_REQUIRED",
                "登录或CSRF状态已失效",
              )
            : new FeatureDeletionError(
                401,
                "FEATURE_SESSION_REQUIRED",
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
        execute: async (tx, actorId) => {
          if ("featureId" in scope) {
            return {
              responseStatus: 200,
              responseSchemaRef: "FeatureDeletionResponse",
              responseHasBody: true,
              responseBody: await this.deletion.deleteFeature(
                actorId,
                scope.projectId,
                scope.moduleId,
                scope.featureId,
                version,
                command.reason,
                requestId,
              ),
              replayAuthContext: { ...scope },
            };
          }
          return {
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
          };
        },
        replayAuthorizer: async (record, tx) => {
          const current = await this.mutation.verify(tx, request.headers);
          if (!current)
            throw isModule
              ? new ModuleDeletionError(
                  401,
                  "MODULE_SESSION_REQUIRED",
                  "登录或CSRF状态已失效",
                )
              : new FeatureDeletionError(
                  401,
                  "FEATURE_SESSION_REQUIRED",
                  "登录或CSRF状态已失效",
                );
          const saved = isModule
            ? schemaRegistry.ModuleDeletionReplayContext.schema.parse(
                record.replayAuthContext,
              )
            : schemaRegistry.FeatureDeletionReplayContext.schema.parse(
                record.replayAuthContext,
              );
          if (
            saved.projectId !== scope.projectId ||
            saved.moduleId !== scope.moduleId
          )
            throw missing();
          if (
            "featureId" in scope &&
            "featureId" in saved &&
            saved.featureId !== scope.featureId
          )
            throw missing();
          // 资源已被物理删除，因此只复核实时角色：组长被转移、降级为
          // 普通成员或系统管理员被停用后重放一律拒绝，不得回放已存响应。
          const role = await this.roles.scopeDeleterReplayRole(
            tx,
            current.userId,
            saved.projectId,
            isModule
              ? {
                  code: "MODULE_DELETE_FORBIDDEN",
                  message: "当前平台权限配置不允许该成员删除模块",
                }
              : {
                  code: "FEATURE_DELETE_FORBIDDEN",
                  message: "当前平台权限配置不允许该成员删除功能",
                },
          );
          if (role === "NOT_MEMBER") throw missing();
        },
      });
      return {
        status: result.responseStatus,
        body: isModule
          ? schemaRegistry.ModuleDeletionResponse.schema.parse(
              result.responseBody,
            )
          : schemaRegistry.FeatureDeletionResponse.schema.parse(
              result.responseBody,
            ),
      };
    } catch (error) {
      const known =
        error instanceof ModuleDeletionError ||
        error instanceof FeatureDeletionError ||
        error instanceof TaskManagementError ||
        error instanceof RecordDraftError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError;
      return {
        status: known ? error.status : 500,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code: known ? error.code : "INTERNAL_ERROR",
          message: known
            ? error.message
            : isModule
              ? "暂时无法删除模块"
              : "暂时无法删除功能",
          details: {},
          requestId,
        }),
      };
    }
  }
}

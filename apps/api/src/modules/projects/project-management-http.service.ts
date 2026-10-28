import { SearchProjectionCapacityError } from "../search/public/search-projection-errors.js";
import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  type ProjectEditRequest,
  type ProjectStatusChangeRequest,
} from "@inpulse/api-contract";

import { AdminHighRiskError } from "../../auth/admin-high-risk.error.js";
import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../../auth/csrf.http.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../../idempotency/http-service.js";
import {
  ProjectManagementError,
  ProjectManagementService,
} from "./project-management.service.js";
import { ProjectCapabilityAccessError } from "./project-member-permission-policy.service.js";

export type ProjectManagementOperation =
  "updateProject" | "changeProjectStatus" | "deleteProject";

export interface ProjectManagementHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly params: unknown;
  readonly query: unknown;
  readonly body?: unknown;
}

class ProjectInputError extends Error {
  constructor(readonly fields: Readonly<Record<string, string>>) {
    super("invalid project management request");
    this.name = "ProjectInputError";
  }
}

class ProjectBodyValidationError extends Error {
  constructor(readonly details: string) {
    super("invalid project management body");
    this.name = "ProjectBodyValidationError";
  }
}

/**
 * F-06 项目编辑与状态变更 HTTP 编排：写路径由幂等 runner 持有单事务，
 * 权限在事务内按实时成员关系判定；项目三态下不再有归档/恢复操作。
 */
@Injectable()
export class ProjectManagementHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(ProjectManagementService)
    private readonly projects: ProjectManagementService,
  ) {}

  async handle(
    operation: ProjectManagementOperation,
    request: ProjectManagementHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === operation,
      )!;
      if (route.request.path === "none") {
        throw new Error("project route requires path schema");
      }
      const path = schemaRegistry.ProjectPath.schema.safeParse(request.params);
      if (!path.success) {
        throw new ProjectInputError({ path: "项目参数无效" });
      }
      if (Object.keys((request.query ?? {}) as object).length) {
        throw new ProjectInputError({ query: "此接口不接受查询参数" });
      }

      if (mutationSameOriginValidationError(request.headers) !== undefined) {
        throw new ProjectManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      }
      if (route.request.headers === "none") {
        throw new Error("project write route requires header schema");
      }
      const version = this.parseWriteHeaders(route, request.headers);
      const bodyBinding = route.request.body;
      let payload: unknown;
      if ("contentTypes" in bodyBinding) {
        if (
          getHeader(request.headers, "content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        ) {
          throw new ProjectManagementError(
            400,
            "PROJECT_CONTENT_TYPE_INVALID",
            "请求必须使用 application/json",
          );
        }
        const parsedBody = schemaRegistry[
          bodyBinding.contentTypes[0]!.schemaRef
        ].schema.safeParse(request.body);
        if (!parsedBody.success) {
          throw new ProjectBodyValidationError(
            parsedBody.error.issues
              .map((issue) => issue.path.join(".") || "body")
              .join(","),
          );
        }
        payload = parsedBody.data;
      } else if (Object.keys((request.body ?? {}) as object).length > 0) {
        // 删除不接受请求体：noBody 路由的幂等摘要不含正文，放行会让不同正文共享同一摘要。
        throw new ProjectInputError({ body: "此接口不接受请求体" });
      }

      // 编辑、状态变更与删除都只要求有效 Session，写权限由服务内的角色门禁判定。
      // 删除是例外：它的目标项目在成功执行后已不存在，重放不能再按项目可读性
      // 复核（ADR-062 的 `actorOnly` 策略只复核当前认证），首次执行的授权则由
      // `deleteProject` 的角色门禁给出（非成员 404、权限不足 403、不存在 404）。
      const resolve = async (tx: TransactionContext): Promise<number> => {
        const current = await this.mutation.verify(tx, request.headers);
        if (current === undefined) {
          throw new ProjectManagementError(
            401,
            "PROJECT_SESSION_REQUIRED",
            "登录或 CSRF 状态已失效",
          );
        }
        if (operation !== "deleteProject") {
          // 只做当前可读性；写前置条件由服务在执行/重放时判定。
          await this.projects.authorize(
            tx,
            current.userId,
            path.data.projectId,
          );
        }
        return current.userId;
      };

      const result = await this.idempotency.run({
        operationId: operation,
        actorId: resolve,
        request: {
          method: route.method,
          path: route.path,
          pathParams: { projectId: String(path.data.projectId) },
          query: {},
          headers: request.headers,
          body: payload,
        },
        execute: async (tx, actorId) => {
          if (operation === "deleteProject") {
            await this.projects.deleteProject(tx, {
              actorId,
              projectId: path.data.projectId,
              version,
              requestId,
            });
            return {
              responseStatus: 204,
              responseSchemaRef: null,
              responseHasBody: false,
              responseBody: null,
              replayAuthContext: { projectId: path.data.projectId },
            };
          }
          const body =
            operation === "updateProject"
              ? await this.projects.updateProject(tx, {
                  actorId,
                  projectId: path.data.projectId,
                  version,
                  edit: payload as ProjectEditRequest,
                  requestId,
                })
              : await this.projects.changeProjectStatus(tx, {
                  actorId,
                  projectId: path.data.projectId,
                  version,
                  target: (payload as ProjectStatusChangeRequest).status,
                  requestId,
                });
          return {
            responseStatus: 200,
            responseSchemaRef: "ProjectDetailResponse",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: { projectId: path.data.projectId },
          };
        },
        replayAuthorizer: async (record, tx) => {
          // ADR-062：删除的同 Key 重放不按项目可读性复核（项目行已随首次执行删除），
          // `resolve` 内的当前认证复核就是该路由声明的全部门禁；已存 204 直接返回。
          const actorId = await resolve(tx);
          if (operation === "deleteProject") return;
          await this.projects.replay(tx, actorId, record.replayAuthContext);
        },
      });
      if (result.responseHasBody === false) {
        // 删除只有 204：响应体为空，由 ContractResponseInterceptor 按 noBody 跳过校验。
        return { status: result.responseStatus, body: undefined };
      }
      return {
        status: result.responseStatus,
        body: schemaRegistry.ProjectDetailResponse.schema.parse(
          result.responseBody,
        ),
      };
    } catch (error) {
      return this.mapError(error, requestId);
    }
  }

  /**
   * 项目写路由的请求头校验：三条命令（编辑、状态变更、删除）都要求 `If-Match`
   * 与服务端版本一致，因此这里只校验 `ProjectVersionHeaders` 并返回版本号。
   */
  private parseWriteHeaders(
    route: (typeof routeRegistry)[number],
    headers: HttpHeaderBag,
  ): number {
    if (route.request.headers !== "ProjectVersionHeaders") {
      throw new Error("project write route requires ProjectVersionHeaders");
    }
    const csrfToken = getHeader(headers, "x-csrf-token");
    const parsed = schemaRegistry.ProjectVersionHeaders.schema.safeParse({
      "x-csrf-token": csrfToken,
      "if-match": getHeader(headers, "if-match"),
    });
    if (!parsed.success) {
      throw new ProjectInputError(headerFields(parsed.error.issues));
    }
    return Number(parsed.data["if-match"].slice(1, -1));
  }

  private mapError(
    error: unknown,
    requestId: string,
  ): { readonly status: number; readonly body: unknown } {
    if (
      error instanceof ProjectManagementError ||
      error instanceof ProjectCapabilityAccessError ||
      error instanceof SearchProjectionCapacityError
    ) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (error instanceof AdminHighRiskError) {
      return errorBody(error.status, error.code, error.message, requestId, {
        reason: error.reason,
      });
    }
    if (error instanceof IdempotencyHttpError) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (error instanceof ProjectInputError) {
      return errorBody(
        422,
        "PROJECT_VALIDATION_FAILED",
        "请检查项目请求字段",
        requestId,
        { ...error.fields },
      );
    }
    if (error instanceof ProjectBodyValidationError) {
      return errorBody(
        422,
        "PROJECT_VALIDATION_FAILED",
        "请检查项目请求字段",
        requestId,
        { body: error.details },
      );
    }
    return errorBody(
      500,
      "INTERNAL_ERROR",
      "服务器无法完成项目操作",
      requestId,
    );
  }
}

/** 头校验失败按字段聚合成 422 details，与请求体校验保持同一形态。 */
function headerFields(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    issues.map((issue) => [issue.path.join(".") || "headers", issue.message]),
  );
}

function errorBody(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details: Readonly<Record<string, unknown>> = {},
): { readonly status: number; readonly body: unknown } {
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

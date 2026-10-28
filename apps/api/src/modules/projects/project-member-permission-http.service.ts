import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  projectMemberPermissionReplayContextSchema,
  routeRegistry,
  schemaRegistry,
  type ProjectMemberPermissionsUpdateRequest,
} from "@inpulse/api-contract";

import { AdminHighRiskAuthService } from "../../auth/admin-high-risk.service.js";
import { AdminHighRiskError } from "../../auth/admin-high-risk.error.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../../auth/csrf.http.js";
import { SessionAuthService } from "../../auth/session-auth.service.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../../idempotency/http-service.js";
import {
  ProjectMemberPermissionError,
  ProjectMemberPermissionService,
} from "./project-member-permission.service.js";

export interface ProjectMemberPermissionHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly query: unknown;
  readonly body?: unknown;
}

interface ProjectMemberPermissionParsedHeaders {
  readonly version: number;
}

class ProjectMemberPermissionHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectMemberPermissionHttpError";
  }
}

class ProjectMemberPermissionInputError extends Error {
  constructor(readonly fields: Readonly<Record<string, string>>) {
    super("invalid project member permission request");
    this.name = "ProjectMemberPermissionInputError";
  }
}

/**
 * ADR-104 全平台项目成员权限 HTTP 编排。
 * GET 使用普通认证 Session；PUT 使用完整管理员 Session、同步 CSRF、
 * If-Match 与数据库级幂等；配置更新和 SYSTEM 审计共用一个事务。
 */
@Injectable()
export class ProjectMemberPermissionHttpService {
  constructor(
    @Inject(PostgresUnitOfWork)
    private readonly unitOfWork: PostgresUnitOfWork,
    @Inject(SessionAuthService)
    private readonly sessionAuth: SessionAuthService,
    @Inject(AdminHighRiskAuthService)
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(ProjectMemberPermissionService)
    private readonly permissions: ProjectMemberPermissionService,
  ) {}

  async get(
    request: ProjectMemberPermissionHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      this.assertNoQuery(request.query);
      const body = await this.unitOfWork.run(async (tx) => {
        const actor = await this.sessionAuth.resolveActorInTransaction(
          tx,
          getHeader(request.headers, "cookie"),
        );
        if (actor === undefined) {
          throw new ProjectMemberPermissionHttpError(
            401,
            "PROJECT_MEMBER_PERMISSION_SESSION_REQUIRED",
            "需要有效的认证 Session",
          );
        }
        return this.permissions.get(tx);
      });
      return {
        status: 200,
        body: schemaRegistry.ProjectMemberPermissions.schema.parse(body),
      };
    } catch (error) {
      return this.mapError(error, requestId);
    }
  }

  async update(
    request: ProjectMemberPermissionHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      this.assertNoQuery(request.query);
      const originFailure = mutationSameOriginValidationError(request.headers);
      if (originFailure !== undefined) {
        throw new ProjectMemberPermissionHttpError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      }
      const contentType = getHeader(request.headers, "content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw new ProjectMemberPermissionHttpError(
          400,
          "PROJECT_MEMBER_PERMISSION_CONTENT_TYPE_INVALID",
          "请求必须使用 application/json",
        );
      }
      const headers = this.parseHeaders(request.headers);
      const body = this.parseBody(request.body);
      const route = routeRegistry.find(
        (entry) => entry.operationId === "updateProjectMemberPermissions",
      );
      if (route === undefined) {
        throw new Error("updateProjectMemberPermissions route is missing");
      }
      const result = await this.idempotency.run({
        operationId: "updateProjectMemberPermissions",
        actorId: (tx) => this.resolveWriteActor(tx, request.headers),
        request: {
          method: route.method,
          path: route.path,
          pathParams: {},
          query: {},
          headers: request.headers,
          body,
        },
        execute: async (tx, actorId) => {
          const updated = await this.permissions.update(tx, {
            actorId,
            expectedRowVersion: headers.version,
            values: body,
            requestId,
          });
          return {
            responseStatus: 200,
            responseSchemaRef: "ProjectMemberPermissions",
            responseHasBody: true,
            responseBody: updated,
            replayAuthContext: {
              actorUserId: actorId,
              settingsRowId: 1 as const,
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await this.resolveWriteActor(tx, request.headers);
          const context = projectMemberPermissionReplayContextSchema.parse(
            record.replayAuthContext,
          );
          if (context.actorUserId !== actorId || context.settingsRowId !== 1) {
            throw new ProjectMemberPermissionHttpError(
              403,
              "ADMIN_REQUIRED",
              "只有原管理员可以重放该权限配置保存请求",
            );
          }
          await this.permissions.replay(tx);
        },
      });
      return {
        status: result.responseStatus,
        body: schemaRegistry.ProjectMemberPermissions.schema.parse(
          result.responseBody,
        ),
      };
    } catch (error) {
      return this.mapError(error, requestId);
    }
  }

  private async resolveWriteActor(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<number> {
    const actor = await this.highRisk.verify(tx, headers);
    return actor.userId;
  }

  private parseHeaders(
    headers: HttpHeaderBag,
  ): ProjectMemberPermissionParsedHeaders {
    const parsed =
      schemaRegistry.ProjectMemberPermissionMutationHeaders.schema.safeParse({
        "x-csrf-token": getHeader(headers, "x-csrf-token"),
        "if-match": getHeader(headers, "if-match"),
      });
    if (!parsed.success) {
      throw new ProjectMemberPermissionInputError({
        headers: "请提供 43 位 CSRF Token 与合法的 If-Match 版本",
      });
    }
    return {
      version: Number(parsed.data["if-match"].slice(1, -1)),
    };
  }

  private parseBody(value: unknown): ProjectMemberPermissionsUpdateRequest {
    const parsed =
      schemaRegistry.ProjectMemberPermissionsUpdateRequest.schema.safeParse(
        value,
      );
    if (!parsed.success) {
      throw new ProjectMemberPermissionInputError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join(".") || "body",
            issue.message,
          ]),
        ),
      );
    }
    return parsed.data;
  }

  private assertNoQuery(value: unknown): void {
    if (Object.keys((value ?? {}) as object).length > 0) {
      throw new ProjectMemberPermissionInputError({
        query: "此接口不接受查询参数",
      });
    }
  }

  private mapError(
    error: unknown,
    requestId: string,
  ): { readonly status: number; readonly body: unknown } {
    if (error instanceof ProjectMemberPermissionError) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (
      error instanceof ProjectMemberPermissionHttpError ||
      error instanceof AdminHighRiskError
    ) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (error instanceof ProjectMemberPermissionInputError) {
      return errorBody(
        422,
        "PROJECT_MEMBER_PERMISSION_VALIDATION_FAILED",
        "请检查全平台权限配置字段",
        requestId,
        error.fields,
      );
    }
    if (error instanceof IdempotencyHttpError) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    return errorBody(
      500,
      "INTERNAL_ERROR",
      "暂时无法读取或保存全平台权限配置",
      requestId,
    );
  }
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

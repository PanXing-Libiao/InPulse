import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  type CasdoorImportPreviewResponse,
} from "@inpulse/api-contract";

import { AdminHighRiskAuthService } from "../auth/admin-high-risk.service.js";
import { AdminHighRiskError } from "../auth/admin-high-risk.error.js";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../auth/csrf.http.js";
import { SessionAuthService } from "../auth/session-auth.service.js";
import {
  CASDOOR_IMPORT_PORT,
  CasdoorDirectorySelectionError,
  selectDirectoryUsers,
  type CasdoorImportPort,
} from "../auth/sso/casdoor-import.port.js";
import {
  SsoCasdoorDirectoryError,
  type CasdoorDirectorySnapshot,
} from "../auth/sso/sso-casdoor-directory.client.js";
import { SsoGroupMetadataError } from "../auth/sso/sso-casdoor-group.client.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../idempotency/http-service.js";
import { AdminCasdoorImportService } from "./admin-casdoor-import.service.js";
import { AdminUserRepository } from "./admin-user.repository.js";

export interface CasdoorImportHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly query: unknown;
  readonly body?: unknown;
}

class CasdoorImportHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 500 | 503,
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "CasdoorImportHttpError";
  }
}

class CasdoorImportInputError extends Error {
  constructor(readonly fields: Readonly<Record<string, string>>) {
    super("invalid Casdoor import input");
    this.name = "CasdoorImportInputError";
  }
}

/** ADR-100：预览只读，确认导入由幂等 runner 持有单事务；网络均在事务外。 */
@Injectable()
export class AdminCasdoorImportHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(AdminHighRiskAuthService)
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(AdminUserRepository)
    private readonly users: AdminUserRepository,
    @Inject(AdminCasdoorImportService)
    private readonly casdoorImport: AdminCasdoorImportService,
    @Inject(CASDOOR_IMPORT_PORT)
    private readonly directory: CasdoorImportPort,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
  ) {}

  async preview(
    request: CasdoorImportHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      this.assertNoQuery(request.query);
      await this.uow.run((tx) => this.assertReadAdmin(tx, request.headers));
      const snapshot = await this.directory.loadDirectory();
      const result = await this.uow.run(async (tx) => {
        await this.assertReadAdmin(tx, request.headers);
        const body = await this.casdoorImport.preview(tx, snapshot);
        return schemaRegistry.CasdoorImportPreviewResponse.schema.parse(
          body satisfies CasdoorImportPreviewResponse,
        );
      });
      return { status: 200, body: result };
    } catch (error) {
      return this.mapError(error, requestId);
    }
  }

  async import(
    request: CasdoorImportHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      if (mutationSameOriginValidationError(request.headers) !== undefined) {
        throw new CasdoorImportHttpError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      }
      this.assertNoQuery(request.query);
      const route = routeRegistry.find(
        (entry) => entry.operationId === "importCasdoorUsers",
      );
      if (route === undefined || route.request.headers === "none") {
        throw new Error("Casdoor import route is not registered correctly");
      }
      this.parseSchema("AdminUserMutationHeaders", {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
      });
      const body = this.parseJsonBody(route, request);
      const parsed = schemaRegistry.CasdoorImportRequest.schema.parse(body);

      await this.uow.run((tx) => this.resolveWriteActor(tx, request.headers));
      const snapshot = await this.directory.loadDirectory();

      const result = await this.idempotency.run({
        operationId: "importCasdoorUsers",
        actorId: (tx) => this.resolveWriteActor(tx, request.headers),
        request: {
          method: route.method,
          path: route.path,
          pathParams: {},
          query: {},
          headers: request.headers,
          body: parsed,
        },
        execute: async (tx, actorId) => {
          this.assertSelectionCurrent(snapshot, parsed.casdoorUserIds);
          const imported = await this.casdoorImport.import(
            tx,
            { actorId, requestId },
            snapshot,
            parsed.casdoorUserIds,
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "CasdoorImportResult",
            responseHasBody: true,
            responseBody: imported,
            replayAuthContext: {},
          };
        },
      });
      return {
        status: result.responseStatus,
        body:
          result.responseSchemaRef === "CasdoorImportResult"
            ? schemaRegistry.CasdoorImportResult.schema.parse(
                result.responseBody,
              )
            : result.responseBody,
      };
    } catch (error) {
      return this.mapError(error, requestId);
    }
  }

  private async assertReadAdmin(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<void> {
    const actor = await this.auth.resolveActorInTransaction(
      tx,
      getHeader(headers, "cookie"),
    );
    if (actor === undefined) {
      throw new CasdoorImportHttpError(
        401,
        "ADMIN_USER_SESSION_REQUIRED",
        "请先登录",
      );
    }
    const user = await this.users.find(tx, actor.userId);
    if (user?.isAdmin !== true) {
      throw new CasdoorImportHttpError(
        403,
        "ADMIN_REQUIRED",
        "只有系统管理员可以导入 Casdoor 账号",
      );
    }
  }

  private async resolveWriteActor(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<number> {
    const actor = await this.mutation.verify(tx, headers);
    if (actor === undefined) {
      throw new CasdoorImportHttpError(
        401,
        "ADMIN_USER_SESSION_REQUIRED",
        "请先登录",
      );
    }
    const user = await this.users.find(tx, actor.userId);
    if (user?.isAdmin !== true) {
      throw new CasdoorImportHttpError(
        403,
        "ADMIN_REQUIRED",
        "只有系统管理员可以导入 Casdoor 账号",
      );
    }
    const verified = await this.highRisk.verify(tx, headers);
    if (verified.userId !== actor.userId) {
      throw new CasdoorImportHttpError(
        403,
        "ADMIN_REQUIRED",
        "管理员身份已变化，请重新验证",
      );
    }
    return actor.userId;
  }

  private assertSelectionCurrent(
    snapshot: CasdoorDirectorySnapshot,
    ids: readonly string[],
  ): void {
    try {
      selectDirectoryUsers(snapshot, ids);
    } catch (error) {
      if (error instanceof CasdoorDirectorySelectionError) {
        throw new CasdoorImportHttpError(
          409,
          "CASDOOR_IMPORT_PREVIEW_STALE",
          "Casdoor 目录已在预览后变化，请刷新预览后重新勾选",
        );
      }
      throw error;
    }
  }

  private parseJsonBody(
    route: (typeof routeRegistry)[number],
    request: CasdoorImportHttpRequest,
  ): unknown {
    if ("noBody" in route.request.body) return {};
    const contentType = getHeader(request.headers, "content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new CasdoorImportHttpError(
        400,
        "CASDOOR_IMPORT_CONTENT_TYPE_INVALID",
        "请求必须使用 application/json",
      );
    }
    const ref = route.request.body.contentTypes[0]!.schemaRef;
    return this.parseSchema(ref, request.body);
  }

  private parseSchema(
    ref: keyof typeof schemaRegistry,
    value: unknown,
  ): unknown {
    const parsed = schemaRegistry[ref].schema.safeParse(value);
    if (!parsed.success) {
      throw new CasdoorImportInputError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      );
    }
    return parsed.data;
  }

  private assertNoQuery(value: unknown): void {
    if (Object.keys((value ?? {}) as object).length > 0) {
      throw new CasdoorImportInputError({ query: "此接口不接受查询参数" });
    }
  }

  private mapError(
    error: unknown,
    requestId: string,
  ): { readonly status: number; readonly body: unknown } {
    if (error instanceof SsoCasdoorDirectoryError) {
      const configured =
        error.reason !== "not-configured" &&
        error.reason !== "organization-invalid";
      return errorBody(
        503,
        configured
          ? "CASDOOR_IMPORT_UNAVAILABLE"
          : "CASDOOR_IMPORT_NOT_CONFIGURED",
        configured
          ? "Casdoor 用户目录暂时不可用，请稍后重试"
          : "Casdoor 账号导入尚未配置",
        { reason: error.reason, requestId },
      );
    }
    if (error instanceof SsoGroupMetadataError) {
      return errorBody(
        503,
        "CASDOOR_IMPORT_UNAVAILABLE",
        "Casdoor 群组信息暂时不可用，请稍后重试",
        { reason: error.reason, requestId },
      );
    }
    if (error instanceof CasdoorImportHttpError) {
      return errorBody(error.status, error.code, error.message, {
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        requestId,
      });
    }
    if (error instanceof CasdoorDirectorySelectionError) {
      return errorBody(
        409,
        "CASDOOR_IMPORT_PREVIEW_STALE",
        "Casdoor 目录已在预览后变化，请刷新预览后重新勾选",
        { reason: error.reason, requestId },
      );
    }
    if (error instanceof AdminHighRiskError) {
      return errorBody(error.status, error.code, error.message, {
        reason: error.reason,
        requestId,
      });
    }
    if (error instanceof IdempotencyHttpError) {
      return errorBody(error.status, error.code, error.message, { requestId });
    }
    if (error instanceof CasdoorImportInputError) {
      return errorBody(
        422,
        "CASDOOR_IMPORT_VALIDATION_FAILED",
        "请检查 Casdoor 导入输入",
        { ...error.fields, requestId },
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      return errorBody(
        409,
        "CASDOOR_IMPORT_CONFLICT",
        "导入过程中账号身份发生变化，请刷新预览后重试",
        { requestId },
      );
    }
    return errorBody(500, "INTERNAL_ERROR", "服务器无法完成 Casdoor 账号导入", {
      requestId,
    });
  }
}

function errorBody(
  status: number,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
) {
  return {
    status,
    body: schemaRegistry.ErrorResponse.schema.parse({
      code,
      message,
      details,
      requestId: details.requestId ?? "",
    }),
  };
}

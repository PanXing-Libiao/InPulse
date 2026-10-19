import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  type AdminUserCreateRequest,
  type AdminUserDisableRequest,
  type AdminUserOffboardingResponse,
  type AdminUserUpdateRequest,
} from "@inpulse/api-contract";

import { SessionAuthService } from "../auth/session-auth.service.js";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import { AdminHighRiskAuthService } from "../auth/admin-high-risk.service.js";
import { AdminHighRiskError } from "../auth/admin-high-risk.error.js";
import { PasswordService } from "../auth/password.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../auth/csrf.http.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import type { TransactionContext } from "../database/transaction-context.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../idempotency/http-service.js";
import { AdminUserError } from "./admin-user.error.js";
import { AdminUserRepository } from "./admin-user.repository.js";
import { AdminUserService } from "./admin-user.service.js";

export type AdminUserOperation =
  | "listAdminUsers"
  | "getAdminUserOffboarding"
  | "createUser"
  | "updateUser"
  | "disableUser"
  | "enableUser"
  | "deleteUser";

export interface AdminUsersHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly params: unknown;
  readonly query: unknown;
  readonly body?: unknown;
}

class AdminUserHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminUserHttpError";
  }
}

class AdminUserInputError extends Error {
  constructor(readonly fields: Readonly<Record<string, string>>) {
    super("invalid admin user input");
    this.name = "AdminUserInputError";
  }
}

/** F-03 用户管理 HTTP 编排：读路径独立事务，写路径由幂等 runner 持有单事务。 */
@Injectable()
export class AdminUsersHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(AdminHighRiskAuthService)
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(AdminUserRepository)
    private readonly repository: AdminUserRepository,
    @Inject(AdminUserService) private readonly users: AdminUserService,
    @Inject(PasswordService) private readonly password: PasswordService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
  ) {}

  async handle(
    operation: AdminUserOperation,
    request: AdminUsersHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === operation,
      )!;
      const write =
        operation !== "listAdminUsers" &&
        operation !== "getAdminUserOffboarding";
      if (
        write &&
        mutationSameOriginValidationError(request.headers) !== undefined
      ) {
        throw new AdminUserHttpError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      }
      if (Object.keys((request.query ?? {}) as object).length) {
        throw new AdminUserInputError({ query: "此接口不接受查询参数" });
      }
      const parsedPath = this.parseRouteValue(
        route.request.path,
        request.params,
      );
      const path = parsedPath as { readonly userId?: number };
      if (!write) {
        return await this.uow.run(async (tx) => {
          await this.assertReadAdmin(tx, request.headers);
          if (operation === "getAdminUserOffboarding") {
            const body = await this.users.offboarding(tx, path.userId!);
            return {
              status: 200,
              body: schemaRegistry.AdminUserOffboardingResponse.schema.parse(
                body satisfies AdminUserOffboardingResponse,
              ),
            };
          }
          const items = await this.repository.list(tx);
          return {
            status: 200,
            body: schemaRegistry.AdminUserListResponse.schema.parse({ items }),
          };
        });
      }

      const parsedHeaders = this.parseRouteValue(
        route.request.headers,
        this.headersFor(operation, request.headers),
      );
      void parsedHeaders;
      const body = this.parseWriteBody(operation, route, request);
      const version = this.versionOf(operation, request.headers);
      const passwordHash =
        operation === "createUser"
          ? await this.password.createHash(
              (body as AdminUserCreateRequest).password,
            )
          : undefined;
      const execute = async (tx: TransactionContext, actorId: number) => {
        const meta = {
          actorId,
          headers: request.headers,
          requestId,
        };
        if (operation === "createUser") {
          const created = await this.users.create(
            tx,
            meta,
            body as AdminUserCreateRequest,
            passwordHash!,
          );
          return userResult(created, actorId, created.id);
        }
        const userId = path.userId!;
        if (operation === "updateUser") {
          const updated = await this.users.update(
            tx,
            meta,
            userId,
            body as AdminUserUpdateRequest,
            version!,
          );
          return userResult(updated, actorId, updated.id);
        }
        if (operation === "disableUser") {
          await this.users.disable(
            tx,
            meta,
            userId,
            version!,
            body as AdminUserDisableRequest,
          );
          return noBodyResult(actorId, userId);
        }
        if (operation === "enableUser") {
          await this.users.enable(tx, meta, userId, version!);
          return noBodyResult(actorId, userId);
        }
        if (operation === "deleteUser") {
          await this.users.delete(tx, meta, userId, version!);
          return noBodyResult(actorId, userId);
        }
        throw new Error("unhandled admin user operation: " + operation);
      };
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: (tx) => this.resolveWriteActor(tx, request.headers),
        request: {
          method: route.method,
          path: route.path,
          pathParams: toPathParams(path),
          query: {},
          headers: request.headers,
          body:
            route.request.body && "noBody" in route.request.body ? null : body,
        },
        execute,
        replayAuthorizer: async (record, tx) => {
          const actorId = await this.resolveWriteActor(tx, request.headers);
          await this.users.replay(tx, actorId, record.replayAuthContext);
        },
      });
      return {
        status: result.responseStatus,
        body: result.responseSchemaRef
          ? schemaRegistry[
              result.responseSchemaRef as keyof typeof schemaRegistry
            ].schema.parse(result.responseBody)
          : undefined,
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
      throw new AdminUserHttpError(
        401,
        "ADMIN_USER_SESSION_REQUIRED",
        "请先登录",
      );
    }
    const user = await this.repository.find(tx, actor.userId);
    if (user?.isAdmin !== true) {
      throw new AdminUserHttpError(
        403,
        "ADMIN_REQUIRED",
        "只有系统管理员可以查看用户管理",
      );
    }
  }

  private async resolveWriteActor(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<number> {
    const actor = await this.mutation.verify(tx, headers);
    if (actor === undefined) {
      throw new AdminUserHttpError(
        401,
        "ADMIN_USER_SESSION_REQUIRED",
        "请先登录",
      );
    }
    const user = await this.repository.find(tx, actor.userId);
    if (user?.isAdmin !== true) {
      throw new AdminUserHttpError(
        403,
        "ADMIN_REQUIRED",
        "只有系统管理员可以执行用户管理",
      );
    }
    const verified = await this.highRisk.verify(tx, headers);
    if (verified.userId !== actor.userId) {
      throw new AdminUserHttpError(
        403,
        "ADMIN_REQUIRED",
        "管理员身份已变化，请重新验证",
      );
    }
    return actor.userId;
  }

  private parseRouteValue(
    ref: keyof typeof schemaRegistry | "none",
    value: unknown,
  ): unknown {
    if (ref === "none") return {};
    const parsed = schemaRegistry[ref].schema.safeParse(value);
    if (!parsed.success) {
      throw new AdminUserInputError(
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

  private headersFor(
    operation: AdminUserOperation,
    headers: HttpHeaderBag,
  ): Readonly<Record<string, string | undefined>> {
    return {
      "x-csrf-token": getHeader(headers, "x-csrf-token"),
      ...(operation === "createUser"
        ? {}
        : { "if-match": getHeader(headers, "if-match") }),
    };
  }

  private parseWriteBody(
    operation: AdminUserOperation,
    route: (typeof routeRegistry)[number],
    request: AdminUsersHttpRequest,
  ): unknown {
    if ("noBody" in route.request.body) return {};
    const contentType = getHeader(request.headers, "content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new AdminUserHttpError(
        400,
        "ADMIN_USER_CONTENT_TYPE_INVALID",
        "请求必须使用 application/json",
      );
    }
    const ref = route.request.body.contentTypes[0]!.schemaRef;
    return this.parseRouteValue(ref, request.body);
  }

  private versionOf(
    operation: AdminUserOperation,
    headers: HttpHeaderBag,
  ): number | undefined {
    if (operation === "createUser") return undefined;
    const value = getHeader(headers, "if-match");
    if (value === undefined) return undefined;
    return Number(value.slice(1, -1));
  }

  private mapError(
    error: unknown,
    requestId: string,
  ): { readonly status: number; readonly body: unknown } {
    if (error instanceof AdminUserError) {
      return errorBody(error.status, error.code, error.message, {
        reason: error.reason,
        ...error.details,
        requestId,
      });
    }
    if (error instanceof AdminUserHttpError) {
      return errorBody(error.status, error.code, error.message, { requestId });
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
    if (error instanceof AdminUserInputError) {
      return errorBody(
        422,
        "ADMIN_USER_VALIDATION_FAILED",
        "请检查用户管理输入字段",
        {
          ...error.fields,
          requestId,
        },
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505" &&
      "constraint_name" in error
    ) {
      const constraint = String(error.constraint_name);
      const code = constraint.includes("login_name")
        ? "ADMIN_USER_LOGIN_CONFLICT"
        : "ADMIN_USER_EMAIL_CONFLICT";
      const message = constraint.includes("login_name")
        ? "登录名已存在"
        : "邮箱已被使用";
      return errorBody(409, code, message, { requestId });
    }
    return errorBody(500, "INTERNAL_ERROR", "服务器无法完成用户管理操作", {
      requestId,
    });
  }
}

function toPathParams(
  parsed: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );
}

function userResult(user: unknown, actorUserId: number, userId: number) {
  return {
    responseStatus: 200,
    responseSchemaRef: "AdminUserItem",
    responseHasBody: true,
    responseBody: user,
    replayAuthContext: { actorUserId, userId },
  };
}

function noBodyResult(actorUserId: number, userId: number) {
  return {
    responseStatus: 204,
    responseSchemaRef: null,
    responseHasBody: false,
    responseBody: null,
    replayAuthContext: { actorUserId, userId },
  };
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

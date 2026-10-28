import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  type ModuleEditRequest,
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
  ModulesManagementService,
  ModuleManagementError,
  type ModuleOperation,
} from "./modules-management.service.js";
import { ProjectCapabilityAccessError } from "../projects/index.js";

export interface ModulesHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly body?: unknown;
  readonly params: unknown;
  readonly query: unknown;
}

@Injectable()
export class ModulesHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(ModulesManagementService)
    private readonly modules: ModulesManagementService,
  ) {}

  async handle(
    operation: "listModules" | ModuleOperation,
    request: ModulesHttpRequest,
  ): Promise<{ status: number; body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === operation,
      )!;
      const write = operation !== "listModules";
      if (
        write &&
        mutationSameOriginValidationError(request.headers) !== undefined
      )
        throw new ModuleManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const actor = write
        ? undefined
        : await this.auth.resolveActor(getHeader(request.headers, "cookie"));
      if (!write && !actor)
        throw new ModuleManagementError(
          401,
          "MODULE_SESSION_REQUIRED",
          "请先登录",
        );
      const parse = (
        ref: keyof typeof schemaRegistry,
        value: unknown,
      ): unknown => {
        const parsed = schemaRegistry[ref].schema.safeParse(value);
        if (!parsed.success) {
          throw new ModuleInputError(
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
        throw new ModuleInputError({ query: "此接口不接受查询参数" });
      if (route.request.path === "none")
        throw new Error("module route requires path schema");
      const path = parse(route.request.path, request.params) as {
        projectId: number;
        moduleId?: number;
      };
      if (!write)
        return {
          status: 200,
          body: schemaRegistry.ModuleListResponse.schema.parse(
            await this.modules.list(actor!.userId, path.projectId),
          ),
        };
      const headers = {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
        ...(operation === "createModule"
          ? {}
          : { "if-match": getHeader(request.headers, "if-match") }),
      };
      if (route.request.headers === "none")
        throw new Error("module route requires header schema");
      parse(route.request.headers, headers);
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new ModuleManagementError(
          400,
          "MODULE_CONTENT_TYPE_INVALID",
          "请求必须使用 application/json",
        );
      if (!("contentTypes" in route.request.body))
        throw new Error("module route requires body schema");
      const input = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      ) as ModuleEditRequest;
      const resolve = async (tx: TransactionContext): Promise<number> => {
        const current = await this.mutation.verify(tx, request.headers);
        if (!current)
          throw new ModuleManagementError(
            401,
            "MODULE_SESSION_REQUIRED",
            "登录或 CSRF 状态已失效",
          );
        await this.modules.authorize(
          tx,
          current.userId,
          path.projectId,
          path.moduleId,
        );
        // ADR-044：模块已无归档/恢复，模块命令对项目内活跃成员开放，
        // 写前检查与角色门禁由服务层在同一事务内完成。
        return current.userId;
      };
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: resolve,
        request: {
          method: route.method,
          path: route.path,
          pathParams: Object.fromEntries(
            Object.entries(path).map(([key, value]) => [key, String(value)]),
          ),
          query: {},
          headers: request.headers,
          body: input,
        },
        execute: async (tx, actorId) => {
          const body = await this.modules.execute(tx, {
            operation,
            actorId,
            projectId: path.projectId,
            ...(path.moduleId === undefined
              ? {}
              : {
                  moduleId: path.moduleId,
                  version: Number(
                    getHeader(request.headers, "if-match")!.slice(1, -1),
                  ),
                }),
            edit: input,
            requestId,
          });
          return {
            responseStatus: 200,
            responseSchemaRef: "ModuleItem",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: { projectId: body.projectId, moduleId: body.id },
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await resolve(tx);
          await this.modules.replay(tx, actorId, record.replayAuthContext);
        },
      });
      return {
        status: result.responseStatus,
        body: schemaRegistry.ModuleItem.schema.parse(result.responseBody),
      };
    } catch (error) {
      let status = 500;
      let code = "INTERNAL_ERROR";
      let message = "暂时无法完成模块操作";
      let details: Record<string, string> = {};
      if (
        error instanceof ModuleManagementError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError
      )
        ({ status, code, message } = error);
      else if (error instanceof ModuleInputError) {
        status = 422;
        code = "MODULE_VALIDATION_FAILED";
        message = "请检查输入字段";
        details = error.fields;
      } else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint_name" in error &&
        error.constraint_name === "modules_name_project_unique"
      ) {
        status = 409;
        code = "MODULE_NAME_CONFLICT";
        message = "该项目已有同名模块";
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

class ModuleInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("invalid module input");
  }
}

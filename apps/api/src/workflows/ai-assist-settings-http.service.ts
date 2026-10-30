import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  aiAssistSettingsReplayContextSchema,
  routeRegistry,
  schemaRegistry,
  type AiAssistModelsRequest,
  type AiAssistSettingsUpdateRequest,
} from "@inpulse/api-contract";

import { AdminHighRiskError } from "../auth/admin-high-risk.error.js";
import { AdminHighRiskAuthService } from "../auth/admin-high-risk.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../auth/csrf.http.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../idempotency/http-service.js";
import type { IdempotencyRecord } from "../idempotency/store.js";
import {
  AiAssistSettingsError,
  AiAssistSettingsInputError,
} from "../modules/document-import/ai-assist-settings.error.js";
import { AiAssistSettingsService } from "../modules/document-import/ai-assist-settings.service.js";

export type AiAssistSettingsOperation =
  | "getAiAssistSettings"
  | "updateAiAssistSettings"
  | "listAiAssistModels"
  | "testAiAssistSettings";

export interface AiAssistSettingsHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly body?: unknown;
}

class AiAssistSettingsHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AiAssistSettingsHttpError";
  }
}

/**
 * ADR-068 管理员配置 HTTP 编排：GET 只读短事务；PUT 由幂等 runner 持有单事务；
 * 测试连接与模型发现的上游网络调用严格在数据库事务之外。
 */
@Injectable()
export class AiAssistSettingsHttpService {
  constructor(
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(AdminHighRiskAuthService)
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(AiAssistSettingsService)
    private readonly settings: AiAssistSettingsService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
  ) {}

  async handle(
    operation: AiAssistSettingsOperation,
    request: AiAssistSettingsHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    const route = routeRegistry.find(
      (entry) => entry.operationId === operation,
    )!;
    try {
      if (operation === "getAiAssistSettings") {
        const item = await this.uow.run((tx) =>
          this.settings.view(tx, request.headers),
        );
        return {
          status: 200,
          body: schemaRegistry.AiAssistSettings.schema.parse(item),
        };
      }
      if (operation === "listAiAssistModels") {
        // 只读管理员门禁；请求体是一次性表单配置，上游 GET 在事务之外执行。
        await this.uow.run((tx) =>
          this.highRisk.verifyRead(tx, request.headers),
        );
        const body = this.parseJsonBody<AiAssistModelsRequest>(route, request);
        const result = await this.settings.listModels(body);
        return {
          status: 200,
          body: schemaRegistry.AiAssistModelsResponse.schema.parse(result),
        };
      }
      if (operation === "testAiAssistSettings") {
        // 只读管理员门禁（不要求 CSRF）；探测网络调用在事务外执行。
        await this.uow.run((tx) =>
          this.highRisk.verifyRead(tx, request.headers),
        );
        const result = await this.settings.testConnection();
        return {
          status: 200,
          body: schemaRegistry.AiAssistSettingsTestResponse.schema.parse(
            result,
          ),
        };
      }
      if (mutationSameOriginValidationError(request.headers) !== undefined) {
        throw new AiAssistSettingsHttpError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      }
      const body = this.parseJsonBody<AiAssistSettingsUpdateRequest>(
        route,
        request,
      );
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: async (tx) => {
          const actor = await this.highRisk.verify(tx, request.headers);
          return actor.userId;
        },
        request: {
          method: route.method,
          path: route.path,
          pathParams: {},
          query: {},
          headers: request.headers,
          body,
        },
        execute: async (tx, actorId) => {
          const item = await this.settings.update(
            tx,
            {
              actorId,
              headers: request.headers,
              requestId,
            },
            body,
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "AiAssistSettings",
            responseHasBody: true,
            responseBody: item,
            replayAuthContext: { actorUserId: actorId, settingsRowId: 1 },
          };
        },
        replayAuthorizer: async (
          record: IdempotencyRecord,
          tx: TransactionContext,
        ) => {
          // 重放前重新验证当前完整管理员会话与 CSRF（ADR-068 2.6）。
          const actor = await this.highRisk.verify(tx, request.headers);
          const context = aiAssistSettingsReplayContextSchema.parse(
            record.replayAuthContext,
          );
          if (context.actorUserId !== actor.userId) {
            throw new AiAssistSettingsHttpError(
              403,
              "ADMIN_REQUIRED",
              "只有原管理员可以重放该配置保存请求",
            );
          }
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

  private parseJsonBody<T>(
    route: (typeof routeRegistry)[number],
    request: AiAssistSettingsHttpRequest,
  ): T {
    if ("noBody" in route.request.body) {
      throw new AiAssistSettingsHttpError(
        400,
        "AI_ASSIST_SETTINGS_BODY_INVALID",
        "该接口不接受请求体",
      );
    }
    const contentType = getHeader(request.headers, "content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new AiAssistSettingsHttpError(
        400,
        "AI_ASSIST_SETTINGS_CONTENT_TYPE_INVALID",
        "请求必须使用 application/json",
      );
    }
    const ref = route.request.body.contentTypes[0]!.schemaRef;
    const parsed = schemaRegistry[ref].schema.safeParse(request.body);
    if (!parsed.success) {
      throw new AiAssistSettingsInputError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      );
    }
    return parsed.data as T;
  }

  private mapError(
    error: unknown,
    requestId: string,
  ): { readonly status: number; readonly body: unknown } {
    if (error instanceof AiAssistSettingsError) {
      return errorBody(error.status, error.code, error.message, {
        ...error.details,
        requestId,
      });
    }
    if (error instanceof AiAssistSettingsHttpError) {
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
    if (error instanceof AiAssistSettingsInputError) {
      return errorBody(
        422,
        "AI_ASSIST_SETTINGS_VALIDATION_FAILED",
        "请检查 AI 辅助转换配置字段",
        { ...error.fields, requestId },
      );
    }
    return errorBody(
      500,
      "INTERNAL_ERROR",
      "服务器无法完成 AI 辅助转换配置操作",
      { requestId },
    );
  }
}

function errorBody(
  status: number,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): { readonly status: number; readonly body: unknown } {
  return {
    status,
    body: schemaRegistry.ErrorResponse.schema.parse({
      code,
      message,
      details,
      requestId: details["requestId"] ?? "",
    }),
  };
}

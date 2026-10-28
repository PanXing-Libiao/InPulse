import { SearchProjectionCapacityError } from "../search/public/search-projection-errors.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  type FeatureEditRequest,
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
  FeaturesManagementService,
  FeatureManagementError,
  type FeatureOperation,
} from "./features-management.service.js";
import { ProjectCapabilityAccessError } from "../projects/index.js";

export interface FeaturesHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly body?: unknown;
  readonly params: unknown;
  readonly query: unknown;
}

@Injectable()
export class FeaturesHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(FeaturesManagementService)
    private readonly features: FeaturesManagementService,
  ) {}

  async handle(
    operation:
      "listFeatures" | "getFeature" | "findSimilarFeatures" | FeatureOperation,
    request: FeaturesHttpRequest,
  ): Promise<{ status: number; body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === operation,
      )!;
      const write = route.method !== "GET";
      if (
        write &&
        mutationSameOriginValidationError(request.headers) !== undefined
      )
        throw new FeatureManagementError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const actor = write
        ? undefined
        : await this.auth.resolveActor(getHeader(request.headers, "cookie"));
      if (!write && !actor)
        throw new FeatureManagementError(
          401,
          "FEATURE_SESSION_REQUIRED",
          "请先登录",
        );
      const parse = (
        ref: keyof typeof schemaRegistry,
        value: unknown,
      ): unknown => {
        const parsed = schemaRegistry[ref].schema.safeParse(value);
        if (!parsed.success) {
          throw new FeatureInputError(
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
      if (
        operation !== "findSimilarFeatures" &&
        Object.keys((request.query ?? {}) as object).length
      )
        throw new FeatureInputError({ query: "此接口不接受查询参数" });
      if (route.request.path === "none")
        throw new Error("feature route requires path schema");
      const path = parse(route.request.path, request.params) as {
        projectId: number;
        moduleId: number;
        featureId?: number;
      };
      if (!write) {
        const body =
          operation === "findSimilarFeatures"
            ? await this.features.similar(
                actor!.userId,
                path.projectId,
                path.moduleId,
                (parse("FeatureSimilarQuery", request.query) as { q: string })
                  .q,
              )
            : await this.features.read(
                actor!.userId,
                path.projectId,
                path.moduleId,
                path.featureId,
              );
        return { status: 200, body };
      }
      const headers = {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
        ...(operation === "createFeature"
          ? {}
          : { "if-match": getHeader(request.headers, "if-match") }),
      };
      if (route.request.headers === "none")
        throw new Error("feature route requires header schema");
      parse(route.request.headers, headers);
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new FeatureManagementError(
          400,
          "FEATURE_CONTENT_TYPE_INVALID",
          "请求必须使用 application/json",
        );
      if (!("contentTypes" in route.request.body))
        throw new Error("feature route requires body schema");
      const input = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      ) as FeatureEditRequest;
      const resolve = async (tx: TransactionContext): Promise<number> => {
        const current = await this.mutation.verify(tx, request.headers);
        if (!current)
          throw new FeatureManagementError(
            401,
            "FEATURE_SESSION_REQUIRED",
            "登录或 CSRF 状态已失效",
          );
        await this.features.authorize(
          tx,
          current.userId,
          path.projectId,
          path.moduleId,
          path.featureId,
        );
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
          const body = await this.features.execute(tx, {
            operation: operation as FeatureOperation,
            actorId,
            projectId: path.projectId,
            moduleId: path.moduleId,
            ...(path.featureId === undefined
              ? {}
              : {
                  featureId: path.featureId,
                  version: Number(
                    getHeader(request.headers, "if-match")!.slice(1, -1),
                  ),
                }),
            edit: input,
            requestId,
          });
          return {
            responseStatus: 200,
            responseSchemaRef: "FeatureItem",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: {
              projectId: body.projectId,
              moduleId: body.moduleId,
              featureId: body.id,
            },
          };
        },
        replayAuthorizer: async (record, tx) => {
          const actorId = await resolve(tx);
          await this.features.replay(tx, actorId, record.replayAuthContext);
        },
      });
      return {
        status: result.responseStatus,
        body: schemaRegistry.FeatureItem.schema.parse(result.responseBody),
      };
    } catch (error) {
      let status = 500;
      let code = "INTERNAL_ERROR";
      let message = "暂时无法完成功能操作";
      let details: Record<string, string> = {};
      if (
        error instanceof FeatureManagementError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof SearchProjectionCapacityError ||
        error instanceof IdempotencyHttpError
      )
        ({ status, code, message } = error);
      else if (error instanceof FeatureInputError) {
        status = 422;
        code = "FEATURE_VALIDATION_FAILED";
        message = "请检查输入字段";
        details = error.fields;
      } else if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint_name" in error &&
        error.constraint_name === "features_project_code_unique"
      ) {
        status = 409;
        code = "FEATURE_CODE_CONFLICT";
        message = "功能编号发生冲突，请联系管理员核对编号序列";
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

class FeatureInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("invalid feature input");
  }
}

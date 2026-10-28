import { SearchProjectionCapacityError } from "../modules/search/search-projection.write-port.js";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { schemaRegistry, routeRegistry } from "@inpulse/api-contract";
import { SessionAuthService } from "../auth/session-auth.service.js";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
} from "../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../idempotency/http-service.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import type { TransactionContext } from "../database/transaction-context.js";
import {
  ExternalLinkWorkflow,
  ExternalLinkError,
} from "./external-link.workflow.js";
import { InvalidGitHubUrlError } from "../modules/external-links/index.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import type { CompletionHttpRequest } from "./task-completion-http.service.js";
@Injectable()
export class ExternalLinkHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(ExternalLinkWorkflow)
    private readonly workflow: ExternalLinkWorkflow,
  ) {}
  async handle(
    operation: "listExternalLinks" | "addExternalLink" | "removeExternalLink",
    request: CompletionHttpRequest,
  ) {
    const requestId = randomUUID();
    try {
      const remove = operation === "removeExternalLink";
      const path = (
        remove
          ? schemaRegistry.ExternalLinkResourcePath
          : schemaRegistry.ExternalLinkTargetPath
      ).schema.safeParse(request.params);
      if (!path.success || Object.keys(request.query ?? {}).length)
        throw new ExternalLinkError(
          422,
          "EXTERNAL_LINK_VALIDATION",
          "目标参数无效",
        );
      const { targetType, targetId } = path.data;
      if (operation === "listExternalLinks")
        return {
          status: 200,
          body: await this.uow.run(async (tx) => {
            const actor = await this.auth.resolveActorInTransaction(
              tx,
              getHeader(request.headers, "cookie"),
            );
            if (!actor)
              throw new ExternalLinkError(
                401,
                "SESSION_REQUIRED",
                "请重新登录",
              );
            return this.workflow.list(tx, actor.userId, targetType, targetId);
          }),
        };
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new ExternalLinkError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源校验",
        );
      const headers = schemaRegistry.RecordDraftVersionHeaders.schema.safeParse(
        {
          "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
          "if-match": getHeader(request.headers, "if-match"),
        },
      );
      if (!headers.success)
        throw new ExternalLinkError(
          422,
          "EXTERNAL_LINK_VALIDATION",
          "请检查版本和安全请求头",
        );
      const body = remove
        ? undefined
        : schemaRegistry.ExternalLinkRequest.schema.safeParse(request.body);
      if (
        (!remove && !body?.success) ||
        (remove &&
          request.body !== undefined &&
          request.body !== null &&
          request.body !== "")
      )
        throw new ExternalLinkError(
          422,
          "EXTERNAL_LINK_VALIDATION",
          "请求正文无效",
        );
      if (
        !remove &&
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new ExternalLinkError(
          400,
          "EXTERNAL_LINK_CONTENT_TYPE",
          "请使用 application/json",
        );
      const actor = async (tx: TransactionContext) => {
        const value = await this.mutation.verify(tx, request.headers);
        if (!value)
          throw new ExternalLinkError(
            401,
            "SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
        return value.userId;
      };
      const route = routeRegistry.find((r) => r.operationId === operation)!;
      const response = await this.idempotency.run({
        operationId: operation,
        actorId: actor,
        request: {
          method: route.method,
          path: route.path,
          pathParams: Object.fromEntries(
            Object.entries(path.data).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
          query: {},
          headers: request.headers,
          body: body?.success ? body.data : undefined,
        },
        execute: async (tx, actorId) => {
          const result = await this.workflow.mutate(
            tx,
            actorId,
            targetType,
            targetId,
            Number(headers.data["if-match"].slice(1, -1)),
            remove
              ? {
                  linkId: schemaRegistry.ExternalLinkResourcePath.schema.parse(
                    request.params,
                  ).linkId,
                }
              : body!.data!,
            requestId,
            () => actor(tx),
          );
          const { rowVersion: _version, ...context } = result;
          return {
            responseStatus: 200,
            responseSchemaRef: "ExternalLinkResult",
            responseHasBody: true,
            responseBody: result,
            replayAuthContext: context,
          };
        },
        replayAuthorizer: async (record, tx) =>
          this.workflow.replay(
            tx,
            await actor(tx),
            targetType,
            targetId,
            record.replayAuthContext,
          ),
      });
      return {
        status: response.responseStatus,
        body: schemaRegistry.ExternalLinkResult.schema.parse(
          response.responseBody,
        ),
      };
    } catch (error) {
      const known =
        error instanceof ExternalLinkError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof SearchProjectionCapacityError ||
        error instanceof IdempotencyHttpError;
      const invalid = error instanceof InvalidGitHubUrlError;
      return {
        status: known ? error.status : invalid ? 422 : 500,
        body: {
          code: known
            ? error.code
            : invalid
              ? "EXTERNAL_LINK_INVALID_URL"
              : "INTERNAL_ERROR",
          message: known || invalid ? error.message : "暂时无法管理GitHub关联",
          details: {},
          requestId,
        },
      };
    }
  }
}

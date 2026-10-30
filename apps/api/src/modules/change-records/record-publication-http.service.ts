import { SearchProjectionCapacityError } from "../search/public/search-projection-errors.js";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  routeRegistry,
  schemaRegistry,
  publishedRecordSchema,
  type PublishedRecordContent,
  type AddRecordLeftoverRequest,
} from "@inpulse/api-contract";
import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
} from "../../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../../idempotency/http-service.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { DraftHttpRequest } from "./record-drafts-http.service.js";
import { RecordPublicationService } from "./record-publication.service.js";
import { RecordPublicationAccess } from "./record-publication-access.js";
import { RecordDraftError } from "./record-drafts.service.js";
export type PublicationOperation =
  | "publishChangeRecord"
  | "createChangeRecordVersion"
  | "addChangeRecordLeftover";
@Injectable()
export class RecordPublicationHttpService {
  constructor(
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(RecordPublicationAccess)
    private readonly access: RecordPublicationAccess,
    @Inject(RecordPublicationService)
    private readonly service: RecordPublicationService,
  ) {}
  async handle(operation: PublicationOperation, request: DraftHttpRequest) {
    const requestId = randomUUID();
    try {
      if (mutationSameOriginValidationError(request.headers) !== undefined)
        throw new RecordDraftError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const route = routeRegistry.find((r) => r.operationId === operation)!,
        publish = operation === "publishChangeRecord";
      const parse = (
        ref: keyof typeof schemaRegistry,
        value: unknown,
      ): unknown => {
        const parsed = schemaRegistry[ref].schema.safeParse(value);
        if (!parsed.success)
          throw new RecordDraftError(
            422,
            "RECORD_PUBLICATION_VALIDATION_FAILED",
            "请检查内容、记录版本和遗留问题（每条最多10000字符，最多50条）",
          );
        return parsed.data;
      };
      if (
        route.request.path === "none" ||
        route.request.headers === "none" ||
        !("contentTypes" in route.request.body)
      )
        throw Error("Publication contract incomplete");
      const path = parse(route.request.path, request.params) as {
        projectId: number;
        recordId: number;
      };
      if (Object.keys((request.query ?? {}) as object).length)
        throw new RecordDraftError(
          422,
          "RECORD_VALIDATION_FAILED",
          "此接口不接受查询参数",
        );
      parse(route.request.headers, {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
        "if-match": getHeader(request.headers, "if-match"),
        ...(publish
          ? {}
          : {
              "x-record-version": getHeader(
                request.headers,
                "x-record-version",
              ),
            }),
      });
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new RecordDraftError(
          400,
          "RECORD_CONTENT_TYPE_INVALID",
          "请使用 application/json",
        );
      const body = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      );
      const actor = async (tx: TransactionContext) => {
        const value = await this.mutation.verify(tx, request.headers);
        if (!value)
          throw new RecordDraftError(
            401,
            "RECORD_SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
        await this.access.authorizeProject(tx, value.userId, path.projectId);
        return value.userId;
      };
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: actor,
        request: {
          method: "POST",
          path: route.path,
          pathParams: Object.fromEntries(
            Object.entries(path).map(([key, value]) => [key, String(value)]),
          ),
          query: {},
          headers: request.headers,
          body,
        },
        execute: async (tx, actorId) => {
          const version = Number(
            getHeader(request.headers, "if-match")!.slice(1, -1),
          );
          const recordVersion = Number(
            getHeader(request.headers, "x-record-version"),
          );
          const value = publish
            ? await this.service.publish(
                tx,
                actorId,
                path.projectId,
                path.recordId,
                version,
                requestId,
              )
            : operation === "addChangeRecordLeftover"
              ? await this.service.appendLeftover(
                  tx,
                  actorId,
                  path.projectId,
                  path.recordId,
                  version,
                  recordVersion,
                  (body as AddRecordLeftoverRequest).content,
                  requestId,
                )
              : await this.service.update(
                  tx,
                  actorId,
                  path.projectId,
                  path.recordId,
                  version,
                  recordVersion,
                  body as PublishedRecordContent,
                  requestId,
                );
          return {
            responseStatus: 200,
            responseSchemaRef: "PublishedRecord",
            responseHasBody: true,
            responseBody: value,
            replayAuthContext: {
              projectId: value.projectId,
              recordId: value.id,
              moduleId: value.moduleId,
              taskId: value.taskId,
              leftoverItemIds: value.leftovers.map((leftover) => leftover.id),
            },
          };
        },
        replayAuthorizer: async (record, tx) =>
          this.service.replay(tx, await actor(tx), record.replayAuthContext),
      });
      return {
        status: result.responseStatus,
        body: publishedRecordSchema.parse(result.responseBody),
      };
    } catch (error) {
      const known =
        error instanceof RecordDraftError ||
        error instanceof SearchProjectionCapacityError ||
        error instanceof IdempotencyHttpError;
      return {
        status: known ? error.status : 500,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "暂时无法保存正式记录",
          details: {},
          requestId,
        }),
      };
    }
  }
}

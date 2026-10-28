import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  routeRegistry,
  schemaRegistry,
  recordDraftItemSchema,
  recordDraftReplayContextSchema,
  type RecordDraftContent,
} from "@inpulse/api-contract";
import { SessionAuthService } from "../auth/session-auth.service.js";
import { AuthenticatedMutationService } from "../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../auth/csrf.http.js";
import {
  IdempotencyHttpService,
  IdempotencyHttpError,
} from "../idempotency/http-service.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { RecordDraftError } from "../modules/change-records/index.js";
import { ProjectCapabilityAccessError } from "../modules/projects/index.js";
import {
  TaskRecordDraftWorkflow,
  type TaskDraftPath,
} from "./task-record-draft.workflow.js";
export interface TaskDraftHttpRequest {
  headers: HttpHeaderBag;
  params: unknown;
  query: unknown;
  body?: unknown;
}
export type TaskDraftOperation =
  "getTaskRecordDrafts" | "createTaskRecordDraft" | "updateTaskRecordDraft";
@Injectable()
export class TaskRecordDraftHttpService {
  constructor(
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
    @Inject(TaskRecordDraftWorkflow)
    private readonly workflow: TaskRecordDraftWorkflow,
  ) {}
  async handle(
    operation: TaskDraftOperation,
    request: TaskDraftHttpRequest,
  ): Promise<{ status: number; body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find((r) => r.operationId === operation)!;
      const write = route.method !== "GET";
      if (
        write &&
        mutationSameOriginValidationError(request.headers) !== undefined
      )
        throw new RecordDraftError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      const actor = write
        ? undefined
        : await this.auth.resolveActor(getHeader(request.headers, "cookie"));
      if (!write && !actor)
        throw new RecordDraftError(401, "DRAFT_SESSION_REQUIRED", "请先登录");
      const parse = (
        ref: keyof typeof schemaRegistry,
        value: unknown,
      ): unknown => {
        const result = schemaRegistry[ref].schema.safeParse(value);
        if (!result.success)
          throw new RecordDraftError(
            422,
            "DRAFT_VALIDATION_FAILED",
            "请检查草稿字段、来源路径和版本",
          );
        return result.data;
      };
      if (Object.keys((request.query ?? {}) as object).length)
        throw new RecordDraftError(
          422,
          "DRAFT_VALIDATION_FAILED",
          "此接口不接受查询参数",
        );
      if (route.request.path === "none") throw Error("source path missing");
      const path = parse(route.request.path, request.params) as TaskDraftPath;
      if (!write)
        return {
          status: 200,
          body: await this.workflow.read(actor!.userId, path),
        };
      if (
        route.request.headers === "none" ||
        !("contentTypes" in route.request.body)
      )
        throw Error("source contract missing");
      parse(route.request.headers, {
        "x-csrf-token": getHeader(request.headers, "x-csrf-token"),
        "if-match": getHeader(request.headers, "if-match"),
      });
      if (
        getHeader(request.headers, "content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new RecordDraftError(
          400,
          "DRAFT_CONTENT_TYPE_INVALID",
          "请使用 application/json",
        );
      const input = parse(
        route.request.body.contentTypes[0]!.schemaRef,
        request.body,
      ) as Omit<RecordDraftContent, "title"> & { title: string | null };
      const resolve = async (tx: TransactionContext) => {
        const actor = await this.mutation.verify(tx, request.headers);
        if (!actor)
          throw new RecordDraftError(
            401,
            "DRAFT_SESSION_REQUIRED",
            "登录或CSRF状态已失效",
          );
        await this.workflow.authorize(tx, actor.userId, path);
        return actor.userId;
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
          const body = await this.workflow.execute(
            tx,
            actorId,
            path,
            Number(getHeader(request.headers, "if-match")!.slice(1, -1)),
            input,
            requestId,
          );
          return {
            responseStatus: 200,
            responseSchemaRef: "RecordDraftItem",
            responseHasBody: true,
            responseBody: body,
            replayAuthContext: {
              projectId: body.projectId,
              recordId: body.id,
              moduleId: body.moduleId,
              featureId: body.featureId,
              taskId: body.taskId,
              impactFeatureIds: body.impactFeatureIds,
            },
          };
        },
        replayAuthorizer: async (record, tx) =>
          this.workflow.replay(
            tx,
            await resolve(tx),
            path,
            recordDraftReplayContextSchema.parse(record.replayAuthContext),
          ),
      });
      return {
        status: result.responseStatus,
        body: recordDraftItemSchema.parse(result.responseBody),
      };
    } catch (error) {
      let status = 500,
        code = "INTERNAL_ERROR",
        message = "暂时无法保存来源草稿";
      if (
        error instanceof RecordDraftError ||
        error instanceof ProjectCapabilityAccessError ||
        error instanceof IdempotencyHttpError
      )
        ({ status, code, message } = error);
      return {
        status,
        body: schemaRegistry.ErrorResponse.schema.parse({
          code,
          message,
          details: {},
          requestId,
        }),
      };
    }
  }
}

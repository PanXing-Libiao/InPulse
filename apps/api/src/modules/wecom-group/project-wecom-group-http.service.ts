import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { routeRegistry, schemaRegistry } from "@inpulse/api-contract";

import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
import { SessionAuthService } from "../../auth/session-auth.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../../auth/csrf.http.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../../idempotency/http-service.js";
import { ProjectCapabilityAccessError } from "../projects/index.js";
import {
  ProjectWecomGroupError,
  ProjectWecomGroupService,
} from "./project-wecom-group.service.js";

export type ProjectWecomGroupOperation =
  | "getProjectWecomGroup"
  | "updateProjectWecomGroupNotificationOptions"
  | "createProjectWecomWebhook"
  | "deleteProjectWecomWebhook";

export interface ProjectWecomGroupHttpRequest {
  readonly headers: HttpHeaderBag;
  readonly params: unknown;
  readonly query: unknown;
  readonly body?: unknown;
}

class ProjectWecomGroupHttpError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectWecomGroupHttpError";
  }
}

class ProjectWecomGroupInputError extends Error {
  constructor(readonly fields: Readonly<Record<string, string>>) {
    super("invalid project wecom group request");
    this.name = "ProjectWecomGroupInputError";
  }
}

/**
 * ADR-090 / ADR-106 项目企微群 HTTP 编排：项目群只处理 Webhook。
 * 读路径独立事务；写命令由幂等 runner 持有单事务，并在重放前重新执行
 * 能力与资源门禁。个人单聊机器人绑定与配置不经过本服务。
 */
@Injectable()
export class ProjectWecomGroupHttpService {
  constructor(
    @Inject(SessionAuthService)
    private readonly sessionAuth: SessionAuthService,
    @Inject(AuthenticatedMutationService)
    private readonly mutation: AuthenticatedMutationService,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(ProjectWecomGroupService)
    private readonly groups: ProjectWecomGroupService,
    @Inject(IdempotencyHttpService)
    private readonly idempotency: IdempotencyHttpService,
  ) {}

  async handle(
    operation: ProjectWecomGroupOperation,
    request: ProjectWecomGroupHttpRequest,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestId = randomUUID();
    try {
      const route = routeRegistry.find(
        (entry) => entry.operationId === operation,
      )!;
      if (Object.keys((request.query ?? {}) as object).length) {
        throw new ProjectWecomGroupInputError({
          query: "此接口不接受查询参数",
        });
      }

      if (operation === "getProjectWecomGroup") {
        const path = this.parseProjectPath(request.params);
        const body = await this.uow.run(async (tx) => {
          const actorId = await this.resolveReadActor(tx, request.headers);
          return this.groups.status(tx, {
            actorId,
            projectId: path.projectId,
          });
        });
        return { status: 200, body };
      }

      const originFailure = mutationSameOriginValidationError(request.headers);
      if (originFailure !== undefined) {
        throw new ProjectWecomGroupHttpError(
          403,
          "CSRF_ORIGIN_REJECTED",
          "请求未通过同源安全校验",
        );
      }

      if (operation === "updateProjectWecomGroupNotificationOptions") {
        const path = this.parseProjectPath(request.params);
        const options = this.parseNotificationOptions(request.body);
        const result = await this.idempotency.run({
          operationId: operation,
          actorId: (tx) => this.resolveWriteActor(tx, request.headers),
          request: {
            method: route.method,
            path: route.path,
            pathParams: { projectId: String(path.projectId) },
            query: {},
            headers: request.headers,
            body: options,
          },
          execute: (tx, actorId) =>
            this.groups.updateNotificationOptions(tx, {
              actorId,
              projectId: path.projectId,
              options,
              requestId,
            }),
          replayAuthorizer: async (record, tx) => {
            const actorId = await this.resolveWriteActor(tx, request.headers);
            await this.groups.notificationOptionsReplayAuthorizer(
              tx,
              actorId,
              record.replayAuthContext,
            );
          },
        });
        return {
          status: result.responseStatus,
          body: result.responseBody,
        };
      }

      if (operation === "createProjectWecomWebhook") {
        const path = this.parseProjectPath(request.params);
        const webhook = this.parseWebhookCreate(request.body);
        const result = await this.idempotency.run({
          operationId: operation,
          actorId: (tx) => this.resolveWriteActor(tx, request.headers),
          request: {
            method: route.method,
            path: route.path,
            pathParams: { projectId: String(path.projectId) },
            query: {},
            headers: request.headers,
            body: webhook,
          },
          execute: (tx, actorId) =>
            this.groups.createWebhook(tx, {
              actorId,
              projectId: path.projectId,
              label: webhook.label,
              webhookUrl: webhook.webhookUrl,
              requestId,
            }),
          replayAuthorizer: async (record, tx) => {
            const actorId = await this.resolveWriteActor(tx, request.headers);
            await this.groups.createWebhookReplayAuthorizer(
              tx,
              actorId,
              record.replayAuthContext,
            );
          },
        });
        return {
          status: result.responseStatus,
          body: result.responseBody,
        };
      }

      const path = this.parseWebhookPath(request.params);
      const result = await this.idempotency.run({
        operationId: operation,
        actorId: (tx) => this.resolveWriteActor(tx, request.headers),
        request: {
          method: route.method,
          path: route.path,
          pathParams: {
            projectId: String(path.projectId),
            bindingId: String(path.bindingId),
          },
          query: {},
          headers: request.headers,
          body: undefined,
        },
        execute: (tx, actorId) =>
          this.groups.deleteWebhook(tx, {
            actorId,
            projectId: path.projectId,
            bindingId: path.bindingId,
            requestId,
          }),
        replayAuthorizer: async (record, tx) => {
          const actorId = await this.resolveWriteActor(tx, request.headers);
          await this.groups.deleteWebhookReplayAuthorizer(
            tx,
            actorId,
            record.replayAuthContext,
          );
        },
      });
      return { status: result.responseStatus, body: undefined };
    } catch (error) {
      return this.mapError(error, requestId);
    }
  }

  private parseProjectPath(value: unknown): { readonly projectId: number } {
    const parsed = schemaRegistry.ProjectWecomGroupPath.schema.safeParse(value);
    if (!parsed.success) {
      throw new ProjectWecomGroupInputError({ path: "项目参数无效" });
    }
    return { projectId: parsed.data.projectId };
  }

  private parseWebhookPath(value: unknown): {
    readonly projectId: number;
    readonly bindingId: number;
  } {
    const parsed =
      schemaRegistry.ProjectWecomWebhookPath.schema.safeParse(value);
    if (!parsed.success) {
      throw new ProjectWecomGroupInputError({
        path: "项目或 Webhook 目标参数无效",
      });
    }
    return parsed.data;
  }

  private parseNotificationOptions(
    value: unknown,
  ): ReturnType<
    typeof schemaRegistry.ProjectWecomGroupNotificationOptions.schema.parse
  > {
    const parsed =
      schemaRegistry.ProjectWecomGroupNotificationOptions.schema.safeParse(
        value,
      );
    if (!parsed.success) {
      throw new ProjectWecomGroupInputError({
        disabledCategories:
          "只接受 task.assign / task.status / record / project.member / scope.delete",
      });
    }
    return parsed.data;
  }

  private parseWebhookCreate(
    value: unknown,
  ): ReturnType<
    typeof schemaRegistry.ProjectWecomWebhookCreateRequest.schema.parse
  > {
    const parsed =
      schemaRegistry.ProjectWecomWebhookCreateRequest.schema.safeParse(value);
    if (!parsed.success) {
      throw new ProjectWecomGroupInputError({
        label: "标签必须为 1 到 80 个字符",
        webhookUrl: "请填写企业微信官方群机器人 Webhook URL",
      });
    }
    return parsed.data;
  }

  private async resolveReadActor(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<number> {
    const actor = await this.sessionAuth.resolveActorInTransaction(
      tx,
      getHeader(headers, "cookie"),
    );
    if (actor === undefined) {
      throw new ProjectWecomGroupHttpError(
        401,
        "PROJECT_WECOM_GROUP_SESSION_REQUIRED",
        "需要有效的认证 Session",
      );
    }
    return actor.userId;
  }

  private async resolveWriteActor(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<number> {
    const actor = await this.mutation.verify(tx, headers);
    if (actor === undefined) {
      throw new ProjectWecomGroupHttpError(
        401,
        "PROJECT_WECOM_GROUP_SESSION_REQUIRED",
        "需要有效的认证 Session 与 CSRF Token",
      );
    }
    return actor.userId;
  }

  private mapError(
    error: unknown,
    requestId: string,
  ): { readonly status: number; readonly body: unknown } {
    if (
      error instanceof ProjectWecomGroupError ||
      error instanceof ProjectCapabilityAccessError
    ) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (error instanceof ProjectWecomGroupHttpError) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (error instanceof IdempotencyHttpError) {
      return errorBody(error.status, error.code, error.message, requestId);
    }
    if (error instanceof ProjectWecomGroupInputError) {
      return errorBody(
        422,
        "PROJECT_WECOM_GROUP_VALIDATION_FAILED",
        "请检查项目企微群 Webhook 请求字段",
        requestId,
        { ...error.fields },
      );
    }
    return errorBody(
      500,
      "INTERNAL_ERROR",
      "服务器无法完成项目企微群 Webhook 操作",
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
) {
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

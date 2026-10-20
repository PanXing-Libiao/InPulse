import { randomUUID } from "node:crypto";

import {
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";

import type {
  NotificationMuteQueryRequest,
  NotificationPath,
  NotificationPreferencesUpdateRequest,
  NotificationQueryRequest,
} from "@inpulse/api-contract";
import {
  ContractBody,
  ContractPath,
  ContractQuery,
  Operation,
} from "../../http/contract.decorators.js";
import { AuthenticatedMutationService } from "../../auth/authenticated-mutation.service.js";
import {
  getHeader,
  mutationSameOriginValidationError,
  type HttpHeaderBag,
} from "../../auth/csrf.http.js";
import { StrictSameOriginGuard } from "../../auth/csrf.guard.js";
import { SessionAuthService } from "../../auth/session-auth.service.js";
import {
  IdempotencyHttpError,
  IdempotencyHttpService,
} from "../../idempotency/http-service.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  NotificationNotFoundError,
  NotificationStateService,
} from "./notification.service.js";
import {
  NotificationQueryService,
  NotificationQueryValidationError,
} from "./notification-query.service.js";
import { NotificationPreferencesService } from "./notification-preferences.service.js";

interface NotificationControllerRequest {
  readonly headers: HttpHeaderBag;
}

interface NotificationControllerResponse {
  status(code: number): unknown;
}

interface ErrorResponseDto {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string>>;
  readonly requestId: string;
}

class NotificationAuthError extends Error {
  readonly code = "NOTIFICATION_UNAUTHENTICATED" as const;

  constructor() {
    super("current session or CSRF token is invalid");
    this.name = "NotificationAuthError";
  }
}

/**
 * F-28 站内通知入口。查询强制当前用户；写操作在同一幂等事务内重新校验
 * Session/CSRF，按 `recipient_id` 条件更新，不接受客户端指定收件人。
 */
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly sessionAuth: SessionAuthService,
    private readonly mutationAuth: AuthenticatedMutationService,
    private readonly queryService: NotificationQueryService,
    private readonly stateService: NotificationStateService,
    private readonly preferencesService: NotificationPreferencesService,
    private readonly idempotency: IdempotencyHttpService,
  ) {}

  @Get()
  @Operation("getNotifications")
  async list(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
    @ContractQuery("getNotifications") query: NotificationQueryRequest,
  ): Promise<unknown | ErrorResponseDto> {
    const requestId = randomUUID();
    const actor = await this.sessionAuth.resolveActor(
      getHeader(request.headers, "cookie"),
    );
    if (actor === undefined) {
      return unauthorized(requestId, response);
    }
    try {
      const result = await this.queryService.query({
        actorUserId: actor.userId,
        ...(query.cursor === undefined ? {} : { after: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.unreadOnly === undefined
          ? {}
          : { unreadOnly: query.unreadOnly }),
        ...(query.mutedProjectCategories === undefined
          ? {}
          : { mutedProjectCategories: query.mutedProjectCategories }),
      });
      return {
        items: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    } catch (error) {
      if (error instanceof NotificationQueryValidationError) {
        response.status(422);
        return validationResponse(requestId, error.message);
      }
      response.status(500);
      return internalError(requestId);
    }
  }

  @Get("unread-count")
  @Operation("getNotificationUnreadCount")
  async unreadCount(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
    @ContractQuery("getNotificationUnreadCount")
    query: NotificationMuteQueryRequest,
  ): Promise<unknown | ErrorResponseDto> {
    const requestId = randomUUID();
    const actor = await this.sessionAuth.resolveActor(
      getHeader(request.headers, "cookie"),
    );
    if (actor === undefined) {
      return unauthorized(requestId, response);
    }
    try {
      return {
        unreadCount: await this.queryService.unreadCount(
          actor.userId,
          query.mutedProjectCategories,
        ),
      };
    } catch (error) {
      if (error instanceof NotificationQueryValidationError) {
        response.status(422);
        return validationResponse(requestId, error.message);
      }
      response.status(500);
      return internalError(requestId);
    }
  }

  @Get("preferences")
  @Operation("getNotificationPreferences")
  async preferences(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
  ): Promise<unknown | ErrorResponseDto> {
    const requestId = randomUUID();
    const actor = await this.sessionAuth.resolveActor(
      getHeader(request.headers, "cookie"),
    );
    if (actor === undefined) {
      return unauthorized(requestId, response);
    }
    try {
      return await this.preferencesService.read(actor.userId);
    } catch {
      response.status(500);
      return internalError(requestId);
    }
  }

  @Put("preferences")
  @HttpCode(200)
  @UseGuards(StrictSameOriginGuard)
  @Operation("updateNotificationPreferences")
  async updatePreferences(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
    @ContractBody("updateNotificationPreferences")
    body: NotificationPreferencesUpdateRequest,
  ): Promise<unknown | ErrorResponseDto> {
    const requestId = randomUUID();
    const originFailure = mutationSameOriginValidationError(request.headers);
    if (originFailure !== undefined) {
      return csrfOriginFailure(requestId, response, originFailure);
    }
    try {
      const result = await this.idempotency.run({
        operationId: "updateNotificationPreferences",
        actorId: async (tx) => this.resolveMutationActor(tx, request),
        request: {
          method: "PUT",
          path: "/notifications/preferences",
          pathParams: {},
          query: {},
          headers: request.headers,
          body,
        },
        execute: async (tx, actorId) => ({
          responseStatus: 200,
          responseSchemaRef: "NotificationPreferences",
          responseHasBody: true,
          responseBody: await this.preferencesService.replace(
            tx,
            actorId,
            body.disabledSettings,
          ),
          replayAuthContext: {},
        }),
        replayAuthorizer: async (_record, tx) => {
          await this.resolveMutationActor(tx, request);
        },
      });
      response.status(result.responseStatus);
      return result.responseBody;
    } catch (error) {
      return this.mapMutationError(error, requestId, response);
    }
  }

  @Post(":notificationId/read")
  @HttpCode(204)
  @UseGuards(StrictSameOriginGuard)
  @Operation("readNotification")
  async read(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
    @ContractPath("readNotification") params: NotificationPath,
  ): Promise<ErrorResponseDto | undefined> {
    return this.runNotificationMutation(
      "readNotification",
      "/notifications/{notificationId}/read",
      request,
      response,
      params,
      async (tx, actorId, notificationId) => {
        await this.stateService.markRead(tx, {
          recipientId: actorId,
          notificationId,
        });
        return { notificationId, recipientId: actorId };
      },
    );
  }

  @Post(":notificationId/unread")
  @HttpCode(204)
  @UseGuards(StrictSameOriginGuard)
  @Operation("unreadNotification")
  async unread(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
    @ContractPath("unreadNotification") params: NotificationPath,
  ): Promise<ErrorResponseDto | undefined> {
    return this.runNotificationMutation(
      "unreadNotification",
      "/notifications/{notificationId}/unread",
      request,
      response,
      params,
      async (tx, actorId, notificationId) => {
        await this.stateService.markUnread(tx, {
          recipientId: actorId,
          notificationId,
        });
        return { notificationId, recipientId: actorId };
      },
    );
  }

  @Post("read-all")
  @HttpCode(204)
  @UseGuards(StrictSameOriginGuard)
  @Operation("readAllNotifications")
  async readAll(
    @Req() request: NotificationControllerRequest,
    @Res({ passthrough: true }) response: NotificationControllerResponse,
  ): Promise<ErrorResponseDto | undefined> {
    const requestId = randomUUID();
    const originFailure = mutationSameOriginValidationError(request.headers);
    if (originFailure !== undefined) {
      return csrfOriginFailure(requestId, response, originFailure);
    }
    try {
      const result = await this.idempotency.run({
        operationId: "readAllNotifications",
        actorId: async (tx) => this.resolveMutationActor(tx, request),
        request: {
          method: "POST",
          path: "/notifications/read-all",
          pathParams: {},
          query: {},
          headers: request.headers,
          body: undefined,
        },
        execute: async (tx, actorId) => {
          await this.stateService.readAll(tx, actorId);
          return noBodyResult({});
        },
        replayAuthorizer: async (_record, tx) => {
          await this.resolveMutationActor(tx, request);
        },
      });
      response.status(result.responseStatus);
      return undefined;
    } catch (error) {
      return this.mapMutationError(error, requestId, response);
    }
  }

  private async runNotificationMutation(
    operationId: "readNotification" | "unreadNotification",
    routePath: string,
    request: NotificationControllerRequest,
    response: NotificationControllerResponse,
    params: NotificationPath,
    execute: (
      tx: TransactionContext,
      actorId: number,
      notificationId: number,
    ) => Promise<{
      readonly notificationId: number;
      readonly recipientId: number;
    }>,
  ): Promise<ErrorResponseDto | undefined> {
    const requestId = randomUUID();
    const originFailure = mutationSameOriginValidationError(request.headers);
    if (originFailure !== undefined) {
      return csrfOriginFailure(requestId, response, originFailure);
    }
    try {
      const result = await this.idempotency.run({
        operationId,
        actorId: async (tx) => this.resolveMutationActor(tx, request),
        request: {
          method: "POST",
          path: routePath,
          pathParams: {
            notificationId: String(params.notificationId),
          },
          query: {},
          headers: request.headers,
          body: undefined,
        },
        execute: async (tx, actorId) => {
          const context = await execute(tx, actorId, params.notificationId);
          return noBodyResult(context);
        },
        replayAuthorizer: async (_record, tx) => {
          const actor = await this.resolveMutationActor(tx, request);
          await this.stateService.assertOwned(tx, actor, params.notificationId);
        },
      });
      response.status(result.responseStatus);
      return undefined;
    } catch (error) {
      return this.mapMutationError(error, requestId, response);
    }
  }

  private async resolveMutationActor(
    tx: TransactionContext,
    request: NotificationControllerRequest,
  ): Promise<number> {
    const actor = await this.mutationAuth.verify(tx, request.headers);
    if (actor === undefined) {
      throw new NotificationAuthError();
    }
    return actor.userId;
  }

  private mapMutationError(
    error: unknown,
    requestId: string,
    response: NotificationControllerResponse,
  ): ErrorResponseDto {
    if (error instanceof NotificationAuthError) {
      response.status(401);
      return {
        code: error.code,
        message: "需要有效认证 Session 与 CSRF Token",
        details: {},
        requestId,
      };
    }
    if (error instanceof NotificationNotFoundError) {
      response.status(404);
      return {
        code: error.code,
        message: "通知不存在或不属于当前用户",
        details: {},
        requestId,
      };
    }
    if (error instanceof IdempotencyHttpError) {
      response.status(error.status);
      return {
        code: error.code,
        message: error.message,
        details: {},
        requestId,
      };
    }
    response.status(500);
    return internalError(requestId);
  }
}

function noBodyResult(replayAuthContext: Record<string, unknown>) {
  return {
    responseStatus: 204,
    responseSchemaRef: null,
    responseHasBody: false,
    responseBody: null,
    replayAuthContext,
  };
}

function unauthorized(
  requestId: string,
  response: NotificationControllerResponse,
): ErrorResponseDto {
  response.status(401);
  return {
    code: "NOTIFICATION_UNAUTHENTICATED",
    message: "需要有效认证 Session 才能查看通知",
    details: {},
    requestId,
  };
}

function validationResponse(
  requestId: string,
  message: string,
): ErrorResponseDto {
  return {
    code: "NOTIFICATION_VALIDATION_FAILED",
    message,
    details: {},
    requestId,
  };
}

function csrfOriginFailure(
  requestId: string,
  response: NotificationControllerResponse,
  reason: string,
): ErrorResponseDto {
  response.status(403);
  return {
    code: "CSRF_ORIGIN_REJECTED",
    message: "请求未通过同源或 Fetch Metadata 校验",
    details: { reason },
    requestId,
  };
}

function internalError(requestId: string): ErrorResponseDto {
  return {
    code: "INTERNAL_ERROR",
    message: "服务器无法完成通知操作",
    details: {},
    requestId,
  };
}

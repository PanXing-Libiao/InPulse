import { describe, expect, test, vi } from "vitest";

import type { AuthenticatedSessionActor } from "../src/auth/session-auth.service.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { IdempotencyHttpCommand } from "../src/idempotency/http-service.js";
import { NotificationNotFoundError } from "../src/modules/notifications/notification.service.js";
import type { NotificationQueryCommand } from "../src/modules/notifications/notification-query.service.js";
import { NotificationsController } from "../src/modules/notifications/notifications.controller.js";

const actor: AuthenticatedSessionActor = {
  sessionId: 1,
  userId: 7,
  authState: "AUTHENTICATED",
  authVersionAtIssue: 1,
};

class FakeSessionAuth {
  value: AuthenticatedSessionActor | undefined = actor;

  async resolveActor(): Promise<AuthenticatedSessionActor | undefined> {
    return this.value;
  }
}

class FakeMutationAuth {
  value: AuthenticatedSessionActor | undefined = actor;

  async verify(
    _tx: TransactionContext,
  ): Promise<AuthenticatedSessionActor | undefined> {
    return this.value;
  }
}

class FakeIdempotency {
  error: unknown;
  calls: IdempotencyHttpCommand[] = [];

  async run(input: IdempotencyHttpCommand): Promise<{
    readonly responseStatus: number;
    readonly responseSchemaRef: string | null;
    readonly responseHasBody: boolean;
    readonly responseBody: unknown | null;
  }> {
    this.calls.push(input);
    const tx = {} as TransactionContext;
    const resolvedActor =
      typeof input.actorId === "function"
        ? await input.actorId(tx)
        : input.actorId;
    await input.execute?.(tx, resolvedActor);
    if (this.error !== undefined) {
      throw this.error;
    }
    return {
      responseStatus: 204,
      responseSchemaRef: null,
      responseHasBody: false,
      responseBody: null,
    };
  }
}

class FakeQueryService {
  queryCommands: NotificationQueryCommand[] = [];
  unread = 3;
  error: unknown;

  async query(command: NotificationQueryCommand): Promise<{
    readonly items: readonly never[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }> {
    this.queryCommands.push(command);
    if (this.error !== undefined) {
      throw this.error;
    }
    return { items: [], nextCursor: null, hasMore: false };
  }

  unreadCalls: Array<string | undefined> = [];

  async unreadCount(
    _actorUserId: number,
    mutedProjectCategories?: string,
  ): Promise<number> {
    this.unreadCalls.push(mutedProjectCategories);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.unread;
  }
}

class FakeStateService {
  error: unknown;
  markReadArgs:
    | { readonly recipientId: number; readonly notificationId: number }
    | undefined;

  async markRead(
    _tx: TransactionContext,
    input: { readonly recipientId: number; readonly notificationId: number },
  ): Promise<void> {
    this.markReadArgs = input;
    if (this.error !== undefined) {
      throw this.error;
    }
  }

  async assertOwned(): Promise<void> {
    if (this.error !== undefined) {
      throw this.error;
    }
  }
}

function responseFixture() {
  return { status: vi.fn(() => undefined) };
}

function mutationHeaders(): Readonly<Record<string, string>> {
  return {
    cookie: "__Host-session=token",
    host: "127.0.0.1",
    origin: "http://127.0.0.1",
    "x-csrf-token": "csrf-token",
    "idempotency-key": "key-1234567890abcdef",
  };
}

function createController(
  session: FakeSessionAuth,
  query: FakeQueryService,
  state: FakeStateService,
  mutation: FakeMutationAuth = new FakeMutationAuth(),
  idempotency: FakeIdempotency = new FakeIdempotency(),
): {
  readonly controller: NotificationsController;
  readonly idempotency: FakeIdempotency;
} {
  return {
    controller: new NotificationsController(
      session as never,
      mutation as never,
      query as never,
      state as never,
      idempotency as never,
    ),
    idempotency,
  };
}

describe("NotificationsController", () => {
  test("匿名查询返回 401；有效查询只使用契约解析后的当前用户与参数", async () => {
    const session = new FakeSessionAuth();
    session.value = undefined;
    const query = new FakeQueryService();
    const { controller } = createController(
      session,
      query,
      new FakeStateService(),
    );
    const anonymousResponse = responseFixture();
    const anonymous = await controller.list(
      { headers: {} },
      anonymousResponse as never,
      {},
    );
    expect(anonymousResponse.status).toHaveBeenCalledWith(401);
    expect(anonymous).toMatchObject({ code: "NOTIFICATION_UNAUTHENTICATED" });

    session.value = actor;
    const response = responseFixture();
    const result = await controller.list(
      { headers: { cookie: "__Host-session=token" } },
      response as never,
      { cursor: "opaque", limit: 10, unreadOnly: true },
    );
    expect(query.queryCommands).toEqual([
      {
        actorUserId: 7,
        after: "opaque",
        limit: 10,
        unreadOnly: true,
      },
    ]);
    expect(result).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  test("未读数正常返回 200，未知错误返回 500", async () => {
    const query = new FakeQueryService();
    const { controller } = createController(
      new FakeSessionAuth(),
      query,
      new FakeStateService(),
    );
    const countResponse = responseFixture();
    expect(
      await controller.unreadCount(
        { headers: { cookie: "__Host-session=token" } },
        countResponse as never,
        { mutedProjectCategories: "12:task.assign" },
      ),
    ).toEqual({ unreadCount: 3 });
    expect(query.unreadCalls).toEqual(["12:task.assign"]);

    query.error = new Error("database");
    const errorResponse = responseFixture();
    expect(
      await controller.unreadCount(
        { headers: { cookie: "__Host-session=token" } },
        errorResponse as never,
        {},
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(errorResponse.status).toHaveBeenCalledWith(500);
  });

  test("标记已读使用契约解析后的数字通知 ID 并执行同事务命令", async () => {
    const state = new FakeStateService();
    const { controller, idempotency } = createController(
      new FakeSessionAuth(),
      new FakeQueryService(),
      state,
    );
    const response = responseFixture();

    const result = await controller.read(
      { headers: mutationHeaders() },
      response as never,
      { notificationId: 42 },
    );

    expect(result).toBeUndefined();
    expect(response.status).toHaveBeenCalledWith(204);
    expect(idempotency.calls).toHaveLength(1);
    expect(idempotency.calls[0]?.operationId).toBe("readNotification");
    expect(idempotency.calls[0]?.request.pathParams).toEqual({
      notificationId: "42",
    });
    expect(state.markReadArgs).toEqual({ recipientId: 7, notificationId: 42 });
    expect(idempotency.calls[0]?.replayAuthorizer).toBeDefined();
  });

  test("认证失败映射 401，非本人映射 404，来源映射 403", async () => {
    const unavailable = new FakeMutationAuth();
    unavailable.value = undefined;
    const unavailableState = new FakeStateService();
    const unavailableController = createController(
      new FakeSessionAuth(),
      new FakeQueryService(),
      unavailableState,
      unavailable,
    ).controller;
    const unauthorizedResponse = responseFixture();
    expect(
      await unavailableController.read(
        { headers: mutationHeaders() },
        unauthorizedResponse as never,
        { notificationId: 42 },
      ),
    ).toMatchObject({ code: "NOTIFICATION_UNAUTHENTICATED" });
    expect(unauthorizedResponse.status).toHaveBeenCalledWith(401);

    const notFoundState = new FakeStateService();
    notFoundState.error = new NotificationNotFoundError();
    const notFoundController = createController(
      new FakeSessionAuth(),
      new FakeQueryService(),
      notFoundState,
    ).controller;
    const notFoundResponse = responseFixture();
    expect(
      await notFoundController.read(
        { headers: mutationHeaders() },
        notFoundResponse as never,
        { notificationId: 999 },
      ),
    ).toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
    expect(notFoundResponse.status).toHaveBeenCalledWith(404);

    const missingOriginResponse = responseFixture();
    expect(
      await unavailableController.read(
        { headers: { ...mutationHeaders(), origin: undefined } },
        missingOriginResponse as never,
        { notificationId: 42 },
      ),
    ).toMatchObject({ code: "CSRF_ORIGIN_REJECTED" });
    expect(missingOriginResponse.status).toHaveBeenCalledWith(403);
  });
});

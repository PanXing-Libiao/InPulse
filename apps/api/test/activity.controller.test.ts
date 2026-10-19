import { describe, expect, test, vi } from "vitest";

import type { AuthenticatedSessionActor } from "../src/auth/session-auth.service.js";
import {
  ActivityAuthorizationError,
  ActivityQueryValidationError,
  type ActivityQueryCommand,
  type ActivityQueryPage,
} from "../src/modules/activity/activity-query.service.js";
import { ActivityController } from "../src/modules/activity/activity.controller.js";

class FakeSessionAuth {
  actor: AuthenticatedSessionActor | undefined = {
    sessionId: 1,
    userId: 7,
    authState: "AUTHENTICATED",
    authVersionAtIssue: 1,
  };
  calls = 0;

  async resolveActor(): Promise<AuthenticatedSessionActor | undefined> {
    this.calls += 1;
    return this.actor;
  }
}

class FakeActivityService {
  result: ActivityQueryPage = {
    items: [
      {
        id: "42",
        projectId: 42,
        sourceEntityType: "TASK",
        sourceEntityId: 9,
        activityType: "TASK_COMPLETED",
        actorId: 7,
        actorName: "成员",
        summary: "完成登录任务",
        occurredAt: "2026-09-08T00:00:00.000Z",
      },
    ],
    nextCursor: "opaque-cursor",
    hasMore: false,
    dayTotals: [{ day: "2026-09-08", count: 3 }],
    dayTotalsTruncated: false,
  };
  error: unknown;
  commands: ActivityQueryCommand[] = [];

  async query(command: ActivityQueryCommand): Promise<ActivityQueryPage> {
    this.commands.push(command);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.result;
  }
}

function responseFixture() {
  return { status: vi.fn(() => undefined) };
}

const request = {
  headers: { cookie: "__Host-session=token" },
};

describe("ActivityController", () => {
  test("匿名请求返回 401 且不调用查询", async () => {
    const session = new FakeSessionAuth();
    session.actor = undefined;
    const service = new FakeActivityService();
    const controller = new ActivityController(
      session as never,
      service as never,
    );
    const response = responseFixture();

    const result = await controller.list(
      request,
      response as never,
      { projectId: 42 },
      {},
    );

    expect(session.calls).toBe(1);
    expect(service.commands).toEqual([]);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(result).toMatchObject({ code: "ACTIVITY_UNAUTHENTICATED" });
  });

  test("路径参数由字符串安全解析为数字并透传查询参数", async () => {
    const session = new FakeSessionAuth();
    const service = new FakeActivityService();
    const controller = new ActivityController(
      session as never,
      service as never,
    );
    const response = responseFixture();

    const result = await controller.list(
      request,
      response as never,
      { projectId: 42 },
      {
        cursor: "opaque",
        limit: 10,
        includeAdminOnly: true,
        category: "task",
      },
    );

    expect(service.commands).toEqual([
      {
        actorUserId: 7,
        projectId: 42,
        after: "opaque",
        limit: 10,
        includeAdminOnly: true,
        category: "task",
      },
    ]);
    expect(result).toEqual({
      items: service.result.items,
      nextCursor: "opaque-cursor",
      hasMore: false,
      dayTotals: [{ day: "2026-09-08", count: 3 }],
      dayTotalsTruncated: false,
    });
    expect(response.status).not.toHaveBeenCalled();
  });

  test("契约解析后的路径与查询参数不再二次校验", async () => {
    const session = new FakeSessionAuth();
    const service = new FakeActivityService();
    const controller = new ActivityController(
      session as never,
      service as never,
    );
    const response = responseFixture();

    const result = await controller.list(
      request,
      response as never,
      { projectId: 42 },
      { limit: 10 },
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(service.commands).toEqual([
      { actorUserId: 7, projectId: 42, limit: 10 },
    ]);
    expect(result).toMatchObject({ hasMore: false });
  });

  test("无权限项目返回 404，游标错误返回 422，未知错误返回 500", async () => {
    const session = new FakeSessionAuth();
    const controller = new ActivityController(
      session as never,
      new FakeActivityService() as never,
    );

    const authService = new FakeActivityService();
    authService.error = new ActivityAuthorizationError("forbidden");
    const authController = new ActivityController(
      session as never,
      authService as never,
    );
    const authResponse = responseFixture();
    expect(
      await authController.list(
        request,
        authResponse as never,
        { projectId: 42 },
        {},
      ),
    ).toMatchObject({ code: "ACTIVITY_PROJECT_NOT_FOUND" });
    expect(authResponse.status).toHaveBeenCalledWith(404);

    const cursorService = new FakeActivityService();
    cursorService.error = new ActivityQueryValidationError(
      "invalid-cursor",
      "cursor expired",
    );
    const cursorController = new ActivityController(
      session as never,
      cursorService as never,
    );
    const cursorResponse = responseFixture();
    expect(
      await cursorController.list(
        request,
        cursorResponse as never,
        { projectId: 42 },
        {},
      ),
    ).toMatchObject({ code: "ACTIVITY_VALIDATION_FAILED" });
    expect(cursorResponse.status).toHaveBeenCalledWith(422);

    const serverService = new FakeActivityService();
    serverService.error = new Error("database");
    const serverController = new ActivityController(
      session as never,
      serverService as never,
    );
    const serverResponse = responseFixture();
    expect(
      await serverController.list(
        request,
        serverResponse as never,
        { projectId: 42 },
        {},
      ),
    ).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(serverResponse.status).toHaveBeenCalledWith(500);
    expect(controller).toBeDefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import { notAdmin } from "../src/auth/admin-high-risk.error.js";
import type { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import type { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import type { PasswordService } from "../src/auth/password.service.js";
import type { SessionAuthService } from "../src/auth/session-auth.service.js";
import type { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type {
  IdempotencyHttpCommand,
  IdempotencyHttpService,
} from "../src/idempotency/http-service.js";
import type { AdminUserService } from "../src/admin-users/admin-user.service.js";
import type { AdminUserRepository } from "../src/admin-users/admin-user.repository.js";
import { AdminUsersHttpService } from "../src/admin-users/admin-user-http.service.js";
import {
  adminUserOpenTasks,
  adminUserActiveProjectMembership,
  adminUserSelfMutation,
} from "../src/admin-users/admin-user.error.js";

const tx = {} as TransactionContext;
const userId = 7;
const ADMIN_USER_INITIAL_PASSWORD = "initial-password";
const actor = { userId };
const item = {
  id: 9,
  loginName: "member",
  name: "成员",
  email: "member@example.com",
  avatarUrl: null,
  isAdmin: false,
  organizationId: null,
  status: "ACTIVE",
  openTaskCount: 0,
  rowVersion: 1,
  disabledAt: null,
  deletedAt: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
} as const;

function validRequest() {
  return {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      cookie: "__Host-session=x".repeat(43),
      "x-csrf-token": "a".repeat(43),
      "idempotency-key": "f03-http-request-key-0001",
      "if-match": '"1"',
      "content-type": "application/json",
    },
    params: { userId: String(item.id) },
    query: {},
    body: { name: "  新成员  ", email: "new@example.com" },
  };
}

function setup() {
  const resolveActor = vi.fn().mockResolvedValue(actor);
  const mutationVerify = vi.fn().mockResolvedValue(actor);
  const highRiskVerify = vi.fn().mockResolvedValue(actor);
  const find = vi
    .fn()
    .mockResolvedValue({ ...item, isAdmin: true, id: userId });
  const list = vi.fn().mockResolvedValue([item]);
  const create = vi.fn().mockResolvedValue(item);
  const update = vi.fn().mockResolvedValue({ ...item, rowVersion: 2 });
  const disable = vi.fn().mockResolvedValue(undefined);
  const enable = vi.fn().mockResolvedValue(undefined);
  const forceLogout = vi.fn().mockResolvedValue(undefined);
  const deleteUser = vi.fn().mockResolvedValue(undefined);
  const replay = vi.fn().mockResolvedValue(undefined);
  const run = vi.fn(
    async (callback: (tx: TransactionContext) => Promise<unknown>) =>
      callback(tx),
  );
  let command: IdempotencyHttpCommand | undefined;
  const idempotencyRun = vi.fn(async (input: IdempotencyHttpCommand) => {
    command = input;
    const resolved =
      typeof input.actorId === "number"
        ? input.actorId
        : await input.actorId(tx);
    return input.execute(tx, resolved);
  });
  const service = new AdminUsersHttpService(
    {
      resolveActorInTransaction: resolveActor,
    } as unknown as SessionAuthService,
    { verify: mutationVerify } as unknown as AuthenticatedMutationService,
    { verify: highRiskVerify } as unknown as AdminHighRiskAuthService,
    { run } as unknown as PostgresUnitOfWork,
    { find, list } as unknown as AdminUserRepository,
    {
      create,
      update,
      disable,
      enable,
      forceLogout,
      delete: deleteUser,
      replay,
    } as unknown as AdminUserService,
    {
      createHash: vi.fn().mockResolvedValue("$argon2id$test"),
    } as unknown as PasswordService,
    { run: idempotencyRun } as unknown as IdempotencyHttpService,
  );
  return {
    service,
    resolveActor,
    mutationVerify,
    highRiskVerify,
    find,
    list,
    create,
    update,
    disable,
    enable,
    forceLogout,
    deleteUser,
    replay,
    idempotencyRun,
    command: () => command!,
  };
}

describe("F-03 AdminUsersHttpService", () => {
  it("管理员可读取用户列表，非管理员和匿名被拒绝", async () => {
    const s = setup();
    expect(
      (await s.service.handle("listAdminUsers", validRequest())).status,
    ).toBe(200);
    s.find.mockResolvedValue({ ...item, isAdmin: false, id: userId });
    expect(
      (await s.service.handle("listAdminUsers", validRequest())).status,
    ).toBe(403);
    s.resolveActor.mockResolvedValue(undefined);
    expect(
      (await s.service.handle("listAdminUsers", validRequest())).status,
    ).toBe(401);
  });

  it("创建用户时先在此事务外生成密码哈希，再执行幂等命令", async () => {
    const s = setup();
    const request = {
      ...validRequest(),
      body: {
        loginName: "new-user",
        name: "新用户",
        password: ADMIN_USER_INITIAL_PASSWORD,
      },
    };
    const result = await s.service.handle("createUser", request);
    expect(result.status).toBe(200);
    expect(s.command().operationId).toBe("createUser");
    expect(s.command().request.body).toMatchObject({
      loginName: "new-user",
      name: "新用户",
    });
    expect(s.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorId: userId }),
      expect.objectContaining({ loginName: "new-user" }),
      "$argon2id$test",
    );
  });

  it("拒绝无 CSRF、无重认证和非法字段，且不执行业务写入", async () => {
    const s = setup();
    const request = validRequest();
    expect(
      (
        await s.service.handle("createUser", {
          ...request,
          body: { name: " " },
        })
      ).status,
    ).toBe(422);
    s.highRiskVerify.mockRejectedValueOnce(notAdmin());
    expect((await s.service.handle("updateUser", request)).status).toBe(403);
    expect(s.create).not.toHaveBeenCalled();
    expect(s.update).not.toHaveBeenCalled();
  });

  it("映射自身停用与 409 状态冲突为安全错误", async () => {
    const s = setup();
    s.update.mockRejectedValueOnce(adminUserSelfMutation());
    const result = await s.service.handle("updateUser", validRequest());
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: "ADMIN_USER_SELF_MUTATION_REJECTED",
    });
  });

  it("删除用户使用 If-Match、幂等键与 CSRF，并映射活跃项目成员冲突", async () => {
    const s = setup();
    const result = await s.service.handle("deleteUser", validRequest());
    expect(result.status).toBe(204);
    expect(s.command().operationId).toBe("deleteUser");
    expect(s.deleteUser).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorId: userId }),
      item.id,
      1,
    );
    expect(s.mutationVerify).toHaveBeenCalledWith(tx, validRequest().headers);

    s.deleteUser.mockRejectedValueOnce(adminUserActiveProjectMembership());
    const conflict = await s.service.handle("deleteUser", validRequest());
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "ADMIN_USER_ACTIVE_PROJECT_MEMBERSHIP",
    });
  });

  it("重放前重新验证管理员重认证与结果资源仍存在", async () => {
    const s = setup();
    await s.service.handle("disableUser", validRequest());
    const authorizer = s.command().replayAuthorizer!;
    await authorizer(
      { replayAuthContext: { actorUserId: userId, userId: item.id } } as never,
      tx,
    );
    expect(s.mutationVerify).toHaveBeenCalledWith(tx, validRequest().headers);
    expect(s.replay).toHaveBeenCalledWith(tx, userId, {
      actorUserId: userId,
      userId: item.id,
    });
  });

  it("停用被未完成任务阻断时返回 409 和任务数量", async () => {
    const s = setup();
    s.disable.mockRejectedValueOnce(adminUserOpenTasks(4));
    const result = await s.service.handle("disableUser", validRequest());
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: "ADMIN_USER_HAS_OPEN_TASKS",
      details: { reason: "open-tasks", openTaskCount: 4 },
    });
  });

  it("数据库和未知错误统一 500，不泄露内部信息", async () => {
    const s = setup();
    s.update.mockRejectedValueOnce(new Error("password_hash table detail"));
    const result = await s.service.handle("updateUser", validRequest());
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("password_hash");
  });
});

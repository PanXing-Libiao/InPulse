import { describe, expect, test, vi } from "vitest";

import type { CasdoorImportPreviewResponse } from "@inpulse/api-contract";
import type { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import type { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import type { SessionAuthService } from "../src/auth/session-auth.service.js";
import type { CasdoorImportPort } from "../src/auth/sso/casdoor-import.port.js";
import {
  SsoCasdoorDirectoryError,
  type CasdoorDirectorySnapshot,
} from "../src/auth/sso/sso-casdoor-directory.client.js";
import { SsoCasdoorPermissionError } from "../src/auth/sso/sso-casdoor-permission.client.js";
import type { TransactionContext } from "../src/database/transaction-context.js";
import type { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import type {
  IdempotencyHttpCommand,
  IdempotencyHttpService,
} from "../src/idempotency/http-service.js";
import { AdminCasdoorImportHttpService } from "../src/admin-users/admin-casdoor-import-http.service.js";
import type { AdminCasdoorImportService } from "../src/admin-users/admin-casdoor-import.service.js";
import type { AdminUserRepository } from "../src/admin-users/admin-user.repository.js";

const tx = {} as TransactionContext;
const actor = { userId: 7 };
const snapshot: CasdoorDirectorySnapshot = {
  organization: "libiaorobot.com",
  fetchedAt: new Date("2026-10-27T00:00:00.000Z"),
  users: [
    {
      casdoorId: "casdoor-one",
      loginName: "one",
      displayName: "成员一",
      email: "one@libiaorobot.com",
      groups: ["libiaorobot.com/测试部"],
    },
  ],
};

const previewBody: CasdoorImportPreviewResponse = {
  organization: snapshot.organization,
  fetchedAt: snapshot.fetchedAt.toISOString(),
  scannedUserCount: 1,
  items: [
    {
      casdoorId: "casdoor-one",
      loginName: "one",
      displayName: "成员一",
      email: "one@libiaorobot.com",
      groups: ["libiaorobot.com/测试部"],
      action: "create",
      reason: null,
    },
  ],
  counts: { create: 1, link: 0, refresh: 0, unchanged: 0, skip: 0 },
};

function request() {
  return {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      cookie: "__Host-session=" + "x".repeat(43),
      "x-csrf-token": "a".repeat(43),
      "content-type": "application/json",
      "idempotency-key": "casdoor-import-http-key-0001",
    },
    query: {},
    body: { casdoorUserIds: ["casdoor-one"] },
  };
}

function setup() {
  const find = vi.fn().mockResolvedValue({ id: actor.userId, isAdmin: true });
  const loadDirectory = vi.fn().mockResolvedValue(snapshot);
  const preview = vi.fn().mockResolvedValue(previewBody);
  const imported = {
    scannedUserCount: 1,
    created: 1,
    linked: 0,
    refreshed: 0,
    skipped: 0,
    createdOrganizationCount: 1,
    membershipCount: 1,
  };
  const importUsers = vi.fn().mockResolvedValue(imported);
  const run = vi.fn(
    async (callback: (context: TransactionContext) => Promise<unknown>) =>
      callback(tx),
  );
  let command: IdempotencyHttpCommand | undefined;
  const idempotencyRun = vi.fn(async (input: IdempotencyHttpCommand) => {
    command = input;
    const actorId =
      typeof input.actorId === "number"
        ? input.actorId
        : await input.actorId(tx);
    return input.execute(tx, actorId);
  });
  const service = new AdminCasdoorImportHttpService(
    {
      resolveActorInTransaction: vi.fn().mockResolvedValue(actor),
    } as unknown as SessionAuthService,
    {
      verify: vi.fn().mockResolvedValue(actor),
    } as unknown as AuthenticatedMutationService,
    {
      verify: vi.fn().mockResolvedValue(actor),
    } as unknown as AdminHighRiskAuthService,
    { run } as unknown as PostgresUnitOfWork,
    { find } as unknown as AdminUserRepository,
    { preview, import: importUsers } as unknown as AdminCasdoorImportService,
    { loadDirectory } as unknown as CasdoorImportPort,
    { run: idempotencyRun } as unknown as IdempotencyHttpService,
  );
  return {
    service,
    find,
    loadDirectory,
    preview,
    importUsers,
    idempotencyRun,
    command: () => command!,
  };
}

describe("AdminCasdoorImportHttpService", () => {
  test("预览先验证管理员，网络读取在事务外，再以只读事务分类", async () => {
    const s = setup();
    const result = await s.service.preview(request());

    expect(result.status).toBe(200);
    expect(result.body).toEqual(previewBody);
    expect(s.loadDirectory).toHaveBeenCalledTimes(1);
    expect(s.preview).toHaveBeenCalledWith(tx, snapshot);
  });

  test("确认导入复用单一幂等事务，只向审计服务传递计数结果", async () => {
    const s = setup();
    const result = await s.service.import(request());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      created: 1,
      createdOrganizationCount: 1,
    });
    expect(s.command().operationId).toBe("importCasdoorUsers");
    expect(s.command().request.body).toEqual({
      casdoorUserIds: ["casdoor-one"],
    });
    expect(s.importUsers).toHaveBeenCalledWith(
      tx,
      { actorId: actor.userId, requestId: expect.any(String) },
      snapshot,
      ["casdoor-one"],
    );
    expect(JSON.stringify(result)).not.toContain("one@libiaorobot.com");
  });

  test("目录在预览后缺失所选账号时，在幂等执行内整批 409", async () => {
    const s = setup();
    const stale = {
      ...snapshot,
      users: [],
    };
    s.loadDirectory.mockResolvedValue(stale);
    const result = await s.service.import(request());

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: "CASDOOR_IMPORT_PREVIEW_STALE",
    });
    expect(s.importUsers).not.toHaveBeenCalled();
  });

  test("同源校验失败时不读取 Casdoor", async () => {
    const s = setup();
    const invalid = request();
    invalid.headers.origin = "https://evil.example";
    const result = await s.service.import(invalid);

    expect(result.status).toBe(403);
    expect(s.loadDirectory).not.toHaveBeenCalled();
  });

  test("上游目录不可用映射为 503，且不泄露内部错误", async () => {
    const s = setup();
    s.loadDirectory.mockRejectedValue(new Error("secret upstream body"));
    const result = await s.service.preview(request());

    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("secret upstream body");

    s.loadDirectory.mockRejectedValue(
      new SsoCasdoorDirectoryError("idp-unreachable"),
    );
    const unavailable = await s.service.preview(request());
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({
      code: "CASDOOR_IMPORT_UNAVAILABLE",
    });
  });

  test("Casdoor Permission 范围不可用时映射为 503", async () => {
    const s = setup();
    s.loadDirectory.mockRejectedValue(
      new SsoCasdoorPermissionError("idp-unreachable"),
    );
    const result = await s.service.preview(request());

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      code: "CASDOOR_IMPORT_PERMISSION_UNAVAILABLE",
      details: { reason: "idp-unreachable" },
    });
  });
});

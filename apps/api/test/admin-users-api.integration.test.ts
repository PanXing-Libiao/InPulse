import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  adminUserItemSchema,
  adminUserListResponseSchema,
} from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import { AdminUserRepository } from "../src/admin-users/admin-user.repository.js";
import { AdminUsersHttpService } from "../src/admin-users/admin-user-http.service.js";
import { AdminUsersController } from "../src/admin-users/admin-user.controller.js";
import { AdminUserService } from "../src/admin-users/admin-user.service.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PasswordService } from "../src/auth/password.service.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { createProject, createUser, testUrls } from "./database.helpers.js";

const ADMIN_USER_INITIAL_PASSWORD = "initial-password-123456";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let app: INestApplication | undefined;
let base: string;
let uow: PostgresUnitOfWork;
let sessions: PostgresUserSessionRepository;
let csrf: PostgresSessionCsrfTokenRepository;
let tokens: SessionTokenService;
let auth: SessionAuthService;
let mutation: AuthenticatedMutationService;
let highRisk: AdminHighRiskAuthService;
let repository: AdminUserRepository;
let audit: PostgresAuditWritePort;
let userService: AdminUserService;

const key = randomBytes(32);

interface Actor {
  readonly userId: number;
  readonly authVersion: number;
  readonly cookie: string;
  readonly csrf: string;
}

function secureHeaders(actor?: Actor) {
  return {
    origin: base,
    "sec-fetch-site": "same-origin",
    ...(actor
      ? { cookie: actor.cookie, "x-csrf-token": actor.csrf }
      : { cookie: "", "x-csrf-token": "a".repeat(43) }),
  };
}

async function request(
  path: string,
  method: string,
  actor?: Actor,
  options: {
    readonly body?: unknown;
    readonly version?: number;
    readonly key?: string;
    readonly csrf?: string;
  } = {},
) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...secureHeaders(actor),
      ...(options.csrf === undefined ? {} : { "x-csrf-token": options.csrf }),
      "content-type": "application/json",
      "Idempotency-Key": options.key ?? randomUUID(),
      ...(options.version === undefined
        ? {}
        : { "If-Match": `"${options.version}"` }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return response;
}

async function authVersionFor(userId: number): Promise<number> {
  const rows = (await client.sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { authVersion: number }[];
  return rows[0]!.authVersion;
}

async function userState(userId: number) {
  const rows = (await client.sql`
    SELECT status,
           disabled_at AS "disabledAt",
           auth_version AS "authVersion",
           row_version AS "rowVersion",
           (SELECT count(*)::int FROM app.user_sessions WHERE user_id = ${userId} AND revoked_at IS NULL) AS "activeSessions",
           (SELECT count(*)::int FROM app.task_assignees AS ta JOIN app.tasks AS t ON t.id = ta.task_id AND t.project_id = ta.project_id WHERE ta.user_id = ${userId} AND t.work_status = 'TODO' AND t.lifecycle_status = 'ACTIVE' AND t.deleted_at IS NULL) AS "openTaskCount"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly {
    readonly status: string;
    readonly disabledAt: string | null;
    readonly authVersion: number;
    readonly rowVersion: number;
    readonly activeSessions: number;
    readonly openTaskCount: number;
  }[];
  return rows[0]!;
}

async function seedUser(options: { readonly admin: boolean }): Promise<Actor> {
  const userId = await createUser(client.sql, { admin: options.admin });
  const authVersion = await authVersionFor(userId);
  const cookie = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await uow.run(async (tx) => {
    const session = await sessions.create(tx, {
      userId,
      tokenHash: tokens.hash(cookie).hash,
      tokenHashKeyVersion: tokens.hash(cookie).keyVersion,
      authVersionAtIssue: authVersion,
      authState: "AUTHENTICATED",
      idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await csrf.issue(tx, {
      sessionId: session.id,
      tokenHash: tokens.hash(csrfToken).hash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return session.id;
  });
  return {
    userId,
    authVersion,
    cookie: `__Host-session=${cookie}`,
    csrf: csrfToken,
  };
}

async function createTargetSession(userId: number, authVersion: number) {
  const cookie = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const sessionId = await uow.run(async (tx) => {
    const session = await sessions.create(tx, {
      userId,
      tokenHash: tokens.hash(cookie).hash,
      tokenHashKeyVersion: tokens.hash(cookie).keyVersion,
      authVersionAtIssue: authVersion,
      authState: "AUTHENTICATED",
      idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await csrf.issue(tx, {
      sessionId: session.id,
      tokenHash: tokens.hash(csrfToken).hash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return session.id;
  });
  return { sessionId, cookie: `__Host-session=${cookie}`, csrf: csrfToken };
}

async function createOpenTaskForUser(userId: number): Promise<number> {
  const project = await createProject(client.sql, userId);
  const code = project.code + "-T-" + Date.now();
  return client.sql.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO app.tasks (
        project_id,
        module_id,
        feature_id,
        scope_type,
        code,
        title,
        creator_id,
        priority,
        work_status,
        lifecycle_status
      )
      VALUES (
        ${project.projectId},
        ${project.moduleId},
        NULL,
        ${"MODULE"},
        ${code},
        ${"未完成任务"},
        ${userId},
        ${"NORMAL"},
        ${"TODO"},
        ${"ACTIVE"}
      )
      RETURNING id
    `) as unknown as readonly { id: number }[];
    const taskId = rows[0]?.id;
    if (taskId === undefined) {
      throw new Error("task fixture insert returned no row");
    }
    await tx`
      INSERT INTO app.task_status_history (
        task_id,
        project_id,
        from_work_status,
        to_work_status,
        completed_at_snapshot,
        changed_by
      )
      VALUES (${taskId}, ${project.projectId}, NULL, ${"TODO"}, NULL, ${userId})
    `;
    await tx`
      INSERT INTO app.task_assignees (task_id, user_id, project_id)
      VALUES (${taskId}, ${userId}, ${project.projectId})
    `;
    return taskId;
  });
}

function metaFor(actor: Actor, requestId: string) {
  return {
    actorId: actor.userId,
    headers: {
      cookie: actor.cookie,
      "x-csrf-token": actor.csrf,
    },
    requestId,
  };
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f03-admin-users",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f03-admin-users-audit",
  });
  uow = new PostgresUnitOfWork(client);
  sessions = new PostgresUserSessionRepository();
  csrf = new PostgresSessionCsrfTokenRepository();
  tokens = new SessionTokenService(
    VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
  );
  auth = new SessionAuthService(uow, sessions, tokens);
  mutation = new AuthenticatedMutationService(auth, csrf, tokens);
  const credentials = new PostgresUserCredentialRepository();
  highRisk = new AdminHighRiskAuthService(sessions, csrf, tokens, credentials);
  audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key,
  });
  repository = new AdminUserRepository();
  userService = new AdminUserService(repository, sessions, highRisk, audit);
  const http = new AdminUsersHttpService(
    auth,
    mutation,
    highRisk,
    uow,
    repository,
    userService,
    new PasswordService(),
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
  );
  class TestModule {}
  Module({
    controllers: [AdminUsersController],
    providers: [{ provide: AdminUsersHttpService, useValue: http }],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ContractResponseInterceptor());
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  await client?.close();
  await auditReader?.close();
});

describe("F-03 用户管理真实 PostgreSQL + HTTP", () => {
  it("管理员完成用户生命周期，幂等不重复创建，停用/强退同事务撤销 Session 并写审计", async () => {
    const actor = await seedUser({ admin: true });
    await seedUser({ admin: true });
    const normal = await seedUser({ admin: false });
    expect((await request("/admin/users", "GET", normal)).status).toBe(403);

    const listResponse = await request("/admin/users", "GET", actor);
    expect(listResponse.status).toBe(200);
    const list = adminUserListResponseSchema.parse(await listResponse.json());
    expect(list.items.some((item) => item.id === actor.userId)).toBe(true);

    const loginName = `f03_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const createKey = randomUUID();
    const createBody = {
      loginName,
      name: "新建用户",
      email: `${loginName}@example.com`,
      password: ADMIN_USER_INITIAL_PASSWORD,
      isAdmin: false,
    };
    const createdResponse = await request("/admin/users", "POST", actor, {
      body: createBody,
      key: createKey,
    });
    expect(createdResponse.status).toBe(200);
    const created = adminUserItemSchema.parse(await createdResponse.json());
    expect(JSON.stringify(created)).not.toContain("password");
    const replayResponse = await request("/admin/users", "POST", actor, {
      body: createBody,
      key: createKey,
    });
    expect(replayResponse.status).toBe(200);
    const replayBody = (await replayResponse.json()) as { id: number };
    expect(replayBody.id).toBe(created.id);

    const updateKey = randomUUID();
    const updatedResponse = await request(
      `/admin/users/${created.id}`,
      "PATCH",
      actor,
      {
        body: { name: "改名用户", email: null },
        version: created.rowVersion,
        key: updateKey,
      },
    );
    expect(updatedResponse.status).toBe(200);
    const updated = adminUserItemSchema.parse(await updatedResponse.json());
    expect(updated.rowVersion).toBe(2);
    expect(updated.name).toBe("改名用户");

    const targetAuthVersion = await authVersionFor(created.id);
    const targetSession = await createTargetSession(
      created.id,
      targetAuthVersion,
    );
    const disable = await request(
      `/admin/users/${created.id}/disable`,
      "POST",
      actor,
      {
        version: updated.rowVersion,
      },
    );
    expect(disable.status).toBe(204);
    expect(await userState(created.id)).toMatchObject({
      status: "DISABLED",
      authVersion: targetAuthVersion + 1,
      rowVersion: 3,
      activeSessions: 0,
    });
    expect(
      (
        await request("/admin/users", "GET", {
          ...normal,
          cookie: targetSession.cookie,
          csrf: targetSession.csrf,
        })
      ).status,
    ).toBe(401);

    const enable = await request(
      `/admin/users/${created.id}/enable`,
      "POST",
      actor,
      {
        version: 3,
      },
    );
    expect(enable.status).toBe(204);
    expect(await userState(created.id)).toMatchObject({
      status: "ACTIVE",
      authVersion: targetAuthVersion + 1,
      rowVersion: 4,
    });

    const forceLogout = await request(
      `/admin/users/${created.id}/force-logout`,
      "POST",
      actor,
      { version: 4 },
    );
    expect(forceLogout.status).toBe(204);
    expect(await userState(created.id)).toMatchObject({
      status: "ACTIVE",
      authVersion: targetAuthVersion + 2,
      rowVersion: 5,
      activeSessions: 0,
    });

    const auditRows = (await auditReader.sql`
      SELECT action AS "action"
        FROM app.audit_logs
       WHERE target_id = ${String(created.id)}
         AND action IN (
           'admin.user.create',
           'admin.user.update',
           'admin.user.disable',
           'admin.user.enable',
           'admin.user.force_logout'
         )
    `) as unknown as readonly { action: string }[];
    expect(new Set(auditRows.map((row) => row.action))).toEqual(
      new Set([
        "admin.user.create",
        "admin.user.update",
        "admin.user.disable",
        "admin.user.enable",
        "admin.user.force_logout",
      ]),
    );
  });

  it("有未完成任务时拒绝停用并返回 openTaskCount", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    await createOpenTaskForUser(target.userId);
    const before = await userState(target.userId);
    await createTargetSession(target.userId, before.authVersion);

    const response = await request(
      `/admin/users/${target.userId}/disable`,
      "POST",
      actor,
      { version: before.rowVersion },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      readonly code: string;
      readonly details: { readonly openTaskCount: number };
    };
    expect(body.code).toBe("ADMIN_USER_HAS_OPEN_TASKS");
    expect(body.details.openTaskCount).toBe(1);
    expect(await userState(target.userId)).toMatchObject({
      status: "ACTIVE",
      openTaskCount: 1,
      activeSessions: 2,
    });
  });

  it("拒绝无重认证、无幂等键和非法字段，不泄露数据库错误", async () => {
    const actor = await seedUser({ admin: true });
    const loginName = `f03_reject_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const memberSession = await seedUser({ admin: false });
    const noReauthResponse = await request(
      "/admin/users",
      "POST",
      memberSession,
      {
        body: {
          loginName,
          name: "拒绝用户",
          password: ADMIN_USER_INITIAL_PASSWORD,
        },
      },
    );
    expect(noReauthResponse.status).toBe(403);

    const invalidResponse = await request("/admin/users", "POST", actor, {
      body: { loginName: " ", name: " ", password: "x" },
    });
    expect(invalidResponse.status).toBe(422);

    const missingKeyResponse = await request("/admin/users", "POST", actor, {
      body: {
        loginName,
        name: "拒绝用户",
        password: ADMIN_USER_INITIAL_PASSWORD,
      },
      key: "",
    });
    expect(missingKeyResponse.status).toBe(400);

    const staleTarget = await seedUser({ admin: false });
    const staleResponse = await request(
      `/admin/users/${staleTarget.userId}`,
      "PATCH",
      actor,
      {
        body: { name: "旧版本" },
        version: 999999,
      },
    );
    expect(staleResponse.status).toBe(409);
    const payload = await staleResponse.json();
    expect(JSON.stringify(payload)).not.toContain("SELECT");
    expect(JSON.stringify(payload)).not.toContain("constraint_name");
  });

  it("拒绝自停用，审计失败时整个用户创建回滚", async () => {
    const actor = await seedUser({ admin: true });
    const selfVersion = await authVersionFor(actor.userId);
    await expect(
      uow.run((tx) =>
        userService.disable(
          tx,
          metaFor(actor, randomUUID()),
          actor.userId,
          selfVersion,
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_USER_SELF_MUTATION_REJECTED",
    });

    const rollbackActor = await seedUser({ admin: true });
    const rollbackLogin = `f03_rollback_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const failingAudit = {
      append: vi.fn().mockRejectedValue(new Error("audit downstream failed")),
    } as never;
    const failingService = new AdminUserService(
      repository,
      sessions,
      highRisk,
      failingAudit,
    );
    await expect(
      uow.run((tx) =>
        failingService.create(
          tx,
          metaFor(rollbackActor, randomUUID()),
          {
            loginName: rollbackLogin,
            name: "回滚用户",
            password: ADMIN_USER_INITIAL_PASSWORD,
            isAdmin: false,
          },
          "$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture-hash",
        ),
      ),
    ).rejects.toThrow("audit downstream failed");
    const rows = (await client.sql`
      SELECT count(*)::int AS count
        FROM app.users
       WHERE login_name = ${rollbackLogin}
    `) as unknown as readonly { count: number }[];
    expect(rows[0]!.count).toBe(0);
  });
});

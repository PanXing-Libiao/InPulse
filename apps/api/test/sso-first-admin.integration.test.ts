import "reflect-metadata";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { migrate } from "@inpulse/database/migrate";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresAuthRateLimitRepository } from "../src/auth/auth-rate-limit.repository.js";
import { LoginRateLimitService } from "../src/auth/auth-rate-limit.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { SsoLoginService } from "../src/auth/sso/sso-login.service.js";
import { PostgresSsoLoginAttemptRepository } from "../src/auth/sso/sso-login-attempt.repository.js";
import { PostgresSsoUserRepository } from "../src/auth/sso/sso-user.repository.js";
import { SsoOidcClient } from "../src/auth/sso/sso-oidc.client.js";
import type { SsoConfig } from "../src/auth/sso/sso.config.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import { PostgresOrganizationSyncService } from "../src/organizations/organization-sync.service.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { testUrls } from "./database.helpers.js";
import { createStubIdp, type StubIdp } from "./sso-stub-idp.js";

/**
 * 空库首个 SSO 登录账号自动成为系统管理员（ADR-075）。
 *
 * 该行为必须用「平台没有任何账号」的真实空库验证：共享测试库 app_ci 里始终
 * 有其他用例的夹具账号，因此每个用例都在 cluster_bootstrap 新建的临时库上
 * 跑完整迁移，结束后 DROP。库内前提只复刻集成测试实际依赖的部分（app schema
 * 与 USAGE 授权、pgroonga 扩展）：完整 000_roles.sql / 020_pgroonga.sql 含
 * psql \gexec 元命令，不能直接交给 postgres.js 执行，其余权限由迁移声明。
 */
const ISSUER = "https://authtest.libiaorobot.com";
const SESSION_COOKIE_NAME = "__Host-session";
const STATE_COOKIE_NAME = "__Host-sso-state";
const STATE_MATERIAL_PURPOSE = "inpulse-sso-login-v1";
const IDLE_MAX_AGE_SECONDS = 7200;
const ABSOLUTE_MAX_AGE_SECONDS = 604800;

const config: SsoConfig = {
  issuer: ISSUER,
  clientId: "inpulse",
  clientSecret: "integration-only-client-secret",
  redirectUrl: "http://127.0.0.1:5173/api/v1/auth/sso/callback",
  stateTtlSeconds: 600,
  discoveryTtlSeconds: 600,
  requestTimeoutMs: 2000,
};

interface TempDatabase {
  readonly runtime: DatabaseClient;
  readonly auditReader: DatabaseClient;
  readonly keyring: VersionedHmacKeyring;
  readonly tokens: SessionTokenService;
  readonly idp: StubIdp;
  readonly service: SsoLoginService;
}

let bootstrapClient: DatabaseClient | undefined;

beforeAll(() => {
  bootstrapClient = createDatabaseClient(testUrls().bootstrap, {
    applicationName: "inpulse-sso-first-admin-bootstrap",
    maxConnections: 2,
  });
});

afterAll(async () => {
  await bootstrapClient?.close();
});

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/" + database;
  return url.toString();
}

function uniqueLoginName(prefix: string): string {
  return prefix + "_" + randomUUID().replaceAll("-", "").slice(0, 12);
}

function uniqueSubject(): string {
  return "sub_" + randomUUID().replaceAll("-", "");
}

function uniqueEmail(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12) + "@libiaorobot.com";
}

function deriveNonce(keyring: VersionedHmacKeyring, state: string): string {
  return createHmac("sha256", keyring.keyFor(1))
    .update(`${STATE_MATERIAL_PURPOSE}\0nonce\0${state}`, "utf8")
    .digest("base64url");
}

function buildService(
  runtime: DatabaseClient,
  keyring: VersionedHmacKeyring,
  tokens: SessionTokenService,
  idp: StubIdp,
): SsoLoginService {
  const unitOfWork = new PostgresUnitOfWork(runtime);
  return new SsoLoginService(
    unitOfWork,
    new PostgresSsoLoginAttemptRepository(),
    new PostgresSsoUserRepository(),
    new PostgresOrganizationSyncService(),
    new PostgresUserCredentialRepository(),
    new PostgresUserSessionRepository(),
    new PostgresSessionCsrfTokenRepository(),
    tokens,
    new LoginRateLimitService(
      unitOfWork,
      new PostgresAuthRateLimitRepository(),
      keyring,
    ),
    new PostgresAuditWritePort({
      currentVersion: 1,
      keyFor: () => Buffer.from("integration-only-audit-key", "utf8"),
    }),
    config,
    new SsoOidcClient(config, idp.fetchImpl),
    {
      idleMaxAgeSeconds: IDLE_MAX_AGE_SECONDS,
      absoluteMaxAgeSeconds: ABSOLUTE_MAX_AGE_SECONDS,
    },
    keyring,
  );
}

async function withTempDatabase<T>(
  run: (database: TempDatabase) => Promise<T>,
): Promise<T> {
  const bootstrapUrl = testUrls().bootstrap;
  const admin = bootstrapClient;
  if (admin === undefined) {
    throw new Error("bootstrap client is not ready");
  }
  const name =
    "inpulse_sso_first_admin_" + randomUUID().replaceAll("-", "").slice(0, 12);
  await admin.sql.unsafe("CREATE DATABASE " + name + " OWNER app_owner");
  try {
    const tempUrl = databaseUrlFor(bootstrapUrl, name);
    const setup = createDatabaseClient(tempUrl, {
      applicationName: "inpulse-sso-first-admin-setup",
      maxConnections: 1,
    });
    try {
      await setup.sql.unsafe(
        "CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_owner",
      );
      await setup.sql.unsafe("REVOKE ALL ON SCHEMA app FROM PUBLIC");
      await setup.sql.unsafe(
        "GRANT USAGE ON SCHEMA app TO app_migrator, app_runtime, app_backup, audit_reader, audit_archive_writer",
      );
      await setup.sql.unsafe(
        "CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA app",
      );
    } finally {
      await setup.close();
    }
    await migrate(databaseUrlFor(testUrls().migrator, name));

    const runtime = createDatabaseClient(
      databaseUrlFor(testUrls().runtime, name),
      { applicationName: "inpulse-sso-first-admin-runtime" },
    );
    const auditReader = createDatabaseClient(
      databaseUrlFor(testUrls().auditReader, name),
      { applicationName: "inpulse-sso-first-admin-audit-reader" },
    );
    const keyring = VersionedHmacKeyring.fromEntries(
      [{ version: 1, key: randomBytes(32) }],
      1,
    );
    const tokens = new SessionTokenService(keyring);
    const idp = createStubIdp({
      issuer: ISSUER,
      clientId: config.clientId,
      fallbackSubject: uniqueSubject,
    });
    const service = buildService(runtime, keyring, tokens, idp);
    try {
      return await run({ runtime, auditReader, keyring, tokens, idp, service });
    } finally {
      await runtime.close();
      await auditReader.close();
    }
  } finally {
    await admin.sql.unsafe("DROP DATABASE " + name + " WITH (FORCE)");
  }
}

async function loginViaSso(
  database: TempDatabase,
  claims: {
    readonly loginName: string;
    readonly displayName: string;
    readonly email: string | null;
  },
): Promise<{
  readonly location: string;
  readonly sessionCookie: string | undefined;
}> {
  const started = await database.service.start({ returnTo: "/projects" });
  const stateCookie = started.cookies.find(
    (cookie) => cookie.name === STATE_COOKIE_NAME,
  );
  const state = stateCookie?.value;
  if (state === null || state === undefined) {
    throw new Error("sso start did not issue a state cookie");
  }
  database.idp.setClaims({
    nonce: deriveNonce(database.keyring, state),
    subject: uniqueSubject(),
    loginName: claims.loginName,
    displayName: claims.displayName,
    email: claims.email,
  });
  const completed = await database.service.complete({
    code: "stub-code",
    state,
    iss: ISSUER,
    error: undefined,
    cookieHeader: STATE_COOKIE_NAME + "=" + state,
    clientIp: "203.0.113.60",
    requestId: randomUUID(),
    userAgent: "vitest",
  });
  const sessionCookie = completed.cookies.find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  );
  return {
    location: completed.location,
    sessionCookie: sessionCookie?.value ?? undefined,
  };
}

async function usersByLoginName(
  runtime: DatabaseClient,
  loginName: string,
): Promise<readonly { readonly id: number; readonly isAdmin: boolean }[]> {
  return (await runtime.sql`
    SELECT id, is_admin AS "isAdmin"
      FROM app.users
     WHERE login_name = ${loginName}
  `) as unknown as readonly {
    readonly id: number;
    readonly isAdmin: boolean;
  }[];
}

async function provisionedPayload(
  auditReader: DatabaseClient,
  userId: number,
): Promise<{ readonly grantedAdmin?: boolean } | undefined> {
  const rows = (await auditReader.sql`
    SELECT event_payload AS "payload"
      FROM app.audit_logs
     WHERE chain_id = ${"SYSTEM"}
       AND actor_id = ${userId}
       AND action = ${"auth.sso_account_provisioned"}
     ORDER BY sequence_no
     LIMIT 1
  `) as unknown as readonly {
    readonly payload: { readonly grantedAdmin?: boolean };
  }[];
  return rows[0]?.payload;
}

describe("空库首个 SSO 账号成为系统管理员（ADR-075，真实 PostgreSQL + 桩 IdP）", () => {
  test("空库首个账号授予管理员并写审计，后续账号不再授予", async () => {
    await withTempDatabase(async (database) => {
      const firstLoginName = uniqueLoginName("first_admin");
      const firstLogin = await loginViaSso(database, {
        loginName: firstLoginName,
        displayName: "首位管理员",
        email: uniqueEmail(),
      });
      expect(firstLogin.location).toBe("/projects");
      expect(firstLogin.sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const firstUsers = await usersByLoginName(
        database.runtime,
        firstLoginName,
      );
      expect(firstUsers).toHaveLength(1);
      expect(firstUsers[0]?.isAdmin).toBe(true);
      const firstPayload = await provisionedPayload(
        database.auditReader,
        firstUsers[0]!.id,
      );
      expect(firstPayload?.grantedAdmin).toBe(true);

      const secondLoginName = uniqueLoginName("second_user");
      await loginViaSso(database, {
        loginName: secondLoginName,
        displayName: "第二位同事",
        email: uniqueEmail(),
      });
      const secondUsers = await usersByLoginName(
        database.runtime,
        secondLoginName,
      );
      expect(secondUsers).toHaveLength(1);
      expect(secondUsers[0]?.isAdmin).toBe(false);
      const secondPayload = await provisionedPayload(
        database.auditReader,
        secondUsers[0]!.id,
      );
      expect(secondPayload?.grantedAdmin).toBe(false);
    });
  });

  test("平台只有停用账号时也不授予管理员（存在行即非空）", async () => {
    await withTempDatabase(async (database) => {
      await database.runtime.sql`
        INSERT INTO app.users (
          login_name,
          name,
          password_hash,
          is_admin,
          status,
          disabled_at
        )
        VALUES (
          ${uniqueLoginName("disabled_holder")},
          ${"停用占位"},
          NULL,
          false,
          ${"DISABLED"},
          now()
        )
      `;
      const loginName = uniqueLoginName("after_disabled");
      await loginViaSso(database, {
        loginName,
        displayName: "后来同事",
        email: uniqueEmail(),
      });
      const users = await usersByLoginName(database.runtime, loginName);
      expect(users).toHaveLength(1);
      expect(users[0]?.isAdmin).toBe(false);
    });
  });

  test("并发两个首登事务只有一个成为管理员", async () => {
    await withTempDatabase(async (database) => {
      const unitOfWork = new PostgresUnitOfWork(database.runtime);
      const repository = new PostgresSsoUserRepository();
      const first = unitOfWork.run(async (tx) => {
        const mapping = await repository.mapIdentity(tx, {
          subject: uniqueSubject(),
          loginName: uniqueLoginName("race_a"),
          displayName: "并发甲",
          email: uniqueEmail(),
        });
        await tx.sql`SELECT pg_sleep(0.3)`;
        return mapping;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = unitOfWork.run((tx) =>
        repository.mapIdentity(tx, {
          subject: uniqueSubject(),
          loginName: uniqueLoginName("race_b"),
          displayName: "并发乙",
          email: uniqueEmail(),
        }),
      );
      const mappings = await Promise.all([first, second]);
      expect(mappings.filter((entry) => entry.kind === "mapped")).toHaveLength(
        2,
      );
      expect(
        mappings.filter(
          (entry) => entry.kind === "mapped" && entry.user.isAdmin,
        ),
      ).toHaveLength(1);
      const rows = (await database.runtime.sql`
        SELECT count(*)::int AS "count" FROM app.users WHERE is_admin
      `) as unknown as readonly { readonly count: number }[];
      expect(rows[0]?.count).toBe(1);
    });
  });
});

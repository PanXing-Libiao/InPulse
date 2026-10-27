import "reflect-metadata";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresAuthRateLimitRepository } from "../src/auth/auth-rate-limit.repository.js";
import { LoginRateLimitService } from "../src/auth/auth-rate-limit.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PasswordService } from "../src/auth/password.service.js";
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

const ISSUER = "https://authtest.libiaorobot.com";
/** 每个用例使用独立 subject：sso_subject 上有唯一索引，禁止跨账号复用。 */
function uniqueSubject(): string {
  return `sub_${randomUUID().replaceAll("-", "")}`;
}
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

let client: DatabaseClient | undefined;
let reader: DatabaseClient | undefined;
let unitOfWork: PostgresUnitOfWork;
let keyring: VersionedHmacKeyring;
let tokens: SessionTokenService;
let service: SsoLoginService;
let idp: StubIdp;

/** nonce 由服务端从 state 派生，测试用同一 keyring 复算，证明明文材料不落库。 */
function deriveNonce(state: string): string {
  return createHmac("sha256", keyring.keyFor(1))
    .update(`${STATE_MATERIAL_PURPOSE}\0nonce\0${state}`, "utf8")
    .digest("base64url");
}

function uniqueLoginName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function uniqueEmail(): string {
  return `${randomUUID().replaceAll("-", "").slice(0, 12)}@libiaorobot.com`;
}

async function startLogin(
  returnTo: string | undefined,
): Promise<{ readonly state: string; readonly location: string }> {
  const started = await service.start({ returnTo });
  const stateCookie = started.cookies.find(
    (cookie) => cookie.name === STATE_COOKIE_NAME,
  );
  const state = stateCookie?.value;
  if (state === null || state === undefined) {
    throw new Error("start did not issue a state cookie");
  }
  const url = new URL(started.location);
  expect(url.searchParams.get("state")).toBe(state);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  return { state, location: started.location };
}

function completeInput(
  state: string,
  clientIp: string,
  overrides: Record<string, unknown> = {},
): Parameters<SsoLoginService["complete"]>[0] {
  return {
    code: "stub-code",
    state,
    iss: ISSUER,
    error: undefined,
    cookieHeader: `${STATE_COOKIE_NAME}=${state}`,
    clientIp,
    requestId: randomUUID(),
    userAgent: "vitest",
    ...overrides,
  } as Parameters<SsoLoginService["complete"]>[0];
}

interface UserRow {
  readonly id: number;
  readonly loginName: string;
  readonly name: string;
  readonly email: string | null;
  readonly ssoSubject: string | null;
  readonly passwordHash: string | null;
  readonly isAdmin: boolean;
  readonly status: string;
}

async function usersByLoginName(
  loginName: string,
): Promise<readonly UserRow[]> {
  return (await client!.sql`
    SELECT id,
           login_name AS "loginName",
           name,
           email,
           sso_subject AS "ssoSubject",
           password_hash AS "passwordHash",
           is_admin AS "isAdmin",
           status
      FROM app.users
     WHERE lower(btrim(login_name)) = lower(btrim(${loginName}))
  `) as unknown as readonly UserRow[];
}

async function createLocalUser(input: {
  readonly loginName: string;
  readonly email: string | null;
  readonly passwordHash?: string | null;
  readonly status?: "ACTIVE" | "DISABLED";
  readonly ssoSubject?: string | null;
}): Promise<number> {
  const rows = (await client!.sql`
    INSERT INTO app.users (
      login_name,
      name,
      email,
      sso_subject,
      password_hash,
      is_admin,
      status,
      disabled_at
    )
    VALUES (
      ${input.loginName},
      ${input.loginName},
      ${input.email},
      ${input.ssoSubject ?? null},
      ${input.passwordHash ?? null},
      false,
      ${input.status ?? "ACTIVE"},
      ${input.status === "DISABLED" ? new Date().toISOString() : null}
    )
    RETURNING id
  `) as unknown as readonly { id: number }[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error("local user fixture insert returned no row");
  }
  return row.id;
}

async function sessionRows(userId: number): Promise<
  readonly {
    readonly id: number;
    readonly tokenHash: Buffer;
    readonly authState: string;
    readonly idleExpiresAt: string;
    readonly absoluteExpiresAt: string;
  }[]
> {
  return (await client!.sql`
    SELECT id,
           token_hash AS "tokenHash",
           auth_state AS "authState",
           idle_expires_at AS "idleExpiresAt",
           absolute_expires_at AS "absoluteExpiresAt"
      FROM app.user_sessions
     WHERE user_id = ${userId}
     ORDER BY id
  `) as unknown as readonly {
    readonly id: number;
    readonly tokenHash: Buffer;
    readonly authState: string;
    readonly idleExpiresAt: string;
    readonly absoluteExpiresAt: string;
  }[];
}

async function auditActions(userId: number): Promise<readonly string[]> {
  const rows = (await reader!.sql`
    SELECT action
      FROM app.audit_logs
     WHERE chain_id = 'SYSTEM'
       AND actor_id = ${userId}
     ORDER BY sequence_no
  `) as unknown as readonly { readonly action: string }[];
  return rows.map((row) => row.action);
}

async function lastFailureReason(): Promise<string | undefined> {
  const rows = (await reader!.sql`
    SELECT event_payload AS "payload"
      FROM app.audit_logs
     WHERE chain_id = 'SYSTEM'
       AND action = 'auth.sso_login_failed'
     ORDER BY sequence_no DESC
     LIMIT 1
  `) as unknown as readonly {
    readonly payload: { readonly reason?: string };
  }[];
  return rows[0]?.payload.reason;
}

interface SsoOrganizationRow {
  readonly id: number;
  readonly name: string;
  readonly source: string;
  readonly groupPath: string;
  readonly parentId: number | null;
  readonly membershipSource: string | null;
}

async function directCasdoorMemberships(
  userId: number,
): Promise<readonly SsoOrganizationRow[]> {
  return (await client!.sql`
    SELECT o.id,
           o.name,
           o.source,
           o.sso_group_path AS "groupPath",
           o.parent_id AS "parentId",
           uo.source AS "membershipSource"
      FROM app.user_organizations AS uo
      JOIN app.organizations AS o ON o.id = uo.organization_id
     WHERE uo.user_id = ${userId}
       AND o.source = 'CASDOOR'
     ORDER BY o.sso_group_path
  `) as unknown as readonly SsoOrganizationRow[];
}

async function organizationsByOwner(
  owner: string,
): Promise<readonly SsoOrganizationRow[]> {
  return (await client!.sql`
    SELECT id,
           name,
           source,
           sso_group_path AS "groupPath",
           parent_id AS "parentId",
           NULL::TEXT AS "membershipSource"
      FROM app.organizations
     WHERE source = 'CASDOOR'
       AND sso_owner = ${owner}
     ORDER BY sso_group_path
  `) as unknown as readonly SsoOrganizationRow[];
}

async function latestOrganizationSyncPayload(userId: number): Promise<
  | {
      readonly groupsClaimPresent?: boolean;
      readonly groupCount?: number;
      readonly createdOrganizationCount?: number;
      readonly membershipCount?: number;
    }
  | undefined
> {
  const rows = (await reader!.sql`
    SELECT event_payload AS "payload"
      FROM app.audit_logs
     WHERE chain_id = 'SYSTEM'
       AND actor_id = ${userId}
       AND action = 'auth.sso_organizations_synced'
     ORDER BY sequence_no DESC
     LIMIT 1
  `) as unknown as readonly {
    readonly payload: {
      readonly groupsClaimPresent?: boolean;
      readonly groupCount?: number;
      readonly createdOrganizationCount?: number;
      readonly membershipCount?: number;
    };
  }[];
  return rows[0]?.payload;
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-sso-login-integration-test",
  });
  reader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-sso-login-audit-reader",
  });
  unitOfWork = new PostgresUnitOfWork(client);
  keyring = VersionedHmacKeyring.fromEntries(
    [{ version: 1, key: randomBytes(32) }],
    1,
  );
  tokens = new SessionTokenService(keyring);
  idp = createStubIdp({
    issuer: ISSUER,
    clientId: config.clientId,
    fallbackSubject: uniqueSubject,
  });
  service = new SsoLoginService(
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
});

afterAll(async () => {
  await client?.close();
  await reader?.close();
});

describe("SSO 登录纵切片（真实 PostgreSQL + 桩 IdP）", () => {
  test("首次登录 JIT 开通账号并签发 2 小时空闲会话", async () => {
    // 平台已有账号（本用例前置一个无关账号）：JIT 开通的默认权限是非管理员；
    // 空库首个账号自动成为管理员的路径由 sso-first-admin.integration.test.ts 覆盖。
    await createLocalUser({
      loginName: uniqueLoginName("sso_baseline"),
      email: null,
    });
    const loginName = uniqueLoginName("sso_jit");
    const email = uniqueEmail();
    const subject = uniqueSubject();
    const { state } = await startLogin("/projects/7?tab=1");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject,
      loginName,
      displayName: "邵晨宇",
      email,
    });

    const result = await service.complete(completeInput(state, "203.0.113.11"));

    expect(result.location).toBe("/projects/7?tab=1");
    const sessionCookie = result.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME,
    );
    expect(sessionCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([
      STATE_COOKIE_NAME,
      SESSION_COOKIE_NAME,
    ]);

    const users = await usersByLoginName(loginName);
    expect(users).toHaveLength(1);
    const user = users[0]!;
    expect(user.ssoSubject).toBe(subject);
    expect(user.passwordHash).toBeNull();
    expect(user.isAdmin).toBe(false);
    expect(user.status).toBe("ACTIVE");
    expect(user.name).toBe("邵晨宇");
    expect(user.email).toBe(email);

    const sessions = await sessionRows(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.authState).toBe("AUTHENTICATED");
    expect(
      sessions[0]?.tokenHash.equals(tokens.hash(sessionCookie!.value!).hash),
    ).toBe(true);
    const idleMillis =
      new Date(sessions[0]!.idleExpiresAt).getTime() - Date.now();
    expect(idleMillis).toBeGreaterThan(IDLE_MAX_AGE_SECONDS * 1000 - 60_000);
    expect(idleMillis).toBeLessThanOrEqual(IDLE_MAX_AGE_SECONDS * 1000);
    const absoluteMillis =
      new Date(sessions[0]!.absoluteExpiresAt).getTime() - Date.now();
    expect(absoluteMillis).toBeGreaterThan(
      ABSOLUTE_MAX_AGE_SECONDS * 1000 - 60_000,
    );

    expect(await auditActions(user.id)).toEqual([
      "auth.sso_account_provisioned",
      "auth.sso_organizations_synced",
      "auth.sso_login",
    ]);

    const provisioned = (await reader!.sql`
      SELECT event_payload AS "payload"
        FROM app.audit_logs
       WHERE chain_id = ${"SYSTEM"}
         AND actor_id = ${user.id}
         AND action = ${"auth.sso_account_provisioned"}
    `) as unknown as readonly {
      readonly payload: { readonly grantedAdmin?: boolean };
    }[];
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]?.payload.grantedAdmin).toBe(false);

    const attempts = (await client!.sql`
      SELECT consumed_at AS "consumedAt"
        FROM app.sso_login_attempts
       ORDER BY id DESC
       LIMIT 1
    `) as unknown as readonly { readonly consumedAt: string | null }[];
    expect(attempts[0]?.consumedAt).not.toBeNull();

    // SSO 账号没有本地口令：口令入口必须拒绝而不是抛出异常。
    const passwordService = new PasswordService();
    expect(await passwordService.verify("whatever", null)).toBe(false);
    const credential = await unitOfWork.run((tx) =>
      new PostgresUserCredentialRepository().findByNormalizedLoginName(
        tx,
        loginName,
      ),
    );
    expect(credential?.passwordHash).toBeNull();
  });

  test("重复登录按 sso_subject 命中并同步展示名与邮箱", async () => {
    const loginName = uniqueLoginName("sso_subject");
    const subject = uniqueSubject();
    const first = await startLogin(undefined);
    idp.setClaims({
      nonce: deriveNonce(first.state),
      subject,
      loginName,
      displayName: "原名",
      email: uniqueEmail(),
    });
    const firstResult = await service.complete(
      completeInput(first.state, "203.0.113.12"),
    );
    expect(firstResult.location).toBe("/");

    const created = (await usersByLoginName(loginName))[0]!;
    const renamed = uniqueEmail();
    const second = await startLogin("/search");
    idp.setClaims({
      nonce: deriveNonce(second.state),
      subject,
      loginName,
      displayName: "新名",
      email: renamed,
    });
    await service.complete(completeInput(second.state, "203.0.113.12"));

    const users = await usersByLoginName(loginName);
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(created.id);
    expect(users[0]?.name).toBe("新名");
    expect(users[0]?.email).toBe(renamed);
    expect(await sessionRows(created.id)).toHaveLength(2);
    expect(await auditActions(created.id)).toEqual([
      "auth.sso_account_provisioned",
      "auth.sso_organizations_synced",
      "auth.sso_login",
      "auth.sso_organizations_synced",
      "auth.sso_login",
    ]);
  });

  test("首次 SSO 登录按 Casdoor 群组路径建立层级组织，仅把最深实体群组写为直接成员关系", async () => {
    const owner = "casdoor_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const directGroups = [owner + "/总部/测试部", owner + "/研发/平台组"];
    // Casdoor 可能同时返回父级路径与用户选中的实体群组；父级只用于建层级。
    const groups = [owner + "/总部", owner + "/研发", ...directGroups];
    const loginName = uniqueLoginName("sso_groups");
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName,
      displayName: "群组同事",
      email: uniqueEmail(),
      groups,
    });

    const result = await service.complete(completeInput(state, "203.0.113.41"));
    expect(result.location).toBe("/projects");
    const user = (await usersByLoginName(loginName))[0]!;

    const organizations = await organizationsByOwner(owner);
    expect(new Set(organizations.map((row) => row.groupPath))).toEqual(
      new Set([
        owner + "/总部",
        owner + "/总部/测试部",
        owner + "/研发",
        owner + "/研发/平台组",
      ]),
    );
    const byPath = new Map(
      organizations.map((row) => [row.groupPath, row] as const),
    );
    expect(byPath.get(owner + "/总部")?.parentId).toBeNull();
    expect(byPath.get(owner + "/总部/测试部")?.name).toBe("测试部");
    expect(byPath.get(owner + "/总部/测试部")?.parentId).toBe(
      byPath.get(owner + "/总部")?.id,
    );
    expect(byPath.get(owner + "/研发/平台组")?.parentId).toBe(
      byPath.get(owner + "/研发")?.id,
    );

    const memberships = await directCasdoorMemberships(user.id);
    expect(new Set(memberships.map((row) => row.groupPath))).toEqual(
      new Set(directGroups),
    );
    expect(memberships.every((row) => row.membershipSource === "CASDOOR")).toBe(
      true,
    );

    expect(await latestOrganizationSyncPayload(user.id)).toMatchObject({
      groupsClaimPresent: true,
      groupCount: 2,
      createdOrganizationCount: 4,
      membershipCount: 2,
    });
    expect(await auditActions(user.id)).toEqual([
      "auth.sso_account_provisioned",
      "auth.sso_organizations_synced",
      "auth.sso_login",
    ]);
  });

  test("groups 缺失不修改、空数组清空、再次提供时全量替换", async () => {
    const owner = "casdoor_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const loginName = uniqueLoginName("sso_groups_replace");
    const subject = uniqueSubject();
    const firstGroup = owner + "/研发/平台组";
    const secondGroup = owner + "/研发/测试组";

    const first = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(first.state),
      subject,
      loginName,
      displayName: "群组替换",
      email: uniqueEmail(),
      groups: [firstGroup, secondGroup],
    });
    await service.complete(completeInput(first.state, "203.0.113.42"));
    const user = (await usersByLoginName(loginName))[0]!;
    expect(
      new Set(
        (await directCasdoorMemberships(user.id)).map((row) => row.groupPath),
      ),
    ).toEqual(new Set([firstGroup, secondGroup]));

    const missing = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(missing.state),
      subject,
      loginName,
      displayName: "群组缺失",
      email: uniqueEmail(),
    });
    await service.complete(completeInput(missing.state, "203.0.113.42"));
    expect(
      new Set(
        (await directCasdoorMemberships(user.id)).map((row) => row.groupPath),
      ),
    ).toEqual(new Set([firstGroup, secondGroup]));
    expect(await latestOrganizationSyncPayload(user.id)).toMatchObject({
      groupsClaimPresent: false,
      groupCount: 0,
    });

    const empty = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(empty.state),
      subject,
      loginName,
      displayName: "群组清空",
      email: uniqueEmail(),
      groups: [],
    });
    await service.complete(completeInput(empty.state, "203.0.113.42"));
    expect(await directCasdoorMemberships(user.id)).toEqual([]);
    expect(await latestOrganizationSyncPayload(user.id)).toMatchObject({
      groupsClaimPresent: true,
      groupCount: 0,
      membershipCount: 0,
    });

    const replacement = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(replacement.state),
      subject,
      loginName,
      displayName: "群组替换",
      email: uniqueEmail(),
      groups: [secondGroup],
    });
    await service.complete(completeInput(replacement.state, "203.0.113.42"));
    expect(
      (await directCasdoorMemberships(user.id)).map((row) => row.groupPath),
    ).toEqual([secondGroup]);
    expect(
      (await organizationsByOwner(owner)).some(
        (row) => row.groupPath === firstGroup,
      ),
    ).toBe(true);
  });

  test("非法 groups 路径拒绝登录且不创建账号、组织或会话", async () => {
    const owner = "casdoor_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const loginName = uniqueLoginName("sso_groups_invalid");
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName,
      displayName: "非法群组",
      email: uniqueEmail(),
      groups: [owner + "//测试部"],
    });

    const result = await service.complete(completeInput(state, "203.0.113.43"));

    expect(result.location).toBe("/login?sso_error=token-invalid");
    expect(await usersByLoginName(loginName)).toHaveLength(0);
    expect(await organizationsByOwner(owner)).toHaveLength(0);
    expect(await lastFailureReason()).toBe("token-invalid");
  });

  test("两个用户并发同步同一 Casdoor 群组只创建一套组织", async () => {
    const owner = "casdoor_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const groups = [owner + "/研发/平台组"];
    const firstUserId = await createLocalUser({
      loginName: uniqueLoginName("sso_sync_a"),
      email: null,
      ssoSubject: uniqueSubject(),
    });
    const secondUserId = await createLocalUser({
      loginName: uniqueLoginName("sso_sync_b"),
      email: null,
      ssoSubject: uniqueSubject(),
    });
    const sync = new PostgresOrganizationSyncService();

    const results = await Promise.all(
      [firstUserId, secondUserId].map((userId) =>
        unitOfWork.run((tx) => sync.syncSsoMemberships({ tx, userId, groups })),
      ),
    );

    expect(
      results.reduce(
        (count, result) => count + result.createdOrganizationCount,
        0,
      ),
    ).toBe(2);
    expect(await organizationsByOwner(owner)).toHaveLength(2);
    expect(await directCasdoorMemberships(firstUserId)).toHaveLength(1);
    expect(await directCasdoorMemberships(secondUserId)).toHaveLength(1);
  });

  test("登录名命中且邮箱一致时绑定既有账号而不是新建", async () => {
    const loginName = uniqueLoginName("sso_link");
    const email = uniqueEmail();
    const existingId = await createLocalUser({ loginName, email });
    const subject = uniqueSubject();
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject,
      loginName,
      displayName: "本地账号",
      email,
    });

    const result = await service.complete(completeInput(state, "203.0.113.13"));

    expect(result.location).toBe("/projects");
    const users = await usersByLoginName(loginName);
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(existingId);
    expect(users[0]?.ssoSubject).toBe(subject);
    expect(await auditActions(existingId)).toEqual([
      "auth.sso_account_linked",
      "auth.sso_organizations_synced",
      "auth.sso_login",
    ]);
  });

  test("登录名命中但邮箱不一致时拒绝登录，防止接管账号", async () => {
    const loginName = uniqueLoginName("sso_conflict");
    const existingId = await createLocalUser({
      loginName,
      email: `${uniqueEmail()}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture",
    });
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName,
      displayName: "冒用者",
      email: uniqueEmail(),
    });

    const result = await service.complete(completeInput(state, "203.0.113.14"));

    expect(result.location).toBe("/login?sso_error=account-conflict");
    const users = await usersByLoginName(loginName);
    expect(users[0]?.ssoSubject).toBeNull();
    expect(users[0]?.name).toBe(loginName);
    expect(await sessionRows(existingId)).toHaveLength(0);
    expect(await lastFailureReason()).toBe("account-conflict");
  });

  test("邮箱已被其他账号占用时拒绝新建账号", async () => {
    const holder = uniqueLoginName("sso_holder");
    const email = uniqueEmail();
    await createLocalUser({ loginName: holder, email });
    const { state } = await startLogin("/projects");
    const newcomer = uniqueLoginName("sso_newcomer");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName: newcomer,
      displayName: "新同事",
      email,
    });

    const result = await service.complete(completeInput(state, "203.0.113.15"));

    expect(result.location).toBe("/login?sso_error=account-conflict");
    expect(await usersByLoginName(newcomer)).toHaveLength(0);
    expect(await lastFailureReason()).toBe("account-conflict");
  });

  test("已绑定但被停用的账号先消费 state 再拒绝，且不签发会话", async () => {
    const loginName = uniqueLoginName("sso_disabled");
    const subject = uniqueSubject();
    const disabledId = await createLocalUser({
      loginName,
      email: uniqueEmail(),
      status: "DISABLED",
      ssoSubject: subject,
    });
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject,
      loginName,
      displayName: "停用账号",
      email: null,
    });

    const result = await service.complete(completeInput(state, "203.0.113.16"));

    expect(result.location).toBe("/login?sso_error=account-disabled");
    expect(await sessionRows(disabledId)).toHaveLength(0);
    expect(await lastFailureReason()).toBe("account-disabled");
  });

  test("同一 state 只能消费一次，并发重放被拒绝", async () => {
    const loginName = uniqueLoginName("sso_replay");
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName,
      displayName: "重放",
      email: uniqueEmail(),
    });
    const first = await service.complete(completeInput(state, "203.0.113.17"));
    const second = await service.complete(completeInput(state, "203.0.113.17"));

    expect(first.location).toBe("/projects");
    expect(second.location).toBe("/login?sso_error=state-consumed");
    const user = (await usersByLoginName(loginName))[0]!;
    expect(await sessionRows(user.id)).toHaveLength(1);
    expect(await lastFailureReason()).toBe("state-consumed");
  });

  test("过期 state 被拒绝且不交换 token", async () => {
    const state = randomBytes(32).toString("base64url");
    const hash = tokens.hash(state);
    await client!.sql`
      INSERT INTO app.sso_login_attempts (
        state_hash,
        state_hash_key_version,
        return_to,
        created_at,
        expires_at
      )
      VALUES (
        ${hash.hash},
        ${hash.keyVersion},
        '/projects',
        now() - interval '20 minutes',
        now() - interval '5 minutes'
      )
    `;
    idp.setClaims({
      subject: uniqueSubject(),
      nonce: deriveNonce(state),
      loginName: uniqueLoginName("sso_expired"),
      displayName: "过期",
      email: uniqueEmail(),
    });

    const result = await service.complete(completeInput(state, "203.0.113.18"));

    expect(result.location).toBe("/login?sso_error=state-expired");
    expect(await lastFailureReason()).toBe("state-expired");
  });

  test("state 与浏览器 Cookie 不匹配时拒绝（CSRF 绑定）", async () => {
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName: uniqueLoginName("sso_cookie"),
      displayName: "Cookie",
      email: uniqueEmail(),
    });

    const missing = await service.complete(
      completeInput(state, "203.0.113.19", { cookieHeader: undefined }),
    );
    const other = await service.complete(
      completeInput(state, "203.0.113.19", {
        cookieHeader: `${STATE_COOKIE_NAME}=${randomBytes(32).toString("base64url")}`,
      }),
    );

    expect(missing.location).toBe("/login?sso_error=state-mismatch");
    expect(other.location).toBe("/login?sso_error=state-mismatch");
    expect(await lastFailureReason()).toBe("state-mismatch");
  });

  test("nonce 与派生值不一致时拒绝（id_token 校验）", async () => {
    const loginName = uniqueLoginName("sso_nonce");
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: "attacker-supplied-nonce",
      subject: uniqueSubject(),
      loginName,
      displayName: "错误 nonce",
      email: uniqueEmail(),
    });

    const result = await service.complete(completeInput(state, "203.0.113.20"));

    expect(result.location).toBe("/login?sso_error=token-invalid");
    expect(await usersByLoginName(loginName)).toHaveLength(0);
    expect(await lastFailureReason()).toBe("token-invalid");
  });

  test("回调 iss 规范化后等于配置 issuer 时放行（RFC 9207）", async () => {
    const loginName = uniqueLoginName("sso_iss_ok");
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName,
      displayName: "iss 尾斜杠",
      email: uniqueEmail(),
    });

    const result = await service.complete(
      completeInput(state, "203.0.113.31", { iss: `${ISSUER}/` }),
    );

    expect(result.location).toBe("/projects");
    expect(
      result.cookies.some((cookie) => cookie.name === SESSION_COOKIE_NAME),
    ).toBe(true);
    expect(await usersByLoginName(loginName)).toHaveLength(1);
  });

  test("回调 iss 与配置不一致时拒绝且不交换 token（mix-up 防护）", async () => {
    const loginName = uniqueLoginName("sso_iss_bad");
    const { state } = await startLogin("/projects");
    idp.setClaims({
      nonce: deriveNonce(state),
      subject: uniqueSubject(),
      loginName,
      displayName: "iss 不符",
      email: uniqueEmail(),
    });

    const result = await service.complete(
      completeInput(state, "203.0.113.32", {
        iss: "https://evil-idp.example.com",
      }),
    );

    expect(result.location).toBe("/login?sso_error=issuer-mismatch");
    expect(await usersByLoginName(loginName)).toHaveLength(0);
    expect(await lastFailureReason()).toBe("issuer-mismatch");
  });

  test("IdP 返回 error 时不交换 token 并按 idp-error 回跳", async () => {
    const { state } = await startLogin("/projects");

    const result = await service.complete(
      completeInput(state, "203.0.113.21", {
        code: undefined,
        error: "access_denied",
      }),
    );

    expect(result.location).toBe("/login?sso_error=idp-error");
    expect(await lastFailureReason()).toBe("idp-error");
  });

  test("未登记的 state 直接拒绝，且不写任何会话", async () => {
    const state = randomBytes(32).toString("base64url");
    idp.setClaims({
      subject: uniqueSubject(),
      nonce: deriveNonce(state),
      loginName: uniqueLoginName("sso_unknown"),
      displayName: "未知",
      email: uniqueEmail(),
    });

    const result = await service.complete(completeInput(state, "203.0.113.22"));

    expect(result.location).toBe("/login?sso_error=state-invalid");
    expect(await lastFailureReason()).toBe("state-invalid");
  });

  test("start 只落库 state 哈希与回跳目标，不保存明文材料", async () => {
    const { state } = await startLogin("/projects/9");

    const rows = (await client!.sql`
      SELECT state_hash AS "stateHash",
             return_to AS "returnTo",
             state_hash_key_version AS "keyVersion"
        FROM app.sso_login_attempts
       ORDER BY id DESC
       LIMIT 1
    `) as unknown as readonly {
      readonly stateHash: Buffer;
      readonly returnTo: string | null;
      readonly keyVersion: number;
    }[];

    expect(rows[0]?.stateHash.equals(tokens.hash(state).hash)).toBe(true);
    expect(rows[0]?.returnTo).toBe("/projects/9");
    expect(rows[0]?.keyVersion).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(state);
  });
});

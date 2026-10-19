import { randomBytes, randomUUID } from "node:crypto";

import { hash } from "@node-rs/argon2";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresAuthRateLimitRepository } from "../src/auth/auth-rate-limit.repository.js";
import { LoginRateLimitService } from "../src/auth/auth-rate-limit.service.js";
import { LoginService } from "../src/auth/login.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresPreauthSessionRepository } from "../src/auth/preauth-session.repository.js";
import { PasswordService } from "../src/auth/password.service.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { testUrls } from "./database.helpers.js";

const LOGIN_FIXTURE_PASSWORD = "integration-login-password";

let client: DatabaseClient | undefined;
let unitOfWork: PostgresUnitOfWork;
let tokenService: SessionTokenService;
let loginService: LoginService;

function futureExpiry(): Date {
  return new Date(Date.now() + 9 * 60 * 1000);
}

async function createLoginUser(
  options: { readonly admin?: boolean; readonly disabled?: boolean } = {},
): Promise<{ readonly id: number; readonly loginName: string }> {
  const loginName = `login_${randomUUID().replaceAll("-", "")}`.slice(0, 80);
  const passwordHash = await hash(LOGIN_FIXTURE_PASSWORD, {
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
    algorithm: 2,
  });
  const status = options.disabled === true ? "DISABLED" : "ACTIVE";
  const [row] = (await client!.sql`
    INSERT INTO app.users (
      login_name,
      name,
      password_hash,
      is_admin,
      status,
      disabled_at
    )
    VALUES (
      ${loginName},
      ${`Login ${loginName}`},
      ${passwordHash},
      ${options.admin === true},
      ${status},
      ${options.disabled === true ? new Date().toISOString() : null}
    )
    RETURNING id
  `) as unknown as readonly { id: number }[];
  if (row === undefined) {
    throw new Error("login fixture user insert returned no row");
  }
  return { id: row.id, loginName };
}

async function issuePreauth(): Promise<{
  readonly preauthId: number;
  readonly sessionToken: string;
  readonly csrfToken: string;
}> {
  const material = tokenService.issuePreauthMaterial();
  const created = await unitOfWork.run((tx) =>
    new PostgresPreauthSessionRepository().create(tx, {
      tokenHash: material.sessionTokenHash,
      tokenHashKeyVersion: material.tokenHashKeyVersion,
      csrfTokenHash: material.csrfTokenHash,
      expiresAt: futureExpiry(),
    }),
  );
  return {
    preauthId: created.id,
    sessionToken: material.sessionToken,
    csrfToken: material.csrfToken,
  };
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-login-integration-test",
  });
  unitOfWork = new PostgresUnitOfWork(client);
  const keyring = VersionedHmacKeyring.fromEntries(
    [{ version: 1, key: randomBytes(32) }],
    1,
  );
  tokenService = new SessionTokenService(keyring);
  loginService = new LoginService(
    unitOfWork,
    new PostgresPreauthSessionRepository(),
    new PostgresUserCredentialRepository(),
    new PostgresUserSessionRepository(),
    new PostgresSessionCsrfTokenRepository(),
    tokenService,
    new PasswordService(),
    new LoginRateLimitService(
      unitOfWork,
      new PostgresAuthRateLimitRepository(),
      keyring,
    ),
  );
});

afterAll(async () => {
  await client?.close();
});

describe("登录纵切片（真实 PostgreSQL）", () => {
  test("普通用户登录成功，数据库只保存 Token Hash 并消费预认证", async () => {
    const user = await createLoginUser();
    const preauth = await issuePreauth();
    const result = await loginService.login({
      loginName: user.loginName,
      password: LOGIN_FIXTURE_PASSWORD,
      clientIp: "198.51.100.10",
      cookieHeader: `__Host-preauth=${preauth.sessionToken}`,
      csrfToken: preauth.csrfToken,
    });

    expect(result.authState).toBe("AUTHENTICATED");
    const sessionToken = result.cookies.find(
      (cookie) => cookie.name === "__Host-session",
    )?.value;
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sessions = (await client!.sql`
      SELECT id, token_hash AS "tokenHash", auth_state AS "authState"
        FROM app.user_sessions
       WHERE user_id = ${user.id}
    `) as unknown as readonly {
      id: number;
      tokenHash: Buffer;
      authState: string;
    }[];
    expect(sessions).toHaveLength(1);
    expect(
      sessions[0]?.tokenHash.equals(tokenService.hash(sessionToken!).hash),
    ).toBe(true);
    expect(sessions[0]?.authState).toBe("AUTHENTICATED");

    const csrfRows = (await client!.sql`
      SELECT token_hash AS "tokenHash"
        FROM app.session_csrf_tokens
       WHERE session_id = ${sessions[0]!.id}
    `) as unknown as readonly { tokenHash: Buffer }[];
    expect(csrfRows).toHaveLength(1);
    expect(
      csrfRows[0]?.tokenHash.equals(tokenService.hash(result.csrfToken).hash),
    ).toBe(true);

    const consumed = (await client!.sql`
      SELECT consumed_at IS NOT NULL AS "consumed"
        FROM app.preauth_sessions
       WHERE id = ${preauth.preauthId}
    `) as unknown as readonly { consumed: boolean }[];
    expect(consumed[0]?.consumed).toBe(true);

    await expect(
      loginService.login({
        loginName: user.loginName,
        password: LOGIN_FIXTURE_PASSWORD,
        clientIp: "198.51.100.10",
        cookieHeader: `__Host-preauth=${preauth.sessionToken}`,
        csrfToken: preauth.csrfToken,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("停用用户登录返回 401 且不签发 Session", async () => {
    const user = await createLoginUser({ disabled: true });
    const preauth = await issuePreauth();
    await expect(
      loginService.login({
        loginName: user.loginName,
        password: LOGIN_FIXTURE_PASSWORD,
        clientIp: "198.51.100.11",
        cookieHeader: `__Host-preauth=${preauth.sessionToken}`,
        csrfToken: preauth.csrfToken,
      }),
    ).rejects.toMatchObject({ status: 401 });

    const sessions = (await client!.sql`
      SELECT count(*)::int AS count
        FROM app.user_sessions
       WHERE user_id = ${user.id}
    `) as unknown as readonly { count: number }[];
    expect(sessions[0]?.count).toBe(0);
  });

  test("墓碑化账号登录返回 401 且不签发 Session", async () => {
    const user = await createLoginUser();
    await client!.sql`
      UPDATE app.users
         SET status = 'DISABLED',
             disabled_at = now(),
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${user.id}
    `;
    const tombstoneLoginName = `deleted-user-${user.id}`;
    await client!.sql`
      UPDATE app.users
         SET login_name = ${tombstoneLoginName},
             name = '删除用户',
             password_hash = NULL,
             deleted_at = now(),
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${user.id}
    `;
    const preauth = await issuePreauth();
    await expect(
      loginService.login({
        loginName: tombstoneLoginName,
        password: LOGIN_FIXTURE_PASSWORD,
        clientIp: "198.51.100.12",
        cookieHeader: `__Host-preauth=${preauth.sessionToken}`,
        csrfToken: preauth.csrfToken,
      }),
    ).rejects.toMatchObject({ status: 401 });

    const sessions = (await client!.sql`
      SELECT count(*)::int AS count
        FROM app.user_sessions
       WHERE user_id = ${user.id}
    `) as unknown as readonly { count: number }[];
    expect(sessions[0]?.count).toBe(0);
  });

  test("管理员带历史 TOTP 因子时直接获得完整认证 Session（ADR-031）", async () => {
    const user = await createLoginUser({ admin: true });
    await client!.sql`
      INSERT INTO app.user_totp_factors (
        user_id,
        status,
        enrollment_generation,
        key_version,
        nonce,
        ciphertext,
        auth_tag,
        enrolled_at
      )
      VALUES (
        ${user.id},
        'ACTIVE',
        1,
        1,
        ${randomBytes(12)},
        ${randomBytes(48)},
        ${randomBytes(16)},
        now()
      )
    `;
    const preauth = await issuePreauth();
    const result = await loginService.login({
      loginName: user.loginName,
      password: LOGIN_FIXTURE_PASSWORD,
      clientIp: "198.51.100.12",
      cookieHeader: `__Host-preauth=${preauth.sessionToken}`,
      csrfToken: preauth.csrfToken,
    });
    expect(result.authState).toBe("AUTHENTICATED");

    const sessions = (await client!.sql`
      SELECT auth_state AS "authState"
        FROM app.user_sessions
       WHERE user_id = ${user.id}
    `) as unknown as readonly { authState: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.authState).toBe("AUTHENTICATED");
  });
});

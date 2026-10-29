import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { hashOpaqueToken } from "../src/auth/token.js";
import {
  parseWecomRobotEncryptionKeyring,
  decryptWecomRobotSecret,
} from "../src/modules/wecom-robot/wecom-robot-secret-keyring.js";
import {
  connect,
  createUser,
  testUrls,
  type TestUrls,
} from "./database.helpers.js";

const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;
const ADMIN_PATH = "/api/v1/admin/wecom-robot";
const ROBOT_KEY_HEX = "ae".repeat(32);
/** 测试专用假 Secret；真实凭据绝不进入仓库。 */
const TEST_ROBOT_SECRET = "inpulse-test-robot-secret-1";
const TEST_ROBOT_SECRET_ALT = "inpulse-test-robot-secret-2";
/** 测试专用机器人资料链接；真实链接绝不进入仓库。 */
const TEST_ROBOT_PROFILE_URL =
  "https://work.weixin.qq.com/wework_admin/common/openBotProfile/test-only";

interface SessionActor {
  readonly userId: number;
  readonly cookie: string;
}

let app: NestExpressApplication | undefined;
let baseUrl = "";
let urls: TestUrls;
let runtime: Sql | undefined;
let auditReader: Sql | undefined;
let bootstrap: Sql | undefined;
let keyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sessionKey: Buffer;

function requireRuntime(): Sql {
  if (runtime === undefined) {
    throw new Error("runtime connection is not initialised");
  }
  return runtime;
}

async function sessionActor(sql: Sql, userId: number): Promise<SessionActor> {
  const users = (await sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { authVersion: number }[];
  const user = users[0];
  if (user === undefined) {
    throw new Error(`user fixture ${userId} does not exist`);
  }
  const cookieToken = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO app.user_sessions (
      user_id,
      token_hash,
      token_hash_key_version,
      auth_version_at_issue,
      auth_state,
      idle_expires_at,
      absolute_expires_at
    )
    VALUES (
      ${userId},
      ${hashOpaqueToken(cookieToken, sessionKey)},
      ${KEY_VERSION},
      ${user.authVersion},
      'AUTHENTICATED',
      now() + interval '1 hour',
      now() + interval '1 day'
    )
  `;
  return {
    userId,
    cookie: `${SESSION_COOKIE_NAME}=${cookieToken}`,
  };
}

async function issueCsrf(cookie: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/csrf`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly csrfToken: string };
  return body.csrfToken;
}

async function getConfig(cookie: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers["cookie"] = cookie;
  }
  return fetch(`${baseUrl}${ADMIN_PATH}`, { headers });
}

async function putConfig(options: {
  readonly cookie: string;
  readonly csrf?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly body: unknown;
  readonly contentType?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: options.cookie,
    host: new URL(baseUrl).host,
    origin: new URL(baseUrl).origin,
    "content-type": options.contentType ?? "application/json",
  };
  if (options.csrf !== undefined) {
    headers["x-csrf-token"] = options.csrf;
  }
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return fetch(`${baseUrl}${ADMIN_PATH}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(options.body),
  });
}

function idempotencyKey(): string {
  return `wecom-robot-${randomBytes(12).toString("hex")}`;
}

function requireBootstrap(): Sql {
  if (bootstrap === undefined) {
    throw new Error("bootstrap connection is not initialised");
  }
  return bootstrap;
}

/** 清除其他测试文件遗留的 ACTIVE 绑定，让解绑计数断言确定（ADR-078）。 */
async function resetActiveBindings(sql: Sql): Promise<void> {
  await sql`
    UPDATE app.user_wecom_bindings
       SET status = 'REVOKED',
           revoked_at = now(),
           updated_at = now(),
           row_version = row_version + 1
     WHERE status = 'ACTIVE'
  `;
  await sql`
    UPDATE app.project_wecom_groups
       SET status = 'REVOKED',
           revoked_at = now(),
           updated_at = now(),
           row_version = row_version + 1
     WHERE status = 'ACTIVE'
  `;
}

async function countActiveBindings(
  sql: Sql,
): Promise<{ userBindings: number; projectGroups: number }> {
  const rows = (await sql`
    SELECT (SELECT count(*)::integer
              FROM app.user_wecom_bindings
             WHERE status = 'ACTIVE') AS "userBindings",
           (SELECT count(*)::integer
              FROM app.project_wecom_groups
             WHERE status = 'ACTIVE') AS "projectGroups"
  `) as unknown as readonly {
    userBindings: number;
    projectGroups: number;
  }[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error("active binding count query returned no row");
  }
  return row;
}

async function expectBodyCode(
  response: Response,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { readonly code: string };
  expect(body.code).toBe(code);
}

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 20);
  auditReader = connect(urls.auditReader, 5);
  bootstrap = connect(urls.bootstrap, 2);
  await migrate(urls.migrator);
  // 单行配置的测试假设从未配置开始；清理上一轮运行可能留下的行（app_runtime 无 DELETE 授权）。
  await bootstrap`DELETE FROM app.wecom_robot_config`;

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKeyring = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-wecom-robot-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
  const robotFile = join(keyringDirectory, "wecom-robot.keyring");
  await writeFile(
    sessionFile,
    `${KEY_VERSION}:${sessionKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    auditFile,
    `${KEY_VERSION}:${auditKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    idempotencyFile,
    `${KEY_VERSION}:${idempotencyKeyring.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(robotFile, `${KEY_VERSION}:${ROBOT_KEY_HEX}\n`, "utf8");

  previousEnvironment = {
    AUDIT_DATABASE_URL: process.env["AUDIT_DATABASE_URL"],
    AUDIT_HMAC_KEYRING_FILE: process.env["AUDIT_HMAC_KEYRING_FILE"],
    AUDIT_HMAC_KEYRING_TEST_PATH: process.env["AUDIT_HMAC_KEYRING_TEST_PATH"],
    AUDIT_HMAC_KEY_VERSION: process.env["AUDIT_HMAC_KEY_VERSION"],
    DATABASE_URL: process.env["DATABASE_URL"],
    IDEMPOTENCY_FINGERPRINT_KEYRING_FILE:
      process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_FILE"],
    IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH:
      process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH"],
    IDEMPOTENCY_FINGERPRINT_KEY_VERSION:
      process.env["IDEMPOTENCY_FINGERPRINT_KEY_VERSION"],
    NODE_ENV: process.env["NODE_ENV"],
    SESSION_HASH_KEYRING_FILE: process.env["SESSION_HASH_KEYRING_FILE"],
    SESSION_HASH_KEYRING_TEST_PATH:
      process.env["SESSION_HASH_KEYRING_TEST_PATH"],
    SESSION_HASH_KEY_VERSION: process.env["SESSION_HASH_KEY_VERSION"],
    WECOM_ROBOT_ENCRYPTION_KEY_FILE:
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"],
    WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH:
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH"],
    WECOM_ROBOT_ENCRYPTION_KEY_VERSION:
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_VERSION"],
  };
  process.env["NODE_ENV"] = "test";
  process.env["DATABASE_URL"] = urls.runtime;
  process.env["AUDIT_DATABASE_URL"] = urls.auditReader;
  process.env["SESSION_HASH_KEYRING_FILE"] = sessionFile;
  process.env["SESSION_HASH_KEYRING_TEST_PATH"] = "1";
  process.env["SESSION_HASH_KEY_VERSION"] = String(KEY_VERSION);
  process.env["AUDIT_HMAC_KEYRING_FILE"] = auditFile;
  process.env["AUDIT_HMAC_KEYRING_TEST_PATH"] = "1";
  process.env["AUDIT_HMAC_KEY_VERSION"] = String(KEY_VERSION);
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_FILE"] = idempotencyFile;
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH"] = "1";
  process.env["IDEMPOTENCY_FINGERPRINT_KEY_VERSION"] = String(KEY_VERSION);
  process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"] = robotFile;
  process.env["WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH"] = "1";
  process.env["WECOM_ROBOT_ENCRYPTION_KEY_VERSION"] = String(KEY_VERSION);

  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (bootstrap !== undefined) {
    await bootstrap`DELETE FROM app.wecom_robot_config`;
  }
  await runtime?.end({ timeout: 5 });
  await auditReader?.end({ timeout: 5 });
  await bootstrap?.end({ timeout: 5 });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (keyringDirectory !== undefined) {
    await rm(keyringDirectory, { recursive: true, force: true });
  }
});

describe("企业微信机器人配置（真实 PostgreSQL + 真实 HTTP）", () => {
  test("匿名 GET → 401，不泄露配置内容", async () => {
    await expectBodyCode(
      await getConfig(undefined),
      401,
      "ADMIN_SESSION_REQUIRED",
    );
  });

  test("普通成员 GET / PUT → 403，且不写入配置行", async () => {
    const sql = requireRuntime();
    const member = await sessionActor(sql, await createUser(sql));
    await expectBodyCode(await getConfig(member.cookie), 403, "ADMIN_REQUIRED");
    const csrf = await issueCsrf(member.cookie);
    const response = await putConfig({
      cookie: member.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-member-try", secret: TEST_ROBOT_SECRET },
    });
    await expectBodyCode(response, 403, "ADMIN_REQUIRED");
    const rows = (await sql`
      SELECT count(*)::int AS "count" FROM app.wecom_robot_config
    `) as unknown as readonly { count: number }[];
    expect(rows[0]?.count).toBe(0);
  });

  test("管理员 GET 未配置 → NOT_CONFIGURED 且响应 no-store", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const response = await getConfig(admin.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      configured: false,
      ready: false,
      disabledReason: "NOT_CONFIGURED",
      botId: null,
      secretHint: null,
      secretKeyVersion: null,
      rowVersion: null,
      botProfileUrl: null,
      updatedAt: null,
      updatedByName: null,
      revokedUserBindings: null,
      revokedProjectGroups: null,
    });
  });

  test("管理员 PUT 缺 Idempotency-Key → 400；无 CSRF → 401", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    const missingKey = await putConfig({
      cookie: admin.cookie,
      csrf,
      body: { botId: "aib-test-bot", secret: TEST_ROBOT_SECRET },
    });
    expect(missingKey.status).toBe(400);
    const missingKeyBody = (await missingKey.json()) as {
      readonly code: string;
    };
    expect(missingKeyBody.code).toContain("IDEMPOTENCY");

    const missingCsrf = await putConfig({
      cookie: admin.cookie,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-test-bot", secret: TEST_ROBOT_SECRET },
    });
    await expectBodyCode(missingCsrf, 401, "ADMIN_CSRF_REJECTED");
  });

  test("首次配置缺 Secret → 422 且 details 指向 secret 字段", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    const response = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-test-bot" },
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      readonly code: string;
      readonly details: Readonly<Record<string, unknown>>;
    };
    expect(body.code).toBe("WECOM_ROBOT_CONFIG_VALIDATION_FAILED");
    expect(Object.keys(body.details)).toContain("secret");
  });

  test("保存成功：响应只回尾 4 位；密文落库且可用主密钥解回明文", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    const secret = TEST_ROBOT_SECRET;
    const response = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: {
        botId: "aib-test-robot-1",
        secret,
        botProfileUrl: TEST_ROBOT_PROFILE_URL,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["configured"]).toBe(true);
    expect(body["ready"]).toBe(true);
    expect(body["botId"]).toBe("aib-test-robot-1");
    expect(body["secretHint"]).toBe(TEST_ROBOT_SECRET.slice(-4));
    expect(body["secretKeyVersion"]).toBe(1);
    expect(body["rowVersion"]).toBe(1);
    expect(body["botProfileUrl"]).toBe(TEST_ROBOT_PROFILE_URL);
    expect(typeof body["updatedAt"]).toBe("string");
    expect(body["updatedByName"]).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(ROBOT_KEY_HEX);

    const rows = (await sql`
      SELECT secret_ciphertext AS "ciphertext",
             secret_key_version AS "keyVersion",
             secret_hint AS "hint",
             bot_profile_url AS "profileUrl"
        FROM app.wecom_robot_config
       WHERE id = 1
    `) as unknown as readonly {
      ciphertext: Buffer;
      keyVersion: number;
      hint: string;
      profileUrl: string | null;
    }[];
    const row = rows[0]!;
    expect(row.hint).toBe(TEST_ROBOT_SECRET.slice(-4));
    expect(row.profileUrl).toBe(TEST_ROBOT_PROFILE_URL);
    expect(row.ciphertext.includes(Buffer.from(secret, "utf8"))).toBe(false);
    const keyring = parseWecomRobotEncryptionKeyring(
      `${KEY_VERSION}:${ROBOT_KEY_HEX}\n`,
      KEY_VERSION,
    );
    expect(
      decryptWecomRobotSecret(row.ciphertext, row.keyVersion, keyring),
    ).toBe(secret);

    const followUp = await getConfig(admin.cookie);
    expect(followUp.status).toBe(200);
    const followUpBody = (await followUp.json()) as Record<string, unknown>;
    expect(followUpBody["configured"]).toBe(true);
    expect(followUpBody["ready"]).toBe(true);
  });

  test("botProfileUrl：缺省保持、null 清空、非 https → 422", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);

    const first = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: {
        botId: "aib-profile-bot",
        secret: TEST_ROBOT_SECRET,
        botProfileUrl: TEST_ROBOT_PROFILE_URL,
      },
    });
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as Record<string, unknown>)["botProfileUrl"],
    ).toBe(TEST_ROBOT_PROFILE_URL);

    // 缺省保持：只改 botId 时链接不变。
    const rename = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-profile-bot-2" },
    });
    expect(rename.status).toBe(200);
    expect(
      ((await rename.json()) as Record<string, unknown>)["botProfileUrl"],
    ).toBe(TEST_ROBOT_PROFILE_URL);

    // null 清空。
    const cleared = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-profile-bot-2", botProfileUrl: null },
    });
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as Record<string, unknown>)["botProfileUrl"],
    ).toBeNull();

    const invalid = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: {
        botId: "aib-profile-bot-2",
        botProfileUrl: "http://work.weixin.qq.com/openBotProfile/x",
      },
    });
    expect(invalid.status).toBe(422);
    const invalidBody = (await invalid.json()) as {
      readonly code: string;
      readonly details: Readonly<Record<string, unknown>>;
    };
    expect(invalidBody.code).toBe("WECOM_ROBOT_CONFIG_VALIDATION_FAILED");
    expect(Object.keys(invalidBody.details)).toContain("botProfileUrl");
  });

  test("同 Key 同请求重放返回原响应且 row_version 不变；换 body → 409", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    const key = idempotencyKey();
    const first = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: key,
      body: { botId: "aib-replay-bot", secret: TEST_ROBOT_SECRET },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const replay = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: key,
      body: { botId: "aib-replay-bot", secret: TEST_ROBOT_SECRET },
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()) as Record<string, unknown>).toEqual(firstBody);

    const conflict = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: key,
      body: { botId: "aib-replay-bot", secret: TEST_ROBOT_SECRET_ALT },
    });
    expect(conflict.status).toBe(409);
  });

  test("再次保存（仅换 botId）保留原 Secret、递增 row_version 并写审计", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    const keptSecret = TEST_ROBOT_SECRET;
    const created = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-keep-bot", secret: keptSecret },
    });
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody["secretHint"]).toBe(keptSecret.slice(-4));

    const updated = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-keep-bot-renamed" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as Record<string, unknown>;
    expect(updatedBody["botId"]).toBe("aib-keep-bot-renamed");
    expect(updatedBody["secretHint"]).toBe(keptSecret.slice(-4));
    expect(updatedBody["rowVersion"]).toBe(
      (createdBody["rowVersion"] as number) + 1,
    );

    const reader = auditReader;
    if (reader === undefined) throw new Error("audit reader missing");
    const audits = (await reader`
      SELECT actor_id AS "actorId", event_payload AS payload
        FROM app.audit_logs
       WHERE action = 'admin.wecomRobot.update'
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly { actorId: number; payload: unknown }[];
    const audit = audits[0];
    expect(audit?.actorId).toBe(admin.userId);
    const serialized = JSON.stringify(audit?.payload);
    expect(serialized).not.toContain(keptSecret);
    expect(serialized).toContain("aib-keep-bot-renamed");
  });

  test("主密钥不可用：GET 按 ENCRYPTION_KEY_UNAVAILABLE fail closed，带新 Secret 的 PUT → 503", async () => {
    const sql = requireRuntime();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    const original = process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"];
    process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"] = join(
      keyringDirectory!,
      "missing.keyring",
    );
    try {
      const response = await getConfig(admin.cookie);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["ready"]).toBe(false);
      expect(body["disabledReason"]).toBe("ENCRYPTION_KEY_UNAVAILABLE");

      const failed = await putConfig({
        cookie: admin.cookie,
        csrf,
        idempotencyKey: idempotencyKey(),
        body: { botId: "aib-blocked-bot", secret: TEST_ROBOT_SECRET },
      });
      await expectBodyCode(failed, 503, "WECOM_ROBOT_CONFIG_KEY_UNAVAILABLE");

      const withoutSecret = await putConfig({
        cookie: admin.cookie,
        csrf,
        idempotencyKey: idempotencyKey(),
        body: { botId: "aib-renamed-without-secret" },
      });
      expect(withoutSecret.status).toBe(200);
      const withoutSecretBody = (await withoutSecret.json()) as Record<
        string,
        unknown
      >;
      expect(withoutSecretBody["disabledReason"]).toBe(
        "ENCRYPTION_KEY_UNAVAILABLE",
      );
    } finally {
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"] = original;
    }
  });

  test("botProfileUrl 列约束：非 https / 超长被 CHECK 拒绝，合法 https 可写", async () => {
    const sql = requireRuntime();
    const userId = await createUser(sql, { admin: true });
    await sql`
      INSERT INTO app.wecom_robot_config (
        id,
        bot_id,
        secret_ciphertext,
        secret_key_version,
        secret_hint,
        updated_by,
        row_version,
        bot_profile_url
      ) VALUES (
        1,
        'aib-constraint-bot',
        ${Buffer.alloc(32)},
        1,
        'test',
        ${userId},
        1,
        NULL
      )
      ON CONFLICT (id) DO UPDATE SET bot_profile_url = NULL
    `;

    const expectCheckViolation = async (value: string): Promise<void> => {
      try {
        await sql`
          UPDATE app.wecom_robot_config
             SET bot_profile_url = ${value}
           WHERE id = 1
        `;
        throw new Error("check unexpectedly allowed: " + value);
      } catch (error) {
        expect((error as { readonly code?: string }).code).toBe("23514");
      }
    };
    await expectCheckViolation("http://work.weixin.qq.com/x");
    await expectCheckViolation("https://" + "a".repeat(520));

    // 合法 https 可写。
    await sql`
      UPDATE app.wecom_robot_config
         SET bot_profile_url = 'https://work.weixin.qq.com/wework_admin/common/openBotProfile/test'
       WHERE id = 1
    `;
    const rows = (await sql`
      SELECT bot_profile_url AS "profileUrl"
        FROM app.wecom_robot_config
       WHERE id = 1
    `) as unknown as readonly { profileUrl: string | null }[];
    expect(rows[0]?.profileUrl).toBe(
      "https://work.weixin.qq.com/wework_admin/common/openBotProfile/test",
    );
    await sql`
      UPDATE app.wecom_robot_config
         SET bot_profile_url = NULL
       WHERE id = 1
    `;
  });

  test("权限探针：app_runtime 无 DELETE、app_backup 只读", async () => {
    const sql = requireRuntime();
    try {
      await sql.unsafe("DELETE FROM app.wecom_robot_config WHERE id = 1");
      throw new Error("delete unexpectedly allowed");
    } catch (error) {
      expect((error as { readonly code?: string }).code).toBe("42501");
    }
    const backup = connect(urls.backup, 2);
    try {
      const rows = (await backup`
        SELECT count(*)::int AS "count" FROM app.wecom_robot_config
      `) as unknown as readonly { count: number }[];
      expect(rows[0]?.count).toBeGreaterThan(0);
      try {
        await backup.unsafe(
          "UPDATE app.wecom_robot_config SET bot_id = 'x' WHERE id = 1",
        );
        throw new Error("backup update unexpectedly allowed");
      } catch (error) {
        expect((error as { readonly code?: string }).code).toBe("42501");
      }
    } finally {
      await backup.end({ timeout: 5 });
    }
  });

  test("更换机器人（botId 变化）解除全部个人绑定与项目群绑定并返回计数（ADR-078）", async () => {
    const sql = requireRuntime();
    const boot = requireBootstrap();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    await boot`DELETE FROM app.wecom_robot_config`;
    await resetActiveBindings(sql);

    const memberOne = await createUser(sql);
    const memberTwo = await createUser(sql);
    await sql`
      INSERT INTO app.user_wecom_bindings (user_id, wecom_userid, status)
      VALUES (${memberOne}, 'test-switch-member-one', 'ACTIVE')
    `;
    await sql`
      INSERT INTO app.user_wecom_bindings (user_id, wecom_userid, status)
      VALUES (${memberTwo}, 'test-switch-member-two', 'ACTIVE')
    `;
    expect(await countActiveBindings(sql)).toEqual({
      userBindings: 2,
      projectGroups: 0,
    });

    const created = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-switch-bot-a", secret: TEST_ROBOT_SECRET },
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody["revokedUserBindings"]).toBeNull();
    expect(createdBody["revokedProjectGroups"]).toBeNull();

    const key = idempotencyKey();
    const switched = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: key,
      body: { botId: "aib-switch-bot-b" },
    });
    expect(switched.status).toBe(200);
    const switchedBody = (await switched.json()) as Record<string, unknown>;
    expect(switchedBody["revokedUserBindings"]).toBe(2);
    expect(switchedBody["revokedProjectGroups"]).toBe(0);
    expect(await countActiveBindings(sql)).toEqual({
      userBindings: 0,
      projectGroups: 0,
    });

    const revokedRows = (await sql`
      SELECT status, revoked_at AS "revokedAt", row_version AS "rowVersion"
        FROM app.user_wecom_bindings
       WHERE user_id = ${memberOne}
       ORDER BY id DESC
       LIMIT 1
    `) as unknown as readonly {
      status: string;
      revokedAt: Date | null;
      rowVersion: number;
    }[];
    expect(revokedRows[0]?.status).toBe("REVOKED");
    expect(revokedRows[0]?.revokedAt).not.toBeNull();
    expect(revokedRows[0]?.rowVersion).toBe(2);

    // 同 Key 重放返回原响应（含解绑计数），不再次执行解绑。
    const replay = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: key,
      body: { botId: "aib-switch-bot-b" },
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()) as Record<string, unknown>).toEqual(
      switchedBody,
    );

    // GET 配置视图不携带解绑计数（只在保存响应出现）。
    const followUp = await getConfig(admin.cookie);
    const followUpBody = (await followUp.json()) as Record<string, unknown>;
    expect(followUpBody["revokedUserBindings"]).toBeNull();
    expect(followUpBody["revokedProjectGroups"]).toBeNull();

    const reader = auditReader;
    if (reader === undefined) throw new Error("audit reader missing");
    const audits = (await reader`
      SELECT event_payload AS payload
        FROM app.audit_logs
       WHERE action = 'admin.wecomRobot.update'
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly { payload: unknown }[];
    const payload = JSON.stringify(audits[0]?.payload);
    expect(payload).toContain('"robotChanged":true');
    expect(payload).toContain('"revokedUserBindings":2');
    expect(payload).toContain('"revokedProjectGroups":0');
  });

  test("同一 botId 仅轮换 Secret 不触发解绑（ADR-078）", async () => {
    const sql = requireRuntime();
    const boot = requireBootstrap();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    await boot`DELETE FROM app.wecom_robot_config`;
    await resetActiveBindings(sql);

    const member = await createUser(sql);
    await sql`
      INSERT INTO app.user_wecom_bindings (user_id, wecom_userid, status)
      VALUES (${member}, 'test-rotate-member', 'ACTIVE')
    `;
    const created = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-rotate-bot", secret: TEST_ROBOT_SECRET },
    });
    expect(created.status).toBe(200);

    const rotated = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-rotate-bot", secret: TEST_ROBOT_SECRET_ALT },
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as Record<string, unknown>;
    expect(rotatedBody["secretHint"]).toBe(TEST_ROBOT_SECRET_ALT.slice(-4));
    expect(rotatedBody["revokedUserBindings"]).toBeNull();
    expect(rotatedBody["revokedProjectGroups"]).toBeNull();
    expect(await countActiveBindings(sql)).toEqual({
      userBindings: 1,
      projectGroups: 0,
    });
  });

  test("更换机器人但没有生效绑定：返回 0 / 0 而不是 null（ADR-078）", async () => {
    const sql = requireRuntime();
    const boot = requireBootstrap();
    const admin = await sessionActor(
      sql,
      await createUser(sql, { admin: true }),
    );
    const csrf = await issueCsrf(admin.cookie);
    await boot`DELETE FROM app.wecom_robot_config`;
    await resetActiveBindings(sql);

    const created = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-empty-bot-a", secret: TEST_ROBOT_SECRET },
    });
    expect(created.status).toBe(200);

    const switched = await putConfig({
      cookie: admin.cookie,
      csrf,
      idempotencyKey: idempotencyKey(),
      body: { botId: "aib-empty-bot-b" },
    });
    expect(switched.status).toBe(200);
    const body = (await switched.json()) as Record<string, unknown>;
    expect(body["revokedUserBindings"]).toBe(0);
    expect(body["revokedProjectGroups"]).toBe(0);
  });
});

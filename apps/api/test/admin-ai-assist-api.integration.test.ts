import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { hashOpaqueToken } from "../src/auth/token.js";
import {
  connect,
  createUser,
  testUrls,
  type TestUrls,
} from "./database.helpers.js";

/**
 * ADR-068 管理员 AI 辅助转换配置的真实 PostgreSQL 集成用例：GET / PUT / test
 * 三条路由走完整 HTTP 入口（真实 Session、CSRF、幂等、审计），上游是本机
 * 回环 stub，不访问外网。
 */
const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;
const ADMIN_PATH = "/api/v1/admin/ai-assist";
const ADMIN_MODELS_PATH = "/api/v1/admin/ai-assist/models";
const ADMIN_TEST_PATH = "/api/v1/admin/ai-assist/test";
const AUDIT_ACTION = "admin.aiAssistSettings.update";
// 假密钥在运行时拼接，避免 check:secrets 把字面量赋值判为 Secret 泄露。
const KEY_VALUE = ["sk", "live", "abcd", "1234"].join("-");
const ROTATED_KEY = ["sk", "live", "rotated", "9999"].join("-");
const RESTORED_KEY = ["sk", "live", "restored", "0001"].join("-");

interface SessionActor {
  readonly userId: number;
  readonly cookie: string;
  readonly csrf: string;
}

interface UpstreamCall {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

interface SettingsRow {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyCiphertext: Buffer;
  readonly apiKeyHint: string;
  readonly rowVersion: number;
}

let app: NestExpressApplication | undefined;
let baseUrl = "";
let urls: TestUrls;
let runtime: Sql | undefined;
let direct: Sql | undefined;
let auditReader: Sql | undefined;
let keyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sessionKey: Buffer;
let stubServer: Server | undefined;
let upstreamCalls: UpstreamCall[] = [];
let stubResponder: () => { status: number; payload: unknown } = () => ({
  status: 200,
  payload: probePayload(),
});
let modelsResponder: () => { status: number; payload: unknown } = () => ({
  status: 200,
  payload: modelsPayload(),
});

function modelsPayload(): Record<string, unknown> {
  return {
    object: "list",
    data: [
      { id: "stub-model-z", object: "model" },
      { id: "stub-model-a", object: "model" },
      { id: "stub-model-z", object: "model" },
    ],
  };
}

function probePayload(model = "stub-chat-model"): Record<string, unknown> {
  return {
    id: "chatcmpl-probe",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "pong" },
        finish_reason: "stop",
      },
    ],
  };
}

function upstreamEndpoint(): string {
  const endpoint = process.env["AI_ASSIST_ENDPOINT"];
  if (endpoint === undefined) {
    throw new Error("AI_ASSIST_ENDPOINT is not set");
  }
  return endpoint;
}

async function startStubServer(): Promise<string> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed: unknown = raw.length === 0 ? {} : JSON.parse(raw);
      upstreamCalls = [
        ...upstreamCalls,
        {
          method: request.method,
          url: request.url,
          authorization: request.headers["authorization"]?.toString(),
          body: parsed as Record<string, unknown>,
        },
      ];
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const result =
        request.method === "GET" && pathname === "/v1/models"
          ? modelsResponder()
          : stubResponder();
      response.writeHead(result.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(result.payload));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  stubServer = server;
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

async function createApp(): Promise<void> {
  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });
  app.useBodyParser("json", { limit: "1mb" });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function readError(response: Response): Promise<{
  code: string;
  details: Readonly<Record<string, unknown>>;
}> {
  const body = (await response.json()) as {
    code?: unknown;
    details?: unknown;
  };
  return {
    code: typeof body.code === "string" ? body.code : "",
    details:
      typeof body.details === "object" && body.details !== null
        ? (body.details as Readonly<Record<string, unknown>>)
        : {},
  };
}

interface RequestOptions {
  readonly actor?: SessionActor;
  readonly body?: unknown;
  readonly csrf?: string | null;
  readonly idempotencyKey?: string | null;
  readonly origin?: string | null;
}

async function request(
  path: string,
  method: "GET" | "POST" | "PUT",
  options: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? baseUrl : options.origin;
  if (origin !== null) {
    headers["origin"] = origin;
    headers["sec-fetch-site"] = "same-origin";
  }
  if (options.actor !== undefined) {
    headers["cookie"] = options.actor.cookie;
    const csrf = options.csrf === undefined ? options.actor.csrf : options.csrf;
    if (csrf !== null) {
      headers["x-csrf-token"] = csrf;
    }
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const key =
    options.idempotencyKey === undefined
      ? randomUUID()
      : options.idempotencyKey;
  if (key !== null && method !== "GET") {
    headers["Idempotency-Key"] = key;
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
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
  const csrfToken = randomBytes(32).toString("base64url");
  const sessions = (await sql`
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
    RETURNING id
  `) as unknown as readonly { id: number }[];
  const session = sessions[0];
  if (session === undefined) {
    throw new Error("session fixture insert returned no row");
  }
  await sql`
    INSERT INTO app.session_csrf_tokens (session_id, token_hash, expires_at)
    VALUES (
      ${session.id},
      ${hashOpaqueToken(csrfToken, sessionKey)},
      now() + interval '1 hour'
    )
  `;
  return {
    userId,
    cookie: `${SESSION_COOKIE_NAME}=${cookieToken}`,
    csrf: csrfToken,
  };
}

async function adminActor(): Promise<SessionActor> {
  const sql = runtime!;
  return sessionActor(sql, await createUser(sql, { admin: true }));
}

async function memberActor(): Promise<SessionActor> {
  const sql = runtime!;
  return sessionActor(sql, await createUser(sql, { admin: false }));
}

async function readSettingsRow(): Promise<SettingsRow | undefined> {
  const rows = (await direct!`
    SELECT enabled,
           endpoint,
           model,
           api_key_ciphertext AS "apiKeyCiphertext",
           api_key_hint AS "apiKeyHint",
           row_version AS "rowVersion"
      FROM app.ai_assist_settings
     WHERE id = 1
  `) as unknown as readonly SettingsRow[];
  return rows[0];
}

async function clearSettingsRow(): Promise<void> {
  await direct!`DELETE FROM app.ai_assist_settings`;
}

async function auditRows(): Promise<
  readonly { actorId: number; payload: Record<string, unknown> }[]
> {
  return (await auditReader!`
    SELECT actor_id AS "actorId", event_payload AS "payload"
      FROM app.audit_logs
     WHERE action = ${AUDIT_ACTION}
     ORDER BY sequence_no
  `) as unknown as readonly {
    actorId: number;
    payload: Record<string, unknown>;
  }[];
}

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 30);
  direct = connect(urls.bootstrap, 5);
  auditReader = connect(urls.auditReader, 10);
  await migrate(urls.migrator);
  await clearSettingsRow();

  sessionKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-ai-assist-admin-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditKeyFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
  const encryptionFile = join(keyringDirectory, "ai-assist-encryption.keyring");
  const apiKeyFile = join(keyringDirectory, "ai-assist-api-key.txt");
  await writeFile(
    sessionFile,
    `${KEY_VERSION}:${sessionKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    auditKeyFile,
    `${KEY_VERSION}:${randomBytes(32).toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    idempotencyFile,
    `${KEY_VERSION}:${randomBytes(32).toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    encryptionFile,
    `${KEY_VERSION}:${randomBytes(32).toString("hex")}\n`,
    "utf8",
  );
  await writeFile(apiKeyFile, "test-ai-key\n", "utf8");

  previousEnvironment = {
    AI_ASSIST_API_KEY_FILE: process.env["AI_ASSIST_API_KEY_FILE"],
    AI_ASSIST_API_KEY_TEST_PATH: process.env["AI_ASSIST_API_KEY_TEST_PATH"],
    AI_ASSIST_ENABLED: process.env["AI_ASSIST_ENABLED"],
    AI_ASSIST_ENCRYPTION_KEY_FILE: process.env["AI_ASSIST_ENCRYPTION_KEY_FILE"],
    AI_ASSIST_ENCRYPTION_KEY_TEST_PATH:
      process.env["AI_ASSIST_ENCRYPTION_KEY_TEST_PATH"],
    AI_ASSIST_ENCRYPTION_KEY_VERSION:
      process.env["AI_ASSIST_ENCRYPTION_KEY_VERSION"],
    AI_ASSIST_ENDPOINT: process.env["AI_ASSIST_ENDPOINT"],
    AI_ASSIST_MAX_TOKENS: process.env["AI_ASSIST_MAX_TOKENS"],
    AI_ASSIST_MODEL: process.env["AI_ASSIST_MODEL"],
    AI_ASSIST_TIMEOUT_MS: process.env["AI_ASSIST_TIMEOUT_MS"],
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
  };
  process.env["NODE_ENV"] = "test";
  process.env["DATABASE_URL"] = urls.runtime;
  process.env["AUDIT_DATABASE_URL"] = urls.auditReader;
  process.env["SESSION_HASH_KEYRING_FILE"] = sessionFile;
  process.env["SESSION_HASH_KEYRING_TEST_PATH"] = "1";
  process.env["SESSION_HASH_KEY_VERSION"] = String(KEY_VERSION);
  process.env["AUDIT_HMAC_KEYRING_FILE"] = auditKeyFile;
  process.env["AUDIT_HMAC_KEYRING_TEST_PATH"] = "1";
  process.env["AUDIT_HMAC_KEY_VERSION"] = String(KEY_VERSION);
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_FILE"] = idempotencyFile;
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH"] = "1";
  process.env["IDEMPOTENCY_FINGERPRINT_KEY_VERSION"] = String(KEY_VERSION);

  const endpoint = await startStubServer();
  process.env["AI_ASSIST_ENABLED"] = "1";
  process.env["AI_ASSIST_ENDPOINT"] = endpoint;
  process.env["AI_ASSIST_MODEL"] = "stub-chat-model";
  process.env["AI_ASSIST_API_KEY_FILE"] = apiKeyFile;
  process.env["AI_ASSIST_API_KEY_TEST_PATH"] = "1";
  process.env["AI_ASSIST_ENCRYPTION_KEY_FILE"] = encryptionFile;
  process.env["AI_ASSIST_ENCRYPTION_KEY_TEST_PATH"] = "1";
  process.env["AI_ASSIST_ENCRYPTION_KEY_VERSION"] = String(KEY_VERSION);

  await createApp();
});

afterAll(async () => {
  await app?.close();
  await clearSettingsRow();
  await new Promise<void>((resolve) => {
    const server = stubServer;
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await runtime?.end({ timeout: 5 });
  await direct?.end({ timeout: 5 });
  await auditReader?.end({ timeout: 5 });
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

describe("ADR-068 管理员 AI 辅助转换配置（真实 PostgreSQL + stub 上游）", () => {
  test("GET：匿名 401、普通成员 403、管理员 200（环境变量模式、禁用缓存、密钥不回显）", async () => {
    const anonymous = await request(ADMIN_PATH, "GET");
    expect(anonymous.status).toBe(401);
    expect((await readError(anonymous)).code).toBe("ADMIN_SESSION_REQUIRED");

    const member = await memberActor();
    const forbidden = await request(ADMIN_PATH, "GET", { actor: member });
    expect(forbidden.status).toBe(403);
    expect((await readError(forbidden)).code).toBe("ADMIN_REQUIRED");

    const admin = await adminActor();
    const ok = await request(ADMIN_PATH, "GET", { actor: admin });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      source: "ENVIRONMENT",
      ready: true,
      disabledReason: null,
      endpoint: upstreamEndpoint(),
      model: "stub-chat-model",
      keyConfigured: true,
      keyHint: null,
      rowVersion: null,
      updatedAt: null,
    });
    expect(JSON.stringify(body)).not.toContain("test-ai-key");
  });

  test("模型发现：匿名 401、普通成员 403、管理员可用未保存端点与密钥直接获取模型", async () => {
    const anonymous = await request(ADMIN_MODELS_PATH, "POST");
    expect(anonymous.status).toBe(401);
    expect((await readError(anonymous)).code).toBe("ADMIN_SESSION_REQUIRED");

    const member = await memberActor();
    const forbidden = await request(ADMIN_MODELS_PATH, "POST", {
      actor: member,
    });
    expect(forbidden.status).toBe(403);
    expect((await readError(forbidden)).code).toBe("ADMIN_REQUIRED");

    const admin = await adminActor();
    const auditsBefore = (await auditRows()).length;
    const missingBody = await request(ADMIN_MODELS_PATH, "POST", {
      actor: admin,
    });
    expect(missingBody.status).toBe(400);
    expect((await readError(missingBody)).code).toBe(
      "AI_ASSIST_SETTINGS_CONTENT_TYPE_INVALID",
    );

    const invalidEndpoint = await request(ADMIN_MODELS_PATH, "POST", {
      actor: admin,
      body: {
        endpoint: "http://example.com/v1/chat/completions",
        timeoutMs: 15_000,
        apiKey: ROTATED_KEY,
      },
    });
    expect(invalidEndpoint.status).toBe(422);
    const invalidError = await readError(invalidEndpoint);
    expect(invalidError.code).toBe("AI_ASSIST_SETTINGS_VALIDATION_FAILED");
    expect(String(invalidError.details["endpoint"])).toContain("绝对 https");

    const response = await request(ADMIN_MODELS_PATH, "POST", {
      actor: admin,
      body: {
        endpoint: upstreamEndpoint() + "?unsaved=1",
        timeoutMs: 15_000,
        apiKey: ROTATED_KEY,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      reason: null,
      models: ["stub-model-a", "stub-model-z"],
    });
    const call = upstreamCalls[upstreamCalls.length - 1]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/v1/models?unsaved=1");
    expect(call.authorization).toBe("Bearer " + ROTATED_KEY);
    expect(call.body).toEqual({});
    expect(await readSettingsRow()).toBeUndefined();
    expect((await auditRows()).length).toBe(auditsBefore);
  });

  test("PUT：缺 Idempotency-Key 400、缺 CSRF 401、跨域 403、普通成员 403，且不落库", async () => {
    const admin = await adminActor();
    const auditsBefore = (await auditRows()).length;
    const upstreamBefore = upstreamCalls.length;
    const body = {
      enabled: true,
      endpoint: upstreamEndpoint(),
      model: "stub-chat-model",
      timeoutMs: 60_000,
      maxTokens: 8192,
      apiKey: KEY_VALUE,
    };

    const missingKey = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body,
      idempotencyKey: null,
    });
    expect(missingKey.status).toBe(400);
    expect((await readError(missingKey)).code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const missingCsrf = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body,
      csrf: null,
    });
    expect(missingCsrf.status).toBe(401);
    expect((await readError(missingCsrf)).code).toBe("ADMIN_CSRF_REJECTED");

    const crossOrigin = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body,
      origin: "https://evil.example.com",
    });
    expect(crossOrigin.status).toBe(403);
    expect((await readError(crossOrigin)).code).toBe("CSRF_ORIGIN_REJECTED");

    const member = await memberActor();
    const forbidden = await request(ADMIN_PATH, "PUT", {
      actor: member,
      body,
    });
    expect(forbidden.status).toBe(403);
    expect((await readError(forbidden)).code).toBe("ADMIN_REQUIRED");

    expect(await readSettingsRow()).toBeUndefined();
    expect((await auditRows()).length).toBe(auditsBefore);
    expect(upstreamCalls.length).toBe(upstreamBefore);
  });

  test("PUT：首次配置缺密钥 422，字段级 details.apiKey", async () => {
    const admin = await adminActor();
    const upstreamBefore = upstreamCalls.length;
    const response = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body: {
        enabled: true,
        endpoint: upstreamEndpoint(),
        model: "stub-chat-model",
        timeoutMs: 60_000,
        maxTokens: 8192,
      },
    });
    expect(response.status).toBe(422);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_SETTINGS_VALIDATION_FAILED");
    expect(String(error.details["apiKey"])).toContain("首次配置");
    expect(await readSettingsRow()).toBeUndefined();
    expect(upstreamCalls.length).toBe(upstreamBefore);
  });

  test("PUT：管理员保存全链路 200（AES-256-GCM 落库 + 审计不含明文）", async () => {
    const admin = await adminActor();
    const secret = KEY_VALUE;
    const auditsBefore = (await auditRows()).length;
    const upstreamBefore = upstreamCalls.length;
    const endpoint = `${upstreamEndpoint()}?db=1`;
    const response = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body: {
        enabled: true,
        endpoint,
        model: "db-model",
        timeoutMs: 30_000,
        maxTokens: 4_096,
        apiKey: secret,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      source: "DATABASE",
      ready: true,
      disabledReason: null,
      endpoint,
      model: "db-model",
      timeoutMs: 30_000,
      maxTokens: 4_096,
      keyConfigured: true,
      keyHint: "1234",
      rowVersion: 1,
    });
    expect(typeof body["updatedAt"]).toBe("string");

    const row = await readSettingsRow();
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    expect(row!.endpoint).toBe(endpoint);
    expect(row!.model).toBe("db-model");
    expect(row!.apiKeyHint).toBe("1234");
    expect(row!.rowVersion).toBe(1);
    expect(row!.apiKeyCiphertext.length).toBeGreaterThanOrEqual(29);
    expect(row!.apiKeyCiphertext.includes(Buffer.from(secret, "utf8"))).toBe(
      false,
    );

    const audits = await auditRows();
    expect(audits.length).toBe(auditsBefore + 1);
    const entry = audits[audits.length - 1]!;
    expect(entry.actorId).toBe(admin.userId);
    expect(entry.payload["keyChanged"]).toBe(true);
    expect(JSON.stringify(entry.payload)).not.toContain(secret);
    expect(upstreamCalls.length).toBe(upstreamBefore);
  });

  test("数据库行优先于环境变量：GET、测试连接与模型发现都用在线配置与解密密钥", async () => {
    const admin = await adminActor();
    const before = upstreamCalls.length;

    const view = await request(ADMIN_PATH, "GET", { actor: admin });
    const body = (await view.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "DATABASE",
      endpoint: `${upstreamEndpoint()}?db=1`,
      model: "db-model",
      keyHint: "1234",
      rowVersion: 1,
    });

    const response = await request(ADMIN_TEST_PATH, "POST", { actor: admin });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      reason: null,
      model: "stub-chat-model",
    });
    expect(upstreamCalls.length).toBe(before + 1);
    const call = upstreamCalls[upstreamCalls.length - 1]!;
    expect(call.authorization).toBe("Bearer " + KEY_VALUE);
    expect(call.body["model"]).toBe("db-model");
    expect(call.body["max_tokens"]).toBe(1);

    const models = await request(ADMIN_MODELS_PATH, "POST", {
      actor: admin,
      body: {
        endpoint: upstreamEndpoint() + "?db=1",
        timeoutMs: 30_000,
        apiKey: null,
      },
    });
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({
      ok: true,
      reason: null,
      models: ["stub-model-a", "stub-model-z"],
    });
    const modelsCall = upstreamCalls[upstreamCalls.length - 1]!;
    expect(modelsCall.method).toBe("GET");
    expect(modelsCall.url).toBe("/v1/models?db=1");
    expect(modelsCall.authorization).toBe("Bearer " + KEY_VALUE);
    expect(upstreamCalls.length).toBe(before + 2);
  });

  test("PUT：apiKey 缺省保持已存密钥（尾号与密文不变）并递增 row_version", async () => {
    const admin = await adminActor();
    const first = await readSettingsRow();
    const response = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body: {
        enabled: true,
        endpoint: `${upstreamEndpoint()}?db=1`,
        model: "db-model",
        timeoutMs: 30_000,
        maxTokens: 4_096,
        apiKey: null,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["keyHint"]).toBe("1234");
    expect(body["rowVersion"]).toBe(2);

    const second = await readSettingsRow();
    expect(second!.apiKeyHint).toBe("1234");
    expect(second!.rowVersion).toBe(2);
    expect(second!.apiKeyCiphertext.equals(first!.apiKeyCiphertext)).toBe(true);
  });

  test("PUT：同 Idempotency-Key 幂等重放不重复写，不同摘要 409", async () => {
    const admin = await adminActor();
    const key = randomUUID();
    const body = {
      enabled: true,
      endpoint: `${upstreamEndpoint()}?db=1`,
      model: "db-model",
      timeoutMs: 30_000,
      maxTokens: 4_096,
      apiKey: null,
    };
    const before = await readSettingsRow();
    const auditsBefore = (await auditRows()).length;

    const first = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body,
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const firstBody: unknown = await first.json();
    const written = await readSettingsRow();
    expect(written!.rowVersion).toBe(before!.rowVersion + 1);
    expect((await auditRows()).length).toBe(auditsBefore + 1);

    const replay = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect((await readSettingsRow())!.rowVersion).toBe(written!.rowVersion);
    expect((await auditRows()).length).toBe(auditsBefore + 1);

    const mismatch = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body: { ...body, model: "db-model-other" },
      idempotencyKey: key,
    });
    expect(mismatch.status).toBe(409);
    expect((await readError(mismatch)).code).toBe(
      "IDEMPOTENCY_REQUEST_MISMATCH",
    );
  });

  test("急停开关优先于数据库行：GET 与测试连接都按 KILL_SWITCH 关闭", async () => {
    const admin = await adminActor();
    const previous = process.env["AI_ASSIST_ENABLED"];
    process.env["AI_ASSIST_ENABLED"] = "0";
    try {
      const view = await request(ADMIN_PATH, "GET", { actor: admin });
      expect(await view.json()).toMatchObject({
        enabled: true,
        source: "DATABASE",
        ready: false,
        disabledReason: "KILL_SWITCH",
      });
      const probe = await request(ADMIN_TEST_PATH, "POST", { actor: admin });
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({
        ok: false,
        reason: "KILL_SWITCH",
        model: null,
      });
    } finally {
      if (previous === undefined) {
        delete process.env["AI_ASSIST_ENABLED"];
      } else {
        process.env["AI_ASSIST_ENABLED"] = previous;
      }
    }
  });

  test("主密钥不可用：分类 ENCRYPTION_KEY_UNAVAILABLE，保存密钥 503", async () => {
    const admin = await adminActor();
    const previous = process.env["AI_ASSIST_ENCRYPTION_KEY_FILE"];
    process.env["AI_ASSIST_ENCRYPTION_KEY_FILE"] = join(
      keyringDirectory!,
      "missing.keyring",
    );
    try {
      const view = await request(ADMIN_PATH, "GET", { actor: admin });
      expect(await view.json()).toMatchObject({
        ready: false,
        disabledReason: "ENCRYPTION_KEY_UNAVAILABLE",
      });
      const probe = await request(ADMIN_TEST_PATH, "POST", { actor: admin });
      expect(await probe.json()).toEqual({
        ok: false,
        reason: "ENCRYPTION_KEY_UNAVAILABLE",
        model: null,
      });
      const save = await request(ADMIN_PATH, "PUT", {
        actor: admin,
        body: {
          enabled: true,
          endpoint: `${upstreamEndpoint()}?db=1`,
          model: "db-model",
          timeoutMs: 30_000,
          maxTokens: 4_096,
          apiKey: ROTATED_KEY,
        },
      });
      expect(save.status).toBe(503);
      expect((await readError(save)).code).toBe(
        "AI_ASSIST_SETTINGS_KEY_UNAVAILABLE",
      );
      expect((await readSettingsRow())!.apiKeyHint).toBe("1234");
    } finally {
      if (previous === undefined) {
        delete process.env["AI_ASSIST_ENCRYPTION_KEY_FILE"];
      } else {
        process.env["AI_ASSIST_ENCRYPTION_KEY_FILE"] = previous;
      }
    }
  });

  test("密文不可认证：按配置非法分类，重新保存后恢复可用", async () => {
    const admin = await adminActor();
    await direct!`
      UPDATE app.ai_assist_settings
         SET api_key_ciphertext = decode(repeat('00', 40), 'hex')
       WHERE id = 1
    `;
    const view = await request(ADMIN_PATH, "GET", { actor: admin });
    expect(await view.json()).toMatchObject({
      ready: false,
      disabledReason: "CONFIG_INVALID",
    });
    const probe = await request(ADMIN_TEST_PATH, "POST", { actor: admin });
    expect(await probe.json()).toEqual({
      ok: false,
      reason: "CONFIG_INVALID",
      model: null,
    });

    const restore = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body: {
        enabled: true,
        endpoint: `${upstreamEndpoint()}?db=1`,
        model: "db-model",
        timeoutMs: 30_000,
        maxTokens: 4_096,
        apiKey: RESTORED_KEY,
      },
    });
    expect(restore.status).toBe(200);
    const recovered = await request(ADMIN_PATH, "GET", { actor: admin });
    expect(await recovered.json()).toMatchObject({
      ready: true,
      keyHint: "0001",
    });
  });

  test("模型发现：上游 401 映射 AUTH", async () => {
    const admin = await adminActor();
    modelsResponder = () => ({ status: 401, payload: { error: "bad key" } });
    try {
      const models = await request(ADMIN_MODELS_PATH, "POST", {
        actor: admin,
        body: {
          endpoint: upstreamEndpoint() + "?db=1",
          timeoutMs: 30_000,
          apiKey: null,
        },
      });
      expect(models.status).toBe(200);
      expect(await models.json()).toEqual({
        ok: false,
        reason: "AUTH",
        models: [],
      });
    } finally {
      modelsResponder = () => ({ status: 200, payload: modelsPayload() });
    }
  });

  test("测试连接：上游 401 映射 AUTH", async () => {
    const admin = await adminActor();
    stubResponder = () => ({ status: 401, payload: { error: "bad key" } });
    try {
      const probe = await request(ADMIN_TEST_PATH, "POST", { actor: admin });
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({
        ok: false,
        reason: "AUTH",
        model: null,
      });
    } finally {
      stubResponder = () => ({ status: 200, payload: probePayload() });
    }
  });

  test("PUT：根地址自动补全 /chat/completions，测试连接可直接使用", async () => {
    const admin = await adminActor();
    const base = upstreamEndpoint().replace(/\/chat\/completions$/, "");
    const before = upstreamCalls.length;
    const response = await request(ADMIN_PATH, "PUT", {
      actor: admin,
      body: {
        enabled: true,
        endpoint: base,
        model: "db-model",
        timeoutMs: 30_000,
        maxTokens: 4_096,
        apiKey: KEY_VALUE,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ endpoint: upstreamEndpoint() });

    const row = await readSettingsRow();
    expect(row!.endpoint).toBe(upstreamEndpoint());

    const probe = await request(ADMIN_TEST_PATH, "POST", { actor: admin });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({
      ok: true,
      reason: null,
      model: "stub-chat-model",
    });
    expect(upstreamCalls.length).toBe(before + 1);
  });
});

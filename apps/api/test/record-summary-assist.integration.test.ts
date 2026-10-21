import { randomBytes } from "node:crypto";
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
 * ADR-076 迭代总结 AI 改写：纯校验接口的端到端契约。
 *
 * 要锁住三件事：① 请求里的 requirement / facts 原样进上游提示词，正文由用户自己
 * 带来的事实充当唯一来源，服务端因此不查库也不产生新的读权限；② 上游失败按固定
 * 错误码 + reason 归类，不下发上游原文；③ 全链路没有任何持久化副作用（审计与导入
 * 运行记录都不增行），也没有 Set-Cookie。
 */

const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;
const ASSIST_PATH = "/api/v1/record-summaries/assist";

const REQUIREMENT = "给领导看，先给结论，突出遗留风险，每条只留一句";
const FACTS = [
  "2026 年度总结",
  "全部项目 ／ 2026-01-01 - 2026-12-31 ／ 全体成员",
  "",
  "## 整体概览",
  "范围内 1 个项目、1 条迭代记录，覆盖 0 个已完成任务。",
  "",
  "- **支付修正**：要点句",
].join("\n");

interface SessionActor {
  readonly userId: number;
  readonly loginName: string;
  readonly cookie: string;
}

interface UpstreamRequestRecord {
  readonly authorization: string | undefined;
  readonly body: unknown;
}

let app: NestExpressApplication | undefined;
let baseUrl = "";
let urls: TestUrls;
let runtime: Sql | undefined;
let auditReader: Sql | undefined;
let keyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sessionKey: Buffer;
let stubServer: Server | undefined;
let upstreamRequestCount = 0;
let lastUpstreamRequest: UpstreamRequestRecord | undefined;
let stubResponder: () => { status: number; payload: unknown } = () => ({
  status: 200,
  payload: completionPayload("## 结论\n本期交付稳定。"),
});

function completionPayload(
  content: string,
  finishReason = "stop",
  model = "stub-chat-model",
): Record<string, unknown> {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
  };
}

async function startStubServer(): Promise<string> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      upstreamRequestCount += 1;
      lastUpstreamRequest = {
        authorization: request.headers["authorization"]?.toString(),
        body: raw.length === 0 ? undefined : JSON.parse(raw),
      };
      const result = stubResponder();
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.payload));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  stubServer = server;
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/v1/chat/completions`;
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
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
}

async function readError(
  response: Response,
): Promise<{ code: string; details: Readonly<Record<string, unknown>> }> {
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

async function postAssist(
  body: unknown,
  actor?: SessionActor,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (actor !== undefined) {
    headers["cookie"] = actor.cookie;
  }
  return fetch(`${baseUrl}${ASSIST_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function sessionActor(sql: Sql, userId: number): Promise<SessionActor> {
  const users = (await sql`
    SELECT login_name AS "loginName", auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { loginName: string; authVersion: number }[];
  const user = users[0];
  if (user === undefined) {
    throw new Error(`user fixture ${String(userId)} does not exist`);
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
    loginName: user.loginName,
    cookie: `${SESSION_COOKIE_NAME}=${cookieToken}`,
  };
}

async function countAuditRows(sql: Sql): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count FROM app.audit_logs
  `) as unknown as readonly { count: number }[];
  return rows[0]?.count ?? -1;
}

async function countImportRunRows(sql: Sql): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count FROM app.document_import_runs
  `) as unknown as readonly { count: number }[];
  return rows[0]?.count ?? -1;
}

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 30);
  auditReader = connect(urls.auditReader, 10);
  await migrate(urls.migrator);

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-summary-assist-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
  const apiKeyFile = join(keyringDirectory, "ai-assist-api-key.txt");
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
    `${KEY_VERSION}:${idempotencyKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(apiKeyFile, "test-ai-key\n", "utf8");

  previousEnvironment = {
    AI_ASSIST_API_KEY_FILE: process.env["AI_ASSIST_API_KEY_FILE"],
    AI_ASSIST_API_KEY_TEST_PATH: process.env["AI_ASSIST_API_KEY_TEST_PATH"],
    AI_ASSIST_ENABLED: process.env["AI_ASSIST_ENABLED"],
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
  process.env["AUDIT_HMAC_KEYRING_FILE"] = auditFile;
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

  await createApp();
});

afterAll(async () => {
  await app?.close();
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

describe("record-summaries assist（已启用，stub 上游 + 真实 PostgreSQL）", () => {
  test("全链路 200：改写正文原样返回，提示词带上要求与事实，且无任何数据库写入", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const rewritten = "## 结论\n本期交付稳定，遗留 1 条待跟进。";
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(rewritten),
    });
    const auditBefore = await countAuditRows(auditReader!);
    const runsBefore = await countImportRunRows(sql);

    const response = await postAssist(
      { requirement: REQUIREMENT, facts: FACTS },
      actor,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = (await response.json()) as {
      markdown: string;
      model: string;
      truncated: boolean;
    };
    expect(body.markdown).toBe(rewritten);
    expect(body.model).toBe("stub-chat-model");
    expect(body.truncated).toBe(false);

    // 上游请求体：模型与 messages 由提示词构造，要求与事实各自成段，密钥只走 Authorization。
    const upstreamBody = lastUpstreamRequest?.body as {
      model: string;
      messages: readonly { role: string; content: string }[];
      max_tokens: number;
      temperature: number;
      stream: boolean;
    };
    expect(lastUpstreamRequest?.authorization).toBe("Bearer test-ai-key");
    expect(upstreamBody.model).toBe("stub-chat-model");
    expect(upstreamBody.stream).toBe(false);
    expect(upstreamBody.temperature).toBe(0.2);
    const system = upstreamBody.messages[0];
    const user = upstreamBody.messages[1];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("唯一的事实来源");
    expect(system?.content).toContain("默认结论先行");
    expect(system?.content).toContain("即使受众是领导");
    expect(system?.content).toContain(
      "只把正文已有的未完成事项或遗留风险转写成行动项",
    );
    expect(user?.role).toBe("user");
    expect(user?.content).toContain(REQUIREMENT);
    expect(user?.content).toContain("支付修正");
    // Cookie 与 API Key 明文都不进上游请求体。
    const serialized = JSON.stringify(upstreamBody);
    expect(serialized).not.toContain(actor.cookie);
    expect(serialized).not.toContain("test-ai-key");

    // 纯校验接口：审计与导入运行记录都不增行。
    expect(await countAuditRows(auditReader!)).toBe(auditBefore);
    expect(await countImportRunRows(sql)).toBe(runsBefore);
  });

  test("finish_reason=length：正文照返并置 truncated", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({
      status: 200,
      payload: completionPayload("## 结论\n被截断的正文", "length"),
    });

    const response = await postAssist(
      { requirement: REQUIREMENT, facts: FACTS },
      actor,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      markdown: string;
      truncated: boolean;
    };
    expect(body.markdown).toBe("## 结论\n被截断的正文");
    expect(body.truncated).toBe(true);
  });

  test("匿名请求 401，且不调用上游", async () => {
    const before = upstreamRequestCount;
    const response = await postAssist({
      requirement: REQUIREMENT,
      facts: FACTS,
    });
    expect(response.status).toBe(401);
    const error = await readError(response);
    expect(error.code).toBe("RECORD_SUMMARY_ASSIST_SESSION_REQUIRED");
    expect(upstreamRequestCount).toBe(before);
  });

  test("要求为空 / 事实超限 422，且不进入上游调用", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const before = upstreamRequestCount;

    const empty = await postAssist({ requirement: "", facts: FACTS }, actor);
    expect(empty.status).toBe(422);

    const tooLong = await postAssist(
      { requirement: REQUIREMENT, facts: "x".repeat(20_001) },
      actor,
    );
    expect(tooLong.status).toBe(422);

    const requirementTooLong = await postAssist(
      { requirement: "x".repeat(501), facts: FACTS },
      actor,
    );
    expect(requirementTooLong.status).toBe(422);

    expect(upstreamRequestCount).toBe(before);
  });

  test("上游 429 映射 503 AI_ASSIST_UPSTREAM_FAILED（rate-limited）", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({ status: 429, payload: { error: "rate limited" } });

    const response = await postAssist(
      { requirement: REQUIREMENT, facts: FACTS },
      actor,
    );

    expect(response.status).toBe(503);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_UPSTREAM_FAILED");
    expect(error.details["reason"]).toBe("rate-limited");
  });

  test("上游 500 映射 503 AI_ASSIST_UPSTREAM_FAILED（invalid-response）", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({ status: 500, payload: { error: "boom" } });

    const response = await postAssist(
      { requirement: REQUIREMENT, facts: FACTS },
      actor,
    );

    expect(response.status).toBe(503);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_UPSTREAM_FAILED");
    expect(error.details["reason"]).toBe("invalid-response");
  });
});

describe("record-summaries assist fail closed（未启用）", () => {
  test("未启用：503 AI_ASSIST_DISABLED 且不调用上游", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    await app?.close();
    app = undefined;
    delete process.env["AI_ASSIST_ENABLED"];
    await createApp();
    const before = upstreamRequestCount;

    const response = await postAssist(
      { requirement: REQUIREMENT, facts: FACTS },
      actor,
    );

    expect(response.status).toBe(503);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_DISABLED");
    expect(upstreamRequestCount).toBe(before);
  });
});

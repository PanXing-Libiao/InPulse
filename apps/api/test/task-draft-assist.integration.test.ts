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
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./database.helpers.js";

/**
 * 新建任务 AI 识别：只返回预填草稿，不创建任务、不写库。
 *
 * 重点锁四件事：① 模型只按名称回答，成员 / 模块 ID 由服务端按真实
 * 清单匹配，模型编造的名字全部丢弃；② LOW 置信度不猜归属与负责人；
 * ③ 未登录 401、非项目成员 404；④ 上游失败与未启用统一 503，且没有副作用。
 */
const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;
const ASSIST_PATH = "/api/v1/projects";

interface SessionActor {
  readonly userId: number;
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
  payload: completionPayload("{}"),
});

function completionPayload(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    model: "stub-chat-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

function modelJson(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    reply: "识别到 5 项，归属和负责人请再确认。",
    title: "修复登录偶发超时",
    description: "定位登录偶发超时的原因并修复，补充回归用例。",
    priority: "HIGH",
    dueDate: "2026-11-06",
    assigneeNames: ["张三"],
    moduleName: "账号与登录",
    confidence: "HIGH",
    notes: [],
    ...overrides,
  });
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
  return "http://127.0.0.1:" + String(address.port) + "/v1/chat/completions";
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
  baseUrl = "http://127.0.0.1:" + String(address.port);
}

async function postAssist(
  projectId: number,
  body: unknown,
  actor?: SessionActor,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (actor !== undefined) headers["cookie"] = actor.cookie;
  return fetch(
    baseUrl + ASSIST_PATH + "/" + String(projectId) + "/task-draft-assist",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

async function postStandaloneAssist(
  body: unknown,
  actor?: SessionActor,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (actor !== undefined) headers["cookie"] = actor.cookie;
  return fetch(baseUrl + "/api/v1/task-draft-assist", {
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
    throw new Error("user fixture " + String(userId) + " does not exist");
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
  return { userId, cookie: SESSION_COOKIE_NAME + "=" + cookieToken };
}

interface Seed {
  readonly leaderId: number;
  readonly outsiderId: number;
  readonly project: ProjectFixture;
  readonly moduleId: number;
}

async function seedProject(sql: Sql): Promise<Seed> {
  const leaderId = await createUser(sql);
  await sql`
    UPDATE app.users
       SET name = '张三', row_version = row_version + 1
     WHERE id = ${leaderId}
  `;
  const project = await createProject(sql, leaderId);
  const [module] = await sql<{ id: number }[]>`
    INSERT INTO app.modules (project_id, name, created_by)
    VALUES (${project.projectId}, '账号与登录', ${leaderId})
    RETURNING id
  `;
  if (module === undefined) throw new Error("module fixture insert failed");
  const outsiderId = await createUser(sql);
  return {
    leaderId,
    outsiderId,
    project,
    moduleId: module.id,
  };
}

async function countRows(sql: Sql, table: string): Promise<number> {
  const rows = (await sql.unsafe(
    "SELECT count(*)::int AS count FROM " + table,
  )) as unknown as readonly { count: number }[];
  return rows[0]?.count ?? -1;
}

async function readError(
  response: Response,
): Promise<{ code: string; details: Readonly<Record<string, unknown>> }> {
  const body = (await response.json()) as { code?: unknown; details?: unknown };
  return {
    code: typeof body.code === "string" ? body.code : "",
    details:
      typeof body.details === "object" && body.details !== null
        ? (body.details as Readonly<Record<string, unknown>>)
        : {},
  };
}

let seed: Seed;
let leaderSession: SessionActor;
let outsiderSession: SessionActor;

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 30);
  auditReader = connect(urls.auditReader, 10);
  await migrate(urls.migrator);

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-task-draft-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
  const apiKeyFile = join(keyringDirectory, "ai-assist-api-key.txt");
  await writeFile(
    sessionFile,
    KEY_VERSION + ":" + sessionKey.toString("hex") + "\n",
    "utf8",
  );
  await writeFile(
    auditFile,
    KEY_VERSION + ":" + auditKey.toString("hex") + "\n",
    "utf8",
  );
  await writeFile(
    idempotencyFile,
    KEY_VERSION + ":" + idempotencyKey.toString("hex") + "\n",
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

  const fixtureSql = runtime;
  if (fixtureSql === undefined) throw new Error("runtime sql missing");
  seed = await seedProject(fixtureSql);
  leaderSession = await sessionActor(fixtureSql, seed.leaderId);
  outsiderSession = await sessionActor(fixtureSql, seed.outsiderId);
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
    server.close(() => {
      resolve();
    });
  });
  await runtime?.end({ timeout: 5 });
  await auditReader?.end({ timeout: 5 });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (keyringDirectory !== undefined) {
    await rm(keyringDirectory, { recursive: true, force: true });
  }
});

describe("POST /projects/{projectId}/task-draft-assist", () => {
  test("未选项目：先识别描述，归属与负责人留空并提示补充", async () => {
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(modelJson()),
    });
    const response = await postStandaloneAssist(
      {
        message: "李工说登录验证码一直转圈，优先处理",
        history: [],
      },
      leaderSession,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notes: readonly string[];
      draft: Readonly<Record<string, unknown>>;
    };
    expect(body.draft).toMatchObject({
      title: "修复登录偶发超时",
      priority: "HIGH",
      dueAt: "2026-11-06T18:00:00+08:00",
      assigneeIds: [],
      assigneeNames: [],
      moduleId: null,
      moduleName: null,
    });
    expect(body.notes.join("\n")).toContain("未选择项目");

    const upstream = lastUpstreamRequest?.body as
      { messages?: readonly { content?: string }[] } | undefined;
    const prompt = (upstream?.messages ?? [])
      .map((message) => message.content ?? "")
      .join("\n");
    expect(prompt).toContain("尚未选择项目");
    expect(prompt).toContain("李工说登录验证码一直转圈");
    expect(prompt).not.toContain("项目里没有活跃成员");
  });

  test("未选项目的识别未登录：401，且不调用上游", async () => {
    upstreamRequestCount = 0;
    const response = await postStandaloneAssist({
      message: "先看一眼截图",
      history: [],
    });
    expect(response.status).toBe(401);
    expect(upstreamRequestCount).toBe(0);
  });

  test("未登录：401，且不调用上游", async () => {
    const before = upstreamRequestCount;
    const response = await postAssist(seed.project.projectId, {
      message: "修一下登录超时",
      history: [],
    });
    expect(response.status).toBe(401);
    expect(upstreamRequestCount).toBe(before);
  });

  test("非项目成员：404，不泄露项目存在性，也不调用上游", async () => {
    const before = upstreamRequestCount;
    const response = await postAssist(
      seed.project.projectId,
      { message: "修一下登录超时", history: [] },
      outsiderSession,
    );
    expect(response.status).toBe(404);
    expect(await readError(response)).toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    expect(upstreamRequestCount).toBe(before);
  });

  test("按名称匹配真实成员与模块，并把 18:00 截止时区补齐", async () => {
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(modelJson()),
    });
    const auditSql = auditReader;
    const runtimeSql = runtime;
    if (auditSql === undefined || runtimeSql === undefined) {
      throw new Error("integration sql missing");
    }
    const auditsBefore = await countRows(auditSql, "app.audit_logs");
    const tasksBefore = await countRows(runtimeSql, "app.tasks");

    const response = await postAssist(
      seed.project.projectId,
      {
        message: "周五前让张三修登录偶发超时，优先级高",
        history: [],
      },
      leaderSession,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reply: string;
      confidence: string;
      notes: readonly string[];
      draft: Readonly<Record<string, unknown>>;
    };
    expect(body.confidence).toBe("HIGH");
    expect(body.draft).toMatchObject({
      title: "修复登录偶发超时",
      priority: "HIGH",
      dueAt: "2026-11-06T18:00:00+08:00",
      assigneeIds: [seed.leaderId],
      assigneeNames: ["张三"],
      moduleId: seed.moduleId,
      moduleName: "账号与登录",
    });

    const upstream = lastUpstreamRequest?.body as
      { messages?: readonly { content?: string }[] } | undefined;
    const prompt = (upstream?.messages ?? [])
      .map((message) => message.content ?? "")
      .join("\n");
    expect(prompt).toContain("张三");
    expect(prompt).toContain("账号与登录");

    expect(await countRows(auditSql, "app.audit_logs")).toBe(auditsBefore);
    expect(await countRows(runtimeSql, "app.tasks")).toBe(tasksBefore);
  });

  test("粘贴截图时把图片和文本一起发给多模态模型", async () => {
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(modelJson({})),
    });
    const imageBase64 = Buffer.from("fake-chat-screenshot").toString("base64");
    const response = await postAssist(
      seed.project.projectId,
      {
        message: "",
        history: [],
        images: [{ mimeType: "image/png", data: imageBase64 }],
      },
      leaderSession,
    );
    expect(response.status).toBe(200);

    const upstream = lastUpstreamRequest?.body as
      | {
          messages?: readonly {
            role?: string;
            content?: unknown;
          }[];
        }
      | undefined;
    const userMessage = (upstream?.messages ?? []).find(
      (message) => message.role === "user",
    );
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage?.content as readonly {
      type?: string;
      text?: string;
      image_url?: { url?: string };
    }[];
    expect(
      parts.some(
        (part) =>
          part.type === "image_url" &&
          (part.image_url?.url ?? "") ===
            "data:image/png;base64," + imageBase64,
      ),
    ).toBe(true);
  });

  test("模型编造的名字一律丢弃，只保留真实清单里的 ID", async () => {
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(
        modelJson({
          assigneeNames: ["不存在的人"],
          moduleName: "不存在的模块",
          confidence: "HIGH",
        }),
      ),
    });
    const response = await postAssist(
      seed.project.projectId,
      { message: "随便建个任务", history: [] },
      leaderSession,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notes: readonly string[];
      draft: Readonly<Record<string, unknown>>;
    };
    expect(body.draft).toMatchObject({
      assigneeIds: [],
      moduleId: null,
      moduleName: null,
    });
    expect(body.notes.join("\n")).toContain("不在项目成员里");
    expect(body.notes.join("\n")).toContain("不在当前项目里");
  });

  test("LOW 置信度不猜归属与负责人", async () => {
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(modelJson({ confidence: "LOW" })),
    });
    const response = await postAssist(
      seed.project.projectId,
      { message: "大概和登录有关，你看着办", history: [] },
      leaderSession,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      confidence: string;
      notes: readonly string[];
      draft: Readonly<Record<string, unknown>>;
    };
    expect(body.confidence).toBe("LOW");
    expect(body.draft).toMatchObject({
      assigneeIds: [],
      moduleId: null,
      moduleName: null,
    });
    expect(body.notes.join("\n")).toContain("请手动选择");
  });

  test("上游失败：503 AI_ASSIST_UPSTREAM_FAILED", async () => {
    stubResponder = () => ({ status: 500, payload: { error: "boom" } });
    const response = await postAssist(
      seed.project.projectId,
      { message: "修登录", history: [] },
      leaderSession,
    );
    expect(response.status).toBe(503);
    expect(await readError(response)).toMatchObject({
      code: "AI_ASSIST_UPSTREAM_FAILED",
    });
  });

  test("未启用：503 AI_ASSIST_DISABLED 且不调用上游", async () => {
    process.env["AI_ASSIST_ENABLED"] = "0";
    const before = upstreamRequestCount;
    const response = await postAssist(
      seed.project.projectId,
      { message: "修登录", history: [] },
      leaderSession,
    );
    process.env["AI_ASSIST_ENABLED"] = "1";
    expect(response.status).toBe(503);
    expect(await readError(response)).toMatchObject({
      code: "AI_ASSIST_DISABLED",
    });
    expect(upstreamRequestCount).toBe(before);
  });
});

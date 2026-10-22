import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import { DOCUMENT_IMPORT_TEMPLATE } from "@inpulse/api-contract";
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

const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;
const ASSIST_PATH = "/api/v1/document-imports/assist";

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
  payload: completionPayload(DOCUMENT_IMPORT_TEMPLATE),
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

async function createFeatureFixture(
  sql: Sql,
  project: ProjectFixture,
  userId: number,
  name: string,
): Promise<number> {
  const [row] = await sql<Array<{ id: number }>>`
    INSERT INTO app.features (project_id, module_id, code, name, created_by)
    VALUES (
      ${project.projectId},
      ${project.moduleId},
      ${project.code + "-F-1"},
      ${name},
      ${userId}
    )
    RETURNING id
  `;
  if (row === undefined) {
    throw new Error("Feature fixture insert returned no row");
  }
  return row.id;
}
beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 30);
  auditReader = connect(urls.auditReader, 10);
  await migrate(urls.migrator);

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-ai-assist-"));
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
describe("assist（已启用，stub 上游 + 真实 PostgreSQL）", () => {
  test("WHOLE_PROJECT 全链路 200：草稿、模型回显、提示词构造正确，且无任何数据库写入", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(
        DOCUMENT_IMPORT_TEMPLATE,
        "stop",
        "stub-chat-model",
      ),
    });
    const auditBefore = await countAuditRows(auditReader!);
    const runsBefore = await countImportRunRows(sql);
    const response = await postAssist(
      {
        mode: "WHOLE_PROJECT",
        text: "我们要做一个商城系统，包含支付模块，张三负责退款回调修复。",
      },
      actor,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      markdown: string;
      model: string;
      issues: readonly { severity: string; code: string }[];
    };
    expect(body.markdown).toBe(DOCUMENT_IMPORT_TEMPLATE);
    expect(body.model).toBe("stub-chat-model");
    expect(body.issues).toEqual([]);
    expect(lastUpstreamRequest?.authorization).toBe("Bearer test-ai-key");
    const upstreamBody = lastUpstreamRequest?.body as {
      model: string;
      messages: readonly { role: string; content: string }[];
      max_tokens: number;
      temperature: number;
      stream: boolean;
    };
    expect(upstreamBody.model).toBe("stub-chat-model");
    expect(upstreamBody.max_tokens).toBe(8192);
    expect(upstreamBody.temperature).toBe(0.2);
    expect(upstreamBody.stream).toBe(false);
    expect(upstreamBody.messages[0]!.role).toBe("system");
    expect(upstreamBody.messages[0]!.content).toContain(
      DOCUMENT_IMPORT_TEMPLATE,
    );
    expect(upstreamBody.messages[0]!.content).toContain("整项目导入");
    // ADR-073 修订：整项目指令要点名创建者（本次导入人）写进项目成员，姓名取自当前
    // Session 对应用户（本夹具的姓名是 "Test <loginName>"），且不写进 user message。
    expect(upstreamBody.messages[0]!.content).toContain(
      "本次导入人的姓名是「Test " + actor.loginName + "」",
    );
    expect(upstreamBody.messages[1]!.content).not.toContain("Test ");
    expect(upstreamBody.messages[1]).toEqual({
      role: "user",
      content: "我们要做一个商城系统，包含支付模块，张三负责退款回调修复。",
    });
    expect(await countAuditRows(auditReader!)).toBe(auditBefore);
    expect(await countImportRunRows(sql)).toBe(runsBefore);
  });

  test("IN_PROJECT：system 使用项目内模式约束，草稿原样返回", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({
      status: 200,
      payload: completionPayload("## 模块：支付\n- 说明：支付与退款能力"),
    });
    const response = await postAssist(
      { mode: "IN_PROJECT", text: "支付模块的需求说明" },
      actor,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      markdown: string;
      issues: readonly unknown[];
    };
    expect(body.markdown).toBe("## 模块：支付\n- 说明：支付与退款能力");
    expect(body.issues).toEqual([]);
    const upstreamBody = lastUpstreamRequest?.body as {
      messages: readonly { role: string; content: string }[];
    };
    expect(upstreamBody.messages[0]!.content).toContain(
      "项目内导入（向已有项目追加）",
    );
    expect(upstreamBody.messages[0]!.content).not.toContain(
      "草稿必须包含「# 项目：」段",
    );
  });

  test("ADR-094 指定模块：校验写权限与归属，提示词带目标且不写库", async () => {
    const sql = runtime!;
    const ownerId = await createUser(sql);
    const project = await createProject(sql, ownerId);
    const actor = await sessionActor(sql, ownerId);
    stubResponder = () => ({
      status: 200,
      payload: completionPayload("## 模块：未分类\n- 说明：新增功能与任务"),
    });
    const auditBefore = await countAuditRows(auditReader!);
    const runsBefore = await countImportRunRows(sql);
    const response = await postAssist(
      {
        mode: "IN_PROJECT",
        text: "未分类模块要新增退款功能",
        target: {
          projectId: project.projectId,
          moduleId: project.moduleId,
          featureId: null,
        },
      },
      actor,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issues: readonly { severity: string }[];
    };
    expect(body.issues.filter((issue) => issue.severity === "ERROR")).toEqual(
      [],
    );
    const upstreamBody = lastUpstreamRequest?.body as {
      messages: readonly { role: string; content: string }[];
    };
    expect(upstreamBody.messages[0]!.content).toContain(
      "本次导入目标由系统选定为已有模块：「未分类」",
    );
    expect(upstreamBody.messages[0]!.content).toContain("## 模块：未分类");
    expect(upstreamBody.messages[1]).toEqual({
      role: "user",
      content: "未分类模块要新增退款功能",
    });
    expect(await countAuditRows(auditReader!)).toBe(auditBefore);
    expect(await countImportRunRows(sql)).toBe(runsBefore);
  });

  test("ADR-094 指定功能：提示词注入模块与功能名，草稿只含目标功能", async () => {
    const sql = runtime!;
    const ownerId = await createUser(sql);
    const project = await createProject(sql, ownerId);
    const featureId = await createFeatureFixture(
      sql,
      project,
      ownerId,
      "退款回调",
    );
    const actor = await sessionActor(sql, ownerId);
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(
        "## 模块：未分类\n### 功能：退款回调\n#### 任务：补超时重试\n- 负责人：张三\n- 优先级：高",
      ),
    });
    const response = await postAssist(
      {
        mode: "IN_PROJECT",
        text: "退款回调补一条超时重试任务",
        target: {
          projectId: project.projectId,
          moduleId: project.moduleId,
          featureId,
        },
      },
      actor,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issues: readonly { severity: string }[];
    };
    expect(body.issues.filter((issue) => issue.severity === "ERROR")).toEqual(
      [],
    );
    const upstreamBody = lastUpstreamRequest?.body as {
      messages: readonly { role: string; content: string }[];
    };
    expect(upstreamBody.messages[0]!.content).toContain(
      "下的已有功能「退款回调」",
    );
    expect(upstreamBody.messages[0]!.content).toContain(
      "只能在目标功能下输出要新增的任务",
    );
  });

  test("ADR-094 非项目成员指定目标：404 且不调用上游", async () => {
    const sql = runtime!;
    const ownerId = await createUser(sql);
    const project = await createProject(sql, ownerId);
    const outsiderId = await createUser(sql);
    const actor = await sessionActor(sql, outsiderId);
    const before = upstreamRequestCount;
    const response = await postAssist(
      {
        mode: "IN_PROJECT",
        text: "越权读取目标",
        target: {
          projectId: project.projectId,
          moduleId: project.moduleId,
          featureId: null,
        },
      },
      actor,
    );
    expect(response.status).toBe(404);
    const error = await readError(response);
    expect(error.code).toBe("DOCUMENT_IMPORT_TARGET_NOT_FOUND");
    expect(upstreamRequestCount).toBe(before);
  });

  test("ADR-094 模块不属于目标项目：404 且不调用上游", async () => {
    const sql = runtime!;
    const ownerId = await createUser(sql);
    const first = await createProject(sql, ownerId);
    const second = await createProject(sql, ownerId);
    const actor = await sessionActor(sql, ownerId);
    const before = upstreamRequestCount;
    const response = await postAssist(
      {
        mode: "IN_PROJECT",
        text: "跨项目模块",
        target: {
          projectId: first.projectId,
          moduleId: second.moduleId,
          featureId: null,
        },
      },
      actor,
    );
    expect(response.status).toBe(404);
    const error = await readError(response);
    expect(error.code).toBe("DOCUMENT_IMPORT_TARGET_NOT_FOUND");
    expect(upstreamRequestCount).toBe(before);
  });

  test("ADR-094 整项目模式携带目标：契约 422 且不调用上游", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const before = upstreamRequestCount;
    const response = await postAssist(
      {
        mode: "WHOLE_PROJECT",
        text: "整项目需求",
        target: { projectId: 1, moduleId: null, featureId: null },
      },
      actor,
    );
    expect(response.status).toBe(422);
    expect(upstreamRequestCount).toBe(before);
  });

  test("finish_reason=length：草稿照返并追加 ERROR 级 AI_ASSIST_TRUNCATED", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({
      status: 200,
      payload: completionPayload(
        "## 模块：支付\n- 说明：支付与退款能力",
        "length",
      ),
    });
    const response = await postAssist(
      { mode: "IN_PROJECT", text: "很长的文档" },
      actor,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      markdown: string;
      issues: readonly { severity: string; code: string }[];
    };
    expect(body.markdown).toBe("## 模块：支付\n- 说明：支付与退款能力");
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      severity: "ERROR",
      code: "AI_ASSIST_TRUNCATED",
    });
  });
  test("匿名请求 401，且不调用上游", async () => {
    const before = upstreamRequestCount;
    const response = await postAssist({ mode: "IN_PROJECT", text: "文档" });
    expect(response.status).toBe(401);
    expect(upstreamRequestCount).toBe(before);
  });

  test("输入超限 422（不进入上游调用）", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const before = upstreamRequestCount;
    const response = await postAssist(
      { mode: "IN_PROJECT", text: "x".repeat(200_001) },
      actor,
    );
    expect(response.status).toBe(422);
    expect(upstreamRequestCount).toBe(before);
  });

  test("上游 429 映射 503 AI_ASSIST_UPSTREAM_FAILED（rate-limited）", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    stubResponder = () => ({ status: 429, payload: { error: "rate limited" } });
    const response = await postAssist(
      { mode: "IN_PROJECT", text: "文档" },
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
      { mode: "IN_PROJECT", text: "文档" },
      actor,
    );
    expect(response.status).toBe(503);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_UPSTREAM_FAILED");
    expect(error.details["reason"]).toBe("invalid-response");
  });
});

describe("assist fail closed（未启用 / 配置非法）", () => {
  test("未启用：503 AI_ASSIST_DISABLED 且不调用上游", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    await app?.close();
    app = undefined;
    delete process.env["AI_ASSIST_ENABLED"];
    await createApp();
    const before = upstreamRequestCount;
    const response = await postAssist(
      { mode: "IN_PROJECT", text: "文档" },
      actor,
    );
    expect(response.status).toBe(503);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_DISABLED");
    expect(upstreamRequestCount).toBe(before);
  });

  test("配置非法（缺少模型）：同样 fail closed 为 503 AI_ASSIST_DISABLED", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    await app?.close();
    app = undefined;
    process.env["AI_ASSIST_ENABLED"] = "1";
    delete process.env["AI_ASSIST_MODEL"];
    await createApp();
    const before = upstreamRequestCount;
    const response = await postAssist(
      { mode: "IN_PROJECT", text: "文档" },
      actor,
    );
    expect(response.status).toBe(503);
    const error = await readError(response);
    expect(error.code).toBe("AI_ASSIST_DISABLED");
    expect(upstreamRequestCount).toBe(before);
  });
});

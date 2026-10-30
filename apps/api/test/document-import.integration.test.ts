import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  projectDocumentImportPreviewResponseSchema,
  projectDocumentImportResultSchema,
} from "@inpulse/api-contract";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { errorResponseSchema } from "../../../packages/api-contract/src/contracts/error.zod.ts";
import { hashOpaqueToken } from "../src/auth/token.js";
import { documentDigest } from "../src/modules/document-import/document-template.parser.js";
import {
  connect,
  createProject,
  createUser,
  testUrls,
  type TestUrls,
} from "./database.helpers.js";

const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;
const PROJECT_IMPORTS_PATH = "/api/v1/project-imports";
const PROJECT_IMPORTS_PREVIEW_PATH = "/api/v1/project-imports/preview";

interface SessionActor {
  readonly userId: number;
  readonly loginName: string;
  readonly cookie: string;
  readonly csrf: string;
}

interface ErrorDto {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId: string;
}

let app: INestApplication | undefined;
let baseUrl = "";
let urls: TestUrls;
let runtime: Sql | undefined;
let auditReader: Sql | undefined;
let keyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sessionKey: Buffer;

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 30);
  auditReader = connect(urls.auditReader, 10);
  await migrate(urls.migrator);

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-doc-import-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
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

  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
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
async function loginOf(sql: Sql, userId: number): Promise<string> {
  const rows = (await sql`
    SELECT login_name FROM app.users WHERE id = ${userId}
  `) as unknown as readonly { login_name: string }[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`user fixture ${userId} does not exist`);
  }
  return row.login_name;
}

async function nameOf(sql: Sql, userId: number): Promise<string> {
  const rows = (await sql`
    SELECT name FROM app.users WHERE id = ${userId}
  `) as unknown as readonly { name: string }[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`user fixture ${userId} does not exist`);
  }
  return row.name;
}

async function sessionActor(sql: Sql, userId: number): Promise<SessionActor> {
  const users = (await sql`
    SELECT login_name, auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { login_name: string; authVersion: number }[];
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
    loginName: user.login_name,
    cookie: `${SESSION_COOKIE_NAME}=${cookieToken}`,
    csrf: csrfToken,
  };
}
interface PostInput {
  readonly path: string;
  readonly actor?: SessionActor;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly csrf?: boolean;
  readonly sameOrigin?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

async function post(input: PostInput): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (input.sameOrigin !== false) {
    headers["origin"] = baseUrl;
    headers["sec-fetch-site"] = "same-origin";
  }
  if (input.actor !== undefined) {
    headers["cookie"] = input.actor.cookie;
    if (input.csrf !== false) {
      headers["x-csrf-token"] = input.actor.csrf;
    }
  }
  if (input.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }
  if (input.extraHeaders !== undefined) {
    Object.assign(headers, input.extraHeaders);
  }
  return fetch(`${baseUrl}${input.path}`, {
    method: "POST",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

async function postDocument(
  path: string,
  actor: SessionActor,
  document: string,
  options: { readonly idempotencyKey?: string } = {},
): Promise<Response> {
  return post({
    path,
    actor,
    body: { document, expectedDigest: documentDigest(document) },
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
  });
}

async function expectError(
  response: Response,
  status: number,
  code?: string,
): Promise<ErrorDto> {
  expect(response.status).toBe(status);
  const parsed = errorResponseSchema.safeParse(await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("error response does not satisfy ErrorResponseSchema");
  }
  if (code !== undefined) {
    expect(parsed.data.code).toBe(code);
  }
  expect(JSON.stringify(parsed.data)).not.toMatch(
    /INSERT INTO|SELECT |stack|constraint_name/,
  );
  return parsed.data;
}

function codeFixture(): string {
  return `IMP_${randomUUID()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 10)
    .toUpperCase()}`;
}

async function importRunRows(
  sql: Sql,
  projectId: number,
): Promise<readonly { document_digest: string; module_count: number }[]> {
  return (await sql`
    SELECT document_digest, module_count
      FROM app.document_import_runs
     WHERE project_id = ${projectId}
     ORDER BY id ASC
  `) as unknown as readonly { document_digest: string; module_count: number }[];
}
describe("ADR-064 文档导入（真实 HTTP + PostgreSQL）", () => {
  test("整项目导入：单事务创建项目、成员与全部下级，负责人自动加入，重复导入 409", async () => {
    const sql = runtime!;
    const creator = await sessionActor(sql, await createUser(sql));
    const initialMemberId = await createUser(sql);
    const assigneeId = await createUser(sql);
    const initialMemberLogin = await loginOf(sql, initialMemberId);
    const assigneeLogin = await loginOf(sql, assigneeId);
    const projectCode = codeFixture();
    const projectName = `导入项目 ${randomUUID()}`;
    const document = [
      `# 项目：${projectName}`,
      `- 项目编码：${projectCode}`,
      "- 项目说明：来自固定模板",
      `- 项目成员：${creator.loginName}, ${initialMemberLogin}, ${assigneeLogin}`,
      "",
      "## 模块：支付",
      "- 说明：支付能力",
      "",
      "### 任务：修复重复回调",
      `- 负责人：${assigneeLogin}`,
      "- 优先级：高",
      "- 截止：2026-12-31",
      "- 描述：避免重复入账",
    ].join("\n");

    const idempotencyKey = randomUUID();
    const first = await postDocument(PROJECT_IMPORTS_PATH, creator, document, {
      idempotencyKey,
    });
    expect(first.status).toBe(200);
    const result = projectDocumentImportResultSchema.parse(await first.json());
    expect(result.projectCode).toBe(projectCode);
    expect(result.digest).toBe(documentDigest(document));
    expect(result.counts).toEqual({
      modules: 1,
      tasks: 1,
      reusedModules: 0,
      // ADR-073：创建者默认算项目成员，成员行数=创建者+项目成员+任务负责人。
      addedMembers: 3,
    });
    expect(result.modules).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);

    const projectId = result.projectId;
    const projects = (await sql`
      SELECT name, status, created_by
        FROM app.projects
       WHERE id = ${projectId}
    `) as unknown as readonly {
      name: string;
      status: string;
      created_by: number;
    }[];
    expect(projects).toEqual([
      { name: projectName, status: "NOT_STARTED", created_by: creator.userId },
    ]);

    const members = (await sql`
      SELECT user_id, status
        FROM app.project_members
       WHERE project_id = ${projectId}
       ORDER BY user_id ASC
    `) as unknown as readonly { user_id: number; status: string }[];
    const expectedMembers = [creator.userId, initialMemberId, assigneeId].sort(
      (left, right) => left - right,
    );
    expect(members.map((row) => row.user_id)).toEqual(expectedMembers);
    expect(members.every((row) => row.status === "ACTIVE")).toBe(true);

    const tasks = (await sql`
      SELECT id, title, priority, module_id
        FROM app.tasks
       WHERE project_id = ${projectId}
    `) as unknown as readonly {
      id: number;
      title: string;
      priority: string;
      module_id: number;
    }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "修复重复回调",
      priority: "HIGH",
      module_id: result.modules[0]!.id,
    });

    const taskAssignees = (await sql`
      SELECT user_id FROM app.task_assignees WHERE task_id = ${tasks[0]!.id}
    `) as unknown as readonly { user_id: number }[];
    expect(taskAssignees.map((row) => row.user_id)).toEqual([assigneeId]);
    const runs = await importRunRows(sql, projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.document_digest).toBe(documentDigest(document));

    const audits = (await auditReader!`
      SELECT action
        FROM app.audit_logs
       WHERE project_id = ${projectId}
         AND action = 'project.documentImport'
    `) as unknown as readonly { action: string }[];
    expect(audits).toHaveLength(1);

    const projectionTypes = (await sql`
      SELECT DISTINCT entity_type
        FROM app.search_projection
       WHERE project_id = ${projectId}
    `) as unknown as readonly { entity_type: string }[];
    expect(new Set(projectionTypes.map((row) => row.entity_type))).toEqual(
      new Set(["PROJECT", "MODULE", "TASK"]),
    );

    // 同摘要文档换幂等键再次导入：409 且不新增批次行。
    const duplicate = await postDocument(
      PROJECT_IMPORTS_PATH,
      creator,
      document,
    );
    const duplicateError = await expectError(
      duplicate,
      409,
      "DOCUMENT_IMPORT_DUPLICATE",
    );
    expect(duplicateError.details["projectId"]).toBe(projectId);
    expect(await importRunRows(sql, projectId)).toHaveLength(1);

    // 同一幂等键重放：返回同一结果且不重复创建。
    const replayed = await postDocument(
      PROJECT_IMPORTS_PATH,
      creator,
      document,
      { idempotencyKey },
    );
    expect(replayed.status).toBe(200);
    expect(
      projectDocumentImportResultSchema.parse(await replayed.json()),
    ).toEqual(result);
    expect(await importRunRows(sql, projectId)).toHaveLength(1);
    const taskCounts = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.tasks
       WHERE project_id = ${projectId}
    `) as unknown as readonly { count: number }[];
    expect(taskCounts[0]!.count).toBe(1);
  });
  test("整项目预览不写库；摘要不一致 409；编码被占用 canApply=false 且执行 409", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const memberId = await createUser(sql);
    const memberLogin = await loginOf(sql, memberId);
    const projectCode = codeFixture();
    const projectName = `预览项目 ${randomUUID()}`;
    const document = [
      `# 项目：${projectName}`,
      `- 项目编码：${projectCode}`,
      `- 项目成员：${actor.loginName}, ${memberLogin}`,
      "",
      "## 模块：账户",
    ].join("\n");

    const preview = await post({
      path: PROJECT_IMPORTS_PREVIEW_PATH,
      actor,
      body: { document },
      csrf: false,
    });
    expect(preview.status).toBe(200);
    const plan = projectDocumentImportPreviewResponseSchema.parse(
      await preview.json(),
    );
    expect(plan.digest).toBe(documentDigest(document));
    expect(plan.canApply).toBe(true);
    expect(plan.duplicate).toBeNull();
    expect(plan.project).toMatchObject({
      name: projectName,
      code: projectCode,
      codeAvailable: true,
    });
    // ADR-073：创建者默认就在名单里，预览也把 TA 排在第一位。
    expect(plan.project?.members.map((item) => item.userId)).toEqual([
      actor.userId,
      memberId,
    ]);
    expect(plan.summary).toMatchObject({
      moduleCount: 1,
      taskCount: 0,
      memberAddCount: 2,
    });
    expect(plan.issues).toEqual([]);

    const runsCount = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.document_import_runs
       WHERE document_digest = ${plan.digest}
    `) as unknown as readonly { count: number }[];
    expect(runsCount[0]!.count).toBe(0);
    const projectCount = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.projects
       WHERE code = ${projectCode}
    `) as unknown as readonly { count: number }[];
    expect(projectCount[0]!.count).toBe(0);

    const stale = await post({
      path: PROJECT_IMPORTS_PATH,
      actor,
      body: { document, expectedDigest: "f".repeat(64) },
      idempotencyKey: randomUUID(),
    });
    await expectError(stale, 409, "DOCUMENT_IMPORT_STALE");
    const afterStale = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.projects
       WHERE name = ${projectName}
    `) as unknown as readonly { count: number }[];
    expect(afterStale[0]!.count).toBe(0);

    // 项目创建触发器要求创建者必须有项目成员行（ADR-033）。
    await sql.begin(async (transaction) => {
      const occupantRows = (await transaction`
        INSERT INTO app.projects (code, name, created_by)
        VALUES (${projectCode}, ${`占用 ${randomUUID()}`}, ${actor.userId})
        RETURNING id
      `) as unknown as readonly { id: number }[];
      const occupant = occupantRows[0];
      if (occupant === undefined) {
        throw new Error("occupant project insert returned no row");
      }
      await transaction`
        INSERT INTO app.project_members (project_id, user_id, role)
        VALUES (${occupant.id}, ${actor.userId}, 'LEADER')
      `;
    });
    const conflictPreview = await post({
      path: PROJECT_IMPORTS_PREVIEW_PATH,
      actor,
      body: { document },
      csrf: false,
    });
    expect(conflictPreview.status).toBe(200);
    const conflictPlan = projectDocumentImportPreviewResponseSchema.parse(
      await conflictPreview.json(),
    );
    expect(conflictPlan.project?.codeAvailable).toBe(false);
    expect(conflictPlan.canApply).toBe(false);

    const conflict = await postDocument(PROJECT_IMPORTS_PATH, actor, document);
    await expectError(conflict, 409, "PROJECT_CODE_CONFLICT");
    const conflictRows = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.projects
       WHERE name = ${projectName}
    `) as unknown as readonly { count: number }[];
    expect(conflictRows[0]!.count).toBe(0);
    const conflictRuns = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.document_import_runs
       WHERE document_digest = ${documentDigest(document)}
    `) as unknown as readonly { count: number }[];
    expect(conflictRuns[0]!.count).toBe(0);
  });
  test("整项目导入：负责人未解析 422 且零残留；缺编码 422；匿名 401", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const projectCode = codeFixture();
    const projectName = `未解析 ${randomUUID()}`;
    const document = [
      `# 项目：${projectName}`,
      `- 项目编码：${projectCode}`,
      "",
      "## 模块：结算",
      "### 任务：对账",
      "- 负责人：ghost_user_never_exists",
    ].join("\n");

    const failure = await postDocument(PROJECT_IMPORTS_PATH, actor, document);
    const failureError = await expectError(
      failure,
      422,
      "DOCUMENT_IMPORT_INVALID",
    );
    const issues = failureError.details["issues"] as readonly {
      readonly code: string;
    }[];
    expect(issues.some((issue) => issue.code === "ASSIGNEE_UNRESOLVED")).toBe(
      true,
    );
    // ADR-072：这份文档根本没写项目成员，必填缺失在同一个 422 里一次说清。
    expect(issues.some((issue) => issue.code === "MEMBER_REQUIRED")).toBe(true);
    const projects = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.projects
       WHERE code = ${projectCode}
    `) as unknown as readonly { count: number }[];
    expect(projects[0]!.count).toBe(0);

    const missingCodeDocument = [
      `# 项目：缺编码 ${randomUUID()}`,
      "",
      "## 模块：账户",
    ].join("\n");
    const missingCode = await post({
      path: PROJECT_IMPORTS_PREVIEW_PATH,
      actor,
      body: { document: missingCodeDocument },
      csrf: false,
    });
    const missingCodeError = await expectError(
      missingCode,
      422,
      "DOCUMENT_IMPORT_INVALID",
    );
    const missingCodeIssues = missingCodeError.details["issues"] as readonly {
      readonly code: string;
    }[];
    expect(
      missingCodeIssues.some((issue) => issue.code === "PROJECT_CODE_REQUIRED"),
    ).toBe(true);

    // 写路由的契约头要求格式合法的 CSRF Token；匿名时缺失会先被契约层 422 拒绝。
    const anonymous = await post({
      path: PROJECT_IMPORTS_PATH,
      body: { document, expectedDigest: documentDigest(document) },
      idempotencyKey: randomUUID(),
      extraHeaders: { "x-csrf-token": "a".repeat(43) },
    });
    await expectError(anonymous, 401, "DOCUMENT_IMPORT_SESSION_REQUIRED");

    const anonymousPreview = await post({
      path: PROJECT_IMPORTS_PREVIEW_PATH,
      body: { document },
      csrf: false,
    });
    await expectError(
      anonymousPreview,
      401,
      "DOCUMENT_IMPORT_SESSION_REQUIRED",
    );
  });
  test("整项目导入：项目成员必填且必须含全部负责人；创建者由系统默认补进成员", async () => {
    const sql = runtime!;
    const actor = await sessionActor(sql, await createUser(sql));
    const assigneeId = await createUser(sql);
    const assigneeLogin = await loginOf(sql, assigneeId);
    const assigneeName = await nameOf(sql, assigneeId);
    const projectCode = codeFixture();
    const projectName = `成员校验 ${randomUUID()}`;
    const documentWith = (members: string): string =>
      [
        `# 项目：${projectName}`,
        `- 项目编码：${projectCode}`,
        `- 项目成员：${members}`,
        "",
        "## 模块：结算",
        "### 任务：对账",
        `- 负责人：${assigneeLogin}`,
      ].join("\n");
    const issueCodes = (error: ErrorDto): readonly string[] =>
      (error.details["issues"] as readonly { readonly code: string }[]).map(
        (issue) => issue.code,
      );
    const previewOf = (document: string): Promise<Response> =>
      post({
        path: PROJECT_IMPORTS_PREVIEW_PATH,
        actor,
        body: { document },
        csrf: false,
      });

    // ADR-073：名单只写负责人、不写创建者本人（服务端兜底：写不写都放行）；
    // AI 生成口径见 ai-assist.prompt.ts：草稿必须写出创建者。
    const noCreator = await previewOf(documentWith(assigneeLogin));
    expect(noCreator.status).toBe(200);
    const noCreatorPlan = projectDocumentImportPreviewResponseSchema.parse(
      await noCreator.json(),
    );
    expect(noCreatorPlan.issues).toEqual([]);
    expect(noCreatorPlan.canApply).toBe(true);
    expect(noCreatorPlan.project?.members.map((item) => item.userId)).toEqual([
      actor.userId,
      assigneeId,
    ]);
    expect(noCreatorPlan.summary.memberAddCount).toBe(2);

    // 名单写登录名、负责人写姓名：同一个人按解析后的账号判，不按字面判，也不会重复计入。
    const mixed = await previewOf(
      documentWith(`${actor.loginName}, ${assigneeName}`),
    );
    expect(mixed.status).toBe(200);
    const plan = projectDocumentImportPreviewResponseSchema.parse(
      await mixed.json(),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.canApply).toBe(true);
    expect(plan.project?.members.map((item) => item.userId)).toEqual([
      actor.userId,
      assigneeId,
    ]);

    // 名单里只有创建者本人：任务负责人没写进名单 → 仍然是 422。
    const noAssignee = await expectError(
      await previewOf(documentWith(actor.loginName)),
      422,
      "DOCUMENT_IMPORT_INVALID",
    );
    expect(issueCodes(noAssignee)).toContain("ASSIGNEE_NOT_INITIAL_MEMBER");
    // ADR-073：删掉了「名单必须含创建者」这条，错误码不再出现。
    expect(issueCodes(noAssignee)).not.toContain("MEMBER_CREATOR_MISSING");

    // 全是纯预览：项目不落库。
    const projects = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.projects
       WHERE code = ${projectCode}
    `) as unknown as readonly { count: number }[];
    expect(projects[0]!.count).toBe(0);
  });
  test("项目内导入：同名模块复用且不覆盖，警告不阻断，任务直接归属模块", async () => {
    const sql = runtime!;
    const creator = await sessionActor(sql, await createUser(sql));
    const memberId = await createUser(sql);
    const memberLogin = await loginOf(sql, memberId);
    const project = await createProject(sql, creator.userId);
    await sql`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${project.projectId}, ${memberId}, 'MEMBER')
    `;

    const firstDocument = [
      "## 模块：支付",
      "- 说明：既有说明",
      "",
      "### 任务：修复重复回调",
      `- 负责人：${memberLogin}`,
    ].join("\n");
    const first = await postDocument(
      `/api/v1/projects/${project.projectId}/document-imports`,
      creator,
      firstDocument,
    );
    expect(first.status).toBe(200);
    const firstResult = projectDocumentImportResultSchema.parse(
      await first.json(),
    );
    expect(firstResult.counts).toEqual({
      modules: 1,
      tasks: 1,
      reusedModules: 0,
      addedMembers: 0,
    });

    const secondDocument = [
      "## 模块：支付",
      "- 说明：文档里的新说明（不应覆盖）",
    ].join("\n");
    const secondPreview = await post({
      path: `/api/v1/projects/${project.projectId}/document-imports/preview`,
      actor: creator,
      body: { document: secondDocument },
      csrf: false,
    });
    expect(secondPreview.status).toBe(200);
    const secondPlan = projectDocumentImportPreviewResponseSchema.parse(
      await secondPreview.json(),
    );
    expect(secondPlan.modules.map((item) => item.action)).toEqual(["REUSE"]);
    expect(secondPlan.canApply).toBe(true);
    const warningCodes = secondPlan.issues.map((issue) => issue.code);
    expect(warningCodes).toContain("MODULE_REUSE_DIFFERS");

    const second = await postDocument(
      `/api/v1/projects/${project.projectId}/document-imports`,
      creator,
      secondDocument,
    );
    expect(second.status).toBe(200);
    const secondResult = projectDocumentImportResultSchema.parse(
      await second.json(),
    );
    expect(secondResult.counts).toEqual({
      modules: 0,
      tasks: 0,
      reusedModules: 1,
      addedMembers: 0,
    });
    expect(secondResult.modules[0]!.id).toBe(firstResult.modules[0]!.id);

    const modules = (await sql`
      SELECT description
        FROM app.modules
       WHERE id = ${firstResult.modules[0]!.id}
    `) as unknown as readonly { description: string }[];
    expect(modules[0]!.description).toBe("既有说明");
    const thirdDocument = [
      "## 模块：支付",
      "",
      "### 任务：归档旧回调",
      `- 负责人：${memberLogin}`,
    ].join("\n");
    const third = await postDocument(
      `/api/v1/projects/${project.projectId}/document-imports`,
      creator,
      thirdDocument,
    );
    expect(third.status).toBe(200);
    const thirdResult = projectDocumentImportResultSchema.parse(
      await third.json(),
    );
    expect(thirdResult.counts).toEqual({
      modules: 0,
      tasks: 1,
      reusedModules: 1,
      addedMembers: 0,
    });
    const importedTasks = (await sql`
      SELECT module_id
        FROM app.tasks
       WHERE id = ${thirdResult.tasks[0]!.id}
    `) as unknown as readonly { module_id: number }[];
    expect(importedTasks).toEqual([{ module_id: firstResult.modules[0]!.id }]);

    const auditRows = (await auditReader!`
      SELECT count(*)::int AS "count"
        FROM app.audit_logs
       WHERE project_id = ${project.projectId}
         AND action = 'project.documentImport'
    `) as unknown as readonly { count: number }[];
    expect(auditRows[0]!.count).toBe(3);
  });
  test("项目内导入：项目段 422；负责人非成员 422 零残留；非成员 404", async () => {
    const sql = runtime!;
    const creator = await sessionActor(sql, await createUser(sql));
    const outsider = await sessionActor(sql, await createUser(sql));
    const strangerId = await createUser(sql);
    const project = await createProject(sql, creator.userId);

    const withProjectSection = [
      `# 项目：不该出现 ${randomUUID()}`,
      "- 项目编码：SHOULD_NOT_APPLY",
      "",
      "## 模块：支付",
    ].join("\n");
    const rejected = await postDocument(
      `/api/v1/projects/${project.projectId}/document-imports`,
      creator,
      withProjectSection,
    );
    const rejectedError = await expectError(
      rejected,
      422,
      "DOCUMENT_IMPORT_INVALID",
    );
    const rejectedIssues = rejectedError.details["issues"] as readonly {
      readonly code: string;
    }[];
    expect(
      rejectedIssues.some(
        (issue) => issue.code === "PROJECT_SECTION_NOT_ALLOWED",
      ),
    ).toBe(true);

    const strangerLogin = await loginOf(sql, strangerId);
    const assigneeDocument = [
      "## 模块：订单",
      "",
      "### 任务：修复下单超时",
      `- 负责人：${strangerLogin}`,
    ].join("\n");
    const assigneeFailure = await postDocument(
      `/api/v1/projects/${project.projectId}/document-imports`,
      creator,
      assigneeDocument,
    );
    const assigneeError = await expectError(
      assigneeFailure,
      422,
      "DOCUMENT_IMPORT_INVALID",
    );
    const assigneeIssues = assigneeError.details["issues"] as readonly {
      readonly code: string;
    }[];
    expect(
      assigneeIssues.some((issue) => issue.code === "ASSIGNEE_NOT_MEMBER"),
    ).toBe(true);
    const createdModules = (await sql`
      SELECT count(*)::int AS "count"
        FROM app.modules
       WHERE project_id = ${project.projectId}
         AND name = '订单'
    `) as unknown as readonly { count: number }[];
    expect(createdModules[0]!.count).toBe(0);

    await expectError(
      await postDocument(
        `/api/v1/projects/${project.projectId}/document-imports`,
        outsider,
        assigneeDocument,
      ),
      404,
      "PROJECT_NOT_FOUND",
    );
    await expectError(
      await post({
        path: `/api/v1/projects/${project.projectId}/document-imports/preview`,
        actor: outsider,
        body: { document: assigneeDocument },
        csrf: false,
      }),
      404,
      "PROJECT_NOT_FOUND",
    );
  });
});

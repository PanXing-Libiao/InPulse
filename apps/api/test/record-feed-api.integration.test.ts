import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { normalizeSearchText } from "../../../database/poc/search/normalize.ts";
import { migrate } from "../../../database/src/migrate.ts";
import {
  myRecordDraftPageSchema,
  recordFeedPageSchema,
} from "../../../packages/api-contract/src/index.ts";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { generateOpaqueToken, hashOpaqueToken } from "../src/auth/token.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

// B-3b 跨项目记录读（F-18 / F-19 跨项目扩展）的真实 HTTP 集成测试：
// GET /api/v1/change-records 的跨项目可见性、status 收敛（非管理员看不到 VOID）、
// 来源筛选、q 全文检索、签名游标绑定与跨筛选拒绝、名称回填；
// GET /api/v1/me/record-drafts 的作者恒为当前 actor、跨项目草稿与项目范围收敛。
// 全部在真实 PostgreSQL（含 PGroonga）上验证，不使用 mock。

const SESSION_COOKIE_NAME = "__Host-session";
const HMAC_KEY_VERSION = 1;

interface ErrorResponseDto {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

interface FeedItemBody {
  readonly record: {
    readonly id: number;
    readonly projectId: number;
    readonly status: "PUBLISHED" | "VOID";
    readonly title: string;
  };
  readonly projectName: string;
  readonly moduleName: string;
  readonly author: { readonly userId: number; readonly name: string };
}

interface PageBody {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

let app: INestApplication | undefined;
let baseUrl: string;
let runtime: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let keyringDirectory: string | undefined;
let idempotencyKeyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sequence = 0;

const baseMs = Date.now();
// 检索夹具每轮使用唯一关键词，避免共享测试库里历史夹具影响断言。
const searchKeyword = "命中关键词" + randomBytes(4).toString("hex");

function isoAt(minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

let projectA: ProjectFixture | undefined;
let projectB: ProjectFixture | undefined;
let projectC: ProjectFixture | undefined;
let memberUser = 0;
let outsiderUser = 0;
let adminUser = 0;
let memberCookie = "";
let outsiderCookie = "";
let adminCookie = "";

let tMain = 0;
let tSource = 0;

let rModule = 0;
let rModuleB = 0;
let rMain = 0;
let rSource = 0;
let rVoid = 0;
let rOther = 0;
let rForeign = 0;

let dA = 0;
let dB = 0;
let dOutsider = 0;
let dForeign = 0;

const taskWrites = new TaskManagementRepository();
const draftWrites = new RecordDraftRepository();

const recordContent = {
  title: "B-3b 跨项目记录夹具",
  contextProblem: "上下文问题",
  changeSolution: "变更方案",
  resultVerification: "验证结果",
  remainingIssues: [],
};

function nextSuffix(kind: "T" | "CR"): string {
  sequence += 1;
  return "-" + kind + "-" + String(sequence);
}

async function newTask(scope: ProjectFixture, title: string): Promise<number> {
  return uow!.run(async (tx) => {
    const created = await taskWrites.create(
      tx,
      { projectId: scope.projectId, moduleId: scope.moduleId },
      scope.userId,
      scope.code + nextSuffix("T"),
      {
        title,
        description: "",
        assigneeIds: [scope.userId],
        priority: "NORMAL",
        dueAt: null,
      },
    );
    return created.id;
  });
}

interface RecordOptions {
  readonly taskId?: number | null;
  readonly publishedAt?: string;
  readonly status?: "PUBLISHED" | "VOID";
  readonly authorId?: number;
}

async function newPublishedRecord(
  scope: ProjectFixture,
  options: RecordOptions = {},
): Promise<number> {
  const code = scope.code + nextSuffix("CR");
  const taskId = options.taskId ?? null;
  const publishedAt = options.publishedAt ?? null;
  const authorId = options.authorId ?? scope.userId;
  const draft = await uow!.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
      },
      authorId,
      recordContent,
      taskId === null ? undefined : { taskId, handlerId: scope.userId },
    ),
  );
  await uow!.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by) SELECT id, project_id, 1, title, current_payload, ${authorId} FROM app.change_records WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    await tx.sql`UPDATE app.change_records SET status = ${"PUBLISHED"}, code = ${code}, current_version = 1, published_at = COALESCE(${publishedAt}::timestamptz, clock_timestamp()), row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    if (options.status === "VOID") {
      await tx.sql`UPDATE app.change_records SET status = ${"VOID"}, voided_at = GREATEST(clock_timestamp(), published_at), void_reason = ${"B-3b 夹具作废"}, row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    }
  });
  return draft.id;
}

async function newDraft(
  scope: ProjectFixture,
  actorId: number,
): Promise<number> {
  const draft = await uow!.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
      },
      actorId,
      recordContent,
    ),
  );
  return draft.id;
}

/** ACTIVE 聚合组：主任务 + 活动来源任务（SOURCE 记录判定的唯一真相）。 */
async function seedActiveGroup(
  scope: ProjectFixture,
  mainTaskId: number,
  sourceTaskId: number,
): Promise<number> {
  return uow!.run(async (tx) => {
    const [group] = await tx.sql<{ id: number }[]>`
      INSERT INTO app.task_groups (project_id, code, name, created_by, status)
      VALUES (${scope.projectId}, ${scope.code + "-TG-1"}, ${"B-3b 记录清单夹具组"}, ${scope.userId}, ${"ACTIVE"})
      RETURNING id
    `;
    if (!group) throw new Error("task group fixture insert returned no row");
    await tx.sql`INSERT INTO app.task_group_members (group_id, task_id, project_id, role, status, joined_at) VALUES (${group.id}, ${mainTaskId}, ${scope.projectId}, ${"MAIN"}, ${"ACTIVE"}, clock_timestamp())`;
    await tx.sql`INSERT INTO app.task_group_members (group_id, task_id, project_id, role, source_kind, original_work_status, original_assignee_id, status, joined_at) VALUES (${group.id}, ${sourceTaskId}, ${scope.projectId}, ${"SOURCE"}, ${"ACTIVE"}, ${"DONE"}, ${scope.userId}, ${"ACTIVE"}, clock_timestamp())`;
    return group.id;
  });
}

async function seedRecordSearch(
  scope: ProjectFixture,
  recordId: number,
  text: string,
  visibility: "MEMBER" | "ADMIN_ONLY" = "MEMBER",
): Promise<void> {
  const normalized = normalizeSearchText(text);
  await runtime!.sql`
    INSERT INTO app.search_projection (
      project_id, entity_type, entity_id, title, summary, raw_text,
      normalized_search_text, visibility_scope, source_status, source_row_version
    )
    VALUES (
      ${scope.projectId}, 'CHANGE_RECORD', ${recordId}, ${text}, '', ${text},
      ${normalized}, ${visibility}, ${visibility === "MEMBER" ? "PUBLISHED" : "VOID"}, 1
    )
  `;
}

async function getJson(
  path: string,
  cookie?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers["cookie"] = cookie;
  }
  const response = await fetch(baseUrl + path, { headers });
  const text = await response.text();
  const body: unknown = text.length === 0 ? null : JSON.parse(text);
  return { status: response.status, body };
}

async function expectError(
  path: string,
  cookie: string | undefined,
  status: number,
  code: string,
): Promise<void> {
  const response = await getJson(path, cookie);
  expect(response.status).toBe(status);
  const body = response.body as ErrorResponseDto;
  expect(body.code).toBe(code);
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.requestId).toBeTypeOf("string");
}

async function feed(query: string, cookie = memberCookie): Promise<PageBody> {
  const response = await getJson("/api/v1/change-records" + query, cookie);
  expect(response.status).toBe(200);
  return recordFeedPageSchema.parse(response.body);
}

async function drafts(query: string, cookie = memberCookie): Promise<PageBody> {
  const response = await getJson("/api/v1/me/record-drafts" + query, cookie);
  expect(response.status).toBe(200);
  return myRecordDraftPageSchema.parse(response.body);
}

function recordIds(page: PageBody): number[] {
  return (page.items as readonly FeedItemBody[]).map((item) => item.record.id);
}

function draftIds(page: PageBody): number[] {
  return (page.items as readonly { draft: { id: number } }[]).map(
    (item) => item.draft.id,
  );
}

async function createAuthenticatedSession(
  sql: Sql,
  keyring: VersionedHmacKeyring,
  userId: number,
): Promise<{ readonly cookie: string }> {
  const rows = (await sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { authVersion: number }[];
  const user = rows[0];
  if (user === undefined) {
    throw new Error("user fixture missing");
  }
  const token = generateOpaqueToken();
  await sql`
    INSERT INTO app.user_sessions (
      user_id, token_hash, token_hash_key_version, auth_version_at_issue,
      auth_state, recovery_rotation_generation, recovery_rotation_consumed_generation,
      created_at, last_seen_at, idle_expires_at, absolute_expires_at
    )
    VALUES (
      ${userId}, ${hashOpaqueToken(token, keyring.currentKey())}, ${HMAC_KEY_VERSION},
      ${user.authVersion}, ${"AUTHENTICATED"}, 0, 0, now(), now(),
      now() + ${"1 hour"}::interval, now() + ${"1 day"}::interval
    )
  `;
  return { cookie: SESSION_COOKIE_NAME + "=" + token };
}

beforeAll(async () => {
  const urls = testUrls();
  runtime = createDatabaseClient(urls.runtime, {
    applicationName: "inpulse-record-feed-api-test",
  });
  await migrate(urls.migrator);
  uow = new PostgresUnitOfWork(runtime);

  memberUser = await createUser(runtime.sql);
  outsiderUser = await createUser(runtime.sql);
  adminUser = await createUser(runtime.sql, { admin: true });
  const fixtureA = await createProject(runtime.sql, memberUser);
  projectA = fixtureA;
  const fixtureB = await createProject(runtime.sql, memberUser);
  projectB = fixtureB;
  const fixtureC = await createProject(runtime.sql, outsiderUser);
  projectC = fixtureC;

  tMain = await newTask(fixtureA, "记录清单主任务");
  tSource = await newTask(fixtureA, "记录清单来源任务");
  await seedActiveGroup(fixtureA, tMain, tSource);

  rModule = await newPublishedRecord(fixtureA, { publishedAt: isoAt(1) });
  rModuleB = await newPublishedRecord(fixtureA, {
    publishedAt: isoAt(2),
  });
  rMain = await newPublishedRecord(fixtureA, {
    taskId: tMain,
    publishedAt: isoAt(3),
  });
  rSource = await newPublishedRecord(fixtureA, {
    taskId: tSource,
    publishedAt: isoAt(4),
  });
  rVoid = await newPublishedRecord(fixtureA, {
    publishedAt: isoAt(5),
    status: "VOID",
  });
  rOther = await newPublishedRecord(fixtureB, { publishedAt: isoAt(6) });
  rForeign = await newPublishedRecord(fixtureC, { publishedAt: isoAt(7) });

  await seedRecordSearch(fixtureA, rModuleB, searchKeyword + " 模块级记录乙");
  await seedRecordSearch(
    fixtureA,
    rVoid,
    searchKeyword + " 作废记录",
    "ADMIN_ONLY",
  );
  await seedRecordSearch(fixtureB, rOther, searchKeyword + " 跨项目记录");

  dA = await newDraft(fixtureA, memberUser);
  dB = await newDraft(fixtureB, memberUser);
  dOutsider = await newDraft(fixtureC, outsiderUser);
  dForeign = await newDraft(fixtureA, outsiderUser);

  const sessionKey = randomBytes(32);
  const sessionKeyring = VersionedHmacKeyring.fromEntries(
    [{ key: sessionKey, version: 1 }],
    1,
  );
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-record-feed-"));
  const sessionKeyringFile = join(keyringDirectory, "session.keyring");
  await writeFile(
    sessionKeyringFile,
    "1:" + sessionKey.toString("hex") + String.fromCharCode(10),
    "utf8",
  );
  memberCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, memberUser)
  ).cookie;
  outsiderCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, outsiderUser)
  ).cookie;
  adminCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, adminUser)
  ).cookie;

  idempotencyKeyringDirectory = await mkdtemp(
    join(tmpdir(), "inpulse-record-feed-idempotency-"),
  );
  const idempotencyKeyringFile = join(
    idempotencyKeyringDirectory,
    "fingerprint.keyring",
  );
  await writeFile(
    idempotencyKeyringFile,
    "1:" + randomBytes(32).toString("hex") + String.fromCharCode(10),
    "utf8",
  );

  previousEnvironment = {
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
  process.env["SESSION_HASH_KEYRING_FILE"] = sessionKeyringFile;
  process.env["SESSION_HASH_KEYRING_TEST_PATH"] = "1";
  process.env["SESSION_HASH_KEY_VERSION"] = String(HMAC_KEY_VERSION);
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_FILE"] = idempotencyKeyringFile;
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH"] = "1";
  process.env["IDEMPOTENCY_FINGERPRINT_KEY_VERSION"] = String(HMAC_KEY_VERSION);

  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = "http://127.0.0.1:" + String(address.port);
});

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (keyringDirectory !== undefined) {
    await rm(keyringDirectory, { force: true, recursive: true });
  }
  if (idempotencyKeyringDirectory !== undefined) {
    await rm(idempotencyKeyringDirectory, { force: true, recursive: true });
  }
});

describe("GET /api/v1/change-records（B-3b 跨项目记录清单）", () => {
  test("匿名 401，limit / q / status 越界返回 422", async () => {
    await expectError(
      "/api/v1/change-records",
      undefined,
      401,
      "RECORD_FEED_UNAUTHENTICATED",
    );
    await expectError(
      "/api/v1/me/record-drafts",
      undefined,
      401,
      "MY_RECORD_DRAFTS_UNAUTHENTICATED",
    );
    await expectError(
      "/api/v1/change-records?limit=101",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/change-records?q=" + "x".repeat(201),
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/change-records?status=OTHER",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("默认只返回成员项目的 PUBLISHED 记录并回填名称", async () => {
    const page = await feed("");
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(recordIds(page)).toEqual([
      rOther,
      rSource,
      rMain,
      rModuleB,
      rModule,
    ]);

    const items = page.items as readonly FeedItemBody[];
    const other = items[0]!;
    expect(other.record.projectId).toBe(projectB!.projectId);
    expect(other.projectName).toBe("Project " + projectB!.code);
    expect(other.moduleName).toBe("未分类");
    expect(other.author.name).toContain("Test user_");
    expect(other.record.status).toBe("PUBLISHED");
    expect("voidedAt" in other.record).toBe(false);

    const moduleBItem = items.find(
      (item) => item.record.id === rModuleB,
    ) as FeedItemBody;
    expect(moduleBItem.moduleName).toBe("未分类");
  });

  test("非成员项目收敛为空页，projectId 只用于收窄授权范围", async () => {
    const narrowed = await feed("?projectId=" + String(projectB!.projectId));
    expect(recordIds(narrowed)).toEqual([rOther]);

    const foreign = await feed("?projectId=" + String(projectC!.projectId));
    expect(foreign.items).toEqual([]);
    expect(foreign.hasMore).toBe(false);

    const outsider = await feed("", outsiderCookie);
    expect(recordIds(outsider)).toEqual([rForeign]);
  });

  test("非管理员请求 VOID / ALL 收敛为 PUBLISHED，管理员可读作废行", async () => {
    const memberVoid = await feed("?status=VOID");
    expect(recordIds(memberVoid)).toEqual([
      rOther,
      rSource,
      rMain,
      rModuleB,
      rModule,
    ]);

    const memberAll = await feed("?status=ALL");
    expect(recordIds(memberAll)).toEqual([
      rOther,
      rSource,
      rMain,
      rModuleB,
      rModule,
    ]);

    // 管理员默认范围是全部项目；共享测试库里存在其他夹具，因此先按包含关系断言，
    // 再用 projectId 收窄后做精确顺序断言。
    const adminDefault = await feed("", adminCookie);
    expect(recordIds(adminDefault)).toContain(rForeign);
    expect(recordIds(adminDefault)).toContain(rOther);
    expect(recordIds(adminDefault)).not.toContain(rVoid);

    const adminProjectA = await feed(
      "?projectId=" + String(projectA!.projectId),
      adminCookie,
    );
    expect(recordIds(adminProjectA)).toEqual([
      rSource,
      rMain,
      rModuleB,
      rModule,
    ]);

    const adminVoid = await feed(
      "?projectId=" + String(projectA!.projectId) + "&status=VOID",
      adminCookie,
    );
    expect(recordIds(adminVoid)).toEqual([rVoid]);
    const voidedItem = (adminVoid.items as readonly FeedItemBody[])[0]!;
    expect(voidedItem.record.status).toBe("VOID");
    expect("voidReason" in voidedItem.record).toBe(true);

    const adminAll = await feed(
      "?projectId=" + String(projectA!.projectId) + "&status=ALL",
      adminCookie,
    );
    expect(recordIds(adminAll)).toEqual([
      rVoid,
      rSource,
      rMain,
      rModuleB,
      rModule,
    ]);

    const adminForeignAll = await feed(
      "?projectId=" + String(projectC!.projectId) + "&status=ALL",
      adminCookie,
    );
    expect(recordIds(adminForeignAll)).toEqual([rForeign]);
  });

  test("来源筛选区分主任务 / 来源任务 / 模块级记录", async () => {
    expect(recordIds(await feed("?source=MAIN"))).toEqual([rMain]);
    expect(recordIds(await feed("?source=SOURCE"))).toEqual([rSource]);
    expect(recordIds(await feed("?source=MODULE"))).toEqual([
      rOther,
      rModuleB,
      rModule,
    ]);
    expect(recordIds(await feed("?source=ALL"))).toEqual([
      rOther,
      rSource,
      rMain,
      rModuleB,
      rModule,
    ]);
  });

  test("q 复用全文投影：跨项目命中、作废投影只对管理员可见、无匹配为空页", async () => {
    const query = encodeURIComponent(searchKeyword);
    const memberPage = await feed("?q=" + query);
    expect(recordIds(memberPage)).toEqual([rOther, rModuleB]);

    const adminPage = await feed("?q=" + query + "&status=ALL", adminCookie);
    expect(recordIds(adminPage)).toEqual([rOther, rVoid, rModuleB]);

    const empty = await feed("?q=" + encodeURIComponent("没有这个关键词"));
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);

    await expectError(
      "/api/v1/change-records?q=" + encodeURIComponent("   "),
      memberCookie,
      422,
      "INVALID_RECORD_FEED_QUERY",
    );
  });

  test("keyset 分页稳定，游标不得跨筛选或跨接口复用", async () => {
    const first = await feed("?limit=2");
    expect(recordIds(first)).toEqual([rOther, rSource]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await feed(
      "?limit=2&cursor=" + encodeURIComponent(first.nextCursor as string),
    );
    expect(recordIds(second)).toEqual([rMain, rModuleB]);
    expect(second.hasMore).toBe(true);

    const third = await feed(
      "?limit=2&cursor=" + encodeURIComponent(second.nextCursor as string),
    );
    expect(recordIds(third)).toEqual([rModule]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    await expectError(
      "/api/v1/change-records?limit=2&source=MODULE&cursor=" +
        encodeURIComponent(first.nextCursor as string),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/change-records?cursor=" + encodeURIComponent("not-a-cursor"),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );

    const draftsPage = await drafts("?limit=1");
    expect(draftsPage.hasMore).toBe(true);
    await expectError(
      "/api/v1/change-records?cursor=" +
        encodeURIComponent(draftsPage.nextCursor as string),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
  });
});

describe("GET /api/v1/me/record-drafts（B-3b 我的草稿）", () => {
  test("只返回当前 actor 的草稿：跨项目、名称回填、他人草稿不可见", async () => {
    const page = await drafts("");
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(new Set(draftIds(page))).toEqual(new Set([dA, dB]));
    expect(draftIds(page)).not.toContain(dForeign);

    const items = page.items as readonly {
      readonly draft: { readonly id: number; readonly projectId: number };
      readonly projectName: string;
      readonly moduleName: string;
    }[];
    expect(items.map((item) => item.projectName).sort()).toEqual(
      ["Project " + projectA!.code, "Project " + projectB!.code].sort(),
    );
    expect(items.every((item) => item.moduleName === "未分类")).toBe(true);

    const outsiderPage = await drafts("", outsiderCookie);
    expect(draftIds(outsiderPage)).toEqual([dOutsider]);
  });

  test("keyset 分页与游标绑定：跨 actor 复用被拒绝", async () => {
    const first = await drafts("?limit=1");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await drafts(
      "?limit=1&cursor=" + encodeURIComponent(first.nextCursor as string),
    );
    expect(second.hasMore).toBe(false);

    const firstIds = draftIds(first);
    const secondIds = draftIds(second);
    expect(firstIds).not.toEqual(secondIds);
    expect(new Set([...firstIds, ...secondIds])).toEqual(new Set([dA, dB]));

    await expectError(
      "/api/v1/me/record-drafts?limit=1&cursor=" +
        encodeURIComponent(first.nextCursor as string),
      outsiderCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/me/record-drafts?limit=101",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("被移出项目后该作者的草稿立即不再返回", async () => {
    expect(draftIds(await drafts("", outsiderCookie))).toEqual([dOutsider]);

    const memberDrafts = await drafts("");
    expect(draftIds(memberDrafts)).not.toContain(dForeign);

    await removeMember(runtime!.sql, projectC!.projectId, outsiderUser);
    const afterRemoval = await drafts("", outsiderCookie);
    expect(afterRemoval.items).toEqual([]);
    expect(afterRemoval.hasMore).toBe(false);
  });
});

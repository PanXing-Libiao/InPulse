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

import { migrate } from "../../../database/src/migrate.ts";
import {
  AGGREGATE_READ_CURSOR_MAX_LENGTH,
  myTaskPageSchema,
  projectOverviewResponseSchema,
  taskGroupDetailResponseSchema,
  taskGroupRecordPageSchema,
} from "../../../packages/api-contract/src/index.ts";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { generateOpaqueToken, hashOpaqueToken } from "../src/auth/token.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

// F-25 / F-29 / F-32 聚合读四条路由的真实 HTTP 集成测试（A 裁决 §2、§3、§7）：
// 授权、404 / 422 语义、统计口径（功能设计 §29.1 / §29.3 / §29.4）与先过滤后分页
// 全部在真实 PostgreSQL 上验证，不使用 mock；模块级任务与版本不增加计数在
// R-2 / R-1 断言中显式覆盖。

const SESSION_COOKIE_NAME = "__Host-session";
const HMAC_KEY_VERSION = 1;

interface ErrorResponseDto {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

let app: INestApplication | undefined;
let baseUrl: string;
let runtime: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let sessionKeyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sequence = 0;

let project: ProjectFixture | undefined;
let otherProject: ProjectFixture | undefined;
let memberUser = 0;
let otherUser = 0;
let outsiderUser = 0;
let secondMemberUser = 0;
let memberCookie = "";
let otherCookie = "";
let outsiderCookie = "";
let groupId = 0;

let tMain = 0;
let tSource = 0;
let tHistorical = 0;
let tDetached = 0;
let tModule = 0;
let tDone = 0;
let tCanceled = 0;
let tInvalid = 0;

let crMain = 0;
let crModule = 0;
let crSource = 0;
let crVoid = 0;
let crHistorical = 0;
let crDraft = 0;
let crPaged: readonly number[] = [];

const taskWrites = new TaskManagementRepository();
const draftWrites = new RecordDraftRepository();

const recordContent = {
  title: "聚合读接口记录",
  contextProblem: "上下文问题",
  changeSolution: "变更方案",
  resultVerification: "验证结果",
  remainingIssues: [],
};

function nextSuffix(kind: "T" | "CR"): string {
  sequence += 1;
  return "-" + kind + "-" + String(sequence);
}

async function newModule(scope: ProjectFixture, name: string): Promise<number> {
  const [row] = await runtime!.sql<{ id: number }[]>`
    INSERT INTO app.modules (project_id, name, created_by)
    VALUES (${scope.projectId}, ${name}, ${scope.userId})
    RETURNING id
  `;
  if (!row) throw new Error("module fixture insert returned no row");
  return row.id;
}

interface TaskOptions {
  readonly assigneeIds?: number[];
  /** 任务创建者；缺省为项目夹具所有者，用于构造 creator ≠ assignee 的场景。 */
  readonly actorUserId?: number;
  readonly workStatus?: "TODO" | "DONE" | "CANCELED";
  readonly lifecycleStatus?: "ACTIVE" | "INVALID";
  readonly title?: string;
  readonly priority?: "NORMAL" | "HIGH" | "URGENT";
  readonly dueAt?: string | null;
}

async function newTask(
  scope: ProjectFixture,
  options: TaskOptions = {},
): Promise<number> {
  const workStatus = options.workStatus ?? "TODO";
  const code = scope.code + nextSuffix("T");
  return uow!.run(async (tx) => {
    const created = await taskWrites.create(
      tx,
      { projectId: scope.projectId, moduleId: scope.moduleId },
      options.actorUserId ?? scope.userId,
      code,
      {
        title: options.title ?? "聚合读接口任务",
        description: "",
        assigneeIds: options.assigneeIds ?? [scope.userId],
        priority: options.priority ?? "NORMAL",
        dueAt: options.dueAt ?? null,
      },
    );
    const current =
      workStatus === "TODO"
        ? created
        : (await taskWrites.transition(
            tx,
            created,
            scope.userId,
            workStatus,
            workStatus === "DONE" ? "聚合读接口夹具完成" : null,
            "聚合读接口夹具",
          ))!;
    if ((options.lifecycleStatus ?? "ACTIVE") !== "ACTIVE") {
      await tx.sql`UPDATE app.tasks SET lifecycle_status = ${options.lifecycleStatus!}, updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = ${current.id} AND project_id = ${scope.projectId}`;
    }
    return current.id;
  });
}

/**
 * 直改项目状态：ADR-043 要求切维护中前不存在未完成任务，本文件刻意保留任务数据
 * 以覆盖「维护中仍有卡片来源」的展示口径，因此绕过 API 直接改库。
 * row_version 必须 +1（0001 的 projects_row_version 触发器）。
 */
async function setProjectStatus(
  projectId: number,
  status: "NOT_STARTED" | "ACTIVE" | "MAINTENANCE",
): Promise<void> {
  await runtime!.sql`
    UPDATE app.projects
       SET status = ${status},
           updated_at = clock_timestamp(),
           row_version = row_version + 1
     WHERE id = ${projectId}
  `;
}

interface RecordOptions {
  readonly taskId?: number | null;
  readonly publishedAt?: string;
  readonly status?: "PUBLISHED" | "VOID";
}

/**
 * 已发布记录夹具：先建草稿，再补版本行并发布；VOID 记录保留 published_at 与版本，
 * 用于验证 R-4「VOID 可见但不计入 publishedRecordCount」与 §29.4「版本不增计数」。
 */
async function newPublishedRecord(
  scope: ProjectFixture,
  options: RecordOptions = {},
): Promise<number> {
  const code = scope.code + nextSuffix("CR");
  const taskId = options.taskId ?? null;
  const publishedAt = options.publishedAt ?? null;
  const draft = await uow!.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
      },
      scope.userId,
      recordContent,
      taskId === null ? undefined : { taskId, handlerId: scope.userId },
    ),
  );
  await uow!.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by) SELECT id, project_id, 1, title, current_payload, ${scope.userId} FROM app.change_records WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    await tx.sql`UPDATE app.change_records SET status = ${"PUBLISHED"}, code = ${code}, current_version = 1, published_at = COALESCE(${publishedAt}::timestamptz, clock_timestamp()), row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    if (options.status === "VOID") {
      await tx.sql`UPDATE app.change_records SET status = ${"VOID"}, voided_at = GREATEST(clock_timestamp(), published_at), void_reason = ${"聚合读接口夹具作废"}, row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    }
  });
  return draft.id;
}

async function newDraftRecord(
  scope: ProjectFixture,
  options: {
    readonly taskId?: number | null;
  } = {},
): Promise<number> {
  const taskId = options.taskId ?? null;
  const draft = await uow!.run((tx) =>
    draftWrites.create(
      tx,
      {
        projectId: scope.projectId,
        moduleId: scope.moduleId,
      },
      scope.userId,
      recordContent,
      taskId === null ? undefined : { taskId, handlerId: scope.userId },
    ),
  );
  return draft.id;
}

async function newRecordVersion(
  scope: ProjectFixture,
  recordId: number,
  versionNo: number,
): Promise<void> {
  await uow!.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by) SELECT id, project_id, ${versionNo}, title, current_payload, ${scope.userId} FROM app.change_records WHERE id = ${recordId} AND project_id = ${scope.projectId}`;
    await tx.sql`UPDATE app.change_records SET current_version = ${versionNo}, row_version = row_version + 1, updated_at = clock_timestamp() WHERE id = ${recordId} AND project_id = ${scope.projectId}`;
  });
}

/**
 * 遗留问题夹具。快照行必须挂在既有版本行上：0001 的 assert_change_record_versions
 * 禁止 DRAFT 记录拥有版本，因此草稿记录在结构上不可能产生遗留问题，夹具只覆盖
 * PUBLISHED / VOID 记录。
 */
async function newLeftover(
  scope: ProjectFixture,
  recordId: number,
  options: {
    readonly content: string;
    readonly createdAt: string;
    readonly status?: "ACTIVE" | "CONVERTED" | "RESOLVED";
  },
): Promise<number> {
  const status = options.status ?? "ACTIVE";
  return uow!.run(async (tx) => {
    const [row] = await tx.sql<{ id: number }[]>`
      INSERT INTO app.change_record_leftover_items (record_id, project_id, status, created_by, created_at)
      VALUES (${recordId}, ${scope.projectId}, ${status}, ${scope.userId}, ${options.createdAt}::timestamptz)
      RETURNING id
    `;
    if (!row) throw new Error("leftover fixture insert returned no row");
    await tx.sql`INSERT INTO app.change_record_version_leftovers (record_id, version_no, leftover_item_id, project_id, content_snapshot) VALUES (${recordId}, 1, ${row.id}, ${scope.projectId}, ${options.content})`;
    return row.id;
  });
}

interface GroupMemberSeed {
  readonly taskId: number;
  readonly role: "MAIN" | "SOURCE";
  readonly sourceKind?: "ACTIVE" | "HISTORICAL";
  readonly status?: "ACTIVE" | "DETACHED";
  readonly joinedAt: string;
  readonly detachedAt?: string;
  readonly detachReason?: string;
}

/**
 * 聚合组夹具：直接落库而不走 merge 命令，避免把合并 Workflow 的副作用带进聚合读
 * 用例；ACTIVE 组必须恰好 1 个 ACTIVE MAIN 且至少 1 个 ACTIVE SOURCE（0001 约束触发器）。
 */
async function seedTaskGroup(
  scope: ProjectFixture,
  codeIndex: number,
  name: string,
  members: readonly GroupMemberSeed[],
): Promise<number> {
  return uow!.run(async (tx) => {
    const [group] = await tx.sql<{ id: number }[]>`
      INSERT INTO app.task_groups (project_id, code, name, created_by)
      VALUES (${scope.projectId}, ${scope.code + "-TG-" + String(codeIndex)}, ${name}, ${scope.userId})
      RETURNING id
    `;
    if (!group) throw new Error("task group fixture insert returned no row");
    for (const member of members) {
      if (member.role === "MAIN") {
        await tx.sql`
          INSERT INTO app.task_group_members (group_id, task_id, project_id, role, status, joined_at)
          VALUES (${group.id}, ${member.taskId}, ${scope.projectId}, ${"MAIN"}, ${"ACTIVE"}, ${member.joinedAt}::timestamptz)
        `;
        continue;
      }
      const sourceKind = member.sourceKind ?? "ACTIVE";
      if ((member.status ?? "ACTIVE") === "DETACHED") {
        await tx.sql`
          INSERT INTO app.task_group_members (group_id, task_id, project_id, role, source_kind, original_work_status, original_assignee_id, status, joined_at, detached_at, detached_by, detach_reason)
          VALUES (${group.id}, ${member.taskId}, ${scope.projectId}, ${"SOURCE"}, ${sourceKind}, ${"TODO"}, ${scope.userId}, ${"DETACHED"}, ${member.joinedAt}::timestamptz, ${member.detachedAt!}::timestamptz, ${scope.userId}, ${member.detachReason!})
        `;
        continue;
      }
      await tx.sql`
        INSERT INTO app.task_group_members (group_id, task_id, project_id, role, source_kind, original_work_status, original_assignee_id, status, joined_at)
        VALUES (${group.id}, ${member.taskId}, ${scope.projectId}, ${"SOURCE"}, ${sourceKind}, ${"TODO"}, ${scope.userId}, ${"ACTIVE"}, ${member.joinedAt}::timestamptz)
      `;
    }
    return group.id;
  });
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

let idempotencyKeyringDirectory: string | undefined;

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
    applicationName: "inpulse-aggregate-read-api-test",
  });
  await migrate(urls.migrator);
  uow = new PostgresUnitOfWork(runtime);

  memberUser = await createUser(runtime.sql);
  otherUser = await createUser(runtime.sql);
  outsiderUser = await createUser(runtime.sql);
  secondMemberUser = await createUser(runtime.sql);
  const projectFixture = await createProject(runtime.sql, memberUser);
  project = projectFixture;
  const otherFixture = await createProject(runtime.sql, otherUser);
  otherProject = otherFixture;
  await runtime.sql`INSERT INTO app.project_members (project_id, user_id) VALUES (${projectFixture.projectId}, ${secondMemberUser})`;

  // ADR-044：模块已无归档态，夹具只保留两个活跃模块。
  await newModule(projectFixture, "聚合读接口模块");

  tMain = await newTask(projectFixture);
  tSource = await newTask(projectFixture);
  tHistorical = await newTask(projectFixture);
  tDetached = await newTask(projectFixture);
  tModule = await newTask(projectFixture);
  tDone = await newTask(projectFixture, {
    workStatus: "DONE",
  });
  tCanceled = await newTask(projectFixture, {
    workStatus: "CANCELED",
  });
  tInvalid = await newTask(projectFixture, {
    lifecycleStatus: "INVALID",
  });

  const baseMs = Date.now();
  const at = (minutes: number) =>
    new Date(baseMs + minutes * 60_000).toISOString();
  const before = (minutes: number) =>
    new Date(baseMs - minutes * 60_000).toISOString();

  groupId = await seedTaskGroup(projectFixture, 1, "聚合读接口聚合组", [
    { joinedAt: before(240), role: "MAIN", taskId: tMain },
    {
      joinedAt: before(180),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      taskId: tSource,
    },
    {
      joinedAt: before(120),
      role: "SOURCE",
      sourceKind: "HISTORICAL",
      taskId: tHistorical,
    },
    {
      detachReason: "聚合读接口夹具解除来源关系",
      detachedAt: before(30),
      joinedAt: before(60),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      status: "DETACHED",
      taskId: tDetached,
    },
  ]);

  crMain = await newPublishedRecord(projectFixture, {
    publishedAt: at(1),
    taskId: tMain,
  });
  crModule = await newPublishedRecord(projectFixture, { publishedAt: at(2) });
  crSource = await newPublishedRecord(projectFixture, {
    publishedAt: at(3),
    taskId: tSource,
  });
  crVoid = await newPublishedRecord(projectFixture, {
    publishedAt: at(4),
    status: "VOID",
    taskId: tSource,
  });
  crHistorical = await newPublishedRecord(projectFixture, {
    publishedAt: at(5),
    taskId: tHistorical,
  });
  crPaged = [
    await newPublishedRecord(projectFixture, {
      publishedAt: at(6),
      taskId: tSource,
    }),
    await newPublishedRecord(projectFixture, {
      publishedAt: at(7),
      taskId: tSource,
    }),
    await newPublishedRecord(projectFixture, {
      publishedAt: at(8),
      taskId: tSource,
    }),
    await newPublishedRecord(projectFixture, {
      publishedAt: at(9),
      taskId: tSource,
    }),
  ];
  crDraft = await newDraftRecord(projectFixture, {
    taskId: tMain,
  });
  // §29.4：版本递增不改变记录数、统计口径与列表条数。
  await newRecordVersion(projectFixture, crMain, 2);

  await newLeftover(projectFixture, crModule, {
    content: "模块级记录遗留问题",
    createdAt: at(1),
  });
  await newLeftover(projectFixture, crVoid, {
    content: "作废记录遗留问题",
    createdAt: at(2),
  });
  await newLeftover(projectFixture, crSource, {
    content: "来源任务遗留问题",
    createdAt: at(3),
  });
  await newLeftover(projectFixture, crMain, {
    content: "已解决遗留问题",
    createdAt: at(4),
    status: "RESOLVED",
  });
  // 裁决修订 D-2：tSource 是一条真实的「遗留问题转任务」跟进任务
  //（CONVERTED 遗留项 + leftover_task_links 链接行），其余任务都没有链接。
  const loConvertedSource = await newLeftover(projectFixture, crSource, {
    content: "已转换遗留问题",
    createdAt: at(5),
    status: "CONVERTED",
  });
  await runtime.sql`
    INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by)
    VALUES (${loConvertedSource}, ${tSource}, ${projectFixture.projectId}, ${projectFixture.userId})
  `;

  const sessionKey = randomBytes(32);
  const sessionKeyring = VersionedHmacKeyring.fromEntries(
    [{ key: sessionKey, version: 1 }],
    1,
  );
  sessionKeyringDirectory = await mkdtemp(
    join(tmpdir(), "inpulse-aggregate-read-api-"),
  );
  const sessionKeyringFile = join(sessionKeyringDirectory, "session.keyring");
  await writeFile(
    sessionKeyringFile,
    "1:" + sessionKey.toString("hex") + String.fromCharCode(10),
    "utf8",
  );
  memberCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, memberUser)
  ).cookie;
  otherCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, otherUser)
  ).cookie;
  outsiderCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, outsiderUser)
  ).cookie;

  idempotencyKeyringDirectory = await mkdtemp(
    join(tmpdir(), "inpulse-aggregate-read-idempotency-"),
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
  if (sessionKeyringDirectory !== undefined) {
    await rm(sessionKeyringDirectory, { force: true, recursive: true });
  }
  if (idempotencyKeyringDirectory !== undefined) {
    await rm(idempotencyKeyringDirectory, { force: true, recursive: true });
  }
});

describe("GET /api/v1/task-groups/{groupId}（R-1 聚合组视图）", () => {
  test("匿名 401，非成员、跨项目成员与不存在的组统一 404", async () => {
    await expectError(
      "/api/v1/task-groups/" + String(groupId),
      undefined,
      401,
      "TASK_GROUP_UNAUTHENTICATED",
    );
    await expectError(
      "/api/v1/task-groups/" + String(groupId),
      outsiderCookie,
      404,
      "TASK_GROUP_NOT_FOUND",
    );
    await expectError(
      "/api/v1/task-groups/" + String(groupId),
      otherCookie,
      404,
      "TASK_GROUP_NOT_FOUND",
    );
    await expectError(
      "/api/v1/task-groups/2147483647",
      memberCookie,
      404,
      "TASK_GROUP_NOT_FOUND",
    );
    await expectError(
      "/api/v1/task-groups/0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("成员按主任务优先、加入时间升序返回，记录数按记录不按版本计数", async () => {
    const response = await getJson(
      "/api/v1/task-groups/" + String(groupId),
      memberCookie,
    );
    expect(response.status).toBe(200);
    const detail = taskGroupDetailResponseSchema.parse(response.body);
    expect(detail.group).toMatchObject({
      closedAt: null,
      code: project!.code + "-TG-1",
      groupId,
      name: "聚合读接口聚合组",
      projectId: project!.projectId,
      status: "ACTIVE",
    });
    expect(detail.members.map((member) => member.taskId)).toEqual([
      tMain,
      tSource,
      tHistorical,
      tDetached,
    ]);
    expect(
      detail.members.map((member) => ({
        memberStatus: member.memberStatus,
        role: member.role,
        sourceKind: member.sourceKind,
        workStatus: member.workStatus,
      })),
    ).toEqual([
      {
        memberStatus: "ACTIVE",
        role: "MAIN",
        sourceKind: null,
        workStatus: "TODO",
      },
      {
        memberStatus: "ACTIVE",
        role: "SOURCE",
        sourceKind: "ACTIVE",
        workStatus: "TODO",
      },
      {
        memberStatus: "ACTIVE",
        role: "SOURCE",
        sourceKind: "HISTORICAL",
        workStatus: "TODO",
      },
      {
        memberStatus: "DETACHED",
        role: "SOURCE",
        sourceKind: "ACTIVE",
        workStatus: "TODO",
      },
    ]);
    // §29.4：crMain 已发布到第 2 版，成员记录数仍为 1；VOID 记录不计入。
    const [record] = await runtime!.sql<{ currentVersion: number }[]>`
      SELECT current_version AS "currentVersion"
        FROM app.change_records
       WHERE id = ${crMain}
    `;
    expect(record?.currentVersion).toBe(2);
    expect(detail.members.map((member) => member.publishedRecordCount)).toEqual(
      [1, 5, 1, 0],
    );
    // 2026-09-21：分支卡片需要展示任务优先级与所属模块名称而不是模块编号。
    expect(detail.members.map((member) => member.priority)).toEqual([
      "NORMAL",
      "NORMAL",
      "NORMAL",
      "NORMAL",
    ]);
    expect(detail.members[0]!.taskCode).toContain("-T-");
    expect(detail.members[0]!.title.length).toBeGreaterThan(0);
    expect(detail.members[0]!.assignee).toMatchObject({ userId: memberUser });
    expect(detail.members[0]!.detachedAt).toBeNull();
    expect(detail.members[3]!.detachedAt).not.toBeNull();
    expect(detail.members[3]!.detachReason).toBe("聚合读接口夹具解除来源关系");
    expect(detail.members[2]!.lifecycleStatus).toBe("ACTIVE");
  });
});

describe("GET /api/v1/task-groups/{groupId}/records（R-4 聚合组记录）", () => {
  test("只返回 PUBLISHED 与 VOID 记录，DRAFT 与组外记录不出现", async () => {
    const response = await getJson(
      "/api/v1/task-groups/" + String(groupId) + "/records",
      memberCookie,
    );
    expect(response.status).toBe(200);
    const page = taskGroupRecordPageSchema.parse(response.body);
    expect(page.items.map((item) => item.recordId)).toEqual([
      crPaged[3]!,
      crPaged[2]!,
      crPaged[1]!,
      crPaged[0]!,
      crHistorical,
      crVoid,
      crSource,
      crMain,
    ]);
    expect(page.items.map((item) => item.recordStatus)).toEqual([
      "PUBLISHED",
      "PUBLISHED",
      "PUBLISHED",
      "PUBLISHED",
      "PUBLISHED",
      "VOID",
      "PUBLISHED",
      "PUBLISHED",
    ]);
    expect(page.items.some((item) => item.recordId === crDraft)).toBe(false);
    expect(page.items.some((item) => item.recordId === crModule)).toBe(false);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    // §29.4：两个版本仍是同一条记录。
    expect(page.items.filter((item) => item.recordId === crMain)).toHaveLength(
      1,
    );
    expect(
      page.items.find((item) => item.recordId === crMain)?.sourceLabel,
    ).toBe("主任务");
    expect(
      page.items.find((item) => item.recordId === crSource)?.sourceLabel,
    ).toContain("-T-");
    expect(
      page.items.find((item) => item.recordId === crHistorical)?.sourceLabel,
    ).toContain("-T-");
    expect(page.items.every((item) => item.externalLinks.length === 0)).toBe(
      true,
    );
  });

  test("memberTaskId 只过滤组内成员任务，组外任务返回空页", async () => {
    const sourcePage = await getJson(
      "/api/v1/task-groups/" +
        String(groupId) +
        "/records?memberTaskId=" +
        String(tSource),
      memberCookie,
    );
    expect(sourcePage.status).toBe(200);
    expect(
      taskGroupRecordPageSchema
        .parse(sourcePage.body)
        .items.map((item) => item.recordId),
    ).toEqual([
      crPaged[3]!,
      crPaged[2]!,
      crPaged[1]!,
      crPaged[0]!,
      crVoid,
      crSource,
    ]);

    const historicalPage = await getJson(
      "/api/v1/task-groups/" +
        String(groupId) +
        "/records?memberTaskId=" +
        String(tHistorical),
      memberCookie,
    );
    expect(historicalPage.status).toBe(200);
    expect(
      taskGroupRecordPageSchema
        .parse(historicalPage.body)
        .items.map((item) => item.recordId),
    ).toEqual([crHistorical]);

    const detachedPage = await getJson(
      "/api/v1/task-groups/" +
        String(groupId) +
        "/records?memberTaskId=" +
        String(tDetached),
      memberCookie,
    );
    expect(detachedPage.status).toBe(200);
    expect(taskGroupRecordPageSchema.parse(detachedPage.body)).toMatchObject({
      hasMore: false,
      items: [],
      nextCursor: null,
    });

    const outsidePage = await getJson(
      "/api/v1/task-groups/" +
        String(groupId) +
        "/records?memberTaskId=" +
        String(tModule),
      memberCookie,
    );
    expect(outsidePage.status).toBe(200);
    expect(taskGroupRecordPageSchema.parse(outsidePage.body)).toMatchObject({
      hasMore: false,
      items: [],
      nextCursor: null,
    });
  });

  test("游标分页不重复不丢行，拒绝跨筛选与篡改游标", async () => {
    const collected: number[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const suffix =
        cursor === null ? "" : "&cursor=" + encodeURIComponent(cursor);
      const response = await getJson(
        "/api/v1/task-groups/" + String(groupId) + "/records?limit=3" + suffix,
        memberCookie,
      );
      expect(response.status).toBe(200);
      const page = taskGroupRecordPageSchema.parse(response.body);
      collected.push(...page.items.map((item) => item.recordId));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(collected).toEqual([
      crPaged[3]!,
      crPaged[2]!,
      crPaged[1]!,
      crPaged[0]!,
      crHistorical,
      crVoid,
      crSource,
      crMain,
    ]);
    expect(new Set(collected).size).toBe(collected.length);

    const unfiltered = await getJson(
      "/api/v1/task-groups/" + String(groupId) + "/records?limit=3",
      memberCookie,
    );
    const firstCursor = taskGroupRecordPageSchema.parse(
      unfiltered.body,
    ).nextCursor;
    expect(firstCursor).not.toBeNull();
    await expectError(
      "/api/v1/task-groups/" +
        String(groupId) +
        "/records?memberTaskId=" +
        String(tSource) +
        "&cursor=" +
        encodeURIComponent(firstCursor!),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    const tampered =
      firstCursor!.slice(0, -2) + (firstCursor!.endsWith("A") ? "B" : "A");
    await expectError(
      "/api/v1/task-groups/" +
        String(groupId) +
        "/records?cursor=" +
        encodeURIComponent(tampered),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/task-groups/" + String(groupId) + "/records?cursor=broken",
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/task-groups/" + String(groupId) + "/records?limit=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("匿名 401、非成员 404 与非法路径参数 422", async () => {
    await expectError(
      "/api/v1/task-groups/" + String(groupId) + "/records",
      undefined,
      401,
      "TASK_GROUP_UNAUTHENTICATED",
    );
    await expectError(
      "/api/v1/task-groups/" + String(groupId) + "/records",
      outsiderCookie,
      404,
      "TASK_GROUP_NOT_FOUND",
    );
    await expectError(
      "/api/v1/task-groups/2147483647/records",
      memberCookie,
      404,
      "TASK_GROUP_NOT_FOUND",
    );
    await expectError(
      "/api/v1/task-groups/abc/records",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/task-groups/" + String(groupId) + "/records?memberTaskId=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });
});

describe("GET /api/v1/projects/{projectId}/overview（R-2 项目概览）", () => {
  test("统计口径按 §29.1 / §29.3 / §29.4：历史来源分支与版本都不增计数", async () => {
    const response = await getJson(
      "/api/v1/projects/" + String(project!.projectId) + "/overview",
      memberCookie,
    );
    expect(response.status).toBe(200);
    const overview = projectOverviewResponseSchema.parse(response.body);
    expect(overview.project).toEqual({
      name: "Project " + project!.code,
      projectId: project!.projectId,
      status: "NOT_STARTED",
    });
    expect(overview.memberCount).toBe(2);
    // 模块自 ADR-044 起无归档态，活跃模块数即项目模块数。
    // 未完成任务排除历史来源分支、CANCELED、INVALID 与 DONE，并包含 §29.3 的模块级任务。
    expect(overview.stats).toEqual({
      activeModuleCount: 2,
      openTaskCount: 4,
      publishedRecordCount: 8,
    });
    expect(overview.recentRecords.map((item) => item.recordId)).toEqual([
      crPaged[3]!,
      crPaged[2]!,
      crPaged[1]!,
    ]);
    expect(overview.activeLeftovers.map((item) => item.content)).toEqual([
      "来源任务遗留问题",
      "模块级记录遗留问题",
    ]);
    expect(
      overview.activeLeftovers.every(
        (item) =>
          item.recordCode.includes("-CR-") &&
          item.leftoverItemId > 0 &&
          item.recordId > 0,
      ),
    ).toBe(true);
  });

  test("最近迭代与遗留问题条数由 query 收口，越界与非法值 422", async () => {
    const expanded = await getJson(
      "/api/v1/projects/" +
        String(project!.projectId) +
        "/overview?recentRecordLimit=5&activeLeftoverLimit=3",
      memberCookie,
    );
    expect(expanded.status).toBe(200);
    const paged = projectOverviewResponseSchema.parse(expanded.body);
    expect(paged.recentRecords.map((item) => item.recordId)).toEqual([
      crPaged[3]!,
      crPaged[2]!,
      crPaged[1]!,
      crPaged[0]!,
      crHistorical,
    ]);
    expect(paged.activeLeftovers.map((item) => item.content)).toEqual([
      "来源任务遗留问题",
      "模块级记录遗留问题",
    ]);

    const full = await getJson(
      "/api/v1/projects/" +
        String(project!.projectId) +
        "/overview?recentRecordLimit=10",
      memberCookie,
    );
    expect(full.status).toBe(200);
    const all = projectOverviewResponseSchema.parse(full.body);
    expect(all.recentRecords).toHaveLength(8);
    // VOID 与 DRAFT 记录都不进入最近迭代；VOID 记录与已解决项的遗留问题不计入未处理。
    expect(all.recentRecords.some((item) => item.recordId === crVoid)).toBe(
      false,
    );
    expect(all.recentRecords.some((item) => item.recordId === crDraft)).toBe(
      false,
    );
    expect(
      all.activeLeftovers.some((item) => item.content === "已解决遗留问题"),
    ).toBe(false);

    await expectError(
      "/api/v1/projects/" +
        String(project!.projectId) +
        "/overview?recentRecordLimit=11",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/projects/" +
        String(project!.projectId) +
        "/overview?activeLeftoverLimit=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("非成员与不存在的项目统一 404，匿名 401", async () => {
    await expectError(
      "/api/v1/projects/" + String(project!.projectId) + "/overview",
      undefined,
      401,
      "PROJECT_OVERVIEW_UNAUTHENTICATED",
    );
    await expectError(
      "/api/v1/projects/" + String(project!.projectId) + "/overview",
      outsiderCookie,
      404,
      "PROJECT_NOT_FOUND",
    );
    await expectError(
      "/api/v1/projects/" + String(project!.projectId) + "/overview",
      otherCookie,
      404,
      "PROJECT_NOT_FOUND",
    );
    await expectError(
      "/api/v1/projects/2147483647/overview",
      memberCookie,
      404,
      "PROJECT_NOT_FOUND",
    );
    await expectError(
      "/api/v1/projects/0/overview",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("activeLeftoverTotal 不受 limit 影响，recordTitle 取来源记录标题", async () => {
    const response = await getJson(
      "/api/v1/projects/" +
        String(project!.projectId) +
        "/overview?activeLeftoverLimit=1",
      memberCookie,
    );
    expect(response.status).toBe(200);
    const overview = projectOverviewResponseSchema.parse(response.body);
    expect(overview.activeLeftovers).toHaveLength(1);
    expect(overview.activeLeftoverTotal).toBe(2);
    expect(overview.activeLeftovers[0]?.recordTitle).toBe("聚合读接口记录");
  });
});

describe("GET /api/v1/me/tasks（R-3 我的任务）", () => {
  test("只返回本人负责的任务，排除历史来源分支并标注组角色", async () => {
    const response = await getJson("/api/v1/me/tasks", memberCookie);
    expect(response.status).toBe(200);
    const page = myTaskPageSchema.parse(response.body);
    // ADR-037：未完成 → 已完成 → 已取消；未完成内部按
    // 标记紧急 → 已逾期 → 今/明日截止 → 其余 分紧急桶，桶内先比优先级、再比「遗留问题来源」
    // 独立一级（2026-09-24 定案：遗留问题只会在同优先级里面高一点），最后按 ID 升序。
    // 本夹具没有截止时间与紧急优先级，只有 tSource 命中「遗留问题来源」，其余未完成任务
    // 都落在「其余」同级，因此 tSource 只在同为普通优先级的 tMain 等同级任务里提前，
    // 期望顺序仍是 tSource 在前、其余按 ID 升序。更高优先级不会被遗留问题越过的用例见
    // 文件末尾的「GET /api/v1/me/tasks 排序口径：遗留问题来源只在同优先级内提前」。
    expect(page.items.map((item) => item.taskId)).toEqual([
      tSource,
      tMain,
      tDetached,
      tModule,
      tInvalid,
      tDone,
      tCanceled,
    ]);
    expect(page.items.some((item) => item.taskId === tHistorical)).toBe(false);
    expect(
      page.items.every((item) => item.assignee.userId === memberUser),
    ).toBe(true);
    const roleByTask = new Map(
      page.items.map((item) => [item.taskId, item.groupRole]),
    );
    expect(roleByTask.get(tMain)).toBe("MAIN");
    expect(roleByTask.get(tSource)).toBe("SOURCE");
    expect(roleByTask.get(tDetached)).toBeNull();
    expect(roleByTask.get(tModule)).toBeNull();
    const publishedByTask = new Map(
      page.items.map((item) => [item.taskId, item.hasPublishedRecord]),
    );
    expect(publishedByTask.get(tMain)).toBe(true);
    expect(publishedByTask.get(tSource)).toBe(true);
    expect(publishedByTask.get(tDone)).toBe(false);
    // 裁决修订 D-1：publishedRecordCount 与 hasPublishedRecord 同源同口径。
    const recordCountByTask = new Map(
      page.items.map((item) => [item.taskId, item.publishedRecordCount]),
    );
    expect(recordCountByTask.get(tMain)).toBe(1);
    expect(recordCountByTask.get(tSource)).toBe(5);
    expect(recordCountByTask.get(tDone)).toBe(0);
    expect(
      page.items.every(
        (item) => item.hasPublishedRecord === item.publishedRecordCount > 0,
      ),
    ).toBe(true);
    // 裁决修订 D-2：只有存在 leftover_task_links 链接行的任务标记遗留问题来源。
    const leftoverSourceByTask = new Map(
      page.items.map((item) => [item.taskId, item.hasLeftoverSource]),
    );
    expect(leftoverSourceByTask.get(tSource)).toBe(true);
    expect(leftoverSourceByTask.get(tMain)).toBe(false);
    expect(leftoverSourceByTask.get(tDone)).toBe(false);
    expect(page.items.find((item) => item.taskId === tModule)).toMatchObject({
      lifecycleStatus: "ACTIVE",
      projectId: project!.projectId,
      projectName: "Project " + project!.code,
      workStatus: "TODO",
    });
    expect(
      page.items.find((item) => item.taskId === tInvalid)?.lifecycleStatus,
    ).toBe("INVALID");
  });

  test("四项筛选、越权 projectId 收敛与游标 filterKey 绑定", async () => {
    const filterCases: readonly {
      readonly path: string;
      readonly taskIds: readonly number[];
    }[] = [
      { path: "/api/v1/me/tasks?workStatus=DONE", taskIds: [tDone] },
      { path: "/api/v1/me/tasks?workStatus=CANCELED", taskIds: [tCanceled] },
      {
        path: "/api/v1/me/tasks?hasPublishedRecord=true",
        taskIds: [tSource, tMain],
      },
      {
        path: "/api/v1/me/tasks?hasPublishedRecord=false",
        taskIds: [tDetached, tModule, tInvalid, tDone, tCanceled],
      },
      {
        path: "/api/v1/me/tasks?projectId=" + String(otherProject!.projectId),
        taskIds: [],
      },
      {
        path: "/api/v1/me/tasks?projectId=" + String(project!.projectId),
        taskIds: [
          tSource,
          tMain,
          tDetached,
          tModule,
          tInvalid,
          tDone,
          tCanceled,
        ],
      },
    ];
    for (const item of filterCases) {
      const response = await getJson(item.path, memberCookie);
      expect(response.status).toBe(200);
      expect(
        myTaskPageSchema.parse(response.body).items.map((task) => task.taskId),
      ).toEqual(item.taskIds);
    }

    const collected: number[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const suffix =
        cursor === null ? "" : "&cursor=" + encodeURIComponent(cursor);
      const response = await getJson(
        "/api/v1/me/tasks?limit=3" + suffix,
        memberCookie,
      );
      expect(response.status).toBe(200);
      const page = myTaskPageSchema.parse(response.body);
      if (page.nextCursor !== null) {
        expect(page.nextCursor.length).toBeLessThanOrEqual(
          AGGREGATE_READ_CURSOR_MAX_LENGTH,
        );
      }
      collected.push(...page.items.map((item) => item.taskId));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(collected).toEqual([
      tSource,
      tMain,
      tDetached,
      tModule,
      tInvalid,
      tDone,
      tCanceled,
    ]);
    expect(new Set(collected).size).toBe(collected.length);

    const unfiltered = await getJson("/api/v1/me/tasks?limit=3", memberCookie);
    const firstCursor = myTaskPageSchema.parse(unfiltered.body).nextCursor;
    expect(firstCursor).not.toBeNull();
    await expectError(
      "/api/v1/me/tasks?limit=3&workStatus=TODO&cursor=" +
        encodeURIComponent(firstCursor!),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/me/tasks?cursor=broken",
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/me/tasks?limit=101",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/me/tasks?moduleScope=GROUP",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/me/tasks?hasPublishedRecord=maybe",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("ownership 归属维度正交：CREATOR 只返回本人创建，且游标签名绑定（F-32「我创建的」）", async () => {
    const createdForOther = await newTask(project!, {
      assigneeIds: [secondMemberUser],
      dueAt: "2027-04-01T03:00:00.000Z",
    });
    const createdByOtherForMe = await newTask(project!, {
      actorUserId: secondMemberUser,
      assigneeIds: [memberUser],
    });

    const createdPage = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks?ownership=CREATOR", memberCookie)).body,
    );
    const createdIds = createdPage.items.map((item) => item.taskId);
    expect(createdIds).toContain(createdForOther);
    expect(createdIds).not.toContain(createdByOtherForMe);
    expect(
      createdPage.items.every((item) => item.creatorId === memberUser),
    ).toBe(true);

    const assignedPage = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks", memberCookie)).body,
    );
    const assignedIds = assignedPage.items.map((item) => item.taskId);
    expect(assignedIds).toContain(createdByOtherForMe);
    expect(assignedIds).not.toContain(createdForOther);
    // 统计与遗留问题样本不随 ownership 变化：todayTodo / myOpen / completed 取负责人维度，
    // created 取创建人维度，两者都是当前用户自指口径。
    expect(createdPage.stats).toEqual(assignedPage.stats);
    expect(createdPage.leftoverCount).toBe(assignedPage.leftoverCount);

    const explicitAssignee = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks?ownership=ASSIGNEE", memberCookie)).body,
    );
    expect(explicitAssignee.items.map((item) => item.taskId)).toEqual(
      assignedIds,
    );

    const paged = myTaskPageSchema.parse(
      (
        await getJson(
          "/api/v1/me/tasks?ownership=CREATOR&limit=1",
          memberCookie,
        )
      ).body,
    );
    expect(paged.nextCursor).not.toBeNull();
    await expectError(
      "/api/v1/me/tasks?ownership=ASSIGNEE&limit=1&cursor=" +
        encodeURIComponent(paged.nextCursor!),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );

    await expectError(
      "/api/v1/me/tasks?ownership=OWNER",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("无项目成员身份返回空页与零统计，匿名 401", async () => {
    const response = await getJson("/api/v1/me/tasks", outsiderCookie);
    expect(response.status).toBe(200);
    expect(myTaskPageSchema.parse(response.body)).toEqual({
      hasMore: false,
      items: [],
      nextCursor: null,
      stats: {
        todayTodo: 0,
        todayTodoBreakdown: {
          overdue: 0,
          leftover: 0,
          urgent: 0,
          dueWithinDays: 0,
        },
        myOpen: 0,
        completed: 0,
        created: 0,
      },
      leftoverCount: 0,
      leftoverSample: null,
    });
    const otherResponse = await getJson("/api/v1/me/tasks", otherCookie);
    expect(otherResponse.status).toBe(200);
    expect(myTaskPageSchema.parse(otherResponse.body).items).toEqual([]);
    await expectError(
      "/api/v1/me/tasks",
      undefined,
      401,
      "MY_TASKS_UNAUTHENTICATED",
    );
  });

  test("priority / includeCanceled 筛选与新选择列（A 裁决 §10.3）", async () => {
    const dueAt = "2027-03-01T03:00:00.000Z";
    const highTask = await newTask(project!, {
      dueAt,
      priority: "HIGH",
    });
    const response = await getJson(
      "/api/v1/me/tasks?priority=HIGH",
      memberCookie,
    );
    expect(response.status).toBe(200);
    const page = myTaskPageSchema.parse(response.body);
    expect(page.items.map((item) => item.taskId)).toEqual([highTask]);
    expect(page.items[0]).toMatchObject({
      priority: "HIGH",
      dueAt: new Date(dueAt).toISOString(),
      completedAt: null,
      creatorId: memberUser,
      githubLinkCount: 0,
      groupId: null,
      groupRole: null,
    });

    const unionResponse = await getJson(
      "/api/v1/me/tasks?workStatus=TODO&includeCanceled=true",
      memberCookie,
    );
    expect(unionResponse.status).toBe(200);
    const unionIds = myTaskPageSchema
      .parse(unionResponse.body)
      .items.map((item) => item.taskId);
    expect(unionIds).toContain(tCanceled);
    expect(unionIds).toContain(highTask);
    expect(unionIds).not.toContain(tDone);

    const excludedResponse = await getJson(
      "/api/v1/me/tasks?workStatus=TODO&includeCanceled=false",
      memberCookie,
    );
    expect(
      myTaskPageSchema
        .parse(excludedResponse.body)
        .items.map((item) => item.taskId),
    ).not.toContain(tCanceled);

    await expectError(
      "/api/v1/me/tasks?priority=CRITICAL",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    // 2026-09-23 起「低」档位已下线：priority=LOW 与 CRITICAL 同为非法枚举，服务端拒绝。
    await expectError(
      "/api/v1/me/tasks?priority=LOW",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/me/tasks?includeCanceled=maybe",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("githubLinkCount 与 groupId 同源映射（§10.3）", async () => {
    const linkTask = await newTask(project!);
    const url = "https://github.com/256-code/InPulse/issues/9901";
    const [link] = await runtime!.sql<{ id: number }[]>`
      INSERT INTO app.external_links (project_id, display_url, normalized_url, kind, created_by)
      VALUES (${project!.projectId}, ${url}, ${url}, ${"ISSUE"}, ${memberUser})
      RETURNING id
    `;
    if (!link) throw new Error("external link fixture insert returned no row");
    await runtime!
      .sql`INSERT INTO app.task_external_links (project_id, task_id, link_id) VALUES (${project!.projectId}, ${linkTask}, ${link.id})`;
    await runtime!
      .sql`INSERT INTO app.task_external_links (project_id, task_id, link_id) VALUES (${project!.projectId}, ${tMain}, ${link.id})`;

    const response = await getJson("/api/v1/me/tasks", memberCookie);
    const page = myTaskPageSchema.parse(response.body);
    const byTask = new Map(page.items.map((item) => [item.taskId, item]));
    expect(byTask.get(linkTask)).toMatchObject({
      githubLinkCount: 1,
      groupRole: null,
      groupId: null,
    });
    expect(byTask.get(tMain)).toMatchObject({
      githubLinkCount: 1,
      groupRole: "MAIN",
      groupId,
    });
  });

  test("统计卡片与遗留问题入口按基准集合计算且与筛选正交（§10.3）", async () => {
    const statsProject = await createProject(runtime!.sql, memberUser);
    const before = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000).toISOString();
    const after = (minutes: number) =>
      new Date(Date.now() + minutes * 60_000).toISOString();
    const overdueTask = await newTask(statsProject, {
      dueAt: before(26 * 60),
      priority: "URGENT",
    });
    const [todayBoundary] = await runtime!.sql<{ dueAt: string }[]>`
      SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'Asia/Shanghai')::text AS "dueAt"
    `;
    const todayTask = await newTask(statsProject, {
      dueAt: todayBoundary!.dueAt,
    });
    const doneTask = await newTask(statsProject, { workStatus: "DONE" });
    const canceledTask = await newTask(statsProject, {
      workStatus: "CANCELED",
    });

    const recordId = await newPublishedRecord(statsProject, {
      publishedAt: after(5),
      taskId: overdueTask,
    });
    const [recordRow] = await runtime!.sql<{ code: string }[]>`
      SELECT code FROM app.change_records WHERE id = ${recordId} AND project_id = ${statsProject.projectId}
    `;
    const leftoverId = await newLeftover(statsProject, recordId, {
      content: "统计遗留内容",
      createdAt: before(30),
    });
    await runtime!
      .sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by) VALUES (${leftoverId}, ${overdueTask}, ${statsProject.projectId}, ${statsProject.userId})`;

    const scope = "projectId=" + String(statsProject.projectId);
    const response = await getJson("/api/v1/me/tasks?" + scope, memberCookie);
    expect(response.status).toBe(200);
    const page = myTaskPageSchema.parse(response.body);
    // ADR-037：已逾期(1) → 今/明日截止(3) → 已完成 → 已取消。
    expect(page.items.map((item) => item.taskId)).toEqual([
      overdueTask,
      todayTask,
      doneTask,
      canceledTask,
    ]);
    expect(page.stats).toEqual({
      // 逾期 ∪ 遗留 ∪ 紧急 ∪ 7 个日历日内到期，去重后 2 条。
      todayTodo: 2,
      todayTodoBreakdown: {
        overdue: 1,
        leftover: 1,
        urgent: 1,
        dueWithinDays: 1,
      },
      myOpen: 2,
      completed: 1,
      created: 3,
    });
    expect(page.leftoverCount).toBe(1);
    expect(page.leftoverSample).toEqual({
      recordCode: recordRow!.code,
      summary: "统计遗留内容",
    });

    // todayTodo 筛选：只返回未完成且命中四类条件之一的任务，并与统计同口径。
    const todayTodoResponse = await getJson(
      "/api/v1/me/tasks?" + scope + "&todayTodo=true",
      memberCookie,
    );
    expect(todayTodoResponse.status).toBe(200);
    const todayTodoPage = myTaskPageSchema.parse(todayTodoResponse.body);
    expect(todayTodoPage.items.map((item) => item.taskId)).toEqual([
      overdueTask,
      todayTask,
    ]);
    expect(todayTodoPage.items).toHaveLength(page.stats.todayTodo);
    await expectError(
      "/api/v1/me/tasks?" + scope + "&todayTodo=maybe",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );

    // 统计与遗留计数与筛选正交：workStatus / priority 只影响 items。
    const filtered = await getJson(
      "/api/v1/me/tasks?" + scope + "&workStatus=DONE&priority=URGENT",
      memberCookie,
    );
    const filteredPage = myTaskPageSchema.parse(filtered.body);
    expect(filteredPage.items).toEqual([]);
    expect(filteredPage.stats).toEqual(page.stats);
    expect(filteredPage.leftoverCount).toBe(1);

    // 最新一条遗留项超过 200 字符时摘要截断并追加省略号。
    const longLeftoverId = await newLeftover(statsProject, recordId, {
      content: "长".repeat(260),
      createdAt: new Date().toISOString(),
    });
    await runtime!
      .sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by) VALUES (${longLeftoverId}, ${todayTask}, ${statsProject.projectId}, ${statsProject.userId})`;
    const truncated = await getJson("/api/v1/me/tasks?" + scope, memberCookie);
    const truncatedPage = myTaskPageSchema.parse(truncated.body);
    expect(truncatedPage.leftoverCount).toBe(2);
    expect(truncatedPage.leftoverSample).toEqual({
      recordCode: recordRow!.code,
      summary: "长".repeat(200) + "…",
    });
  });

  test("维护中项目不再产出任务卡片，切回进行中后重新出现（2026-09-30 口径）", async () => {
    const maintenanceProject = await createProject(runtime!.sql, memberUser);
    const openTask = await newTask(maintenanceProject);
    const doneTask = await newTask(maintenanceProject, {
      workStatus: "DONE",
    });
    const scope = "projectId=" + String(maintenanceProject.projectId);
    const taskIdsIn = (page: { items: readonly { taskId: number }[] }) =>
      page.items.map((item) => item.taskId);

    // 未开始 / 进行中项目仍产出卡片：只有维护中项目被剔除。
    const before = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks?" + scope, memberCookie)).body,
    );
    expect(taskIdsIn(before)).toEqual([openTask, doneTask]);
    expect(before.stats).toMatchObject({ myOpen: 1, completed: 1 });

    await setProjectStatus(maintenanceProject.projectId, "MAINTENANCE");

    const hidden = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks?" + scope, memberCookie)).body,
    );
    expect(hidden.items).toEqual([]);
    expect(hidden.stats).toMatchObject({
      todayTodo: 0,
      myOpen: 0,
      completed: 0,
      created: 0,
    });
    expect(hidden.leftoverCount).toBe(0);

    // 未带 projectId 的全局查询同样不再出现该项目：剔除发生在授权范围收窄之后、
    // 分页与统计之前。
    const all = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks", memberCookie)).body,
    );
    expect(
      all.items.some((item) => item.projectId === maintenanceProject.projectId),
    ).toBe(false);

    await setProjectStatus(maintenanceProject.projectId, "ACTIVE");

    const restored = myTaskPageSchema.parse(
      (await getJson("/api/v1/me/tasks?" + scope, memberCookie)).body,
    );
    expect(taskIdsIn(restored)).toEqual([openTask, doneTask]);
    expect(restored.stats).toMatchObject({ myOpen: 1, completed: 1 });
  });
});

describe("GET /api/v1/task-groups/memberships（R-5 任务记录标记批量读，裁决修订 D-1）", () => {
  test("覆盖请求中每一个有权 taskId：未入组任务返回空关系且计数照常", async () => {
    // 未入组但有 PUBLISHED 记录的任务：groupId / groupRole 为 null，计数照常非零。
    const ungroupedWithRecord = await newTask(project!, {});
    await newPublishedRecord(project!, {
      taskId: ungroupedWithRecord,
    });

    const response = await getJson(
      "/api/v1/task-groups/memberships?taskIds=" +
        [
          tMain,
          tSource,
          tHistorical,
          tDetached,
          tModule,
          ungroupedWithRecord,
        ].join(","),
      memberCookie,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          taskId: tMain,
          groupId,
          groupRole: "MAIN",
          publishedRecordCount: 1,
          hasLeftoverSource: false,
        },
        {
          taskId: tSource,
          groupId,
          groupRole: "SOURCE",
          publishedRecordCount: 5,
          hasLeftoverSource: true,
        },
        {
          taskId: tHistorical,
          groupId,
          groupRole: "SOURCE",
          publishedRecordCount: 1,
          hasLeftoverSource: false,
        },
        {
          taskId: tDetached,
          groupId: null,
          groupRole: null,
          publishedRecordCount: 0,
          hasLeftoverSource: false,
        },
        {
          taskId: tModule,
          groupId: null,
          groupRole: null,
          publishedRecordCount: 0,
          hasLeftoverSource: false,
        },
        {
          taskId: ungroupedWithRecord,
          groupId: null,
          groupRole: null,
          publishedRecordCount: 1,
          hasLeftoverSource: false,
        },
      ],
    });

    const unknown = await getJson(
      "/api/v1/task-groups/memberships?taskIds=2147483647",
      memberCookie,
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ items: [] });
  });

  test("无权项目的聚合关系不返回，也不泄露存在性", async () => {
    const foreignMain = await newTask(otherProject!, {
      assigneeIds: [otherUser],
    });
    const foreignSource = await newTask(otherProject!, {
      assigneeIds: [otherUser],
    });
    const joinedAt = new Date(Date.now() - 60_000).toISOString();
    const foreignGroupId = await seedTaskGroup(otherProject!, 9, "外部聚合组", [
      { joinedAt, role: "MAIN", taskId: foreignMain },
      { joinedAt, role: "SOURCE", taskId: foreignSource },
    ]);

    const hidden = await getJson(
      "/api/v1/task-groups/memberships?taskIds=" + String(foreignMain),
      memberCookie,
    );
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ items: [] });

    const visible = await getJson(
      "/api/v1/task-groups/memberships?taskIds=" +
        [foreignMain, foreignSource].join(","),
      otherCookie,
    );
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({
      items: [
        {
          taskId: foreignMain,
          groupId: foreignGroupId,
          groupRole: "MAIN",
          publishedRecordCount: 0,
          hasLeftoverSource: false,
        },
        {
          taskId: foreignSource,
          groupId: foreignGroupId,
          groupRole: "SOURCE",
          publishedRecordCount: 0,
          hasLeftoverSource: false,
        },
      ],
    });
  });

  test("taskIds 数量、格式与重复校验失败统一 422，匿名 401", async () => {
    await expectError(
      "/api/v1/task-groups/memberships?taskIds=" + String(tMain),
      undefined,
      401,
      "TASK_GROUP_MEMBERSHIP_UNAUTHENTICATED",
    );
    await expectError(
      "/api/v1/task-groups/memberships",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/task-groups/memberships?taskIds=",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/task-groups/memberships?taskIds=abc",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/task-groups/memberships?taskIds=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/task-groups/memberships?taskIds=1,1",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    const tooMany = Array.from({ length: 101 }, (_, index) =>
      String(index + 1),
    ).join(",");
    await expectError(
      "/api/v1/task-groups/memberships?taskIds=" + tooMany,
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });
});

// 2026-09-24 产品定案（原文「遗留问题只会在同优先级里面高一点……以后不管是别人拉取
// 还是，都要以这个为准」）：遗留问题来源是优先级之后的独立一级，只在同优先级内部提前，
// 绝不越过更高优先级的任务。这条口径在 2026-09-24 的两条并行开发线合并时曾被改成
// 「并回紧急桶、排在已逾期之后」（v6），本用例就是防止再次翻回去的 HTTP 级回归网。
// 单独建项目夹具并显式带 projectId，避免影响同文件其它用例的期望集合。
describe("GET /api/v1/me/tasks 排序口径：遗留问题来源只在同优先级内提前", () => {
  test("高优先级任务不被普通优先级的遗留问题来源越过，同优先级内遗留问题来源排前", async () => {
    const scope = await createProject(runtime!.sql, memberUser);
    // 创建顺序刻意与期望顺序相反：先建同优先级的对照任务，再建遗留问题来源，
    // 最后建更高优先级的任务。若遗留问题来源重新并回紧急桶，普通优先级的
    // leftoverSource 会压住更高优先级的 plainHigh，下面的顺序断言立即失败。
    const normalPlain = await newTask(scope, { title: "同优先级对照" });
    const recordId = await newPublishedRecord(scope);
    const leftoverId = await newLeftover(scope, recordId, {
      content: "排序口径回归夹具",
      createdAt: new Date().toISOString(),
    });
    const leftoverSource = await newTask(scope, { title: "遗留问题来源" });
    await runtime!
      .sql`INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by)
      VALUES (${leftoverId}, ${leftoverSource}, ${scope.projectId}, ${scope.userId})`;
    const plainHigh = await newTask(scope, {
      priority: "HIGH",
      title: "高优先级对照",
    });

    const response = await getJson(
      "/api/v1/me/tasks?projectId=" + String(scope.projectId),
      memberCookie,
    );
    expect(response.status).toBe(200);
    const page = myTaskPageSchema.parse(response.body);
    expect(page.items.map((item) => item.taskId)).toEqual([
      plainHigh,
      leftoverSource,
      normalPlain,
    ]);
    const leftoverSourceByTask = new Map(
      page.items.map((item) => [item.taskId, item.hasLeftoverSource]),
    );
    expect(leftoverSourceByTask.get(leftoverSource)).toBe(true);
    expect(leftoverSourceByTask.get(plainHigh)).toBe(false);
    expect(leftoverSourceByTask.get(normalPlain)).toBe(false);

    // 分页时同一把尺子：limit=1 逐页取，顺序与不分页一致，游标不重不漏。
    const collected: number[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const suffix =
        cursor === null ? "" : "&cursor=" + encodeURIComponent(cursor);
      const pagedResponse = await getJson(
        "/api/v1/me/tasks?projectId=" +
          String(scope.projectId) +
          "&limit=1" +
          suffix,
        memberCookie,
      );
      expect(pagedResponse.status).toBe(200);
      const paged = myTaskPageSchema.parse(pagedResponse.body);
      collected.push(...paged.items.map((item) => item.taskId));
      cursor = paged.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(collected).toEqual([plainHigh, leftoverSource, normalPlain]);
  });
});

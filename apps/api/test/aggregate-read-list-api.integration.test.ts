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
  leftoverItemPageSchema,
  taskGroupDetailResponseSchema,
  taskGroupListPageSchema,
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

// F-20 遗留问题列表（R-6）与任务聚合组列表（R-7）的真实 HTTP 集成测试：
// 授权范围固定为服务端 AuthorizedProjectScope（非成员收敛为空页而非 404）、
// 分桶与跨项目隔离、keyset 分页与签名游标绑定（actor + filterKey）、
// 最新版本快照内容、来源/跟进任务引用、聚合组分支排序与 DETACHED 排除。
// 全部在真实 PostgreSQL 上验证，不使用 mock。

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
let keyringDirectory: string | undefined;
let idempotencyKeyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sequence = 0;

const baseMs = Date.now();

function isoAt(minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

function isoBefore(minutes: number): string {
  return new Date(baseMs - minutes * 60_000).toISOString();
}

let project: ProjectFixture | undefined;
let otherProject: ProjectFixture | undefined;
let memberUser = 0;
let otherUser = 0;
let outsiderUser = 0;
let foreignUser = 0;
let memberCookie = "";
let otherCookie = "";
let outsiderCookie = "";
let foreignCookie = "";

let tSourceA = 0;
let tSourceB = 0;
let tFollowup = 0;

let rLinked = 0;
let rOrphan = 0;
let rConverted = 0;
let rResolved = 0;
let rVoid = 0;
let rOther = 0;

let loLinked = 0;
let loOrphan = 0;
let loConverted = 0;
let loResolved = 0;
let loVoid = 0;
let loOther = 0;

let tGroupMain = 0;
let tGroupSource = 0;
let tGroupHistorical = 0;
let tGroupDetached = 0;
let tClosedDetached = 0;
let tOtherMain = 0;
let tOtherSource = 0;
let tForeignMain = 0;
let tForeignSource = 0;
let tOwnSecondMain = 0;
let tOwnSecondSource = 0;
let tSourceOnlyMain = 0;
let tSourceOnlySource = 0;
let groupActive = 0;
let groupClosed = 0;
let groupOther = 0;
let groupForeign = 0;
let groupOwnSecond = 0;
let groupSourceOnly = 0;

const taskWrites = new TaskManagementRepository();
const draftWrites = new RecordDraftRepository();

const recordContent = {
  title: "聚合读列表接口记录",
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
      scope.userId,
      code,
      {
        title: options.title ?? "聚合读列表接口任务",
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
            workStatus === "DONE" ? "聚合读列表接口夹具完成" : null,
            "聚合读列表接口夹具",
          ))!;
    if ((options.lifecycleStatus ?? "ACTIVE") !== "ACTIVE") {
      await tx.sql`UPDATE app.tasks SET lifecycle_status = ${options.lifecycleStatus!}, updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = ${current.id} AND project_id = ${scope.projectId}`;
    }
    return current.id;
  });
}

interface RecordOptions {
  readonly taskId?: number | null;
  readonly publishedAt?: string;
  readonly status?: "PUBLISHED" | "VOID";
}

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
      await tx.sql`UPDATE app.change_records SET status = ${"VOID"}, voided_at = GREATEST(clock_timestamp(), published_at), void_reason = ${"聚合读列表接口夹具作废"}, row_version = row_version + 1 WHERE id = ${draft.id} AND project_id = ${scope.projectId}`;
    }
  });
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

interface LeftoverOptions {
  readonly content: string;
  readonly createdAt: string;
  readonly status?: "ACTIVE" | "CONVERTED" | "RESOLVED";
}

async function newLeftover(
  scope: ProjectFixture,
  recordId: number,
  options: LeftoverOptions,
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

async function newLeftoverSnapshotVersion(
  scope: ProjectFixture,
  recordId: number,
  versionNo: number,
  leftoverItemId: number,
  content: string,
): Promise<void> {
  await uow!.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_version_leftovers (record_id, version_no, leftover_item_id, project_id, content_snapshot) VALUES (${recordId}, ${versionNo}, ${leftoverItemId}, ${scope.projectId}, ${content})`;
  });
}

async function taskCode(
  taskId: number,
  scope: ProjectFixture,
): Promise<string> {
  const [row] = await runtime!.sql<{ code: string }[]>`
    SELECT code FROM app.tasks WHERE id = ${taskId} AND project_id = ${scope.projectId}
  `;
  if (!row) throw new Error("task fixture missing");
  return row.code;
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

async function seedTaskGroup(
  scope: ProjectFixture,
  codeIndex: number,
  name: string,
  members: readonly GroupMemberSeed[],
  status: "ACTIVE" | "CLOSED" = "ACTIVE",
): Promise<number> {
  return uow!.run(async (tx) => {
    const [group] = await tx.sql<{ id: number }[]>`
      INSERT INTO app.task_groups (project_id, code, name, created_by, status, closed_at)
      VALUES (${scope.projectId}, ${scope.code + "-TG-" + String(codeIndex)}, ${name}, ${scope.userId}, ${status}, ${status === "CLOSED" ? new Date().toISOString() : null}::timestamptz)
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

/**
 * 直改项目状态：ADR-043 要求切维护中前不存在未完成任务，本文件要覆盖「维护中仍有
 * 卡片来源」的展示口径，因此绕过 API 直接改库；row_version 必须 +1（0001 触发器）。
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
    applicationName: "inpulse-aggregate-read-list-api-test",
  });
  await migrate(urls.migrator);
  uow = new PostgresUnitOfWork(runtime);

  memberUser = await createUser(runtime.sql);
  otherUser = await createUser(runtime.sql);
  outsiderUser = await createUser(runtime.sql);
  foreignUser = await createUser(runtime.sql);
  const projectFixture = await createProject(runtime.sql, memberUser);
  project = projectFixture;
  const otherFixture = await createProject(runtime.sql, otherUser);
  otherProject = otherFixture;
  // R-7 可见性收窄夹具（2026-09-22）：项目内另一名成员，用于验证「他人负责的组不返回」。
  await runtime.sql`
    INSERT INTO app.project_members (project_id, user_id, role)
    VALUES (${projectFixture.projectId}, ${foreignUser}, ${"MEMBER"})
  `;

  await newModule(projectFixture, "遗留模块");
  tSourceA = await newTask(projectFixture, {
    title: "遗留来源任务A",
  });
  tSourceB = await newTask(projectFixture, {
    title: "遗留来源任务B",
  });
  tFollowup = await newTask(projectFixture, {
    title: "遗留跟进任务",
  });

  tGroupMain = await newTask(projectFixture, {
    title: "聚合组主任务",
    priority: "HIGH",
    dueAt: isoAt(9),
  });
  tGroupSource = await newTask(projectFixture, {
    title: "聚合组活动来源",
    workStatus: "DONE",
    dueAt: isoAt(7),
  });
  tGroupHistorical = await newTask(projectFixture, {
    title: "聚合组历史来源",
    workStatus: "CANCELED",
    priority: "NORMAL",
  });
  tGroupDetached = await newTask(projectFixture, { title: "聚合组已解除来源" });
  tClosedDetached = await newTask(projectFixture, { title: "已关闭组来源" });
  tOtherMain = await newTask(otherFixture, { title: "其他项目主任务" });
  tOtherSource = await newTask(otherFixture, { title: "其他项目来源任务" });

  rLinked = await newPublishedRecord(projectFixture, {
    publishedAt: isoAt(1),
    taskId: tSourceA,
  });
  rOrphan = await newPublishedRecord(projectFixture, { publishedAt: isoAt(2) });
  rConverted = await newPublishedRecord(projectFixture, {
    publishedAt: isoAt(3),
    taskId: tSourceB,
  });
  rResolved = await newPublishedRecord(projectFixture, {
    publishedAt: isoAt(4),
  });
  rVoid = await newPublishedRecord(projectFixture, {
    publishedAt: isoAt(5),
    status: "VOID",
    taskId: tSourceB,
  });
  rOther = await newPublishedRecord(otherFixture, { publishedAt: isoAt(6) });

  loLinked = await newLeftover(projectFixture, rLinked, {
    content: "遗留-有关联来源任务",
    createdAt: isoAt(1),
  });
  loOrphan = await newLeftover(projectFixture, rOrphan, {
    content: "遗留-模块级无来源任务",
    createdAt: isoAt(2),
  });
  loConverted = await newLeftover(projectFixture, rConverted, {
    content: "遗留-已生成跟进任务",
    createdAt: isoAt(3),
    status: "CONVERTED",
  });
  loResolved = await newLeftover(projectFixture, rResolved, {
    content: "遗留-已解决无跟进",
    createdAt: isoAt(4),
    status: "RESOLVED",
  });
  loVoid = await newLeftover(projectFixture, rVoid, {
    content: "遗留-作废记录",
    createdAt: isoAt(5),
  });
  loOther = await newLeftover(otherFixture, rOther, {
    content: "其他项目遗留",
    createdAt: isoAt(6),
  });
  await runtime.sql`
    INSERT INTO app.leftover_task_links (leftover_item_id, task_id, project_id, created_by)
    VALUES (${loConverted}, ${tFollowup}, ${projectFixture.projectId}, ${projectFixture.userId})
  `;
  await newRecordVersion(projectFixture, rLinked, 2);
  await newLeftoverSnapshotVersion(
    projectFixture,
    rLinked,
    2,
    loLinked,
    "最新快照内容：遗留-有关联来源任务",
  );

  groupActive = await seedTaskGroup(projectFixture, 1, "遗留聚合组", [
    { joinedAt: isoBefore(300), role: "MAIN", taskId: tGroupMain },
    {
      joinedAt: isoBefore(200),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      taskId: tGroupSource,
    },
    {
      joinedAt: isoBefore(100),
      role: "SOURCE",
      sourceKind: "HISTORICAL",
      taskId: tGroupHistorical,
    },
    {
      detachReason: "遗留夹具解除来源关系",
      detachedAt: isoBefore(40),
      joinedAt: isoBefore(50),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      status: "DETACHED",
      taskId: tGroupDetached,
    },
  ]);
  groupClosed = await seedTaskGroup(
    projectFixture,
    2,
    "已关闭聚合组",
    [
      {
        detachReason: "遗留夹具关闭聚合组",
        detachedAt: isoBefore(10),
        joinedAt: isoBefore(400),
        role: "SOURCE",
        sourceKind: "ACTIVE",
        status: "DETACHED",
        taskId: tClosedDetached,
      },
    ],
    "CLOSED",
  );
  groupOther = await seedTaskGroup(otherFixture, 1, "其他项目聚合组", [
    { joinedAt: isoBefore(300), role: "MAIN", taskId: tOtherMain },
    {
      joinedAt: isoBefore(200),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      taskId: tOtherSource,
    },
  ]);

  // R-7 可见性收窄夹具（2026-09-22）：他人负责的活跃组、仅作为来源负责人的组与本人第二个组。
  tForeignMain = await newTask(projectFixture, {
    assigneeIds: [foreignUser],
    title: "他人聚合组主任务",
  });
  tForeignSource = await newTask(projectFixture, {
    assigneeIds: [foreignUser],
    title: "他人聚合组来源任务",
  });
  groupForeign = await seedTaskGroup(projectFixture, 3, "他人聚合组", [
    { joinedAt: isoBefore(300), role: "MAIN", taskId: tForeignMain },
    {
      joinedAt: isoBefore(200),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      taskId: tForeignSource,
    },
  ]);
  tOwnSecondMain = await newTask(projectFixture, {
    title: "本人第二个组主任务",
  });
  tOwnSecondSource = await newTask(projectFixture, {
    title: "本人第二个组来源任务",
  });
  groupOwnSecond = await seedTaskGroup(projectFixture, 4, "本人第二个聚合组", [
    { joinedAt: isoBefore(120), role: "MAIN", taskId: tOwnSecondMain },
    {
      joinedAt: isoBefore(100),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      taskId: tOwnSecondSource,
    },
  ]);
  tSourceOnlyMain = await newTask(projectFixture, {
    assigneeIds: [foreignUser],
    title: "来源负责人本人组主任务",
  });
  tSourceOnlySource = await newTask(projectFixture, {
    title: "来源负责人本人组来源任务",
  });
  groupSourceOnly = await seedTaskGroup(projectFixture, 5, "来源负责人本人组", [
    { joinedAt: isoBefore(300), role: "MAIN", taskId: tSourceOnlyMain },
    {
      joinedAt: isoBefore(200),
      role: "SOURCE",
      sourceKind: "ACTIVE",
      taskId: tSourceOnlySource,
    },
  ]);

  const sessionKey = randomBytes(32);
  const sessionKeyring = VersionedHmacKeyring.fromEntries(
    [{ key: sessionKey, version: 1 }],
    1,
  );
  keyringDirectory = await mkdtemp(
    join(tmpdir(), "inpulse-aggregate-read-list-"),
  );
  const sessionKeyringFile = join(keyringDirectory, "session.keyring");
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
  foreignCookie = (
    await createAuthenticatedSession(runtime.sql, sessionKeyring, foreignUser)
  ).cookie;

  idempotencyKeyringDirectory = await mkdtemp(
    join(tmpdir(), "inpulse-aggregate-read-list-idempotency-"),
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
  app = await NestFactory.create(AppModule, { logger: ["error"] });
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

describe("GET /api/v1/leftover-items（R-6 遗留问题列表）", () => {
  test("匿名 401，非成员与越权项目收敛为空页，非法参数 422", async () => {
    await expectError(
      "/api/v1/leftover-items",
      undefined,
      401,
      "LEFTOVER_ITEMS_UNAUTHENTICATED",
    );
    const outsider = await getJson("/api/v1/leftover-items", outsiderCookie);
    expect(outsider.status).toBe(200);
    expect(leftoverItemPageSchema.parse(outsider.body)).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });

    const otherScoped = await getJson(
      "/api/v1/leftover-items?projectId=" + String(otherProject!.projectId),
      memberCookie,
    );
    expect(otherScoped.status).toBe(200);
    expect(leftoverItemPageSchema.parse(otherScoped.body).items).toEqual([]);

    const unknownScoped = await getJson(
      "/api/v1/leftover-items?projectId=2147483647",
      memberCookie,
    );
    expect(unknownScoped.status).toBe(200);
    expect(leftoverItemPageSchema.parse(unknownScoped.body).items).toEqual([]);

    await expectError(
      "/api/v1/leftover-items?bucket=ALL",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/leftover-items?limit=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/leftover-items?projectId=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("成员按 id 倒序看到全部遗留项，内容取最新快照，任务引用只含 ID 与编号", async () => {
    const response = await getJson("/api/v1/leftover-items", memberCookie);
    expect(response.status).toBe(200);
    const page = leftoverItemPageSchema.parse(response.body);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.leftoverItemId)).toEqual([
      loVoid,
      loResolved,
      loConverted,
      loOrphan,
      loLinked,
    ]);

    const linked = page.items[4]!;
    expect(linked).toMatchObject({
      content: "最新快照内容：遗留-有关联来源任务",
      moduleId: project!.moduleId,
      moduleName: "未分类",
      projectId: project!.projectId,
      projectName: "Project " + project!.code,
      recordId: rLinked,
      recordTitle: "聚合读列表接口记录",
      status: "ACTIVE",
    });
    expect(linked.author.userId).toBe(memberUser);
    expect(linked.sourceTask).toEqual({
      taskId: tSourceA,
      code: await taskCode(tSourceA, project!),
      projectId: project!.projectId,
      moduleId: project!.moduleId,
    });
    expect(linked.followupTask).toBeNull();
    expect(linked.publishedAt).toBe(isoAt(1));

    const orphan = page.items[3]!;
    expect(orphan).toMatchObject({
      recordId: rOrphan,
      status: "ACTIVE",
    });
    expect(orphan.sourceTask).toBeNull();
    expect(orphan.followupTask).toBeNull();

    const converted = page.items[2]!;
    expect(converted).toMatchObject({
      recordId: rConverted,
      status: "CONVERTED",
    });
    expect(converted.sourceTask).toEqual({
      taskId: tSourceB,
      code: await taskCode(tSourceB, project!),
      projectId: project!.projectId,
      moduleId: project!.moduleId,
    });
    expect(converted.followupTask).toEqual({
      taskId: tFollowup,
      code: await taskCode(tFollowup, project!),
      projectId: project!.projectId,
      moduleId: project!.moduleId,
    });

    const resolved = page.items[1]!;
    expect(resolved).toMatchObject({ recordId: rResolved, status: "RESOLVED" });
    expect(resolved.sourceTask).toBeNull();
    expect(resolved.followupTask).toBeNull();

    const voided = page.items[0]!;
    expect(voided).toMatchObject({ recordId: rVoid, status: "VOIDED" });
    expect(voided.sourceTask).toEqual({
      taskId: tSourceB,
      code: await taskCode(tSourceB, project!),
      projectId: project!.projectId,
      moduleId: project!.moduleId,
    });
    expect(voided.followupTask).toBeNull();
  });

  test("bucket=OPEN 只含 PUBLISHED 记录的 ACTIVE 项，bucket=CLOSED 含已处理与父记录作废的项", async () => {
    const open = leftoverItemPageSchema.parse(
      (await getJson("/api/v1/leftover-items?bucket=OPEN", memberCookie)).body,
    );
    expect(open.items.map((item) => item.leftoverItemId)).toEqual([
      loOrphan,
      loLinked,
    ]);
    expect(open.items.map((item) => item.status)).toEqual(["ACTIVE", "ACTIVE"]);

    const closed = leftoverItemPageSchema.parse(
      (await getJson("/api/v1/leftover-items?bucket=CLOSED", memberCookie))
        .body,
    );
    expect(closed.items.map((item) => item.leftoverItemId)).toEqual([
      loVoid,
      loResolved,
      loConverted,
    ]);
    expect(closed.items.map((item) => item.status)).toEqual([
      "VOIDED",
      "RESOLVED",
      "CONVERTED",
    ]);

    const narrowed = leftoverItemPageSchema.parse(
      (
        await getJson(
          "/api/v1/leftover-items?bucket=OPEN&projectId=" +
            String(project!.projectId),
          memberCookie,
        )
      ).body,
    );
    expect(narrowed.items.map((item) => item.leftoverItemId)).toEqual([
      loOrphan,
      loLinked,
    ]);
  });

  test("keyset 分页稳定，游标绑定 actor 与筛选条件，跨筛选或跨用户复用 422", async () => {
    const first = leftoverItemPageSchema.parse(
      (await getJson("/api/v1/leftover-items?limit=2", memberCookie)).body,
    );
    expect(first.items.map((item) => item.leftoverItemId)).toEqual([
      loVoid,
      loResolved,
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = leftoverItemPageSchema.parse(
      (
        await getJson(
          "/api/v1/leftover-items?limit=2&cursor=" +
            encodeURIComponent(first.nextCursor!),
          memberCookie,
        )
      ).body,
    );
    expect(second.items.map((item) => item.leftoverItemId)).toEqual([
      loConverted,
      loOrphan,
    ]);
    expect(second.hasMore).toBe(true);

    const third = leftoverItemPageSchema.parse(
      (
        await getJson(
          "/api/v1/leftover-items?limit=2&cursor=" +
            encodeURIComponent(second.nextCursor!),
          memberCookie,
        )
      ).body,
    );
    expect(third.items.map((item) => item.leftoverItemId)).toEqual([loLinked]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    await expectError(
      "/api/v1/leftover-items?bucket=OPEN&cursor=" +
        encodeURIComponent(first.nextCursor!),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/leftover-items?cursor=" + encodeURIComponent(first.nextCursor!),
      otherCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/leftover-items?cursor=broken",
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    const tampered =
      first.nextCursor!.slice(0, -2) +
      (first.nextCursor!.endsWith("A") ? "B" : "A");
    await expectError(
      "/api/v1/leftover-items?cursor=" + encodeURIComponent(tampered),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
  });

  test("记录作废时遗留项派生为 VOIDED，恢复 PUBLISHED 后回到原状态并保留跟进", async () => {
    const projectId = project!.projectId;
    const setVoid = async (recordId: number) => {
      await runtime!.sql`
        UPDATE app.change_records
           SET status = 'VOID',
               voided_at = GREATEST(clock_timestamp(), published_at),
               void_reason = '遗留状态回归夹具',
               row_version = row_version + 1,
               updated_at = GREATEST(clock_timestamp(), updated_at)
         WHERE id = ${recordId} AND project_id = ${projectId}
      `;
    };
    const setPublished = async (recordId: number) => {
      await runtime!.sql`
        UPDATE app.change_records
           SET status = 'PUBLISHED',
               row_version = row_version + 1,
               updated_at = GREATEST(clock_timestamp(), updated_at)
         WHERE id = ${recordId} AND project_id = ${projectId}
      `;
    };

    try {
      await setPublished(rVoid);
      const reopened = leftoverItemPageSchema.parse(
        (await getJson("/api/v1/leftover-items?bucket=OPEN", memberCookie))
          .body,
      );
      expect(
        reopened.items.find((item) => item.leftoverItemId === loVoid)?.status,
      ).toBe("ACTIVE");

      await setVoid(rResolved);
      const closedResolvedVoided = leftoverItemPageSchema.parse(
        (await getJson("/api/v1/leftover-items?bucket=CLOSED", memberCookie))
          .body,
      );
      expect(
        closedResolvedVoided.items.find(
          (item) => item.leftoverItemId === loResolved,
        )?.status,
      ).toBe("VOIDED");
      await setPublished(rResolved);
      const restoredResolved = leftoverItemPageSchema.parse(
        (await getJson("/api/v1/leftover-items?bucket=CLOSED", memberCookie))
          .body,
      );
      expect(
        restoredResolved.items.find(
          (item) => item.leftoverItemId === loResolved,
        )?.status,
      ).toBe("RESOLVED");

      await setVoid(rConverted);
      const closedWhileVoided = leftoverItemPageSchema.parse(
        (await getJson("/api/v1/leftover-items?bucket=CLOSED", memberCookie))
          .body,
      );
      expect(
        closedWhileVoided.items.find(
          (item) => item.leftoverItemId === loConverted,
        )?.status,
      ).toBe("VOIDED");
      const openWhileVoided = leftoverItemPageSchema.parse(
        (await getJson("/api/v1/leftover-items?bucket=OPEN", memberCookie))
          .body,
      );
      expect(
        openWhileVoided.items.map((item) => item.leftoverItemId),
      ).not.toContain(loConverted);

      await setPublished(rConverted);
      const restored = leftoverItemPageSchema.parse(
        (await getJson("/api/v1/leftover-items?bucket=CLOSED", memberCookie))
          .body,
      );
      const restoredConverted = restored.items.find(
        (item) => item.leftoverItemId === loConverted,
      );
      expect(restoredConverted).toMatchObject({ status: "CONVERTED" });
      expect(restoredConverted?.followupTask).toEqual({
        taskId: tFollowup,
        code: await taskCode(tFollowup, project!),
        projectId,
        moduleId: project!.moduleId,
      });
    } finally {
      await setVoid(rVoid);
      await setPublished(rConverted);
      await setPublished(rResolved);
    }
  });

  test("其他项目成员只看到自己项目的遗留项", async () => {
    const page = leftoverItemPageSchema.parse(
      (await getJson("/api/v1/leftover-items", otherCookie)).body,
    );
    expect(page.items.map((item) => item.leftoverItemId)).toEqual([loOther]);
    expect(page.items[0]!.projectId).toBe(otherProject!.projectId);
    expect(page.items[0]!.projectName).toBe("Project " + otherProject!.code);
  });
});

describe("GET /api/v1/task-groups（R-7 任务聚合组列表）", () => {
  test("匿名 401，非成员与越权项目收敛为空页，非法参数 422", async () => {
    await expectError(
      "/api/v1/task-groups",
      undefined,
      401,
      "TASK_GROUP_UNAUTHENTICATED",
    );
    const outsider = await getJson("/api/v1/task-groups", outsiderCookie);
    expect(outsider.status).toBe(200);
    expect(taskGroupListPageSchema.parse(outsider.body)).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });

    const scoped = taskGroupListPageSchema.parse(
      (
        await getJson(
          "/api/v1/task-groups?projectId=" + String(otherProject!.projectId),
          memberCookie,
        )
      ).body,
    );
    expect(scoped.items).toEqual([]);

    await expectError(
      "/api/v1/task-groups?limit=0",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
    await expectError(
      "/api/v1/task-groups?projectId=-1",
      memberCookie,
      422,
      "VALIDATION_FAILED",
    );
  });

  test("成员按组 ID 倒序看到聚合组，分支主任务在前且 DETACHED 不出现", async () => {
    const response = await getJson("/api/v1/task-groups", memberCookie);
    expect(response.status).toBe(200);
    const page = taskGroupListPageSchema.parse(response.body);
    expect(page.items.map((group) => group.groupId)).toEqual([
      groupSourceOnly,
      groupOwnSecond,
      groupActive,
    ]);

    const active = page.items[2]!;
    expect(active).toMatchObject({
      code: project!.code + "-TG-1",
      name: "遗留聚合组",
      projectId: project!.projectId,
      projectName: "Project " + project!.code,
      status: "ACTIVE",
    });
    expect(active.mainTask).toEqual({
      taskId: tGroupMain,
      code: await taskCode(tGroupMain, project!),
      projectId: project!.projectId,
      moduleId: project!.moduleId,
    });
    expect(
      active.branches.map((branch) => [
        branch.taskId,
        branch.role,
        branch.sourceKind,
        branch.workStatus,
        branch.priority,
        branch.moduleId,
        branch.moduleName,
        branch.dueAt,
        branch.publishedRecordCount,
      ]),
    ).toEqual([
      [
        tGroupMain,
        "MAIN",
        null,
        "TODO",
        "HIGH",
        project!.moduleId,
        "未分类",
        isoAt(9),
        0,
      ],
      [
        tGroupSource,
        "SOURCE",
        "ACTIVE",
        "DONE",
        "NORMAL",
        project!.moduleId,
        "未分类",
        isoAt(7),
        0,
      ],
      [
        tGroupHistorical,
        "SOURCE",
        "HISTORICAL",
        "CANCELED",
        "NORMAL",
        project!.moduleId,
        "未分类",
        null,
        0,
      ],
    ]);
    const mainBranch = active.branches[0]!;
    expect(mainBranch.title).toBe("聚合组主任务");
    expect(mainBranch.taskCode).toBe(await taskCode(tGroupMain, project!));
    expect(mainBranch.assignee.userId).toBe(memberUser);
  });

  test("只返回当前用户是活跃分支负责人的聚合组（2026-09-22 可见性收窄）", async () => {
    const own = taskGroupListPageSchema.parse(
      (await getJson("/api/v1/task-groups", memberCookie)).body,
    );
    // 本人作为主任务负责人（TG-1 / TG-4）与作为来源任务负责人（TG-5）都可见；
    // 他人负责的活跃组（TG-3）与已关闭组（TG-2）不返回。
    expect(own.items.map((group) => group.groupId)).toEqual([
      groupSourceOnly,
      groupOwnSecond,
      groupActive,
    ]);
    expect(own.items.map((group) => group.groupId)).not.toContain(groupForeign);
    expect(own.items.map((group) => group.groupId)).not.toContain(groupClosed);

    const foreign = taskGroupListPageSchema.parse(
      (await getJson("/api/v1/task-groups", foreignCookie)).body,
    );
    // 同一项目内另一名成员：只能看到主任务在自己名下的组，以及自己作为来源负责人的组。
    expect(foreign.items.map((group) => group.groupId)).toEqual([
      groupSourceOnly,
      groupForeign,
    ]);
    expect(foreign.items.map((group) => group.groupId)).not.toContain(
      groupActive,
    );

    const scoped = taskGroupListPageSchema.parse(
      (
        await getJson(
          "/api/v1/task-groups?projectId=" + String(project!.projectId),
          foreignCookie,
        )
      ).body,
    );
    expect(scoped.items.map((group) => group.groupId)).toEqual([
      groupSourceOnly,
      groupForeign,
    ]);
  });

  test("已关闭聚合组列表不返回，R-1 详情仍可见全部成员", async () => {
    for (const cookie of [memberCookie, foreignCookie]) {
      const page = taskGroupListPageSchema.parse(
        (await getJson("/api/v1/task-groups", cookie)).body,
      );
      expect(page.items.map((group) => group.groupId)).not.toContain(
        groupClosed,
      );
    }
    // 关闭组在关闭时已解除全部成员，列表按活跃分支负责人过滤后不再返回；
    // 详情（R-1）仍按项目成员关系可读，组与历史成员不丢。
    const detail = taskGroupDetailResponseSchema.parse(
      (
        await getJson(
          "/api/v1/task-groups/" + String(groupClosed),
          memberCookie,
        )
      ).body,
    );
    expect(detail.group).toMatchObject({
      groupId: groupClosed,
      status: "CLOSED",
    });
    expect(
      detail.members.map((member) => [member.taskId, member.memberStatus]),
    ).toEqual([[tClosedDetached, "DETACHED"]]);
  });

  test("分页与游标绑定：跨 projectId 复用或跨用户复用游标一律 422", async () => {
    const first = taskGroupListPageSchema.parse(
      (await getJson("/api/v1/task-groups?limit=1", memberCookie)).body,
    );
    expect(first.items.map((group) => group.groupId)).toEqual([
      groupSourceOnly,
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = taskGroupListPageSchema.parse(
      (
        await getJson(
          "/api/v1/task-groups?limit=1&cursor=" +
            encodeURIComponent(first.nextCursor!),
          memberCookie,
        )
      ).body,
    );
    expect(second.items.map((group) => group.groupId)).toEqual([
      groupOwnSecond,
    ]);
    expect(second.hasMore).toBe(true);
    expect(second.nextCursor).not.toBeNull();

    const third = taskGroupListPageSchema.parse(
      (
        await getJson(
          "/api/v1/task-groups?limit=1&cursor=" +
            encodeURIComponent(second.nextCursor!),
          memberCookie,
        )
      ).body,
    );
    expect(third.items.map((group) => group.groupId)).toEqual([groupActive]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    await expectError(
      "/api/v1/task-groups?projectId=" +
        String(project!.projectId) +
        "&cursor=" +
        encodeURIComponent(first.nextCursor!),
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/task-groups?cursor=" + encodeURIComponent(first.nextCursor!),
      otherCookie,
      422,
      "INVALID_CURSOR",
    );
    await expectError(
      "/api/v1/task-groups?cursor=broken",
      memberCookie,
      422,
      "INVALID_CURSOR",
    );
  });

  test("其他项目成员只看到自己项目的聚合组", async () => {
    const page = taskGroupListPageSchema.parse(
      (await getJson("/api/v1/task-groups", otherCookie)).body,
    );
    expect(page.items.map((group) => group.groupId)).toEqual([groupOther]);
    expect(
      page.items[0]!.branches.map((branch) => [branch.taskId, branch.role]),
    ).toEqual([
      [tOtherMain, "MAIN"],
      [tOtherSource, "SOURCE"],
    ]);
  });

  test("维护中项目不再产出聚合组卡片，R-1 详情仍可读（2026-09-30 口径）", async () => {
    const maintenanceProject = await createProject(runtime!.sql, memberUser);
    const maintenanceTask = await newTask(maintenanceProject, {
      title: "维护中聚合组主任务",
    });
    const maintenanceSource = await newTask(maintenanceProject, {
      title: "维护中聚合组来源任务",
    });
    const maintenanceGroup = await seedTaskGroup(
      maintenanceProject,
      1,
      "维护中聚合组",
      [
        { taskId: maintenanceTask, role: "MAIN", joinedAt: isoAt(1) },
        { taskId: maintenanceSource, role: "SOURCE", joinedAt: isoAt(2) },
      ],
    );
    const scoped =
      "/api/v1/task-groups?projectId=" + String(maintenanceProject.projectId);

    const before = taskGroupListPageSchema.parse(
      (await getJson(scoped, memberCookie)).body,
    );
    expect(before.items.map((group) => group.groupId)).toEqual([
      maintenanceGroup,
    ]);

    await setProjectStatus(maintenanceProject.projectId, "MAINTENANCE");

    const hidden = taskGroupListPageSchema.parse(
      (await getJson(scoped, memberCookie)).body,
    );
    expect(hidden).toEqual({ items: [], nextCursor: null, hasMore: false });

    const all = taskGroupListPageSchema.parse(
      (await getJson("/api/v1/task-groups", memberCookie)).body,
    );
    expect(all.items.map((group) => group.groupId)).not.toContain(
      maintenanceGroup,
    );

    // 只有列表被收窄：R-1 详情不按项目状态过滤，任务看板与模块任务入口不受影响。
    const detail = taskGroupDetailResponseSchema.parse(
      (
        await getJson(
          "/api/v1/task-groups/" + String(maintenanceGroup),
          memberCookie,
        )
      ).body,
    );
    expect(detail.group).toMatchObject({
      groupId: maintenanceGroup,
      status: "ACTIVE",
    });
    expect(detail.members).toHaveLength(2);
    expect(detail.members.map((member) => member.taskId)).toEqual(
      expect.arrayContaining([maintenanceTask, maintenanceSource]),
    );

    await setProjectStatus(maintenanceProject.projectId, "ACTIVE");

    const restored = taskGroupListPageSchema.parse(
      (await getJson(scoped, memberCookie)).body,
    );
    expect(restored.items.map((group) => group.groupId)).toEqual([
      maintenanceGroup,
    ]);
  });
});

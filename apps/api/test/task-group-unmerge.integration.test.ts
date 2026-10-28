import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import { randomBytes, randomUUID } from "node:crypto";
import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { schemaRegistry } from "@inpulse/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresTaskQueryPort } from "../src/modules/tasks/task-query.port.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { TaskGroupRepository } from "../src/modules/task-groups/task-group.repository.js";
import { TaskGroupsService } from "../src/modules/task-groups/task-groups.service.js";
import { TaskGroupsHttpService } from "../src/modules/task-groups/task-groups-http.service.js";
import { TaskGroupUnmergeHttpService } from "../src/modules/task-groups/task-group-unmerge-http.service.js";
import { TaskGroupsController } from "../src/modules/task-groups/task-groups.controller.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let taskGroupsHttp: TaskGroupsHttpService;
let unmergeHttp: TaskGroupUnmergeHttpService;
let client: DatabaseClient;
let auditReader: DatabaseClient;
let app: INestApplication;
let base: string;
const key = randomBytes(32);
const tokens = new SessionTokenService(
  VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
);
const mergePath = "/api/v1/task-groups/merge";
const unmergePath = "/api/v1/task-groups/unmerge";
/** 功能设计 18.14 把解除原因定义为「建议填写」；未填写时服务端写入固定文案。 */
const defaultUnmergeReason = "未填写解除原因";

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f24-unmerge",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f24-unmerge-audit",
  });
  const uow = new PostgresUnitOfWork(client);
  const auth = new SessionAuthService(
    uow,
    new PostgresUserSessionRepository(),
    tokens,
  );
  const access = new PostgresProjectAccessQueryPort(client);
  const service = new TaskGroupsService(
    access,
    new PostgresProjectCodePort(),
    new PostgresModuleQueryPort(),
    new PostgresFeatureQueryPort(),
    new PostgresTaskQueryPort(),
    new TaskGroupRepository(),
    new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key }),
    new PostgresActivityWritePort(),
    new ProjectNotificationDispatcher(
      access,
      new PostgresNotificationWritePort(),
    ),
    new PostgresSearchProjectionWritePort(),
    postgresProjectMemberPermissions(),
  );
  const mutation = new AuthenticatedMutationService(
    auth,
    new PostgresSessionCsrfTokenRepository(),
    tokens,
  );
  const idempotency = new IdempotencyHttpService(
    new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
    { currentVersion: 1, currentKey: () => key, keyFor: () => key },
    resolveRegisteredRoute,
  );
  taskGroupsHttp = new TaskGroupsHttpService(
    auth,
    mutation,
    idempotency,
    service,
  );
  unmergeHttp = new TaskGroupUnmergeHttpService(mutation, idempotency, service);
  class TestModule {}
  Module({
    controllers: [TaskGroupsController],
    providers: [
      { provide: TaskGroupsHttpService, useValue: taskGroupsHttp },
      { provide: TaskGroupUnmergeHttpService, useValue: unmergeHttp },
    ],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ContractResponseInterceptor());
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  await client?.close();
  await auditReader?.close();
});

interface Actor {
  readonly cookie: string;
  readonly csrf: string;
}

async function session(userId: number): Promise<Actor> {
  const cookie = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const [row] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions(user_id,token_hash,token_hash_key_version,auth_version_at_issue,auth_state,recovery_rotation_generation,recovery_rotation_consumed_generation,idle_expires_at,absolute_expires_at) VALUES (${userId},${tokens.hash(cookie).hash},1,1,'AUTHENTICATED',0,0,now()+interval '1 hour',now()+interval '1 day') RETURNING id`;
  if (!row) throw new Error("session fixture returned no row");
  await client.sql`INSERT INTO app.session_csrf_tokens(session_id,token_hash,expires_at) VALUES (${row.id},${tokens.hash(csrf).hash},now()+interval '1 hour')`;
  return { cookie: `__Host-session=${cookie}`, csrf };
}

function mergeBody(
  sourceTaskId: number,
  mainTaskId: number,
  sourceKind: "HISTORICAL" | "ACTIVE" = "HISTORICAL",
  mergeNote: string | null = null,
) {
  return { sourceTaskId, mainTaskId, sourceKind, mergeNote };
}

function unmergeBody(sourceTaskId: number, unmergeReason: string | null) {
  return { sourceTaskId, unmergeReason };
}

async function merge(
  actor: Actor | undefined,
  body: unknown,
  options: {
    readonly csrf?: string;
    readonly idempotencyKey?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: base,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }
  if (actor) {
    headers["cookie"] = actor.cookie;
    headers["x-csrf-token"] = options.csrf ?? actor.csrf;
  }
  return fetch(base + mergePath, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function unmerge(
  actor: Actor | undefined,
  body: unknown,
  options: {
    readonly csrf?: string;
    readonly idempotencyKey?: string | null;
    readonly query?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: base,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }
  if (actor) {
    headers["cookie"] = actor.cookie;
    headers["x-csrf-token"] = options.csrf ?? actor.csrf;
  }
  return fetch(base + unmergePath + (options.query ?? ""), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function failure(response: Response, status: number) {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  const body = schemaRegistry.ErrorResponse.schema.parse(JSON.parse(text));
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
  expect(JSON.stringify(body)).not.toMatch(
    /SELECT |INSERT INTO|constraint_name|stack/i,
  );
  return body;
}

let sequences = 0;
async function createTask(
  project: ProjectFixture,
  creatorId: number,
  assigneeId: number,
  title: string,
  options: {
    readonly workStatus?: "TODO" | "DONE" | "CANCELED";
    readonly lifecycleStatus?: "ACTIVE" | "INVALID";
  } = {},
): Promise<number> {
  sequences += 1;
  const workStatus = options.workStatus ?? "TODO";
  const completedAt = workStatus === "DONE" ? new Date().toISOString() : null;
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO app.tasks(project_id,module_id,feature_id,scope_type,code,title,creator_id,work_status,lifecycle_status,completed_at) VALUES (${project.projectId},${project.moduleId},NULL,'MODULE',${`${project.code}-T-${sequences}`},${title},${creatorId},${workStatus},${options.lifecycleStatus ?? "ACTIVE"},${completedAt}) RETURNING id`;
    if (!row) throw new Error("task fixture returned no row");
    await tx`INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES (${row.id}, ${assigneeId}, ${project.projectId})`;
    await tx`INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, changed_by) VALUES (${row.id}, ${project.projectId}, NULL, ${workStatus}, ${completedAt}, ${creatorId})`;
    return row.id;
  });
}

async function addMember(projectId: number, userId: number): Promise<void> {
  await client.sql`INSERT INTO app.project_members(project_id,user_id) VALUES (${projectId},${userId})`;
}

interface GroupFixture {
  readonly actor: Actor;
  readonly groupCode: string;
  readonly groupId: number;
  readonly groupRowVersion: number;
  readonly mainAssigneeId: number;
  readonly mainTaskId: number;
  readonly project: ProjectFixture;
  readonly secondSourceAssigneeId: number;
  readonly secondSourceTaskId: number;
  readonly sourceAssigneeId: number;
  readonly sourceTaskId: number;
  readonly userId: number;
}

/** 四个成员（actor + 三个负责人）与三个 MODULE 任务，覆盖合并与解除合并路径。 */
async function taskFixture() {
  const userId = await createUser(client.sql);
  const project = await createProject(client.sql, userId);
  const mainAssigneeId = await createUser(client.sql);
  const sourceAssigneeId = await createUser(client.sql);
  const secondSourceAssigneeId = await createUser(client.sql);
  await addMember(project.projectId, mainAssigneeId);
  await addMember(project.projectId, sourceAssigneeId);
  await addMember(project.projectId, secondSourceAssigneeId);
  const mainTaskId = await createTask(
    project,
    userId,
    mainAssigneeId,
    "修复重复退款",
  );
  const sourceTaskId = await createTask(
    project,
    userId,
    sourceAssigneeId,
    "处理重复回调",
    { workStatus: "DONE" },
  );
  const secondSourceTaskId = await createTask(
    project,
    userId,
    secondSourceAssigneeId,
    "回收入口",
  );
  return {
    actor: await session(userId),
    mainAssigneeId,
    mainTaskId,
    project,
    secondSourceAssigneeId,
    secondSourceTaskId,
    sourceAssigneeId,
    sourceTaskId,
    userId,
  };
}

/** 合并出含一个活跃来源的聚合组（row_version = 1）。 */
async function mergeFixture(): Promise<GroupFixture> {
  const f = await taskFixture();
  const response = await merge(
    f.actor,
    mergeBody(f.sourceTaskId, f.mainTaskId),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const item = schemaRegistry.TaskGroupItem.schema.parse(await response.json());
  return {
    ...f,
    groupCode: item.code,
    groupId: item.id,
    groupRowVersion: item.rowVersion,
  };
}

/** 同一主任务下含两个活跃来源的聚合组（row_version = 2）。 */
async function twoSourceFixture(): Promise<GroupFixture> {
  const f = await mergeFixture();
  const response = await merge(
    f.actor,
    mergeBody(f.secondSourceTaskId, f.mainTaskId, "ACTIVE", "同一根因"),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const item = schemaRegistry.TaskGroupItem.schema.parse(await response.json());
  expect(item.id).toBe(f.groupId);
  return { ...f, groupRowVersion: item.rowVersion };
}

async function countSideEffects(projectId: number) {
  const [runtime] = await client.sql<
    {
      activities: string;
      groups: string;
      members: string;
      notifications: string;
      search: string;
    }[]
  >`SELECT (SELECT count(*)::text FROM app.task_groups WHERE project_id = ${projectId}) AS groups, (SELECT count(*)::text FROM app.task_group_members WHERE project_id = ${projectId}) AS members, (SELECT count(*)::text FROM app.activity_projection WHERE project_id = ${projectId}) AS activities, (SELECT count(*)::text FROM app.notifications WHERE project_id = ${projectId}) AS notifications, (SELECT count(*)::text FROM app.search_projection WHERE project_id = ${projectId}) AS search`;
  const [audit] = await auditReader.sql<
    { mergeLogs: string; unmergeLogs: string }[]
  >`SELECT count(*) FILTER (WHERE action = 'task.merge')::text AS "mergeLogs", count(*) FILTER (WHERE action = 'task.unmerge')::text AS "unmergeLogs" FROM app.audit_logs WHERE project_id = ${projectId}`;
  return {
    ...runtime,
    mergeLogs: audit?.mergeLogs,
    unmergeLogs: audit?.unmergeLogs,
  };
}

describe("F-24 task group unmerge", () => {
  it("unmerges one of two sources keeping the group active with side effects and replay", async () => {
    const f = await twoSourceFixture();
    const key = randomUUID();
    const reason = "重复录入，回退为独立任务";
    const body = unmergeBody(f.sourceTaskId, reason);
    const response = await unmerge(f.actor, body, { idempotencyKey: key });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const item = schemaRegistry.TaskGroupUnmergeResponse.schema.parse(
      await response.json(),
    );
    expect(item.group.id).toBe(f.groupId);
    expect(item.group.status).toBe("ACTIVE");
    expect(item.group.closedAt).toBeNull();
    expect(item.group.rowVersion).toBe(f.groupRowVersion + 1);
    expect(item.group.mainTaskId).toBe(f.mainTaskId);
    expect(item.detachedMembers).toHaveLength(1);
    const detached = item.detachedMembers[0]!;
    expect(detached).toMatchObject({
      taskId: f.sourceTaskId,
      role: "SOURCE",
      sourceKind: "HISTORICAL",
      originalWorkStatus: "DONE",
      originalAssigneeId: f.sourceAssigneeId,
      detachReason: reason,
    });
    expect(new Date(detached.detachedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(detached.joinedAt).getTime(),
    );
    // 解除合并只改成员关系，来源任务本身的工作状态、负责人与版本保持不变
    const [sourceTask] = await client.sql<
      {
        assigneeId: number;
        lifecycleStatus: string;
        rowVersion: number;
        workStatus: string;
      }[]
    >`SELECT work_status AS "workStatus", (SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id = app.tasks.id) AS "assigneeId", row_version AS "rowVersion", lifecycle_status AS "lifecycleStatus" FROM app.tasks WHERE id = ${f.sourceTaskId}`;
    expect(sourceTask).toMatchObject({
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      assigneeId: f.sourceAssigneeId,
      rowVersion: 1,
    });
    const members = await client.sql<
      {
        detachReason: string | null;
        detachedBy: number | null;
        role: string;
        status: string;
        taskId: number;
      }[]
    >`SELECT id, task_id AS "taskId", role, status, detach_reason AS "detachReason", detached_by AS "detachedBy" FROM app.task_group_members WHERE group_id = ${f.groupId} ORDER BY id`;
    expect(members.find((row) => row.taskId === f.sourceTaskId)).toMatchObject({
      status: "DETACHED",
      detachReason: reason,
      detachedBy: f.userId,
    });
    expect(members.find((row) => row.taskId === f.mainTaskId)).toMatchObject({
      status: "ACTIVE",
      role: "MAIN",
    });
    expect(
      members.find((row) => row.taskId === f.secondSourceTaskId),
    ).toMatchObject({ status: "ACTIVE", role: "SOURCE" });
    const effects = await countSideEffects(f.project.projectId);
    expect(effects).toMatchObject({
      groups: "1",
      members: "3",
      activities: "3",
      notifications: "9",
      search: "1",
      mergeLogs: "2",
      unmergeLogs: "1",
    });
    const [activity] = await client.sql<
      {
        actorId: number;
        sourceEntityId: number;
        sourceEntityType: string;
        summary: string;
        visibilityScope: string;
      }[]
    >`SELECT actor_id AS "actorId", source_entity_type AS "sourceEntityType", source_entity_id AS "sourceEntityId", summary, visibility_scope AS "visibilityScope" FROM app.activity_projection WHERE project_id = ${f.project.projectId} AND activity_type = ${"task.unmerge"}`;
    expect(activity).toMatchObject({
      actorId: f.userId,
      sourceEntityType: "TASK_GROUP",
      sourceEntityId: f.groupId,
      visibilityScope: "MEMBER",
    });
    expect(activity?.summary).toContain("恢复独立");
    const notifications = await client.sql<
      {
        body: string;
        notificationType: string;
        recipientId: number;
        targetPath: string | null;
        title: string;
      }[]
    >`SELECT recipient_id AS "recipientId", notification_type AS "notificationType", title, body, target_path AS "targetPath" FROM app.notifications WHERE project_id = ${f.project.projectId} AND notification_type = ${"task.unmerge"} ORDER BY recipient_id`;
    expect(notifications.map((row) => row.recipientId)).toEqual(
      [f.mainAssigneeId, f.sourceAssigneeId, f.userId].sort((a, b) => a - b),
    );
    for (const row of notifications) {
      expect(row).toMatchObject({
        title: "任务解除合并：处理重复回调 恢复独立",
        body: reason,
        targetPath: `/projects/${f.project.projectId}/modules/${f.project.moduleId}/tasks?taskId=${f.sourceTaskId}`,
      });
    }
    const [projection] = await client.sql<
      {
        entityId: number;
        entityType: string;
        sourceRowVersion: number;
        summary: string;
        title: string;
      }[]
    >`SELECT entity_type AS "entityType", entity_id AS "entityId", title, summary, source_row_version AS "sourceRowVersion" FROM app.search_projection WHERE project_id = ${f.project.projectId} AND entity_type = ${"TASK_GROUP"}`;
    expect(projection).toMatchObject({
      entityType: "TASK_GROUP",
      entityId: f.groupId,
      title: "修复重复退款",
      summary: reason,
      sourceRowVersion: f.groupRowVersion + 1,
    });
    const replay = await unmerge(f.actor, body, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(item);
    const mismatch = await unmerge(
      f.actor,
      unmergeBody(f.sourceTaskId, "另一段原因"),
      { idempotencyKey: key },
    );
    expect((await failure(mismatch, 409)).code).toBe(
      "IDEMPOTENCY_REQUEST_MISMATCH",
    );
    const repeat = await unmerge(f.actor, body);
    expect((await failure(repeat, 409)).code).toBe("TASK_NOT_MERGED");
    // 同组历史关系仍然存在：带历史成员的重复合并必须被拒绝
    const remerge = await merge(
      f.actor,
      mergeBody(f.sourceTaskId, f.mainTaskId),
    );
    expect((await failure(remerge, 409)).code).toBe("TASK_ALREADY_MERGED");
    expect(await countSideEffects(f.project.projectId)).toEqual(effects);
    // 结果资源权限按当前成员关系重新校验
    await removeMember(client.sql, f.project.projectId, f.userId);
    await failure(await unmerge(f.actor, body, { idempotencyKey: key }), 404);
  });

  it("closes the group when the last source is unmerged and allows a fresh group later", async () => {
    const f = await mergeFixture();
    const key = randomUUID();
    const reason = "误合并，且没有其他来源分支";
    const body = unmergeBody(f.sourceTaskId, reason);
    const response = await unmerge(f.actor, body, { idempotencyKey: key });
    expect(response.status, await response.clone().text()).toBe(200);
    const item = schemaRegistry.TaskGroupUnmergeResponse.schema.parse(
      await response.json(),
    );
    expect(item.group.id).toBe(f.groupId);
    expect(item.group.status).toBe("CLOSED");
    expect(item.group.closedAt).not.toBeNull();
    expect(item.group.rowVersion).toBe(2);
    expect(item.group.mainTaskId).toBe(f.mainTaskId);
    expect(item.detachedMembers.map((member) => member.role).sort()).toEqual([
      "MAIN",
      "SOURCE",
    ]);
    const detachedMain = item.detachedMembers.find(
      (member) => member.role === "MAIN",
    );
    expect(detachedMain).toMatchObject({
      taskId: f.mainTaskId,
      sourceKind: null,
      originalWorkStatus: null,
      originalAssigneeId: null,
      detachReason: reason,
    });
    const [group] = await client.sql<
      { closedAt: Date | null; rowVersion: number; status: string }[]
    >`SELECT status, closed_at AS "closedAt", row_version AS "rowVersion" FROM app.task_groups WHERE id = ${f.groupId}`;
    expect(group).toMatchObject({ status: "CLOSED", rowVersion: 2 });
    expect(group?.closedAt).not.toBeNull();
    const [active] = await client.sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM app.task_group_members WHERE group_id = ${f.groupId} AND status = 'ACTIVE'`;
    expect(active?.count).toBe("0");
    const effects = await countSideEffects(f.project.projectId);
    expect(effects).toMatchObject({
      groups: "1",
      members: "2",
      activities: "2",
      notifications: "6",
      search: "1",
      mergeLogs: "1",
      unmergeLogs: "1",
    });
    // 关闭的聚合组仍是幂等重放的结果资源，可安全重放
    const replay = await unmerge(f.actor, body, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(item);
    const repeat = await unmerge(f.actor, unmergeBody(f.sourceTaskId, null));
    expect((await failure(repeat, 409)).code).toBe("TASK_NOT_MERGED");
    // 关闭后重新合并同一对任务会创建新的聚合组，历史关系仍保留
    const remerge = await merge(
      f.actor,
      mergeBody(f.sourceTaskId, f.mainTaskId),
    );
    expect(remerge.status, await remerge.clone().text()).toBe(200);
    const created = schemaRegistry.TaskGroupItem.schema.parse(
      await remerge.json(),
    );
    expect(created.id).not.toBe(f.groupId);
    expect(created.code).toBe(`${f.project.code}-TG-2`);
    expect(created.status).toBe("ACTIVE");
    expect(created.members).toHaveLength(2);
    const [closed] = await client.sql<
      { status: string }[]
    >`SELECT status FROM app.task_groups WHERE id = ${f.groupId}`;
    expect(closed?.status).toBe("CLOSED");
  });

  it("falls back to a fixed reason and notification body when the reason is omitted", async () => {
    const f = await twoSourceFixture();
    const response = await unmerge(f.actor, unmergeBody(f.sourceTaskId, "   "));
    expect(response.status, await response.clone().text()).toBe(200);
    const item = schemaRegistry.TaskGroupUnmergeResponse.schema.parse(
      await response.json(),
    );
    expect(item.detachedMembers[0]).toMatchObject({
      detachReason: defaultUnmergeReason,
    });
    const [detached] = await client.sql<
      { detachReason: string | null }[]
    >`SELECT detach_reason AS "detachReason" FROM app.task_group_members WHERE group_id = ${f.groupId} AND task_id = ${f.sourceTaskId}`;
    expect(detached?.detachReason).toBe(defaultUnmergeReason);
    const [sourceRow] = await client.sql<
      { code: string }[]
    >`SELECT code FROM app.tasks WHERE id = ${f.sourceTaskId}`;
    const notifications = await client.sql<
      { body: string; recipientId: number }[]
    >`SELECT recipient_id AS "recipientId", body FROM app.notifications WHERE project_id = ${f.project.projectId} AND notification_type = ${"task.unmerge"} ORDER BY recipient_id`;
    expect(notifications).toHaveLength(3);
    for (const row of notifications)
      expect(row.body).toBe(`${sourceRow!.code} 已恢复独立`);
  });

  it("rejects main-task unmerge, unknown tasks, non-members and archived projects", async () => {
    const f = await twoSourceFixture();
    const mainAttempt = await failure(
      await unmerge(f.actor, unmergeBody(f.mainTaskId, null)),
      409,
    );
    expect(mainAttempt.code).toBe("TASK_GROUP_STATE_CONFLICT");
    expect(mainAttempt.message).toContain("主任务");
    const idleAssigneeId = await createUser(client.sql);
    await addMember(f.project.projectId, idleAssigneeId);
    const idleTaskId = await createTask(
      f.project,
      f.userId,
      idleAssigneeId,
      "从未合并的任务",
    );
    const neverMerged = await failure(
      await unmerge(f.actor, unmergeBody(idleTaskId, null)),
      409,
    );
    expect(neverMerged.code).toBe("TASK_NOT_MERGED");
    await failure(await unmerge(f.actor, unmergeBody(2147483647, null)), 404);
    const other = await createProject(client.sql, await createUser(client.sql));
    const foreignTaskId = await createTask(
      other,
      other.userId,
      other.userId,
      "其他项目任务",
    );
    await failure(
      await unmerge(f.actor, unmergeBody(foreignTaskId, null)),
      404,
    );
    const outsider = await session(await createUser(client.sql));
    await failure(
      await unmerge(outsider, unmergeBody(f.sourceTaskId, null)),
      404,
    );
    await removeMember(client.sql, f.project.projectId, f.userId);
    await failure(
      await unmerge(f.actor, unmergeBody(f.sourceTaskId, null)),
      404,
    );
    expect(await countSideEffects(f.project.projectId)).toMatchObject({
      groups: "1",
      members: "3",
      activities: "2",
      notifications: "6",
      search: "1",
      mergeLogs: "2",
      unmergeLogs: "0",
    });
  });

  it("enforces the HTTP security, validation and idempotency boundary", async () => {
    const f = await mergeFixture();
    const body = unmergeBody(f.sourceTaskId, "边界用例");
    const post = (
      cookieHeader: string,
      csrfToken: string,
      overrides: Record<string, string> = {},
    ) =>
      fetch(base + unmergePath, {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          ...overrides,
        },
        body: JSON.stringify(body),
      });
    const hostile = await failure(
      await post(f.actor.cookie, f.actor.csrf, {
        origin: "https://evil.example",
      }),
      403,
    );
    expect(hostile.code).toBe("CSRF_ORIGIN_REJECTED");
    const bare = await failure(
      await post(f.actor.cookie, f.actor.csrf, { origin: "" }),
      403,
    );
    expect(bare.code).toBe("CSRF_ORIGIN_REJECTED");
    const staleCsrf = await failure(
      await post(f.actor.cookie, randomBytes(32).toString("base64url")),
      401,
    );
    expect(staleCsrf.code).toBe("TASK_UNMERGE_SESSION_REQUIRED");
    const anonymous = await failure(
      await post(
        `__Host-session=${randomBytes(32).toString("base64url")}`,
        randomBytes(32).toString("base64url"),
      ),
      401,
    );
    expect(anonymous.code).toBe("TASK_UNMERGE_SESSION_REQUIRED");
    const shortHeader = await failure(await post(f.actor.cookie, "", {}), 422);
    expect(shortHeader.code).toBe("VALIDATION_FAILED");
    const missingKey = await failure(
      await unmerge(f.actor, body, { idempotencyKey: null }),
      400,
    );
    expect(missingKey.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const shortKey = await failure(
      await unmerge(f.actor, body, { idempotencyKey: "short" }),
      400,
    );
    expect(shortKey.code).toBe("IDEMPOTENCY_KEY_INVALID");
    const query = await failure(
      await unmerge(f.actor, body, { query: "?dryRun=1" }),
      422,
    );
    expect(query.code).toBe("TASK_UNMERGE_VALIDATION_FAILED");
    expect(query.details).toMatchObject({ query: "此接口不接受查询参数" });
    // @ContractBody 在处理器之前拒绝无法解析的请求体（统一 422）；
    // 处理器内的 400 内容类型映射由直接调用覆盖。
    const wrongType = await failure(
      await post(f.actor.cookie, f.actor.csrf, {
        "content-type": "text/plain",
      }),
      422,
    );
    expect(wrongType.code).toBe("VALIDATION_FAILED");
    const directContentType = await unmergeHttp.handle({
      headers: {
        host: new URL(base).host,
        origin: base,
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
        "idempotency-key": randomUUID(),
        cookie: f.actor.cookie,
        "x-csrf-token": f.actor.csrf,
      },
      params: {},
      query: {},
      body,
    });
    expect(directContentType.status).toBe(400);
    expect(directContentType.body).toMatchObject({
      code: "TASK_UNMERGE_CONTENT_TYPE_INVALID",
    });
    const malformed = await failure(
      await unmerge(f.actor, { sourceTaskId: "abc", unmergeReason: null }),
      422,
    );
    expect(malformed.code).toBe("VALIDATION_FAILED");
    const missingReason = await failure(
      await unmerge(f.actor, { sourceTaskId: f.sourceTaskId }),
      422,
    );
    expect(missingReason.code).toBe("VALIDATION_FAILED");
    const unknownField = await failure(
      await unmerge(f.actor, {
        ...body,
        projectId: f.project.projectId,
      }),
      422,
    );
    expect(unknownField.code).toBe("VALIDATION_FAILED");
    expect(await countSideEffects(f.project.projectId)).toMatchObject({
      groups: "1",
      members: "2",
      activities: "1",
      notifications: "3",
      search: "1",
      mergeLogs: "1",
      unmergeLogs: "0",
    });
  });

  it("serializes concurrent unmerges of the same source", async () => {
    const f = await twoSourceFixture();
    const body = unmergeBody(f.sourceTaskId, "并发解除");
    const responses = await Promise.all([
      unmerge(f.actor, body, { idempotencyKey: randomUUID() }),
      unmerge(f.actor, body, { idempotencyKey: randomUUID() }),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect((await failure(rejected, 409)).code).toBe("TASK_NOT_MERGED");
    expect(await countSideEffects(f.project.projectId)).toMatchObject({
      groups: "1",
      members: "3",
      activities: "3",
      notifications: "9",
      search: "1",
      mergeLogs: "2",
      unmergeLogs: "1",
    });
    const [group] = await client.sql<
      { rowVersion: number; status: string }[]
    >`SELECT status, row_version AS "rowVersion" FROM app.task_groups WHERE id = ${f.groupId}`;
    expect(group).toMatchObject({ status: "ACTIVE", rowVersion: 3 });
    const [active] = await client.sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM app.task_group_members WHERE group_id = ${f.groupId} AND status = 'ACTIVE'`;
    expect(active?.count).toBe("2");
  });

  it("serializes unmerging the last source against merging a new source", async () => {
    const f = await mergeFixture();
    const extraAssigneeId = await createUser(client.sql);
    await addMember(f.project.projectId, extraAssigneeId);
    const extraTaskId = await createTask(
      f.project,
      f.userId,
      extraAssigneeId,
      "新增来源分支",
    );
    const [unmergeResponse, mergeResponse] = await Promise.all([
      unmerge(f.actor, unmergeBody(f.sourceTaskId, "并发解除"), {
        idempotencyKey: randomUUID(),
      }),
      merge(f.actor, mergeBody(extraTaskId, f.mainTaskId, "ACTIVE"), {
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(unmergeResponse.status, await unmergeResponse.clone().text()).toBe(
      200,
    );
    const groups = await client.sql<
      { id: number; rowVersion: number; status: string }[]
    >`SELECT id, status, row_version AS "rowVersion" FROM app.task_groups WHERE project_id = ${f.project.projectId} ORDER BY id`;
    const active = await client.sql<
      { groupId: number; taskId: number }[]
    >`SELECT group_id AS "groupId", task_id AS "taskId" FROM app.task_group_members WHERE project_id = ${f.project.projectId} AND status = 'ACTIVE' ORDER BY task_id`;
    // 不变量：任何 CLOSED 聚合组都不得残留活跃成员，解除的来源必然 DETACHED
    for (const group of groups.filter((row) => row.status === "CLOSED"))
      expect(active.filter((row) => row.groupId === group.id)).toHaveLength(0);
    const [detachedSource] = await client.sql<
      { status: string }[]
    >`SELECT status FROM app.task_group_members WHERE project_id = ${f.project.projectId} AND task_id = ${f.sourceTaskId}`;
    expect(detachedSource?.status).toBe("DETACHED");
    if (mergeResponse.status === 200) {
      // 合并先提交：解除来源时仍有活跃来源，原聚合组保持 ACTIVE；
      // 解除先提交：MAIN 已解除，合并按既有语义创建新的聚合组。
      const merged = schemaRegistry.TaskGroupItem.schema.parse(
        await mergeResponse.json(),
      );
      const target = groups.find((row) => row.id === merged.id)!;
      expect(target.status).toBe("ACTIVE");
      expect(
        active
          .filter((row) => row.groupId === merged.id)
          .map((row) => row.taskId)
          .sort((a, b) => a - b),
      ).toEqual([f.mainTaskId, extraTaskId].sort((a, b) => a - b));
    } else {
      // 合并与关闭组竞争失败：组已关闭，禁止新增来源任务
      const error = await failure(mergeResponse, 409);
      expect(error.code).toBe("TASK_GROUP_STATE_CONFLICT");
      expect(groups).toHaveLength(1);
      expect(groups[0]?.status).toBe("CLOSED");
      expect(active).toHaveLength(0);
    }
  });

  it("enforces detach metadata and closed-group invariants directly in PostgreSQL", async () => {
    const f = await twoSourceFixture();
    const response = await unmerge(
      f.actor,
      unmergeBody(f.sourceTaskId, "探针"),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const [member] = await client.sql<
      { memberId: number }[]
    >`SELECT id AS "memberId" FROM app.task_group_members WHERE group_id = ${f.groupId} AND task_id = ${f.sourceTaskId}`;
    const missingMetadata = await client.sql
      .begin(async (tx) => {
        await tx`UPDATE app.task_group_members SET status = 'DETACHED', detached_at = NULL, detach_reason = 'x' WHERE id = ${member!.memberId}`;
      })
      .catch((error: unknown) => error);
    expect(missingMetadata).toMatchObject({
      code: "23514",
      constraint_name: "task_group_members_detach_state_check",
    });
    const backdated = await client.sql
      .begin(async (tx) => {
        await tx`UPDATE app.task_group_members SET detached_at = joined_at - interval '1 second' WHERE id = ${member!.memberId}`;
      })
      .catch((error: unknown) => error);
    expect(backdated).toMatchObject({
      code: "23514",
      constraint_name: "task_group_members_detach_time_check",
    });
    const closed = await mergeFixture();
    const closeResponse = await unmerge(
      closed.actor,
      unmergeBody(closed.sourceTaskId, null),
    );
    expect(closeResponse.status, await closeResponse.clone().text()).toBe(200);
    const [mainMember] = await client.sql<
      { memberId: number }[]
    >`SELECT id AS "memberId" FROM app.task_group_members WHERE group_id = ${closed.groupId} AND role = 'MAIN'`;
    const reactivate = await client.sql
      .begin(async (tx) => {
        await tx`UPDATE app.task_group_members SET status = 'ACTIVE', detached_at = NULL, detached_by = NULL, detach_reason = NULL WHERE id = ${mainMember!.memberId}`;
      })
      .catch((error: unknown) => error);
    expect(reactivate).toMatchObject({ code: "23514" });
    expect(String(reactivate)).toContain("closed task group");
    const [stillDetached] = await client.sql<
      { status: string }[]
    >`SELECT status FROM app.task_group_members WHERE id = ${mainMember!.memberId}`;
    expect(stillDetached?.status).toBe("DETACHED");
  });
});

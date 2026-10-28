import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import { randomBytes, randomUUID } from "node:crypto";
import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { schemaRegistry } from "@inpulse/api-contract";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
let client: DatabaseClient;
let auditReader: DatabaseClient;
let uow: PostgresUnitOfWork;
let app: INestApplication;
let base: string;
const key = randomBytes(32);
const tokens = new SessionTokenService(
  VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
);
const mergePath = "/api/v1/task-groups/merge";

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f23-merge",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f23-merge-audit",
  });
  uow = new PostgresUnitOfWork(client);
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
  // F-24 后控制器同时提供解除合并入口，测试模块必须注册对应 Provider。
  const unmergeHttp = new TaskGroupUnmergeHttpService(
    mutation,
    idempotency,
    service,
  );
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

afterEach(() => vi.restoreAllMocks());
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

async function merge(
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
  return fetch(base + mergePath + (options.query ?? ""), {
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
    readonly featureId?: number | null;
    readonly lifecycleStatus?: "ACTIVE" | "INVALID";
    readonly workStatus?: "TODO" | "DONE" | "CANCELED";
  } = {},
): Promise<number> {
  sequences += 1;
  const featureId = options.featureId ?? null;
  const workStatus = options.workStatus ?? "TODO";
  const completedAt = workStatus === "DONE" ? new Date().toISOString() : null;
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO app.tasks(project_id,module_id,feature_id,scope_type,code,title,creator_id,work_status,lifecycle_status,completed_at) VALUES (${project.projectId},${project.moduleId},${featureId},${featureId === null ? "MODULE" : "FEATURE"},${`${project.code}-T-${sequences}`},${title},${creatorId},${workStatus},${options.lifecycleStatus ?? "ACTIVE"},${completedAt}) RETURNING id`;
    if (!row) throw new Error("task fixture returned no row");
    await tx`INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES (${row.id}, ${assigneeId}, ${project.projectId})`;
    await tx`INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, changed_by) VALUES (${row.id}, ${project.projectId}, NULL, ${workStatus}, ${completedAt}, ${creatorId})`;
    return row.id;
  });
}

async function createFeature(
  project: ProjectFixture,
  creatorId: number,
  name: string,
): Promise<number> {
  sequences += 1;
  const [row] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.features(project_id,module_id,code,name,created_by) VALUES (${project.projectId},${project.moduleId},${`${project.code}-F-${sequences}`},${name},${creatorId}) RETURNING id`;
  if (!row) throw new Error("feature fixture returned no row");
  return row.id;
}

async function addMember(projectId: number, userId: number): Promise<void> {
  await client.sql`INSERT INTO app.project_members(project_id,user_id) VALUES (${projectId},${userId})`;
}

interface MergeFixture {
  readonly actor: Actor;
  readonly mainAssigneeId: number;
  readonly mainTaskId: number;
  readonly project: ProjectFixture;
  readonly sourceAssigneeId: number;
  readonly sourceTaskId: number;
  readonly userId: number;
}

/** 三个成员（actor + 两个负责人）加一对 MODULE 任务，覆盖默认合并路径。 */
async function mergeFixture(): Promise<MergeFixture> {
  const userId = await createUser(client.sql);
  const project = await createProject(client.sql, userId);
  const mainAssigneeId = await createUser(client.sql);
  const sourceAssigneeId = await createUser(client.sql);
  await addMember(project.projectId, mainAssigneeId);
  await addMember(project.projectId, sourceAssigneeId);
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
  return {
    actor: await session(userId),
    mainAssigneeId,
    mainTaskId,
    project,
    sourceAssigneeId,
    sourceTaskId,
    userId,
  };
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
    { logs: string }[]
  >`SELECT count(*)::text AS logs FROM app.audit_logs WHERE project_id = ${projectId} AND action = 'task.merge'`;
  return { ...runtime, logs: audit?.logs };
}

describe("F-23 task group merge", () => {
  it("merges a source into a new group with snapshots, side effects and replay", async () => {
    const f = await mergeFixture();
    const key = randomUUID();
    const body = mergeBody(
      f.sourceTaskId,
      f.mainTaskId,
      "HISTORICAL",
      "回调与退款根因相同",
    );
    const response = await merge(f.actor, body, { idempotencyKey: key });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const item = schemaRegistry.TaskGroupItem.schema.parse(
      await response.json(),
    );
    expect(item.projectId).toBe(f.project.projectId);
    expect(item.code).toBe(`${f.project.code}-TG-1`);
    expect(item.name).toBe("修复重复退款");
    expect(item.status).toBe("ACTIVE");
    expect(item.createdBy).toBe(f.userId);
    expect(item.rowVersion).toBe(1);
    expect(item.mainTaskId).toBe(f.mainTaskId);
    expect(item.members).toHaveLength(2);
    const [mainMember, sourceMember] = item.members;
    expect(mainMember).toMatchObject({
      taskId: f.mainTaskId,
      role: "MAIN",
      sourceKind: null,
      status: "ACTIVE",
      originalWorkStatus: null,
      originalAssigneeId: null,
    });
    expect(sourceMember).toMatchObject({
      taskId: f.sourceTaskId,
      role: "SOURCE",
      sourceKind: "HISTORICAL",
      status: "ACTIVE",
      originalWorkStatus: "DONE",
      originalAssigneeId: f.sourceAssigneeId,
    });
    const tasks = await client.sql<
      Array<{
        assigneeId: number;
        id: number;
        lifecycleStatus: string;
        rowVersion: number;
        workStatus: string;
      }>
    >`SELECT id, work_status AS "workStatus", lifecycle_status AS "lifecycleStatus", (SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id = app.tasks.id) AS "assigneeId", row_version AS "rowVersion" FROM app.tasks WHERE project_id = ${f.project.projectId} ORDER BY id`;
    expect(tasks.find((task) => task.id === f.sourceTaskId)).toMatchObject({
      workStatus: "DONE",
      lifecycleStatus: "ACTIVE",
      assigneeId: f.sourceAssigneeId,
      rowVersion: 1,
    });
    expect(tasks.find((task) => task.id === f.mainTaskId)).toMatchObject({
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      assigneeId: f.mainAssigneeId,
      rowVersion: 1,
    });
    const effects = await countSideEffects(f.project.projectId);
    expect(effects).toMatchObject({
      groups: "1",
      members: "2",
      activities: "1",
      notifications: "3",
      search: "1",
      logs: "1",
    });
    const [activity] = await client.sql<
      Array<{
        activityType: string;
        actorId: number;
        sourceEntityId: number;
        sourceEntityType: string;
        summary: string;
        visibilityScope: string;
      }>
    >`SELECT activity_type AS "activityType", actor_id AS "actorId", source_entity_type AS "sourceEntityType", source_entity_id AS "sourceEntityId", summary, visibility_scope AS "visibilityScope" FROM app.activity_projection WHERE project_id = ${f.project.projectId}`;
    expect(activity).toMatchObject({
      activityType: "task.merge",
      actorId: f.userId,
      sourceEntityType: "TASK_GROUP",
      sourceEntityId: item.id,
      visibilityScope: "MEMBER",
    });
    expect(activity?.summary).toContain("修复重复退款");

    const notifications = await client.sql<
      Array<{
        body: string;
        notificationType: string;
        recipientId: number;
        targetPath: string | null;
        title: string;
      }>
    >`SELECT recipient_id AS "recipientId", notification_type AS "notificationType", title, body, target_path AS "targetPath" FROM app.notifications WHERE project_id = ${f.project.projectId} ORDER BY recipient_id`;
    expect(notifications.map((row) => row.recipientId)).toEqual(
      [f.mainAssigneeId, f.sourceAssigneeId, f.userId].sort((a, b) => a - b),
    );
    for (const row of notifications) {
      expect(row).toMatchObject({
        notificationType: "task.merge",
        title: "任务合并：处理重复回调 并入 修复重复退款",
        body: "回调与退款根因相同",
        targetPath: `/projects/${f.project.projectId}/modules/${f.project.moduleId}/tasks?taskId=${f.mainTaskId}`,
      });
    }
    const [projection] = await client.sql<
      Array<{
        entityId: number;
        entityType: string;
        sourceRowVersion: number;
        summary: string;
        title: string;
        visibilityScope: string;
      }>
    >`SELECT entity_type AS "entityType", entity_id AS "entityId", title, summary, visibility_scope AS "visibilityScope", source_row_version AS "sourceRowVersion" FROM app.search_projection WHERE project_id = ${f.project.projectId}`;
    expect(projection).toMatchObject({
      entityType: "TASK_GROUP",
      entityId: item.id,
      title: "修复重复退款",
      summary: "回调与退款根因相同",
      visibilityScope: "MEMBER",
      sourceRowVersion: 1,
    });
    const replay = await merge(f.actor, body, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(item);
    const mismatch = await merge(
      f.actor,
      { ...body, mergeNote: "另一段说明" },
      { idempotencyKey: key },
    );
    expect((await failure(mismatch, 409)).code).toBe(
      "IDEMPOTENCY_REQUEST_MISMATCH",
    );
    const conflict = await merge(f.actor, body);
    expect((await failure(conflict, 409)).code).toBe("TASK_ALREADY_MERGED");
    expect(await countSideEffects(f.project.projectId)).toEqual(effects);
    await removeMember(client.sql, f.project.projectId, f.userId);
    await failure(await merge(f.actor, body, { idempotencyKey: key }), 404);
  });

  it("appends further sources to the existing group and advances row_version", async () => {
    const f = await mergeFixture();
    const first = await merge(f.actor, mergeBody(f.sourceTaskId, f.mainTaskId));
    expect(first.status, await first.clone().text()).toBe(200);
    const created = schemaRegistry.TaskGroupItem.schema.parse(
      await first.json(),
    );
    const featureId = await createFeature(f.project, f.userId, "退款回调");
    const thirdAssigneeId = await createUser(client.sql);
    await addMember(f.project.projectId, thirdAssigneeId);
    const thirdTaskId = await createTask(
      f.project,
      f.userId,
      thirdAssigneeId,
      "回收入口",
      { featureId },
    );
    const second = await merge(
      f.actor,
      mergeBody(thirdTaskId, f.mainTaskId, "ACTIVE", "同一根因"),
      { idempotencyKey: randomUUID() },
    );
    expect(second.status, await second.clone().text()).toBe(200);
    const merged = schemaRegistry.TaskGroupItem.schema.parse(
      await second.json(),
    );
    expect(merged.id).toBe(created.id);
    expect(merged.rowVersion).toBe(2);
    expect(merged.mainTaskId).toBe(f.mainTaskId);
    expect(merged.members).toHaveLength(3);
    expect(
      merged.members.find((member) => member.taskId === thirdTaskId),
    ).toMatchObject({
      role: "SOURCE",
      sourceKind: "ACTIVE",
      status: "ACTIVE",
      originalWorkStatus: "TODO",
      originalAssigneeId: thirdAssigneeId,
    });
    expect(
      merged.members.find((member) => member.taskId === f.sourceTaskId),
    ).toMatchObject({
      sourceKind: "HISTORICAL",
      originalWorkStatus: "DONE",
      originalAssigneeId: f.sourceAssigneeId,
    });
    const [group] = await client.sql<
      Array<{ rowVersion: number }>
    >`SELECT row_version AS "rowVersion" FROM app.task_groups WHERE id = ${merged.id}`;
    expect(group?.rowVersion).toBe(2);
    const effects = await countSideEffects(f.project.projectId);
    expect(effects).toMatchObject({
      groups: "1",
      members: "3",
      activities: "2",
      notifications: "6",
      search: "1",
      logs: "2",
    });
    const [projection] = await client.sql<
      Array<{ sourceRowVersion: number }>
    >`SELECT source_row_version AS "sourceRowVersion" FROM app.search_projection WHERE project_id = ${f.project.projectId} AND entity_type = ${"TASK_GROUP"}`;
    expect(projection?.sourceRowVersion).toBe(2);
  });

  it("rejects self merges, cross-project pairs, unknown tasks and non-members", async () => {
    const f = await mergeFixture();
    const self = await failure(
      await merge(f.actor, mergeBody(f.mainTaskId, f.mainTaskId)),
      422,
    );
    expect(self.code).toBe("TASK_MERGE_SELF_REFERENCE");
    await failure(
      await merge(f.actor, mergeBody(2147483647, f.mainTaskId)),
      404,
    );
    await failure(
      await merge(f.actor, mergeBody(f.sourceTaskId, 2147483647)),
      404,
    );
    const other = await createProject(client.sql, await createUser(client.sql));
    const foreignTaskId = await createTask(
      other,
      other.userId,
      other.userId,
      "其他项目任务",
    );
    await failure(
      await merge(f.actor, mergeBody(foreignTaskId, f.mainTaskId)),
      404,
    );
    await failure(
      await merge(f.actor, mergeBody(f.sourceTaskId, foreignTaskId)),
      404,
    );
    const outsider = await session(await createUser(client.sql));
    await failure(
      await merge(outsider, mergeBody(f.sourceTaskId, f.mainTaskId)),
      404,
    );
    await removeMember(client.sql, f.project.projectId, f.userId);
    await failure(
      await merge(f.actor, mergeBody(f.sourceTaskId, f.mainTaskId)),
      404,
    );
    const invalid = await mergeFixture();
    // ADR-054：任务归档已下线，父级拒写改由任务自身的无效状态承接（错误码不变）。
    await client.sql`UPDATE app.tasks SET lifecycle_status = ${"INVALID"}, updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = ${invalid.sourceTaskId}`;
    const blocked = await failure(
      await merge(
        invalid.actor,
        mergeBody(invalid.sourceTaskId, invalid.mainTaskId),
      ),
      409,
    );
    expect(blocked.code).toBe("TASK_MERGE_PARENT_ARCHIVED");
    expect((await countSideEffects(invalid.project.projectId)).members).toBe(
      "0",
    );
  });

  it("enforces the HTTP security, validation and idempotency boundary", async () => {
    const f = await mergeFixture();
    const body = mergeBody(f.sourceTaskId, f.mainTaskId);
    const post = (
      cookieHeader: string,
      csrfToken: string,
      overrides: Record<string, string> = {},
    ) =>
      fetch(base + mergePath, {
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
    expect(staleCsrf.code).toBe("TASK_MERGE_SESSION_REQUIRED");
    const anonymous = await failure(
      await post(
        `__Host-session=${randomBytes(32).toString("base64url")}`,
        randomBytes(32).toString("base64url"),
      ),
      401,
    );
    expect(anonymous.code).toBe("TASK_MERGE_SESSION_REQUIRED");
    const shortHeader = await failure(await post(f.actor.cookie, "", {}), 422);
    expect(shortHeader.code).toBe("VALIDATION_FAILED");
    const missingKey = await failure(
      await merge(f.actor, body, { idempotencyKey: null }),
      400,
    );
    expect(missingKey.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const shortKey = await failure(
      await merge(f.actor, body, { idempotencyKey: "short" }),
      400,
    );
    expect(shortKey.code).toBe("IDEMPOTENCY_KEY_INVALID");
    const query = await failure(
      await merge(f.actor, body, { query: "?dryRun=1" }),
      422,
    );
    expect(query.code).toBe("TASK_MERGE_VALIDATION_FAILED");
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
    const directContentType = await taskGroupsHttp.handle({
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
      code: "TASK_MERGE_CONTENT_TYPE_INVALID",
    });
    const malformed = await failure(
      await merge(f.actor, { sourceTaskId: "abc" }),
      422,
    );
    expect(malformed.code).toBe("VALIDATION_FAILED");
    const unknownField = await failure(
      await merge(f.actor, { ...body, projectId: f.project.projectId }),
      422,
    );
    expect(unknownField.code).toBe("VALIDATION_FAILED");
    expect(await countSideEffects(f.project.projectId)).toMatchObject({
      groups: "0",
      members: "0",
      activities: "0",
      notifications: "0",
      search: "0",
      logs: "0",
    });
  });

  it("serializes concurrent merges of the same pair into one group", async () => {
    const f = await mergeFixture();
    const body = mergeBody(f.sourceTaskId, f.mainTaskId);
    const responses = await Promise.all([
      merge(f.actor, body, { idempotencyKey: randomUUID() }),
      merge(f.actor, body, { idempotencyKey: randomUUID() }),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect((await failure(rejected, 409)).code).toBe("TASK_ALREADY_MERGED");
    const effects = await countSideEffects(f.project.projectId);
    expect(effects).toMatchObject({
      groups: "1",
      members: "2",
      activities: "1",
      notifications: "3",
      search: "1",
      logs: "1",
    });
  });

  it("enforces task group invariants directly in PostgreSQL", async () => {
    const f = await mergeFixture();
    const response = await merge(
      f.actor,
      mergeBody(f.sourceTaskId, f.mainTaskId),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const item = schemaRegistry.TaskGroupItem.schema.parse(
      await response.json(),
    );
    const extraTaskId = await createTask(
      f.project,
      f.userId,
      f.mainAssigneeId,
      "第二个主任务",
    );
    const duplicateMain =
      await client.sql`INSERT INTO app.task_group_members (group_id, task_id, project_id, role) VALUES (${item.id}, ${extraTaskId}, ${f.project.projectId}, ${"MAIN"})`.catch(
        (error: unknown) => error,
      );
    expect(duplicateMain).toMatchObject({
      code: "23505",
      constraint_name: "task_group_members_one_active_main_unique",
    });
    const shapeTaskId = await createTask(
      f.project,
      f.userId,
      f.mainAssigneeId,
      "缺来源任务",
    );
    const shapeError = await client.sql
      .begin(async (tx) => {
        const [group] = await tx<
          Array<{ id: number }>
        >`INSERT INTO app.task_groups (project_id, code, name, created_by) VALUES (${f.project.projectId}, ${`${f.project.code}-TG-77`}, ${"缺少来源"}, ${f.userId}) RETURNING id`;
        await tx`INSERT INTO app.task_group_members (group_id, task_id, project_id, role) VALUES (${group!.id}, ${shapeTaskId}, ${f.project.projectId}, ${"MAIN"})`;
      })
      .catch((error: unknown) => error);
    expect(shapeError).toMatchObject({ code: "23514" });
    expect(String(shapeError)).toContain(
      "requires exactly one MAIN and at least one SOURCE",
    );
    const secondGroupId = await client.sql.begin(async (tx) => {
      const [group] = await tx<
        Array<{ id: number }>
      >`INSERT INTO app.task_groups (project_id, code, name, created_by) VALUES (${f.project.projectId}, ${`${f.project.code}-TG-78`}, ${"第二组"}, ${f.userId}) RETURNING id`;
      await tx`INSERT INTO app.task_group_members (group_id, task_id, project_id, role) VALUES (${group!.id}, ${extraTaskId}, ${f.project.projectId}, ${"MAIN"})`;
      await tx`INSERT INTO app.task_group_members (group_id, task_id, project_id, role, source_kind, original_work_status, original_assignee_id) VALUES (${group!.id}, ${shapeTaskId}, ${f.project.projectId}, ${"SOURCE"}, ${"HISTORICAL"}, ${"DONE"}, ${f.mainAssigneeId})`;
      return group!.id;
    });
    const duplicateGroup =
      await client.sql`INSERT INTO app.task_group_members (group_id, task_id, project_id, role, source_kind, original_work_status, original_assignee_id) VALUES (${secondGroupId}, ${f.mainTaskId}, ${f.project.projectId}, ${"SOURCE"}, ${"HISTORICAL"}, ${"DONE"}, ${f.mainAssigneeId})`.catch(
        (error: unknown) => error,
      );
    expect(duplicateGroup).toMatchObject({
      code: "23505",
      constraint_name: "task_group_members_one_active_group_unique",
    });
    const snapshotTaskId = await createTask(
      f.project,
      f.userId,
      f.mainAssigneeId,
      "缺快照来源",
    );
    const snapshotError =
      await client.sql`INSERT INTO app.task_group_members (group_id, task_id, project_id, role) VALUES (${item.id}, ${snapshotTaskId}, ${f.project.projectId}, ${"SOURCE"})`.catch(
        (error: unknown) => error,
      );
    expect(snapshotError).toMatchObject({
      code: "23514",
      constraint_name: "task_group_members_snapshot_check",
    });
  });
});

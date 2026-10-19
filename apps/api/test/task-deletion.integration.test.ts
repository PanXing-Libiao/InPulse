import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
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
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
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
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { SqlTaskDeletionCommandPort } from "../src/modules/tasks/task-deletion.command-port.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { ExternalLinksRepository } from "../src/modules/external-links/external-links.repository.js";
import { ExternalLinksCommandPort } from "../src/modules/external-links/external-links.port.js";
import { RecordLifecycleService } from "../src/modules/change-records/record-lifecycle.service.js";
import { RecordLifecycleRepository } from "../src/modules/change-records/record-lifecycle.repository.js";
import { RecordPublicationRepository } from "../src/modules/change-records/record-publication.repository.js";
import { PublishedRecordRepository } from "../src/modules/change-records/published-record.repository.js";
import { LeftoverSearchProjectionSync } from "../src/modules/change-records/leftover-search-projection.js";
import { RecordLifecycleTaskRecordVoidPort } from "../src/modules/change-records/task-record-void.port.js";
import { TaskGroupRepository } from "../src/modules/task-groups/task-group.repository.js";
import { PostgresTaskBranchQueryPort } from "../src/modules/task-groups/task-branch-query.port.js";
import { SqlTaskGroupDeletionPort } from "../src/modules/task-groups/task-group-deletion.port.js";
import { TaskDeletionWorkflow } from "../src/workflows/task-deletion.workflow.js";
import { TaskDeletionHttpService } from "../src/workflows/task-deletion-http.service.js";
import { TaskDeletionController } from "../src/workflows/task-deletion.controller.js";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let audit: PostgresAuditWritePort;
let activity: PostgresActivityWritePort;
let search: PostgresSearchProjectionWritePort;
let uow: PostgresUnitOfWork;
let app: INestApplication;
let base: string;
const key = randomBytes(32);
const tokens = new SessionTokenService(
  VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
);

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-adr058-delete",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-adr058-delete-audit",
  });
  uow = new PostgresUnitOfWork(client);
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  activity = new PostgresActivityWritePort();
  search = new PostgresSearchProjectionWritePort();
  const access = new PostgresProjectAccessQueryPort(client),
    management = new TasksManagementService(
      access,
      new PostgresModuleQueryPort(),
      new PostgresFeatureQueryPort(),
      new PostgresFeatureReadPort(),
      new PostgresProjectCodePort(),
      new PostgresProjectMembersQueryPort(),
      uow,
      new TaskManagementRepository(),
      audit,
      activity,
      search,
      new PostgresNotificationWritePort(),
      new PostgresModuleReadPort(),
      new PostgresProjectsWritePort(),
      new PostgresUserReadPort(),
    ),
    commands = new SqlTaskDeletionCommandPort(
      management,
      new TaskManagementRepository(),
    ),
    groups = new SqlTaskGroupDeletionPort(
      new PostgresTaskBranchQueryPort(new TaskGroupRepository()),
      new TaskGroupRepository(),
    ),
    deletion = new TaskDeletionWorkflow(
      uow,
      commands,
      audit,
      activity,
      search,
      new ExternalLinksCommandPort(new ExternalLinksRepository()),
      new RecordLifecycleTaskRecordVoidPort(
        new RecordLifecycleService(
          access,
          new PostgresModuleQueryPort(),
          new PostgresFeatureQueryPort(),
          new RecordPublicationRepository(),
          new PublishedRecordRepository(),
          new RecordLifecycleRepository(),
          audit,
          activity,
          search,
          new LeftoverSearchProjectionSync(search),
        ),
      ),
      groups,
    ),
    auth = new SessionAuthService(
      uow,
      new PostgresUserSessionRepository(),
      tokens,
    ),
    mutation = new AuthenticatedMutationService(
      auth,
      new PostgresSessionCsrfTokenRepository(),
      tokens,
    ),
    idempotency = new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    );
  class TestModule {}
  Module({
    controllers: [TaskDeletionController],
    providers: [
      {
        provide: TaskDeletionHttpService,
        useValue: new TaskDeletionHttpService(
          mutation,
          idempotency,
          deletion,
          commands,
        ),
      },
    ],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: ["error"] });
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
  const cookie = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  const [row] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions(user_id,token_hash,token_hash_key_version,auth_version_at_issue,auth_state,recovery_rotation_generation,recovery_rotation_consumed_generation,idle_expires_at,absolute_expires_at) VALUES (${userId},${tokens.hash(cookie).hash},1,1,'AUTHENTICATED',0,0,now()+interval '1 hour',now()+interval '1 day') RETURNING id`;
  if (!row) throw new Error("session fixture returned no row");
  await client.sql`INSERT INTO app.session_csrf_tokens(session_id,token_hash,expires_at) VALUES (${row.id},${tokens.hash(csrf).hash},now()+interval '1 hour')`;
  return { cookie: `__Host-session=${cookie}`, csrf };
}

async function fixture(options: { readonly admin?: boolean } = {}) {
  const userId = await createUser(client.sql, options),
    project = await createProject(client.sql, userId);
  return { ...project, userId, actor: await session(userId) };
}

interface TaskFixture {
  readonly id: number;
  readonly rowVersion: number;
}

let sequences = 0;
/** 夹具任务一律走模块级范围（feature_id 为空），与 deleteModuleTask 路由对齐。 */
async function createTask(
  project: ProjectFixture,
  creatorId: number,
  title: string,
  workStatus: "TODO" | "DONE" | "CANCELED" = "TODO",
): Promise<TaskFixture> {
  sequences += 1;
  const completedAt = workStatus === "DONE" ? new Date().toISOString() : null;
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number; rowVersion: number }[]
    >`INSERT INTO app.tasks(project_id,module_id,feature_id,scope_type,code,title,creator_id,work_status,lifecycle_status,completed_at) VALUES (${project.projectId},${project.moduleId},NULL,'MODULE',${`${project.code}-T-${sequences}`},${title},${creatorId},${workStatus},'ACTIVE',${completedAt}) RETURNING id, row_version AS "rowVersion"`;
    if (!row) throw new Error("task fixture returned no row");
    await tx`INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES (${row.id}, ${creatorId}, ${project.projectId})`;
    await tx`INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, changed_by) VALUES (${row.id}, ${project.projectId}, NULL, ${workStatus}, ${completedAt}, ${creatorId})`;
    return row;
  });
}

let recordSequences = 0;
/**
 * 直接落一条已发布记录：删除路径只关心 `status = 'PUBLISHED' AND task_id = ?`，
 * 走完整发布流程会引入与本次语义无关的任务状态门禁。版本行必须同事务写入，
 * 否则提交时会被 `change_records_versions_complete` 拒绝。
 */
async function publishRecord(
  project: ProjectFixture,
  taskId: number,
  authorId: number,
  title: string,
): Promise<number> {
  recordSequences += 1;
  const payload = {
    title,
    contextProblem: "同一回调被重放",
    changeSolution: "按回调 ID 去重",
    resultVerification: "重复回调只落一条",
  };
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO app.change_records(project_id,module_id,feature_id,scope_type,code,title,handler_id,author_id,status,current_version,current_payload,published_at,task_id) VALUES (${project.projectId},${project.moduleId},NULL,'MODULE',${`${project.code}-CR-${recordSequences}`},${title},${authorId},${authorId},'PUBLISHED',1,${JSON.stringify(payload)}::jsonb,now(),${taskId}) RETURNING id`;
    if (!row) throw new Error("record fixture returned no row");
    await tx`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) VALUES (${row.id},${project.projectId},1,${title},${JSON.stringify(payload)}::jsonb,${authorId})`;
    return row.id;
  });
}

async function addTaskLink(
  project: ProjectFixture,
  taskId: number,
  creatorId: number,
  url: string,
): Promise<number> {
  return client.sql.begin(async (tx) => {
    const [link] = await tx<
      { id: number }[]
    >`INSERT INTO app.external_links (project_id,display_url,normalized_url,provider,kind,created_by) VALUES (${project.projectId},${url},${url},'GITHUB','OTHER',${creatorId}) RETURNING id`;
    if (!link) throw new Error("link fixture returned no row");
    await tx`INSERT INTO app.task_external_links (project_id,task_id,link_id) VALUES (${project.projectId},${taskId},${link.id})`;
    return link.id;
  });
}

async function addSearchRow(
  project: ProjectFixture,
  taskId: number,
  title: string,
): Promise<void> {
  await client.sql`
    INSERT INTO app.search_projection(project_id,entity_type,entity_id,title,summary,raw_text,normalized_search_text,visibility_scope,source_status,source_row_version,module_id)
    VALUES (${project.projectId},'TASK',${taskId},${title},'',${title},${title},'MEMBER','TODO',1,${project.moduleId})`;
}

let groupSequences = 0;
async function createGroup(
  project: ProjectFixture,
  createdBy: number,
  mainTaskId: number,
  sourceTaskIds: readonly number[],
): Promise<number> {
  groupSequences += 1;
  return client.sql.begin(async (tx) => {
    const [group] = await tx<
      { id: number }[]
    >`INSERT INTO app.task_groups(project_id,code,name,status,created_by) VALUES (${project.projectId},${`${project.code}-TG-${groupSequences}`},'删除夹具聚合组','ACTIVE',${createdBy}) RETURNING id`;
    if (!group) throw new Error("group fixture returned no row");
    await tx`INSERT INTO app.task_group_members(group_id,task_id,project_id,role,source_kind,original_work_status,original_assignee_id) VALUES (${group.id},${mainTaskId},${project.projectId},'MAIN',NULL,NULL,NULL)`;
    for (const taskId of sourceTaskIds)
      await tx`INSERT INTO app.task_group_members(group_id,task_id,project_id,role,source_kind,original_work_status,original_assignee_id) VALUES (${group.id},${taskId},${project.projectId},'SOURCE','HISTORICAL','DONE',${createdBy})`;
    return group.id;
  });
}

async function remove(
  actor: Actor | undefined,
  project: ProjectFixture,
  taskId: number,
  options: {
    readonly body?: unknown;
    readonly csrf?: string;
    readonly idempotencyKey?: string | null;
    readonly version?: number;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: base,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "If-Match": `"${options.version ?? 1}"`,
  };
  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }
  if (actor) {
    headers["cookie"] = actor.cookie;
    headers["x-csrf-token"] = options.csrf ?? actor.csrf;
  }
  return fetch(
    `${base}/api/v1/projects/${project.projectId}/modules/${project.moduleId}/tasks/${taskId}/delete`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? { reason: "与已完成任务重复" }),
    },
  );
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

const taskRow = async (taskId: number) =>
  (
    await client.sql<
      {
        deletedAt: Date | null;
        deletedBy: number | null;
        rowVersion: number;
      }[]
    >`SELECT deleted_at AS "deletedAt", deleted_by AS "deletedBy", row_version AS "rowVersion" FROM app.tasks WHERE id = ${taskId}`
  )[0];

const auditRows = (projectId: number, action: string) =>
  auditReader.sql<
    { action: string; actorId: number | null; payload: unknown }[]
  >`SELECT action, actor_id AS "actorId", event_payload AS payload FROM app.audit_logs WHERE project_id = ${projectId} AND action = ${action} ORDER BY sequence_no`;

const activityRows = (projectId: number, entityId: number) =>
  client.sql<
    {
      activityType: string;
      sourceStatus: string;
      sourceRowVersion: number;
      summary: string;
    }[]
  >`SELECT activity_type AS "activityType", source_status AS "sourceStatus", source_row_version AS "sourceRowVersion", summary FROM app.activity_projection WHERE project_id = ${projectId} AND source_entity_id = ${entityId} ORDER BY id`;

describe("ADR-058 删除任务", () => {
  it("删除同一事务内软删除任务、解除链接、作废记录并保留审计与动态", async () => {
    const project = await fixture(),
      task = await createTask(project, project.userId, "重复回调处理"),
      recordId = await publishRecord(
        project,
        task.id,
        project.userId,
        "重复回调处理记录",
      ),
      linkId = await addTaskLink(
        project,
        task.id,
        project.userId,
        "https://github.com/256-code/InPulse/commit/9f2c41ab77de",
      );
    await addSearchRow(project, task.id, "重复回调处理");

    const response = await remove(project.actor, project, task.id, {
      version: task.rowVersion,
      body: { reason: "与已完成任务重复" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      schemaRegistry.TaskDeletionResponse.schema.parse(await response.json()),
    ).toMatchObject({
      id: task.id,
      projectId: project.projectId,
      moduleId: project.moduleId,
      featureId: null,
      workStatus: "TODO",
      deletedBy: project.userId,
      voidedRecordCount: 1,
      removedLinkCount: 1,
      detachedGroupRole: null,
    });

    // 软删除：行保留、两列同时落值、行版本恰好 +1（ADR-049 同范式）。
    expect(await taskRow(task.id)).toMatchObject({
      deletedBy: project.userId,
      rowVersion: task.rowVersion + 1,
    });
    expect((await taskRow(task.id))?.deletedAt).not.toBeNull();

    // 链接关联行解除，链接本体仍在（项目面板聚合结果不受影响）。
    const [linkRow] = await client.sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM app.task_external_links WHERE task_id = ${task.id}`;
    expect(linkRow?.count).toBe("0");
    expect(
      (
        await client.sql<
          { id: number }[]
        >`SELECT id FROM app.external_links WHERE id = ${linkId}`
      ).length,
    ).toBe(1);

    // 记录作废但版本、快照与正文全部保留。
    expect(
      (
        await client.sql<
          { status: string; voidReason: string | null; voidedAt: Date | null }[]
        >`SELECT status, void_reason AS "voidReason", voided_at AS "voidedAt" FROM app.change_records WHERE id = ${recordId}`
      )[0],
    ).toMatchObject({ status: "VOID", voidReason: "与已完成任务重复" });
    expect(
      (
        await client.sql<
          { versionNo: number }[]
        >`SELECT version_no AS "versionNo" FROM app.change_record_versions WHERE record_id = ${recordId}`
      ).length,
    ).toBe(1);

    // 审计与项目动态：删除这件事必须留痕，且动态对成员可见。
    const audits = await auditRows(project.projectId, "task.delete");
    expect(audits.length).toBe(1);
    expect(audits[0]?.actorId).toBe(project.userId);
    expect(audits[0]?.payload).toMatchObject({
      taskId: task.id,
      reason: "与已完成任务重复",
      removedLinkCount: 1,
    });
    const rows = await activityRows(project.projectId, task.id);
    expect(rows.map((row) => row.activityType)).toContain("TASK_DELETED");
    expect(rows[0]).toMatchObject({
      sourceStatus: "DELETED",
      sourceRowVersion: task.rowVersion + 1,
    });

    // 搜索投影删除，任务从全部任务级读路径消失。
    expect(
      (
        await client.sql<
          { id: number }[]
        >`SELECT id FROM app.search_projection WHERE project_id = ${project.projectId} AND entity_type = 'TASK' AND entity_id = ${task.id}`
      ).length,
    ).toBe(0);
    const found = await uow.run((tx) =>
      new TaskManagementRepository().find(
        tx,
        {
          projectId: project.projectId,
          moduleId: project.moduleId,
          featureId: null,
        },
        task.id,
      ),
    );
    expect(found).toBeUndefined();
  });

  it("请求体只允许 reason，未带幂等键或 CSRF 时按既有写命令口径拒绝", async () => {
    const project = await fixture(),
      task = await createTask(project, project.userId, "参数校验用任务");

    const anonymous = await failure(
      await remove(
        { cookie: "__Host-session=absent", csrf: "a".repeat(43) },
        project,
        task.id,
      ),
      401,
    );
    expect(anonymous.code).toBe("TASK_SESSION_REQUIRED");
    // 既有写命令口径：无 Session 与 CSRF 不匹配都归为认证失效，不单独区分。
    const wrongCsrf = await failure(
      await remove(project.actor, project, task.id, { csrf: "b".repeat(43) }),
      401,
    );
    expect(wrongCsrf.code).toBe("TASK_SESSION_REQUIRED");
    const missingKey = await failure(
      await remove(project.actor, project, task.id, { idempotencyKey: null }),
      400,
    );
    expect(missingKey.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await failure(
      await remove(project.actor, project, task.id, {
        body: { reason: "重复", unexpected: true },
      }),
      422,
    );
    await failure(
      await remove(project.actor, project, task.id, {
        body: { reason: "   " },
      }),
      422,
    );
    expect(await taskRow(task.id)).toMatchObject({ deletedBy: null });
  });

  it("If-Match 版本过期返回 409 且不落任何删除副作用", async () => {
    const project = await fixture(),
      task = await createTask(project, project.userId, "版本冲突用任务"),
      recordId = await publishRecord(
        project,
        task.id,
        project.userId,
        "版本冲突用记录",
      );

    await client.sql`UPDATE app.tasks SET title = '版本冲突用任务（已改）', row_version = row_version + 1, updated_at = now() WHERE id = ${task.id}`;
    const body = await failure(
      await remove(project.actor, project, task.id, {
        version: task.rowVersion,
      }),
      409,
    );
    expect(body.code).toBe("TASK_STATE_CONFLICT");
    expect(await taskRow(task.id)).toMatchObject({
      deletedBy: null,
      rowVersion: task.rowVersion + 1,
    });
    expect(
      (
        await client.sql<
          { status: string }[]
        >`SELECT status FROM app.change_records WHERE id = ${recordId}`
      )[0]?.status,
    ).toBe("PUBLISHED");
  });

  it("任务不存在、跨项目与无项目成员关系统一 404，不泄露资源存在性", async () => {
    const project = await fixture(),
      other = await fixture(),
      task = await createTask(project, project.userId, "归属校验用任务");

    await failure(await remove(project.actor, project, 2147483647), 404);
    await failure(await remove(project.actor, other, task.id), 404);

    const outsider = await createUser(client.sql),
      outsiderActor = await session(outsider);
    await failure(await remove(outsiderActor, project, task.id), 404);
    expect(await taskRow(task.id)).toMatchObject({ deletedBy: null });
  });

  it("同一幂等键与同一摘要重放原响应，摘要不同返回 409", async () => {
    const project = await fixture(),
      task = await createTask(project, project.userId, "幂等重放用任务"),
      idempotencyKey = randomUUID();

    const first = await remove(project.actor, project, task.id, {
      idempotencyKey,
      version: task.rowVersion,
      body: { reason: "重复任务" },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const replay = await remove(project.actor, project, task.id, {
      idempotencyKey,
      version: task.rowVersion,
      body: { reason: "重复任务" },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const conflict = await remove(project.actor, project, task.id, {
      idempotencyKey,
      version: task.rowVersion,
      body: { reason: "换一个理由" },
    });
    await failure(conflict, 409);

    // 重放不会二次作废或重复计数。
    expect((await auditRows(project.projectId, "task.delete")).length).toBe(1);
  });

  it("非管理员的项目成员（组长与普通成员）都能删除任务并作废其记录", async () => {
    const project = await fixture(),
      memberId = await createUser(client.sql);
    await client.sql`INSERT INTO app.project_members(project_id,user_id) VALUES (${project.projectId},${memberId})`;
    const member = await session(memberId),
      task = await createTask(project, project.userId, "成员删除用任务"),
      recordId = await publishRecord(
        project,
        task.id,
        project.userId,
        "成员删除用记录",
      );

    const response = await remove(member, project, task.id, {
      version: task.rowVersion,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      (
        await client.sql<
          { status: string }[]
        >`SELECT status FROM app.change_records WHERE id = ${recordId}`
      )[0]?.status,
    ).toBe("VOID");
  });

  it("聚合组来源任务被删除时解除关系；最后一个来源离开时关闭聚合组", async () => {
    const project = await fixture(),
      main = await createTask(project, project.userId, "聚合主任务"),
      sourceA = await createTask(project, project.userId, "聚合来源一", "DONE"),
      sourceB = await createTask(project, project.userId, "聚合来源二", "DONE"),
      groupId = await createGroup(project, project.userId, main.id, [
        sourceA.id,
        sourceB.id,
      ]);

    const first = await remove(project.actor, project, sourceA.id, {
      version: sourceA.rowVersion,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(
      schemaRegistry.TaskDeletionResponse.schema.parse(await first.json()),
    ).toMatchObject({ detachedGroupRole: "SOURCE" });
    expect(
      (
        await client.sql<
          { status: string; detachReason: string | null }[]
        >`SELECT status, detach_reason AS "detachReason" FROM app.task_group_members WHERE group_id = ${groupId} AND task_id = ${sourceA.id}`
      )[0],
    ).toMatchObject({ status: "DETACHED" });
    expect(
      (
        await client.sql<
          { status: string }[]
        >`SELECT status FROM app.task_groups WHERE id = ${groupId}`
      )[0]?.status,
    ).toBe("ACTIVE");

    const second = await remove(project.actor, project, sourceB.id, {
      version: sourceB.rowVersion,
    });
    expect(second.status, await second.clone().text()).toBe(200);
    expect(
      schemaRegistry.TaskDeletionResponse.schema.parse(await second.json()),
    ).toMatchObject({ detachedGroupRole: "SOURCE" });
    // 最后一个来源离开：聚合组关闭，主任务关系一并解除，主任务本身不受影响。
    expect(
      (
        await client.sql<
          { status: string; closedAt: Date | null }[]
        >`SELECT status, closed_at AS "closedAt" FROM app.task_groups WHERE id = ${groupId}`
      )[0],
    ).toMatchObject({ status: "CLOSED" });
    expect(
      (
        await client.sql<
          { status: string }[]
        >`SELECT status FROM app.task_group_members WHERE group_id = ${groupId} AND task_id = ${main.id}`
      )[0]?.status,
    ).toBe("DETACHED");
    expect(await taskRow(main.id)).toMatchObject({ deletedBy: null });
  });

  it("聚合组主任务必须先解除合并才能删除，冲突时任务与链接均保持原状", async () => {
    const project = await fixture(),
      main = await createTask(project, project.userId, "主任务不可删"),
      source = await createTask(project, project.userId, "主任务来源", "DONE"),
      groupId = await createGroup(project, project.userId, main.id, [
        source.id,
      ]),
      linkId = await addTaskLink(
        project,
        main.id,
        project.userId,
        "https://github.com/256-code/InPulse/commit/mainlocked",
      );

    const body = await failure(
      await remove(project.actor, project, main.id, {
        version: main.rowVersion,
      }),
      409,
    );
    expect(body.code).toBe("TASK_GROUP_MAIN_LOCKED");
    expect(body.message).toContain(String(groupId));
    expect(await taskRow(main.id)).toMatchObject({ deletedBy: null });
    expect(
      (
        await client.sql<
          { status: string }[]
        >`SELECT status FROM app.task_groups WHERE id = ${groupId}`
      )[0]?.status,
    ).toBe("ACTIVE");
    expect(
      (
        await client.sql<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM app.task_external_links WHERE task_id = ${main.id} AND link_id = ${linkId}`
      )[0]?.count,
    ).toBe("1");
    expect((await auditRows(project.projectId, "task.delete")).length).toBe(0);
  });

  it("删除后再次删除（新幂等键）返回 404，审计与动态不重复写入", async () => {
    const project = await fixture(),
      task = await createTask(project, project.userId, "重复删除用任务");

    expect(
      (
        await remove(project.actor, project, task.id, {
          version: task.rowVersion,
        })
      ).status,
    ).toBe(200);
    await failure(await remove(project.actor, project, task.id), 404);
    expect((await auditRows(project.projectId, "task.delete")).length).toBe(1);
    expect(await activityRows(project.projectId, task.id)).toHaveLength(1);
  });
});

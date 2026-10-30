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
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import { ModuleManagementRepository } from "../src/modules/modules/module-management.repository.js";
import { SqlModuleDeletionCommandPort } from "../src/modules/modules/module-deletion.command-port.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { ScopeDeletionWorkflow } from "../src/workflows/scope-deletion.workflow.js";
import { ScopeDeletionHttpService } from "../src/workflows/scope-deletion-http.service.js";
import { ScopeDeletionController } from "../src/workflows/scope-deletion.controller.js";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let uow: PostgresUnitOfWork;
let modules: ModuleManagementRepository;
let app: INestApplication;
let base: string;
const key = randomBytes(32);
const tokens = new SessionTokenService(
  VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
);

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-adr096-scope-delete",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-adr096-scope-delete-audit",
  });
  uow = new PostgresUnitOfWork(client);
  modules = new ModuleManagementRepository();
  const access = new PostgresProjectAccessQueryPort(client),
    members = new PostgresProjectMembersQueryPort(),
    roles = new ProjectRoleGateService(
      access,
      members,
      postgresProjectMemberPermissions(),
    ),
    audit = new PostgresAuditWritePort({
      currentVersion: 1,
      keyFor: () => key,
    }),
    activity = new PostgresActivityWritePort(),
    deletion = new ScopeDeletionWorkflow(
      uow,
      access,
      new SqlModuleDeletionCommandPort(roles, modules),
      audit,
      activity,
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
    controllers: [ScopeDeletionController],
    providers: [
      {
        provide: ScopeDeletionHttpService,
        useValue: new ScopeDeletionHttpService(
          mutation,
          idempotency,
          deletion,
          roles,
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

/** 加入一名普通成员（非组长），用于权限矩阵用例。 */
async function joinMember(projectId: number, role = "MEMBER"): Promise<number> {
  const userId = await createUser(client.sql);
  await client.sql`INSERT INTO app.project_members(project_id,user_id,role) VALUES (${projectId},${userId},${role})`;
  return userId;
}

/** 把组长身份转交给新成员，原组长降级为普通成员（数据库要求恰好一名组长）。 */
async function transferLeader(
  projectId: number,
  currentLeaderId: number,
): Promise<number> {
  const successorId = await createUser(client.sql);
  await client.sql.begin(async (tx) => {
    await tx`UPDATE app.project_members SET role = 'MEMBER' WHERE project_id = ${projectId} AND user_id = ${currentLeaderId}`;
    await tx`INSERT INTO app.project_members(project_id,user_id,role) VALUES (${projectId},${successorId},'LEADER')`;
  });
  return successorId;
}

interface Scope {
  readonly moduleId: number;
}

let moduleSequences = 0;
async function createNormalModule(
  project: ProjectFixture,
  actorId: number,
  name: string,
): Promise<{ id: number; code: string; rowVersion: number }> {
  moduleSequences += 1;
  const code = `${project.code}-M-${moduleSequences}`;
  const [row] = await client.sql<
    { id: number; code: string; rowVersion: number }[]
  >`INSERT INTO app.modules(project_id,name,kind,code,created_by) VALUES (${project.projectId},${name},'NORMAL',${code},${actorId}) RETURNING id, code, row_version AS "rowVersion"`;
  if (!row) throw new Error("module fixture returned no row");
  return { id: row.id, code: row.code, rowVersion: row.rowVersion };
}

interface TaskFixture {
  readonly id: number;
  readonly rowVersion: number;
}

let taskSequences = 0;
/** 夹具任务与真实写路径同形：负责人与状态历史同事务写入。 */
async function createTask(
  project: ProjectFixture,
  scope: Scope,
  creatorId: number,
  title: string,
): Promise<TaskFixture> {
  taskSequences += 1;
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number; rowVersion: number }[]
    >`INSERT INTO app.tasks(project_id,module_id,code,title,creator_id,work_status,lifecycle_status) VALUES (${project.projectId},${scope.moduleId},${`${project.code}-T-${taskSequences}`},${title},${creatorId},'TODO','ACTIVE') RETURNING id, row_version AS "rowVersion"`;
    if (!row) throw new Error("task fixture returned no row");
    await tx`INSERT INTO app.task_assignees (task_id, user_id, project_id) VALUES (${row.id}, ${creatorId}, ${project.projectId})`;
    await tx`INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, changed_by) VALUES (${row.id}, ${project.projectId}, NULL, 'TODO', NULL, ${creatorId})`;
    return row;
  });
}

let recordSequences = 0;
/**
 * 直接落一条已发布记录：删除路径只关心 `status = 'PUBLISHED'` 与范围列，
 * 走完整发布流程会引入与本次语义无关的任务状态门禁。版本行必须同事务写入，
 * 否则提交时会被 `change_records_versions_complete` 拒绝。
 */
async function publishRecord(
  project: ProjectFixture,
  scope: Scope,
  authorId: number,
  title: string,
): Promise<number> {
  recordSequences += 1;
  const payload = {
    title,
    contextProblem: "模块下线后旧入口仍可访问",
    changeSolution: "删除模块时级联物理删除记录",
    resultVerification: "记录与版本均已物理删除",
  };
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO app.change_records(project_id,module_id,code,title,handler_id,author_id,status,current_version,current_payload,published_at) VALUES (${project.projectId},${scope.moduleId},${`${project.code}-CR-${recordSequences}`},${title},${authorId},${authorId},'PUBLISHED',1,${JSON.stringify(payload)}::jsonb,now()) RETURNING id`;
    if (!row) throw new Error("record fixture returned no row");
    await tx`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) VALUES (${row.id},${project.projectId},1,${title},${JSON.stringify(payload)}::jsonb,${authorId})`;
    return row.id;
  });
}

/** 草稿没有版本行，`current_version` 必须为 0，`code` 必须为 NULL（`change_records_state_check`）。 */
async function createDraftRecord(
  project: ProjectFixture,
  scope: Scope,
  authorId: number,
  title: string,
): Promise<number> {
  recordSequences += 1;
  const [row] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.change_records(project_id,module_id,code,title,handler_id,author_id,status,current_version,current_payload) VALUES (${project.projectId},${scope.moduleId},NULL,${title},${authorId},${authorId},'DRAFT',0,'{}'::jsonb) RETURNING id`;
  if (!row) throw new Error("draft fixture returned no row");
  return row.id;
}

async function attachTaskLink(
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
  entityType: "MODULE" | "TASK",
  entityId: number,
  moduleId: number,
  title: string,
): Promise<void> {
  await client.sql`
    INSERT INTO app.search_projection(project_id,entity_type,entity_id,title,summary,raw_text,normalized_search_text,visibility_scope,source_status,source_row_version,module_id)
    VALUES (${project.projectId},${entityType},${entityId},${title},'',${title},${title},'MEMBER','TODO',1,${entityType === "MODULE" ? null : moduleId})`;
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

async function attachRecordLink(
  project: ProjectFixture,
  recordId: number,
  creatorId: number,
  url: string,
): Promise<number> {
  return client.sql.begin(async (tx) => {
    const [link] = await tx<
      { id: number }[]
    >`INSERT INTO app.external_links (project_id,display_url,normalized_url,provider,kind,created_by) VALUES (${project.projectId},${url},${url},'GITHUB','OTHER',${creatorId}) RETURNING id`;
    if (!link) throw new Error("link fixture returned no row");
    await tx`INSERT INTO app.change_record_external_links (project_id,change_record_id,link_id) VALUES (${project.projectId},${recordId},${link.id})`;
    return link.id;
  });
}

async function addLeftover(
  project: ProjectFixture,
  recordId: number,
  creatorId: number,
  content: string,
): Promise<number> {
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO app.change_record_leftover_items (record_id,project_id,status,created_by) VALUES (${recordId},${project.projectId},'ACTIVE',${creatorId}) RETURNING id`;
    if (!row) throw new Error("leftover fixture returned no row");
    await tx`INSERT INTO app.change_record_version_leftovers (record_id,version_no,leftover_item_id,project_id,content_snapshot) VALUES (${recordId},1,${row.id},${project.projectId},${content})`;
    return row.id;
  });
}
interface RequestOptions {
  readonly body?: unknown;
  readonly csrf?: string;
  readonly idempotencyKey?: string | null;
  readonly origin?: string;
  readonly version?: number;
}

function headers(
  actor: Actor | undefined,
  options: RequestOptions,
  version: number,
): Record<string, string> {
  const result: Record<string, string> = {
    origin: options.origin ?? base,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "If-Match": `"${options.version ?? version}"`,
    // 请求头 Schema 在认证之前校验，匿名用例也要带形状合法的 CSRF，
    // 否则得到的是 422 而不是 401。
    "x-csrf-token": options.csrf ?? actor?.csrf ?? "a".repeat(43),
  };
  if (options.idempotencyKey !== null) {
    result["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }
  if (actor) {
    result["cookie"] = actor.cookie;
  }
  return result;
}

function deleteModule(
  actor: Actor | undefined,
  project: ProjectFixture,
  moduleId: number,
  version: number,
  options: RequestOptions = {},
) {
  return fetch(
    `${base}/api/v1/projects/${project.projectId}/modules/${moduleId}/delete`,
    {
      method: "POST",
      headers: headers(actor, options, version),
      body: JSON.stringify(options.body ?? { reason: "模块下线" }),
    },
  );
}

async function purgeProject(projectId: number): Promise<void> {
  await client.sql`SELECT * FROM app.purge_project(${projectId})`;
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

const count = async (query: Promise<{ count: string }[]>) =>
  Number((await query)[0]?.count ?? "0");

const rowCount = (table: string, id: number) =>
  count(
    client.sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM ${client.sql(table)} WHERE id = ${id}`,
  );

const columnCount = (table: string, column: string, id: number) =>
  count(
    client.sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM ${client.sql(table)} WHERE ${client.sql(column)} = ${id}`,
  );

const groupState = (groupId: number) =>
  client.sql<
    { status: string; memberCount: number }[]
  >`SELECT status, (SELECT count(*)::int FROM app.task_group_members m WHERE m.group_id = g.id) AS "memberCount" FROM app.task_groups g WHERE g.id = ${groupId}`;

const auditRows = (projectId: number, action: string) =>
  auditReader.sql<
    {
      action: string;
      actorId: number | null;
      payload: Record<string, unknown>;
    }[]
  >`SELECT action, actor_id AS "actorId", event_payload AS payload FROM app.audit_logs WHERE project_id = ${projectId} AND action = ${action} ORDER BY sequence_no`;

const activityRows = (projectId: number, entityId: number) =>
  client.sql<
    {
      activityType: string;
      sourceStatus: string;
      sourceRowVersion: number;
      metadata: Record<string, unknown>;
    }[]
  >`SELECT activity_type AS "activityType", source_status AS "sourceStatus", source_row_version AS "sourceRowVersion", metadata FROM app.activity_projection WHERE project_id = ${projectId} AND source_entity_id = ${entityId} ORDER BY id`;

const searchRows = (projectId: number, entityType: string, entityId: number) =>
  client.sql<
    { id: number }[]
  >`SELECT id FROM app.search_projection WHERE project_id = ${projectId} AND entity_type = ${entityType} AND entity_id = ${entityId}`;

describe("ADR-096 物理删除模块", () => {
  it("删除模块会物理清除全部下级、记录与关联，只保留审计和项目动态", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "结算模块"),
      moduleTask = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "模块级任务",
      ),
      alphaTask = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "对账任务",
      ),
      betaTask = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "开票任务",
      ),
      moduleRecord = await publishRecord(
        project,
        { moduleId: module.id },
        project.userId,
        "模块级记录",
      ),
      alphaRecord = await publishRecord(
        project,
        { moduleId: module.id },
        project.userId,
        "对账记录",
      ),
      draftRecord = await createDraftRecord(
        project,
        { moduleId: module.id },
        project.userId,
        "未发布草稿",
      ),
      leftoverId = await addLeftover(
        project,
        moduleRecord,
        project.userId,
        "删除后仍需处理的对账入口",
      ),
      taskLinkId = await attachTaskLink(
        project,
        alphaTask.id,
        project.userId,
        "https://github.com/256-code/InPulse/commit/1a2b3c4d5e6f",
      ),
      recordLinkId = await attachRecordLink(
        project,
        moduleRecord,
        project.userId,
        "https://github.com/256-code/InPulse/pull/560",
      );

    await addSearchRow(project, "MODULE", module.id, module.id, "结算模块");
    await addSearchRow(project, "TASK", alphaTask.id, module.id, "对账任务");

    const response = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = schemaRegistry.ModuleDeletionResponse.schema.parse(
      await response.json(),
    );
    expect(body).toEqual({
      id: module.id,
      projectId: project.projectId,
      code: module.code,
      name: "结算模块",
      kind: "NORMAL",
      deletedTaskCount: 3,
      deletedRecordCount: 3,
      removedLinkCount: 2,
    });

    expect(await rowCount("modules", module.id)).toBe(0);
    for (const taskId of [moduleTask.id, alphaTask.id, betaTask.id]) {
      expect(await rowCount("tasks", taskId)).toBe(0);
      expect(await columnCount("task_status_history", "task_id", taskId)).toBe(
        0,
      );
      expect(await columnCount("task_assignees", "task_id", taskId)).toBe(0);
    }
    for (const recordId of [moduleRecord, alphaRecord, draftRecord]) {
      expect(await rowCount("change_records", recordId)).toBe(0);
      expect(
        await columnCount("change_record_versions", "record_id", recordId),
      ).toBe(0);
      expect(
        await columnCount(
          "change_record_version_leftovers",
          "record_id",
          recordId,
        ),
      ).toBe(0);
    }
    expect(await rowCount("change_record_leftover_items", leftoverId)).toBe(0);

    expect(
      await columnCount("task_external_links", "task_id", alphaTask.id),
    ).toBe(0);
    expect(
      await columnCount(
        "change_record_external_links",
        "change_record_id",
        moduleRecord,
      ),
    ).toBe(0);
    expect(await rowCount("external_links", taskLinkId)).toBe(1);
    expect(await rowCount("external_links", recordLinkId)).toBe(1);

    expect(
      (await searchRows(project.projectId, "MODULE", module.id)).length,
    ).toBe(0);
    expect(
      (await searchRows(project.projectId, "TASK", alphaTask.id)).length,
    ).toBe(0);

    const moduleAudits = await auditRows(project.projectId, "module.delete");
    expect(moduleAudits).toHaveLength(1);
    expect(moduleAudits[0]?.actorId).toBe(project.userId);
    expect(moduleAudits[0]?.payload).toMatchObject({
      moduleId: module.id,
      code: module.code,
      name: "结算模块",
      kind: "NORMAL",
      deletedTaskCount: 3,
      deletedRecordCount: 3,
      removedLinkCount: 2,
      reason: "模块下线",
    });
    expect(await auditRows(project.projectId, "task.delete")).toHaveLength(0);

    const moduleActivity = await activityRows(project.projectId, module.id);
    expect(moduleActivity).toHaveLength(1);
    expect(moduleActivity[0]).toMatchObject({
      activityType: "MODULE_DELETED",
      sourceStatus: "DELETED",
      sourceRowVersion: module.rowVersion + 1,
      metadata: {
        moduleId: module.id,
        code: module.code,
        kind: "NORMAL",
        deletedTaskCount: 3,
        deletedRecordCount: 3,
        removedLinkCount: 2,
      },
    });
    expect(await activityRows(project.projectId, alphaTask.id)).toHaveLength(0);

    const listed = await uow.run((tx) => modules.list(tx, project.projectId));
    expect(listed.map((item) => item.id)).not.toContain(module.id);
  });

  it("未分类模块禁止删除：409 且不产生任何副作用", async () => {
    const project = await fixture();
    const before = await uow.run((tx) =>
      modules.find(tx, project.projectId, project.moduleId),
    );
    const response = await deleteModule(
      project.actor,
      project,
      project.moduleId,
      before?.rowVersion ?? 1,
    );
    const body = await failure(response, 409);
    expect(body.code).toBe("MODULE_UNCLASSIFIED_PROTECTED");
    expect(await rowCount("modules", project.moduleId)).toBe(1);
    expect(await auditRows(project.projectId, "module.delete")).toHaveLength(0);
    expect(
      await activityRows(project.projectId, project.moduleId),
    ).toHaveLength(0);
  });

  it("删除仅限系统管理员或本项目组长，其余 403 / 404 / 401", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "权限模块"),
      memberId = await joinMember(project.projectId),
      member = await session(memberId),
      outsider = await session(await createUser(client.sql));

    expect(
      (
        await failure(
          await deleteModule(member, project, module.id, module.rowVersion),
          403,
        )
      ).code,
    ).toBe("MODULE_DELETE_FORBIDDEN");
    expect(
      (
        await failure(
          await deleteModule(outsider, project, module.id, module.rowVersion),
          404,
        )
      ).code,
    ).toBe("MODULE_NOT_FOUND");
    expect(
      (
        await failure(
          await deleteModule(undefined, project, module.id, module.rowVersion),
          401,
        )
      ).code,
    ).toBe("MODULE_SESSION_REQUIRED");
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
            { csrf: randomBytes(32).toString("base64url") },
          ),
          401,
        )
      ).code,
    ).toBe("MODULE_SESSION_REQUIRED");
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
            { origin: "https://evil.example.com" },
          ),
          403,
        )
      ).code,
    ).toBe("CSRF_ORIGIN_REJECTED");

    expect(await rowCount("modules", module.id)).toBe(1);

    const adminId = await createUser(client.sql, { admin: true }),
      adminActor = await session(adminId);
    const response = await deleteModule(
      adminActor,
      project,
      module.id,
      module.rowVersion,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      schemaRegistry.ModuleDeletionResponse.schema.parse(await response.json()),
    ).toMatchObject({ id: module.id });
    expect(await rowCount("modules", module.id)).toBe(0);
    expect(
      (await auditRows(project.projectId, "module.delete"))[0]?.actorId,
    ).toBe(adminId);
  });

  it("版本不匹配时 409，且模块、任务与记录都保持原状", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "版本模块"),
      task = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "版本任务",
      ),
      recordId = await publishRecord(
        project,
        { moduleId: module.id },
        project.userId,
        "版本记录",
      );

    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion + 7,
          ),
          409,
        )
      ).code,
    ).toBe("MODULE_VERSION_CONFLICT");
    expect(await rowCount("modules", module.id)).toBe(1);
    expect(await rowCount("tasks", task.id)).toBe(1);
    expect(await rowCount("change_records", recordId)).toBe(1);
    expect(await auditRows(project.projectId, "module.delete")).toHaveLength(0);
  });

  it("幂等重放返回原响应且不重复删除，角色变化后重放被拒绝", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "幂等模块"),
      task = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "幂等任务",
      ),
      recordId = await publishRecord(
        project,
        { moduleId: module.id },
        project.userId,
        "幂等记录",
      ),
      idempotencyKey = randomUUID();

    const first = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
      { idempotencyKey },
    );
    expect(first.status, await first.clone().text()).toBe(200);
    const original = schemaRegistry.ModuleDeletionResponse.schema.parse(
      await first.json(),
    );
    const replay = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
      { idempotencyKey },
    );
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(
      schemaRegistry.ModuleDeletionResponse.schema.parse(await replay.json()),
    ).toEqual(original);
    expect(await auditRows(project.projectId, "module.delete")).toHaveLength(1);
    expect(await rowCount("modules", module.id)).toBe(0);
    expect(await rowCount("tasks", task.id)).toBe(0);
    expect(await rowCount("change_records", recordId)).toBe(0);

    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
            { idempotencyKey, body: { reason: "另一个原因" } },
          ),
          409,
        )
      ).code,
    ).toBe("IDEMPOTENCY_REQUEST_MISMATCH");
    await transferLeader(project.projectId, project.userId);
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
            { idempotencyKey },
          ),
          403,
        )
      ).code,
    ).toBe("MODULE_DELETE_FORBIDDEN");
  });

  it("并发删除同一模块只有一个成功，另一个按不存在处理", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "并发模块"),
      task = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "并发任务",
      );

    const [left, right] = await Promise.all([
      deleteModule(project.actor, project, module.id, module.rowVersion),
      deleteModule(project.actor, project, module.id, module.rowVersion),
    ]);
    expect([left.status, right.status].sort((a, b) => a - b)).toEqual([
      200, 404,
    ]);
    const failed = left.status === 404 ? left : right;
    expect(
      schemaRegistry.ErrorResponse.schema.parse(await failed.json()).code,
    ).toBe("MODULE_NOT_FOUND");
    expect(await auditRows(project.projectId, "module.delete")).toHaveLength(1);
    expect(await rowCount("modules", module.id)).toBe(0);
    expect(await rowCount("tasks", task.id)).toBe(0);
  });

  it("已物理删除的模块再次删除返回 404；项目物理删除后同样 404", async () => {
    const project = await fixture(),
      module = await createNormalModule(
        project,
        project.userId,
        "重复删除模块",
      );
    expect(
      (await deleteModule(project.actor, project, module.id, module.rowVersion))
        .status,
    ).toBe(200);
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion + 1,
          ),
          404,
        )
      ).code,
    ).toBe("MODULE_NOT_FOUND");
    const second = await createNormalModule(
      project,
      project.userId,
      "第二模块",
    );
    await purgeProject(project.projectId);
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            second.id,
            second.rowVersion,
          ),
          404,
        )
      ).code,
    ).toBe("MODULE_NOT_FOUND");
  });

  it("聚合组主任务不再阻断删除；组关闭并在无成员时清除", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "聚合组模块"),
      source = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "来源任务",
      ),
      main = await createTask(
        project,
        { moduleId: module.id },
        project.userId,
        "主任务",
      ),
      groupId = await createGroup(project, project.userId, main.id, [
        source.id,
      ]);
    const response = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await rowCount("modules", module.id)).toBe(0);
    expect(await rowCount("tasks", main.id)).toBe(0);
    expect(await rowCount("tasks", source.id)).toBe(0);
    expect(await groupState(groupId)).toEqual([]);
    expect(await auditRows(project.projectId, "module.delete")).toHaveLength(1);
  });
});

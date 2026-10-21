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
import { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import { ModuleManagementRepository } from "../src/modules/modules/module-management.repository.js";
import { SqlModuleDeletionCommandPort } from "../src/modules/modules/module-deletion.command-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { FeatureManagementRepository } from "../src/modules/features/feature-management.repository.js";
import { SqlFeatureDeletionCommandPort } from "../src/modules/features/feature-deletion.command-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { SqlTaskDeletionCommandPort } from "../src/modules/tasks/task-deletion.command-port.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
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
import { RecordLifecycleScopeVoidPort } from "../src/modules/change-records/record-scope-void.port.js";
import { TaskGroupRepository } from "../src/modules/task-groups/task-group.repository.js";
import { PostgresTaskBranchQueryPort } from "../src/modules/task-groups/task-branch-query.port.js";
import { SqlTaskGroupDeletionPort } from "../src/modules/task-groups/task-group-deletion.port.js";
import { TaskDeletionWorkflow } from "../src/workflows/task-deletion.workflow.js";
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
    applicationName: "inpulse-adr059-scope-delete",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-adr059-scope-delete-audit",
  });
  uow = new PostgresUnitOfWork(client);
  modules = new ModuleManagementRepository();
  const access = new PostgresProjectAccessQueryPort(client),
    members = new PostgresProjectMembersQueryPort(),
    roles = new ProjectRoleGateService(access, members),
    audit = new PostgresAuditWritePort({
      currentVersion: 1,
      keyFor: () => key,
    }),
    activity = new PostgresActivityWritePort(),
    search = new PostgresSearchProjectionWritePort(),
    lifecycle = new RecordLifecycleService(
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
    management = new TasksManagementService(
      access,
      new PostgresModuleQueryPort(),
      new PostgresFeatureQueryPort(),
      new PostgresFeatureReadPort(),
      new PostgresProjectCodePort(),
      members,
      uow,
      new TaskManagementRepository(),
      audit,
      activity,
      search,
      new ProjectNotificationDispatcher(
        access,
        new PostgresNotificationWritePort(),
      ),
      new PostgresModuleReadPort(),
      new PostgresProjectsWritePort(),
    ),
    tasks = new SqlTaskDeletionCommandPort(
      management,
      new TaskManagementRepository(),
    ),
    links = new ExternalLinksCommandPort(new ExternalLinksRepository()),
    taskDeletion = new TaskDeletionWorkflow(
      uow,
      tasks,
      audit,
      activity,
      search,
      links,
      new RecordLifecycleTaskRecordVoidPort(lifecycle),
      new SqlTaskGroupDeletionPort(
        new PostgresTaskBranchQueryPort(new TaskGroupRepository()),
        new TaskGroupRepository(),
      ),
    ),
    deletion = new ScopeDeletionWorkflow(
      uow,
      access,
      new SqlModuleDeletionCommandPort(roles, modules),
      new SqlFeatureDeletionCommandPort(
        roles,
        new FeatureManagementRepository(),
      ),
      tasks,
      taskDeletion,
      new RecordLifecycleScopeVoidPort(lifecycle),
      links,
      audit,
      activity,
      search,
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
  readonly featureId: number | null;
}

let moduleSequences = 0;
async function createNormalModule(
  project: ProjectFixture,
  actorId: number,
  name: string,
): Promise<{ id: number; code: string; rowVersion: number }> {
  moduleSequences += 1;
  const [row] = await client.sql<
    { id: number; rowVersion: number }[]
  >`INSERT INTO app.modules(project_id,name,kind,code,created_by) VALUES (${project.projectId},${name},'NORMAL',${`${project.code}-M-${moduleSequences}`},${actorId}) RETURNING id, row_version AS "rowVersion"`;
  if (!row) throw new Error("module fixture returned no row");
  return {
    id: row.id,
    code: `${project.code}-M-${moduleSequences}`,
    rowVersion: row.rowVersion,
  };
}

let featureSequences = 0;
async function createFeature(
  project: ProjectFixture,
  moduleId: number,
  actorId: number,
  name: string,
): Promise<{ id: number; rowVersion: number }> {
  featureSequences += 1;
  const [row] = await client.sql<
    { id: number; rowVersion: number }[]
  >`INSERT INTO app.features(project_id,module_id,code,name,created_by) VALUES (${project.projectId},${moduleId},${`${project.code}-F-${featureSequences}`},${name},${actorId}) RETURNING id, row_version AS "rowVersion"`;
  if (!row) throw new Error("feature fixture returned no row");
  return row;
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
    >`INSERT INTO app.tasks(project_id,module_id,feature_id,scope_type,code,title,creator_id,work_status,lifecycle_status) VALUES (${project.projectId},${scope.moduleId},${scope.featureId},${scope.featureId === null ? "MODULE" : "FEATURE"},${`${project.code}-T-${taskSequences}`},${title},${creatorId},'TODO','ACTIVE') RETURNING id, row_version AS "rowVersion"`;
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
    changeSolution: "删除模块时级联作废记录",
    resultVerification: "记录状态为 VOID 且版本保留",
  };
  return client.sql.begin(async (tx) => {
    const [row] = await tx<
      { id: number }[]
    >`INSERT INTO app.change_records(project_id,module_id,feature_id,scope_type,code,title,handler_id,author_id,status,current_version,current_payload,published_at) VALUES (${project.projectId},${scope.moduleId},${scope.featureId},${scope.featureId === null ? "MODULE" : "FEATURE"},${`${project.code}-CR-${recordSequences}`},${title},${authorId},${authorId},'PUBLISHED',1,${JSON.stringify(payload)}::jsonb,now()) RETURNING id`;
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
  >`INSERT INTO app.change_records(project_id,module_id,feature_id,scope_type,code,title,handler_id,author_id,status,current_version,current_payload) VALUES (${project.projectId},${scope.moduleId},${scope.featureId},${scope.featureId === null ? "MODULE" : "FEATURE"},NULL,${title},${authorId},${authorId},'DRAFT',0,'{}'::jsonb) RETURNING id`;
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

async function attachFeatureLink(
  project: ProjectFixture,
  featureId: number,
  creatorId: number,
  url: string,
): Promise<number> {
  return client.sql.begin(async (tx) => {
    const [link] = await tx<
      { id: number }[]
    >`INSERT INTO app.external_links (project_id,display_url,normalized_url,provider,kind,created_by) VALUES (${project.projectId},${url},${url},'GITHUB','OTHER',${creatorId}) RETURNING id`;
    if (!link) throw new Error("link fixture returned no row");
    await tx`INSERT INTO app.feature_external_links (project_id,feature_id,link_id) VALUES (${project.projectId},${featureId},${link.id})`;
    return link.id;
  });
}

async function addImpact(
  project: ProjectFixture,
  taskId: number,
  featureId: number,
  moduleId: number,
): Promise<void> {
  await client.sql`INSERT INTO app.task_feature_impacts(task_id,feature_id,module_id,project_id) VALUES (${taskId},${featureId},${moduleId},${project.projectId})`;
}

async function addSearchRow(
  project: ProjectFixture,
  entityType: "MODULE" | "FEATURE" | "TASK",
  entityId: number,
  moduleId: number,
  featureId: number | null,
  title: string,
): Promise<void> {
  await client.sql`
    INSERT INTO app.search_projection(project_id,entity_type,entity_id,title,summary,raw_text,normalized_search_text,visibility_scope,source_status,source_row_version,module_id,feature_id)
    VALUES (${project.projectId},${entityType},${entityId},${title},'',${title},${title},'MEMBER','TODO',1,${entityType === "MODULE" ? null : moduleId},${featureId})`;
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

function deleteFeature(
  actor: Actor | undefined,
  project: ProjectFixture,
  moduleId: number,
  featureId: number,
  version: number,
  options: RequestOptions = {},
) {
  return fetch(
    `${base}/api/v1/projects/${project.projectId}/modules/${moduleId}/features/${featureId}/delete`,
    {
      method: "POST",
      headers: headers(actor, options, version),
      body: JSON.stringify(options.body ?? { reason: "功能下线" }),
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

const count = async (query: Promise<{ count: string }[]>) =>
  Number((await query)[0]?.count ?? "0");

const deletedState = (table: "modules" | "features", id: number) =>
  client.sql<
    {
      deletedAt: Date | null;
      deletedBy: number | null;
      rowVersion: number;
    }[]
  >`SELECT deleted_at AS "deletedAt", deleted_by AS "deletedBy", row_version AS "rowVersion" FROM ${client.sql(table)} WHERE id = ${id}`;

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

describe("ADR-059 删除模块与功能", () => {
  it("删除模块在同一事务内级联软删除功能与任务、作废已发布记录并保留审计与动态", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "结算模块"),
      alpha = await createFeature(project, module.id, project.userId, "对账"),
      beta = await createFeature(project, module.id, project.userId, "开票"),
      moduleTask = await createTask(
        project,
        { moduleId: module.id, featureId: null },
        project.userId,
        "模块级任务",
      ),
      alphaTask = await createTask(
        project,
        { moduleId: module.id, featureId: alpha.id },
        project.userId,
        "对账任务",
      ),
      betaTask = await createTask(
        project,
        { moduleId: module.id, featureId: beta.id },
        project.userId,
        "开票任务",
      ),
      moduleRecord = await publishRecord(
        project,
        { moduleId: module.id, featureId: null },
        project.userId,
        "模块级记录",
      ),
      alphaRecord = await publishRecord(
        project,
        { moduleId: module.id, featureId: alpha.id },
        project.userId,
        "对账记录",
      ),
      draftRecord = await createDraftRecord(
        project,
        { moduleId: module.id, featureId: alpha.id },
        project.userId,
        "未发布草稿",
      );
    await attachTaskLink(
      project,
      alphaTask.id,
      project.userId,
      "https://github.com/256-code/InPulse/commit/1a2b3c4d5e6f",
    );
    await attachFeatureLink(
      project,
      alpha.id,
      project.userId,
      "https://github.com/256-code/InPulse/issues/559",
    );
    await addSearchRow(
      project,
      "MODULE",
      module.id,
      module.id,
      null,
      "结算模块",
    );
    await addSearchRow(
      project,
      "FEATURE",
      alpha.id,
      module.id,
      alpha.id,
      "对账",
    );
    await addSearchRow(
      project,
      "TASK",
      alphaTask.id,
      module.id,
      alpha.id,
      "对账任务",
    );

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
    expect(body).toMatchObject({
      id: module.id,
      projectId: project.projectId,
      name: "结算模块",
      kind: "NORMAL",
      deletedBy: project.userId,
      deletedFeatureCount: 2,
      deletedTaskCount: 3,
      voidedRecordCount: 2,
      removedLinkCount: 2,
    });

    // 软删除：模块行保留、两列同时落值、行版本恰好 +1（ADR-049 同范式）。
    expect(await deletedState("modules", module.id)).toMatchObject([
      { deletedBy: project.userId, rowVersion: module.rowVersion + 1 },
    ]);
    expect(
      (await deletedState("modules", module.id))[0]?.deletedAt,
    ).not.toBeNull();
    for (const feature of [alpha, beta]) {
      const [row] = await deletedState("features", feature.id);
      expect(row).toMatchObject({
        deletedBy: project.userId,
        rowVersion: feature.rowVersion + 1,
      });
      expect(row?.deletedAt).not.toBeNull();
    }

    // 任务与记录：任务软删除、已发布记录作废、草稿保持原状。
    const [taskCounts] = await client.sql<
      { deleted: string; alive: string }[]
    >`SELECT count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted, count(*) FILTER (WHERE deleted_at IS NULL)::text AS alive FROM app.tasks WHERE module_id = ${module.id}`;
    expect(taskCounts).toMatchObject({ deleted: "3", alive: "0" });
    const records = await client.sql<
      { status: string; voidReason: string | null }[]
    >`SELECT status, void_reason AS "voidReason" FROM app.change_records WHERE module_id = ${module.id} ORDER BY id`;
    expect(records).toEqual([
      { status: "VOID", voidReason: "模块下线" },
      { status: "VOID", voidReason: "模块下线" },
      { status: "DRAFT", voidReason: null },
    ]);
    // 版本与快照保留：作废不改写历史，草稿不进作废范围。
    expect(
      await count(
        client.sql<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM app.change_record_versions WHERE record_id IN (${moduleRecord}, ${alphaRecord})`,
      ),
    ).toBe(2);
    expect(
      await count(
        client.sql<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM app.change_record_versions WHERE record_id = ${draftRecord}`,
      ),
    ).toBe(0);
    for (const task of [moduleTask.id, alphaTask.id, betaTask.id]) {
      const [row] = await client.sql<
        { deletedAt: Date | null }[]
      >`SELECT deleted_at AS "deletedAt" FROM app.tasks WHERE id = ${task}`;
      expect(row?.deletedAt).not.toBeNull();
    }

    // 链接关联行解除，链接本体保留（项目面板聚合结果不受影响）。
    for (const [table, column, id] of [
      ["task_external_links", "task_id", alphaTask.id],
      ["feature_external_links", "feature_id", alpha.id],
    ] as const) {
      expect(
        await count(
          client.sql<
            { count: string }[]
          >`SELECT count(*)::text AS count FROM ${client.sql(table)} WHERE ${client.sql(column)} = ${id}`,
        ),
      ).toBe(0);
    }

    // 审计与项目动态：模块、每个功能、每条任务都各自留痕。
    const moduleAudits = await auditRows(project.projectId, "module.delete");
    expect(moduleAudits.length).toBe(1);
    expect(moduleAudits[0]?.actorId).toBe(project.userId);
    expect(moduleAudits[0]?.payload).toMatchObject({
      moduleId: module.id,
      kind: "NORMAL",
      deletedFeatureIds: [alpha.id, beta.id],
      deletedTaskCount: 3,
      removedLinkCount: 2,
      reason: "模块下线",
    });
    expect(moduleAudits[0]?.payload.voidedRecords).toEqual([
      moduleRecord,
      alphaRecord,
    ]);
    expect((await auditRows(project.projectId, "feature.delete")).length).toBe(
      2,
    );
    expect((await auditRows(project.projectId, "task.delete")).length).toBe(3);

    const moduleActivity = await activityRows(project.projectId, module.id);
    expect(moduleActivity[0]).toMatchObject({
      activityType: "MODULE_DELETED",
      sourceStatus: "DELETED",
      sourceRowVersion: module.rowVersion + 1,
    });
    expect(moduleActivity[0]?.metadata).toMatchObject({
      deletedFeatureCount: 2,
      deletedTaskCount: 3,
    });
    for (const feature of [alpha, beta]) {
      expect(
        (await activityRows(project.projectId, feature.id))[0],
      ).toMatchObject({
        activityType: "FEATURE_DELETED",
        sourceStatus: "DELETED",
      });
    }

    // 搜索投影按实体类型删除，三行都不再可检索。
    expect(
      (await searchRows(project.projectId, "MODULE", module.id)).length,
    ).toBe(0);
    expect(
      (await searchRows(project.projectId, "FEATURE", alpha.id)).length,
    ).toBe(0);
    expect(
      (await searchRows(project.projectId, "TASK", alphaTask.id)).length,
    ).toBe(0);

    // 读路径：模块与功能都不再出现在列表里。
    const listed = await uow.run((tx) => modules.list(tx, project.projectId));
    expect(listed.map((item) => item.id)).not.toContain(module.id);
  });

  it("未分类模块禁止删除：409 且不产生任何副作用", async () => {
    const project = await fixture();
    const response = await deleteModule(
      project.actor,
      project,
      project.moduleId,
      1,
    );
    const body = await failure(response, 409);
    expect(body.code).toBe("MODULE_UNCLASSIFIED_PROTECTED");

    const [row] = await deletedState("modules", project.moduleId);
    expect(row).toMatchObject({
      deletedAt: null,
      deletedBy: null,
      rowVersion: 1,
    });
    expect((await auditRows(project.projectId, "module.delete")).length).toBe(
      0,
    );
  });

  it("删除按 ADR-059 收窄到系统管理员或本项目组长，其余 403 / 404 / 401", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "权限模块"),
      feature = await createFeature(
        project,
        module.id,
        project.userId,
        "权限功能",
      ),
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
          await deleteFeature(
            member,
            project,
            module.id,
            feature.id,
            feature.rowVersion,
          ),
          403,
        )
      ).code,
    ).toBe("FEATURE_DELETE_FORBIDDEN");
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
          await deleteFeature(
            outsider,
            project,
            module.id,
            feature.id,
            feature.rowVersion,
          ),
          404,
        )
      ).code,
    ).toBe("FEATURE_NOT_FOUND");
    expect(
      (
        await failure(
          await deleteModule(undefined, project, module.id, module.rowVersion),
          401,
        )
      ).code,
    ).toBe("MODULE_SESSION_REQUIRED");
    // 无 Session 与 CSRF 不匹配都归为认证失效，不单独区分错误码（同 ADR-058）。
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
    // 跨源请求在进入认证之前就被同源校验拦下。
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

    // 失败路径全部无副作用：模块与功能都还在原位。
    expect((await deletedState("modules", module.id))[0]).toMatchObject({
      deletedAt: null,
      rowVersion: module.rowVersion,
    });
    expect((await deletedState("features", feature.id))[0]).toMatchObject({
      deletedAt: null,
      rowVersion: feature.rowVersion,
    });

    // 系统管理员不受成员关系限制：非成员身份也能删除普通模块。
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
    ).toMatchObject({ id: module.id, deletedBy: adminId });
    expect(
      (await auditRows(project.projectId, "module.delete"))[0]?.actorId,
    ).toBe(adminId);
  });

  it("版本的 `If-Match` 不匹配时 409，且不改动任何行", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "版本模块"),
      feature = await createFeature(
        project,
        module.id,
        project.userId,
        "版本功能",
      ),
      task = await createTask(
        project,
        { moduleId: module.id, featureId: feature.id },
        project.userId,
        "版本任务",
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
    expect(
      (
        await failure(
          await deleteFeature(
            project.actor,
            project,
            module.id,
            feature.id,
            feature.rowVersion + 7,
          ),
          409,
        )
      ).code,
    ).toBe("FEATURE_VERSION_CONFLICT");

    const [moduleRow] = await deletedState("modules", module.id);
    expect(moduleRow).toMatchObject({
      deletedAt: null,
      rowVersion: module.rowVersion,
    });
    const [featureRow] = await deletedState("features", feature.id);
    expect(featureRow).toMatchObject({
      deletedAt: null,
      rowVersion: feature.rowVersion,
    });
    const [taskRow] = await client.sql<
      { deletedAt: Date | null }[]
    >`SELECT deleted_at AS "deletedAt" FROM app.tasks WHERE id = ${task.id}`;
    expect(taskRow?.deletedAt).toBeNull();
  });

  it("删除功能只影响该功能：模块级记录与任务、同级功能都不受影响", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "混合模块"),
      target = await createFeature(
        project,
        module.id,
        project.userId,
        "待删功能",
      ),
      survivor = await createFeature(
        project,
        module.id,
        project.userId,
        "保留功能",
      ),
      moduleTask = await createTask(
        project,
        { moduleId: module.id, featureId: null },
        project.userId,
        "模块级保留任务",
      ),
      survivorTask = await createTask(
        project,
        { moduleId: module.id, featureId: survivor.id },
        project.userId,
        "同级保留任务",
      ),
      targetTask = await createTask(
        project,
        { moduleId: module.id, featureId: target.id },
        project.userId,
        "待删功能的任务",
      ),
      moduleRecord = await publishRecord(
        project,
        { moduleId: module.id, featureId: null },
        project.userId,
        "模块级保留记录",
      ),
      targetRecord = await publishRecord(
        project,
        { moduleId: module.id, featureId: target.id },
        project.userId,
        "待删功能的记录",
      );
    // 模块级任务对目标功能的影响行是历史，不随功能删除消失。
    await addImpact(project, moduleTask.id, target.id, module.id);

    const response = await deleteFeature(
      project.actor,
      project,
      module.id,
      target.id,
      target.rowVersion,
      { body: { reason: null } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      schemaRegistry.FeatureDeletionResponse.schema.parse(
        await response.json(),
      ),
    ).toMatchObject({
      id: target.id,
      projectId: project.projectId,
      moduleId: module.id,
      name: "待删功能",
      deletedBy: project.userId,
      deletedTaskCount: 1,
      voidedRecordCount: 1,
      removedLinkCount: 0,
    });

    expect(
      (await deletedState("features", target.id))[0]?.deletedAt,
    ).not.toBeNull();
    expect(
      (await deletedState("features", survivor.id))[0]?.deletedAt,
    ).toBeNull();
    expect((await deletedState("modules", module.id))[0]?.deletedAt).toBeNull();

    const [targetTaskRow] = await client.sql<
      { deletedAt: Date | null }[]
    >`SELECT deleted_at AS "deletedAt" FROM app.tasks WHERE id = ${targetTask.id}`;
    expect(targetTaskRow?.deletedAt).not.toBeNull();
    for (const taskId of [moduleTask.id, survivorTask.id]) {
      const [row] = await client.sql<
        { deletedAt: Date | null }[]
      >`SELECT deleted_at AS "deletedAt" FROM app.tasks WHERE id = ${taskId}`;
      expect(row?.deletedAt).toBeNull();
    }

    // 记录作废只覆盖该功能；模块级记录保持已发布。
    expect(
      (
        await client.sql<
          { status: string }[]
        >`SELECT status FROM app.change_records WHERE id = ${moduleRecord}`
      )[0],
    ).toMatchObject({ status: "PUBLISHED" });
    const [targetRecordRow] = await client.sql<
      { status: string; voidReason: string | null }[]
    >`SELECT status, void_reason AS "voidReason" FROM app.change_records WHERE id = ${targetRecord}`;
    expect(targetRecordRow).toMatchObject({
      status: "VOID",
      voidReason: "功能已被删除",
    });

    // 影响行保留为历史，读路径靠已删除功能过滤而不是物理删除。
    expect(
      await count(
        client.sql<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM app.task_feature_impacts WHERE task_id = ${moduleTask.id}`,
      ),
    ).toBe(1);

    const audit = await auditRows(project.projectId, "feature.delete");
    expect(audit.length).toBe(1);
    expect(audit[0]?.payload).toMatchObject({
      featureId: target.id,
      cascadeFromModuleId: null,
      deletedTaskCount: 1,
    });
    expect(await activityRows(project.projectId, target.id)).toMatchObject([
      { activityType: "FEATURE_DELETED", sourceStatus: "DELETED" },
    ]);
    expect(
      (await searchRows(project.projectId, "FEATURE", target.id)).length,
    ).toBe(0);
  });

  it("幂等重放返回原响应，并重新复核实时角色", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "幂等模块"),
      feature = await createFeature(
        project,
        module.id,
        project.userId,
        "幂等功能",
      ),
      task = await createTask(
        project,
        { moduleId: module.id, featureId: feature.id },
        project.userId,
        "幂等任务",
      ),
      idempotencyKey = randomUUID();

    const first = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
      {
        idempotencyKey,
      },
    );
    expect(first.status, await first.clone().text()).toBe(200);
    const original = schemaRegistry.ModuleDeletionResponse.schema.parse(
      await first.json(),
    );

    // 同 Key、同摘要重放：返回原 2xx，且不再产生任何新副作用。
    const replay = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
      {
        idempotencyKey,
      },
    );
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(
      schemaRegistry.ModuleDeletionResponse.schema.parse(await replay.json()),
    ).toMatchObject(original);
    expect((await auditRows(project.projectId, "module.delete")).length).toBe(
      1,
    );
    expect((await auditRows(project.projectId, "task.delete")).length).toBe(1);
    expect(
      await count(
        client.sql<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM app.tasks WHERE id = ${task.id}`,
      ),
    ).toBe(1);

    // 摘要变化（原因不同）时同 Key 返回 409，而不是复用原响应。
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
            {
              idempotencyKey,
              body: { reason: "另一个原因" },
            },
          ),
          409,
        )
      ).code,
    ).toBe("IDEMPOTENCY_REQUEST_MISMATCH");

    // 组长被降级为普通成员后重放：实时角色复核拒绝，不泄露已存状态。
    await transferLeader(project.projectId, project.userId);
    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
            {
              idempotencyKey,
            },
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
        { moduleId: module.id, featureId: null },
        project.userId,
        "并发任务",
      );

    const [left, right] = await Promise.all([
      deleteModule(project.actor, project, module.id, module.rowVersion),
      deleteModule(project.actor, project, module.id, module.rowVersion),
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 404]);
    const failed = left.status === 404 ? left : right;
    expect(
      schemaRegistry.ErrorResponse.schema.parse(await failed.json()).code,
    ).toBe("MODULE_NOT_FOUND");

    // 只有一个成功，级联只发生一次。
    expect((await auditRows(project.projectId, "module.delete")).length).toBe(
      1,
    );
    const [taskRow] = await client.sql<
      { deletedAt: Date | null }[]
    >`SELECT deleted_at AS "deletedAt" FROM app.tasks WHERE id = ${task.id}`;
    expect(taskRow?.deletedAt).not.toBeNull();
  });

  it("已软删除的模块再次删除返回 404，项目被物理删除后同样 404", async () => {
    const project = await fixture(),
      module = await createNormalModule(
        project,
        project.userId,
        "重复删除模块",
      ),
      feature = await createFeature(
        project,
        module.id,
        project.userId,
        "重复删除功能",
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
    await deleteFeature(project.actor, project, module.id, feature.id, 1);
    // ADR-062：项目删除是物理删除，模块随项目一起消失；此后模块删除按
    // 「非成员」处理，仍是 404 而不泄露模块是否曾经存在。
    await client.sql`SELECT * FROM app.purge_project(${project.projectId})`;
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

  it("级联遇到聚合组主任务时 409 并整体回滚，不留半删状态", async () => {
    const project = await fixture(),
      module = await createNormalModule(project, project.userId, "聚合组模块"),
      source = await createTask(
        project,
        { moduleId: module.id, featureId: null },
        project.userId,
        "来源任务",
      ),
      main = await createTask(
        project,
        { moduleId: module.id, featureId: null },
        project.userId,
        "主任务",
      ),
      groupId = await createGroup(project, project.userId, main.id, [
        source.id,
      ]);

    expect(
      (
        await failure(
          await deleteModule(
            project.actor,
            project,
            module.id,
            module.rowVersion,
          ),
          409,
        )
      ).code,
    ).toBe("TASK_GROUP_MAIN_LOCKED");

    const [moduleRow] = await deletedState("modules", module.id);
    expect(moduleRow).toMatchObject({
      deletedAt: null,
      rowVersion: module.rowVersion,
    });
    const [tasks] = await client.sql<{ alive: string }[]>`
      SELECT count(*) FILTER (WHERE deleted_at IS NULL)::text AS alive FROM app.tasks WHERE module_id = ${module.id}`;
    expect(tasks).toMatchObject({ alive: "2" });
    expect(
      (
        await client.sql<
          { status: string; role: string }[]
        >`SELECT status, role FROM app.task_group_members WHERE group_id = ${groupId} ORDER BY role`
      ).map((row) => [row.role, row.status]),
    ).toEqual([
      ["MAIN", "ACTIVE"],
      ["SOURCE", "ACTIVE"],
    ]);
    expect((await auditRows(project.projectId, "module.delete")).length).toBe(
      0,
    );
  });

  it("已删除的功能不再参与模块级联计数", async () => {
    const project = await fixture(),
      module = await createNormalModule(
        project,
        project.userId,
        "二次级联模块",
      ),
      removed = await createFeature(
        project,
        module.id,
        project.userId,
        "先删功能",
      ),
      kept = await createFeature(
        project,
        module.id,
        project.userId,
        "后删功能",
      ),
      // 先删功能下的任务：它的删除由功能级联完成，后续只按行数断言。
      _removedTask = await createTask(
        project,
        { moduleId: module.id, featureId: removed.id },
        project.userId,
        "先删任务",
      ),
      keptTask = await createTask(
        project,
        { moduleId: module.id, featureId: kept.id },
        project.userId,
        "后删任务",
      );

    expect(
      (
        await deleteFeature(
          project.actor,
          project,
          module.id,
          removed.id,
          removed.rowVersion,
        )
      ).status,
    ).toBe(200);

    const response = await deleteModule(
      project.actor,
      project,
      module.id,
      module.rowVersion,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      schemaRegistry.ModuleDeletionResponse.schema.parse(await response.json()),
    ).toMatchObject({
      deletedFeatureCount: 1,
      deletedTaskCount: 1,
      voidedRecordCount: 0,
    });

    const [counts] = await client.sql<{ deleted: string; alive: string }[]>`
      SELECT count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted, count(*) FILTER (WHERE deleted_at IS NULL)::text AS alive FROM app.tasks WHERE module_id = ${module.id}`;
    expect(counts).toMatchObject({ deleted: "2", alive: "0" });
    expect(
      (await deletedState("features", removed.id))[0]?.deletedAt,
    ).not.toBeNull();
    expect(
      (await deletedState("features", kept.id))[0]?.deletedAt,
    ).not.toBeNull();
    // 两次命令各自留痕：先删功能一条、模块级联再一条（模块级联只含 kept），
    // 用 cascadeFromModuleId 区分两条来源，不能只看总数。
    const featureDeletions = await auditRows(
      project.projectId,
      "feature.delete",
    );
    expect(featureDeletions.length).toBe(2);
    expect(
      featureDeletions
        .map((row) => ({
          featureId: row.payload.featureId,
          cascadeFromModuleId: row.payload.cascadeFromModuleId ?? null,
        }))
        .sort(
          (left, right) => Number(left.featureId) - Number(right.featureId),
        ),
    ).toEqual([
      { featureId: removed.id, cascadeFromModuleId: null },
      { featureId: kept.id, cascadeFromModuleId: module.id },
    ]);
    expect((await auditRows(project.projectId, "task.delete")).length).toBe(2);
    expect(
      await count(
        client.sql<
          { count: string }[]
        >`SELECT count(*)::text AS count FROM app.task_external_links WHERE task_id = ${keptTask.id}`,
      ),
    ).toBe(0);
  });
});

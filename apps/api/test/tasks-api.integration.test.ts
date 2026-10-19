import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { ProjectStartNotifier } from "../src/modules/projects/project-start.notifier.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import {
  taskItemSchema,
  moduleTaskItemSchema,
  taskListResponseSchema,
  taskAssigneesResponseSchema,
  schemaRegistry,
} from "@inpulse/api-contract";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { LeftoverSearchProjectionSync } from "../src/modules/change-records/leftover-search-projection.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { TasksHttpService } from "../src/modules/tasks/tasks-http.service.js";
import { TasksController } from "../src/modules/tasks/tasks.controller.js";
import { TaskStatusCompatibilityController } from "../src/workflows/task-status-compatibility.controller.js";
import { TaskStatusCompatibilityHttpService } from "../src/workflows/task-status-compatibility-http.service.js";
import { TaskCompletionWorkflow } from "../src/workflows/task-completion.workflow.js";
import { ExistingTaskStatusCommandPort } from "../src/modules/tasks/task-status.port.js";
import { PostgresTaskCompletionCommandPort } from "../src/modules/tasks/task-completion.port.js";
import { PostgresTaskQueryPort } from "../src/modules/tasks/task-query.port.js";
import { PostgresTaskBranchQueryPort } from "../src/modules/task-groups/task-branch-query.port.js";
import { TaskGroupRepository } from "../src/modules/task-groups/task-group.repository.js";
import { RecordDraftsService } from "../src/modules/change-records/record-drafts.service.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { RecordPublicationService } from "../src/modules/change-records/record-publication.service.js";
import { RecordPublicationRepository } from "../src/modules/change-records/record-publication.repository.js";
import { RecordPublicationAccess } from "../src/modules/change-records/record-publication-access.js";
import { RecordPublicationEffects } from "../src/modules/change-records/record-publication-effects.js";
import { PublishedRecordRepository } from "../src/modules/change-records/published-record.repository.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let app: INestApplication | undefined;
let base: string;
let uow: PostgresUnitOfWork;
let management: TasksManagementService;
let audit: PostgresAuditWritePort;
let search: PostgresSearchProjectionWritePort;
let activity: PostgresActivityWritePort;
let notifications: PostgresNotificationWritePort;
const key = randomBytes(32);
const ring = VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1);
const tokens = new SessionTokenService(ring);
interface Actor {
  userId: number;
  sessionId: number;
  cookie: string;
  csrf: string;
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f14-http",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f14-audit-evidence",
  });
  uow = new PostgresUnitOfWork(client);
  const sessions = new PostgresUserSessionRepository();
  const csrf = new PostgresSessionCsrfTokenRepository();
  const auth = new SessionAuthService(uow, sessions, tokens);
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  search = new PostgresSearchProjectionWritePort();
  activity = new PostgresActivityWritePort();
  notifications = new PostgresNotificationWritePort();
  management = new TasksManagementService(
    new PostgresProjectAccessQueryPort(client),
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
    notifications,
    new PostgresModuleReadPort(),
    new PostgresProjectsWritePort(),
    new PostgresUserReadPort(),
  );
  const mutation = new AuthenticatedMutationService(auth, csrf, tokens);
  const idempotency = new IdempotencyHttpService(
    new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
    { currentVersion: 1, currentKey: () => key, keyFor: () => key },
    resolveRegisteredRoute,
  );
  const http = new TasksHttpService(auth, mutation, idempotency, management);
  const access = new PostgresProjectAccessQueryPort(client),
    modules = new PostgresModuleQueryPort(),
    features = new PostgresFeatureQueryPort(),
    featureRead = new PostgresFeatureReadPort(),
    taskQuery = new PostgresTaskQueryPort(),
    records = new RecordDraftRepository(),
    pubRepo = new RecordPublicationRepository();
  const drafts = new RecordDraftsService(
    access,
    modules,
    new PostgresModuleReadPort(),
    features,
    featureRead,
    records,
    uow,
    audit,
    new TimeCursorService(ring, "RECORD_DRAFTS"),
    new PostgresUserReadPort(),
  );
  const publication = new RecordPublicationService(
    new RecordPublicationAccess(access, modules, features, taskQuery, pubRepo),
    pubRepo,
    records,
    new PublishedRecordRepository(),
    new PostgresProjectCodePort(),
    featureRead,
    new RecordPublicationEffects(
      audit,
      activity,
      search,
      new LeftoverSearchProjectionSync(search),
      notifications,
      access,
    ),
  );
  const completion = new TaskCompletionWorkflow(
    access,
    modules,
    features,
    taskQuery,
    new PostgresTaskBranchQueryPort(new TaskGroupRepository()),
    drafts,
    drafts,
    publication,
    new PostgresTaskCompletionCommandPort(
      new TaskManagementRepository(),
      audit,
      activity,
      search,
      notifications,
      access,
      new PostgresProjectsWritePort(),
      new ProjectStartNotifier(
        new PostgresProjectMembersQueryPort(),
        notifications,
      ),
    ),
  );
  class TestModule {}
  Module({
    controllers: [TasksController, TaskStatusCompatibilityController],
    providers: [
      { provide: TasksHttpService, useValue: http },
      {
        provide: TaskStatusCompatibilityHttpService,
        useValue: new TaskStatusCompatibilityHttpService(
          mutation,
          idempotency,
          completion,
          new ExistingTaskStatusCommandPort(management),
        ),
      },
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

async function actor(admin = false): Promise<Actor> {
  const userId = await createUser(client.sql, { admin });
  const cookie = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const [session] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions (user_id, token_hash, token_hash_key_version, auth_version_at_issue, auth_state, idle_expires_at, absolute_expires_at) VALUES (${userId}, ${tokens.hash(cookie).hash}, 1, 1, 'AUTHENTICATED', now() + interval '1 hour', now() + interval '1 day') RETURNING id`;
  await client.sql`INSERT INTO app.session_csrf_tokens (session_id, token_hash, expires_at) VALUES (${session!.id}, ${tokens.hash(csrf).hash}, now() + interval '1 hour')`;
  return {
    userId,
    sessionId: session!.id,
    cookie: `__Host-session=${cookie}`,
    csrf,
  };
}
type ScopeFixture = ProjectFixture & { featureId: number };
async function fixture(): Promise<{ member: Actor; project: ScopeFixture }> {
  const member = await actor();
  const project = await createProject(client.sql, member.userId);
  const [f] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.features (project_id,module_id,code,name,created_by) VALUES (${project.projectId},${project.moduleId},${project.code + "-F-1"},'支付',${member.userId}) RETURNING id`;
  return { member, project: { ...project, featureId: f!.id } };
}
async function request(
  project: { projectId: number; moduleId: number; featureId: number | null },
  method: string,
  who?: Actor,
  body?: unknown,
  suffix = "",
  version?: number,
  idempotencyKey: string = randomUUID(),
) {
  return fetch(
    `${base}/api/v1/projects/${project.projectId}/modules/${project.moduleId}${project.featureId === null ? "" : `/features/${project.featureId}`}/tasks${suffix}`,
    {
      method,
      headers: {
        origin: base,
        "sec-fetch-site": "same-origin",
        ...(who
          ? { cookie: who.cookie, "x-csrf-token": who.csrf }
          : { "x-csrf-token": "a".repeat(43) }),
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
        ...(version ? { "If-Match": `"${version}"` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
async function error(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  const body = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
  if (code) expect(body.code).toBe(code);
  expect(JSON.stringify(body)).not.toMatch(
    /INSERT INTO|SELECT |stack|constraint_name/,
  );
}

const edit = (assigneeId: number, title = "修复退款") => ({
  title,
  description: "支付退款说明",
  priority: "NORMAL",
  assigneeIds: [assigneeId],
  dueAt: null,
});
async function create(project: ScopeFixture, member: Actor) {
  const response = await request(project, "POST", member, edit(member.userId));
  expect(response.status, await response.clone().text()).toBe(200);
  return taskItemSchema.parse(await response.json());
}
async function addMember(projectId: number, userId: number) {
  await client.sql`INSERT INTO app.project_members (project_id,user_id) VALUES (${projectId},${userId})`;
}
describe("F-16 status history", () => {
  const complete = {
    action: "COMPLETE",
    mode: "WITHOUT_RECORD",
    completionReason: "测试验证",
    note: "回归通过",
  };
  it("keeps history time monotonic when a reopening transaction starts before completion", async () => {
    const { project, member } = await fixture();
    const task = await create(project, member);
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const reopening = uow.run(async (tx) => {
      await tx.sql`SELECT now()`;
      acquired();
      await gate;
      return management.transition(tx, {
        ...project,
        taskId: task.id,
        actorId: member.userId,
        version: 2,
        command: { action: "REOPEN", reason: "事务重叠" },
        requestId: randomUUID(),
      });
    });
    await ready;
    try {
      expect(
        (
          await request(
            project,
            "POST",
            member,
            complete,
            `/${task.id}/status`,
            1,
          )
        ).status,
      ).toBe(200);
    } finally {
      release();
    }
    expect(await reopening).toMatchObject({
      workStatus: "TODO",
      rowVersion: 3,
    });
    const history = schemaRegistry.TaskStatusHistoryResponse.schema.parse(
      await (
        await request(
          project,
          "GET",
          member,
          undefined,
          `/${task.id}/status-history`,
        )
      ).json(),
    );
    expect(
      new Date(history.items[2]!.changedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(history.items[1]!.changedAt).getTime());
    expect(history.items[2]!.completedAtSnapshot).toBe(
      history.items[1]!.completedAtSnapshot,
    );
  });
  it("notifies the creator on completion and deduplicates creator/assignee on reopening", async () => {
    const { project, member } = await fixture();
    const assignee = await actor();
    await addMember(project.projectId, assignee.userId);
    const task = taskItemSchema.parse(
      await (
        await request(project, "POST", member, edit(assignee.userId))
      ).json(),
    );
    await request(project, "POST", member, complete, `/${task.id}/status`, 1);
    await request(
      project,
      "POST",
      member,
      { action: "REOPEN", reason: null },
      `/${task.id}/status`,
      2,
    );
    expect(
      await client.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${project.projectId} AND notification_type='task.complete'`,
    ).toEqual([{ recipient_id: member.userId }]);
    expect(
      await client.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${project.projectId} AND notification_type='task.reopen' ORDER BY recipient_id`,
    ).toEqual(
      [member.userId, assignee.userId]
        .sort((a, b) => a - b)
        .map((recipient_id) => ({ recipient_id })),
    );
    await removeMember(client.sql, project.projectId, assignee.userId);
    expect(
      (
        await request(
          project,
          "POST",
          member,
          complete,
          `/${task.id}/status`,
          3,
        )
      ).status,
    ).toBe(200);
    expect(
      taskItemSchema.parse(
        await (
          await request(project, "GET", member, undefined, `/${task.id}`)
        ).json(),
      ).assigneeId,
    ).toBe(assignee.userId);
  });
  for (const failure of [
    "audit",
    "activity",
    "search",
    "notification",
  ] as const)
    it(`rolls back status, snapshots and all side effects on ${failure} failure`, async () => {
      const { project, member } = await fixture();
      const task = await create(project, member);
      const snapshot = async () => ({
        task: await client.sql`SELECT * FROM app.tasks WHERE id=${task.id}`,
        history:
          await client.sql`SELECT * FROM app.task_status_history WHERE task_id=${task.id}`,
        audit:
          await auditReader.sql`SELECT * FROM app.audit_logs WHERE project_id=${project.projectId} ORDER BY sequence_no`,
        activity:
          await client.sql`SELECT * FROM app.activity_projection WHERE project_id=${project.projectId}`,
        search:
          await client.sql`SELECT * FROM app.search_projection WHERE project_id=${project.projectId}`,
        notifications:
          await client.sql`SELECT * FROM app.notifications WHERE project_id=${project.projectId}`,
        idempotency:
          await client.sql`SELECT * FROM app.idempotency_records WHERE actor_id=${member.userId}`,
      });
      const before = await snapshot();
      const spy =
        failure === "audit"
          ? vi.spyOn(audit, "append")
          : failure === "activity"
            ? vi.spyOn(activity, "append")
            : failure === "search"
              ? vi.spyOn(search, "upsert")
              : vi.spyOn(notifications, "write");
      spy.mockRejectedValueOnce(new Error("injected status failure"));
      const key = randomUUID();
      await error(
        await request(
          project,
          "POST",
          member,
          complete,
          `/${task.id}/status`,
          1,
          key,
        ),
        500,
      );
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await request(
            project,
            "POST",
            member,
            complete,
            `/${task.id}/status`,
            1,
            key,
          )
        ).status,
      ).toBe(200);
    });
  it("replays only after live authorization, rejects changed semantics and keeps history singular", async () => {
    const { project, member } = await fixture();
    const task = await create(project, member);
    const key = randomUUID();
    const first = await request(
      project,
      "POST",
      member,
      complete,
      `/${task.id}/status`,
      1,
      key,
    );
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(
      await (
        await request(
          project,
          "POST",
          member,
          complete,
          `/${task.id}/status`,
          1,
          key,
        )
      ).json(),
    ).toEqual(saved);
    expect(
      await client.sql`SELECT 1 FROM app.task_status_history WHERE task_id=${task.id}`,
    ).toHaveLength(2);
    await error(
      await request(
        project,
        "POST",
        member,
        { ...complete, note: "different" },
        `/${task.id}/status`,
        1,
        key,
      ),
      409,
    );
    await error(
      await request(
        project,
        "POST",
        member,
        complete,
        `/${task.id}/status`,
        2,
        key,
      ),
      409,
    );
    await removeMember(client.sql, project.projectId, member.userId);
    await error(
      await request(
        project,
        "POST",
        member,
        complete,
        `/${task.id}/status`,
        1,
        key,
      ),
      404,
    );
    await error(
      await request(
        project,
        "GET",
        member,
        undefined,
        `/${task.id}/status-history`,
      ),
      404,
    );
  });
  it("protects status and history with session, CSRF, ownership and If-Match", async () => {
    const { project, member } = await fixture();
    const task = await create(project, member);
    const outsider = await actor();
    await error(
      await request(
        project,
        "GET",
        undefined,
        undefined,
        `/${task.id}/status-history`,
      ),
      401,
    );
    await error(
      await request(
        project,
        "POST",
        outsider,
        complete,
        `/${task.id}/status`,
        1,
      ),
      404,
    );
    await error(
      await request(
        { ...project, featureId: null },
        "POST",
        member,
        complete,
        `/${task.id}/status`,
        1,
      ),
      404,
    );
    await error(
      await request(
        project,
        "POST",
        { ...member, csrf: "a".repeat(43) },
        complete,
        `/${task.id}/status`,
        1,
      ),
      401,
    );
    await error(
      await request(project, "POST", member, complete, `/${task.id}/status`),
      422,
    );
    expect(
      (
        await request(
          project,
          "GET",
          member,
          undefined,
          `/${task.id}/status-history`,
        )
      ).status,
    ).toBe(200);
  });
  for (const moduleScope of [false, true])
    it(`serializes concurrent complete/cancel, keeping the winning status searchable (${moduleScope})`, async () => {
      const { project, member } = await fixture();
      const scope = {
        ...project,
        featureId: moduleScope ? null : project.featureId,
      };
      const original = (
        moduleScope ? moduleTaskItemSchema : taskItemSchema
      ).parse(
        await (
          await request(scope, "POST", member, {
            ...edit(member.userId),
            ...(moduleScope ? { impactFeatureIds: [project.featureId] } : {}),
          })
        ).json(),
      );
      const results = await Promise.all(
        [complete, { action: "CANCEL", reason: "重复" }].map((body) =>
          request(scope, "POST", member, body, `/${original.id}/status`, 1),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = (
        moduleScope ? moduleTaskItemSchema : taskItemSchema
      ).parse(await results.find((r) => r.status === 200)!.json());
      expect(
        await client.sql`SELECT 1 FROM app.task_status_history WHERE task_id=${original.id}`,
      ).toHaveLength(2);
      expect(
        await client.sql`SELECT source_status FROM app.search_projection WHERE entity_type='TASK' AND entity_id=${original.id} AND normalized_search_text &@~ app.pgroonga_query_escape(${original.code})`,
      ).toMatchObject([{ source_status: winner.workStatus }]);
      if (winner.scopeType === "MODULE")
        expect(winner.impactFeatureIds).toEqual([project.featureId]);
    });
  for (const moduleScope of [false, true]) {
    it(`retains repeated completion snapshots, cancellation and restoration (${moduleScope ? "MODULE" : "FEATURE"})`, async () => {
      const { project, member } = await fixture();
      const scope = {
        ...project,
        featureId: moduleScope ? null : project.featureId,
      };
      const created = await request(scope, "POST", member, {
        ...edit(member.userId),
        ...(moduleScope ? { impactFeatureIds: [project.featureId] } : {}),
      });
      const original = (
        moduleScope ? moduleTaskItemSchema : taskItemSchema
      ).parse(await created.json());
      let current = original;
      for (const body of [
        complete,
        { action: "REOPEN", reason: "补充验证" },
        { ...complete, completionReason: "技术调研", note: "再次完成" },
        { action: "REOPEN", reason: "新增验证" },
        { action: "CANCEL", reason: "已无必要" },
        { action: "RESTORE", reason: "需求恢复" },
      ]) {
        const response = await request(
          scope,
          "POST",
          member,
          body,
          `/${current.id}/status`,
          current.rowVersion,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        current = (moduleScope ? moduleTaskItemSchema : taskItemSchema).parse(
          await response.json(),
        );
      }
      expect(current).toMatchObject({
        ...original,
        rowVersion: 7,
        updatedAt: expect.any(String),
      });
      const response = await request(
        scope,
        "GET",
        member,
        undefined,
        `/${current.id}/status-history`,
      );
      expect(response.status).toBe(200);
      const history = schemaRegistry.TaskStatusHistoryResponse.schema.parse(
        await response.json(),
      );
      expect(
        history.items.map((h: { toWorkStatus: string }) => h.toWorkStatus),
      ).toEqual(["TODO", "DONE", "TODO", "DONE", "TODO", "CANCELED", "TODO"]);
      expect(history.items[2]).toMatchObject({
        completedAtSnapshot: history.items[1]!.completedAtSnapshot,
        completionNoteSnapshot: history.items[1]!.completionNoteSnapshot,
        changedBy: member.userId,
        reason: "补充验证",
      });
      expect(history.items[4]).toMatchObject({
        completedAtSnapshot: history.items[3]!.completedAtSnapshot,
        completionNoteSnapshot: "技术调研，不涉及功能变化：再次完成",
      });
      expect(
        new Date(history.items[3]!.completedAtSnapshot!).getTime(),
      ).toBeGreaterThan(
        new Date(history.items[1]!.completedAtSnapshot!).getTime(),
      );
      expect(history.items[5]).toMatchObject({
        reason: "已无必要",
        completedAtSnapshot: null,
      });
      expect(history.items[6]).toMatchObject({
        reason: "需求恢复",
        completedAtSnapshot: null,
      });
      await expect(
        client.sql`UPDATE app.task_status_history SET reason='tamper' WHERE task_id=${current.id}`,
      ).rejects.toThrow();
      await expect(
        client.sql`DELETE FROM app.task_status_history WHERE task_id=${current.id}`,
      ).rejects.toThrow();
    });
  }
  it("rejects actual-change completion, injected fields and illegal transitions", async () => {
    const { project, member } = await fixture();
    const task = await create(project, member);
    for (const body of [
      { ...complete, mode: "WITH_RECORD" },
      { ...complete, completedAt: new Date().toISOString() },
      { ...complete, completionReason: "开发功能" },
    ])
      await error(
        await request(project, "POST", member, body, `/${task.id}/status`, 1),
        422,
      );
    for (const action of ["REOPEN", "RESTORE"])
      await error(
        await request(
          project,
          "POST",
          member,
          { action, reason: null },
          `/${task.id}/status`,
          1,
        ),
        409,
        "TASK_STATE_CONFLICT",
      );
    expect(
      (
        await request(
          project,
          "POST",
          member,
          complete,
          `/${task.id}/status`,
          1,
        )
      ).status,
    ).toBe(200);
    for (const body of [
      complete,
      { action: "CANCEL", reason: null },
      { action: "RESTORE", reason: null },
    ])
      await error(
        await request(project, "POST", member, body, `/${task.id}/status`, 2),
        409,
        "TASK_STATE_CONFLICT",
      );
  });
});

describe("F-15 module tasks", () => {
  it("rechecks module task permissions and all saved impact resources before replay", async () => {
    const { project, member } = await fixture();
    const other = await fixture();
    const scope = { ...project, featureId: null };
    const key = randomUUID();
    const input = {
      ...edit(member.userId),
      impactFeatureIds: [project.featureId],
    };
    const first = await request(
      scope,
      "POST",
      member,
      input,
      "",
      undefined,
      key,
    );
    expect(first.status).toBe(200);
    const item = moduleTaskItemSchema.parse(await first.json());
    await error(await request(scope, "GET"), 401);
    await error(await request(scope, "GET", other.member), 404);
    await error(
      await request(scope, "PATCH", other.member, input, `/${item.id}`, 1),
      404,
    );
    await removeMember(client.sql, project.projectId, member.userId);
    await error(
      await request(scope, "POST", member, input, "", undefined, key),
      404,
    );
  });
  const moduleScope = (project: ScopeFixture) => ({
    ...project,
    featureId: null,
  });
  async function anotherFeature(project: ScopeFixture, member: Actor) {
    const [row] = await client.sql<
      { id: number }[]
    >`INSERT INTO app.features (project_id,module_id,code,name,created_by) VALUES (${project.projectId},${project.moduleId},${project.code + "-F-" + Math.floor(Math.random() * 100000 + 2)},'影响功能',${member.userId}) RETURNING id`;
    return row!.id;
  }
  async function createModule(
    project: ScopeFixture,
    member: Actor,
    ids: number[] = [],
  ) {
    const response = await request(moduleScope(project), "POST", member, {
      ...edit(member.userId),
      impactFeatureIds: ids,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return moduleTaskItemSchema.parse(await response.json());
  }
  it("stores one task with deduplicated same-module impacts and references once per feature", async () => {
    const { project, member } = await fixture();
    const second = await anotherFeature(project, member);
    const item = await createModule(project, member, [
      second,
      project.featureId,
      second,
    ]);
    expect(item).toMatchObject({
      scopeType: "MODULE",
      featureId: null,
      impactFeatureIds: [project.featureId, second],
    });
    expect(
      await client.sql`SELECT 1 FROM app.tasks WHERE project_id=${project.projectId}`,
    ).toHaveLength(1);
    for (const featureId of [project.featureId, second])
      expect(
        taskListResponseSchema.parse(
          await (
            await request({ ...project, featureId }, "GET", member)
          ).json(),
        ).items,
      ).toEqual([item]);
    expect(
      moduleTaskItemSchema.parse(
        await (
          await request(
            moduleScope(project),
            "GET",
            member,
            undefined,
            `/${item.id}`,
          )
        ).json(),
      ),
    ).toEqual(item);
    expect(
      await client.sql`SELECT 1 FROM app.task_feature_impacts WHERE task_id=${item.id}`,
    ).toHaveLength(2);
    await expect(
      client.sql`INSERT INTO app.task_feature_impacts(task_id,feature_id,module_id,project_id) VALUES (${item.id},${second},${project.moduleId},${project.projectId})`,
    ).rejects.toMatchObject({ code: "23505" });
    const foreign = await fixture();
    await expect(
      client.sql`INSERT INTO app.task_feature_impacts(task_id,feature_id,module_id,project_id) VALUES (${item.id},${foreign.project.featureId},${project.moduleId},${project.projectId})`,
    ).rejects.toMatchObject({ code: "23503" });
    const featureTask = await create(project, member);
    await expect(
      client.sql`INSERT INTO app.task_feature_impacts(task_id,feature_id,module_id,project_id) VALUES (${featureTask.id},${second},${project.moduleId},${project.projectId})`,
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("accepts empty impacts, preserves one project number sequence and normalizes same-key reordered duplicates", async () => {
    const { project, member } = await fixture();
    const featureTask = await create(project, member);
    const module = await createModule(project, member);
    expect(featureTask.code).toBe(project.code + "-T-1");
    expect(module.code).toBe(project.code + "-T-2");
    const key = randomUUID();
    const input = {
      ...edit(member.userId),
      impactFeatureIds: [project.featureId, project.featureId],
    };
    const a = await request(
      moduleScope(project),
      "POST",
      member,
      input,
      "",
      undefined,
      key,
    );
    const body = await a.json();
    expect(
      await (
        await request(
          moduleScope(project),
          "POST",
          member,
          { ...input, impactFeatureIds: [project.featureId] },
          "",
          undefined,
          key,
        )
      ).json(),
    ).toEqual(body);
  });
  it("rejects foreign project/module impacts and scope injection, with no partial insert", async () => {
    const { project, member } = await fixture();
    const foreign = await fixture();
    await error(
      await request(moduleScope(project), "POST", member, {
        ...edit(member.userId),
        impactFeatureIds: [foreign.project.featureId],
      }),
      404,
    );
    const [module] = await client.sql<
      { id: number }[]
    >`INSERT INTO app.modules(project_id,name,created_by) VALUES (${project.projectId},'另一模块',${member.userId}) RETURNING id`;
    const wrong = await anotherFeature(
      { ...project, moduleId: module!.id },
      member,
    );
    await error(
      await request(moduleScope(project), "POST", member, {
        ...edit(member.userId),
        impactFeatureIds: [project.featureId, wrong],
      }),
      404,
    );
    await error(
      await request(moduleScope(project), "POST", member, {
        ...edit(member.userId),
        featureId: project.featureId,
        impactFeatureIds: [],
      }),
      422,
    );
    expect(
      await client.sql`SELECT 1 FROM app.tasks WHERE project_id=${project.projectId}`,
    ).toHaveLength(0);
  });
  it("removes and readds current relations with complete immutable audit snapshots", async () => {
    const { project, member } = await fixture();
    const item = await createModule(project, member, [project.featureId]);
    const [old] = await client.sql<
      { created_at: Date }[]
    >`SELECT created_at FROM app.task_feature_impacts WHERE task_id=${item.id}`;
    const patch = (ids: number[], version: number) =>
      request(
        moduleScope(project),
        "PATCH",
        member,
        { ...edit(member.userId), impactFeatureIds: ids },
        `/${item.id}`,
        version,
      );
    expect((await patch([], 1)).status).toBe(200);
    expect(
      taskListResponseSchema.parse(
        await (await request(project, "GET", member)).json(),
      ).items,
    ).toEqual([]);
    expect((await patch([project.featureId], 2)).status).toBe(200);
    const [fresh] = await client.sql<
      { created_at: Date }[]
    >`SELECT created_at FROM app.task_feature_impacts WHERE task_id=${item.id}`;
    expect(new Date(fresh!.created_at).getTime()).toBeGreaterThan(
      new Date(old!.created_at).getTime(),
    );
    const logs = await auditReader.sql<
      {
        event_payload: {
          impactsBefore: unknown[];
          impactsAfter: unknown[];
          removed: number[];
        };
      }[]
    >`SELECT event_payload FROM app.audit_logs WHERE project_id=${project.projectId} AND action='task.update' ORDER BY sequence_no`;
    expect(logs[0]!.event_payload.impactsBefore).toEqual([
      expect.objectContaining({
        taskId: item.id,
        projectId: project.projectId,
        moduleId: project.moduleId,
        featureId: project.featureId,
        relationType: "IMPACT",
        createdAt: new Date(old!.created_at).toISOString(),
      }),
    ]);
    expect(logs[0]!.event_payload.impactsAfter).toEqual([]);
    expect(logs[0]!.event_payload.removed).toEqual([project.featureId]);
  });
  it("keeps, removes and re-adds existing impacts now that features cannot be archived (ADR-045)", async () => {
    const { project, member } = await fixture();
    const item = await createModule(project, member, [project.featureId]);
    const patch = (ids: number[], version: number) =>
      request(
        moduleScope(project),
        "PATCH",
        member,
        { ...edit(member.userId, "编辑模块任务"), impactFeatureIds: ids },
        `/${item.id}`,
        version,
      );
    expect((await patch([project.featureId], 1)).status).toBe(200);
    expect((await patch([], 2)).status).toBe(200);
    // ADR-045：影响功能不再有归档态，移除后可以重新加回。
    expect((await patch([project.featureId], 3)).status).toBe(200);
  });
  it("rolls back relation removal on audit failure and rejects stale concurrent updates", async () => {
    const { project, member } = await fixture();
    const second = await anotherFeature(project, member);
    const item = await createModule(project, member, [project.featureId]);
    const patch = (ids: number[]) =>
      request(
        moduleScope(project),
        "PATCH",
        member,
        { ...edit(member.userId), impactFeatureIds: ids },
        `/${item.id}`,
        1,
      );
    vi.spyOn(audit, "append").mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    await error(await patch([]), 500);
    expect(
      moduleTaskItemSchema.parse(
        await (
          await request(
            moduleScope(project),
            "GET",
            member,
            undefined,
            `/${item.id}`,
          )
        ).json(),
      ),
    ).toEqual(item);
    const results = await Promise.all([patch([second]), patch([])]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const success = moduleTaskItemSchema.parse(
      await results.find((r) => r.status === 200)!.json(),
    );
    expect(
      moduleTaskItemSchema.parse(
        await (
          await request(
            moduleScope(project),
            "GET",
            member,
            undefined,
            `/${item.id}`,
          )
        ).json(),
      ),
    ).toEqual(success);
  });
  it("waits for the feature row lock before adding an influence then commits it", async () => {
    const { project, member } = await fixture();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      acquired = r;
    });
    // ADR-045：功能不再有归档态，持锁方只做一次改名；影响功能写入必须等它解锁。
    const archive = uow.run(async (tx) => {
      await tx.sql`UPDATE app.features SET name='持锁改名',row_version=row_version+1 WHERE id=${project.featureId}`;
      acquired();
      await gate;
    });
    await ready;
    const pending = request(moduleScope(project), "POST", member, {
      ...edit(member.userId),
      impactFeatureIds: [project.featureId],
    });
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name='inpulse-f14-http' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`
            ).length,
          ).toBeGreaterThan(0),
        { timeout: 4000, interval: 30 },
      );
    } finally {
      release();
      await archive;
    }
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      moduleTaskItemSchema.parse(await response.json()).impactFeatureIds,
    ).toEqual([project.featureId]);
  });
});

describe("F-14 real HTTP / PostgreSQL", () => {
  it("preserves a valid 500-character title while fitting notification limits", async () => {
    const { project, member } = await fixture();
    const title = "任".repeat(500);
    const response = await request(
      project,
      "POST",
      member,
      edit(member.userId, title),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(taskItemSchema.parse(await response.json()).title).toBe(title);
    const [notification] = await client.sql<
      { title: string }[]
    >`SELECT title FROM app.notifications WHERE project_id=${project.projectId}`;
    expect(notification!.title.length).toBe(500);
  });
  it("maps an imported number collision to a safe 409 and rolls back the sequence", async () => {
    const { project, member } = await fixture();
    await uow.run(async (tx) => {
      const [task] = await tx.sql<
        { id: number }[]
      >`INSERT INTO app.tasks (project_id,module_id,feature_id,scope_type,code,title,creator_id) VALUES (${project.projectId},${project.moduleId},${project.featureId},'FEATURE',${project.code + "-T-1"},'导入任务',${member.userId}) RETURNING id`;
      await tx.sql`INSERT INTO app.task_assignees (task_id,user_id,project_id) VALUES (${task!.id},${member.userId},${project.projectId})`;
      await tx.sql`INSERT INTO app.task_status_history (task_id,project_id,to_work_status,changed_by) VALUES (${task!.id},${project.projectId},'TODO',${member.userId})`;
    });
    await error(
      await request(project, "POST", member, edit(member.userId)),
      409,
      "TASK_CODE_CONFLICT",
    );
    expect(
      await client.sql`SELECT 1 FROM app.code_sequences WHERE project_id=${project.projectId} AND entity_type='TASK'`,
    ).toHaveLength(0);
  });
  it("orders the panel list by work status group then task priority", async () => {
    const { project, member } = await fixture();
    const post = async (title: string, priority: string) => {
      const response = await request(project, "POST", member, {
        ...edit(member.userId, title),
        priority,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return taskItemSchema.parse(await response.json());
    };
    // 登记顺序与期望顺序不同：排序键生效时结果不等于 id 升序。
    const done = await post("已完成任务", "URGENT");
    const highTodo = await post("高优任务", "HIGH");
    const urgentTodo = await post("紧急任务", "URGENT");
    const normalTodo = await post("普通任务", "NORMAL");
    const canceled = await post("已取消任务", "HIGH");
    // app.tasks 的状态历史不变量要求最后一条 task_status_history 与任务行一致，
    // 因此改状态时同事务补上对应迁移。
    await client.sql`
      WITH updated AS (
        UPDATE app.tasks
           SET work_status = 'DONE',
               completed_at = now(),
               completion_note = '已完成',
               row_version = row_version + 1
         WHERE id = ${done.id} AND project_id = ${project.projectId}
        RETURNING id, project_id, completed_at, completion_note
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status,
        completed_at_snapshot, completion_note_snapshot, changed_by
      )
      SELECT id, project_id, 'TODO', 'DONE', completed_at, completion_note,
             ${member.userId}
        FROM updated
    `;
    await client.sql`
      WITH updated AS (
        UPDATE app.tasks
           SET work_status = 'CANCELED',
               row_version = row_version + 1
         WHERE id = ${canceled.id} AND project_id = ${project.projectId}
        RETURNING id, project_id
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status, changed_by
      )
      SELECT id, project_id, 'TODO', 'CANCELED', ${member.userId}
        FROM updated
    `;

    const items = taskListResponseSchema.parse(
      await (await request(project, "GET", member)).json(),
    ).items;
    // 未完成（紧急 → 高 → 普通）在前，其后依次是已完成与已取消。
    expect(items.map((item) => item.id)).toEqual([
      urgentTodo.id,
      highTodo.id,
      normalTodo.id,
      done.id,
      canceled.id,
    ]);
  });

  it("keeps the task writable and replays the same key after an unrelated parent change (ADR-045)", async () => {
    const { project, member } = await fixture();
    const key = randomUUID();
    const body = edit(member.userId);
    const first = await request(
      project,
      "POST",
      member,
      body,
      "",
      undefined,
      key,
    );
    const item = taskItemSchema.parse(await first.json());
    // ADR-045：功能改名不产生只读态，任务仍可读、可编辑，同 Key 重放返回原响应。
    await client.sql`UPDATE app.features SET name='改名功能',row_version=row_version+1 WHERE id=${project.featureId}`;
    expect(
      (await request(project, "GET", member, undefined, `/${item.id}`)).status,
    ).toBe(200);
    const patched = await request(
      project,
      "PATCH",
      member,
      body,
      `/${item.id}`,
      1,
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    const replay = await request(
      project,
      "POST",
      member,
      body,
      "",
      undefined,
      key,
    );
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(taskItemSchema.parse(await replay.json())).toMatchObject({
      id: item.id,
    });
  });
  // ADR-043/ADR-044/ADR-045：项目、模块与功能都已无归档态，
  // 并发父级状态变更只覆盖成员停用与用户停用。
  for (const target of ["member", "user"] as const)
    it(`waits for concurrent ${target} removal then rechecks`, async () => {
      const { project, member } = await fixture();
      const assignee = await actor();
      await addMember(project.projectId, assignee.userId);
      let release!: () => void;
      let acquired!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const change = uow.run(async (tx) => {
        if (target === "member")
          await tx.sql`UPDATE app.project_members SET status='REMOVED', removed_at=now() WHERE project_id=${project.projectId} AND user_id=${assignee.userId}`;
        if (target === "user")
          await tx.sql`UPDATE app.users SET status='DISABLED', disabled_at=now(), row_version=row_version+1 WHERE id=${assignee.userId}`;
        acquired();
        await gate;
      });
      await ready;
      const pending = request(project, "POST", member, edit(assignee.userId));
      try {
        await vi.waitFor(
          async () => {
            expect(
              (
                await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name='inpulse-f14-http' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`
              ).length,
            ).toBeGreaterThan(0);
          },
          { timeout: 4000, interval: 30 },
        );
      } finally {
        release();
        await change;
      }
      await error(await pending, 422);
      expect(
        await client.sql`SELECT 1 FROM app.tasks WHERE project_id=${project.projectId}`,
      ).toHaveLength(0);
    });
  it("allows a global admin to create but requires their chosen assignee to be a project member", async () => {
    const { project, member } = await fixture();
    const admin = await actor(true);
    await error(await request(project, "POST", admin, edit(admin.userId)), 422);
    const result = await request(project, "POST", admin, edit(member.userId));
    expect(result.status).toBe(200);
  });
  it("rolls back a reassignment and version when notification fails", async () => {
    const { project, member } = await fixture();
    const next = await actor();
    await addMember(project.projectId, next.userId);
    const item = await create(project, member);
    vi.spyOn(notifications, "write").mockRejectedValueOnce(
      new Error("notification failure"),
    );
    await error(
      await request(
        project,
        "PATCH",
        member,
        edit(next.userId),
        `/${item.id}`,
        1,
      ),
      500,
    );
    expect(
      taskItemSchema.parse(
        await (
          await request(project, "GET", member, undefined, `/${item.id}`)
        ).json(),
      ),
    ).toEqual(item);
    expect(
      await client.sql`SELECT 1 FROM app.notifications WHERE project_id=${project.projectId}`,
    ).toHaveLength(1);
  });
  it("creates one TODO task/history and atomic projections/notification; reads list/detail/members", async () => {
    const { project, member } = await fixture();
    const item = await create(project, member);
    expect(item).toMatchObject({
      code: project.code + "-T-1",
      scopeType: "FEATURE",
      featureId: project.featureId,
      workStatus: "TODO",
      lifecycleStatus: "ACTIVE",
      rowVersion: 1,
    });
    const history =
      await client.sql`SELECT * FROM app.task_status_history WHERE task_id=${item.id}`;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_work_status: null,
      to_work_status: "TODO",
    });
    expect(
      taskListResponseSchema.parse(
        await (await request(project, "GET", member)).json(),
      ).items,
    ).toEqual([item]);
    expect(
      await (
        await request(project, "GET", member, undefined, `/${item.id}`)
      ).json(),
    ).toEqual(item);
    expect(
      taskAssigneesResponseSchema
        .parse(
          await (
            await request(project, "GET", member, undefined, "/assignees")
          ).json(),
        )
        .items.map((m: { id: number }) => m.id),
    ).toEqual([member.userId]);
    expect(
      await client.sql`SELECT 1 FROM app.notifications WHERE project_id=${project.projectId} AND recipient_id=${member.userId}`,
    ).toHaveLength(1);
    expect(
      await client.sql`SELECT 1 FROM app.search_projection WHERE project_id=${project.projectId} AND entity_type='TASK'`,
    ).toHaveLength(1);
  });
  it("rejects anonymous/foreign/removed/disabled actors and wrong project/module/feature identity", async () => {
    const { project, member } = await fixture();
    const other = await fixture();
    const item = await create(project, member);
    await error(await request(project, "GET"), 401);
    await error(await request(project, "GET", other.member), 404);
    await error(
      await request(
        { ...project, moduleId: other.project.moduleId },
        "GET",
        member,
      ),
      404,
    );
    await error(
      await request(
        { ...project, featureId: other.project.featureId },
        "GET",
        member,
        undefined,
        `/${item.id}`,
      ),
      404,
    );
    await error(
      await request(
        other.project,
        "GET",
        other.member,
        undefined,
        `/${item.id}`,
      ),
      404,
    );
    await removeMember(client.sql, project.projectId, member.userId);
    await error(await request(project, "GET", member), 404);
    await client.sql`UPDATE app.users SET status='DISABLED', disabled_at=now(), row_version=row_version+1 WHERE id=${other.member.userId}`;
    await error(await request(other.project, "GET", other.member), 401);
  });
  it("requires CSRF/key/version and rejects client identity injection", async () => {
    const { project, member } = await fixture();
    const item = await create(project, member);
    await error(
      await request(
        project,
        "POST",
        { ...member, csrf: "z".repeat(43) },
        edit(member.userId),
      ),
      401,
    );
    await error(
      await request(project, "POST", member, {
        ...edit(member.userId),
        code: "X-T-1",
      }),
      422,
    );
    await error(
      await request(project, "POST", member, {
        ...edit(member.userId),
        assigneeIds: [null],
      }),
      422,
    );
    await error(
      await request(
        project,
        "POST",
        member,
        edit(member.userId),
        "",
        undefined,
        "",
      ),
      400,
    );
    await error(
      await request(
        project,
        "PATCH",
        member,
        edit(member.userId),
        `/${item.id}`,
      ),
      422,
    );
  });
  it("only notifies newly assigned ACTIVE project members; retains removed historical assignee for unrelated edits", async () => {
    const { project, member } = await fixture();
    const next = await actor();
    const outsider = await actor();
    await addMember(project.projectId, next.userId);
    const item = await create(project, member);
    await error(
      await request(
        project,
        "PATCH",
        member,
        edit(outsider.userId),
        `/${item.id}`,
        1,
      ),
      422,
    );
    const changed = await request(
      project,
      "PATCH",
      member,
      edit(next.userId),
      `/${item.id}`,
      1,
    );
    expect(changed.status).toBe(200);
    await removeMember(client.sql, project.projectId, next.userId);
    expect(
      (
        await request(
          project,
          "PATCH",
          member,
          edit(next.userId, "历史负责人保留"),
          `/${item.id}`,
          2,
        )
      ).status,
    ).toBe(200);
    expect(
      await client.sql`SELECT 1 FROM app.notifications WHERE project_id=${project.projectId}`,
    ).toHaveLength(2);
    const members = taskAssigneesResponseSchema.parse(
      await (
        await request(project, "GET", member, undefined, "/assignees")
      ).json(),
    );
    expect(members.items.map((m: { id: number }) => m.id)).not.toContain(
      next.userId,
    );
    await error(await request(project, "POST", member, edit(next.userId)), 422);
  });
  it("replays exact success without extra side effects; checks changed semantics, If-Match, permissions", async () => {
    const { project, member } = await fixture();
    const key = randomUUID();
    const body = edit(member.userId);
    const first = await request(
      project,
      "POST",
      member,
      body,
      "",
      undefined,
      key,
    );
    expect(first.status).toBe(200);
    const item = taskItemSchema.parse(await first.json());
    expect(
      await (
        await request(project, "POST", member, body, "", undefined, key)
      ).json(),
    ).toEqual(item);
    await error(
      await request(
        project,
        "POST",
        member,
        { ...body, title: "different" },
        "",
        undefined,
        key,
      ),
      409,
    );
    const patchKey = randomUUID();
    expect(
      (
        await request(
          project,
          "PATCH",
          member,
          body,
          `/${item.id}`,
          1,
          patchKey,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          project,
          "PATCH",
          member,
          body,
          `/${item.id}`,
          1,
          patchKey,
        )
      ).status,
    ).toBe(200);
    await error(
      await request(project, "PATCH", member, body, `/${item.id}`, 2, patchKey),
      409,
    );
    await error(
      await request(project, "PATCH", member, body, `/${item.id}`, 1),
      409,
      "TASK_VERSION_CONFLICT",
    );
    await removeMember(client.sql, project.projectId, member.userId);
    await error(
      await request(project, "POST", member, body, "", undefined, key),
      404,
    );
  });
  it("allocates unique project task numbers under concurrent creation", async () => {
    const { project, member } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(project, "POST", member, edit(member.userId)),
      ),
    );
    for (const response of results)
      expect(response.status, await response.clone().text()).toBe(200);
    const items = await Promise.all(
      results.map(async (r) => taskItemSchema.parse(await r.json())),
    );
    expect(new Set(items.map((i) => i.code)).size).toBe(12);
  });
  for (const failure of [
    "audit",
    "activity",
    "search",
    "notification",
  ] as const)
    it(`rolls back business/history/sequence/idempotency and all projections on ${failure} failure`, async () => {
      const { project, member } = await fixture();
      const spy =
        failure === "audit"
          ? vi.spyOn(audit, "append")
          : failure === "activity"
            ? vi.spyOn(activity, "append")
            : failure === "search"
              ? vi.spyOn(search, "upsert")
              : vi.spyOn(notifications, "write");
      spy.mockRejectedValueOnce(new Error("injected storage failure"));
      await error(
        await request(project, "POST", member, edit(member.userId)),
        500,
      );
      expect(
        await client.sql`SELECT 1 FROM app.tasks WHERE project_id=${project.projectId}`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.code_sequences WHERE project_id=${project.projectId} AND entity_type='TASK'`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.notifications WHERE project_id=${project.projectId}`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.search_projection WHERE project_id=${project.projectId} AND entity_type='TASK'`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.idempotency_records WHERE actor_id=${member.userId}`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.task_status_history WHERE project_id=${project.projectId}`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.activity_projection WHERE project_id=${project.projectId}`,
      ).toHaveLength(0);
      expect(
        await auditReader.sql`SELECT 1 FROM app.audit_logs WHERE project_id=${project.projectId}`,
      ).toHaveLength(0);
    });
});

describe("ADR-054 task archive removal", () => {
  it("serves no archive or restore route for module or feature tasks", async () => {
    const { project, member } = await fixture();
    const scope = { ...project, featureId: null };
    const moduleTask = moduleTaskItemSchema.parse(
      await (
        await request(scope, "POST", member, {
          ...edit(member.userId),
          impactFeatureIds: [project.featureId],
        })
      ).json(),
    );
    const featureTask = await create(project, member);

    // ADR-054：任务归档已下线，归档/恢复路由从 Route Registry、Controller 与生成客户端一并移除。
    for (const [label, target] of [
      ["模块任务归档", [scope, moduleTask.id] as const],
      ["功能任务归档", [project, featureTask.id] as const],
    ] as const) {
      for (const action of ["archive", "restore"] as const) {
        const response = await request(
          target[0],
          "POST",
          member,
          { reason: "已下线" },
          `/${target[1]}/${action}`,
          1,
        );
        expect(response.status, `${label} ${action}`).toBe(404);
      }
    }
  });
});

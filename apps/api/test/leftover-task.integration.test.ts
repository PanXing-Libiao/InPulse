import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import { LeftoverTaskWorkflow } from "../src/workflows/leftover-task.workflow.js";
import { LeftoverTaskHttpService } from "../src/workflows/leftover-task-http.service.js";
import { LeftoverTaskController } from "../src/workflows/leftover-task.controller.js";
import { PostgresLeftoverRecordCommandPort } from "../src/modules/change-records/leftover-record.port.js";
import { LeftoverRecordRepository } from "../src/modules/change-records/leftover-record.repository.js";
import { PostgresFollowupTaskCommandPort } from "../src/modules/tasks/followup-task.port.js";
import {
  leftoverTaskResponseSchema,
  type LeftoverTaskRequest,
} from "@inpulse/api-contract";
let leftover: LeftoverTaskWorkflow;
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { TaskCompletionController } from "../src/workflows/task-completion.controller.js";
import { TaskCompletionHttpService } from "../src/workflows/task-completion-http.service.js";
import { TaskStatusCompatibilityController } from "../src/workflows/task-status-compatibility.controller.js";
import { TaskStatusCompatibilityHttpService } from "../src/workflows/task-status-compatibility-http.service.js";
import { ExistingTaskStatusCommandPort } from "../src/modules/tasks/task-status.port.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { ProjectStartNotifier } from "../src/modules/projects/project-start.notifier.js";
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
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { type TaskCompletionRequest } from "@inpulse/api-contract";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { PostgresTaskQueryPort } from "../src/modules/tasks/task-query.port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { PostgresTaskCompletionCommandPort } from "../src/modules/tasks/task-completion.port.js";
import { TaskGroupRepository } from "../src/modules/task-groups/task-group.repository.js";
import { PostgresTaskBranchQueryPort } from "../src/modules/task-groups/task-branch-query.port.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { RecordDraftsService } from "../src/modules/change-records/record-drafts.service.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import { RecordPublicationRepository } from "../src/modules/change-records/record-publication.repository.js";
import { RecordPublicationAccess } from "../src/modules/change-records/record-publication-access.js";
import { RecordPublicationEffects } from "../src/modules/change-records/record-publication-effects.js";
import { RecordPublicationService } from "../src/modules/change-records/record-publication.service.js";
import { PublishedRecordRepository } from "../src/modules/change-records/published-record.repository.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { LeftoverSearchProjectionSync } from "../src/modules/change-records/leftover-search-projection.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { TaskCompletionWorkflow } from "../src/workflows/task-completion.workflow.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
} from "./database.helpers.js";
let db: DatabaseClient,
  auditDb: DatabaseClient,
  uow: PostgresUnitOfWork,
  workflow: TaskCompletionWorkflow,
  publication: RecordPublicationService;
let app: INestApplication, base: string;
let audit: PostgresAuditWritePort,
  activity: PostgresActivityWritePort,
  search: PostgresSearchProjectionWritePort,
  notifications: PostgresNotificationWritePort;
const tasks = new TaskManagementRepository(),
  records = new RecordDraftRepository(),
  groups = new TaskGroupRepository();
const content = {
  title: "组合完成",
  contextProblem: "发现问题",
  changeSolution: "修复方案",
  resultVerification: "验证通过",
  remainingIssues: [{ content: "后续优化" }],
};
beforeAll(async () => {
  db = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f20-conversion",
  });
  auditDb = createDatabaseClient(testUrls().auditReader);
  uow = new PostgresUnitOfWork(db);
  const access = new PostgresProjectAccessQueryPort(db),
    modules = new PostgresModuleQueryPort(),
    features = new PostgresFeatureQueryPort(),
    featureRead = new PostgresFeatureReadPort(),
    taskQuery = new PostgresTaskQueryPort(),
    pubRepo = new RecordPublicationRepository();
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  activity = new PostgresActivityWritePort();
  search = new PostgresSearchProjectionWritePort();
  notifications = new PostgresNotificationWritePort();
  const dispatcher = new ProjectNotificationDispatcher(access, notifications);
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
    postgresProjectMemberPermissions(),
  );
  publication = new RecordPublicationService(
    new RecordPublicationAccess(
      access,
      modules,
      features,
      taskQuery,
      pubRepo,
      postgresProjectMemberPermissions(),
    ),
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
      dispatcher,
    ),
  );
  workflow = new TaskCompletionWorkflow(
    access,
    modules,
    features,
    taskQuery,
    new PostgresTaskBranchQueryPort(groups),
    drafts,
    drafts,
    publication,
    new PostgresTaskCompletionCommandPort(
      tasks,
      audit,
      activity,
      search,
      dispatcher,
      new PostgresProjectsWritePort(),
      new ProjectStartNotifier(
        new PostgresProjectMembersQueryPort(),
        dispatcher,
      ),
    ),
    postgresProjectMemberPermissions(),
  );
  const auth = new SessionAuthService(
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
  leftover = new LeftoverTaskWorkflow(
    access,
    modules,
    features,
    featureRead,
    taskQuery,
    new PostgresFollowupTaskCommandPort(
      new TasksManagementService(
        access,
        modules,
        features,
        featureRead,
        new PostgresProjectCodePort(),
        new PostgresProjectMembersQueryPort(),
        uow,
        tasks,
        audit,
        activity,
        search,
        dispatcher,
        new PostgresModuleReadPort(),
        new PostgresProjectsWritePort(),
        postgresProjectMemberPermissions(),
      ),
    ),
    new PostgresLeftoverRecordCommandPort(
      new LeftoverRecordRepository(new PublishedRecordRepository()),
    ),
    audit,
    activity,
    search,
    new LeftoverSearchProjectionSync(search),
    postgresProjectMemberPermissions(),
  );
  class TestModule {}
  Module({
    controllers: [
      TaskCompletionController,
      TaskStatusCompatibilityController,
      LeftoverTaskController,
    ],
    providers: [
      {
        provide: LeftoverTaskHttpService,
        useValue: new LeftoverTaskHttpService(
          auth,
          mutation,
          idempotency,
          uow,
          leftover,
        ),
      },
      {
        provide: TaskStatusCompatibilityHttpService,
        useValue: new TaskStatusCompatibilityHttpService(
          mutation,
          idempotency,
          workflow,
          new ExistingTaskStatusCommandPort(
            new TasksManagementService(
              access,
              modules,
              features,
              featureRead,
              new PostgresProjectCodePort(),
              new PostgresProjectMembersQueryPort(),
              uow,
              tasks,
              audit,
              activity,
              search,
              dispatcher,
              new PostgresModuleReadPort(),
              new PostgresProjectsWritePort(),
              postgresProjectMemberPermissions(),
            ),
          ),
        ),
      },
      {
        provide: TaskCompletionHttpService,
        useValue: new TaskCompletionHttpService(
          mutation,
          idempotency,
          workflow,
        ),
      },
    ],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ContractResponseInterceptor());
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
const key = randomBytes(32);
const ring = VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1);
const tokens = new SessionTokenService(ring);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app?.close();
  await db?.close();
  await auditDb?.close();
});
async function fixture(feature = false) {
  const actor = await createUser(db.sql),
    p = await createProject(db.sql, actor),
    author = await createUser(db.sql);
  await db.sql`INSERT INTO app.project_members(project_id,user_id) VALUES(${p.projectId},${author})`;
  const [f] = await db.sql<
    { id: number }[]
  >`INSERT INTO app.features(project_id,module_id,code,name,created_by) VALUES(${p.projectId},${p.moduleId},${p.code + "-F-1"},'真实功能',${actor}) RETURNING id`;
  const scope = { ...p, featureId: feature ? f!.id : null },
    task = await uow.run(async (tx) => {
      const task = await tasks.create(
        tx,
        scope,
        actor,
        await new PostgresProjectCodePort().allocateTaskCode(tx, p.projectId),
        {
          title: "待完成任务",
          description: "说明",
          assigneeIds: [actor],
          priority: "NORMAL",
          dueAt: null,
        },
      );
      if (!feature) {
        await tasks.replaceImpacts(tx, task, [f!.id]);
        return (await tasks.find(tx, scope, task.id))!;
      }
      return task;
    });
  return { ...scope, actor, author, impactFeatureId: f!.id, task };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const complete = (
  f: Fixture,
  input: TaskCompletionRequest = {
    mode: "WITH_RECORD",
    expectedRowVersion: 1,
    record: content,
  },
) =>
  uow.run((tx) =>
    workflow.execute(tx, f.actor, f.task.id, input, randomUUID()),
  );

async function published(feature = false) {
  const f = await fixture(feature),
    result = await complete(f);
  return { ...f, record: result.record! };
}
type PublishedFixture = Awaited<ReturnType<typeof published>>;
async function inputFor(f: PublishedFixture): Promise<LeftoverTaskRequest> {
  const preview = await uow.run((tx) =>
    leftover.preview(tx, f.actor, f.projectId, f.record.id),
  );
  return {
    leftoverItemId: preview.leftoverItemId,
    recordVersion: preview.recordVersion,
    expectedRowVersion: preview.rowVersion,
    leftoverExpectedRowVersion: preview.leftoverRowVersion,
    expectedImpactFeatureIds: preview.inheritedImpacts.map((i) => i.id),
    title: "跟进遗留问题",
    assigneeIds: [f.author],
    priority: "HIGH",
    dueAt: null,
  };
}
const convert = (f: PublishedFixture, input: LeftoverTaskRequest) =>
  uow.run((tx) =>
    leftover.execute(
      tx,
      f.actor,
      f.projectId,
      f.record.id,
      input,
      randomUUID(),
    ),
  );
async function snapshot(f: PublishedFixture) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "tasks",
    "task_status_history",
    "code_sequences",
    "change_records",
    "change_record_versions",
    "change_record_version_leftovers",
    "change_record_leftover_items",
    "leftover_task_links",
    "activity_projection",
    "notifications",
    "search_projection",
  ])
    result[table] =
      await db.sql`SELECT to_jsonb(t) AS row FROM ${db.sql("app." + table)} t WHERE project_id=${f.projectId} ORDER BY to_jsonb(t)::text`;
  result.audit =
    await auditDb.sql`SELECT to_jsonb(t) AS row FROM app.audit_logs t WHERE project_id=${f.projectId} ORDER BY to_jsonb(t)::text`;
  return result;
}
async function session(userId: number) {
  const cookie = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  const [s] = await db.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions(user_id,token_hash,token_hash_key_version,auth_version_at_issue,auth_state,recovery_rotation_generation,recovery_rotation_consumed_generation,idle_expires_at,absolute_expires_at) VALUES(${userId},${tokens.hash(cookie).hash},1,1,'AUTHENTICATED',0,0,now()+interval '1 hour',now()+interval '1 day') RETURNING id`;
  await db.sql`INSERT INTO app.session_csrf_tokens(session_id,token_hash,expires_at) VALUES(${s!.id},${tokens.hash(csrf).hash},now()+interval '1 hour')`;
  return { cookie: `__Host-session=${cookie}`, csrf };
}
function post(
  f: PublishedFixture,
  actor: Awaited<ReturnType<typeof session>>,
  body: LeftoverTaskRequest,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  return fetch(
    `${base}/api/v1/projects/${f.projectId}/change-records/${f.record.id}/leftover-task`,
    {
      method: "POST",
      headers: {
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        "If-Match": `"${body.expectedRowVersion}"`,
        "Idempotency-Key": key,
        "Content-Type": "application/json",
        origin: base,
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}
for (const feature of [true, false])
  it(`converts ${feature ? "FEATURE" : "MODULE"} stable item once with original snapshots and bidirectional source`, async () => {
    const f = await published(feature),
      input = await inputFor(f),
      before = await snapshot(f),
      result = await convert(f, input);
    const task = await uow.run((tx) => tasks.find(tx, f, result.taskId));
    expect(task).toMatchObject({
      workStatus: "TODO",
      rowVersion: 1,
      assigneeIds: [f.author],
      scopeType: feature ? "FEATURE" : "MODULE",
      featureId: f.featureId,
    });
    expect(task?.description).toContain("后续优化");
    expect(task?.description).toContain(f.record.code + " v1");
    // 未填任务说明时，说明仍是服务端自动的来源块（口径 A 的退化情形）。
    expect(task?.description?.startsWith("来源记录：")).toBe(true);
    const after = await snapshot(f);
    for (const table of [
      "change_record_versions",
      "change_record_version_leftovers",
    ])
      expect(after[table]).toEqual(before[table]);
    expect(
      await uow.run((tx) =>
        new PublishedRecordRepository().find(tx, f.projectId, f.record.id),
      ),
    ).toMatchObject({
      currentVersion: 1,
      rowVersion: f.record.rowVersion + 1,
      leftovers: [
        {
          id: input.leftoverItemId,
          status: "CONVERTED",
          linkedTaskId: result.taskId,
          content: "后续优化",
        },
      ],
    });
    expect(
      await uow.run((tx) => leftover.source(tx, f.actor, result.taskId)),
    ).toEqual({
      source: {
        projectId: f.projectId,
        recordId: f.record.id,
        leftoverItemId: input.leftoverItemId,
      },
    });
    expect(
      await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} AND notification_type='leftover.convert'`,
    ).toEqual([{ recipient_id: f.author }]);
    expect(
      await db.sql`SELECT entity_id FROM app.search_projection WHERE project_id=${f.projectId} AND entity_type='TASK' AND entity_id=${result.taskId}`,
    ).toHaveLength(1);
    await expect(convert(f, input)).rejects.toMatchObject({
      status: 409,
      code: "LEFTOVER_ALREADY_CONVERTED",
      details: { task: { taskId: result.taskId } },
    });
  });
it("inherits every impacted feature because impacts can no longer be archived (ADR-045)", async () => {
  const f = await published(),
    [second] = await db.sql<
      { id: number }[]
    >`INSERT INTO app.features(project_id,module_id,code,name,created_by) VALUES(${f.projectId},${f.moduleId},${f.code + "-F-2"},'后加影响',${f.actor}) RETURNING id`;
  await db.sql`INSERT INTO app.change_record_feature_impacts(module_id,project_id,change_record_id,feature_id) VALUES(${f.moduleId},${f.projectId},${f.record.id},${second!.id})`;
  const preview = await uow.run((tx) =>
    leftover.preview(tx, f.actor, f.projectId, f.record.id),
  );
  // 功能层下线归档后，记录上的全部影响都会原样继承，不再有 archived history 排除分支。
  expect(preview.inheritedImpacts.map((i) => i.id)).toEqual([
    f.impactFeatureId,
    second!.id,
  ]);
  const result = await convert(f, await inputFor(f));
  expect(result.impactFeatureIds).toEqual([f.impactFeatureId, second!.id]);
  expect(
    (await uow.run((tx) =>
      new PublishedRecordRepository().find(tx, f.projectId, f.record.id),
    ))!.impactFeatureIds,
  ).toEqual([f.impactFeatureId, second!.id]);
});
it("rejects stale record/item versions, foreign item, non-member assignee and hidden client identity without writes", async () => {
  const f = await published(),
    input = await inputFor(f),
    before = await snapshot(f),
    outsider = await createUser(db.sql);
  for (const changed of [
    { ...input, expectedRowVersion: 99 },
    { ...input, recordVersion: 99 },
    { ...input, leftoverExpectedRowVersion: 99 },
    { ...input, leftoverItemId: 2147483647 },
    { ...input, assigneeIds: [outsider] },
    { ...input, expectedImpactFeatureIds: [] },
  ]) {
    await expect(convert(f, changed)).rejects.toMatchObject({
      status:
        changed.assigneeIds[0] === outsider
          ? 422
          : changed.leftoverItemId === 2147483647
            ? 404
            : 409,
    });
    expect(await snapshot(f)).toEqual(before);
  }
  const actor = await session(f.actor);
  expect(
    (await post(f, actor, { ...input, projectId: 99 } as LeftoverTaskRequest))
      .status,
  ).toBe(422);
});
it("prepends the authored task description ahead of the server source block (口径 A)", async () => {
  const f = await published(),
    input = await inputFor(f),
    result = await convert(f, {
      ...input,
      description: "  按线上日志先补埋点  ",
    });
  const description = (await uow.run((tx) => tasks.find(tx, f, result.taskId)))!
    .description;
  expect(description.startsWith("按线上日志先补埋点")).toBe(true);
  expect(description).toContain("来源记录：");
  expect(description).toContain(f.record.code + " v1");
  expect(description).toContain("后续优化");
  expect(description).not.toContain("  按线上日志");
});
it("rejects an authored description that overflows the 50000 character column", async () => {
  const f = await published(),
    input = await inputFor(f);
  await expect(
    convert(f, { ...input, description: "x".repeat(50000) }),
  ).rejects.toMatchObject({
    status: 422,
    code: "LEFTOVER_TASK_DESCRIPTION_TOO_LONG",
  });
});
for (const effect of [
  "audit",
  "activity",
  "search",
  "notification",
  "link",
  "late-audit",
  "late-search",
] as const)
  it(`rolls back task/code/link/item/record and projections after ${effect} failure`, async () => {
    const f = await published(),
      input = await inputFor(f),
      before = await snapshot(f);
    if (effect === "audit")
      vi.spyOn(audit, "append").mockRejectedValueOnce(Error("injected"));
    if (effect === "activity")
      vi.spyOn(activity, "append").mockRejectedValueOnce(Error("injected"));
    if (effect === "search")
      vi.spyOn(search, "upsert").mockRejectedValueOnce(Error("injected"));
    if (effect === "notification")
      vi.spyOn(notifications, "write").mockRejectedValueOnce(Error("injected"));
    if (effect === "link")
      vi.spyOn(
        LeftoverRecordRepository.prototype,
        "link",
      ).mockRejectedValueOnce(Error("injected"));
    if (effect === "late-audit") {
      const original = audit.append.bind(audit);
      vi.spyOn(audit, "append").mockImplementation((tx, input) => {
        if (input.action === "leftover.convert") throw Error("injected");
        return original(tx, input);
      });
    }
    if (effect === "late-search") {
      const original = search.upsert.bind(search);
      vi.spyOn(search, "upsert").mockImplementation((tx, input) => {
        if (input.entityType === "CHANGE_RECORD") throw Error("injected");
        return original(tx, input);
      });
    }
    await expect(convert(f, input)).rejects.toThrow("injected");
    expect(await snapshot(f)).toEqual(before);
  });
it("uses real HTTP auth, CSRF, strict If-Match and same-key replay, then gates replay and duplicate references on live access", async () => {
  const f = await published(),
    input = await inputFor(f),
    actor = await session(f.actor),
    key = randomUUID();
  expect(
    (await post(f, { ...actor, csrf: "a".repeat(43) }, input)).status,
  ).toBe(401);
  expect(
    (
      await post(f, actor, input, randomUUID(), {
        origin: "https://foreign.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await post(f, actor, input, randomUUID(), { "If-Match": '"99"' })).status,
  ).toBe(422);
  const responses = await Promise.all([
    post(f, actor, input, key),
    post(f, actor, input, key),
  ]);
  for (const r of responses) expect(r.status, await r.clone().text()).toBe(200);
  const result = leftoverTaskResponseSchema.parse(await responses[0]!.json());
  expect(await responses[1]!.json()).toEqual(result);
  expect(
    (await post(f, actor, { ...input, title: "另一个标题" }, key)).status,
  ).toBe(409);
  const duplicate = await post(f, actor, input);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({
    details: { task: { taskId: result.taskId } },
  });
  await removeMember(db.sql, f.projectId, f.actor);
  for (const k of [key, randomUUID()]) {
    const denied = await post(f, actor, input, k);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ details: {} });
  }
});
it("serializes different-key concurrent conversion and enforces a single stable link", async () => {
  const f = await published(),
    input = await inputFor(f),
    actor = await session(f.actor);
  const results = await Promise.all([
    post(f, actor, input),
    post(f, actor, input),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    await db.sql`SELECT task_id FROM app.leftover_task_links WHERE project_id=${f.projectId}`,
  ).toHaveLength(1);
  expect(
    await db.sql`SELECT id FROM app.tasks WHERE project_id=${f.projectId}`,
  ).toHaveLength(2);
});

it("retains the single link through CONVERTED edits, clearing and refilling, and replays the original result", async () => {
  const f = await published(),
    input = await inputFor(f),
    actor = await session(f.actor),
    key = randomUUID(),
    first = await post(f, actor, input, key);
  expect(first.status, await first.clone().text()).toBe(200);
  const result = leftoverTaskResponseSchema.parse(await first.json());
  let record = (await uow.run((tx) =>
    new PublishedRecordRepository().find(tx, f.projectId, f.record.id),
  ))!;
  const originalVersion =
    await db.sql`SELECT to_jsonb(v) AS row FROM app.change_record_versions v WHERE record_id=${record.id} AND version_no=1`;
  for (const entries of [
    [{ id: input.leftoverItemId, content: "改进后的遗留" }],
    [],
    [{ id: input.leftoverItemId, content: "再填遗留" }],
  ]) {
    record = await uow.run((tx) =>
      publication.update(
        tx,
        f.actor,
        f.projectId,
        record.id,
        record.rowVersion,
        record.currentVersion,
        { ...content, remainingIssues: entries, confirmLeftoverResolved: true },
        randomUUID(),
      ),
    );
    expect(
      record.leftovers.map((leftover) => [
        leftover.id,
        leftover.status,
        leftover.linkedTaskId,
      ]),
    ).toEqual([[input.leftoverItemId, "CONVERTED", result.taskId]]);
    expect(await (await post(f, actor, input, key)).json()).toEqual(result);
    const duplicate = await post(f, actor, {
      ...input,
      recordVersion: record.currentVersion,
      expectedRowVersion: record.rowVersion,
      leftoverExpectedRowVersion: record.leftovers[0]!.rowVersion,
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      details: { task: { taskId: result.taskId } },
    });
  }
  expect(
    await db.sql`SELECT to_jsonb(v) AS row FROM app.change_record_versions v WHERE record_id=${record.id} AND version_no=1`,
  ).toEqual(originalVersion);
  expect(
    await db.sql`SELECT task_id FROM app.leftover_task_links WHERE project_id=${f.projectId}`,
  ).toHaveLength(1);
});
it("rejects an item absent from the current version, then reuses its stable ID after refill", async () => {
  const f = await published(),
    input = await inputFor(f);
  let record = await uow.run((tx) =>
    publication.update(
      tx,
      f.actor,
      f.projectId,
      f.record.id,
      f.record.rowVersion,
      1,
      { ...content, remainingIssues: [], confirmLeftoverResolved: true },
      randomUUID(),
    ),
  );
  await expect(
    convert(f, {
      ...input,
      recordVersion: record.currentVersion,
      expectedRowVersion: record.rowVersion,
      // 条目已从当前版本移除，这里是客户端仍持有的上一个条目版本。
      leftoverExpectedRowVersion: f.record.leftovers[0]!.rowVersion,
    }),
  ).rejects.toMatchObject({ code: "LEFTOVER_NOT_ACTIVE" });
  record = await uow.run((tx) =>
    publication.update(
      tx,
      f.actor,
      f.projectId,
      record.id,
      record.rowVersion,
      record.currentVersion,
      {
        ...content,
        remainingIssues: [{ id: input.leftoverItemId, content: "新遗留" }],
        confirmLeftoverResolved: false,
      },
      randomUUID(),
    ),
  );
  expect(record.leftovers[0]!.id).toBe(input.leftoverItemId);
  const created = await convert(f, await inputFor(f));
  expect(created.leftoverItemId).toBe(input.leftoverItemId);
  expect(
    (await uow.run((tx) => tasks.find(tx, f, created.taskId)))!.description,
  ).toContain("新遗留");
});
it("requires an explicit leftover id once a record carries more than one active entry", async () => {
  const f = await published(),
    input = await inputFor(f),
    // 记录已有两条 ACTIVE 条目：不指定 id 的预览与转换都必须要求客户端选择。
    extra = await uow.run((tx) =>
      publication.update(
        tx,
        f.actor,
        f.projectId,
        f.record.id,
        f.record.rowVersion,
        f.record.currentVersion,
        {
          ...content,
          remainingIssues: [
            { id: input.leftoverItemId, content: "既有遗留" },
            { content: "新发现的遗留" },
          ],
          confirmLeftoverResolved: false,
        },
        randomUUID(),
      ),
    ),
    ids = extra.leftovers.map((leftover) => leftover.id);
  expect(ids).toHaveLength(2);
  await expect(
    uow.run((tx) => leftover.preview(tx, f.actor, f.projectId, f.record.id)),
  ).rejects.toMatchObject({
    code: "LEFTOVER_SELECTION_REQUIRED",
    details: { leftoverItemIds: ids },
  });
  expect(
    await uow.run((tx) =>
      leftover.preview(tx, f.actor, f.projectId, f.record.id, ids[1]!),
    ),
  ).toMatchObject({ leftoverItemId: ids[1], content: "新发现的遗留" });
});
it("checks current HTTP access for preview, task source, foreign records and duplicate target references", async () => {
  const f = await published(),
    input = await inputFor(f),
    actor = await session(f.actor),
    other = await session(await createUser(db.sql));
  const url = `${base}/api/v1/projects/${f.projectId}/change-records/${f.record.id}/leftover-task-preview`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { cookie: other.cookie } })).status).toBe(
    404,
  );
  expect((await fetch(url, { headers: { cookie: actor.cookie } })).status).toBe(
    200,
  );
  const task = await convert(f, input),
    source = `${base}/api/v1/tasks/${task.taskId}/leftover-source`;
  expect(
    (await fetch(source, { headers: { cookie: other.cookie } })).status,
  ).toBe(404);
  expect(
    await (await fetch(source, { headers: { cookie: actor.cookie } })).json(),
  ).toMatchObject({ source: { recordId: f.record.id } });
  expect((await post(f, other, input)).status).toBe(404);
});

import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
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
import {
  taskCompletionResponseSchema,
  type TaskCompletionRequest,
  type TaskStatusRequest,
} from "@inpulse/api-contract";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
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
    applicationName: "inpulse-f19-completion",
  });
  auditDb = createDatabaseClient(testUrls().auditReader);
  uow = new PostgresUnitOfWork(db);
  const access = new PostgresProjectAccessQueryPort(db),
    modules = new PostgresModuleQueryPort(),
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
      taskQuery,
      pubRepo,
      postgresProjectMemberPermissions(),
    ),
    pubRepo,
    records,
    new PublishedRecordRepository(),
    new PostgresProjectCodePort(),
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
  class TestModule {}
  Module({
    controllers: [TaskCompletionController, TaskStatusCompatibilityController],
    providers: [
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
async function fixture() {
  const actor = await createUser(db.sql),
    p = await createProject(db.sql, actor),
    author = await createUser(db.sql);
  await db.sql`INSERT INTO app.project_members(project_id,user_id) VALUES(${p.projectId},${author})`;
  const task = await uow.run((tx) =>
    tasks.create(tx, p, actor, p.code + "-T-1", {
      title: "待完成任务",
      description: "说明",
      assigneeIds: [actor],
      priority: "NORMAL",
      dueAt: null,
    }),
  );
  return { ...p, actor, author, task };
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
const draft = (f: Fixture, bound = false) =>
  uow.run((tx) =>
    records.create(
      tx,
      f,
      f.author,
      content,
      bound ? { taskId: f.task.id, handlerId: f.actor } : undefined,
    ),
  );
async function unchanged(
  f: Fixture,
  beforeDraft?: Awaited<ReturnType<typeof draft>>,
) {
  expect(await uow.run((tx) => tasks.find(tx, f, f.task.id))).toEqual(f.task);
  expect(await uow.run((tx) => tasks.history(tx, f, f.task.id))).toHaveLength(
    1,
  );
  if (beforeDraft)
    expect(
      await uow.run((tx) => records.find(tx, f.projectId, beforeDraft.id)),
    ).toEqual(beforeDraft);
  expect(
    await db.sql`SELECT id FROM app.change_records WHERE project_id=${f.projectId}`,
  ).toHaveLength(beforeDraft ? 1 : 0);
  for (const table of [
    "change_record_versions",
    "change_record_leftover_items",
    "activity_projection",
    "notifications",
    "search_projection",
  ])
    expect(
      await db.sql`SELECT 1 FROM ${db.sql("app." + table)} WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  expect(
    await db.sql`SELECT 1 FROM app.code_sequences WHERE project_id=${f.projectId} AND entity_type='CHANGE_RECORD'`,
  ).toHaveLength(0);
  expect(
    await auditDb.sql`SELECT 1 FROM app.audit_logs WHERE project_id=${f.projectId}`,
  ).toHaveLength(0);
}
it("completes inline with one immutable v1 and two events", async () => {
  const f = await fixture(),
    result = await complete(f);
  expect(result.task).toMatchObject({ workStatus: "DONE", rowVersion: 2 });
  expect(result.record).toMatchObject({
    taskId: f.task.id,
    handlerId: f.actor,
    authorId: f.actor,
    currentVersion: 1,
    status: "PUBLISHED",
  });
  expect(
    await db.sql`SELECT version_no FROM app.change_record_versions WHERE record_id=${result.record!.id}`,
  ).toEqual([{ version_no: 1 }]);
  const activityTypes = (
    (await db.sql`SELECT activity_type FROM app.activity_projection WHERE project_id=${f.projectId}`) as unknown as readonly {
      activity_type: string;
    }[]
  ).map((row) => row.activity_type);
  // ADR-035：首个任务完成会同事务写入项目开工活动。
  expect(activityTypes.sort()).toEqual([
    "PROJECT_STATUS_CHANGED",
    "record.publish",
    "task.complete",
  ]);
});
it("binds a matching independent draft without replacing frozen identities", async () => {
  const f = await fixture(),
    saved = await draft(f),
    result = await complete(f, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: saved.id,
      recordExpectedRowVersion: 1,
    });
  expect(result.record).toMatchObject({
    id: saved.id,
    taskId: f.task.id,
    authorId: f.author,
    handlerId: f.author,
    rowVersion: 3,
  });
  expect(
    await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} AND notification_type='task.complete' ORDER BY recipient_id`,
  ).toEqual(
    [f.actor, f.author]
      .sort((a, b) => a - b)
      .map((recipient_id) => ({ recipient_id })),
  );
});
it("completes without a new record, preserving multiple historical records and notifying their currently authorized authors", async () => {
  const f = await fixture(),
    one = await draft(f, true);
  await draft(f, true);
  await removeMember(db.sql, f.projectId, f.author);
  const result = await complete(f, {
    mode: "WITHOUT_RECORD",
    expectedRowVersion: 1,
    completionReason: "测试验证",
    note: "无需代码变化",
  });
  expect(result.record).toBeNull();
  expect(
    (await uow.run((tx) => tasks.history(tx, f, f.task.id)))[1]!
      .completionNoteSnapshot,
  ).toBe("测试验证，不关联迭代记录：无需代码变化");
  expect(
    await db.sql`SELECT id FROM app.change_records WHERE project_id=${f.projectId}`,
  ).toHaveLength(2);
  expect(await uow.run((tx) => records.find(tx, f.projectId, one.id))).toEqual(
    one,
  );
  expect(
    await db.sql`SELECT recipient_id, notification_type FROM app.notifications WHERE project_id=${f.projectId} ORDER BY notification_type`,
  ).toEqual([
    { recipient_id: f.actor, notification_type: "project.status.change" },
    { recipient_id: f.actor, notification_type: "task.complete" },
  ]);
});
it("keeps task, draft, code and all effects unchanged on search capacity or draft-version failure", async () => {
  const f = await fixture(),
    saved = await draft(f);
  await expect(
    complete(f, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: saved.id,
      recordExpectedRowVersion: 2,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await unchanged(f, saved);
  const g = await fixture();
  await expect(
    complete(g, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      record: {
        ...content,
        contextProblem: "文".repeat(50000),
        changeSolution: "文".repeat(50000),
      },
    }),
  ).rejects.toMatchObject({ status: 422 });
  await unchanged(g);
});
for (const effect of ["audit", "activity", "search", "notifications"] as const)
  it(`rolls back completion, binding, publication and sequence when ${effect} fails`, async () => {
    const f = await fixture(),
      saved = await draft(f);
    if (effect === "audit")
      vi.spyOn(audit, "append").mockRejectedValueOnce(Error("injected"));
    if (effect === "activity")
      vi.spyOn(activity, "append").mockRejectedValueOnce(Error("injected"));
    if (effect === "search")
      vi.spyOn(search, "upsert").mockRejectedValueOnce(Error("injected"));
    if (effect === "notifications")
      vi.spyOn(notifications, "write").mockRejectedValueOnce(Error("injected"));
    await expect(
      complete(f, {
        mode: "WITH_RECORD",
        expectedRowVersion: 1,
        recordDraftId: saved.id,
        recordExpectedRowVersion: 1,
      }),
    ).rejects.toThrow("injected");
    await unchanged(f, saved);
  });
for (const effect of ["audit", "activity", "search", "notifications"] as const)
  it(`rolls back already-completed task when the later publication ${effect} fails`, async () => {
    const f = await fixture(),
      saved = await draft(f);
    if (effect === "audit") {
      const original = audit.append.bind(audit);
      vi.spyOn(audit, "append").mockImplementation((tx, input) => {
        if (input.action === "record.publish") throw Error("late failure");
        return original(tx, input);
      });
    }
    if (effect === "activity") {
      const original = activity.append.bind(activity);
      vi.spyOn(activity, "append").mockImplementation((tx, input) => {
        if (input.activityType === "record.publish")
          throw Error("late failure");
        return original(tx, input);
      });
    }
    if (effect === "search") {
      const original = search.upsert.bind(search);
      vi.spyOn(search, "upsert").mockImplementation((tx, input) => {
        if (input.entityType === "CHANGE_RECORD") throw Error("late failure");
        return original(tx, input);
      });
    }
    if (effect === "notifications") {
      const original = notifications.write.bind(notifications);
      vi.spyOn(notifications, "write").mockImplementation((tx, input) => {
        if (input.notificationType === "record.publish")
          throw Error("late failure");
        return original(tx, input);
      });
    }
    await expect(
      complete(f, {
        mode: "WITH_RECORD",
        expectedRowVersion: 1,
        recordDraftId: saved.id,
        recordExpectedRowVersion: 1,
      }),
    ).rejects.toThrow("late failure");
    await unchanged(f, saved);
  });
async function session(userId: number) {
  const cookie = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  const [s] = await db.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions(user_id,token_hash,token_hash_key_version,auth_version_at_issue,auth_state,recovery_rotation_generation,recovery_rotation_consumed_generation,idle_expires_at,absolute_expires_at) VALUES(${userId},${tokens.hash(cookie).hash},1,1,'AUTHENTICATED',0,0,now()+interval '1 hour',now()+interval '1 day') RETURNING id`;
  await db.sql`INSERT INTO app.session_csrf_tokens(session_id,token_hash,expires_at) VALUES(${s!.id},${tokens.hash(csrf).hash},now()+interval '1 hour')`;
  return { cookie: `__Host-session=${cookie}`, csrf };
}
async function post(
  f: Fixture,
  actor: Awaited<ReturnType<typeof session>>,
  body: TaskCompletionRequest,
  key = randomUUID(),
  overrides: Record<string, string> = {},
) {
  return fetch(`${base}/api/v1/tasks/${f.task.id}/complete`, {
    method: "POST",
    headers: {
      cookie: actor.cookie,
      "x-csrf-token": actor.csrf,
      "If-Match": `"${body.expectedRowVersion}"`,
      "Idempotency-Key": key,
      "Content-Type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}
it("runs real HTTP authentication, CSRF, strict contract and concurrent idempotency with fresh replay authorization", async () => {
  const f = await fixture(),
    actor = await session(f.actor),
    input: TaskCompletionRequest = {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      record: { ...content, remainingIssues: [] },
    },
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
    (await post(f, actor, input, randomUUID(), { "If-Match": '"2"' })).status,
  ).toBe(422);
  const responses = await Promise.all([
    post(f, actor, input, key),
    post(f, actor, input, key),
  ]);
  for (const response of responses)
    expect(response.status, await response.clone().text()).toBe(200);
  const first = taskCompletionResponseSchema.parse(await responses[0]!.json());
  expect(await responses[1]!.json()).toEqual(first);
  expect(first.record?.leftovers).toEqual([]);
  expect(
    (
      await post(
        f,
        actor,
        { ...input, record: { ...content, title: "different" } },
        key,
      )
    ).status,
  ).toBe(409);
  expect((await post(f, actor, input)).status).toBe(409);
  await uow.run((tx) =>
    tasks.transition(tx, first.task, f.actor, "TODO", null, "后来重开"),
  );
  expect(await (await post(f, actor, input, key)).json()).toEqual(first);
  await removeMember(db.sql, f.projectId, f.actor);
  expect((await post(f, actor, input, key)).status).toBe(404);
});
it("replays the WITHOUT_RECORD null result and rejects competing keys without creating records", async () => {
  const f = await fixture(),
    actor = await session(f.actor),
    input: TaskCompletionRequest = {
      mode: "WITHOUT_RECORD",
      expectedRowVersion: 1,
      completionReason: "技术调研",
      note: "",
    },
    key = randomUUID();
  const response = await post(f, actor, input, key);
  expect(response.status, await response.clone().text()).toBe(200);
  const result = taskCompletionResponseSchema.parse(await response.json());
  expect(result.record).toBeNull();
  expect(await (await post(f, actor, input, key)).json()).toEqual(result);
  const g = await fixture(),
    a = await session(g.actor);
  const concurrent = await Promise.all([post(g, a, input), post(g, a, input)]);
  expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    await db.sql`SELECT id FROM app.change_records WHERE project_id=${g.projectId}`,
  ).toHaveLength(0);
});
it("rejects wrong module, foreign project, another source, revoked actor and stale task without partial writes", async () => {
  const f = await fixture(),
    g = await fixture(),
    foreign = await draft(g);
  await expect(
    complete(f, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: foreign.id,
      recordExpectedRowVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await unchanged(f);
  const [otherModule] = await db.sql<{ id: number }[]>`
    INSERT INTO app.modules (project_id, name, created_by)
    VALUES (${f.projectId}, '其他模块', ${f.actor})
    RETURNING id
  `;
  if (otherModule === undefined) throw new Error("module fixture failed");
  const mismatch = await uow.run((tx) =>
    records.create(
      tx,
      { projectId: f.projectId, moduleId: otherModule.id },
      f.author,
      content,
    ),
  );
  await expect(
    complete(f, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: mismatch.id,
      recordExpectedRowVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await unchanged(f, mismatch);
  const h = await fixture();
  await expect(
    complete(h, {
      mode: "WITHOUT_RECORD",
      expectedRowVersion: 2,
      completionReason: "其他",
      note: "",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await unchanged(h);
  await removeMember(db.sql, h.projectId, h.actor);
  await expect(complete(h)).rejects.toMatchObject({ status: 404 });
  await unchanged(h);
  const j = await fixture(),
    other = await uow.run((tx) =>
      tasks.create(tx, j, j.actor, j.code + "-T-2", {
        title: "其他任务",
        description: "",
        assigneeIds: [j.actor],
        priority: "NORMAL",
        dueAt: null,
      }),
    );
  const wrong = await uow.run((tx) =>
    records.create(tx, j, j.author, content, {
      taskId: other.id,
      handlerId: j.actor,
    }),
  );
  await expect(
    complete(j, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: wrong.id,
      recordExpectedRowVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await unchanged(j, wrong);
});
async function branchFixture(sourceKind: "ACTIVE" | "HISTORICAL") {
  const f = await fixture(),
    main = await uow.run((tx) =>
      tasks.create(tx, f, f.actor, f.code + "-T-2", {
        title: "主任务",
        description: "",
        assigneeIds: [f.actor],
        priority: "NORMAL",
        dueAt: null,
      }),
    );
  const add = (tx: Parameters<TaskGroupRepository["createGroup"]>[0]) =>
    createBranch(tx, f, main.id, sourceKind);
  return { f, main, add };
}
async function createBranch(
  tx: Parameters<TaskGroupRepository["createGroup"]>[0],
  f: Fixture,
  mainId: number,
  sourceKind: "ACTIVE" | "HISTORICAL",
) {
  const group = await groups.createGroup(tx, {
    projectId: f.projectId,
    code: f.code + "-TG-1",
    name: "合并组",
    createdBy: f.actor,
  });
  await groups.createMember(tx, {
    projectId: f.projectId,
    groupId: group.groupId,
    taskId: mainId,
    role: "MAIN",
    sourceKind: null,
    originalWorkStatus: null,
    originalAssigneeId: null,
  });
  await groups.createMember(tx, {
    projectId: f.projectId,
    groupId: group.groupId,
    taskId: f.task.id,
    role: "SOURCE",
    sourceKind,
    originalWorkStatus: f.task.workStatus,
    originalAssigneeId: f.actor,
  });
  return group;
}
it("permits ACTIVE sources and MAIN completion but rejects HISTORICAL execution without mutating the group", async () => {
  const a = await branchFixture("ACTIVE"),
    group = await uow.run(a.add);
  await complete(a.f);
  const after = await uow.run((tx) =>
    groups.findGroup(tx, a.f.projectId, group.groupId),
  );
  expect(after).toEqual(group);
  await complete(
    { ...a.f, task: a.main },
    {
      mode: "WITHOUT_RECORD",
      expectedRowVersion: 1,
      completionReason: "测试验证",
      note: "",
    },
  );
  expect(
    await uow.run((tx) => groups.findGroup(tx, a.f.projectId, group.groupId)),
  ).toEqual(group);
  const h = await branchFixture("HISTORICAL");
  await uow.run(h.add);
  await expect(complete(h.f)).rejects.toMatchObject({
    status: 409,
    code: "TASK_HISTORICAL_SOURCE",
  });
  await unchanged(h.f);
});
async function waitBlocked() {
  await vi.waitFor(
    async () =>
      expect(
        (
          await db.sql`SELECT pid FROM pg_stat_activity WHERE application_name='inpulse-f19-completion' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`
        ).length,
      ).toBeGreaterThan(0),
    { timeout: 4000, interval: 25 },
  );
}
it("rechecks a concurrent merge committed while completion waits for its task lock", async () => {
  const { f, add } = await branchFixture("HISTORICAL");
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      acquired = r;
    });
  const merging = uow.run(async (tx) => {
    await tx.sql`SELECT id FROM app.tasks WHERE project_id=${f.projectId} ORDER BY id FOR UPDATE`;
    await add(tx);
    acquired();
    await gate;
  });
  await ready;
  const result = expect(complete(f)).rejects.toMatchObject({
    status: 409,
    code: "TASK_HISTORICAL_SOURCE",
  });
  try {
    await waitBlocked();
  } finally {
    release();
    await merging;
  }
  await result;
  await unchanged(f);
});
it("rechecks edited draft contents and task versions after real lock waits", async () => {
  const f = await fixture(),
    saved = await draft(f);
  let release!: () => void, acquired!: () => void;
  let gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      acquired = r;
    });
  const editing = uow.run(async (tx) => {
    await records.find(tx, f.projectId, saved.id, true);
    await records.update(tx, saved, { ...content, title: "并发编辑" });
    acquired();
    await gate;
  });
  await ready;
  const result = expect(
    complete(f, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: saved.id,
      recordExpectedRowVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 409, code: "RECORD_VERSION_CONFLICT" });
  try {
    await waitBlocked();
  } finally {
    release();
    await editing;
  }
  await result;
  expect(await uow.run((tx) => tasks.find(tx, f, f.task.id))).toEqual(f.task);
  expect(
    await db.sql`SELECT 1 FROM app.change_record_versions WHERE project_id=${f.projectId}`,
  ).toHaveLength(0);
  const g = await fixture();
  gate = new Promise<void>((r) => {
    release = r;
  });
  ready = new Promise<void>((r) => {
    acquired = r;
  });
  const changing = uow.run(async (tx) => {
    await tasks.find(tx, g, g.task.id, true);
    await tasks.update(tx, g.task, {
      title: "最新任务",
      description: g.task.description,
      assigneeIds: [g.actor],
      priority: g.task.priority,
      dueAt: g.task.dueAt,
    });
    acquired();
    await gate;
  });
  await ready;
  const outcome = expect(complete(g)).rejects.toMatchObject({
    status: 409,
    code: "TASK_VERSION_CONFLICT",
  });
  try {
    await waitBlocked();
  } finally {
    release();
    await changing;
  }
  await outcome;
  expect(
    await db.sql`SELECT work_status FROM app.tasks WHERE id=${g.task.id}`,
  ).toEqual([{ work_status: "TODO" }]);
});
it("serializes independent publication against binding/completion", async () => {
  // ADR-045：功能归档下线后不再有父级归档拒写；ADR-109 已移除功能层，这里只覆盖两条并发写入的互斥。
  const g = await fixture(),
    saved = await draft(g);
  const outcomes = await Promise.allSettled([
    complete(g, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      recordDraftId: saved.id,
      recordExpectedRowVersion: 1,
    }),
    uow.run((tx) =>
      publication.publish(tx, g.actor, g.projectId, saved.id, 1, randomUUID()),
    ),
  ]);
  expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(
    1,
  );
  const record = await uow.run((tx) =>
    new PublishedRecordRepository().find(tx, g.projectId, saved.id),
  );
  expect(record?.currentVersion).toBe(1);
  const task = await uow.run((tx) => tasks.find(tx, g, g.task.id));
  expect(
    record?.taskId === null
      ? task?.workStatus === "TODO"
      : task?.workStatus === "DONE",
  ).toBe(true);
});
it("publishes a new record after reopening a task with existing formal history and preserves its old snapshot", async () => {
  const f = await fixture(),
    saved = await draft(f, true);
  const done = await uow.run((tx) =>
    tasks.transition(tx, f.task, f.actor, "DONE", "历史完成", null),
  );
  const old = await uow.run((tx) =>
    publication.publish(tx, f.actor, f.projectId, saved.id, 1, randomUUID()),
  );
  const reopened = await uow.run((tx) =>
    tasks.transition(tx, done!, f.actor, "TODO", null, "再做一次"),
  );
  const result = await complete(
    { ...f, task: reopened! },
    {
      mode: "WITH_RECORD",
      expectedRowVersion: reopened!.rowVersion,
      record: { ...content, title: "新的独立变化" },
    },
  );
  expect(result.record?.id).not.toBe(old.id);
  expect(
    await uow.run((tx) =>
      new PublishedRecordRepository().find(tx, f.projectId, old.id),
    ),
  ).toEqual(old);
  expect(
    await db.sql`SELECT id FROM app.change_records WHERE project_id=${f.projectId} AND task_id=${f.task.id} AND status='PUBLISHED'`,
  ).toHaveLength(2);
  expect(
    await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} AND notification_type='task.complete' ORDER BY recipient_id`,
  ).toEqual(
    [f.actor, f.author]
      .sort((a, b) => a - b)
      .map((recipient_id) => ({ recipient_id })),
  );
});

const legacyCommand: TaskStatusRequest = {
  action: "COMPLETE",
  mode: "WITHOUT_RECORD",
  completionReason: "测试验证",
  note: "兼容完成",
};
function legacyPost(
  f: Fixture,
  actor: Awaited<ReturnType<typeof session>>,
  body: TaskStatusRequest = legacyCommand,
  version = 1,
  key = randomUUID(),
) {
  return fetch(
    `${base}/api/v1/projects/${f.projectId}/modules/${f.moduleId}/tasks/${f.task.id}/status`,
    {
      method: "POST",
      headers: {
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        "If-Match": `"${version}"`,
        "Idempotency-Key": key,
        "Content-Type": "application/json",
        origin: base,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(body),
    },
  );
}
it("preserves legacy envelopes, notifies record authors and retains other transitions", async () => {
  const f = await fixture(),
    saved = await draft(f, true),
    actor = await session(f.actor),
    key = randomUUID();
  const first = await legacyPost(f, actor, legacyCommand, 1, key);
  expect(first.status, await first.clone().text()).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({
    id: f.task.id,
    workStatus: "DONE",
    rowVersion: 2,
  });
  expect(body).not.toHaveProperty("task");
  expect(body).not.toHaveProperty("record");
  expect(
    await (await legacyPost(f, actor, legacyCommand, 1, key)).json(),
  ).toEqual(body);
  expect(
    await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} AND notification_type='task.complete' ORDER BY recipient_id`,
  ).toEqual(
    [f.actor, f.author]
      .sort((a, b) => a - b)
      .map((recipient_id) => ({ recipient_id })),
  );
  expect(
    await uow.run((tx) => records.find(tx, f.projectId, saved.id)),
  ).toEqual(saved);
  let version = 2;
  for (const action of ["REOPEN", "CANCEL", "RESTORE"] as const) {
    const operationKey = randomUUID(),
      command = { action, reason: "兼容回归" };
    const response = await legacyPost(f, actor, command, version, operationKey);
    expect(response.status, await response.clone().text()).toBe(200);
    const changed = await response.json();
    expect(changed).toMatchObject({
      id: f.task.id,
      workStatus: action === "CANCEL" ? "CANCELED" : "TODO",
      rowVersion: version + 1,
    });
    expect(
      await (await legacyPost(f, actor, command, version, operationKey)).json(),
    ).toEqual(changed);
    version++;
  }
  expect(await uow.run((tx) => tasks.history(tx, f, f.task.id))).toHaveLength(
    5,
  );
  await removeMember(db.sql, f.projectId, f.actor);
  expect((await legacyPost(f, actor, legacyCommand, 1, key)).status).toBe(404);
});
it("rejects previous-contract keys at the legacy endpoint without additional writes", async () => {
  const f = await fixture(),
    actor = await session(f.actor),
    key = randomUUID();
  expect((await legacyPost(f, actor, legacyCommand, 1, key)).status).toBe(200);
  const operation = "transitionModuleTask";
  await db.sql`UPDATE app.idempotency_records SET idempotency_contract_version='1.0.0',replay_auth_policy_version='1.0.0' WHERE actor_id=${f.actor} AND operation_id=${operation} AND idempotency_key=${key}`;
  const retry = await legacyPost(f, actor, legacyCommand, 1, key);
  expect(retry.status, await retry.clone().text()).toBe(409);
  expect(await uow.run((tx) => tasks.history(tx, f, f.task.id))).toHaveLength(
    2,
  );
});
it("applies SOURCE/HISTORICAL and current replay gates to the legacy endpoint while allowing MAIN and ACTIVE", async () => {
  const active = await branchFixture("ACTIVE");
  await uow.run(active.add);
  const actor = await session(active.f.actor);
  expect((await legacyPost(active.f, actor)).status).toBe(200);
  expect(
    (await legacyPost({ ...active.f, task: active.main }, actor)).status,
  ).toBe(200);
  const historical = await branchFixture("HISTORICAL"),
    ha = await session(historical.f.actor);
  await uow.run(historical.add);
  const denied = await legacyPost(historical.f, ha);
  expect(denied.status, await denied.clone().text()).toBe(409);
  expect(await denied.json()).toMatchObject({ code: "TASK_HISTORICAL_SOURCE" });
  await unchanged(historical.f);
  const later = await branchFixture("HISTORICAL"),
    la = await session(later.f.actor),
    key = randomUUID();
  expect((await legacyPost(later.f, la, legacyCommand, 1, key)).status).toBe(
    200,
  );
  later.f.task = (await uow.run((tx) =>
    tasks.find(tx, later.f, later.f.task.id),
  ))!;
  await uow.run(later.add);
  const replay = await legacyPost(later.f, la, legacyCommand, 1, key);
  expect(replay.status, await replay.clone().text()).toBe(409);
  expect(await replay.json()).toMatchObject({ code: "TASK_HISTORICAL_SOURCE" });
});
it("serializes competing legacy and new completion requests into one successful transition", async () => {
  const f = await fixture(),
    actor = await session(f.actor);
  const results = await Promise.all([
    legacyPost(f, actor),
    post(f, actor, {
      mode: "WITH_RECORD",
      expectedRowVersion: 1,
      record: content,
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await uow.run((tx) => tasks.history(tx, f, f.task.id))).toHaveLength(
    2,
  );
  const count = results[1]!.status === 200 ? 1 : 0;
  expect(
    await db.sql`SELECT id FROM app.change_records WHERE project_id=${f.projectId}`,
  ).toHaveLength(count);
  expect(
    await db.sql`SELECT 1 FROM app.change_record_versions WHERE project_id=${f.projectId}`,
  ).toHaveLength(count);
});
it("rolls back legacy completion and its effects when notification persistence fails", async () => {
  const f = await fixture(),
    actor = await session(f.actor);
  vi.spyOn(notifications, "write").mockRejectedValueOnce(
    Error("compatibility failure"),
  );
  expect((await legacyPost(f, actor)).status).toBe(500);
  await unchanged(f);
});

it("首个任务完成把项目从未开始升级为进行中，并写审计、活动与开工通知", async () => {
  const f = await fixture();
  const readProject = async () =>
    (await db.sql`SELECT status, first_task_completed_at AS "firstTaskCompletedAt", row_version AS "rowVersion" FROM app.projects WHERE id = ${f.projectId}`) as unknown as readonly {
      status: string;
      firstTaskCompletedAt: Date | null;
      rowVersion: number;
    }[];

  expect((await readProject())[0]).toMatchObject({
    status: "NOT_STARTED",
    firstTaskCompletedAt: null,
    rowVersion: 1,
  });

  await complete(f);

  const started = (await readProject())[0]!;
  expect(started.status).toBe("ACTIVE");
  expect(started.firstTaskCompletedAt).not.toBeNull();
  expect(started.rowVersion).toBe(2);

  expect(
    await auditDb.sql`SELECT action FROM app.audit_logs WHERE project_id=${f.projectId} AND action='project.status.change'`,
  ).toHaveLength(1);
  expect(
    await db.sql`SELECT activity_type FROM app.activity_projection WHERE project_id=${f.projectId} AND activity_type='PROJECT_STATUS_CHANGED'`,
  ).toHaveLength(1);
  expect(
    (await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} AND notification_type='project.status.change' ORDER BY recipient_id`) as unknown as readonly {
      recipient_id: number;
    }[],
  ).toEqual(
    [f.actor, f.author]
      .sort((a, b) => a - b)
      .map((recipient_id) => ({ recipient_id })),
  );

  const second = await uow.run((tx) =>
    tasks.create(tx, f, f.actor, f.code + "-T-2", {
      title: "第二个任务",
      description: "说明",
      assigneeIds: [f.actor],
      priority: "NORMAL",
      dueAt: null,
    }),
  );
  await complete({ ...f, task: second });

  const again = (await readProject())[0]!;
  expect(again.status).toBe("ACTIVE");
  expect(again.rowVersion).toBe(2);
  expect(
    await db.sql`SELECT activity_type FROM app.activity_projection WHERE project_id=${f.projectId} AND activity_type='PROJECT_STATUS_CHANGED'`,
  ).toHaveLength(1);
});

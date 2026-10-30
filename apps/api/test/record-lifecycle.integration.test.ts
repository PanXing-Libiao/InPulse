import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import { SearchQueryService } from "../src/modules/search/search-query.service.js";
import { PostgresSearchProjectionReader } from "../src/modules/search/search-projection.reader.js";
import { SearchCursorService } from "../src/modules/search/search-cursor.js";
import { ActivityQueryService } from "../src/modules/activity/activity-query.service.js";
import { PostgresActivityProjectionReader } from "../src/modules/activity/activity-projection.reader.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import { RecordLifecycleService } from "../src/modules/change-records/record-lifecycle.service.js";
import { RecordLifecycleRepository } from "../src/modules/change-records/record-lifecycle.repository.js";
import { RecordLifecycleHttpService } from "../src/modules/change-records/record-lifecycle-http.service.js";
import { RecordLifecycleController } from "../src/modules/change-records/record-lifecycle.controller.js";
import { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { schemaRegistry } from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresTaskQueryPort } from "../src/modules/tasks/task-query.port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { PublishedRecordRepository } from "../src/modules/change-records/published-record.repository.js";
import { RecordPublicationRepository } from "../src/modules/change-records/record-publication.repository.js";
import { RecordPublicationAccess } from "../src/modules/change-records/record-publication-access.js";
import { RecordPublicationEffects } from "../src/modules/change-records/record-publication-effects.js";
import { RecordPublicationService } from "../src/modules/change-records/record-publication.service.js";
import { RecordPublicationHttpService } from "../src/modules/change-records/record-publication-http.service.js";
import { PublishedRecordsHttpService } from "../src/modules/change-records/published-records-http.service.js";
import { PublishedRecordReadService } from "../src/modules/change-records/published-record-read.service.js";
import { PublishedRecordsController } from "../src/modules/change-records/published-records.controller.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { LeftoverSearchProjectionSync } from "../src/modules/change-records/leftover-search-projection.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
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
import { createProject, createUser, testUrls } from "./database.helpers.js";
let db: DatabaseClient,
  auditDb: DatabaseClient,
  uow: PostgresUnitOfWork,
  service: RecordPublicationService,
  app: INestApplication,
  base: string;
let audit: PostgresAuditWritePort,
  activity: PostgresActivityWritePort,
  search: PostgresSearchProjectionWritePort,
  notifications: PostgresNotificationWritePort;
const key = randomBytes(32),
  ring = VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
  tokens = new SessionTokenService(ring);
const content = {
  title: "发布验证",
  contextProblem: "并发保存",
  changeSolution: "事务发布",
  resultVerification: "完整校验",
  remainingIssues: [{ content: "仍需跟进" }],
};
beforeAll(async () => {
  db = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f18-publish",
  });
  auditDb = createDatabaseClient(testUrls().auditReader);
  uow = new PostgresUnitOfWork(db);
  const access = new PostgresProjectAccessQueryPort(db),
    repository = new RecordPublicationRepository(),
    gate = new RecordPublicationAccess(
      access,
      new PostgresModuleQueryPort(),
      new PostgresTaskQueryPort(),
      repository,
      postgresProjectMemberPermissions(),
    );
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  activity = new PostgresActivityWritePort();
  search = new PostgresSearchProjectionWritePort();
  notifications = new PostgresNotificationWritePort();
  const dispatcher = new ProjectNotificationDispatcher(access, notifications);
  service = new RecordPublicationService(
    gate,
    repository,
    new RecordDraftRepository(),
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
    controllers: [PublishedRecordsController, RecordLifecycleController],
    providers: [
      {
        provide: RecordLifecycleHttpService,
        useValue: new RecordLifecycleHttpService(
          new AdminHighRiskAuthService(
            new PostgresUserSessionRepository(),
            new PostgresSessionCsrfTokenRepository(),
            tokens,
            new PostgresUserCredentialRepository(),
          ),
          idempotency,
          new RecordLifecycleService(
            access,
            new PostgresModuleQueryPort(),
            repository,
            new PublishedRecordRepository(),
            new RecordLifecycleRepository(),
            audit,
            activity,
            search,
            new LeftoverSearchProjectionSync(search),
          ),
        ),
      },
      {
        provide: PublishedRecordsHttpService,
        useValue: new PublishedRecordsHttpService(
          auth,
          new PublishedRecordReadService(
            access,
            uow,
            new PublishedRecordRepository(),
            new TimeCursorService(ring, "CHANGE_RECORDS"),
          ),
        ),
      },
      {
        provide: RecordPublicationHttpService,
        useValue: new RecordPublicationHttpService(
          mutation,
          idempotency,
          gate,
          service,
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
  await db?.close();
  await auditDb?.close();
});
async function fixture(
  remainingIssues: readonly {
    readonly id?: number;
    readonly content: string;
  }[] = content.remainingIssues,
) {
  const userId = await createUser(db.sql),
    p = await createProject(db.sql, userId),
    creator = await createUser(db.sql);
  await db.sql`INSERT INTO app.project_members(project_id,user_id) VALUES(${p.projectId},${creator})`;
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      {
        ...p,
      },
      userId,
      { ...content, remainingIssues: [...remainingIssues] },
    ),
  );
  return { ...p, userId, creator, draft };
}
const publish = (f: Awaited<ReturnType<typeof fixture>>) =>
  uow.run((tx) =>
    service.publish(tx, f.userId, f.projectId, f.draft.id, 1, randomUUID()),
  );
async function session(userId: number) {
  const cookie = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  const [s] = await db.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions(user_id,token_hash,token_hash_key_version,auth_version_at_issue,auth_state,recovery_rotation_generation,recovery_rotation_consumed_generation,idle_expires_at,absolute_expires_at) VALUES(${userId},${tokens.hash(cookie).hash},1,1,'AUTHENTICATED',0,0,now()+interval '1 hour',now()+interval '1 day') RETURNING id`;
  await db.sql`INSERT INTO app.session_csrf_tokens(session_id,token_hash,expires_at) VALUES(${s!.id},${tokens.hash(csrf).hash},now()+interval '1 hour')`;
  return { cookie: `__Host-session=${cookie}`, csrf };
}
async function failure(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status);
  const e = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  expect(response.headers.get("x-request-id")).toBe(e.requestId);
  expect(JSON.stringify(e)).not.toMatch(
    /SELECT |INSERT INTO|constraint_name|stack/,
  );
}

async function lifecycleFixture() {
  const f = await fixture(content.remainingIssues);
  const record = await publish(f);
  const adminId = await createUser(db.sql, { admin: true });
  const admin = await session(adminId);
  return { ...f, record, adminId, admin };
}
async function change(
  f: Awaited<ReturnType<typeof lifecycleFixture>>,
  restore = false,
  version = f.record.rowVersion,
  actor = f.admin,
  key = randomUUID(),
  reason = "生命周期测试原因",
) {
  return fetch(
    `${base}/api/v1/projects/${f.projectId}/change-records/${f.draft.id}/${restore ? "restore" : "void"}`,
    {
      method: "POST",
      headers: {
        origin: base,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        "If-Match": `"${version}"`,
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ reason }),
    },
  );
}
async function state(f: Awaited<ReturnType<typeof lifecycleFixture>>) {
  const [record] =
    await db.sql`SELECT * FROM app.change_records WHERE id=${f.draft.id}`;
  return {
    record,
    versions:
      await db.sql`SELECT * FROM app.change_record_versions WHERE record_id=${f.draft.id} ORDER BY version_no`,
    leftovers:
      await db.sql`SELECT * FROM app.change_record_leftover_items WHERE record_id=${f.draft.id} ORDER BY id`,
    snapshots:
      await db.sql`SELECT * FROM app.change_record_version_leftovers WHERE record_id=${f.draft.id} ORDER BY version_no,leftover_item_id`,
    links:
      await db.sql`SELECT * FROM app.leftover_task_links WHERE leftover_item_id IN (SELECT id FROM app.change_record_leftover_items WHERE record_id=${f.draft.id})`,
    activity:
      await db.sql`SELECT * FROM app.activity_projection WHERE project_id=${f.projectId} ORDER BY id`,
    search:
      await db.sql`SELECT * FROM app.search_projection WHERE project_id=${f.projectId} ORDER BY id`,
    notifications:
      await db.sql`SELECT * FROM app.notifications WHERE project_id=${f.projectId} ORDER BY id`,
    audit:
      await auditDb.sql`SELECT * FROM app.audit_logs WHERE project_id=${f.projectId} ORDER BY sequence_no`,
  };
}
describe("F21 ADR-024 lifecycle", () => {
  it("cycles twice, preserves immutable records/leftovers and snapshots, hides reasons in projections", async () => {
    const f = await lifecycleFixture();
    const before = await state(f);
    for (let round = 0; round < 2; round++) {
      const voidResponse = await change(
        f,
        false,
        f.record.rowVersion + round * 2,
        f.admin,
        randomUUID(),
        "作废私密原因" + round,
      );
      expect(voidResponse.status).toBe(200);
      expect(await voidResponse.json()).toEqual({
        id: f.draft.id,
        projectId: f.projectId,
        status: "VOID",
        rowVersion: f.record.rowVersion + round * 2 + 1,
      });
      const voidState = await state(f);
      expect(voidState.record).toMatchObject({
        status: "VOID",
        void_reason: "作废私密原因" + round,
      });
      expect(voidState.search).toHaveLength(2);
      for (const row of voidState.search)
        expect(row).toMatchObject({ visibility_scope: "ADMIN_ONLY" });
      for (const row of voidState.activity)
        expect(row).toMatchObject({
          visibility_scope: "ADMIN_ONLY",
          source_status: "VOID",
        });
      const response = await change(
        f,
        true,
        f.record.rowVersion + round * 2 + 1,
        f.admin,
        randomUUID(),
        "恢复私密原因" + round,
      );
      expect(response.status).toBe(200);
      const after = await state(f);
      expect(after.record).toEqual({
        ...voidState.record,
        status: "PUBLISHED",
        row_version: f.record.rowVersion + round * 2 + 2,
        updated_at: after.record!.updated_at,
      });
      for (const field of [
        "versions",
        "leftovers",
        "snapshots",
        "links",
        "notifications",
      ] as const)
        expect(after[field]).toEqual(before[field]);
      expect(after.search).toHaveLength(2);
      expect(after.search[0]).toMatchObject({
        id: before.search[0]!.id,
        entity_type: "CHANGE_RECORD",
        visibility_scope: "MEMBER",
        source_status: "PUBLISHED",
      });
      expect(after.search[1]).toMatchObject({
        id: before.search[1]!.id,
        entity_type: "LEFTOVER",
        visibility_scope: "MEMBER",
        source_status: "ACTIVE",
      });
      for (const row of after.activity)
        expect(row).toMatchObject({
          visibility_scope: "MEMBER",
          source_status: "PUBLISHED",
        });
      expect(
        JSON.stringify(after.activity) + JSON.stringify(after.search),
      ).not.toContain("私密原因");
      expect(
        after.audit.filter((row) =>
          ["CHANGE_RECORD_VOIDED", "CHANGE_RECORD_RESTORED"].includes(
            row.action as string,
          ),
        ),
      ).toHaveLength((round + 1) * 2);
    }
  });
  it("enforces member 404, admin VOID discovery/all versions and status-only restored visibility", async () => {
    const f = await lifecycleFixture();
    expect((await change(f)).status).toBe(200);
    const reader = new PublishedRecordReadService(
      new PostgresProjectAccessQueryPort(db),
      uow,
      new PublishedRecordRepository(),
      new TimeCursorService(ring, "CHANGE_RECORDS"),
    );
    await expect(
      reader.read(f.userId, f.projectId, f.draft.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reader.read(f.userId, f.projectId, f.draft.id, true),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reader.list(f.userId, f.projectId, { status: "VOID" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await reader.list(f.adminId, f.projectId, {})).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(
      await reader.list(f.adminId, f.projectId, { status: "VOID" }),
    ).toMatchObject({ items: [{ id: f.draft.id, status: "VOID" }] });
    expect(await reader.read(f.adminId, f.projectId, f.draft.id)).toMatchObject(
      { status: "VOID", voidReason: "生命周期测试原因" },
    );
    expect(
      await reader.read(f.adminId, f.projectId, f.draft.id, true),
    ).toMatchObject({ items: [{ versionNo: 1 }] });
    expect((await change(f, true, f.record.rowVersion + 1)).status).toBe(200);
    const restored = await reader.read(f.userId, f.projectId, f.draft.id);
    expect(restored).toMatchObject({ status: "PUBLISHED" });
    expect(restored).not.toHaveProperty("voidReason");
  });
  it("replays the same Key and re-checks current administrator identity", async () => {
    const f = await lifecycleFixture(),
      key = randomUUID();
    const first = await change(f, false, f.record.rowVersion, f.admin, key);
    expect(first.status).toBe(200);
    const original = await first.json();
    expect(
      await (await change(f, false, f.record.rowVersion, f.admin, key)).json(),
    ).toEqual(original);
    await failure(
      await change(f, false, f.record.rowVersion, f.admin, key, "不同原因"),
      409,
    );
    await failure(await change(f, false, f.record.rowVersion), 409);
    await db.sql`UPDATE app.users SET is_admin=false,row_version=row_version+1 WHERE id=${f.adminId}`;
    await failure(
      await change(f, false, f.record.rowVersion, f.admin, key),
      403,
    );
    await db.sql`UPDATE app.users SET is_admin=true,row_version=row_version+1 WHERE id=${f.adminId}`;
    await db.sql`UPDATE app.user_sessions SET revoked_at=now() WHERE user_id=${f.adminId}`;
    await failure(
      await change(f, false, f.record.rowVersion, f.admin, key),
      401,
    );
  });
  it("rejects ordinary members, empty reasons, wrong state and stale versions without effects", async () => {
    const f = await lifecycleFixture(),
      before = await state(f);
    await failure(
      await change(f, false, f.record.rowVersion, await session(f.userId)),
      403,
    );
    await failure(
      await change(f, false, f.record.rowVersion, f.admin, randomUUID(), "  "),
      422,
    );
    await failure(await change(f, true), 409);
    await failure(await change(f, false, 999), 409);
    expect(await state(f)).toEqual(before);
  });
  it("serializes different keys to exactly one transition and replays concurrent same key", async () => {
    for (const sameKey of [false, true]) {
      const f = await lifecycleFixture(),
        key = randomUUID();
      const results = await Promise.all([
        change(f, false, f.record.rowVersion, f.admin, key),
        change(
          f,
          false,
          f.record.rowVersion,
          f.admin,
          sameKey ? key : randomUUID(),
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(
        sameKey ? [200, 200] : [200, 409],
      );
      const snapshot = await state(f);
      expect(
        snapshot.audit.filter((row) => row.action === "CHANGE_RECORD_VOIDED"),
      ).toHaveLength(1);
    }
  });
  for (const effect of ["audit", "visibility", "activity", "search"] as const)
    it("rolls back all effects when " + effect + " fails", async () => {
      const f = await lifecycleFixture(),
        before = await state(f);
      if (effect === "audit")
        vi.spyOn(audit, "append").mockRejectedValueOnce(Error("audit failed"));
      if (effect === "visibility")
        vi.spyOn(activity, "updateEntityVisibility").mockRejectedValueOnce(
          Error("visibility failed"),
        );
      if (effect === "activity")
        vi.spyOn(activity, "append").mockRejectedValueOnce(
          Error("activity failed"),
        );
      if (effect === "search")
        vi.spyOn(search, "upsert").mockRejectedValueOnce(
          Error("search failed"),
        );
      await failure(await change(f), 500);
      expect(await state(f)).toEqual(before);
    });
});

it("search and activity readers enforce current visibility before and after restore", async () => {
  const f = await lifecycleFixture(),
    access = new PostgresProjectAccessQueryPort(db),
    ring = VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1);
  const searches = new SearchQueryService(
    access,
    new PostgresSearchProjectionReader(db.sql),
    new SearchCursorService(ring),
  );
  const activities = new ActivityQueryService(
    access,
    new PostgresActivityProjectionReader(db.sql),
    new TimeCursorService(ring, "ACTIVITY"),
  );
  const searchFor = (actorUserId: number, includeVoid = false) =>
    searches.search({ actorUserId, query: f.record.code, includeVoid });
  expect(
    (await searchFor(f.userId)).items.some((r) => r.entityId === f.draft.id),
  ).toBe(true);
  expect((await change(f)).status).toBe(200);
  expect((await searchFor(f.userId, true)).items).toEqual([]);
  expect((await searchFor(f.adminId)).items).toEqual([]);
  expect(
    (await searchFor(f.adminId, true)).items
      .map((item) => item.entityType)
      .sort(),
  ).toEqual(["CHANGE_RECORD", "LEFTOVER"]);
  expect(
    (
      await activities.query({
        actorUserId: f.userId,
        projectId: f.projectId,
        includeAdminOnly: true,
      })
    ).items,
  ).toEqual([]);
  expect((await change(f, true, f.record.rowVersion + 1)).status).toBe(200);
  expect(
    (await searchFor(f.userId)).items.map((item) => item.entityType).sort(),
  ).toEqual(["CHANGE_RECORD", "LEFTOVER"]);
  expect(
    (await activities.query({ actorUserId: f.userId, projectId: f.projectId }))
      .items,
  ).toHaveLength(3);
});
it("preserves converted links, exact history and source TODO without a restore gate", async () => {
  const f = await lifecycleFixture();
  const task = await uow.run(async (tx) => {
    const t = await new TaskManagementRepository().create(
      tx,
      { projectId: f.projectId, moduleId: f.moduleId },
      f.userId,
      f.code + "-T-1",
      {
        title: "既有任务",
        description: "fixture",
        assigneeIds: [f.userId],
        priority: "NORMAL",
        dueAt: null,
      },
    );
    await tx.sql`INSERT INTO app.leftover_task_links(leftover_item_id,task_id,project_id,created_by) VALUES(${f.record.leftovers[0]!.id},${t.id},${f.projectId},${f.userId})`;
    await tx.sql`UPDATE app.change_record_leftover_items SET status='CONVERTED',row_version=row_version+1 WHERE id=${f.record.leftovers[0]!.id}`;
    return t;
  });
  // Formal source identity must already exist at publication. Create another draft bound to the same task, then publish it while DONE.
  const done = await uow.run((tx) =>
    new TaskManagementRepository().transition(
      tx,
      task,
      f.userId,
      "DONE",
      "测试验证",
      null,
    ),
  );
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      { projectId: f.projectId, moduleId: f.moduleId },
      f.userId,
      content,
      { taskId: task.id, handlerId: f.userId },
    ),
  );
  const sourced = await uow.run((tx) =>
    service.publish(tx, f.userId, f.projectId, draft.id, 1, randomUUID()),
  );
  await uow.run((tx) =>
    new TaskManagementRepository().transition(
      tx,
      done!,
      f.userId,
      "TODO",
      null,
      "后来重开",
    ),
  );
  const before = await state(f),
    tasksBefore =
      await db.sql`SELECT * FROM app.tasks WHERE project_id=${f.projectId} ORDER BY id`;
  expect((await change(f)).status).toBe(200);
  expect((await change(f, true, f.record.rowVersion + 1)).status).toBe(200);
  const sourceFixture = { ...f, draft, record: sourced };
  expect((await change(sourceFixture)).status).toBe(200);
  expect(
    (await change(sourceFixture, true, sourced.rowVersion + 1)).status,
  ).toBe(200);
  const after = await state(f);
  for (const field of ["versions", "leftovers", "snapshots", "links"] as const)
    expect(after[field]).toEqual(before[field]);
  expect(
    await db.sql`SELECT * FROM app.tasks WHERE project_id=${f.projectId} ORDER BY id`,
  ).toEqual(tasksBefore);
  const [source] =
    await db.sql`SELECT task_id FROM app.change_records WHERE id=${draft.id}`;
  expect(source!.task_id).toBe(task.id);
});
// ADR-045：功能归档下线后父级已不存在「归档后再拒写」这条路径；ADR-109 已移除功能层；
// 父到子锁序由下面的「holds parent locks until projections commit」用例覆盖。
it("holds parent locks until projections commit, serializing a following parent write", async () => {
  const f = await lifecycleFixture();
  expect((await change(f)).status).toBe(200);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const original = search.upsert.bind(search);
  vi.spyOn(search, "upsert").mockImplementationOnce(async (tx, input) => {
    await original(tx, input);
    entered();
    await hold;
  });
  const pending = change(f, true, f.record.rowVersion + 1);
  await ready;
  let locked = false;
  const parentWrite = uow.run(async (tx) => {
    await tx.sql`SELECT id FROM app.projects WHERE id=${f.projectId} FOR UPDATE`;
    locked = true;
  });
  try {
    await vi.waitFor(
      async () => {
        const rows =
          await db.sql`SELECT 1 FROM pg_stat_activity WHERE application_name='inpulse-f18-publish' AND wait_event_type='Lock'`;
        expect(rows.length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 20 },
    );
    expect(locked).toBe(false);
  } finally {
    release();
  }
  expect((await pending).status).toBe(200);
  await parentWrite;
  expect(locked).toBe(true);
});

it("rechecks administrator identity after waiting for the record lock", async () => {
  const f = await lifecycleFixture(),
    before = await state(f);
  let release!: () => void, locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r)),
    hold = new Promise<void>((r) => (release = r));
  const blocker = uow.run(async (tx) => {
    await tx.sql`SELECT id FROM app.change_records WHERE id=${f.draft.id} FOR UPDATE`;
    locked();
    await hold;
  });
  await ready;
  const pending = change(f);
  try {
    await vi.waitFor(
      async () => {
        const rows =
          await db.sql`SELECT 1 FROM pg_stat_activity WHERE application_name='inpulse-f18-publish' AND wait_event_type='Lock'`;
        expect(rows.length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 20 },
    );
    await db.sql`UPDATE app.users SET is_admin=false,row_version=row_version+1 WHERE id=${f.adminId}`;
  } finally {
    release();
    await blocker;
  }
  await failure(await pending, 403);
  expect(await state(f)).toEqual(before);
});
it("validates HTTP VOID versions and hides record reasons from unauthorized readers", async () => {
  const f = await lifecycleFixture();
  expect((await change(f)).status).toBe(200);
  const member = await session(f.userId),
    url = `${base}/api/v1/projects/${f.projectId}/change-records/${f.draft.id}/versions/1`;
  const success = await fetch(url, { headers: { cookie: f.admin.cookie } });
  expect(success.status).toBe(200);
  expect(success.headers.get("cache-control")).toBe("no-store");
  expect(await success.json()).toMatchObject({
    versionNo: 1,
    title: content.title,
  });
  const denied = await fetch(url, { headers: { cookie: member.cookie } });
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("生命周期测试原因");
});
for (const effect of ["audit", "visibility", "activity", "search"] as const)
  it("rolls back restore when " + effect + " fails", async () => {
    const f = await lifecycleFixture();
    expect((await change(f)).status).toBe(200);
    const before = await state(f);
    if (effect === "audit")
      vi.spyOn(audit, "append").mockRejectedValueOnce(Error("audit failed"));
    if (effect === "visibility")
      vi.spyOn(activity, "updateEntityVisibility").mockRejectedValueOnce(
        Error("visibility failed"),
      );
    if (effect === "activity")
      vi.spyOn(activity, "append").mockRejectedValueOnce(
        Error("activity failed"),
      );
    if (effect === "search")
      vi.spyOn(search, "upsert").mockRejectedValueOnce(Error("search failed"));
    await failure(await change(f, true, f.record.rowVersion + 1), 500);
    expect(await state(f)).toEqual(before);
  });

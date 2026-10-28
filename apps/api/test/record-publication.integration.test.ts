import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
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
import {
  schemaRegistry,
  type PublishedRecord,
  type PublishedRecordContent,
} from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
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
import { TimeCursorService } from "../src/cursors/time-cursor.js";
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
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
} from "./database.helpers.js";
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
      new PostgresFeatureQueryPort(),
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
    new PostgresFeatureReadPort(),
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
    controllers: [PublishedRecordsController],
    providers: [
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
  feature = false,
) {
  const userId = await createUser(db.sql),
    p = await createProject(db.sql, userId),
    creator = await createUser(db.sql);
  await db.sql`INSERT INTO app.project_members(project_id,user_id) VALUES(${p.projectId},${creator})`;
  const [f] = await db.sql<
    { id: number }[]
  >`INSERT INTO app.features(project_id,module_id,code,name,created_by) VALUES(${p.projectId},${p.moduleId},${p.code + "-F-1"},'关联功能',${creator}) RETURNING id`;
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      {
        ...p,
        featureId: feature ? f!.id : null,
        impactFeatureIds: feature ? [] : [f!.id],
      },
      userId,
      { ...content, remainingIssues: [...remainingIssues] },
    ),
  );
  return { ...p, userId, creator, featureId: f!.id, draft };
}
const publish = (f: Awaited<ReturnType<typeof fixture>>) =>
  uow.run((tx) =>
    service.publish(tx, f.userId, f.projectId, f.draft.id, 1, randomUUID()),
  );
/**
 * 修订：未提供的遗留项条目保持已发布内容，显式提供的数组按 id / 新条目处理。
 * 与真实客户端行为一致，调用方可直接复用上一条目的 id 完成追加、修改或移除。
 */
const edit = (
  f: Awaited<ReturnType<typeof fixture>>,
  current: PublishedRecord,
  input: Partial<PublishedRecordContent>,
) =>
  uow.run((tx) =>
    service.update(
      tx,
      f.userId,
      f.projectId,
      current.id,
      current.rowVersion,
      current.currentVersion,
      {
        ...content,
        remainingIssues: current.remainingIssues.map((entry) => ({
          id: entry.id!,
          content: entry.content,
        })),
        ...input,
        confirmLeftoverResolved: input.confirmLeftoverResolved ?? false,
      },
      randomUUID(),
    ),
  );
async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await uow.run((tx) =>
      new RecordDraftRepository().find(tx, f.projectId, f.draft.id),
    ),
  ).toEqual(f.draft);
  for (const table of [
    "change_record_versions",
    "change_record_leftover_items",
    "activity_projection",
    "search_projection",
    "notifications",
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
  f: Awaited<ReturnType<typeof fixture>>,
  actor: Awaited<ReturnType<typeof session>>,
  publish: boolean,
  body: unknown = {},
  rowVersion = 1,
  currentVersion = 1,
  idempotencyKey = randomUUID(),
) {
  return fetch(
    `${base}/api/v1/projects/${f.projectId}/change-records/${f.draft.id}/${publish ? "publish" : "versions"}`,
    {
      method: "POST",
      headers: {
        origin: base,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        "If-Match": `"${rowVersion}"`,
        "X-Record-Version": String(currentVersion),
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}
/** 详情页快捷追加：单独路由，但 CSRF、If-Match、X-Record-Version 与幂等键完全一致。 */
async function append(
  f: Awaited<ReturnType<typeof fixture>>,
  actor: Awaited<ReturnType<typeof session>>,
  body: unknown,
  rowVersion: number,
  currentVersion: number,
  idempotencyKey = randomUUID(),
) {
  return fetch(
    `${base}/api/v1/projects/${f.projectId}/change-records/${f.draft.id}/leftovers`,
    {
      method: "POST",
      headers: {
        origin: base,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        "If-Match": `"${rowVersion}"`,
        "X-Record-Version": String(currentVersion),
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
}
async function failure(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status);
  const e = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  expect(response.headers.get("x-request-id")).toBe(e.requestId);
  expect(JSON.stringify(e)).not.toMatch(
    /SELECT |INSERT INTO|constraint_name|stack/,
  );
}
describe("F18 publication and immutable revisions", () => {
  it("publishes multiple leftovers, appends one more, then resolves and reactivates by stable ID", async () => {
    const f = await fixture(),
      v1 = await publish(f),
      first = v1.leftovers[0]!;
    expect(v1).toMatchObject({
      status: "PUBLISHED",
      code: f.code + "-CR-1",
      currentVersion: 1,
      rowVersion: 2,
      leftovers: [
        {
          id: first.id,
          content: "仍需跟进",
          status: "ACTIVE",
          linkedTaskId: null,
        },
      ],
    });
    // 保留原条目并新增一条：两条各自拿到稳定 id，无需重写已有内容
    const v2 = await edit(f, v1, {
      remainingIssues: [
        { id: first.id, content: "修订遗留文字" },
        { content: "新发现的遗留" },
      ],
    });
    expect(v2).toMatchObject({ currentVersion: 2 });
    expect(v2.leftovers.map((leftover) => leftover.id)).toContain(first.id);
    const second = v2.leftovers.find((leftover) => leftover.id !== first.id)!;
    expect(
      v2.leftovers.map((leftover) => [
        leftover.status,
        leftover.content,
        leftover.linkedTaskId,
      ]),
    ).toEqual([
      ["ACTIVE", "修订遗留文字", null],
      ["ACTIVE", "新发现的遗留", null],
    ]);
    // 带未知条目 id 的提交按冲突拒绝，防止串用其它记录或历史版本的条目
    await expect(
      edit(f, v2, {
        remainingIssues: [
          { id: first.id, content: "修订遗留文字" },
          { id: 2147483647, content: "不属于本记录" },
        ],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "RECORD_LEFTOVER_CONFLICT",
    });
    // 移除未闭环条目必须先明确确认已解决
    await expect(
      edit(f, v2, {
        remainingIssues: [{ id: first.id, content: "修订遗留文字" }],
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "LEFTOVER_RESOLUTION_CONFIRMATION_REQUIRED",
    });
    const v3 = await edit(f, v2, {
      remainingIssues: [{ id: first.id, content: "修订遗留文字" }],
      confirmLeftoverResolved: true,
    });
    expect(
      v3.leftovers.map((leftover) => [leftover.id, leftover.status]),
    ).toEqual([[first.id, "ACTIVE"]]);
    expect(
      await db.sql`SELECT id,status FROM app.change_record_leftover_items WHERE record_id=${v1.id} ORDER BY id`,
    ).toEqual([
      { id: first.id, status: "ACTIVE" },
      { id: second.id, status: "RESOLVED" },
    ]);
    const v4 = await edit(f, v3, {
      remainingIssues: [
        { id: first.id, content: "修订遗留文字" },
        { id: second.id, content: "重新说明同一问题" },
      ],
    });
    expect(v4).toMatchObject({
      currentVersion: 4,
      publishedAt: v1.publishedAt,
    });
    expect(
      v4.leftovers.map((leftover) => [
        leftover.id,
        leftover.status,
        leftover.content,
      ]),
    ).toEqual([
      [first.id, "ACTIVE", "修订遗留文字"],
      [second.id, "ACTIVE", "重新说明同一问题"],
    ]);
    expect(
      await db.sql`SELECT version_no,leftover_item_id,content_snapshot FROM app.change_record_version_leftovers WHERE record_id=${v1.id} ORDER BY version_no,leftover_item_id`,
    ).toEqual([
      {
        version_no: 1,
        leftover_item_id: first.id,
        content_snapshot: "仍需跟进",
      },
      {
        version_no: 2,
        leftover_item_id: first.id,
        content_snapshot: "修订遗留文字",
      },
      {
        version_no: 2,
        leftover_item_id: second.id,
        content_snapshot: "新发现的遗留",
      },
      {
        version_no: 3,
        leftover_item_id: first.id,
        content_snapshot: "修订遗留文字",
      },
      {
        version_no: 4,
        leftover_item_id: first.id,
        content_snapshot: "修订遗留文字",
      },
      {
        version_no: 4,
        leftover_item_id: second.id,
        content_snapshot: "重新说明同一问题",
      },
    ]);
    expect(
      await db.sql`SELECT 1 FROM app.change_record_leftover_items WHERE record_id=${v1.id}`,
    ).toHaveLength(2);
    expect(
      await db.sql`SELECT entity_type,title,summary,visibility_scope,source_status FROM app.search_projection WHERE project_id=${f.projectId} AND entity_type='LEFTOVER' ORDER BY entity_id`,
    ).toEqual([
      {
        entity_type: "LEFTOVER",
        title: "修订遗留文字",
        summary: `待处理 · ${v1.code} ${v1.title}`,
        visibility_scope: "MEMBER",
        source_status: "ACTIVE",
      },
      {
        entity_type: "LEFTOVER",
        title: "重新说明同一问题",
        summary: `待处理 · ${v1.code} ${v1.title}`,
        visibility_scope: "MEMBER",
        source_status: "ACTIVE",
      },
    ]);
  });
  it("retains CONVERTED identity and its task link through clearing and refilling", async () => {
    const f = await fixture(),
      v1 = await publish(f),
      id = v1.leftovers[0]!.id;
    const task = await uow.run(async (tx) => {
      const t = await new TaskManagementRepository().create(
        tx,
        { ...f, featureId: null },
        f.userId,
        f.code + "-T-1",
        {
          title: "既有跟进任务",
          description: "fixture",
          assigneeIds: [f.userId],
          priority: "NORMAL",
          dueAt: null,
        },
      );
      await tx.sql`INSERT INTO app.leftover_task_links(leftover_item_id,task_id,project_id,created_by) VALUES(${id},${t.id},${f.projectId},${f.userId})`;
      await tx.sql`UPDATE app.change_record_leftover_items SET status='CONVERTED',row_version=row_version+1 WHERE id=${id}`;
      return t;
    });
    // 已转任务条目未提交也自动保留，且不需要解决确认
    const v2 = await edit(f, v1, { remainingIssues: [] });
    expect(
      v2.leftovers.map((leftover) => [
        leftover.id,
        leftover.status,
        leftover.linkedTaskId,
      ]),
    ).toEqual([[id, "CONVERTED", task.id]]);
    const v3 = await edit(f, v2, {
      remainingIssues: [{ id, content: "澄清同一问题" }],
    });
    expect(
      v3.leftovers.map((leftover) => [
        leftover.id,
        leftover.status,
        leftover.linkedTaskId,
        leftover.content,
      ]),
    ).toEqual([[id, "CONVERTED", task.id, "澄清同一问题"]]);
    expect(
      await db.sql`SELECT 1 FROM app.leftover_task_links WHERE leftover_item_id=${id}`,
    ).toHaveLength(1);
    expect(
      await db.sql`SELECT 1 FROM app.change_record_leftover_items WHERE record_id=${v1.id}`,
    ).toHaveLength(1);
    expect(
      await db.sql`SELECT content_snapshot FROM app.change_record_version_leftovers WHERE record_id=${v1.id} AND version_no=1`,
    ).toEqual([{ content_snapshot: "仍需跟进" }]);
    expect(
      await db.sql`SELECT source_status,title FROM app.search_projection WHERE project_id=${f.projectId} AND entity_type='LEFTOVER'`,
    ).toEqual([{ source_status: "CONVERTED", title: "澄清同一问题" }]);
  });
  it.each(["audit", "activity", "search", "notification"] as const)(
    "rolls back record, v1, stable item, code and all side effects when %s fails",
    async (kind) => {
      const f = await fixture();
      if (kind === "audit")
        vi.spyOn(audit, "append").mockRejectedValueOnce(Error("forced"));
      if (kind === "activity")
        vi.spyOn(activity, "append").mockRejectedValueOnce(Error("forced"));
      if (kind === "search")
        vi.spyOn(search, "upsert").mockRejectedValueOnce(Error("forced"));
      if (kind === "notification")
        vi.spyOn(notifications, "write").mockRejectedValueOnce(Error("forced"));
      await expect(publish(f)).rejects.toThrow("forced");
      await clean(f);
    },
  );
  it("rejects oversize leftovers and full search overflows without truncating published content or consuming codes", async () => {
    // 超长遗留问题由写入校验拒绝：已发布内容、版本与编码都不受影响。
    const f = await fixture();
    const v1 = await publish(f);
    const codes =
      await db.sql`SELECT project_id FROM app.code_sequences WHERE project_id=${f.projectId} AND entity_type='CHANGE_RECORD'`;
    await expect(
      edit(f, v1, {
        remainingIssues: [{ content: "长".repeat(10001) }],
        confirmLeftoverResolved: false,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      await db.sql`SELECT current_payload->'remainingIssues' AS issues, current_version, row_version FROM app.change_records WHERE id=${f.draft.id}`,
    ).toEqual([
      {
        issues: [
          {
            id: v1.leftovers[0]!.id,
            content: content.remainingIssues[0]!.content,
          },
        ],
        current_version: 1,
        row_version: v1.rowVersion,
      },
    ]);
    expect(
      await db.sql`SELECT version_no FROM app.change_record_versions WHERE record_id=${f.draft.id} ORDER BY version_no`,
    ).toEqual([{ version_no: 1 }]);
    expect(
      await db.sql`SELECT project_id FROM app.code_sequences WHERE project_id=${f.projectId} AND entity_type='CHANGE_RECORD'`,
    ).toEqual(codes);
    const g = await fixture([]);
    await uow.run((tx) =>
      new RecordDraftRepository().update(tx, g.draft, {
        ...content,
        contextProblem: "中".repeat(50000),
        changeSolution: "文".repeat(50000),
        remainingIssues: [],
      }),
    );
    await expect(
      uow.run((tx) =>
        service.publish(tx, g.userId, g.projectId, g.draft.id, 2, randomUUID()),
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "RECORD_SEARCH_CAPACITY_EXCEEDED",
    });
    expect(
      await db.sql`SELECT 1 FROM app.code_sequences WHERE project_id=${g.projectId} AND entity_type='CHANGE_RECORD'`,
    ).toHaveLength(0);
    expect(
      await db.sql`SELECT length(current_payload->>'contextProblem') AS size FROM app.change_records WHERE id=${g.draft.id}`,
    ).toEqual([{ size: 50000 }]);
    expect(await db.sql`SELECT length(${"😀".repeat(3)}) AS size`).toEqual([
      { size: 3 },
    ]);
  });
  it("allows only one concurrent publish and one concurrent revision for the same expected versions", async () => {
    const f = await fixture();
    const first = await Promise.allSettled([publish(f), publish(f)]);
    expect(first.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const v1 = (
      first.find(
        (x) => x.status === "fulfilled",
      ) as PromiseFulfilledResult<PublishedRecord>
    ).value;
    const next = await Promise.allSettled([
      edit(f, v1, { title: "甲" }),
      edit(f, v1, { title: "乙" }),
    ]);
    expect(next.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(next.find((x) => x.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    expect(
      await db.sql`SELECT version_no FROM app.change_record_versions WHERE record_id=${v1.id} ORDER BY version_no`,
    ).toEqual([{ version_no: 1 }, { version_no: 2 }]);
  });
  it("deduplicates publication recipients, excludes revoked feature creators, and uses only the author for independent revisions", async () => {
    const f = await fixture([], true);
    await removeMember(db.sql, f.projectId, f.creator);
    const v1 = await publish(f);
    expect(
      await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId}`,
    ).toEqual([{ recipient_id: f.userId }]);
    const g = await fixture([], true),
      g1 = await publish(g);
    expect(
      await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${g.projectId} ORDER BY recipient_id`,
    ).toEqual(
      [g.userId, g.creator]
        .sort((a, b) => a - b)
        .map((recipient_id) => ({ recipient_id })),
    );
    await edit(g, g1, { title: "修订", remainingIssues: [] });
    expect(
      await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${g.projectId} AND notification_type='record.version.create'`,
    ).toEqual([{ recipient_id: g.userId }]);
    expect(v1.leftovers).toEqual([]);
  });
  it("uses real HTTP contract, CSRF, idempotency, two version headers and current replay authorization", async () => {
    const f = await fixture([], true),
      actor = await session(f.userId),
      key = randomUUID();
    const response = await post(f, actor, true, {}, 1, 1, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const v1 = schemaRegistry.PublishedRecord.schema.parse(
      await response.json(),
    );
    expect(await (await post(f, actor, true, {}, 1, 1, key)).json()).toEqual(
      v1,
    );
    await failure(await post(f, actor, true, { status: "PUBLISHED" }), 422);
    await failure(await post(f, { ...actor, csrf: "a".repeat(43) }, true), 401);
    await failure(await post(f, actor, true), 409);
    const appended = await append(
      f,
      actor,
      { content: "快捷追加的遗留问题" },
      v1.rowVersion,
      v1.currentVersion,
    );
    expect(appended.status, await appended.clone().text()).toBe(200);
    const v2 = schemaRegistry.PublishedRecord.schema.parse(
      await appended.json(),
    );
    expect(v2).toMatchObject({ currentVersion: 2, code: v1.code });
    expect(
      v2.leftovers.map((leftover) => [
        leftover.status,
        leftover.content,
        leftover.linkedTaskId,
      ]),
    ).toEqual([["ACTIVE", "快捷追加的遗留问题", null]]);
    await failure(
      await append(
        f,
        actor,
        { content: "  " },
        v2.rowVersion,
        v2.currentVersion,
      ),
      422,
    );
    const body = {
        ...content,
        title: "HTTP新版本",
        remainingIssues: [
          { id: v2.leftovers[0]!.id, content: "快捷追加的遗留问题" },
          { content: "修订时新增的遗留问题" },
        ],
        confirmLeftoverResolved: false,
      },
      editKey = randomUUID();
    const update = await post(f, actor, false, body, v2.rowVersion, 2, editKey);
    expect(update.status, await update.clone().text()).toBe(200);
    const v3 = schemaRegistry.PublishedRecord.schema.parse(await update.json());
    expect(v3.leftovers.map((leftover) => leftover.content)).toEqual([
      "快捷追加的遗留问题",
      "修订时新增的遗留问题",
    ]);
    expect(
      await (
        await post(f, actor, false, body, v2.rowVersion, 2, editKey)
      ).json(),
    ).toEqual(v3);
    await failure(
      await post(f, actor, false, body, v2.rowVersion, 3, editKey),
      409,
    );
    await failure(
      await post(f, actor, false, { ...body, taskId: 5 }, v3.rowVersion, 3),
      422,
    );
    await failure(
      await post(
        f,
        actor,
        false,
        {
          ...body,
          remainingIssues: [{ id: 2147483000, content: "不属于本记录" }],
        },
        v3.rowVersion,
        3,
      ),
      409,
    );
    await removeMember(db.sql, f.projectId, f.userId);
    await failure(await post(f, actor, true, {}, 1, 1, key), 404);
    await failure(
      await post(f, actor, false, body, v2.rowVersion, 2, editKey),
      404,
    );
    await failure(
      await append(
        f,
        actor,
        { content: "追加" },
        v1.rowVersion,
        v1.currentVersion,
      ),
      404,
    );
  });
});
it("publishes a DONE source, uses its current assignee, and replays/revises history after later reopening", async () => {
  const f = await fixture([], true),
    tasks = new TaskManagementRepository(),
    current = await createUser(db.sql);
  await db.sql`INSERT INTO app.project_members(project_id,user_id) VALUES(${f.projectId},${current})`;
  const task = await uow.run(async (tx) => {
    const t = await tasks.create(
      tx,
      { ...f, featureId: f.featureId },
      f.userId,
      f.code + "-T-1",
      {
        title: "已完成来源",
        description: "",
        assigneeIds: [f.creator],
        priority: "NORMAL",
        dueAt: null,
      },
    );
    return (await tasks.transition(tx, t, f.userId, "DONE", "测试验证", null))!;
  });
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      { ...f, featureId: f.featureId, impactFeatureIds: [] },
      f.userId,
      { ...content, remainingIssues: [] },
      { taskId: task.id, handlerId: f.creator },
    ),
  );
  const changed = await uow.run((tx) =>
    tasks.update(tx, task, {
      title: task.title,
      description: task.description,
      assigneeIds: [current],
      priority: task.priority,
      dueAt: task.dueAt,
    }),
  );
  await removeMember(db.sql, f.projectId, f.creator);
  const source = { ...f, draft },
    actor = await session(f.userId),
    key = randomUUID(),
    response = await post(source, actor, true, {}, 1, 1, key);
  expect(response.status, await response.clone().text()).toBe(200);
  const v1 = schemaRegistry.PublishedRecord.schema.parse(await response.json());
  expect(v1).toMatchObject({
    taskId: task.id,
    handlerId: f.creator,
    authorId: f.userId,
  });
  expect(
    await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} ORDER BY recipient_id`,
  ).toEqual(
    [f.userId, current]
      .sort((a, b) => a - b)
      .map((recipient_id) => ({ recipient_id })),
  );
  await uow.run((tx) =>
    tasks.transition(tx, changed!, f.userId, "TODO", null, "后来重开"),
  );
  expect(await (await post(source, actor, true, {}, 1, 1, key)).json()).toEqual(
    v1,
  );
  await edit(source, v1, { title: "重开后仍可补充历史", remainingIssues: [] });
  expect(
    await db.sql`SELECT recipient_id FROM app.notifications WHERE project_id=${f.projectId} AND notification_type='record.version.create' ORDER BY recipient_id`,
  ).toEqual(
    [f.userId, current]
      .sort((a, b) => a - b)
      .map((recipient_id) => ({ recipient_id })),
  );
  expect(
    await db.sql`SELECT work_status FROM app.tasks WHERE id=${task.id}`,
  ).toEqual([{ work_status: "TODO" }]);
});
it("publishes an unfinished source without touching its task state or history", async () => {
  const f = await fixture([], true),
    tasks = new TaskManagementRepository();
  const task = await uow.run((tx) =>
    tasks.create(
      tx,
      { ...f, featureId: f.featureId },
      f.userId,
      f.code + "-T-1",
      {
        title: "未完成来源",
        description: "",
        assigneeIds: [f.creator],
        priority: "NORMAL",
        dueAt: null,
      },
    ),
  );
  const draft = await uow.run((tx) =>
    new RecordDraftRepository().create(
      tx,
      { ...f, featureId: f.featureId, impactFeatureIds: [] },
      f.userId,
      { ...content, remainingIssues: [] },
      { taskId: task.id, handlerId: f.creator },
    ),
  );
  const before = (await db.sql`SELECT * FROM app.tasks WHERE id=${task.id}`)[0];
  const source = { ...f, draft },
    actor = await session(f.userId),
    key = randomUUID(),
    response = await post(source, actor, true, {}, 1, 1, key);
  expect(response.status, await response.clone().text()).toBe(200);
  const v1 = schemaRegistry.PublishedRecord.schema.parse(await response.json());
  expect(v1).toMatchObject({
    taskId: task.id,
    handlerId: f.creator,
    authorId: f.userId,
  });
  // ADR-047：迭代记录只描述本次迭代，发布不改变来源任务的状态、完成信息与历史。
  expect(
    (await db.sql`SELECT * FROM app.tasks WHERE id=${task.id}`)[0],
  ).toEqual(before);
  expect(
    await db.sql`SELECT 1 FROM app.task_status_history WHERE task_id=${task.id}`,
  ).toHaveLength(1);
  // 幂等重放仍返回同一条 v1：口径不因来源任务未完成而改变。
  expect(await (await post(source, actor, true, {}, 1, 1, key)).json()).toEqual(
    v1,
  );
});
it("rolls back a failed revision and rejects publication after an actual parent-archive lock wait", async () => {
  const f = await fixture(),
    v1 = await publish(f);
  vi.spyOn(search, "upsert").mockRejectedValueOnce(
    Error("revision search failure"),
  );
  await expect(
    edit(f, v1, {
      title: "不应保留",
      remainingIssues: [],
      confirmLeftoverResolved: true,
    }),
  ).rejects.toThrow("revision search failure");
  expect(
    await uow.run((tx) =>
      new PublishedRecordRepository().find(tx, f.projectId, v1.id),
    ),
  ).toEqual(v1);
  expect(
    await db.sql`SELECT 1 FROM app.change_record_versions WHERE record_id=${v1.id}`,
  ).toHaveLength(1);
});

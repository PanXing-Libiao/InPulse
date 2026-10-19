import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { TaskGroupsService } from "../src/modules/task-groups/task-groups.service.js";
import { TaskGroupRepository } from "../src/modules/task-groups/task-group.repository.js";
import { ExternalLinkController } from "../src/workflows/external-link.controller.js";
import { ExternalLinkHttpService } from "../src/workflows/external-link-http.service.js";
import { ExternalLinkWorkflow } from "../src/workflows/external-link.workflow.js";
import {
  ProjectLinkQueryPort,
  ProjectLinkCommandPort,
} from "../src/modules/projects/external-link-target.port.js";
import {
  FeatureLinkQueryPort,
  FeatureLinkCommandPort,
} from "../src/modules/features/external-link-target.port.js";
import {
  TaskLinkQueryPort,
  TaskLinkCommandPort,
} from "../src/modules/tasks/external-link-target.port.js";
import {
  RecordLinkQueryPort,
  RecordLinkCommandPort,
} from "../src/modules/change-records/external-link-target.port.js";
import { ExternalLinksRepository } from "../src/modules/external-links/external-links.repository.js";
import {
  ExternalLinksQueryPort,
  ExternalLinksCommandPort,
} from "../src/modules/external-links/external-links.port.js";
import { ExternalLinkSearchPort } from "../src/modules/search/external-link-search.port.js";
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
import { schemaRegistry, routeRegistry } from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
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
    );
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  activity = new PostgresActivityWritePort();
  search = new PostgresSearchProjectionWritePort();
  notifications = new PostgresNotificationWritePort();
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
      notifications,
      access,
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
    controllers: [
      PublishedRecordsController,
      RecordLifecycleController,
      ExternalLinkController,
    ],
    providers: [
      {
        provide: ExternalLinkHttpService,
        useValue: new ExternalLinkHttpService(
          auth,
          mutation,
          idempotency,
          uow,
          new ExternalLinkWorkflow(
            access,
            new PostgresModuleQueryPort(),
            new PostgresFeatureQueryPort(),
            new ProjectLinkQueryPort(),
            new FeatureLinkQueryPort(),
            new TaskLinkQueryPort(),
            new RecordLinkQueryPort(),
            new ProjectLinkCommandPort(),
            new FeatureLinkCommandPort(),
            new TaskLinkCommandPort(),
            new RecordLinkCommandPort(),
            new ExternalLinksQueryPort(new ExternalLinksRepository()),
            new ExternalLinksCommandPort(new ExternalLinksRepository()),
            audit,
            activity,
            new ExternalLinkSearchPort(search),
          ),
        ),
      },
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
            new PostgresFeatureQueryPort(),
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
            new PostgresUserReadPort(),
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

async function lifecycleFixture(feature = false) {
  const f = await fixture(content.remainingIssues, feature);
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

type Actor = Awaited<ReturnType<typeof session>>;
async function linkRequest(
  type: string,
  id: number,
  actor: Actor,
  version = 1,
  url = "https://github.com/inpulse/core/pull/245",
  linkId?: number,
  key = randomUUID(),
  isRootRepository?: boolean,
) {
  return fetch(
    `${base}/api/v1/external-links/${type}/${id}${linkId ? "/" + linkId : ""}`,
    {
      method: linkId ? "DELETE" : "POST",
      headers: {
        origin: base,
        "sec-fetch-site": "same-origin",
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        "If-Match": `"${version}"`,
        "Idempotency-Key": key,
        ...(linkId ? {} : { "content-type": "application/json" }),
      },
      ...(linkId
        ? {}
        : {
            body: JSON.stringify({
              url,
              ...(isRootRepository === undefined ? {} : { isRootRepository }),
            }),
          }),
    },
  );
}
async function listLinks(type: string, id: number, actor?: Actor) {
  return fetch(`${base}/api/v1/external-links/${type}/${id}`, {
    headers: actor ? { cookie: actor.cookie } : {},
  });
}
async function taskFixture(f: Awaited<ReturnType<typeof fixture>>, number = 1) {
  const task = await uow.run((tx) =>
    new TaskManagementRepository().create(
      tx,
      { projectId: f.projectId, moduleId: f.moduleId, featureId: f.featureId },
      f.userId,
      f.code + "-T-" + number,
      {
        title: "链接任务",
        description: "",
        assigneeIds: [f.userId],
        priority: "NORMAL",
        dueAt: null,
      },
    ),
  );
  return task.id;
}
describe("F22 typed external links", () => {
  it("显式选择根仓库、切换已有链接并保留其他关联", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    const one = await linkRequest(
      "PROJECT",
      f.projectId,
      actor,
      1,
      "https://github.com/inpulse/one",
      undefined,
      randomUUID(),
      true,
    );
    expect(one.status, await one.clone().text()).toBe(200);
    const first = schemaRegistry.ExternalLinkResult.schema.parse(
      await one.json(),
    );
    const two = await linkRequest(
      "PROJECT",
      f.projectId,
      actor,
      2,
      "https://github.com/inpulse/two",
    );
    expect(two.status).toBe(200);
    const second = schemaRegistry.ExternalLinkResult.schema.parse(
      await two.json(),
    );
    const switchRoot = await linkRequest(
      "PROJECT",
      f.projectId,
      actor,
      3,
      "https://github.com/inpulse/two",
      undefined,
      randomUUID(),
      true,
    );
    expect(switchRoot.status, await switchRoot.clone().text()).toBe(200);
    const links = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(links.items).toHaveLength(2);
    expect(
      links.items
        .filter((link) => link.isRootRepository)
        .map((link) => link.id),
    ).toEqual([second.linkId]);
    const events =
      await auditDb.sql`SELECT event_payload FROM app.audit_logs WHERE project_id=${f.projectId} ORDER BY sequence_no DESC LIMIT 1`;
    expect(events[0]?.event_payload).toMatchObject({
      previousRootLinkId: first.linkId,
      rootLinkId: second.linkId,
    });
    const stale = await linkRequest(
      "PROJECT",
      f.projectId,
      actor,
      3,
      "https://github.com/inpulse/one",
      undefined,
      randomUUID(),
      true,
    );
    await failure(stale, 409);
  });
  it("根仓库拒绝子路径、非项目目标和外部项目访问", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    await failure(
      await linkRequest(
        "PROJECT",
        f.projectId,
        actor,
        1,
        "https://github.com/inpulse/core/pull/1",
        undefined,
        randomUUID(),
        true,
      ),
      422,
    );
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        1,
        "https://github.com/inpulse/core",
        undefined,
        randomUUID(),
        true,
      ),
      422,
    );
    await failure(
      await linkRequest(
        "PROJECT",
        f.projectId,
        await session(await createUser(db.sql)),
        1,
        "https://github.com/inpulse/core",
        undefined,
        randomUUID(),
        true,
      ),
      404,
    );
    expect(
      await db.sql`SELECT link_id FROM app.project_external_links WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  });

  it("粘贴裸 commit SHA 时用项目根仓库补全为 commit 链接", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      sha = "408ade2023dbdcaae8fe7bfed7bdf2d759d71695";
    const taskId = await taskFixture(f);
    const withoutRoot = await linkRequest("TASK", taskId, actor, 1, sha);
    expect(withoutRoot.status, await withoutRoot.clone().text()).toBe(422);
    const missingRoot = schemaRegistry.ErrorResponse.schema.parse(
      await withoutRoot.json(),
    );
    expect(missingRoot.code).toBe("EXTERNAL_LINK_SHA_REQUIRES_ROOT_REPOSITORY");
    expect(missingRoot.message).toContain("项目根仓库");
    expect(
      await db.sql`SELECT id FROM app.external_links WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
    const root = await linkRequest(
      "PROJECT",
      f.projectId,
      actor,
      1,
      "https://github.com/256-code/InPulse",
      undefined,
      randomUUID(),
      true,
    );
    expect(root.status, await root.clone().text()).toBe(200);
    const upper = await linkRequest(
      "TASK",
      taskId,
      actor,
      1,
      sha.toUpperCase(),
    );
    expect(upper.status, await upper.clone().text()).toBe(200);
    const short = await linkRequest("TASK", taskId, actor, 2, "408ade2");
    expect(short.status, await short.clone().text()).toBe(200);
    const links = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("TASK", taskId, actor)).json(),
    );
    expect(links.items).toMatchObject([
      {
        kind: "COMMIT",
        repository: "256-code/InPulse",
        externalSha: sha,
        normalizedUrl: "https://github.com/256-code/InPulse/commit/" + sha,
      },
      {
        kind: "COMMIT",
        repository: "256-code/InPulse",
        externalSha: "408ade2",
        normalizedUrl: "https://github.com/256-code/InPulse/commit/408ade2",
      },
    ]);
    const stored = await db.sql<
      { normalized_url: string; kind: string; external_sha: string }[]
    >`SELECT normalized_url,kind,external_sha FROM app.external_links WHERE project_id=${f.projectId} ORDER BY id`;
    expect(stored).toMatchObject([
      {
        normalized_url: "https://github.com/256-code/InPulse",
        kind: "OTHER",
      },
      {
        normalized_url: "https://github.com/256-code/InPulse/commit/" + sha,
        kind: "COMMIT",
        external_sha: sha,
      },
      {
        normalized_url: "https://github.com/256-code/InPulse/commit/408ade2",
        kind: "COMMIT",
        external_sha: "408ade2",
      },
    ]);
    const notSha = await linkRequest("TASK", taskId, actor, 3, "not-a-commit");
    expect(notSha.status, await notSha.clone().text()).toBe(422);
    expect(
      schemaRegistry.ErrorResponse.schema.parse(await notSha.json()).code,
    ).toBe("EXTERNAL_LINK_INVALID_URL");
  });

  it.each(["PROJECT", "FEATURE", "TASK", "CHANGE_RECORD"])(
    "%s lists/adds/removes and preserves link entity plus audit",
    async (type) => {
      const f = await fixture(),
        actor = await session(f.userId);
      const id =
        type === "PROJECT"
          ? f.projectId
          : type === "FEATURE"
            ? f.featureId
            : type === "TASK"
              ? await taskFixture(f)
              : f.draft.id;
      const before = await listLinks(type, id, actor);
      expect(before.status).toBe(200);
      const added = await linkRequest(type, id, actor);
      expect(added.status, await added.clone().text()).toBe(200);
      const result = schemaRegistry.ExternalLinkResult.schema.parse(
        await added.json(),
      );
      expect(result.rowVersion).toBe(2);
      const links = schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks(type, id, actor)).json(),
      );
      expect(links.items).toHaveLength(1);
      expect(links.items[0]).toMatchObject({
        kind: "PULL_REQUEST",
        label: "PR #245",
      });
      const key = randomUUID();
      const removed = await linkRequest(
        type,
        id,
        actor,
        2,
        "",
        result.linkId,
        key,
      );
      expect(removed.status, await removed.clone().text()).toBe(200);
      const replay = await linkRequest(
        type,
        id,
        actor,
        2,
        "",
        result.linkId,
        key,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(await removed.json());
      expect(
        schemaRegistry.ExternalLinkList.schema.parse(
          await (await listLinks(type, id, actor)).json(),
        ).items,
      ).toHaveLength(0);
      expect(
        await db.sql`SELECT id FROM app.external_links WHERE id=${result.linkId}`,
      ).toHaveLength(1);
      const logs =
        await auditDb.sql`SELECT action,event_payload FROM app.audit_logs WHERE project_id=${f.projectId} AND action IN ('EXTERNAL_LINK_ADDED','EXTERNAL_LINK_REMOVED') ORDER BY sequence_no`;
      expect(logs).toHaveLength(2);
      expect(logs.map((row) => row.action)).toEqual(
        ["addExternalLink", "removeExternalLink"].map(
          (operationId) =>
            routeRegistry.find((route) => route.operationId === operationId)!
              .auditAction,
        ),
      );
      expect(JSON.stringify(logs)).toContain(
        "https://github.com/inpulse/core/pull/245",
      );
    },
  );
  it("项目面板聚合任务、功能与已发布记录的关联并标注来源", async () => {
    const f = await fixture(),
      g = await fixture(),
      actor = await session(f.userId),
      other = await session(g.userId),
      taskId = await taskFixture(f);
    for (const response of [
      await linkRequest(
        "PROJECT",
        f.projectId,
        actor,
        1,
        "https://github.com/inpulse/core",
        undefined,
        randomUUID(),
        true,
      ),
      await linkRequest(
        "TASK",
        taskId,
        actor,
        1,
        "https://github.com/inpulse/core/commit/408ade2023dbdcaa8fe7bfed7bdf2d759d71695",
      ),
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        1,
        "https://github.com/inpulse/core/issues/7",
      ),
    ])
      expect(response.status, await response.clone().text()).toBe(200);
    const published = await publish(f);
    const record = await linkRequest(
      "CHANGE_RECORD",
      published.id,
      actor,
      published.rowVersion,
      "https://github.com/inpulse/core/pull/245",
    );
    expect(record.status, await record.clone().text()).toBe(200);
    // 另一个项目的关联不得进入本项目面板。
    expect(
      (
        await linkRequest(
          "PROJECT",
          g.projectId,
          other,
          1,
          "https://github.com/other/secret",
          undefined,
          randomUUID(),
          true,
        )
      ).status,
    ).toBe(200);
    const links = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(links.items).toHaveLength(4);
    const root = links.items.filter((item) => item.isRootRepository);
    expect(root).toHaveLength(1);
    expect(root[0]).toMatchObject({
      label: "inpulse/core",
      sources: [
        {
          targetType: "PROJECT",
          targetId: f.projectId,
          title: "Project " + f.code,
        },
      ],
    });
    expect(links.items.find((item) => item.kind === "COMMIT")).toMatchObject({
      label: "Commit 408ade2023db",
      sources: [{ targetType: "TASK", targetId: taskId, title: "链接任务" }],
    });
    expect(links.items.find((item) => item.kind === "ISSUE")).toMatchObject({
      label: "Issue #7",
      sources: [
        { targetType: "FEATURE", targetId: f.featureId, title: "关联功能" },
      ],
    });
    expect(
      links.items.find((item) => item.kind === "PULL_REQUEST"),
    ).toMatchObject({
      label: "PR #245",
      sources: [
        {
          targetType: "CHANGE_RECORD",
          targetId: published.id,
          title: content.title,
        },
      ],
    });
    // 只有项目视图是聚合读，其他目标不返回 sources。
    const taskList = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("TASK", taskId, actor)).json(),
    );
    expect(taskList.items[0]?.sources).toBeUndefined();
    // 同一链接被任务与功能共同关联时合并成一行并列出全部来源。
    const shared = "https://github.com/inpulse/core/pull/900";
    for (const [type, id, version] of [
      ["TASK", taskId, 2],
      ["FEATURE", f.featureId, 2],
    ] as const)
      expect((await linkRequest(type, id, actor, version, shared)).status).toBe(
        200,
      );
    const merged = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(merged.items).toHaveLength(5);
    expect(
      merged.items.find((item) => item.normalizedUrl === shared)?.sources,
    ).toMatchObject([
      { targetType: "TASK", targetId: taskId },
      { targetType: "FEATURE", targetId: f.featureId },
    ]);
  });
  it("项目面板聚合只呈现已发布记录，草稿与已作废记录不出现", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      url = "https://github.com/inpulse/core/issues/11";
    const draftLink = await linkRequest(
      "CHANGE_RECORD",
      f.draft.id,
      actor,
      1,
      url,
    );
    expect(draftLink.status, await draftLink.clone().text()).toBe(200);
    const beforePublish = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(beforePublish.items).toHaveLength(0);
    // 关联写入了草稿行版本，发布用当前版本而不是固定 1。
    const [draftRow] = await db.sql<
      { row_version: number }[]
    >`SELECT row_version FROM app.change_records WHERE id=${f.draft.id}`;
    const published = await uow.run((tx) =>
      service.publish(
        tx,
        f.userId,
        f.projectId,
        f.draft.id,
        draftRow!.row_version,
        randomUUID(),
      ),
    );
    const afterPublish = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(afterPublish.items).toMatchObject([
      {
        normalizedUrl: url,
        sources: [{ targetType: "CHANGE_RECORD", targetId: published.id }],
      },
    ]);
    const adminId = await createUser(db.sql, { admin: true }),
      admin = await session(adminId);
    const voided = await change({ ...f, record: published, adminId, admin });
    expect(voided.status, await voided.clone().text()).toBe(200);
    const afterVoid = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(afterVoid.items).toHaveLength(0);
    // 作废只影响聚合呈现，关联关系本身保留。
    expect(
      await db.sql`SELECT link_id FROM app.change_record_external_links WHERE project_id=${f.projectId}`,
    ).toHaveLength(1);
  });
  it("项目面板聚合排除已取消与无效任务上的链接，恢复后重新出现", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      canceledTaskId = await taskFixture(f),
      invalidTaskId = await taskFixture(f, 2),
      canceledUrl = "https://github.com/inpulse/core/pull/901",
      invalidUrl = "https://github.com/inpulse/core/pull/902";
    for (const [taskId, url] of [
      [canceledTaskId, canceledUrl],
      [invalidTaskId, invalidUrl],
    ] as const)
      expect((await linkRequest("TASK", taskId, actor, 1, url)).status).toBe(
        200,
      );
    // 无效任务已无业务写入路径（ADR-054 删除了标记无效命令），按数据库状态构造。
    await db.sql`UPDATE app.tasks SET lifecycle_status='INVALID', row_version=row_version+1 WHERE id=${invalidTaskId}`;
    const tasks = new TaskManagementRepository(),
      scope = {
        projectId: f.projectId,
        moduleId: f.moduleId,
        featureId: f.featureId,
      },
      transition = (to: "CANCELED" | "TODO") =>
        uow.run(async (tx) => {
          const current = await tasks.find(tx, scope, canceledTaskId);
          await tasks.transition(tx, current!, f.userId, to, null, null);
        });
    // 已标记无效的任务不进聚合，未取消的任务仍在。
    const before = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("PROJECT", f.projectId, actor)).json(),
    );
    expect(before.items).toMatchObject([
      {
        normalizedUrl: canceledUrl,
        sources: [{ targetType: "TASK", targetId: canceledTaskId }],
      },
    ]);
    await transition("CANCELED");
    expect(
      schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks("PROJECT", f.projectId, actor)).json(),
      ).items,
    ).toHaveLength(0);
    // 取消只影响项目面板的聚合呈现：任务自身面板与关联行保留。
    expect(
      schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks("TASK", canceledTaskId, actor)).json(),
      ).items,
    ).toMatchObject([{ normalizedUrl: canceledUrl }]);
    expect(
      await db.sql`SELECT task_id FROM app.task_external_links WHERE project_id=${f.projectId}`,
    ).toHaveLength(2);
    // 恢复任务（CANCELED -> TODO）后重新出现在项目面板。
    await transition("TODO");
    expect(
      schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks("PROJECT", f.projectId, actor)).json(),
      ).items,
    ).toMatchObject([{ normalizedUrl: canceledUrl }]);
  });
  it("动态摘要写明关联的链接与目标任务，草稿链接不产生活动", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      taskId = await taskFixture(f);
    const added = await linkRequest("TASK", taskId, actor);
    expect(added.status, await added.clone().text()).toBe(200);
    const add = schemaRegistry.ExternalLinkResult.schema.parse(
      await added.json(),
    );
    const readLinkActivity = () =>
      db.sql<{ activity_type: string; summary: string }[]>`
        SELECT activity_type, summary FROM app.activity_projection
         WHERE project_id=${f.projectId} AND activity_type LIKE 'EXTERNAL_LINK%'
         ORDER BY id`;
    expect(await readLinkActivity()).toEqual([
      {
        activity_type: "EXTERNAL_LINK_ADDED",
        summary: `添加 GitHub 关联：PR #245（任务 ${f.code}-T-1「链接任务」）`,
      },
    ]);
    // 添加关联已把任务行版本推进到 2，解除必须带当前版本。
    const removed = await linkRequest(
      "TASK",
      taskId,
      actor,
      2,
      undefined,
      add.linkId,
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await readLinkActivity()).map((row) => row.summary)).toEqual([
      `添加 GitHub 关联：PR #245（任务 ${f.code}-T-1「链接任务」）`,
      `解除 GitHub 关联：PR #245（任务 ${f.code}-T-1「链接任务」）`,
    ]);
    // ADR-048：未发布草稿不产生活动；草稿上的链接只留审计与自身读取。
    const draftLink = await linkRequest(
      "CHANGE_RECORD",
      f.draft.id,
      actor,
      1,
      "https://github.com/inpulse/core/issues/11",
    );
    expect(draftLink.status, await draftLink.clone().text()).toBe(200);
    expect(
      await db.sql`SELECT id FROM app.activity_projection WHERE project_id=${f.projectId} AND source_entity_type='CHANGE_RECORD'`,
    ).toHaveLength(0);
    expect(
      schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks("CHANGE_RECORD", f.draft.id, actor)).json(),
      ).items,
    ).toHaveLength(1);
    expect(
      await auditDb.sql<
        { action: string }[]
      >`SELECT action FROM app.audit_logs WHERE project_id=${f.projectId} AND target_type='CHANGE_RECORD' AND target_id=${String(f.draft.id)} AND action LIKE 'EXTERNAL_LINK%'`,
    ).toEqual([{ action: "EXTERNAL_LINK_ADDED" }]);
  });
  it("same key concurrent replay and new-key duplicate are distinguished", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      key = randomUUID();
    const responses = await Promise.all([
      linkRequest("FEATURE", f.featureId, actor, 1, undefined, undefined, key),
      linkRequest("FEATURE", f.featureId, actor, 1, undefined, undefined, key),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    const duplicate = await linkRequest("FEATURE", f.featureId, actor, 2);
    await failure(duplicate.clone(), 409);
    expect(
      schemaRegistry.ErrorResponse.schema.parse(await duplicate.json()).code,
    ).toBe("EXTERNAL_LINK_ALREADY_ASSOCIATED");
  });
  it("same project URL shares entity across targets; different projects isolate", async () => {
    const f = await fixture(),
      g = await fixture(),
      a = await session(f.userId),
      b = await session(g.userId);
    const [one, two, three] = await Promise.all([
      linkRequest("FEATURE", f.featureId, a),
      linkRequest("CHANGE_RECORD", f.draft.id, a),
      linkRequest("FEATURE", g.featureId, b),
    ]);
    for (const r of [one, two, three])
      expect(r.status, await r.clone().text()).toBe(200);
    const x = schemaRegistry.ExternalLinkResult.schema.parse(await one.json()),
      y = schemaRegistry.ExternalLinkResult.schema.parse(await two.json()),
      z = schemaRegistry.ExternalLinkResult.schema.parse(await three.json());
    expect(x.linkId).toBe(y.linkId);
    expect(z.linkId).not.toBe(x.linkId);
    await failure(
      await linkRequest("FEATURE", f.featureId, a, 2, "", z.linkId),
      404,
    );
  });
  it("rejects unauthenticated/inaccessible targets and strict path kinds", async () => {
    const f = await fixture(),
      outsider = await session(await createUser(db.sql));
    await failure(await listLinks("FEATURE", f.featureId), 401);
    await failure(await listLinks("FEATURE", f.featureId, outsider), 404);
    await failure(await linkRequest("FEATURE", f.featureId, outsider), 404);
    await failure(await listLinks("MODULE", f.moduleId, outsider), 422);
  });
  it.each([
    "http://github.com/a/b",
    "https://github.com.evil.test/a/b",
    "https://user@github.com/a/b",
    "https://github.com:444/a/b",
    "javascript:alert(1)",
  ])("rejects unsafe URL %s", async (url) => {
    const f = await fixture();
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        await session(f.userId),
        1,
        url,
      ),
      422,
    );
    expect(
      await db.sql`SELECT id FROM app.external_links WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  });
  it("Release/Branch/Repository/Compare retain OTHER and only canonical URL is persisted", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    const urls = [
      "https://GitHub.com:443/inpulse/core/releases/tag/v2.6.0?token=discard#fragment",
      "https://github.com/inpulse/core/tree/main",
      "https://github.com/inpulse/core",
      "https://github.com/inpulse/core/compare/main...develop",
    ];
    for (let i = 0; i < urls.length; i++)
      expect(
        (await linkRequest("FEATURE", f.featureId, actor, i + 1, urls[i]!))
          .status,
      ).toBe(200);
    const list = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("FEATURE", f.featureId, actor)).json(),
    );
    expect(list.items.map((x: { kind: string }) => x.kind)).toEqual([
      "OTHER",
      "OTHER",
      "OTHER",
      "OTHER",
    ]);
    expect(list.items[0]).toMatchObject({
      label: "Release v2.6.0",
      releaseTag: "v2.6.0",
    });
    const stored =
      await db.sql`SELECT display_url,normalized_url FROM app.external_links WHERE project_id=${f.projectId}`;
    expect(JSON.stringify(stored)).not.toMatch(/discard|fragment|token/);
  });
  it("does not replay after member removal", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      key = randomUUID();
    expect(
      (
        await linkRequest(
          "FEATURE",
          f.featureId,
          actor,
          1,
          undefined,
          undefined,
          key,
        )
      ).status,
    ).toBe(200);
    await removeMember(db.sql, f.projectId, f.userId);
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        1,
        undefined,
        undefined,
        key,
      ),
      404,
    );
  });
  it("published record link mutation preserves immutable snapshots; VOID gates and search remain aligned", async () => {
    const f = await lifecycleFixture(),
      actor = await session(f.userId),
      before = await state(f);
    const added = await linkRequest(
      "CHANGE_RECORD",
      f.draft.id,
      actor,
      f.record.rowVersion,
      "https://github.com/inpulse/core/issues/78781",
    );
    expect(added.status, await added.clone().text()).toBe(200);
    const after = await state(f);
    for (const field of [
      "versions",
      "leftovers",
      "snapshots",
      "links",
    ] as const)
      expect(after[field]).toEqual(before[field]);
    expect(after.record!.current_version).toBe(before.record!.current_version);
    expect(after.search[0]!.raw_text).not.toContain("78781");
    expect(after.search[0]!.normalized_search_text).toContain("78781");
    expect((await change(f, false, f.record.rowVersion + 1)).status).toBe(200);
    await failure(await listLinks("CHANGE_RECORD", f.draft.id, actor), 404);
    expect((await listLinks("CHANGE_RECORD", f.draft.id, f.admin)).status).toBe(
      200,
    );
    await failure(
      await linkRequest(
        "CHANGE_RECORD",
        f.draft.id,
        f.admin,
        f.record.rowVersion + 2,
      ),
      409,
    );
    expect((await change(f, true, f.record.rowVersion + 2)).status).toBe(200);
    const restored = await state(f);
    expect(restored.search[0]!.normalized_search_text).toContain("78781");
    const item = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("CHANGE_RECORD", f.draft.id, actor)).json(),
    ).items[0]!;
    expect(
      (
        await linkRequest(
          "CHANGE_RECORD",
          f.draft.id,
          actor,
          f.record.rowVersion + 3,
          "",
          item.id,
        )
      ).status,
    ).toBe(200);
    expect((await state(f)).search[0]!.normalized_search_text).not.toContain(
      "78781",
    );
  });
  it.each(["audit", "activity", "search"])(
    "rolls back association/entity/target on %s failure",
    async (point) => {
      const f = await fixture(),
        actor = await session(f.userId);
      if (point === "audit")
        vi.spyOn(audit, "append").mockRejectedValueOnce(new Error("synthetic"));
      if (point === "activity")
        vi.spyOn(activity, "append").mockRejectedValueOnce(
          new Error("synthetic"),
        );
      if (point === "search")
        vi.spyOn(
          ExternalLinkSearchPort.prototype,
          "refresh",
        ).mockRejectedValueOnce(new Error("synthetic"));
      await failure(await linkRequest("FEATURE", f.featureId, actor), 500);
      expect(
        await (await listLinks("FEATURE", f.featureId, actor)).json(),
      ).toMatchObject({ rowVersion: 1, items: [] });
      expect(
        await db.sql`SELECT id FROM app.external_links WHERE project_id=${f.projectId}`,
      ).toHaveLength(0);
    },
  );

  it("capacity failures return 422, roll back, and removal remains available", async () => {
    const f = await lifecycleFixture(),
      actor = await session(f.userId),
      url = "https://github.com/inpulse/core/issues/77661";
    expect(
      (
        await linkRequest(
          "CHANGE_RECORD",
          f.draft.id,
          actor,
          f.record.rowVersion,
          url,
        )
      ).status,
    ).toBe(200);
    const before = await state(f);
    // Synthetic current projection near the existing 100000-character capacity.
    await db.sql`UPDATE app.search_projection SET raw_text=${"x".repeat(99900)} WHERE project_id=${f.projectId} AND entity_type='CHANGE_RECORD' AND entity_id=${f.draft.id}`;
    await failure(
      await linkRequest(
        "CHANGE_RECORD",
        f.draft.id,
        actor,
        f.record.rowVersion + 1,
        "https://github.com/inpulse/core/tree/" + "a".repeat(100),
      ),
      422,
    );
    expect(
      (
        (await (
          await listLinks("CHANGE_RECORD", f.draft.id, actor)
        ).json()) as { items: unknown[] }
      ).items,
    ).toHaveLength(1);
    expect((await state(f)).record!.row_version).toBe(
      before.record!.row_version,
    );
    const item = schemaRegistry.ExternalLinkList.schema.parse(
      await (await listLinks("CHANGE_RECORD", f.draft.id, actor)).json(),
    ).items[0]!;
    expect(
      (
        await linkRequest(
          "CHANGE_RECORD",
          f.draft.id,
          actor,
          f.record.rowVersion + 1,
          "",
          item.id,
        )
      ).status,
    ).toBe(200);
  });

  it("later record revision rejects combined capacity and keeps linked search on successful revision", async () => {
    const f = await lifecycleFixture(),
      actor = await session(f.userId);
    const url = "https://github.com/inpulse/core/tree/" + "a".repeat(1600);
    expect(
      (
        await linkRequest(
          "CHANGE_RECORD",
          f.draft.id,
          actor,
          f.record.rowVersion,
          url,
        )
      ).status,
    ).toBe(200);
    const before = await state(f);
    const revise = async (contentValue: typeof content) =>
      fetch(
        `${base}/api/v1/projects/${f.projectId}/change-records/${f.draft.id}/versions`,
        {
          method: "POST",
          headers: {
            origin: base,
            "sec-fetch-site": "same-origin",
            cookie: actor.cookie,
            "x-csrf-token": actor.csrf,
            "If-Match": `"${f.record.rowVersion + 1}"`,
            "Idempotency-Key": randomUUID(),
            "content-type": "application/json",
            "x-record-version": "1",
          },
          body: JSON.stringify({
            ...contentValue,
            // 提交当前版本的遗留问题条目本身，避免触发移除确认分支。
            remainingIssues: f.record.leftovers.map((leftover) => ({
              id: leftover.id,
              content: leftover.content,
            })),
            confirmLeftoverResolved: false,
          }),
        },
      );
    const over = await revise({
      ...content,
      contextProblem: "x".repeat(49000),
      changeSolution: "y".repeat(49000),
      resultVerification: "z".repeat(1000),
    });
    await failure(over.clone(), 422);
    expect(
      schemaRegistry.ErrorResponse.schema.parse(await over.json()).code,
    ).toBe("SEARCH_TEXT_CAPACITY_EXCEEDED");
    const failed = await state(f);
    expect(failed.versions).toEqual(before.versions);
    expect(failed.record).toEqual(before.record);
    expect(failed.search).toEqual(before.search);
    const good = await revise({ ...content, changeSolution: "修订后正文" });
    expect(good.status, await good.clone().text()).toBe(200);
    const after = await state(f);
    expect(after.search[0]!.normalized_search_text).toContain(
      "inpulse/core/tree",
    );
    expect(after.search[0]!.raw_text).toContain("修订后正文");
    expect(after.search[0]!.raw_text).not.toContain(url);
  });
  it.each(["PROJECT", "FEATURE", "TASK", "CHANGE_RECORD"])(
    "%s concurrent different keys allow exactly one row version",
    async (type) => {
      const f = await fixture(),
        actor = await session(f.userId),
        id =
          type === "PROJECT"
            ? f.projectId
            : type === "FEATURE"
              ? f.featureId
              : type === "TASK"
                ? await taskFixture(f)
                : f.draft.id;
      const results = await Promise.all([
        linkRequest(type, id, actor, 1, "https://github.com/a/b/issues/1"),
        linkRequest(type, id, actor, 1, "https://github.com/a/b/issues/2"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        schemaRegistry.ExternalLinkList.schema.parse(
          await (await listLinks(type, id, actor)).json(),
        ).items,
      ).toHaveLength(1);
    },
  );
  it("waits for the feature row lock then commits the association", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      taskId = await taskFixture(f);
    const id = f.featureId;
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (locked = r)),
      gate = new Promise<void>((r) => (release = r));
    const blocker = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM app.features WHERE id=${id} FOR UPDATE`;
      locked();
      await gate;
      // ADR-045：功能不再有归档只读态，持锁方只做一次普通改名。
      await tx`UPDATE app.features SET name='持锁改名',row_version=row_version+1,updated_at=now() WHERE id=${id}`;
    });
    await ready;
    let completed = false;
    const pending = linkRequest("TASK", taskId, actor).then((r) => {
      completed = true;
      return r;
    });
    try {
      await new Promise((r) => setTimeout(r, 70));
      expect(completed).toBe(false);
    } finally {
      release();
      await blocker;
    }
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      await db.sql`SELECT id FROM app.external_links WHERE project_id=${f.projectId}`,
    ).toHaveLength(1);
  });
  it.each(["audit", "activity", "search"])(
    "removal rollback retains the association on %s failure",
    async (point) => {
      const f = await fixture(),
        actor = await session(f.userId);
      const result = schemaRegistry.ExternalLinkResult.schema.parse(
        await (await linkRequest("FEATURE", f.featureId, actor)).json(),
      );
      if (point === "audit")
        vi.spyOn(audit, "append").mockRejectedValueOnce(new Error("synthetic"));
      if (point === "activity")
        vi.spyOn(activity, "append").mockRejectedValueOnce(
          new Error("synthetic"),
        );
      if (point === "search")
        vi.spyOn(
          ExternalLinkSearchPort.prototype,
          "refresh",
        ).mockRejectedValueOnce(new Error("synthetic"));
      await failure(
        await linkRequest("FEATURE", f.featureId, actor, 2, "", result.linkId),
        500,
      );
      expect(
        schemaRegistry.ExternalLinkList.schema.parse(
          await (await listLinks("FEATURE", f.featureId, actor)).json(),
        ),
      ).toMatchObject({ rowVersion: 2, items: [{ id: result.linkId }] });
    },
  );
  it("same key changes to URL or If-Match conflict and revoked Session cannot replay", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      key = randomUUID();
    expect(
      (
        await linkRequest(
          "FEATURE",
          f.featureId,
          actor,
          1,
          undefined,
          undefined,
          key,
        )
      ).status,
    ).toBe(200);
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        1,
        "https://github.com/a/b",
        undefined,
        key,
      ),
      409,
    );
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        2,
        undefined,
        undefined,
        key,
      ),
      409,
    );
    await db.sql`UPDATE app.user_sessions SET revoked_at=now() WHERE user_id=${f.userId}`;
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        1,
        undefined,
        undefined,
        key,
      ),
      401,
    );
  });

  it("merge keeps original source task association and main task does not acquire it", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      source = await taskFixture(f),
      main = await taskFixture(f, 2);
    expect((await linkRequest("TASK", source, actor)).status).toBe(200);
    const before =
      await db.sql`SELECT * FROM app.task_external_links WHERE task_id=${source}`;
    const groups = new TaskGroupsService(
      new PostgresProjectAccessQueryPort(db),
      new PostgresProjectCodePort(),
      new PostgresModuleQueryPort(),
      new PostgresFeatureQueryPort(),
      new PostgresTaskQueryPort(),
      new TaskGroupRepository(),
      audit,
      activity,
      notifications,
      search,
    );
    await uow.run((tx) =>
      groups.execute(
        tx,
        f.userId,
        {
          sourceTaskId: source,
          mainTaskId: main,
          sourceKind: "ACTIVE",
          mergeNote: null,
        },
        randomUUID(),
      ),
    );
    expect(
      await db.sql`SELECT * FROM app.task_external_links WHERE task_id=${source}`,
    ).toEqual(before);
    expect(
      schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks("TASK", source, actor)).json(),
      ).items,
    ).toHaveLength(1);
    expect(
      schemaRegistry.ExternalLinkList.schema.parse(
        await (await listLinks("TASK", main, actor)).json(),
      ).items,
    ).toHaveLength(0);
  });
  it("malformed repository metadata is a 422 rather than a database 500", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    await failure(
      await linkRequest(
        "FEATURE",
        f.featureId,
        actor,
        1,
        "https://github.com/a/b%20c/pull/1",
      ),
      422,
    );
  });

  it.each(["GET", "ADD_REPLAY", "REMOVE_REPLAY"])(
    "%s rechecks VOID after waiting for the real parent lock",
    async (operation) => {
      const f = await lifecycleFixture(true),
        actor = await session(f.userId);
      const addKey = randomUUID(),
        removeKey = randomUUID();
      const added = await linkRequest(
        "CHANGE_RECORD",
        f.draft.id,
        actor,
        f.record.rowVersion,
        undefined,
        undefined,
        addKey,
      );
      expect(added.status).toBe(200);
      const link = schemaRegistry.ExternalLinkResult.schema.parse(
        await added.json(),
      );
      let version = link.rowVersion;
      if (operation === "REMOVE_REPLAY") {
        const removed = await linkRequest(
          "CHANGE_RECORD",
          f.draft.id,
          actor,
          version,
          "",
          link.linkId,
          removeKey,
        );
        expect(removed.status).toBe(200);
        version = schemaRegistry.ExternalLinkResult.schema.parse(
          await removed.json(),
        ).rowVersion;
      }
      const lifecycle = new RecordLifecycleService(
        new PostgresProjectAccessQueryPort(db),
        new PostgresModuleQueryPort(),
        new PostgresFeatureQueryPort(),
        new RecordPublicationRepository(),
        new PublishedRecordRepository(),
        new RecordLifecycleRepository(),
        audit,
        activity,
        search,
        new LeftoverSearchProjectionSync(search),
      );
      let signalReady!: (pid: number) => void, release!: () => void;
      const ready = new Promise<number>((r) => (signalReady = r)),
        gate = new Promise<void>((r) => (release = r));
      const blocker = uow.run(async (tx) => {
        await tx.sql`SELECT id FROM app.projects WHERE id=${f.projectId} FOR UPDATE`;
        const [backend] = await tx.sql<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        signalReady(backend!.pid);
        await gate;
        // Use the actual F21 service in the transaction owning the parent lock.
        await lifecycle.transition(
          tx,
          f.adminId,
          f.projectId,
          f.draft.id,
          version,
          false,
          { reason: "受控读写竞态" },
          randomUUID(),
          async () => f.adminId,
        );
      });
      const pid = await ready;
      const pending =
        operation === "GET"
          ? listLinks("CHANGE_RECORD", f.draft.id, actor)
          : operation === "ADD_REPLAY"
            ? linkRequest(
                "CHANGE_RECORD",
                f.draft.id,
                actor,
                f.record.rowVersion,
                undefined,
                undefined,
                addKey,
              )
            : linkRequest(
                "CHANGE_RECORD",
                f.draft.id,
                actor,
                link.rowVersion,
                "",
                link.linkId,
                removeKey,
              );
      try {
        // This proves the HTTP request has passed its pre-read and is waiting on the parent.
        await expect
          .poll(
            async () => {
              const [waiters] = await db.sql<
                { count: number }[]
              >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%app.projects%' AND wait_event_type='Lock'`;
              return waiters!.count;
            },
            { timeout: 3000, interval: 20 },
          )
          .toBeGreaterThan(0);
      } finally {
        release();
        await blocker;
      }
      const response = await pending;
      await failure(response.clone(), 404);
      expect(await response.text()).not.toMatch(
        /normalizedUrl|rowVersion|linkId/,
      );
      const admin = await listLinks("CHANGE_RECORD", f.draft.id, f.admin);
      expect(admin.status).toBe(200);
      expect(
        schemaRegistry.ExternalLinkList.schema.parse(await admin.json()),
      ).toMatchObject({ writable: false });
    },
  );
});

import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
import { randomBytes, randomUUID } from "node:crypto";
import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { schemaRegistry } from "@inpulse/api-contract";
import { RecordDraftsHttpService } from "../src/modules/change-records/record-drafts-http.service.js";
import { RecordDraftsController } from "../src/modules/change-records/record-drafts.controller.js";
import { TaskRecordDraftWorkflow } from "../src/workflows/task-record-draft.workflow.js";
import { TaskRecordDraftHttpService } from "../src/workflows/task-record-draft-http.service.js";
import { TaskRecordDraftController } from "../src/workflows/task-record-draft.controller.js";
import { PostgresTaskQueryPort } from "../src/modules/tasks/task-query.port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
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
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { RecordDraftRepository } from "../src/modules/change-records/record-draft.repository.js";
import { RecordDraftsService } from "../src/modules/change-records/record-drafts.service.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
} from "./database.helpers.js";

let client: DatabaseClient;
let uow: PostgresUnitOfWork;
let service: RecordDraftsService;
let audit: PostgresAuditWritePort;
let app: INestApplication;
let base: string;
let workflow: TaskRecordDraftWorkflow;
const key = randomBytes(32);
const ring = VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1);
const tokens = new SessionTokenService(ring);
const content = {
  title: "独立验证",
  contextProblem: "重复请求",
  changeSolution: "幂等处理",
  resultVerification: "回归通过",
  remainingIssues: [],
};
beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f17-drafts",
  });
  uow = new PostgresUnitOfWork(client);
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  service = new RecordDraftsService(
    new PostgresProjectAccessQueryPort(client),
    new PostgresModuleQueryPort(),
    new PostgresModuleReadPort(),
    new PostgresFeatureQueryPort(),
    new PostgresFeatureReadPort(),
    new RecordDraftRepository(),
    uow,
    audit,
    new TimeCursorService(ring, "RECORD_DRAFTS"),
  );
  const auth = new SessionAuthService(
    uow,
    new PostgresUserSessionRepository(),
    tokens,
  );
  const http = new RecordDraftsHttpService(
    auth,
    new AuthenticatedMutationService(
      auth,
      new PostgresSessionCsrfTokenRepository(),
      tokens,
    ),
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    service,
  );
  class TestModule {}
  workflow = new TaskRecordDraftWorkflow(
    new PostgresProjectAccessQueryPort(client),
    new PostgresModuleQueryPort(),
    new PostgresFeatureQueryPort(),
    new PostgresTaskQueryPort(),
    service,
    service,
    uow,
    new PostgresUserReadPort(),
  );
  const sourceHttp = new TaskRecordDraftHttpService(
    auth,
    new AuthenticatedMutationService(
      auth,
      new PostgresSessionCsrfTokenRepository(),
      tokens,
    ),
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    workflow,
  );
  Module({
    controllers: [RecordDraftsController, TaskRecordDraftController],
    providers: [
      { provide: RecordDraftsHttpService, useValue: http },
      { provide: TaskRecordDraftHttpService, useValue: sourceHttp },
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
});
async function session(userId: number) {
  const cookie = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  const [s] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.user_sessions(user_id,token_hash,token_hash_key_version,auth_version_at_issue,auth_state,recovery_rotation_generation,recovery_rotation_consumed_generation,idle_expires_at,absolute_expires_at) VALUES (${userId},${tokens.hash(cookie).hash},1,1,'AUTHENTICATED',0,0,now()+interval '1 hour',now()+interval '1 day') RETURNING id`;
  await client.sql`INSERT INTO app.session_csrf_tokens(session_id,token_hash,expires_at) VALUES (${s!.id},${tokens.hash(csrf).hash},now()+interval '1 hour')`;
  return { cookie: `__Host-session=${cookie}`, csrf };
}
async function http(
  path: string,
  method: string,
  actor?: { cookie: string; csrf: string },
  body?: unknown,
  version?: number,
  key = randomUUID(),
) {
  return fetch(base + "/api/v1" + path, {
    method,
    headers: {
      origin: base,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "Idempotency-Key": key,
      ...(actor ? { cookie: actor.cookie, "x-csrf-token": actor.csrf } : {}),
      ...(version ? { "If-Match": `"${version}"` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function failure(response: Response, status: number) {
  expect(response.status).toBe(status);
  const body = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
  expect(JSON.stringify(body)).not.toMatch(
    /SELECT |INSERT INTO|constraint_name|stack/,
  );
}
async function fixture() {
  const userId = await createUser(client.sql);
  const project = await createProject(client.sql, userId);
  const [f] = await client.sql<
    { id: number }[]
  >`INSERT INTO app.features(project_id,module_id,code,name,created_by) VALUES (${project.projectId},${project.moduleId},${project.code + "-F-1"},'功能',${userId}) RETURNING id`;
  return { ...project, userId, featureId: f!.id };
}
describe("F-17 independent drafts", () => {
  it("enforces HTTP security and replay semantics using current resource permissions", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    const path = `/projects/${f.projectId}/modules/${f.moduleId}/record-drafts`;
    const body = {
      ...content,
      scopeType: "MODULE",
      impactFeatureIds: [f.featureId],
    };
    const key = randomUUID();
    const response = await http(path, "POST", actor, body, undefined, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = schemaRegistry.RecordDraftItem.schema.parse(
      await response.json(),
    );
    expect(
      await (await http(path, "POST", actor, body, undefined, key)).json(),
    ).toEqual(saved);
    await failure(
      await http(
        path,
        "POST",
        actor,
        { ...body, title: "另一含义" },
        undefined,
        key,
      ),
      409,
    );
    await failure(
      await http(path, "POST", actor, { ...body, authorId: f.userId }),
      422,
    );
    await failure(
      await http(path, "POST", { ...actor, csrf: "a".repeat(43) }, body),
      401,
    );
    const resource = `/projects/${f.projectId}/record-drafts/${saved.id}`;
    await failure(await http(resource, "GET"), 401);
    await failure(await http(resource, "PATCH", actor, content), 422);
    const outsider = await session(await createUser(client.sql));
    await failure(await http(resource, "GET", outsider), 404);
    await failure(await http(resource, "PATCH", outsider, content, 1), 404);
    const updateKey = randomUUID();
    const edited = await http(
      resource,
      "PATCH",
      actor,
      { ...content, title: "保存修改" },
      1,
      updateKey,
    );
    expect(edited.status).toBe(200);
    const value = await edited.json();
    expect(
      await (
        await http(
          resource,
          "PATCH",
          actor,
          { ...content, title: "保存修改" },
          1,
          updateKey,
        )
      ).json(),
    ).toEqual(value);
    await failure(
      await http(
        resource,
        "PATCH",
        actor,
        { ...content, title: "保存修改" },
        2,
        updateKey,
      ),
      409,
    );
    await removeMember(client.sql, f.projectId, f.userId);
    await failure(await http(path, "POST", actor, body, undefined, key), 404);
    await failure(await http(resource, "GET", actor), 404);
  });
  it("waits for the feature row lock then commits draft creation", async () => {
    const f = await fixture();
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    // ADR-045：功能不再有归档只读态，持锁方只做一次改名。
    const archive = uow.run(async (tx) => {
      await tx.sql`UPDATE app.features SET name='持锁改名',row_version=row_version+1 WHERE id=${f.featureId}`;
      acquired();
      await gate;
    });
    await ready;
    const pending = uow.run((tx) =>
      service.create(
        tx,
        f.userId,
        f.projectId,
        f.moduleId,
        { ...content, scopeType: "FEATURE", featureId: f.featureId },
        randomUUID(),
      ),
    );
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name='inpulse-f17-drafts' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`
            ).length,
          ).toBeGreaterThan(0),
        { timeout: 4000, interval: 30 },
      );
    } finally {
      release();
      await archive;
    }
    await expect(pending).resolves.toMatchObject({
      scopeType: "FEATURE",
      featureId: f.featureId,
    });
    expect(
      await client.sql`SELECT 1 FROM app.change_records WHERE project_id=${f.projectId}`,
    ).toHaveLength(1);
  });
  it("creates a real unnumbered draft, allows another member to edit, and emits no published data", async () => {
    const f = await fixture();
    const draft = await uow.run((tx) =>
      service.create(
        tx,
        f.userId,
        f.projectId,
        f.moduleId,
        { ...content, scopeType: "FEATURE", featureId: f.featureId },
        randomUUID(),
      ),
    );
    expect(draft).toMatchObject({
      ...content,
      taskId: null,
      code: null,
      status: "DRAFT",
      currentVersion: 0,
      publishedAt: null,
      handlerId: f.userId,
      authorId: f.userId,
    });
    const member = await createUser(client.sql);
    await client.sql`INSERT INTO app.project_members(project_id,user_id) VALUES (${f.projectId},${member})`;
    const edited = await uow.run((tx) =>
      service.update(
        tx,
        member,
        f.projectId,
        draft.id,
        1,
        { ...content, changeSolution: "补充方案" },
        randomUUID(),
      ),
    );
    expect(edited).toMatchObject({
      rowVersion: 2,
      authorId: f.userId,
      handlerId: f.userId,
      changeSolution: "补充方案",
    });
    expect(await service.read(member, f.projectId)).toMatchObject({
      items: [edited],
    });
    for (const table of [
      "change_record_versions",
      "activity_projection",
      "search_projection",
      "notifications",
    ])
      expect(
        await client.sql`SELECT 1 FROM ${client.sql("app." + table)} WHERE project_id=${f.projectId}`,
      ).toHaveLength(0);
    expect(
      await client.sql`SELECT 1 FROM app.code_sequences WHERE project_id=${f.projectId} AND entity_type='CHANGE_RECORD'`,
    ).toHaveLength(0);
    expect(
      await client.sql`SELECT 1 FROM app.tasks WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  });
  it("rejects foreign ownership, revoked members and archived parents without leaking drafts", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      uow.run((tx) =>
        service.create(
          tx,
          f.userId,
          f.projectId,
          f.moduleId,
          { ...content, scopeType: "FEATURE", featureId: other.featureId },
          randomUUID(),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const draft = await uow.run((tx) =>
      service.create(
        tx,
        f.userId,
        f.projectId,
        f.moduleId,
        { ...content, scopeType: "FEATURE", featureId: f.featureId },
        randomUUID(),
      ),
    );
    await expect(
      service.read(other.userId, f.projectId, draft.id),
    ).rejects.toMatchObject({ status: 404 });
    // ADR-045：功能不再有归档态，父级改名不影响草稿写入。
    await client.sql`UPDATE app.features SET name='改名功能',row_version=row_version+1 WHERE id=${f.featureId}`;
    await expect(
      uow.run((tx) =>
        service.update(
          tx,
          f.userId,
          f.projectId,
          draft.id,
          1,
          content,
          randomUUID(),
        ),
      ),
    ).resolves.toMatchObject({ id: draft.id });
    expect(await service.read(f.userId, f.projectId, draft.id)).toMatchObject({
      id: draft.id,
    });
    await removeMember(client.sql, f.projectId, f.userId);
    await expect(
      service.read(f.userId, f.projectId, draft.id),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("keeps independent MODULE impact snapshots and rejects foreign impacts", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      uow.run((tx) =>
        service.create(
          tx,
          f.userId,
          f.projectId,
          f.moduleId,
          {
            ...content,
            scopeType: "MODULE",
            impactFeatureIds: [other.featureId],
          },
          randomUUID(),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const draft = await uow.run((tx) =>
      service.create(
        tx,
        f.userId,
        f.projectId,
        f.moduleId,
        { ...content, scopeType: "MODULE", impactFeatureIds: [f.featureId] },
        randomUUID(),
      ),
    );
    // ADR-045：功能不再有归档态，已有影响功能在编辑后原样保留，也可以再次引用。
    expect(
      await uow.run((tx) =>
        service.update(
          tx,
          f.userId,
          f.projectId,
          draft.id,
          1,
          { ...content, title: "保留历史" },
          randomUUID(),
        ),
      ),
    ).toMatchObject({ impactFeatureIds: [f.featureId] });
    await expect(
      uow.run((tx) =>
        service.create(
          tx,
          f.userId,
          f.projectId,
          f.moduleId,
          { ...content, scopeType: "MODULE", impactFeatureIds: [f.featureId] },
          randomUUID(),
        ),
      ),
    ).resolves.toMatchObject({ impactFeatureIds: [f.featureId] });
  });
  it("serializes concurrent edits and rolls back a failed audit with content and version", async () => {
    const f = await fixture();
    const draft = await uow.run((tx) =>
      service.create(
        tx,
        f.userId,
        f.projectId,
        f.moduleId,
        { ...content, scopeType: "MODULE", impactFeatureIds: [] },
        randomUUID(),
      ),
    );
    vi.spyOn(audit, "append").mockRejectedValueOnce(new Error("audit failed"));
    await expect(
      uow.run((tx) =>
        service.update(
          tx,
          f.userId,
          f.projectId,
          draft.id,
          1,
          { ...content, title: "不得保留" },
          randomUUID(),
        ),
      ),
    ).rejects.toThrow("audit failed");
    expect(await service.read(f.userId, f.projectId, draft.id)).toEqual({
      ...draft,
      authorName: expect.any(String),
      handlerName: expect.any(String),
      moduleName: "未分类",
      featureName: null,
      impactFeatureNames: [],
    });
    const results = await Promise.allSettled(
      ["甲", "乙"].map((title) =>
        uow.run((tx) =>
          service.update(
            tx,
            f.userId,
            f.projectId,
            draft.id,
            1,
            { ...content, title },
            randomUUID(),
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "RECORD_VERSION_CONFLICT" },
    });
  });
  it("pages drafts newest-first with the signed keyset cursor without overlap or loss", async () => {
    const f = await fixture();
    const created: number[] = [];
    for (const title of ["分页甲", "分页乙", "分页丙"]) {
      const draft = await uow.run((tx) =>
        service.create(
          tx,
          f.userId,
          f.projectId,
          f.moduleId,
          { ...content, title, scopeType: "MODULE", impactFeatureIds: [] },
          randomUUID(),
        ),
      );
      created.push(draft.id);
    }
    const newestFirst = [...created].reverse();
    const readPage = async (params: {
      readonly limit?: number;
      readonly cursor?: string;
    }) =>
      schemaRegistry.RecordDraftPage.schema.parse(
        await service.read(f.userId, f.projectId, undefined, params),
      );
    const first = await readPage({ limit: 2 });
    expect(first.items.map((x) => x.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const second = await readPage({ limit: 2, cursor: cursor! });
    expect(second.items.map((x) => x.id)).toEqual(newestFirst.slice(2));
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    const other = await createProject(client.sql, f.userId);
    await expect(
      service.read(f.userId, other.projectId, undefined, { cursor: cursor! }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
    await expect(
      service.read(f.userId, f.projectId, undefined, { cursor: "tampered.0" }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
  });
  it("filters the project draft list by author and binds the author into the cursor", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    const member = await createUser(client.sql);
    await client.sql`INSERT INTO app.project_members(project_id,user_id) VALUES (${f.projectId},${member})`;
    const create = (authorId: number, title: string) =>
      uow.run((tx) =>
        service.create(
          tx,
          authorId,
          f.projectId,
          f.moduleId,
          { ...content, title, scopeType: "MODULE", impactFeatureIds: [] },
          randomUUID(),
        ),
      );
    const mineOlder = await create(f.userId, "我的草稿甲");
    const mineNewer = await create(f.userId, "我的草稿乙");
    const theirs = await create(member, "他人草稿");
    const numeric = (a: number, b: number) => a - b;
    const readPage = async (params: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly authorId?: number;
    }) =>
      schemaRegistry.RecordDraftPage.schema.parse(
        await service.read(f.userId, f.projectId, undefined, params),
      );
    const all = await readPage({});
    expect(all.items.map((item) => item.id).sort(numeric)).toEqual(
      [mineOlder.id, mineNewer.id, theirs.id].sort(numeric),
    );
    const first = await readPage({ authorId: f.userId, limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual([mineNewer.id]);
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const second = await readPage({
      authorId: f.userId,
      limit: 1,
      cursor: cursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual([mineOlder.id]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    await expect(
      service.read(f.userId, f.projectId, undefined, {
        limit: 1,
        cursor: cursor!,
        authorId: member,
      }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
    await expect(
      service.read(f.userId, f.projectId, undefined, { cursor: cursor! }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR" });
    const list = `/projects/${f.projectId}/record-drafts`;
    const mine = schemaRegistry.RecordDraftPage.schema.parse(
      await (await http(`${list}?authorId=${f.userId}`, "GET", actor)).json(),
    );
    expect(mine.items.map((item) => item.id).sort(numeric)).toEqual(
      [mineOlder.id, mineNewer.id].sort(numeric),
    );
    await failure(await http(`${list}?authorId=abc`, "GET", actor), 422);
    await failure(await http(`${list}?authorId=0`, "GET", actor), 422);
  });
});
async function taskFixture(scope: "FEATURE" | "MODULE" = "FEATURE") {
  const f = await fixture();
  const member = await createUser(client.sql);
  await client.sql`INSERT INTO app.project_members(project_id,user_id) VALUES (${f.projectId},${member})`;
  const repo = new TaskManagementRepository();
  const task = await uow.run(async (tx) => {
    const task = await repo.create(
      tx,
      { ...f, featureId: scope === "FEATURE" ? f.featureId : null },
      f.userId,
      f.code + "-T-1",
      {
        title: "来源任务",
        description: "来源说明",
        assigneeIds: [f.userId],
        priority: "NORMAL",
        dueAt: null,
      },
    );
    if (scope === "MODULE") await repo.replaceImpacts(tx, task, [f.featureId]);
    return task;
  });
  return {
    ...f,
    member,
    task,
    repo,
    path: { projectId: f.projectId, moduleId: f.moduleId, taskId: task.id },
    url: `/projects/${f.projectId}/modules/${f.moduleId}/tasks/${task.id}/record-drafts`,
  };
}

describe("F-17 source drafts", () => {
  it("creates multiple explicit drafts, replays only the same key, derives identity, and never completes the source", async () => {
    const f = await taskFixture(),
      actor = await session(f.member),
      body = { ...content, title: null },
      key = randomUUID();
    const before =
      await client.sql`SELECT * FROM app.tasks WHERE id=${f.task.id}`;
    const first = await http(f.url, "POST", actor, body, 1, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const saved = schemaRegistry.RecordDraftItem.schema.parse(
      await first.json(),
    );
    expect(saved).toMatchObject({
      title: f.task.title,
      taskId: f.task.id,
      handlerId: f.userId,
      authorId: f.member,
      featureId: f.featureId,
      status: "DRAFT",
      code: null,
      currentVersion: 0,
      publishedAt: null,
    });
    expect(
      await (await http(f.url, "POST", actor, body, 1, key)).json(),
    ).toEqual(saved);
    const second = await http(
      f.url,
      "POST",
      actor,
      { ...body, title: "另一条变化" },
      1,
    );
    expect(second.status).toBe(200);
    const secondSaved = (await second.json()) as { id: number };
    expect(secondSaved.id).not.toBe(saved.id);
    const list = schemaRegistry.TaskRecordDraftsResponse.schema.parse(
      await (await http(f.url, "GET", actor)).json(),
    );
    expect(list.items.map((x) => x.id)).toEqual([secondSaved.id, saved.id]);
    expect(
      await client.sql`SELECT * FROM app.tasks WHERE id=${f.task.id}`,
    ).toEqual(before);
    expect(
      await client.sql`SELECT * FROM app.task_status_history WHERE task_id=${f.task.id}`,
    ).toHaveLength(1);
    for (const table of [
      "change_record_versions",
      "activity_projection",
      "search_projection",
      "notifications",
    ])
      expect(
        await client.sql`SELECT 1 FROM ${client.sql("app." + table)} WHERE project_id=${f.projectId}`,
      ).toHaveLength(0);
    await failure(
      await http(f.url, "POST", actor, { ...body, handlerId: f.member }, 1),
      422,
    );
    await failure(
      await http(f.url, "POST", actor, { ...body, title: "changed" }, 1, key),
      409,
    );
    await failure(await http(f.url, "POST", actor, body), 422);
    await failure(await http(f.url, "POST", actor, body, 2), 409);
    const edit = await http(
      f.url + "/" + saved.id,
      "PATCH",
      await session(f.userId),
      { ...content, title: "成员补充" },
      1,
    );
    expect(edit.status, await edit.clone().text()).toBe(200);
    expect(await edit.json()).toMatchObject({
      authorId: f.member,
      handlerId: f.userId,
      taskId: f.task.id,
      rowVersion: 2,
      title: "成员补充",
    });
    await failure(
      await http(
        `/projects/${f.projectId}/record-drafts/${saved.id}`,
        "PATCH",
        actor,
        content,
        2,
      ),
      409,
    );
    await removeMember(client.sql, f.projectId, f.member);
    await failure(await http(f.url, "POST", actor, body, 1, key), 404);
    await failure(await http(f.url, "GET", actor), 404);
  });
  it.each(["DONE", "CANCELED"] as const)(
    "preserves %s status and its history while creating/editing",
    async (status) => {
      const f = await taskFixture();
      const task = await uow.run((tx) =>
        f.repo.transition(
          tx,
          f.task,
          f.userId,
          status,
          status === "DONE" ? "无功能变化" : null,
          status === "CANCELED" ? "不再需要" : null,
        ),
      );
      const before =
        await client.sql`SELECT * FROM app.tasks WHERE id=${f.task.id}`;
      const history =
        await client.sql`SELECT * FROM app.task_status_history WHERE task_id=${f.task.id} ORDER BY id`;
      const draft = await uow.run((tx) =>
        workflow.execute(
          tx,
          f.member,
          f.path,
          task!.rowVersion,
          { ...content, title: null },
          randomUUID(),
        ),
      );
      await uow.run((tx) =>
        workflow.execute(
          tx,
          f.userId,
          { ...f.path, recordId: draft.id },
          1,
          { ...content, title: "继续补充" },
          randomUUID(),
        ),
      );
      expect(
        await client.sql`SELECT * FROM app.tasks WHERE id=${f.task.id}`,
      ).toEqual(before);
      expect(
        await client.sql`SELECT * FROM app.task_status_history WHERE task_id=${f.task.id} ORDER BY id`,
      ).toEqual(history);
    },
  );
  it("freezes MODULE impacts and handler despite later task changes", async () => {
    const f = await taskFixture("MODULE");
    const draft = await uow.run((tx) =>
      workflow.execute(
        tx,
        f.member,
        f.path,
        1,
        { ...content, title: null },
        randomUUID(),
      ),
    );
    await uow.run(async (tx) => {
      await tx.sql`SELECT id FROM app.tasks WHERE id=${f.task.id} FOR UPDATE`;
      await f.repo.replaceImpacts(tx, f.task, []);
      await tx.sql`UPDATE app.tasks SET title='已改名',row_version=row_version+1 WHERE id=${f.task.id}`;
      // ADR-040：任务负责人已改为关联表，用关联表写入保持原「改派给 f.member」语义。
      await tx.sql`DELETE FROM app.task_assignees WHERE task_id=${f.task.id}`;
      await tx.sql`INSERT INTO app.task_assignees (task_id, user_id, project_id) SELECT ${f.task.id}, ${f.member}, project_id FROM app.tasks WHERE id=${f.task.id}`;
    });
    const edited = await uow.run((tx) =>
      workflow.execute(
        tx,
        f.member,
        { ...f.path, recordId: draft.id },
        1,
        { ...content, title: "历史快照" },
        randomUUID(),
      ),
    );
    expect(edited).toMatchObject({
      impactFeatureIds: [f.featureId],
      handlerId: f.userId,
      authorId: f.member,
      taskId: f.task.id,
    });
    const next = await uow.run((tx) =>
      workflow.execute(
        tx,
        f.member,
        f.path,
        2,
        { ...content, title: null },
        randomUUID(),
      ),
    );
    expect(next).toMatchObject({
      impactFeatureIds: [],
      handlerId: f.member,
      title: "已改名",
    });
  });
  it("rejects foreign source identity and revoked membership, including replay", async () => {
    const f = await taskFixture(),
      other = await taskFixture(),
      actor = await session(f.member),
      key = randomUUID(),
      body = { ...content, title: null };
    const response = await http(f.url, "POST", actor, body, 1, key);
    expect(response.status).toBe(200);
    const saved = (await response.json()) as { id: number };
    await failure(
      await http(
        `/projects/${f.projectId}/modules/${f.moduleId}/tasks/${other.task.id}/record-drafts`,
        "POST",
        actor,
        body,
        1,
      ),
      404,
    );
    await failure(
      await http(
        other.url + "/" + saved.id,
        "PATCH",
        await session(other.member),
        content,
        1,
      ),
      404,
    );
    await failure(await http(f.url, "GET"), 401);
    await failure(
      await http(f.url, "POST", { ...actor, csrf: "a".repeat(43) }, body, 1),
      401,
    );
    // ADR-045：功能不再有归档态，父级改名后草稿仍可写、同 Key 重放返回原响应。
    await client.sql`UPDATE app.features SET name='改名功能',row_version=row_version+1 WHERE id=${f.featureId}`;
    const replay = await http(f.url, "POST", actor, body, 1, key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    const patched = await http(
      f.url + "/" + saved.id,
      "PATCH",
      actor,
      content,
      1,
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await workflow.read(f.member, f.path)).items).toHaveLength(1);
  });
  it("rolls back failed audit and accepts only one concurrent content edit", async () => {
    const f = await taskFixture("MODULE");
    vi.spyOn(audit, "append").mockRejectedValueOnce(
      new Error("draft audit failure"),
    );
    await expect(
      uow.run((tx) =>
        workflow.execute(
          tx,
          f.member,
          f.path,
          1,
          { ...content, title: null },
          randomUUID(),
        ),
      ),
    ).rejects.toThrow("draft audit failure");
    expect((await workflow.read(f.member, f.path)).items).toHaveLength(0);
    const draft = await uow.run((tx) =>
      workflow.execute(
        tx,
        f.member,
        f.path,
        1,
        { ...content, title: null },
        randomUUID(),
      ),
    );
    const results = await Promise.allSettled(
      ["甲", "乙"].map((title) =>
        uow.run((tx) =>
          workflow.execute(
            tx,
            f.member,
            { ...f.path, recordId: draft.id },
            1,
            { ...content, title },
            randomUUID(),
          ),
        ),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.find((x) => x.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "RECORD_VERSION_CONFLICT" },
    });
  });
  it("retries from parent locks when a task update commits during its row-lock wait", async () => {
    const f = await taskFixture("MODULE");
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const update = uow.run(async (tx) => {
      await tx.sql`SELECT id FROM app.tasks WHERE id=${f.task.id} FOR UPDATE`;
      await f.repo.replaceImpacts(tx, f.task, []);
      await tx.sql`UPDATE app.tasks SET title='锁后最新标题',row_version=row_version+1 WHERE id=${f.task.id}`;
      // ADR-040：同上，改派经关联表完成。
      await tx.sql`DELETE FROM app.task_assignees WHERE task_id=${f.task.id}`;
      await tx.sql`INSERT INTO app.task_assignees (task_id, user_id, project_id) SELECT ${f.task.id}, ${f.member}, project_id FROM app.tasks WHERE id=${f.task.id}`;
      acquired();
      await gate;
    });
    await ready;
    const pending = uow.run((tx) =>
      workflow.execute(
        tx,
        f.member,
        f.path,
        2,
        { ...content, title: null },
        randomUUID(),
      ),
    );
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name='inpulse-f17-drafts' AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`
            ).length,
          ).toBeGreaterThan(0),
        { timeout: 4000, interval: 30 },
      );
    } finally {
      release();
      await update;
    }
    expect(await pending).toMatchObject({
      title: "锁后最新标题",
      handlerId: f.member,
      impactFeatureIds: [],
    });
  });
});
it("allows another source draft after an existing published record without modifying that history", async () => {
  const f = await taskFixture();
  await uow.run((tx) =>
    f.repo.transition(tx, f.task, f.userId, "DONE", "无功能变化", null),
  );
  const published = await uow.run((tx) =>
    workflow.execute(tx, f.member, f.path, 2, content, randomUUID()),
  );
  // Fixture represents an existing formal record; F-17 exposes no publish command.
  await uow.run(async (tx) => {
    await tx.sql`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) SELECT id,project_id,1,title,current_payload,${f.member} FROM app.change_records WHERE id=${published.id}`;
    await tx.sql`UPDATE app.change_records SET status='PUBLISHED',code=${f.code + "-CR-1"},current_version=1,published_at=now(),row_version=row_version+1 WHERE id=${published.id}`;
  });
  const original =
    await client.sql`SELECT * FROM app.change_records WHERE id=${published.id}`;
  const next = await uow.run((tx) =>
    workflow.execute(
      tx,
      f.member,
      f.path,
      2,
      { ...content, title: "另一条草稿" },
      randomUUID(),
    ),
  );
  expect(
    (await workflow.read(f.member, f.path)).items.map((x) => x.id),
  ).toEqual([next.id]);
  expect(
    await client.sql`SELECT * FROM app.change_records WHERE id=${published.id}`,
  ).toEqual(original);
  expect(
    await client.sql`SELECT * FROM app.change_record_versions WHERE record_id=${published.id}`,
  ).toHaveLength(1);
});

/** 删除草稿：审计留痕走 audit_reader，运行角色读不到审计表。 */
async function auditEventFor(projectId: number, action: string) {
  const db = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f22-draft-delete",
  });
  try {
    return await db.sql<
      { action: string; targetId: string }[]
    >`SELECT action,target_id AS "targetId" FROM app.audit_logs WHERE project_id=${projectId} AND action=${action} ORDER BY sequence_no`;
  } finally {
    await db.close();
  }
}

describe("F-17 草稿删除", () => {
  it("deletes an independent draft with its child rows, audits it, and still replays the same key afterwards", async () => {
    const f = await fixture(),
      actor = await session(f.userId);
    const created = await http(
      `/projects/${f.projectId}/modules/${f.moduleId}/record-drafts`,
      "POST",
      actor,
      { ...content, scopeType: "MODULE", impactFeatureIds: [f.featureId] },
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const saved = schemaRegistry.RecordDraftItem.schema.parse(
      await created.json(),
    );
    const resource = `/projects/${f.projectId}/record-drafts/${saved.id}`;
    // 子行确实存在，删除必须一起清掉，否则 restrict 外键会挡住。
    expect(
      await client.sql`SELECT 1 FROM app.change_record_feature_impacts WHERE change_record_id=${saved.id}`,
    ).toHaveLength(1);
    const key = randomUUID();
    const deleted = await http(resource, "DELETE", actor, undefined, 1, key);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const result = schemaRegistry.RecordDraftDeleteResult.schema.parse(
      await deleted.json(),
    );
    expect(result).toEqual({
      projectId: f.projectId,
      recordId: saved.id,
      moduleId: f.moduleId,
      featureId: null,
      taskId: null,
      impactFeatureIds: [f.featureId],
    });
    expect(
      await client.sql`SELECT 1 FROM app.change_records WHERE id=${saved.id}`,
    ).toHaveLength(0);
    expect(
      await client.sql`SELECT 1 FROM app.change_record_feature_impacts WHERE change_record_id=${saved.id}`,
    ).toHaveLength(0);
    expect(await auditEventFor(f.projectId, "record.draft.delete")).toEqual([
      { action: "record.draft.delete", targetId: String(saved.id) },
    ]);
    // 记录行已经不存在：同 Key 同摘要必须重放原 200，而不是 404。
    const replay = await http(resource, "DELETE", actor, undefined, 1, key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(result);
    // 列表与详情都不再暴露这条草稿；换新 Key 再来一次是 404。
    const list = schemaRegistry.RecordDraftPage.schema.parse(
      await (
        await http(`/projects/${f.projectId}/record-drafts`, "GET", actor)
      ).json(),
    );
    expect(list.items).toHaveLength(0);
    await failure(await http(resource, "GET", actor), 404);
    await failure(await http(resource, "DELETE", actor, undefined, 1), 404);
  });

  it("rejects unauthenticated, foreign, revoked and version-mismatched deletes, and never touches published history", async () => {
    const f = await fixture(),
      actor = await session(f.userId),
      path = `/projects/${f.projectId}/modules/${f.moduleId}/record-drafts`;
    const first = await http(path, "POST", actor, {
      ...content,
      scopeType: "MODULE",
      impactFeatureIds: [f.featureId],
    });
    const saved = schemaRegistry.RecordDraftItem.schema.parse(
      await first.json(),
    );
    const resource = `/projects/${f.projectId}/record-drafts/${saved.id}`;
    // 未登录：请求头形状合法但没有会话，鉴权必须 401。
    await failure(
      await http(
        resource,
        "DELETE",
        { cookie: "__Host-session=" + "b".repeat(43), csrf: "a".repeat(43) },
        undefined,
        1,
      ),
      401,
    );
    const outsider = await session(await createUser(client.sql));
    await failure(await http(resource, "DELETE", outsider, undefined, 1), 404);
    await failure(await http(resource, "DELETE", actor, undefined, 9), 409);
    expect(
      await client.sql`SELECT 1 FROM app.change_records WHERE id=${saved.id}`,
    ).toHaveLength(1);
    // 已发布记录不是草稿：删除必须 404，正文与子行都保持原样。
    // 版本不变式（assert_change_record_versions）要求发布行必须有 v1，同事务补上。
    await uow.run(async (tx) => {
      await tx.sql`INSERT INTO app.change_record_versions(record_id,project_id,version_no,title_snapshot,payload,created_by) SELECT id,project_id,1,title,current_payload,${f.userId} FROM app.change_records WHERE id=${saved.id}`;
      await tx.sql`UPDATE app.change_records SET status='PUBLISHED',code=${f.code + "-CR-1"},current_version=1,published_at=now(),row_version=row_version+1 WHERE id=${saved.id}`;
    });
    const published =
      await client.sql`SELECT * FROM app.change_records WHERE id=${saved.id}`;
    await failure(await http(resource, "DELETE", actor, undefined, 2), 404);
    expect(
      await client.sql`SELECT * FROM app.change_records WHERE id=${saved.id}`,
    ).toEqual(published);
    expect(
      await client.sql`SELECT 1 FROM app.change_record_feature_impacts WHERE change_record_id=${saved.id}`,
    ).toHaveLength(1);
    expect(
      await auditEventFor(f.projectId, "record.draft.delete"),
    ).toHaveLength(0);
  });

  it("deletes a task source draft through the same path without changing the task", async () => {
    const f = await taskFixture(),
      actor = await session(f.member);
    const created = await http(
      f.url,
      "POST",
      actor,
      { ...content, title: null },
      1,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const saved = schemaRegistry.RecordDraftItem.schema.parse(
      await created.json(),
    );
    expect(saved.taskId).toBe(f.task.id);
    const before =
      await client.sql`SELECT * FROM app.tasks WHERE id=${f.task.id}`;
    const deleted = await http(
      `/projects/${f.projectId}/record-drafts/${saved.id}`,
      "DELETE",
      actor,
      undefined,
      1,
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(
      await client.sql`SELECT 1 FROM app.change_records WHERE id=${saved.id}`,
    ).toHaveLength(0);
    expect(
      await client.sql`SELECT * FROM app.tasks WHERE id=${f.task.id}`,
    ).toEqual(before);
    const list = schemaRegistry.TaskRecordDraftsResponse.schema.parse(
      await (await http(f.url, "GET", actor)).json(),
    );
    expect(list.items).toHaveLength(0);
  });
});

import { PostgresUserReadPort } from "../src/auth/user-read.port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { FeatureCandidatesQueryPort } from "../src/modules/search/index.js";
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
  featureItemSchema,
  featureListResponseSchema,
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
import { FeatureManagementRepository } from "../src/modules/features/feature-management.repository.js";
import { FeaturesManagementService } from "../src/modules/features/features-management.service.js";
import { FeaturesHttpService } from "../src/modules/features/features-http.service.js";
import { FeaturesController } from "../src/modules/features/features.controller.js";
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
let management: FeaturesManagementService;
let audit: PostgresAuditWritePort;
let search: PostgresSearchProjectionWritePort;
let activity: PostgresActivityWritePort;
const key = randomBytes(32);
const tokens = new SessionTokenService(
  VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
);
interface Actor {
  userId: number;
  sessionId: number;
  cookie: string;
  csrf: string;
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f13-http",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f13-audit-evidence",
  });
  uow = new PostgresUnitOfWork(client);
  const sessions = new PostgresUserSessionRepository();
  const csrf = new PostgresSessionCsrfTokenRepository();
  const auth = new SessionAuthService(uow, sessions, tokens);
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  search = new PostgresSearchProjectionWritePort();
  activity = new PostgresActivityWritePort();
  const access = new PostgresProjectAccessQueryPort(client);
  management = new FeaturesManagementService(
    access,
    new FeatureCandidatesQueryPort(),
    new PostgresModuleQueryPort(),
    new PostgresModuleReadPort(),
    new PostgresProjectCodePort(),
    uow,
    new FeatureManagementRepository(),
    audit,
    activity,
    search,
  );
  const http = new FeaturesHttpService(
    auth,
    new AuthenticatedMutationService(auth, csrf, tokens),
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    management,
  );
  class TestModule {}
  Module({
    controllers: [FeaturesController],
    providers: [{ provide: FeaturesHttpService, useValue: http }],
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
async function fixture(): Promise<{ member: Actor; project: ProjectFixture }> {
  const member = await actor();
  return { member, project: await createProject(client.sql, member.userId) };
}
async function request(
  project: Pick<ProjectFixture, "projectId" | "moduleId">,
  method: string,
  who?: Actor,
  body?: unknown,
  suffix = "",
  version?: number,
  idempotencyKey = randomUUID(),
) {
  return fetch(
    `${base}/api/v1/projects/${project.projectId}/modules/${project.moduleId}/features${suffix}`,
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

async function create(
  project: ProjectFixture,
  member: Actor,
  name = "支付退款",
) {
  const response = await request(project, "POST", member, {
    name,
    currentBehavior: "原说明",
    tags: ["支付"],
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return featureItemSchema.parse(await response.json());
}

describe("F-13 real HTTP and PostgreSQL", () => {
  it("rejects disabled sessions, invalid CSRF, missing keys and changed If-Match replay", async () => {
    const { member, project } = await fixture();
    const item = await create(project, member);
    await error(
      await request(
        project,
        "POST",
        { ...member, csrf: "z".repeat(43) },
        { name: "CSRF" },
      ),
      401,
    );
    const noKey = await fetch(
      `${base}/api/v1/projects/${project.projectId}/modules/${project.moduleId}/features`,
      {
        method: "POST",
        headers: {
          origin: base,
          "sec-fetch-site": "same-origin",
          cookie: member.cookie,
          "x-csrf-token": member.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "缺少 Key" }),
      },
    );
    await error(noKey, 400);
    const key = randomUUID();
    const edit = { name: "修改", currentBehavior: "新行为", tags: [] };
    const first = await request(
      project,
      "PATCH",
      member,
      edit,
      `/${item.id}`,
      1,
      key,
    );
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(
      await (
        await request(project, "PATCH", member, edit, `/${item.id}`, 1, key)
      ).json(),
    ).toEqual(body);
    await error(
      await request(project, "PATCH", member, edit, `/${item.id}`, 2, key),
      409,
    );
    await client.sql`UPDATE app.users SET status = 'DISABLED', disabled_at = now(), row_version = row_version + 1 WHERE id = ${member.userId}`;
    await error(await request(project, "GET", member), 401);
    await error(
      await request(project, "PATCH", member, edit, `/${item.id}`, 1, key),
      401,
    );
  });

  it("maps an existing code collision to 409 without consuming a sequence or overwriting history", async () => {
    const { member, project } = await fixture();
    await client.sql`INSERT INTO app.features (project_id, module_id, code, name, created_by) VALUES (${project.projectId}, ${project.moduleId}, ${`${project.code}-F-1`}, '导入历史', ${member.userId})`;
    await error(
      await request(project, "POST", member, { name: "新建" }),
      409,
      "FEATURE_CODE_CONFLICT",
    );
    expect(
      await client.sql`SELECT 1 FROM app.code_sequences WHERE project_id = ${project.projectId} AND entity_type = 'FEATURE'`,
    ).toHaveLength(0);
    const [row] =
      await client.sql`SELECT name FROM app.features WHERE project_id = ${project.projectId}`;
    expect(row?.name).toBe("导入历史");
  });
  it("creates, lists, reads, edits description with immutable before/after audit and no change record", async () => {
    const { member, project } = await fixture();
    const item = await create(project, member);
    expect(item).toMatchObject({
      code: `${project.code}-F-1`,
      createdBy: member.userId,
      moduleId: project.moduleId,
      rowVersion: 1,
    });
    const list = await request(project, "GET", member);
    expect(featureListResponseSchema.parse(await list.json()).items).toEqual([
      { ...item, createdByName: expect.any(String) },
    ]);
    expect(
      await (
        await request(project, "GET", member, undefined, `/${item.id}`)
      ).json(),
    ).toEqual({ ...item, createdByName: expect.any(String) });
    const update = await request(
      project,
      "PATCH",
      member,
      {
        name: item.name,
        currentBehavior: "新说明",
        acceptanceCriteria: "低于 400ms",
        tags: ["新标签"],
      },
      `/${item.id}`,
      1,
    );
    expect(update.status).toBe(200);
    expect(featureItemSchema.parse(await update.json())).toMatchObject({
      currentBehavior: "新说明",
      acceptanceCriteria: "低于 400ms",
      tags: ["新标签"],
      rowVersion: 2,
      code: item.code,
      createdBy: member.userId,
    });
    const audits =
      await auditReader.sql`SELECT event_payload FROM app.audit_logs WHERE project_id = ${project.projectId} AND action = 'feature.update'`;
    expect(audits[0]?.event_payload).toMatchObject({
      before: { currentBehavior: "原说明", acceptanceCriteria: "" },
      after: { currentBehavior: "新说明", acceptanceCriteria: "低于 400ms" },
    });
    expect(
      await client.sql`SELECT id FROM app.change_records WHERE project_id = ${project.projectId}`,
    ).toHaveLength(0);
    await error(
      await request(
        project,
        "PATCH",
        member,
        { name: "旧版本" },
        `/${item.id}`,
        1,
      ),
      409,
      "FEATURE_VERSION_CONFLICT",
    );
    for (const injected of [
      { code: item.code },
      { moduleId: project.moduleId },
      { projectId: project.projectId },
      { createdBy: member.userId },
    ])
      await error(
        await request(project, "POST", member, { name: "注入", ...injected }),
        422,
      );
  });

  it("orders the feature list by lifecycle rank then newest-first creation: 进行中、未开始", async () => {
    const { member, project } = await fixture();
    // 创建顺序刻意与目标顺序相反：若排序键没生效，断言会退化成「按 id 升序」。
    const notStarted = await create(project, member, "未开始功能");
    // ADR-045：功能不再有归档态，排序档位只剩进行中与未开始。
    const active = await create(project, member, "进行中功能");
    // 功能下有一条已完成的有效任务，作用域内即「进行中」。
    // app.tasks 的状态历史不变量要求任务行与最后一条 task_status_history 对齐，
    // 同一语句里带上完工快照，夹具才能落库。
    await client.sql`
      WITH created AS (
        INSERT INTO app.tasks (
          project_id, module_id, feature_id, scope_type, code, title,
          work_status, completion_note, completed_at, creator_id
        ) VALUES (
          ${project.projectId}, ${project.moduleId}, ${active.id}, 'FEATURE',
          ${project.code + "-T-1"}, '已完成任务', 'DONE', '已完成', now(),
          ${member.userId}
        )
        RETURNING id, project_id, completed_at, completion_note
      ),
      assignees AS (
        INSERT INTO app.task_assignees (task_id, user_id, project_id)
        SELECT id, ${member.userId}, project_id FROM created
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status,
        completed_at_snapshot, completion_note_snapshot, changed_by
      )
      SELECT id, project_id, NULL, 'DONE', completed_at, completion_note,
             ${member.userId}
        FROM created
    `;

    // ADR-046：与 notStarted 同属「未开始」档但创建更晚，应排在它前面。
    const newerNotStarted = await create(project, member, "更晚建的未开始功能");

    const items = featureListResponseSchema.parse(
      await (await request(project, "GET", member)).json(),
    ).items;
    expect(items.map((item) => item.id)).toEqual([
      active.id,
      newerNotStarted.id,
      notStarted.id,
    ]);
  });

  it("allocates unique project-wide numbers concurrently across modules and allows identical names", async () => {
    const { member, project } = await fixture();
    const [module] = await client.sql<
      { id: number }[]
    >`INSERT INTO app.modules (project_id, name, created_by) VALUES (${project.projectId}, '另一模块', ${member.userId}) RETURNING id`;
    const items = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        create(i % 2 ? { ...project, moduleId: module!.id } : project, member),
      ),
    );
    expect(new Set(items.map((item) => item.code)).size).toBe(12);
    expect(
      items.every((item) => item.code.startsWith(`${project.code}-F-`)),
    ).toBe(true);
  });

  it("filters keyword candidates by project before limit, still permits creating the same name", async () => {
    const { member, project } = await fixture();
    const other = await fixture();
    await create(other.project, other.member);
    const item = await create(project, member);
    const response = await request(
      project,
      "GET",
      member,
      undefined,
      "/similar?q=" + encodeURIComponent("退款"),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      featureListResponseSchema
        .parse(await response.json())
        .items.map((value) => value.id),
    ).toEqual([item.id]);
    await create(project, member);
    await error(
      await request(project, "GET", other.member, undefined, "/similar?q=退款"),
      404,
    );
    await error(
      await request(project, "GET", member, undefined, "/similar?q=x"),
      422,
    );
  });

  it("hides cross-project/cross-module resources and rejects anonymous, removed and nonmembers", async () => {
    const { member, project } = await fixture();
    const other = await fixture();
    const item = await create(project, member);
    const admin = await actor(true);
    for (const suffix of ["", `/${item.id}`, "/similar?q=退款"]) {
      await error(
        await request(project, "GET", undefined, undefined, suffix),
        401,
      );
      await error(
        await request(project, "GET", other.member, undefined, suffix),
        404,
      );
    }
    await error(
      await request(project, "POST", undefined, { name: "匿名" }),
      401,
    );
    await error(
      await request(
        { ...project, moduleId: other.project.moduleId },
        "GET",
        admin,
        undefined,
        `/${item.id}`,
      ),
      404,
    );
    await error(
      await request(
        other.project,
        "PATCH",
        admin,
        { name: "越界" },
        `/${item.id}`,
        1,
      ),
      404,
    );
    const [module] = await client.sql<
      { id: number }[]
    >`INSERT INTO app.modules (project_id, name, created_by) VALUES (${project.projectId}, '其他模块', ${member.userId}) RETURNING id`;
    await error(
      await request(
        { ...project, moduleId: module!.id },
        "PATCH",
        member,
        { name: "错误模块" },
        `/${item.id}`,
        1,
      ),
      404,
    );
    await removeMember(client.sql, project.projectId, member.userId);
    await error(
      await request(project, "GET", member, undefined, `/${item.id}`),
      404,
    );
    await error(
      await request(project, "POST", member, { name: "已移除" }),
      404,
    );
    expect(
      (await request(project, "GET", admin, undefined, `/${item.id}`)).status,
    ).toBe(200);
  });

  it("replays same semantic key and rejects changes, stale If-Match and revoked result access", async () => {
    const { member, project } = await fixture();
    const key = randomUUID();
    const first = await request(
      project,
      "POST",
      member,
      { name: "幂等" },
      "",
      undefined,
      key,
    );
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(
      await (
        await request(
          project,
          "POST",
          member,
          { name: " 幂等 ", currentBehavior: "", tags: [] },
          "",
          undefined,
          key,
        )
      ).json(),
    ).toEqual(body);
    await error(
      await request(
        project,
        "POST",
        member,
        { name: "变化" },
        "",
        undefined,
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
        { name: "幂等" },
        "",
        undefined,
        key,
      ),
      404,
    );
  });

  it("removes feature archive entirely: no archive routes, no status field and always writable (ADR-045)", async () => {
    const { member, project } = await fixture();
    const admin = await actor(true);
    const item = await create(project, member);
    // 功能下补一条已完成的有效任务，用于断言新增的 completedTaskCount。
    await client.sql`
      WITH created AS (
        INSERT INTO app.tasks (
          project_id, module_id, feature_id, scope_type, code, title,
          work_status, completion_note, completed_at, creator_id
        ) VALUES (
          ${project.projectId}, ${project.moduleId}, ${item.id}, 'FEATURE',
          ${project.code + "-T-1"}, '已完成任务', 'DONE', '已完成', now(),
          ${member.userId}
        )
        RETURNING id, project_id, completed_at, completion_note
      ),
      assignees AS (
        INSERT INTO app.task_assignees (task_id, user_id, project_id)
        SELECT id, ${member.userId}, project_id FROM created
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status,
        completed_at_snapshot, completion_note_snapshot, changed_by
      )
      SELECT id, project_id, NULL, 'DONE', completed_at, completion_note,
             ${member.userId}
        FROM created
    `;
    const detail = featureItemSchema.parse(
      await (
        await request(project, "GET", member, undefined, `/${item.id}`)
      ).json(),
    );
    // 响应里既没有 status 也没有 archivedAt：功能档案不再有归档态。
    expect(detail).not.toHaveProperty("status");
    expect(detail).not.toHaveProperty("archivedAt");
    expect(detail.stats.completedTaskCount).toBe(1);
    // 归档与恢复路由已随 Controller 与 Route Registry 一并删除。
    for (const action of ["archive", "restore"] as const)
      expect(
        (
          await request(
            project,
            "POST",
            admin,
            { reason: "归档" },
            `/${item.id}/${action}`,
            1,
          )
        ).status,
      ).toBe(404);
    // 归属链上已无归档只读态：写检查恒为 allowed。
    expect(
      await uow.run((tx) =>
        new PostgresFeatureQueryPort().checkFeatureForWrite(tx, {
          ...project,
          featureId: item.id,
        }),
      ),
    ).toMatchObject({ kind: "allowed" });
    // 父级模块改名后功能仍然可写，row_version 正常递增。
    await client.sql`UPDATE app.modules SET name = '改名模块', row_version = row_version + 1 WHERE id = ${project.moduleId}`;
    const edited = await request(
      project,
      "PATCH",
      member,
      { name: "父级仍可写" },
      `/${item.id}`,
      1,
    );
    expect(edited.status, await edited.clone().text()).toBe(200);
  });

  it.each(["audit", "activity", "search"] as const)(
    "rolls back business, code, audit, projections and idempotency on %s failure",
    async (writer) => {
      const { member, project } = await fixture();
      const key = randomUUID();
      if (writer === "audit")
        vi.spyOn(audit, "append").mockRejectedValueOnce(new Error("failure"));
      else if (writer === "activity")
        vi.spyOn(activity, "append").mockRejectedValueOnce(
          new Error("failure"),
        );
      else
        vi.spyOn(search, "upsert").mockRejectedValueOnce(new Error("failure"));
      await error(
        await request(
          project,
          "POST",
          member,
          { name: "回滚" },
          "",
          undefined,
          key,
        ),
        500,
      );
      for (const table of [
        "features",
        "activity_projection",
        "search_projection",
      ])
        expect(
          await client.sql`SELECT 1 FROM ${client.sql(`app.${table}`)} WHERE project_id = ${project.projectId}`,
        ).toHaveLength(0);
      expect(
        await client.sql`SELECT entity_type,last_number FROM app.code_sequences WHERE project_id=${project.projectId}`,
      ).toEqual([{ entity_type: "MODULE", last_number: 1 }]);
      expect(
        await auditReader.sql`SELECT 1 FROM app.audit_logs WHERE project_id = ${project.projectId}`,
      ).toHaveLength(0);
      expect(
        await client.sql`SELECT 1 FROM app.idempotency_records WHERE idempotency_key = ${key}`,
      ).toHaveLength(0);
      expect(
        (
          await request(
            project,
            "POST",
            member,
            { name: "回滚" },
            "",
            undefined,
            key,
          )
        ).status,
      ).toBe(200);
    },
  );

  it("waits on a real module row lock then commits the released child write", async () => {
    const { member, project } = await fixture();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      acquired = r;
    });
    const parent = uow.run(async (tx) => {
      await tx.sql`SELECT id FROM app.projects WHERE id = ${project.projectId} FOR SHARE`;
      await tx.sql`SELECT id FROM app.modules WHERE id = ${project.moduleId} FOR UPDATE`;
      acquired();
      await gate;
      // ADR-044：模块命令只剩改名，父级写不再把子级置为只读。
      await tx.sql`UPDATE app.modules SET name = '锁竞争改名', row_version = row_version + 1 WHERE id = ${project.moduleId}`;
    });
    await ready;
    const child = request(project, "POST", member, { name: "锁竞争" });
    try {
      await vi.waitFor(
        async () => {
          const rows =
            await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name = 'inpulse-f13-http' AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 4000, interval: 30 },
      );
    } finally {
      release();
      await parent;
    }
    expect((await child).status, await (await child).clone().text()).toBe(200);
    expect(
      await client.sql`SELECT id FROM app.features WHERE project_id = ${project.projectId}`,
    ).toHaveLength(1);
  });
});

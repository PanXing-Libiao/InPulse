import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import {
  moduleItemSchema,
  moduleListResponseSchema,
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
import { ModuleManagementRepository } from "../src/modules/modules/module-management.repository.js";
import { ModulesManagementService } from "../src/modules/modules/modules-management.service.js";
import { ModulesHttpService } from "../src/modules/modules/modules-http.service.js";
import { ModulesController } from "../src/modules/modules/modules.controller.js";
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
let management: ModulesManagementService;
let audit: PostgresAuditWritePort;
let search: PostgresSearchProjectionWritePort;
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
    applicationName: "inpulse-f12-http",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f12-audit-evidence",
  });
  uow = new PostgresUnitOfWork(client);
  const sessions = new PostgresUserSessionRepository();
  const csrf = new PostgresSessionCsrfTokenRepository();
  const auth = new SessionAuthService(uow, sessions, tokens);
  audit = new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key });
  search = new PostgresSearchProjectionWritePort();
  management = new ModulesManagementService(
    new PostgresProjectAccessQueryPort(client),
    uow,
    new ModuleManagementRepository(),
    audit,
    new PostgresActivityWritePort(),
    search,
    postgresProjectMemberPermissions(),
  );
  const http = new ModulesHttpService(
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
    controllers: [ModulesController],
    providers: [{ provide: ModulesHttpService, useValue: http }],
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
  projectId: number,
  method: string,
  who?: Actor,
  body?: unknown,
  suffix = "",
  version?: number,
  idempotencyKey = randomUUID(),
) {
  return fetch(`${base}/api/v1/projects/${projectId}/modules${suffix}`, {
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
  });
}
async function error(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  const body = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  if (code) expect(body.code).toBe(code);
  expect(JSON.stringify(body)).not.toMatch(
    /INSERT INTO|SELECT |stack|constraint_name/,
  );
}

describe("F-12 real HTTP + PostgreSQL", () => {
  it("creates NORMAL, edits UNCLASSIFIED, exposes only contract DTOs and keeps sort order", async () => {
    const { member, project } = await fixture();
    const created = await request(project.projectId, "POST", member, {
      name: "普通",
      description: "说明",
    });
    expect(created.status).toBe(200);
    const module = moduleItemSchema.parse(await created.json());
    expect(module.kind).toBe("NORMAL");
    const updated = await request(
      project.projectId,
      "PATCH",
      member,
      { name: "新的未分类名称", description: "允许修改" },
      `/${project.moduleId}`,
      1,
    );
    expect(updated.status).toBe(200);
    expect(moduleItemSchema.parse(await updated.json())).toMatchObject({
      kind: "UNCLASSIFIED",
      rowVersion: 2,
    });
    const listing = await request(project.projectId, "GET", member);
    expect(listing.status).toBe(200);
    const items = moduleListResponseSchema.parse(await listing.json()).items;
    // ADR-046：两个模块都还没有完成任务（同属「未开始」档），同档位内按创建时间
    // 从近到远，因此后建的 module 排在创建项目时自动生成的未分类模块之前。
    expect(items.map((item) => item.id)).toEqual([module.id, project.moduleId]);
  });
  it("orders module cards by derived lifecycle band and counts completed tasks", async () => {
    const { member, project } = await fixture();
    const started = moduleItemSchema.parse(
      await (
        await request(project.projectId, "POST", member, { name: "已开始模块" })
      ).json(),
    );
    const notStarted = moduleItemSchema.parse(
      await (
        await request(project.projectId, "POST", member, { name: "未开始模块" })
      ).json(),
    );
    // 只有「已开始模块」下有已完成任务，其余模块都没有。
    await client.sql`
      WITH created AS (
        INSERT INTO app.tasks (
          project_id, module_id, scope_type, code, title, work_status,
          completion_note, completed_at, creator_id
        )
        VALUES (
          ${project.projectId},
          ${started.id},
          'MODULE',
          ${`${project.code}-T-1`},
          '已完成任务',
          'DONE',
          '已完成',
          now(),
          ${member.userId}
        )
        RETURNING id, project_id
      ),
      assignees AS (
        INSERT INTO app.task_assignees (task_id, user_id, project_id)
        SELECT id, ${member.userId}, project_id FROM created
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status,
        completed_at_snapshot, completion_note_snapshot, changed_by
      )
      SELECT id, project_id, NULL, 'DONE', now(), '已完成', ${member.userId}
        FROM created
    `;
    const listing = await request(project.projectId, "GET", member);
    expect(listing.status).toBe(200);
    const items = moduleListResponseSchema.parse(await listing.json()).items;
    // ADR-044 / ADR-046：模块排序只剩派生档位 进行中（模块内已有完成任务）与
    // 未开始 两档，同档位内按创建时间从近到远、创建时间相同时按 ID 降序；
    // 这里 started 单独占「进行中」档，两个「未开始」模块里 notStarted 建得更晚。
    expect(items.map((item) => item.id)).toEqual([
      started.id,
      notStarted.id,
      project.moduleId,
    ]);
    expect(items.map((item) => item.stats.completedTaskCount)).toEqual([
      1, 0, 0,
    ]);
  });
  it("maps normalized duplicate names and stale versions to safe 409; rejects identity injection", async () => {
    const { member, project } = await fixture();
    expect(
      (await request(project.projectId, "POST", member, { name: "Catalog" }))
        .status,
    ).toBe(200);
    await error(
      await request(project.projectId, "POST", member, { name: " catalog " }),
      409,
      "MODULE_NAME_CONFLICT",
    );
    await error(
      await request(
        project.projectId,
        "PATCH",
        member,
        { name: "旧版本" },
        `/${project.moduleId}`,
        2,
      ),
      409,
      "MODULE_VERSION_CONFLICT",
    );
    await error(
      await request(project.projectId, "POST", member, {
        name: "非法身份",
        kind: "UNCLASSIFIED",
      }),
      422,
    );
    await error(
      await request(
        project.projectId,
        "PATCH",
        member,
        { name: "漏版本" },
        `/${project.moduleId}`,
      ),
      422,
    );
  });
  it("covers anonymous, member, other project member, removed member and admin access", async () => {
    const { member, project } = await fixture();
    const other = await fixture();
    const admin = await actor(true);
    await error(await request(project.projectId, "GET"), 401);
    await error(
      await request(project.projectId, "POST", undefined, { name: "匿名" }),
      401,
    );
    await error(await request(project.projectId, "GET", other.member), 404);
    await error(
      await request(
        other.project.projectId,
        "PATCH",
        member,
        { name: "错误归属" },
        `/${project.moduleId}`,
        1,
      ),
      404,
    );
    expect((await request(project.projectId, "GET", admin)).status).toBe(200);
    await removeMember(client.sql, project.projectId, member.userId);
    await error(await request(project.projectId, "GET", member), 404);
    await error(
      await request(project.projectId, "POST", member, { name: "移除后" }),
      404,
    );
  });
  it("serves no module archive or restore route and drops lifecycle fields from the module DTO (ADR-044)", async () => {
    const { member, project } = await fixture();
    // 归档/恢复路由已从 Route Registry、Controller 与生成客户端一并下线。
    expect(
      (
        await request(
          project.projectId,
          "POST",
          member,
          { reason: "已下线" },
          `/${project.moduleId}/archive`,
          1,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          project.projectId,
          "POST",
          member,
          { reason: "已下线" },
          `/${project.moduleId}/restore`,
          1,
        )
      ).status,
    ).toBe(404);

    // 模块只有 ACTIVE 一种状态，契约 DTO 不再暴露 status / archivedAt。
    const listed = await request(project.projectId, "GET", member);
    expect(listed.status).toBe(200);
    const items = moduleListResponseSchema.parse(await listed.json()).items;
    const item = items.find((entry) => entry.id === project.moduleId);
    expect(item?.kind).toBe("UNCLASSIFIED");
    expect(item).not.toHaveProperty("status");
    expect(item).not.toHaveProperty("archivedAt");
    // 只剩创建与更新：改名仍可按版本正常完成。
    const renamed = await request(
      project.projectId,
      "PATCH",
      member,
      { name: "模块改版", description: "" },
      `/${project.moduleId}`,
      1,
    );
    expect(renamed.status).toBe(200);
    expect(moduleItemSchema.parse(await renamed.json())).toMatchObject({
      name: "模块改版",
      rowVersion: 2,
    });
  });

  it("replays equivalent normalized requests, rejects changed input and removed membership", async () => {
    const { member, project } = await fixture();
    const key = randomUUID();
    const first = await request(
      project.projectId,
      "POST",
      member,
      { name: "幂等" },
      "",
      undefined,
      key,
    );
    expect(first.status).toBe(200);
    const body = await first.json();
    const replay = await request(
      project.projectId,
      "POST",
      member,
      { name: " 幂等 ", description: "" },
      "",
      undefined,
      key,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    await error(
      await request(
        project.projectId,
        "POST",
        member,
        { name: "不同" },
        "",
        undefined,
        key,
      ),
      409,
      "IDEMPOTENCY_REQUEST_MISMATCH",
    );
    await removeMember(client.sql, project.projectId, member.userId);
    await error(
      await request(
        project.projectId,
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
  it("replays an updateModule request by key without a second write and refuses removed membership", async () => {
    const { member, project } = await fixture();
    const admin = await actor(true);
    const key = randomUUID();
    const suffix = `/${project.moduleId}`;
    const body = { name: "重命名模块", description: "重放" };
    const first = await request(
      project.projectId,
      "PATCH",
      member,
      body,
      suffix,
      1,
      key,
    );
    expect(first.status).toBe(200);
    const cached = await first.json();
    // ADR-044：ModuleItem 去掉 status / archivedAt 后契约版本升到 1.4.0；
    // 同 Key、同摘要、同契约版本重放返回原 2xx，且不再校验 row_version。
    const replay = await request(
      project.projectId,
      "PATCH",
      member,
      body,
      suffix,
      1,
      key,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(cached);
    // 重放前重新鉴权：成员被移除后拒绝，且不泄露已存状态码或响应。
    await removeMember(client.sql, project.projectId, member.userId);
    await error(
      await request(project.projectId, "PATCH", member, body, suffix, 1, key),
      404,
    );
    // 重放没有产生第二次写入：名称与 row_version 都停在首次结果。
    const listed = await request(project.projectId, "GET", admin);
    expect(listed.status).toBe(200);
    const items = moduleListResponseSchema.parse(await listed.json()).items;
    expect(items.find((entry) => entry.id === project.moduleId)).toMatchObject({
      name: "重命名模块",
      rowVersion: 2,
    });
  });
  it.each(["audit", "search"] as const)(
    "rolls back business, audit, projections and idempotency after %s failure",
    async (failure) => {
      const { member, project } = await fixture();
      const key = randomUUID();
      if (failure === "audit")
        vi.spyOn(audit, "append").mockRejectedValueOnce(
          new Error("internal fixture failure"),
        );
      else
        vi.spyOn(search, "upsert").mockRejectedValueOnce(
          new Error("internal fixture failure"),
        );
      await error(
        await request(
          project.projectId,
          "POST",
          member,
          { name: "全部回滚" },
          "",
          undefined,
          key,
        ),
        500,
      );
      const [counts] =
        await client.sql`SELECT (SELECT count(*)::int FROM app.modules WHERE project_id = ${project.projectId}) AS modules, (SELECT count(*)::int FROM app.activity_projection WHERE project_id = ${project.projectId}) AS activities, (SELECT count(*)::int FROM app.search_projection WHERE project_id = ${project.projectId}) AS search, (SELECT count(*)::int FROM app.idempotency_records WHERE idempotency_key = ${key}) AS idempotency`;
      expect(counts).toEqual({
        modules: 1,
        activities: 0,
        search: 0,
        idempotency: 0,
      });
      const audits =
        await auditReader.sql`SELECT action FROM app.audit_logs WHERE project_id = ${project.projectId}`;
      expect(audits).toHaveLength(0);
      expect(
        (
          await request(
            project.projectId,
            "POST",
            member,
            { name: "全部回滚" },
            "",
            undefined,
            key,
          )
        ).status,
      ).toBe(200);
    },
  );
  it("runs 100 real createModule business transactions on one project audit chain without gaps or forks", async () => {
    const { member, project } = await fixture();
    const dedicatedClient = createDatabaseClient(testUrls().runtime, {
      applicationName: "inpulse-f12-audit-concurrency",
      maxConnections: 110,
    });
    const dedicatedUow = new PostgresUnitOfWork(dedicatedClient);
    const dedicatedManagement = new ModulesManagementService(
      new PostgresProjectAccessQueryPort(dedicatedClient),
      dedicatedUow,
      new ModuleManagementRepository(),
      new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key }),
      new PostgresActivityWritePort(),
      new PostgresSearchProjectionWritePort(),
      postgresProjectMemberPermissions(),
    );
    let ready = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const operations = Array.from({ length: 100 }, (_, index) =>
        dedicatedUow.run(async (tx) => {
          ready += 1;
          if (ready === 100) release?.();
          await barrier;
          return dedicatedManagement.execute(tx, {
            operation: "createModule",
            actorId: member.userId,
            projectId: project.projectId,
            edit: {
              name: `concurrent-module-${String(index + 1).padStart(3, "0")}`,
              description: "100 concurrent business transactions",
            },
            requestId: randomUUID(),
          });
        }),
      );
      const results = await Promise.all(operations);
      expect(results).toHaveLength(100);
      expect(results.every((item) => item.kind === "NORMAL")).toBe(true);
      expect(results.every((item) => item.rowVersion === 1)).toBe(true);

      const chainId = `PROJECT:${project.projectId}`;
      const auditRows = (await auditReader.sql`
        SELECT sequence_no AS "sequenceNo",
               prev_hash AS "prevHash",
               record_hash AS "recordHash",
               action,
               chain_id AS "chainId"
          FROM app.audit_logs
         WHERE project_id = ${project.projectId}
         ORDER BY sequence_no
      `) as unknown as readonly {
        sequenceNo: string;
        prevHash: Buffer;
        recordHash: Buffer;
        action: string;
        chainId: string;
      }[];
      expect(auditRows).toHaveLength(100);
      expect(
        auditRows.every(
          (row) => row.chainId === chainId && row.action === "module.create",
        ),
      ).toBe(true);

      let previousHash = Buffer.alloc(32);
      auditRows.forEach((row, index) => {
        expect(Number(row.sequenceNo)).toBe(index + 1);
        expect(Buffer.from(row.prevHash).equals(previousHash)).toBe(true);
        previousHash = Buffer.from(row.recordHash);
      });
      const [head] = (await auditReader.sql`
        SELECT last_sequence AS "lastSequence", last_hash AS "lastHash"
          FROM app.audit_chain_heads
         WHERE chain_id = ${chainId}
      `) as unknown as readonly {
        lastSequence: string;
        lastHash: Buffer;
      }[];
      expect(Number(head?.lastSequence)).toBe(100);
      expect(Buffer.from(head?.lastHash ?? [])).toEqual(previousHash);

      const [counts] = (await client.sql`
        SELECT
          (SELECT count(*)::INTEGER
             FROM app.modules
            WHERE project_id = ${project.projectId}) AS modules,
          (SELECT count(*)::INTEGER
             FROM app.activity_projection
            WHERE project_id = ${project.projectId}) AS activities,
          (SELECT count(*)::INTEGER
             FROM app.search_projection
            WHERE project_id = ${project.projectId}) AS search
      `) as unknown as readonly {
        modules: number;
        activities: number;
        search: number;
      }[];
      expect(counts).toEqual({ modules: 101, activities: 100, search: 100 });
    } finally {
      await dedicatedClient.close();
    }
  });
  it("父级 FOR UPDATE 阻塞子级写入，释放后按当前状态提交", async () => {
    const { member, project } = await fixture();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const parent = uow.run(async (tx) => {
      await tx.sql`SELECT id FROM app.projects WHERE id = ${project.projectId} FOR UPDATE`;
      acquired();
      await gate;
    });
    await ready;
    const child = request(project.projectId, "POST", member, {
      name: "竞争写入",
    });
    try {
      await vi.waitFor(
        async () => {
          const rows =
            await client.sql`SELECT pid FROM pg_stat_activity WHERE application_name = 'inpulse-f12-http' AND wait_event_type = 'Lock'`;
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 4000, interval: 30 },
      );
    } finally {
      release();
      await parent;
    }
    expect((await child).status).toBe(200);
    expect(
      (await management.list(member.userId, project.projectId)).items,
    ).toHaveLength(2);
  });
});

import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { schemaRegistry } from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { ProjectManagementController } from "../src/modules/projects/project-management.controller.js";
import { ProjectManagementHttpService } from "../src/modules/projects/project-management-http.service.js";
import { ProjectManagementService } from "../src/modules/projects/project-management.service.js";
import { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import { ProjectStartNotifier } from "../src/modules/projects/project-start.notifier.js";
import { ProjectWrapNotifier } from "../src/modules/projects/project-wrap.notifier.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

/**
 * ADR-062 / ADR-085：项目删除是**物理删除**——一个事务内清空项目行与全部下级业务
 * 数据，但项目自己的 `PROJECT:<id>` 审计日志与链头保留为只读历史；SYSTEM 链另写
 * 一条 `project.delete`（操作者、编码、名称、状态、删除行数与保留审计行数），仅
 * 系统管理员可在审计日志中查看。项目删除后不写动态、不发通知，项目编码随行释放。
 *
 * ADR-051 的还原（`restoreProject`）与彻底删除（`purgeProject`）两条命令、删除
 * 台账（`listProjectDeletions`）与 ADR-055 的保留期自动清理都已整体下线，本文件
 * 不再覆盖它们；任务（ADR-058）与模块/功能（ADR-059）的软删除不受影响。
 */
let client: DatabaseClient;
let auditReader: DatabaseClient;
let auditWriter: PostgresAuditWritePort;
let unitOfWork: PostgresUnitOfWork;
let access: PostgresProjectAccessQueryPort;
let members: PostgresProjectMembersQueryPort;
let app: INestApplication | undefined;
let base: string;

const key = randomBytes(32);
const tokens = new SessionTokenService(
  VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
);

interface Actor {
  readonly userId: number;
  readonly cookie: string;
  readonly csrf: string;
}

interface Fixture {
  readonly owner: Actor;
  readonly project: ProjectFixture;
}

async function actor(admin = false): Promise<Actor> {
  const userId = await createUser(client.sql, { admin });
  const cookie = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const [session] = await client.sql<Array<{ id: number }>>`
    INSERT INTO app.user_sessions (
      user_id,
      token_hash,
      token_hash_key_version,
      auth_version_at_issue,
      auth_state,
      idle_expires_at,
      absolute_expires_at
    )
    VALUES (
      ${userId},
      ${tokens.hash(cookie).hash},
      1,
      1,
      'AUTHENTICATED',
      now() + interval '1 hour',
      now() + interval '1 day'
    )
    RETURNING id
  `;
  await client.sql`
    INSERT INTO app.session_csrf_tokens (session_id, token_hash, expires_at)
    VALUES (
      ${session!.id},
      ${tokens.hash(csrf).hash},
      now() + interval '1 hour'
    )
  `;
  return { userId, cookie: `__Host-session=${cookie}`, csrf };
}

async function fixture(): Promise<Fixture> {
  const owner = await actor(false);
  const project = await createProject(client.sql, owner.userId);
  return { owner, project };
}

/** 把用户加入项目；默认普通成员，`role` 可显式指定组长。 */
async function join(
  projectId: number,
  userId: number,
  role: "MEMBER" | "LEADER" = "MEMBER",
): Promise<void> {
  await client.sql.begin(async (transaction) => {
    if (role === "LEADER") {
      await transaction`
        UPDATE app.project_members
           SET role = 'MEMBER'
         WHERE project_id = ${projectId}
           AND status = 'ACTIVE'
           AND role = 'LEADER'
      `;
    }
    await transaction`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${projectId}, ${userId}, ${role})
    `;
  });
}

async function request(
  method: string,
  path: string,
  who?: Actor,
  options: {
    readonly key?: string;
    readonly csrf?: string;
    readonly body?: unknown;
    readonly omitCsrf?: boolean;
    readonly omitIdempotency?: boolean;
    readonly omitIfMatch?: boolean;
    readonly ifMatch?: string;
    readonly contentType?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: base,
    "sec-fetch-site": "same-origin",
    ...(who === undefined ? {} : { cookie: who.cookie }),
    ...(options.omitCsrf === true
      ? {}
      : { "x-csrf-token": options.csrf ?? who?.csrf ?? "" }),
    ...(options.omitIfMatch === true
      ? {}
      : { "if-match": options.ifMatch ?? '"1"' }),
    ...(options.omitIdempotency === true
      ? {}
      : { "Idempotency-Key": options.key ?? randomUUID() }),
    ...(options.contentType === undefined
      ? {}
      : { "content-type": options.contentType }),
  };
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  expect(body.code).toBe(code);
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
  expect(JSON.stringify(body)).not.toMatch(
    /INSERT INTO|SELECT |stack|constraint_name/i,
  );
}

/** 项目是否仍能从授权范围、写前校验与成员列表读到。 */
async function visibility(
  projectId: number,
  userId: number,
): Promise<{
  readonly inSearchScope: boolean;
  readonly writable: string;
  readonly memberProfiles: number;
}> {
  return unitOfWork.run(async (tx) => {
    const scope = await access.getAuthorizedSearchScope(userId);
    const check = await access.checkProjectForWrite(tx, {
      actorUserId: userId,
      projectId,
    });
    const profiles = await members.listActiveMemberProfiles(tx, {
      actorUserId: userId,
      projectId,
    });
    return {
      inSearchScope: scope.projectIds.includes(projectId),
      writable: check.kind,
      // undefined 表示项目不可访问，用 -1 与「空列表」区分开。
      memberProfiles: profiles?.length ?? -1,
    };
  });
}

/** 项目行是否还在；物理删除后必须为 false。 */
async function projectExists(projectId: number): Promise<boolean> {
  const rows = (await client.sql`
    SELECT count(*) AS "count" FROM app.projects WHERE id = ${projectId}
  `) as unknown as readonly { count: string }[];
  return rows[0]!.count !== "0";
}

/** 在项目链写一条审计，验证项目删除只清业务数据、不抹审计历史。 */
async function seedProjectAudit(
  project: ProjectFixture,
  actorId: number,
): Promise<void> {
  await unitOfWork.run((tx) =>
    auditWriter.append(tx, {
      projectId: project.projectId,
      actorType: "USER",
      actorId,
      action: "PROJECT_DELETE_RETENTION_SEED",
      targetType: "PROJECT",
      targetId: String(project.projectId),
      eventPayload: { code: project.code },
      requestId: `project-delete-audit-${randomUUID()}`,
    }),
  );
}

/**
 * 给项目造功能、任务、任务组关系与迭代记录草稿：物理删除的外键顺序与行数统计
 * 才有真实数据可删。夹具直接写表、不走命令，因此不产生通知与动态。
 *
 * 任务必须在**同一事务内**补状态历史：`tasks` 上有延迟约束触发器，提交时没有
 * 历史行就会报 `task N must have status history`。
 */
async function seedPurgeableRecords(
  project: ProjectFixture,
  actorId: number,
): Promise<void> {
  await client.sql.begin(async (transaction) => {
    const [feature] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.features (project_id, module_id, code, name, created_by)
      VALUES (${project.projectId}, ${project.moduleId}, ${`${project.code}-F-1`}, ${"删除级联用功能"}, ${actorId})
      RETURNING id
    `;
    const [main] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.tasks (project_id, module_id, feature_id, scope_type, code, title, creator_id)
      VALUES (${project.projectId}, ${project.moduleId}, ${feature!.id}, 'FEATURE', ${`${project.code}-T-1`}, ${"删除级联用主任务"}, ${actorId})
      RETURNING id
    `;
    const [source] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.tasks (project_id, module_id, feature_id, scope_type, code, title, creator_id)
      VALUES (${project.projectId}, ${project.moduleId}, ${feature!.id}, 'FEATURE', ${`${project.code}-T-2`}, ${"删除级联用来源任务"}, ${actorId})
      RETURNING id
    `;
    await transaction`
      INSERT INTO app.task_status_history (task_id, project_id, from_work_status, to_work_status, changed_by)
      VALUES (${main!.id}, ${project.projectId}, NULL, 'TODO', ${actorId}),
             (${source!.id}, ${project.projectId}, NULL, 'TODO', ${actorId})
    `;
    const [group] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.task_groups (project_id, code, name, created_by)
      VALUES (${project.projectId}, ${`${project.code}-TG-1`}, ${"删除级联用任务组"}, ${actorId})
      RETURNING id
    `;
    await transaction`
      INSERT INTO app.task_group_members (group_id, task_id, project_id, role)
      VALUES (${group!.id}, ${main!.id}, ${project.projectId}, 'MAIN')
    `;
    await transaction`
      INSERT INTO app.task_group_members (
        group_id,
        task_id,
        project_id,
        role,
        source_kind,
        original_work_status,
        original_assignee_id
      )
      VALUES (${group!.id}, ${source!.id}, ${project.projectId}, 'SOURCE', 'ACTIVE', 'TODO', ${actorId})
    `;
    await transaction`
      INSERT INTO app.change_records (project_id, module_id, scope_type, title, handler_id, author_id)
      VALUES (${project.projectId}, ${project.moduleId}, 'MODULE', ${"删除级联用迭代记录"}, ${actorId}, ${actorId})
    `;
  });
}

async function seedProjectWrap(
  project: ProjectFixture,
  actorId: number,
): Promise<void> {
  await client.sql`
    INSERT INTO app.project_wraps (
      project_id, sealed_at, sealed_by, sealed_by_snapshot,
      template_version, snapshot
    )
    SELECT p.id,
           now(),
           ${actorId},
           jsonb_build_object('id', ${actorId}::integer, 'name', u.name),
           1,
           jsonb_build_object(
             'version', 1,
             'project', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name),
             'stats', jsonb_build_object(),
             'participants', '[]'::jsonb,
             'timeline', jsonb_build_object()
           )
      FROM app.projects p
      JOIN app.users u ON u.id = ${actorId}
     WHERE p.id = ${project.projectId}
  `;
}

/** 走夹具之外的路径重建项目行，用于验证编码已随物理删除释放。 */
async function insertProjectWithCode(
  code: string,
  ownerUserId: number,
): Promise<number> {
  return client.sql.begin(async (transaction) => {
    const [project] = await transaction<Array<{ id: number }>>`
      INSERT INTO app.projects (code, name, created_by)
      VALUES (${code}, ${`Project ${code}`}, ${ownerUserId})
      RETURNING id
    `;
    await transaction`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${project!.id}, ${ownerUserId}, 'LEADER')
    `;
    await transaction`
      INSERT INTO app.modules (project_id, name, kind, created_by)
      VALUES (${project!.id}, '未分类', 'UNCLASSIFIED', ${ownerUserId})
    `;
    return project!.id;
  });
}

/** `app.purge_project` 逐表删除的全部位置，用于验证「删除后全表无残留」。 */
const PROJECT_SCOPED_TABLES = [
  "modules",
  "features",
  "tasks",
  "task_groups",
  "task_group_members",
  "task_status_history",
  "task_assignees",
  "task_feature_impacts",
  "task_external_links",
  "change_records",
  "change_record_versions",
  "change_record_leftover_items",
  "change_record_feature_impacts",
  "change_record_external_links",
  "change_record_version_leftovers",
  "leftover_task_links",
  "feature_external_links",
  "project_external_links",
  "external_links",
  "project_archive_requests",
  "code_sequences",
  "project_members",
  "notifications",
  "activity_projection",
  "search_projection",
] as const;

/** 审计表只有 `audit_reader` 可读，运行时角色没有 SELECT。 */
const PROJECT_AUDIT_TABLES = ["audit_logs", "audit_chain_heads"] as const;

/** 按项目统计各表行数；表名来自上面的常量、ID 来自夹具自增主键，不拼接外部输入。 */
async function countProjectRows(
  sql: Sql,
  tables: readonly string[],
  projectId: number,
): Promise<Record<string, number>> {
  const id = Math.trunc(projectId);
  const union = tables
    .map(
      (table) =>
        `SELECT '${table}' AS table_name, count(*)::integer AS row_count FROM app.${table} WHERE project_id = ${id}`,
    )
    .join(" UNION ALL ");
  const rows = (await sql.unsafe(
    `SELECT * FROM (${union}) AS counts`,
  )) as unknown as readonly {
    readonly table_name: string;
    readonly row_count: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.table_name, row.row_count]));
}

/** 业务表由运行时角色统计，审计表由只读角色统计，避免把保留与删除混在一起。 */
async function projectBusinessRowCounts(
  projectId: number,
): Promise<Record<string, number>> {
  return countProjectRows(client.sql, PROJECT_SCOPED_TABLES, projectId);
}

async function projectAuditRowCounts(
  projectId: number,
): Promise<Record<string, number>> {
  return countProjectRows(auditReader.sql, PROJECT_AUDIT_TABLES, projectId);
}

/** `PROJECT:<id>` 审计链表头是否还在；ADR-085 要求项目删除后仍然存在。 */
async function projectChainHeadExists(projectId: number): Promise<boolean> {
  const rows = (await auditReader.sql`
    SELECT count(*) AS "count"
      FROM app.audit_chain_heads
     WHERE chain_id = ${`PROJECT:${String(projectId)}`}
  `) as unknown as readonly { count: string }[];
  return rows[0]!.count !== "0";
}

/** SYSTEM 链表头仍与链上最后一条记录对齐（项目链的删除不得影响系统链）。 */
async function systemChainHealthy(): Promise<boolean> {
  const rows = (await auditReader.sql`
    SELECT h.last_hash = last_row.record_hash AS "hashMatches",
           h.last_sequence = last_row.sequence_no AS "sequenceMatches"
      FROM app.audit_chain_heads h
      JOIN LATERAL (
        SELECT sequence_no, record_hash
          FROM app.audit_logs
         WHERE chain_id = 'SYSTEM'
         ORDER BY sequence_no DESC
         LIMIT 1
      ) AS last_row ON true
     WHERE h.chain_id = 'SYSTEM'
  `) as unknown as readonly {
    hashMatches: boolean;
    sequenceMatches: boolean;
  }[];
  return rows.length === 1 && rows[0]!.hashMatches && rows[0]!.sequenceMatches;
}

beforeAll(async () => {
  const urls = testUrls();
  client = createDatabaseClient(urls.runtime, {
    applicationName: "inpulse-adr062-project-delete",
  });
  auditReader = createDatabaseClient(urls.auditReader, {
    applicationName: "inpulse-adr062-project-delete-audit",
  });
  unitOfWork = new PostgresUnitOfWork(client);
  access = new PostgresProjectAccessQueryPort(client);
  members = new PostgresProjectMembersQueryPort();

  const csrf = new PostgresSessionCsrfTokenRepository();
  const auth = new SessionAuthService(
    unitOfWork,
    new PostgresUserSessionRepository(),
    tokens,
  );
  auditWriter = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key,
  });
  const service = new ProjectManagementService(
    new PostgresProjectsWritePort(),
    access,
    auditWriter,
    new PostgresActivityWritePort(),
    new PostgresSearchProjectionWritePort(),
    members,
    new ProjectRoleGateService(
      access,
      members,
      postgresProjectMemberPermissions(),
    ),
    postgresProjectMemberPermissions(),
    new ProjectStartNotifier(
      members,
      new ProjectNotificationDispatcher(
        access,
        new PostgresNotificationWritePort(),
      ),
    ),
    new ProjectWrapNotifier(members, new PostgresNotificationWritePort()),
  );
  const http = new ProjectManagementHttpService(
    new AuthenticatedMutationService(auth, csrf, tokens),
    new IdempotencyHttpService(
      new IdempotencyRunner(unitOfWork, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
    service,
  );

  class TestModule {}
  Module({
    controllers: [ProjectManagementController],
    providers: [{ provide: ProjectManagementHttpService, useValue: http }],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
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

describe("ADR-062 project delete API", () => {
  it("组长删除项目：204 无正文、下级业务数据清空、项目审计链保留、SYSTEM 链留一条 project.delete", async () => {
    const value = await fixture();
    const projectId = value.project.projectId;
    const path = `/projects/${projectId}`;
    await seedPurgeableRecords(value.project, value.owner.userId);
    await seedProjectAudit(value.project, value.owner.userId);
    await seedProjectWrap(value.project, value.owner.userId);

    const beforeWraps = (await client.sql`
      SELECT count(*)::int AS "total"
        FROM app.project_wraps
       WHERE project_id = ${projectId}
    `) as unknown as readonly { total: number }[];
    expect(beforeWraps[0]!.total).toBe(1);

    const before = await projectBusinessRowCounts(projectId);
    const beforeAudit = await projectAuditRowCounts(projectId);
    const expectedTotal = Object.values(before).reduce(
      (sum, count) => sum + count,
      0,
    );
    // 审计快照记录的是删除前的真实状态，按夹具实际值断言而不是写死常量。
    const [statusRow] = (await client.sql`
      SELECT status FROM app.projects WHERE id = ${projectId}
    `) as unknown as readonly { readonly status: string }[];
    expect(expectedTotal).toBeGreaterThan(0);
    // 业务表确实有行，项目链也确实已有一条审计；删除后分别验证归零与保留。
    expect(before).toMatchObject({
      modules: 1,
      features: 1,
      tasks: 2,
      task_status_history: 2,
      task_groups: 1,
      task_group_members: 2,
      change_records: 1,
      project_members: 1,
      notifications: 0,
      activity_projection: 0,
    });
    expect(beforeAudit).toEqual({ audit_logs: 1, audit_chain_heads: 1 });

    const deleted = await request("DELETE", path, value.owner);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(deleted.headers.get("content-type")).toBeNull();

    // 项目行与全部下级业务数据消失，但项目自己的审计日志与链头原样保留。
    expect(await projectExists(projectId)).toBe(false);
    expect(await projectChainHeadExists(projectId)).toBe(true);
    const afterWraps = (await client.sql`
      SELECT count(*)::int AS "total"
        FROM app.project_wraps
       WHERE project_id = ${projectId}
    `) as unknown as readonly { total: number }[];
    expect(afterWraps[0]!.total).toBe(0);
    expect(await projectBusinessRowCounts(projectId)).toEqual(
      Object.fromEntries(PROJECT_SCOPED_TABLES.map((table) => [table, 0])),
    );
    expect(await projectAuditRowCounts(projectId)).toEqual(beforeAudit);

    // 删除后项目退出全部读取路径：组长自己也读不到、写不进、成员列表读不到。
    expect(await visibility(projectId, value.owner.userId)).toMatchObject({
      inSearchScope: false,
      writable: "not-found",
      memberProfiles: -1,
    });

    // SYSTEM 链上的 project.delete 记录本次操作与保留的审计行数。
    const systemLogs = (await auditReader.sql`
      SELECT project_id AS "projectId",
             actor_type AS "actorType",
             actor_id AS "actorId",
             target_type AS "targetType",
             target_id AS "targetId",
             event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE chain_id = 'SYSTEM'
         AND action = 'project.delete'
         AND target_id = ${String(projectId)}
    `) as unknown as readonly {
      projectId: number | null;
      actorType: string;
      actorId: number | null;
      targetType: string;
      targetId: string;
      eventPayload: {
        readonly code: string;
        readonly name: string;
        readonly status: string;
        readonly rowVersion: number;
        readonly actorRole: string;
        readonly records: Readonly<Record<string, number>>;
      };
    }[];
    expect(systemLogs).toHaveLength(1);
    expect(systemLogs[0]).toMatchObject({
      projectId: null,
      actorType: "USER",
      actorId: value.owner.userId,
      targetType: "PROJECT",
      targetId: String(projectId),
      eventPayload: {
        code: value.project.code,
        name: `Project ${value.project.code}`,
        status: statusRow?.status,
        rowVersion: 1,
        actorRole: "LEADER",
        records: {
          modules: before.modules,
          features: before.features,
          tasks: before.tasks,
          changeRecords: before.change_records,
          retainedAuditLogs: beforeAudit.audit_logs,
          members: before.project_members,
          total: expectedTotal,
        },
      },
    });

    // 保留项目审计链不得影响 SYSTEM 链的完整性。
    expect(await systemChainHealthy()).toBe(true);
  });

  it("普通成员 403、非成员与已移除成员 404、系统管理员放行；失败路径零副作用", async () => {
    const value = await fixture();
    const projectId = value.project.projectId;
    const path = `/projects/${projectId}`;
    const member = await actor(false);
    const outsider = await actor(false);
    const removed = await actor(false);
    const admin = await actor(true);
    await join(projectId, member.userId);
    await join(projectId, removed.userId);
    await removeMember(client.sql, projectId, removed.userId);

    await expectError(
      await request("DELETE", path, member),
      403,
      "PROJECT_DELETE_FORBIDDEN",
    );
    await expectError(
      await request("DELETE", path, outsider),
      404,
      "PROJECT_NOT_FOUND",
    );
    await expectError(
      await request("DELETE", path, removed),
      404,
      "PROJECT_NOT_FOUND",
    );

    // 失败路径不得留下副作用：项目与全部下级数据仍在，版本号未变。
    expect(await projectExists(projectId)).toBe(true);
    expect(await visibility(projectId, value.owner.userId)).toMatchObject({
      inSearchScope: true,
      writable: "allowed",
      memberProfiles: 2,
    });
    const counts = await projectBusinessRowCounts(projectId);
    // 失败路径零副作用：成员行仍是组长 + 成员 + 已移除成员三条。
    expect(counts).toMatchObject({ modules: 1, project_members: 3 });
    expect(await projectChainHeadExists(projectId)).toBe(false);

    // 系统管理员即使不是成员也可以删除。
    expect((await request("DELETE", path, admin)).status).toBe(204);
    expect(await projectExists(projectId)).toBe(false);
  });

  it("同 Key 同摘要重放已存的 204；摘要不一致 409；换 Key 按不存在处理", async () => {
    const value = await fixture();
    const projectId = value.project.projectId;
    const path = `/projects/${projectId}`;
    const deleteKey = randomUUID();

    expect(
      (await request("DELETE", path, value.owner, { key: deleteKey })).status,
    ).toBe(204);

    // 项目行已不存在，重放只复核当前认证（ADR-062 的 actorOnly 策略），
    // 因此这里直接返回已存的 204，而不是把合法重放变成 404。
    const replay = await request("DELETE", path, value.owner, {
      key: deleteKey,
    });
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");

    const repeatLogs = (await auditReader.sql`
      SELECT count(*) AS "count"
        FROM app.audit_logs
       WHERE chain_id = 'SYSTEM'
         AND action = 'project.delete'
         AND target_id = ${String(projectId)}
    `) as unknown as readonly { count: string }[];
    expect(repeatLogs[0]!.count).toBe("1");

    // 同一把 Key、不同请求内容（If-Match 变了）→ 摘要不一致。
    await expectError(
      await request("DELETE", path, value.owner, {
        key: deleteKey,
        ifMatch: '"2"',
      }),
      409,
      "IDEMPOTENCY_REQUEST_MISMATCH",
    );

    // 换一把新 Key 重删：项目已不存在，按不存在处理。
    await expectError(
      await request("DELETE", path, value.owner),
      404,
      "PROJECT_NOT_FOUND",
    );
  });

  it("重放只复核当前认证：项目已删除仍重放 204，但认证失效后不得重放", async () => {
    const value = await fixture();
    const projectId = value.project.projectId;
    const path = `/projects/${projectId}`;
    const deleteKey = randomUUID();

    expect(
      (await request("DELETE", path, value.owner, { key: deleteKey })).status,
    ).toBe(204);
    expect(await projectExists(projectId)).toBe(false);

    // 常规重放会按项目可读性复核并必然 404；删除走的是 actorOnly，只复核认证。
    const replay = await request("DELETE", path, value.owner, {
      key: deleteKey,
    });
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");

    // 认证失效后不得再重放：幂等记录不能变成绕过停用的后门。
    await client.sql`
      UPDATE app.users
         SET auth_version = auth_version + 1,
             row_version = row_version + 1
       WHERE id = ${value.owner.userId}
    `;
    await expectError(
      await request("DELETE", path, value.owner, { key: deleteKey }),
      401,
      "PROJECT_SESSION_REQUIRED",
    );

    // 未登录同样不重放。
    await expectError(
      await request("DELETE", path, undefined, { csrf: "a".repeat(43) }),
      401,
      "PROJECT_SESSION_REQUIRED",
    );
  });

  it("陈旧版本 409、缺 If-Match 422、缺幂等键 400、带请求体 422、缺 CSRF 422、未登录 401", async () => {
    const value = await fixture();
    const projectId = value.project.projectId;
    const path = `/projects/${projectId}`;

    await client.sql`
      UPDATE app.projects
         SET row_version = row_version + 1
       WHERE id = ${projectId}
    `;
    await expectError(
      await request("DELETE", path, value.owner, { ifMatch: '"1"' }),
      409,
      "PROJECT_VERSION_CONFLICT",
    );
    await expectError(
      await request("DELETE", path, value.owner, { omitIfMatch: true }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
    await expectError(
      await request("DELETE", path, value.owner, { omitIdempotency: true }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await expectError(
      await request("DELETE", path, value.owner, {
        body: { reason: "误建" },
        contentType: "application/json",
      }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
    await expectError(
      await request("DELETE", path, value.owner, { omitCsrf: true }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
    await expectError(
      await request("DELETE", path, undefined, { csrf: "a".repeat(43) }),
      401,
      "PROJECT_SESSION_REQUIRED",
    );

    // 以上失败都不删除任何数据；用当前版本号删除成功。
    expect(await projectExists(projectId)).toBe(true);
    expect(
      (await request("DELETE", path, value.owner, { ifMatch: '"2"' })).status,
    ).toBe(204);
    expect(await projectExists(projectId)).toBe(false);
  });

  it("项目编码随物理删除释放，可被后续新项目复用", async () => {
    const value = await fixture();
    const projectId = value.project.projectId;
    const code = value.project.code;

    expect(
      (await request("DELETE", `/projects/${projectId}`, value.owner)).status,
    ).toBe(204);

    // 唯一约束里没有残留墓碑行：同一编码可以重新登记。
    const reusedId = await insertProjectWithCode(code, value.owner.userId);
    expect(reusedId).not.toBe(projectId);
    const [reused] = (await client.sql`
      SELECT code AS "code" FROM app.projects WHERE id = ${reusedId}
    `) as unknown as readonly { code: string }[];
    expect(reused!.code).toBe(code);
  });
});

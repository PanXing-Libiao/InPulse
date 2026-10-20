import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { schemaRegistry } from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
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
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { ProjectRoleGateService } from "../src/modules/projects/project-role-gate.service.js";
import { ProjectStartNotifier } from "../src/modules/projects/project-start.notifier.js";
import { ProjectWrapNotifier } from "../src/modules/projects/project-wrap.notifier.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { ProjectManagementController } from "../src/modules/projects/project-management.controller.js";
import { ProjectManagementHttpService } from "../src/modules/projects/project-management-http.service.js";
import { ProjectManagementService } from "../src/modules/projects/project-management.service.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let client: DatabaseClient;
let auditReader: DatabaseClient;
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

async function request(
  method: string,
  path: string,
  who?: Actor,
  body?: unknown,
  options: {
    readonly key?: string;
    readonly csrf?: string;
    readonly omitCsrf?: boolean;
    readonly omitIdempotency?: boolean;
    readonly omitIfMatch?: boolean;
    readonly contentType?: string;
    readonly ifMatch?: string;
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
    "content-type": options.contentType ?? "application/json",
    ...(options.omitIdempotency === true
      ? {}
      : { "Idempotency-Key": options.key ?? randomUUID() }),
  };
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f06-project-management",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f06-project-management-audit",
  });
  const uow = new PostgresUnitOfWork(client);
  const csrf = new PostgresSessionCsrfTokenRepository();
  const sessions = new PostgresUserSessionRepository();
  const auth = new SessionAuthService(uow, sessions, tokens);
  const service = new ProjectManagementService(
    new PostgresProjectsWritePort(),
    new PostgresProjectAccessQueryPort(client),
    new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key }),
    new PostgresActivityWritePort(),
    new PostgresSearchProjectionWritePort(),
    new PostgresProjectMembersQueryPort(),
    new ProjectRoleGateService(
      new PostgresProjectAccessQueryPort(client),
      new PostgresProjectMembersQueryPort(),
    ),
    new ProjectStartNotifier(
      new PostgresProjectMembersQueryPort(),
      new PostgresNotificationWritePort(),
    ),
    new ProjectWrapNotifier(
      new PostgresProjectMembersQueryPort(),
      new PostgresNotificationWritePort(),
    ),
  );
  const http = new ProjectManagementHttpService(
    new AuthenticatedMutationService(auth, csrf, tokens),
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
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

describe("F-06.1 project edit API", () => {
  it("edits a project with audit, activity, search projection and idempotent replay", async () => {
    const value = await fixture();
    const editKey = randomUUID();
    const path = `/projects/${value.project.projectId}`;
    const editBody = { name: "  商城系统二期  ", description: "新的项目描述" };

    const edited = await request("PATCH", path, value.owner, editBody, {
      key: editKey,
    });
    expect(edited.status).toBe(200);
    const body = schemaRegistry.ProjectDetailResponse.schema.parse(
      await edited.json(),
    );
    expect(body.project).toMatchObject({
      id: value.project.projectId,
      code: value.project.code,
      name: "商城系统二期",
      description: "新的项目描述",
      status: "NOT_STARTED",
      rowVersion: 2,
      memberCount: 1,
      stats: {
        activeModuleCount: 1,
        activeFeatureCount: 0,
        openTaskCount: 0,
        completedTaskCount: 0,
      },
    });

    const replay = await request("PATCH", path, value.owner, editBody, {
      key: editKey,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);

    const auditRows = (await auditReader.sql`
      SELECT action AS "action",
             target_id AS "targetId"
        FROM app.audit_logs
       WHERE project_id = ${value.project.projectId}
         AND action = 'project.update'
    `) as unknown as readonly { action: string; targetId: string }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.targetId).toBe(String(value.project.projectId));

    const activityRows = (await client.sql`
      SELECT activity_type AS "activityType",
             source_row_version AS "sourceRowVersion"
        FROM app.activity_projection
       WHERE project_id = ${value.project.projectId}
         AND activity_type = 'PROJECT_UPDATED'
    `) as unknown as readonly {
      activityType: string;
      sourceRowVersion: number;
    }[];
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]!.sourceRowVersion).toBe(2);

    const searchRows = (await client.sql`
      SELECT title, summary
        FROM app.search_projection
       WHERE project_id = ${value.project.projectId}
         AND entity_type = 'PROJECT'
         AND entity_id = ${value.project.projectId}
    `) as unknown as readonly { title: string; summary: string }[];
    expect(searchRows).toHaveLength(1);
    expect(searchRows[0]).toMatchObject({
      title: "商城系统二期",
      summary: "新的项目描述",
    });
  });

  it("rejects anonymous, non-member and stale version writes", async () => {
    const value = await fixture();
    const outsider = await actor(false);
    const path = `/projects/${value.project.projectId}`;
    const editBody = { name: "受保护的项目", description: "" };

    await expectError(
      await request("PATCH", path, undefined, editBody, {
        csrf: "a".repeat(43),
      }),
      401,
      "PROJECT_SESSION_REQUIRED",
    );
    await expectError(
      await request("PATCH", path, outsider, editBody),
      404,
      "PROJECT_NOT_FOUND",
    );

    const first = await request("PATCH", path, value.owner, editBody);
    expect(first.status).toBe(200);
    await expectError(
      await request("PATCH", path, value.owner, {
        name: "并发覆盖",
        description: "",
      }),
      409,
      "PROJECT_VERSION_CONFLICT",
    );
  });

  it("validates protocol headers, content type, body and idempotency key", async () => {
    const value = await fixture();
    const path = `/projects/${value.project.projectId}`;
    const editBody = { name: "协议校验", description: "" };

    await expectError(
      await request("PATCH", path, value.owner, editBody, {
        omitIfMatch: true,
      }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
    await expectError(
      await request("PATCH", path, value.owner, editBody, {
        omitCsrf: true,
      }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
    await expectError(
      await request("PATCH", path, value.owner, editBody, {
        ifMatch: "1",
      }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
    await expectError(
      await request("PATCH", path, value.owner, editBody, {
        contentType: "text/plain",
      }),
      400,
      "PROJECT_CONTENT_TYPE_INVALID",
    );
    await expectError(
      await request("PATCH", path, value.owner, editBody, {
        omitIdempotency: true,
      }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await expectError(
      await request("PATCH", path, value.owner, {
        name: "   ",
        description: "",
      }),
      422,
      "PROJECT_VALIDATION_FAILED",
    );
  });

  it("rechecks current authorization before replaying a cached success", async () => {
    const removed = await fixture();
    const removedKey = randomUUID();
    const removedPath = `/projects/${removed.project.projectId}`;
    const editBody = { name: "重放授权", description: "" };
    const first = await request("PATCH", removedPath, removed.owner, editBody, {
      key: removedKey,
    });
    expect(first.status).toBe(200);
    await client.sql`
      UPDATE app.project_members
         SET status = 'REMOVED',
             removed_at = now(),
             role = 'MEMBER'
       WHERE project_id = ${removed.project.projectId}
         AND user_id = ${removed.owner.userId}
         AND status = 'ACTIVE'
    `;
    await expectError(
      await request("PATCH", removedPath, removed.owner, editBody, {
        key: removedKey,
      }),
      404,
      "PROJECT_NOT_FOUND",
    );
  });
});

describe("F-06.3 项目状态变更 API", () => {
  const statusPath = (projectId: number) => `/projects/${projectId}/status`;

  it("组长把未开始改为进行中：写审计、活动、搜索投影并通知全体成员", async () => {
    const value = await fixture();
    const teammate = await actor(false);
    await client.sql`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${value.project.projectId}, ${teammate.userId}, 'MEMBER')
    `;

    const response = await request(
      "PATCH",
      statusPath(value.project.projectId),
      value.owner,
      { status: "ACTIVE" },
      { key: randomUUID(), ifMatch: '"1"' },
    );
    expect(response.status).toBe(200);
    const body = schemaRegistry.ProjectDetailResponse.schema.parse(
      await response.json(),
    );
    expect(body.project).toMatchObject({
      id: value.project.projectId,
      status: "ACTIVE",
      hasCompletedTask: false,
      rowVersion: 2,
    });

    const audits = (await auditReader.sql`
      SELECT action AS "action"
        FROM app.audit_logs
       WHERE project_id = ${value.project.projectId}
         AND action = 'project.status.change'
    `) as unknown as readonly { action: string }[];
    expect(audits).toHaveLength(1);

    const notifications = (await client.sql`
      SELECT recipient_id AS "recipientId"
        FROM app.notifications
       WHERE project_id = ${value.project.projectId}
       ORDER BY recipient_id ASC
    `) as unknown as readonly { recipientId: number }[];
    expect(notifications.map((row) => row.recipientId)).toEqual(
      [value.owner.userId, teammate.userId].sort((left, right) => left - right),
    );
  });

  it("维护中不通知，未开始与维护中禁止越级互改", async () => {
    const value = await fixture();
    const path = statusPath(value.project.projectId);

    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "MAINTENANCE" },
        { ifMatch: '"1"' },
      ),
      409,
      "PROJECT_STATUS_LEVEL_SKIP",
    );

    const started = await request(
      "PATCH",
      path,
      value.owner,
      { status: "ACTIVE" },
      { ifMatch: '"1"' },
    );
    expect(started.status).toBe(200);
    const maintenance = await request(
      "PATCH",
      path,
      value.owner,
      { status: "MAINTENANCE" },
      { ifMatch: '"2"' },
    );
    expect(maintenance.status).toBe(200);
    expect(
      schemaRegistry.ProjectDetailResponse.schema.parse(
        await maintenance.json(),
      ).project.status,
    ).toBe("MAINTENANCE");

    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "NOT_STARTED" },
        { ifMatch: '"3"' },
      ),
      409,
      "PROJECT_STATUS_LEVEL_SKIP",
    );

    const notifications = (await client.sql`
      SELECT count(*)::int AS "total"
        FROM app.notifications
       WHERE project_id = ${value.project.projectId}
         AND notification_type = 'project.status.change'
    `) as unknown as readonly { total: number }[];
    expect(notifications[0]!.total).toBe(1);

    const activities = (await client.sql`
      SELECT activity_type AS "activityType"
        FROM app.activity_projection
       WHERE project_id = ${value.project.projectId}
       ORDER BY id ASC
    `) as unknown as readonly { activityType: string }[];
    expect(activities.map((row) => row.activityType)).toEqual([
      "PROJECT_STATUS_CHANGED",
      "PROJECT_STATUS_CHANGED",
    ]);

    const wraps = (await client.sql`
      SELECT count(*)::int AS "total"
        FROM app.project_wraps
       WHERE project_id = ${value.project.projectId}
    `) as unknown as readonly { total: number }[];
    expect(wraps[0]!.total).toBe(0);
  });

  it("普通成员可改状态、非成员 404、版本冲突与同态各自返回 409", async () => {
    const value = await fixture();
    const teammate = await actor(false);
    const outsider = await actor(false);
    await client.sql`
      INSERT INTO app.project_members (project_id, user_id, role)
      VALUES (${value.project.projectId}, ${teammate.userId}, 'MEMBER')
    `;
    const path = statusPath(value.project.projectId);

    await expectError(
      await request(
        "PATCH",
        path,
        outsider,
        { status: "ACTIVE" },
        { ifMatch: '"2"' },
      ),
      404,
      "PROJECT_NOT_FOUND",
    );
    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "ACTIVE" },
        { ifMatch: '"9"' },
      ),
      409,
      "PROJECT_VERSION_CONFLICT",
    );
    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "NOT_STARTED" },
        { ifMatch: '"1"' },
      ),
      409,
      "PROJECT_STATE_CONFLICT",
    );
    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "ARCHIVED" },
        { ifMatch: '"1"' },
      ),
      422,
      "PROJECT_VALIDATION_FAILED",
    );

    // ADR-039：项目内管理权全员等同，普通成员（非组长、非系统管理员）
    // 直接改状态成功。
    const memberChange = await request(
      "PATCH",
      path,
      teammate,
      { status: "ACTIVE" },
      { key: randomUUID(), ifMatch: '"1"' },
    );
    expect(memberChange.status, await memberChange.clone().text()).toBe(200);
    expect(
      schemaRegistry.ProjectDetailResponse.schema.parse(
        await memberChange.json(),
      ).project,
    ).toMatchObject({ status: "ACTIVE", rowVersion: 2 });
  });

  it("项目出现过已完成任务后不能回退未开始", async () => {
    const value = await fixture();
    const path = statusPath(value.project.projectId);

    await client.sql`
      UPDATE app.projects
         SET status = 'ACTIVE',
             first_task_completed_at = now(),
             row_version = row_version + 1
       WHERE id = ${value.project.projectId}
    `;

    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "NOT_STARTED" },
        { ifMatch: '"2"' },
      ),
      409,
      "PROJECT_STATUS_NOT_STARTED_LOCKED",
    );

    // 有已完成任务只锁定「回退未开始」这一条边，其余迁移照常放行。
    const maintenance = await request(
      "PATCH",
      path,
      value.owner,
      { status: "MAINTENANCE" },
      { ifMatch: '"2"' },
    );
    expect(maintenance.status).toBe(200);
    expect(
      schemaRegistry.ProjectDetailResponse.schema.parse(
        await maintenance.json(),
      ).project,
    ).toMatchObject({ status: "MAINTENANCE", hasCompletedTask: true });
  });

  it("进入维护中要求项目下任务全部收尾（ADR-043）", async () => {
    const value = await fixture();
    const path = statusPath(value.project.projectId);
    const started = await request(
      "PATCH",
      path,
      value.owner,
      { status: "ACTIVE" },
      { ifMatch: '"1"' },
    );
    expect(started.status).toBe(200);

    // app.tasks 的延迟状态历史不变量要求任务行与最后一条 task_status_history 对齐，
    // 因此夹具在同一条语句里补写历史。
    const [pending] = await client.sql<Array<{ id: number }>>`
      WITH created AS (
        INSERT INTO app.tasks (
          project_id, module_id, scope_type, code, title, creator_id
        )
        VALUES (
          ${value.project.projectId},
          ${value.project.moduleId},
          'MODULE',
          ${`${value.project.code}-T-1`},
          '未完成任务',
          ${value.owner.userId}
        )
        RETURNING id, project_id
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status, changed_by
      )
      SELECT id, project_id, NULL, 'TODO', ${value.owner.userId}
        FROM created
      RETURNING task_id AS id
    `;
    expect(pending?.id).toBeGreaterThan(0);

    await expectError(
      await request(
        "PATCH",
        path,
        value.owner,
        { status: "MAINTENANCE" },
        { ifMatch: '"2"' },
      ),
      409,
      "PROJECT_MAINTENANCE_TASKS_OPEN",
    );

    // 任务完成即视为收尾，门禁放行。
    await client.sql`
      WITH updated AS (
        UPDATE app.tasks
           SET work_status = 'DONE',
               completion_note = '已完成',
               completed_at = now(),
               row_version = row_version + 1
         WHERE id = ${pending!.id}
         RETURNING id, project_id, completed_at, completion_note
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status,
        completed_at_snapshot, completion_note_snapshot, changed_by
      )
      SELECT id, project_id, 'TODO', 'DONE', completed_at, completion_note,
             ${value.owner.userId}
        FROM updated
    `;
    const maintenance = await request(
      "PATCH",
      path,
      value.owner,
      { status: "MAINTENANCE" },
      { ifMatch: '"2"' },
    );
    expect(maintenance.status, await maintenance.clone().text()).toBe(200);
    expect(
      schemaRegistry.ProjectDetailResponse.schema.parse(
        await maintenance.json(),
      ).project.status,
    ).toBe("MAINTENANCE");

    const wraps = (await client.sql`
      SELECT sealed_by AS "sealedBy",
             template_version AS "templateVersion",
             snapshot
        FROM app.project_wraps
       WHERE project_id = ${value.project.projectId}
    `) as unknown as readonly {
      sealedBy: number;
      templateVersion: number;
      snapshot: {
        stats: { completedTaskCount: number; openTaskCount: number };
        participants: readonly unknown[];
        timeline: { sealedAt: string; lastTaskCompletedAt: string };
      };
    }[];
    expect(wraps).toHaveLength(1);
    expect(wraps[0]).toMatchObject({
      sealedBy: value.owner.userId,
      templateVersion: 1,
      snapshot: {
        stats: { completedTaskCount: 1, openTaskCount: 0 },
      },
    });
    expect(wraps[0]!.snapshot.participants).toHaveLength(1);
    expect(wraps[0]!.snapshot.timeline.lastTaskCompletedAt).toBeTruthy();

    const wrapActivities = (await client.sql`
      SELECT activity_type AS "activityType"
        FROM app.activity_projection
       WHERE project_id = ${value.project.projectId}
       ORDER BY id ASC
    `) as unknown as readonly { activityType: string }[];
    expect(wrapActivities.map((row) => row.activityType)).toEqual([
      "PROJECT_STATUS_CHANGED",
      "PROJECT_WRAPPED",
    ]);

    const wrapNotifications = (await client.sql`
      SELECT recipient_id AS "recipientId",
             notification_type AS "notificationType"
        FROM app.notifications
       WHERE project_id = ${value.project.projectId}
         AND notification_type = 'project.wrapped'
    `) as unknown as readonly {
      recipientId: number;
      notificationType: string;
    }[];
    expect(wrapNotifications).toEqual([
      {
        recipientId: value.owner.userId,
        notificationType: "project.wrapped",
      },
    ]);
  });

  it("已完成或已取消的任务不算未收尾，可进入维护中", async () => {
    const value = await fixture();
    const path = statusPath(value.project.projectId);
    await request(
      "PATCH",
      path,
      value.owner,
      { status: "ACTIVE" },
      { ifMatch: '"1"' },
    );
    await client.sql`
      WITH created AS (
        INSERT INTO app.tasks (
          project_id, module_id, scope_type, code, title, work_status,
          lifecycle_status, creator_id
        )
        VALUES (
          ${value.project.projectId},
          ${value.project.moduleId},
          'MODULE',
          ${`${value.project.code}-T-1`},
          '已取消任务',
          'CANCELED',
          'ACTIVE',
          ${value.owner.userId}
        )
        RETURNING id, project_id
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status, changed_by
      )
      SELECT id, project_id, NULL, 'CANCELED', ${value.owner.userId}
        FROM created
    `;
    await client.sql`
      WITH created AS (
        INSERT INTO app.tasks (
          project_id, module_id, scope_type, code, title, work_status,
          completion_note, completed_at, creator_id
        )
        VALUES (
          ${value.project.projectId},
          ${value.project.moduleId},
          'MODULE',
          ${`${value.project.code}-T-2`},
          '已完成任务',
          'DONE',
          '已完成',
          now(),
          ${value.owner.userId}
        )
        RETURNING id, project_id, completed_at, completion_note
      )
      INSERT INTO app.task_status_history (
        task_id, project_id, from_work_status, to_work_status,
        completed_at_snapshot, completion_note_snapshot, changed_by
      )
      SELECT id, project_id, NULL, 'DONE', completed_at, completion_note,
             ${value.owner.userId}
        FROM created
    `;

    const maintenance = await request(
      "PATCH",
      path,
      value.owner,
      { status: "MAINTENANCE" },
      { ifMatch: '"2"' },
    );
    expect(maintenance.status, await maintenance.clone().text()).toBe(200);
  });
});

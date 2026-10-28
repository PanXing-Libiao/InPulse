import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  adminUserItemSchema,
  adminUserListResponseSchema,
} from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import { AdminUserRepository } from "../src/admin-users/admin-user.repository.js";
import { AdminUsersHttpService } from "../src/admin-users/admin-user-http.service.js";
import { AdminUsersController } from "../src/admin-users/admin-user.controller.js";
import { AdminCasdoorImportHttpService } from "../src/admin-users/admin-casdoor-import-http.service.js";
import { AdminUserService } from "../src/admin-users/admin-user.service.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PasswordService } from "../src/auth/password.service.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import { PostgresActivityProjectionReader } from "../src/modules/activity/activity-projection.reader.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectLeaderTransferPort } from "../src/modules/projects/project-leader-transfer.port.js";
import { AdminUserOffboardingRepository } from "../src/admin-users/admin-user-offboarding.repository.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { ProjectMemberTaskCommandPort } from "../src/modules/tasks/project-member-task.command-port.js";
import { SqlTaskDeletionCommandPort } from "../src/modules/tasks/task-deletion.command-port.js";
import { TaskDeletionWorkflow } from "../src/workflows/task-deletion.workflow.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import {
  createProject,
  createUser,
  removeMember,
  testUrls,
} from "./database.helpers.js";

const ADMIN_USER_INITIAL_PASSWORD = "initial-password-123456";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let app: INestApplication | undefined;
let base: string;
let uow: PostgresUnitOfWork;
let sessions: PostgresUserSessionRepository;
let csrf: PostgresSessionCsrfTokenRepository;
let tokens: SessionTokenService;
let auth: SessionAuthService;
let mutation: AuthenticatedMutationService;
let highRisk: AdminHighRiskAuthService;
let repository: AdminUserRepository;
let audit: PostgresAuditWritePort;
let userService: AdminUserService;
let credentials: PostgresUserCredentialRepository;
let taskManagement: TasksManagementService;
let taskDeletionCommands: SqlTaskDeletionCommandPort;
let taskDeletionWorkflow: TaskDeletionWorkflow;

const key = randomBytes(32);

interface Actor {
  readonly userId: number;
  readonly authVersion: number;
  readonly cookie: string;
  readonly csrf: string;
}

function secureHeaders(actor?: Actor) {
  return {
    origin: base,
    "sec-fetch-site": "same-origin",
    ...(actor
      ? { cookie: actor.cookie, "x-csrf-token": actor.csrf }
      : { cookie: "", "x-csrf-token": "a".repeat(43) }),
  };
}

async function request(
  path: string,
  method: string,
  actor?: Actor,
  options: {
    readonly body?: unknown;
    readonly version?: number;
    readonly key?: string;
    readonly csrf?: string;
  } = {},
) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...secureHeaders(actor),
      ...(options.csrf === undefined ? {} : { "x-csrf-token": options.csrf }),
      "content-type": "application/json",
      "Idempotency-Key": options.key ?? randomUUID(),
      ...(options.version === undefined
        ? {}
        : { "If-Match": `"${options.version}"` }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return response;
}

async function authVersionFor(userId: number): Promise<number> {
  const rows = (await client.sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { authVersion: number }[];
  return rows[0]!.authVersion;
}

async function userState(userId: number) {
  const rows = (await client.sql`
    SELECT login_name AS "loginName",
           name,
           email,
           password_hash IS NULL AS "passwordCleared",
           is_admin AS "isAdmin",
           status,
           disabled_at AS "disabledAt",
           deleted_at AS "deletedAt",
           auth_version AS "authVersion",
           row_version AS "rowVersion",
           (SELECT count(*)::int FROM app.user_sessions WHERE user_id = ${userId} AND revoked_at IS NULL) AS "activeSessions",
           (SELECT count(*)::int FROM app.task_assignees AS ta JOIN app.tasks AS t ON t.id = ta.task_id AND t.project_id = ta.project_id WHERE ta.user_id = ${userId} AND t.work_status = 'TODO' AND t.lifecycle_status = 'ACTIVE' AND t.deleted_at IS NULL) AS "openTaskCount"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly {
    readonly loginName: string;
    readonly name: string;
    readonly email: string | null;
    readonly passwordCleared: boolean;
    readonly isAdmin: boolean;
    readonly status: string;
    readonly disabledAt: string | null;
    readonly deletedAt: string | null;
    readonly authVersion: number;
    readonly rowVersion: number;
    readonly activeSessions: number;
    readonly openTaskCount: number;
  }[];
  return rows[0]!;
}

async function seedUser(options: { readonly admin: boolean }): Promise<Actor> {
  const userId = await createUser(client.sql, { admin: options.admin });
  const authVersion = await authVersionFor(userId);
  const cookie = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await uow.run(async (tx) => {
    const session = await sessions.create(tx, {
      userId,
      tokenHash: tokens.hash(cookie).hash,
      tokenHashKeyVersion: tokens.hash(cookie).keyVersion,
      authVersionAtIssue: authVersion,
      authState: "AUTHENTICATED",
      idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await csrf.issue(tx, {
      sessionId: session.id,
      tokenHash: tokens.hash(csrfToken).hash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return session.id;
  });
  return {
    userId,
    authVersion,
    cookie: `__Host-session=${cookie}`,
    csrf: csrfToken,
  };
}

async function createTargetSession(userId: number, authVersion: number) {
  const cookie = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const sessionId = await uow.run(async (tx) => {
    const session = await sessions.create(tx, {
      userId,
      tokenHash: tokens.hash(cookie).hash,
      tokenHashKeyVersion: tokens.hash(cookie).keyVersion,
      authVersionAtIssue: authVersion,
      authState: "AUTHENTICATED",
      idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await csrf.issue(tx, {
      sessionId: session.id,
      tokenHash: tokens.hash(csrfToken).hash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return session.id;
  });
  return { sessionId, cookie: `__Host-session=${cookie}`, csrf: csrfToken };
}

async function addProjectMember(
  projectId: number,
  userId: number,
): Promise<void> {
  await client.sql`
    INSERT INTO app.project_members (project_id, user_id, role)
    VALUES (${projectId}, ${userId}, ${"MEMBER"})
  `;
}

let taskSequence = 0;

async function createOpenTaskForAssignees(
  project: {
    readonly projectId: number;
    readonly moduleId: number;
    readonly code: string;
  },
  creatorId: number,
  assigneeIds: readonly number[],
  title: string,
): Promise<{ readonly taskId: number; readonly rowVersion: number }> {
  taskSequence += 1;
  return client.sql.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO app.tasks (
        project_id,
        module_id,
        feature_id,
        scope_type,
        code,
        title,
        creator_id,
        priority,
        work_status,
        lifecycle_status
      )
      VALUES (
        ${project.projectId},
        ${project.moduleId},
        NULL,
        ${"MODULE"},
        ${project.code + "-T-" + taskSequence},
        ${title},
        ${creatorId},
        ${"NORMAL"},
        ${"TODO"},
        ${"ACTIVE"}
      )
      RETURNING id, row_version AS "rowVersion"
    `) as unknown as readonly {
      readonly id: number;
      readonly rowVersion: number;
    }[];
    const task = rows[0];
    if (task === undefined) {
      throw new Error("task fixture insert returned no row");
    }
    await tx`
      INSERT INTO app.task_status_history (
        task_id,
        project_id,
        from_work_status,
        to_work_status,
        completed_at_snapshot,
        changed_by
      )
      VALUES (${task.id}, ${project.projectId}, NULL, ${"TODO"}, NULL, ${creatorId})
    `;
    for (const assigneeId of assigneeIds) {
      await tx`
        INSERT INTO app.task_assignees (task_id, user_id, project_id)
        VALUES (${task.id}, ${assigneeId}, ${project.projectId})
      `;
    }
    return { taskId: task.id, rowVersion: task.rowVersion };
  });
}

async function taskAssigneeIds(taskId: number): Promise<number[]> {
  const rows = (await client.sql`
    SELECT user_id AS "userId"
      FROM app.task_assignees
     WHERE task_id = ${taskId}
     ORDER BY user_id
  `) as unknown as readonly { userId: number }[];
  return rows.map((row) => row.userId);
}

async function createTask(
  project: {
    readonly projectId: number;
    readonly moduleId: number;
    readonly code: string;
  },
  creatorId: number,
): Promise<number> {
  taskSequence += 1;
  return client.sql.begin(async (tx) => {
    const [task] = await tx<{ id: number }[]>`
      INSERT INTO app.tasks (
        project_id,
        module_id,
        feature_id,
        scope_type,
        code,
        title,
        creator_id,
        work_status,
        lifecycle_status,
        completed_at
      )
      VALUES (
        ${project.projectId},
        ${project.moduleId},
        NULL,
        'MODULE',
        ${`${project.code}-T-${taskSequence}`},
        '删除历史姓名测试',
        ${creatorId},
        'DONE',
        'ACTIVE',
        now()
      )
      RETURNING id
    `;
    if (!task) throw new Error("task fixture returned no row");
    await tx`
      INSERT INTO app.task_assignees (task_id, user_id, project_id)
      VALUES (${task.id}, ${creatorId}, ${project.projectId})
    `;
    await tx`
      INSERT INTO app.task_status_history (
        task_id,
        project_id,
        from_work_status,
        to_work_status,
        completed_at_snapshot,
        changed_by
      )
      VALUES (
        ${task.id},
        ${project.projectId},
        NULL,
        'DONE',
        now(),
        ${creatorId}
      )
    `;
    return task.id;
  });
}

function metaFor(actor: Actor, requestId: string) {
  return {
    actorId: actor.userId,
    headers: {
      cookie: actor.cookie,
      "x-csrf-token": actor.csrf,
    },
    requestId,
  };
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f03-admin-users",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f03-admin-users-audit",
  });
  uow = new PostgresUnitOfWork(client);
  sessions = new PostgresUserSessionRepository();
  csrf = new PostgresSessionCsrfTokenRepository();
  tokens = new SessionTokenService(
    VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
  );
  auth = new SessionAuthService(uow, sessions, tokens);
  mutation = new AuthenticatedMutationService(auth, csrf, tokens);
  credentials = new PostgresUserCredentialRepository();
  highRisk = new AdminHighRiskAuthService(sessions, csrf, tokens, credentials);
  audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key,
  });
  repository = new AdminUserRepository();
  const access = new PostgresProjectAccessQueryPort(client);
  const activity = new PostgresActivityWritePort();
  const search = new PostgresSearchProjectionWritePort();
  taskManagement = new TasksManagementService(
    access,
    new PostgresModuleQueryPort(),
    new PostgresFeatureQueryPort(),
    new PostgresFeatureReadPort(),
    new PostgresProjectCodePort(),
    new PostgresProjectMembersQueryPort(),
    uow,
    new TaskManagementRepository(),
    audit,
    activity,
    search,
    new ProjectNotificationDispatcher(
      access,
      new PostgresNotificationWritePort(),
    ),
    new PostgresModuleReadPort(),
    new PostgresProjectsWritePort(),
    postgresProjectMemberPermissions(),
  );
  taskDeletionCommands = new SqlTaskDeletionCommandPort(
    taskManagement,
    new TaskManagementRepository(),
  );
  taskDeletionWorkflow = new TaskDeletionWorkflow(
    uow,
    taskDeletionCommands,
    audit,
    activity,
  );
  userService = new AdminUserService(
    repository,
    new AdminUserOffboardingRepository(),
    sessions,
    highRisk,
    audit,
    new PostgresProjectMembersQueryPort(),
    new PostgresProjectLeaderTransferPort(
      new PostgresProjectsWritePort(),
      audit,
      activity,
    ),
    new ProjectMemberTaskCommandPort(
      new TaskManagementRepository(),
      taskManagement,
    ),
    taskDeletionCommands,
    taskDeletionWorkflow,
  );
  const http = new AdminUsersHttpService(
    auth,
    mutation,
    highRisk,
    uow,
    repository,
    userService,
    new PasswordService(),
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
  );
  class TestModule {}
  Module({
    controllers: [AdminUsersController],
    providers: [
      { provide: AdminUsersHttpService, useValue: http },
      { provide: AdminCasdoorImportHttpService, useValue: {} },
    ],
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

describe("F-03 用户管理真实 PostgreSQL + HTTP", () => {
  it("管理员完成用户生命周期，幂等不重复创建，停用同事务撤销 Session 并写审计", async () => {
    const actor = await seedUser({ admin: true });
    await seedUser({ admin: true });
    const normal = await seedUser({ admin: false });
    expect((await request("/admin/users", "GET", normal)).status).toBe(403);

    const listResponse = await request("/admin/users", "GET", actor);
    expect(listResponse.status).toBe(200);
    const list = adminUserListResponseSchema.parse(await listResponse.json());
    expect(list.items.some((item) => item.id === actor.userId)).toBe(true);

    const loginName = `f03_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const createKey = randomUUID();
    const createBody = {
      loginName,
      name: "新建用户",
      email: `${loginName}@example.com`,
      password: ADMIN_USER_INITIAL_PASSWORD,
      isAdmin: false,
    };
    const createdResponse = await request("/admin/users", "POST", actor, {
      body: createBody,
      key: createKey,
    });
    expect(createdResponse.status).toBe(200);
    const created = adminUserItemSchema.parse(await createdResponse.json());
    expect(JSON.stringify(created)).not.toContain("password");
    const replayResponse = await request("/admin/users", "POST", actor, {
      body: createBody,
      key: createKey,
    });
    expect(replayResponse.status).toBe(200);
    const replayBody = (await replayResponse.json()) as { id: number };
    expect(replayBody.id).toBe(created.id);

    const updateKey = randomUUID();
    const updatedResponse = await request(
      `/admin/users/${created.id}`,
      "PATCH",
      actor,
      {
        body: { name: "改名用户", email: null },
        version: created.rowVersion,
        key: updateKey,
      },
    );
    expect(updatedResponse.status).toBe(200);
    const updated = adminUserItemSchema.parse(await updatedResponse.json());
    expect(updated.rowVersion).toBe(2);
    expect(updated.name).toBe("改名用户");

    const targetAuthVersion = await authVersionFor(created.id);
    const targetSession = await createTargetSession(
      created.id,
      targetAuthVersion,
    );
    const disable = await request(
      `/admin/users/${created.id}/disable`,
      "POST",
      actor,
      {
        version: updated.rowVersion,
        body: { tasks: [], leaderTransfers: [] },
      },
    );
    expect(disable.status).toBe(204);
    expect(await userState(created.id)).toMatchObject({
      status: "DISABLED",
      authVersion: targetAuthVersion + 1,
      rowVersion: 3,
      activeSessions: 0,
    });
    expect(
      (
        await request("/admin/users", "GET", {
          ...normal,
          cookie: targetSession.cookie,
          csrf: targetSession.csrf,
        })
      ).status,
    ).toBe(401);

    const enable = await request(
      `/admin/users/${created.id}/enable`,
      "POST",
      actor,
      {
        version: 3,
      },
    );
    expect(enable.status).toBe(204);
    expect(await userState(created.id)).toMatchObject({
      status: "ACTIVE",
      authVersion: targetAuthVersion + 1,
      rowVersion: 4,
    });

    const auditRows = (await auditReader.sql`
      SELECT action AS "action"
        FROM app.audit_logs
       WHERE target_id = ${String(created.id)}
         AND action IN (
           'admin.user.create',
           'admin.user.update',
           'admin.user.disable',
           'admin.user.enable'
         )
    `) as unknown as readonly { action: string }[];
    expect(new Set(auditRows.map((row) => row.action))).toEqual(
      new Set([
        "admin.user.create",
        "admin.user.update",
        "admin.user.disable",
        "admin.user.enable",
      ]),
    );
  });

  it("强制退出路由已移除，旧路径返回 404", async () => {
    const actor = await seedUser({ admin: true });
    const response = await request(
      `/admin/users/${actor.userId}/force-logout`,
      "POST",
      actor,
    );
    expect(response.status).toBe(404);
  });

  it("唯一负责人任务未处理时拒绝停用", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    const peer = await seedUser({ admin: false });
    const project = await createProject(client.sql, target.userId);
    await addProjectMember(project.projectId, peer.userId);
    await createOpenTaskForAssignees(
      project,
      target.userId,
      [target.userId],
      "唯一负责人任务",
    );
    const before = await userState(target.userId);
    await createTargetSession(target.userId, before.authVersion);

    const response = await request(
      `/admin/users/${target.userId}/disable`,
      "POST",
      actor,
      {
        version: before.rowVersion,
        body: {
          tasks: [],
          leaderTransfers: [
            {
              projectId: project.projectId,
              newLeaderUserId: peer.userId,
            },
          ],
        },
      },
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { readonly code: string };
    expect(body.code).toBe("ADMIN_USER_OFFBOARDING_TASK_REQUIRED");
    expect(await userState(target.userId)).toMatchObject({
      status: "ACTIVE",
      openTaskCount: 1,
      activeSessions: 2,
    });
  });

  it("多负责人任务默认保留其他负责人并完成停用", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    const peer = await seedUser({ admin: false });
    const project = await createProject(client.sql, target.userId);
    await addProjectMember(project.projectId, peer.userId);
    const task = await createOpenTaskForAssignees(
      project,
      target.userId,
      [target.userId, peer.userId],
      "多人协作任务",
    );
    const before = await userState(target.userId);
    await createTargetSession(target.userId, before.authVersion);

    const response = await request(
      `/admin/users/${target.userId}/disable`,
      "POST",
      actor,
      {
        version: before.rowVersion,
        body: {
          tasks: [],
          leaderTransfers: [
            {
              projectId: project.projectId,
              newLeaderUserId: peer.userId,
            },
          ],
        },
      },
    );

    expect(response.status).toBe(204);
    expect(await taskAssigneeIds(task.taskId)).toEqual([peer.userId]);
    expect(await userState(target.userId)).toMatchObject({
      status: "DISABLED",
      openTaskCount: 0,
      activeSessions: 0,
    });
    const [disabledAudit] = (await auditReader.sql`
      SELECT event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE action = ${"admin.user.disable"}
         AND target_id = ${String(target.userId)}
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      readonly eventPayload: {
        readonly reassignedTaskIds: readonly number[];
        readonly deletedTaskIds: readonly number[];
      };
    }[];
    expect(disabledAudit?.eventPayload.reassignedTaskIds).toEqual([
      task.taskId,
    ]);
    expect(disabledAudit?.eventPayload.deletedTaskIds).toEqual([]);
  });

  it("组长未移交时拒绝停用", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    const peer = await seedUser({ admin: false });
    const project = await createProject(client.sql, target.userId);
    await addProjectMember(project.projectId, peer.userId);
    const before = await userState(target.userId);
    await createTargetSession(target.userId, before.authVersion);

    const response = await request(
      "/admin/users/" + target.userId + "/disable",
      "POST",
      actor,
      { version: before.rowVersion, body: { tasks: [], leaderTransfers: [] } },
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { readonly code: string };
    expect(body.code).toBe("ADMIN_USER_OFFBOARDING_LEADER_REQUIRED");
    expect(await userState(target.userId)).toMatchObject({
      status: "ACTIVE",
      activeSessions: 2,
    });
  });

  it("组长移交给项目活跃成员后完成停用", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    const peer = await seedUser({ admin: false });
    const project = await createProject(client.sql, target.userId);
    await addProjectMember(project.projectId, peer.userId);
    const before = await userState(target.userId);
    await createTargetSession(target.userId, before.authVersion);

    const response = await request(
      "/admin/users/" + target.userId + "/disable",
      "POST",
      actor,
      {
        version: before.rowVersion,
        body: {
          tasks: [],
          leaderTransfers: [
            { projectId: project.projectId, newLeaderUserId: peer.userId },
          ],
        },
      },
    );

    expect(response.status).toBe(204);
    expect(await userState(target.userId)).toMatchObject({
      status: "DISABLED",
      activeSessions: 0,
    });
    const members = (await client.sql`
      SELECT user_id AS "userId", role
        FROM app.project_members
       WHERE project_id = ${project.projectId}
         AND status = 'ACTIVE'
       ORDER BY user_id
    `) as unknown as readonly {
      readonly userId: number;
      readonly role: string;
    }[];
    const roles = new Map(members.map((item) => [item.userId, item.role]));
    expect(roles.get(peer.userId)).toBe("LEADER");
    expect(roles.get(target.userId)).toBe("MEMBER");

    const roleAudit = (await auditReader.sql`
      SELECT event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE project_id = ${project.projectId}
         AND action = 'project.member.role.set'
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      readonly eventPayload: {
        readonly previousLeaderUserId: number;
        readonly userId: number;
        readonly role: string;
      };
    }[];
    expect(roleAudit[0]?.eventPayload).toMatchObject({
      previousLeaderUserId: target.userId,
      userId: peer.userId,
      role: "LEADER",
    });
    const roleActivity = (await client.sql`
      SELECT activity_type AS "activityType"
        FROM app.activity_projection
       WHERE project_id = ${project.projectId}
         AND activity_type = 'PROJECT_MEMBER_ROLE_CHANGED'
    `) as unknown as readonly { readonly activityType: string }[];
    expect(roleActivity).toHaveLength(1);
  });

  it("组长不能移交给项目外成员", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    const peer = await seedUser({ admin: false });
    const outsider = await seedUser({ admin: false });
    const project = await createProject(client.sql, target.userId);
    await addProjectMember(project.projectId, peer.userId);
    const before = await userState(target.userId);
    await createTargetSession(target.userId, before.authVersion);

    const response = await request(
      "/admin/users/" + target.userId + "/disable",
      "POST",
      actor,
      {
        version: before.rowVersion,
        body: {
          tasks: [],
          leaderTransfers: [
            { projectId: project.projectId, newLeaderUserId: outsider.userId },
          ],
        },
      },
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { readonly code: string };
    expect(body.code).toBe("ADMIN_USER_OFFBOARDING_LEADER_INVALID");
  });

  it("唯一负责人任务可增补多名接手人，也可标记删除", async () => {
    const actor = await seedUser({ admin: true });
    const transferTarget = await seedUser({ admin: false });
    const peerA = await seedUser({ admin: false });
    const peerB = await seedUser({ admin: false });
    const transferProject = await createProject(
      client.sql,
      transferTarget.userId,
    );
    await addProjectMember(transferProject.projectId, peerA.userId);
    await addProjectMember(transferProject.projectId, peerB.userId);
    const transferTask = await createOpenTaskForAssignees(
      transferProject,
      transferTarget.userId,
      [transferTarget.userId],
      "需要多人接手",
    );
    const transferBefore = await userState(transferTarget.userId);
    await createTargetSession(
      transferTarget.userId,
      transferBefore.authVersion,
    );
    const transferAssignees = [peerA.userId, peerB.userId].sort(
      (left, right) => left - right,
    );

    const transferResponse = await request(
      `/admin/users/${transferTarget.userId}/disable`,
      "POST",
      actor,
      {
        version: transferBefore.rowVersion,
        body: {
          tasks: [
            {
              projectId: transferProject.projectId,
              moduleId: transferProject.moduleId,
              featureId: null,
              taskId: transferTask.taskId,
              rowVersion: transferTask.rowVersion,
              assigneeIds: transferAssignees,
              delete: false,
            },
          ],
          leaderTransfers: [
            {
              projectId: transferProject.projectId,
              newLeaderUserId: peerA.userId,
            },
          ],
        },
      },
    );

    expect(transferResponse.status).toBe(204);
    expect(await taskAssigneeIds(transferTask.taskId)).toEqual(
      transferAssignees,
    );
    expect(await userState(transferTarget.userId)).toMatchObject({
      status: "DISABLED",
      openTaskCount: 0,
      activeSessions: 0,
    });

    const deleteTarget = await seedUser({ admin: false });
    const peerC = await seedUser({ admin: false });
    const deleteProject = await createProject(client.sql, deleteTarget.userId);
    await addProjectMember(deleteProject.projectId, peerC.userId);
    const deleteTask = await createOpenTaskForAssignees(
      deleteProject,
      deleteTarget.userId,
      [deleteTarget.userId],
      "标记删除任务",
    );
    const deleteBefore = await userState(deleteTarget.userId);
    await createTargetSession(deleteTarget.userId, deleteBefore.authVersion);

    const deleteResponse = await request(
      `/admin/users/${deleteTarget.userId}/disable`,
      "POST",
      actor,
      {
        version: deleteBefore.rowVersion,
        body: {
          tasks: [
            {
              projectId: deleteProject.projectId,
              moduleId: deleteProject.moduleId,
              featureId: null,
              taskId: deleteTask.taskId,
              rowVersion: deleteTask.rowVersion,
              assigneeIds: [],
              delete: true,
            },
          ],
          leaderTransfers: [
            {
              projectId: deleteProject.projectId,
              newLeaderUserId: peerC.userId,
            },
          ],
        },
      },
    );

    expect(deleteResponse.status).toBe(204);
    const [deletedTask] = (await client.sql`
      SELECT count(*)::int AS count
        FROM app.tasks
       WHERE id = ${deleteTask.taskId}
    `) as unknown as readonly { readonly count: number }[];
    expect(deletedTask?.count).toBe(0);
    expect(await userState(deleteTarget.userId)).toMatchObject({
      status: "DISABLED",
      openTaskCount: 0,
      activeSessions: 0,
    });
  });

  it("物理删除已停用且无活跃项目关系的用户，并保留历史署名与审计", async () => {
    const actor = await seedUser({ admin: true });
    const target = await seedUser({ admin: false });
    const peer = await seedUser({ admin: false });
    const original = await userState(target.userId);
    const project = await createProject(client.sql, target.userId);
    await addProjectMember(project.projectId, peer.userId);
    const taskId = await createTask(project, target.userId);
    const targetSession = await createTargetSession(
      target.userId,
      target.authVersion,
    );

    const activeDelete = await request(
      `/admin/users/${target.userId}/delete`,
      "POST",
      actor,
      { version: original.rowVersion },
    );
    expect(activeDelete.status).toBe(409);
    expect((await activeDelete.json()) as { code: string }).toMatchObject({
      code: "ADMIN_USER_STATE_CONFLICT",
    });

    const disable = await request(
      `/admin/users/${target.userId}/disable`,
      "POST",
      actor,
      {
        version: original.rowVersion,
        body: {
          tasks: [],
          leaderTransfers: [
            {
              projectId: project.projectId,
              newLeaderUserId: peer.userId,
            },
          ],
        },
      },
    );
    expect(disable.status).toBe(204);
    const state = await userState(target.userId);
    expect(state).toMatchObject({
      status: "DISABLED",
      rowVersion: original.rowVersion + 1,
      activeSessions: 0,
      deletedAt: null,
    });
    expect(
      (
        await request("/admin/users", "GET", {
          ...target,
          cookie: targetSession.cookie,
          csrf: targetSession.csrf,
        })
      ).status,
    ).toBe(401);

    const membershipDelete = await request(
      `/admin/users/${target.userId}/delete`,
      "POST",
      actor,
      { version: state.rowVersion },
    );
    expect(membershipDelete.status).toBe(409);
    expect((await membershipDelete.json()) as { code: string }).toMatchObject({
      code: "ADMIN_USER_ACTIVE_PROJECT_MEMBERSHIP",
    });
    expect(await userState(target.userId)).toMatchObject({
      status: "DISABLED",
      deletedAt: null,
    });

    await removeMember(client.sql, project.projectId, target.userId);
    const deletionSession = await createTargetSession(
      target.userId,
      state.authVersion,
    );

    await client.sql`
      INSERT INTO app.user_totp_factors (
        user_id, status, enrollment_generation, key_version,
        nonce, ciphertext, auth_tag, enrolled_at
      )
      VALUES (
        ${target.userId}, 'ACTIVE', 1, 1,
        ${randomBytes(12)}, ${randomBytes(48)}, ${randomBytes(16)}, now()
      )
    `;
    await client.sql`
      INSERT INTO app.mfa_recovery_codes (
        user_id, batch_version, code_hash
      )
      VALUES (
        ${target.userId}, 1,
        ${"$argon2id$v=19$m=19456,t=2,p=1$" + randomUUID() + "$fixture-recovery"}
      )
    `;
    await client.sql`
      INSERT INTO app.wecom_binding_codes (user_id, code_hash, expires_at)
      VALUES (${target.userId}, ${randomBytes(32)}, now() + interval '10 minutes')
    `;
    await client.sql`
      INSERT INTO app.user_wecom_bindings (user_id, wecom_userid, status)
      VALUES (${target.userId}, ${`private-${randomUUID().slice(0, 12)}`}, 'ACTIVE')
    `;
    await client.sql`
      INSERT INTO app.idempotency_records (
        actor_id, operation_id, idempotency_key,
        idempotency_contract_version, request_hash,
        request_hash_key_version, expires_at
      )
      VALUES (
        ${target.userId}, 'fixture.private', ${randomUUID()},
        '1.0.0', ${randomBytes(32)}, 1, now() + interval '1 hour'
      )
    `;

    const privateRowCounts = async () => {
      const [row] = (await client.sql`
        SELECT
          (SELECT count(*)::int FROM app.user_sessions WHERE user_id = ${target.userId}) AS sessions,
          (SELECT count(*)::int FROM app.session_csrf_tokens AS c JOIN app.user_sessions AS s ON s.id = c.session_id WHERE s.user_id = ${target.userId}) AS "csrfTokens",
          (SELECT count(*)::int FROM app.user_totp_factors WHERE user_id = ${target.userId}) AS totp,
          (SELECT count(*)::int FROM app.mfa_recovery_codes WHERE user_id = ${target.userId}) AS "recoveryCodes",
          (SELECT count(*)::int FROM app.notifications WHERE recipient_id = ${target.userId}) AS notifications,
          (SELECT count(*)::int FROM app.wecom_binding_codes WHERE user_id = ${target.userId}) AS "bindingCodes",
          (SELECT count(*)::int FROM app.user_wecom_bindings WHERE user_id = ${target.userId}) AS "wecomBindings",
          (SELECT count(*)::int FROM app.idempotency_records WHERE actor_id = ${target.userId}) AS idempotency
      `) as unknown as readonly {
        readonly sessions: number;
        readonly csrfTokens: number;
        readonly totp: number;
        readonly recoveryCodes: number;
        readonly notifications: number;
        readonly bindingCodes: number;
        readonly wecomBindings: number;
        readonly idempotency: number;
      }[];
      return row!;
    };
    const activitySummary = `用户 ${original.name} 完成了任务`;
    await uow.run(async (tx) => {
      const event = await audit.append(tx, {
        projectId: project.projectId,
        actorType: "USER",
        actorId: target.userId,
        action: "task.complete",
        targetType: "TASK",
        targetId: String(taskId),
        eventPayload: { taskId },
        requestId: randomUUID(),
        clientRequestId: null,
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        occurredAt: new Date(),
      });
      await new PostgresActivityWritePort().append(tx, {
        projectId: project.projectId,
        sourceChainId: `PROJECT:${project.projectId}`,
        sourceSequence: event.sequenceNo,
        sourceEntityType: "TASK",
        sourceEntityId: taskId,
        activityType: "TASK_COMPLETED",
        actorId: target.userId,
        summary: activitySummary,
        metadata: { userId: target.userId },
        visibilityScope: "MEMBER",
        sourceStatus: "ACTIVE",
        sourceRowVersion: 1,
        occurredAt: new Date(),
      });
      await tx.sql`
        INSERT INTO app.notifications (
          recipient_id, project_id, source_chain_id, source_sequence,
          notification_type, title, body, target_path
        )
        VALUES (
          ${target.userId}, ${project.projectId},
          ${"PROJECT:" + String(project.projectId)}, ${event.sequenceNo},
          'PRIVATE_TEST', '私有通知', '', '/tasks'
        )
      `;
    });

    expect(await privateRowCounts()).toEqual({
      sessions: 3,
      csrfTokens: 3,
      totp: 1,
      recoveryCodes: 1,
      notifications: 1,
      bindingCodes: 1,
      wecomBindings: 1,
      idempotency: 1,
    });

    const deleteKey = randomUUID();
    const deleteResponse = await request(
      `/admin/users/${target.userId}/delete`,
      "POST",
      actor,
      { version: state.rowVersion, key: deleteKey },
    );
    expect(deleteResponse.status).toBe(204);

    const [userRows] = (await client.sql`
      SELECT count(*)::int AS count
        FROM app.users
       WHERE id = ${target.userId}
    `) as unknown as readonly { readonly count: number }[];
    expect(userRows?.count).toBe(0);
    const [archivedIdentity] = (await client.sql`
      SELECT user_id AS "userId",
             name,
             login_name AS "loginName"
        FROM app.deleted_user_identities
       WHERE user_id = ${target.userId}
    `) as unknown as readonly {
      readonly userId: number;
      readonly name: string;
      readonly loginName: string;
    }[];
    expect(archivedIdentity).toEqual({
      userId: target.userId,
      name: original.name,
      loginName: original.loginName,
    });
    expect(await privateRowCounts()).toEqual({
      sessions: 0,
      csrfTokens: 0,
      totp: 0,
      recoveryCodes: 0,
      notifications: 0,
      bindingCodes: 0,
      wecomBindings: 0,
      idempotency: 0,
    });

    const afterDeleteList = await request("/admin/users", "GET", actor);
    expect(afterDeleteList.status).toBe(200);
    const afterDeleteItems = adminUserListResponseSchema.parse(
      await afterDeleteList.json(),
    );
    expect(
      afterDeleteItems.items.some((item) => item.id === target.userId),
    ).toBe(false);

    const [projectSnapshot] = (await client.sql`
      SELECT created_by_snapshot->>'name' AS "creatorName"
        FROM app.projects
       WHERE id = ${project.projectId}
    `) as unknown as readonly { readonly creatorName: string }[];
    expect(projectSnapshot?.creatorName).toBe(original.name);
    const [memberHistory] = (await client.sql`
      SELECT status,
             user_snapshot->>'name' AS name
        FROM app.project_members
       WHERE project_id = ${project.projectId}
         AND user_id = ${target.userId}
       ORDER BY id DESC
       LIMIT 1
    `) as unknown as readonly {
      readonly status: string;
      readonly name: string;
    }[];
    expect(memberHistory).toEqual({ status: "REMOVED", name: original.name });

    const [taskSnapshots] = (await client.sql`
      SELECT t.creator_snapshot->>'name' AS "creatorName",
             ARRAY(
               SELECT ta.user_snapshot->>'name'
                 FROM app.task_assignees AS ta
                WHERE ta.task_id = t.id
                ORDER BY ta.user_id
             ) AS "assigneeNames",
             (
               SELECT h.changed_by_snapshot->>'name'
                 FROM app.task_status_history AS h
                WHERE h.task_id = t.id
                ORDER BY h.id
                LIMIT 1
             ) AS "changedByName"
        FROM app.tasks AS t
       WHERE t.id = ${taskId}
    `) as unknown as readonly {
      readonly creatorName: string;
      readonly assigneeNames: readonly string[];
      readonly changedByName: string;
    }[];
    expect(taskSnapshots).toEqual({
      creatorName: original.name,
      assigneeNames: [original.name],
      changedByName: original.name,
    });

    const taskItems = await uow.run((tx) =>
      new TaskManagementRepository().list(tx, {
        projectId: project.projectId,
        moduleId: project.moduleId,
        featureId: null,
      }),
    );
    expect(taskItems.find((item) => item.id === taskId)).toMatchObject({
      creatorName: original.name,
      assigneeNames: [original.name],
    });

    const activityRows = (await client.sql`
      SELECT summary,
             actor_snapshot AS "actorSnapshot"
        FROM app.activity_projection
       WHERE source_entity_type = 'TASK'
         AND source_entity_id = ${taskId}
         AND actor_id = ${target.userId}
    `) as unknown as readonly {
      readonly summary: string;
      readonly actorSnapshot: {
        readonly id: number;
        readonly name: string;
        readonly loginName: string;
      };
    }[];
    expect(activityRows).toEqual([
      {
        summary: activitySummary,
        actorSnapshot: {
          id: target.userId,
          name: original.name,
          loginName: original.loginName,
        },
      },
    ]);
    const activityPage = await new PostgresActivityProjectionReader(
      client.sql,
    ).read({
      projectIds: [project.projectId],
      adminOnlyProjectIds: [],
      category: "task",
      limit: 20,
      after: null,
    });
    expect(
      activityPage.items.find((item) => item.sourceEntityId === taskId),
    ).toMatchObject({
      actorId: target.userId,
      actorName: original.name,
      summary: activitySummary,
    });

    const [deleteAuditCount] = (await auditReader.sql`
      SELECT count(*)::int AS count
        FROM app.audit_logs
       WHERE action = 'admin.user.delete'
         AND target_id = ${String(target.userId)}
    `) as unknown as readonly { readonly count: number }[];
    expect(deleteAuditCount?.count).toBe(1);
    const [deleteAudit] = (await auditReader.sql`
      SELECT event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE action = 'admin.user.delete'
         AND target_id = ${String(target.userId)}
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      readonly eventPayload: {
        readonly before: { readonly loginName: string; readonly name: string };
        readonly after: null;
        readonly physicalDeleted: boolean;
        readonly revokedSessionCount: number;
      };
    }[];
    expect(deleteAudit?.eventPayload).toMatchObject({
      before: { loginName: original.loginName, name: original.name },
      after: null,
      physicalDeleted: true,
      revokedSessionCount: 1,
    });
    expect(deleteAudit?.eventPayload).not.toHaveProperty(
      "renamedActivityCount",
    );

    const replay = await request(
      `/admin/users/${target.userId}/delete`,
      "POST",
      actor,
      { version: state.rowVersion, key: deleteKey },
    );
    expect(replay.status).toBe(204);
    const [replayedAuditCount] = (await auditReader.sql`
      SELECT count(*)::int AS count
        FROM app.audit_logs
       WHERE action = 'admin.user.delete'
         AND target_id = ${String(target.userId)}
    `) as unknown as readonly { readonly count: number }[];
    expect(replayedAuditCount?.count).toBe(1);

    for (const [path, method, body] of [
      [`/admin/users/${target.userId}/enable`, "POST", undefined],
      [`/admin/users/${target.userId}`, "PATCH", { name: "不能恢复" }],
      [`/admin/users/${target.userId}/delete`, "POST", undefined],
    ] as const) {
      const response = await request(path, method, actor, {
        version: state.rowVersion,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(404);
      expect((await response.json()) as { code: string }).toMatchObject({
        code: "ADMIN_USER_NOT_FOUND",
      });
    }

    const reused = await request("/admin/users", "POST", actor, {
      body: {
        loginName: original.loginName,
        name: "复用登录名",
        password: ADMIN_USER_INITIAL_PASSWORD,
        isAdmin: false,
      },
      key: randomUUID(),
    });
    expect(reused.status).toBe(200);
    expect(adminUserItemSchema.parse(await reused.json()).loginName).toBe(
      original.loginName,
    );

    expect(
      (
        await request("/admin/users", "GET", {
          ...target,
          cookie: deletionSession.cookie,
          csrf: deletionSession.csrf,
        })
      ).status,
    ).toBe(401);
  });

  it("拒绝无重认证、无幂等键和非法字段，不泄露数据库错误", async () => {
    const actor = await seedUser({ admin: true });
    const loginName = `f03_reject_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const memberSession = await seedUser({ admin: false });
    const noReauthResponse = await request(
      "/admin/users",
      "POST",
      memberSession,
      {
        body: {
          loginName,
          name: "拒绝用户",
          password: ADMIN_USER_INITIAL_PASSWORD,
        },
      },
    );
    expect(noReauthResponse.status).toBe(403);

    const invalidResponse = await request("/admin/users", "POST", actor, {
      body: { loginName: " ", name: " ", password: "x" },
    });
    expect(invalidResponse.status).toBe(422);

    const missingKeyResponse = await request("/admin/users", "POST", actor, {
      body: {
        loginName,
        name: "拒绝用户",
        password: ADMIN_USER_INITIAL_PASSWORD,
      },
      key: "",
    });
    expect(missingKeyResponse.status).toBe(400);

    const staleTarget = await seedUser({ admin: false });
    const staleResponse = await request(
      `/admin/users/${staleTarget.userId}`,
      "PATCH",
      actor,
      {
        body: { name: "旧版本" },
        version: 999999,
      },
    );
    expect(staleResponse.status).toBe(409);
    const payload = await staleResponse.json();
    expect(JSON.stringify(payload)).not.toContain("SELECT");
    expect(JSON.stringify(payload)).not.toContain("constraint_name");
  });

  it("拒绝自停用，审计失败时整个用户创建回滚", async () => {
    const actor = await seedUser({ admin: true });
    const selfVersion = await authVersionFor(actor.userId);
    await expect(
      uow.run((tx) =>
        userService.disable(
          tx,
          metaFor(actor, randomUUID()),
          actor.userId,
          selfVersion,
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_USER_SELF_MUTATION_REJECTED",
    });

    const rollbackActor = await seedUser({ admin: true });
    const rollbackLogin = `f03_rollback_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const failingAudit = {
      append: vi.fn().mockRejectedValue(new Error("audit downstream failed")),
    } as never;
    const failingService = new AdminUserService(
      repository,
      new AdminUserOffboardingRepository(),
      sessions,
      highRisk,
      failingAudit,
      new PostgresProjectMembersQueryPort(),
      new PostgresProjectLeaderTransferPort(
        new PostgresProjectsWritePort(),
        failingAudit,
        new PostgresActivityWritePort(),
      ),
      new ProjectMemberTaskCommandPort(
        new TaskManagementRepository(),
        taskManagement,
      ),
      taskDeletionCommands,
      taskDeletionWorkflow,
    );
    await expect(
      uow.run((tx) =>
        failingService.create(
          tx,
          metaFor(rollbackActor, randomUUID()),
          {
            loginName: rollbackLogin,
            name: "回滚用户",
            password: ADMIN_USER_INITIAL_PASSWORD,
            isAdmin: false,
          },
          "$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture-hash",
        ),
      ),
    ).rejects.toThrow("audit downstream failed");
    const rows = (await client.sql`
      SELECT count(*)::int AS count
        FROM app.users
       WHERE login_name = ${rollbackLogin}
    `) as unknown as readonly { count: number }[];
    expect(rows[0]!.count).toBe(0);
  });
});

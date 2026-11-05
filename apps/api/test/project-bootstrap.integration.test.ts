import { randomUUID } from "node:crypto";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import {
  PostgresActiveUsersQueryPort,
  PostgresProjectsWritePort,
} from "../src/modules/projects/postgres-projects-write-port.js";
import {
  ProjectBootstrapValidationError,
  ProjectBootstrapWorkflow,
  ProjectCodeConflictError,
} from "../src/modules/projects/project-bootstrap.workflow.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { ModuleCreateCommandPort } from "../src/modules/modules/create.command-port.js";
import { ModuleManagementRepository } from "../src/modules/modules/module-management.repository.js";
import { ModulesManagementService } from "../src/modules/modules/modules-management.service.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { TaskCreateCommandPort } from "../src/modules/tasks/create.command-port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { ProjectMemberPermissionPolicyService } from "../src/modules/projects/project-member-permission-policy.service.js";
import { ProjectMemberPermissionRepository } from "../src/modules/projects/project-member-permission.repository.js";
import { createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient | undefined;
let auditClient: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let workflow: ProjectBootstrapWorkflow | undefined;

const auditKey = Buffer.alloc(32, 0x5b);

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-project-bootstrap-test",
  });
  auditClient = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-project-bootstrap-audit-test",
  });
  uow = new PostgresUnitOfWork(client);
  const access = new PostgresProjectAccessQueryPort(client);
  const audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => auditKey,
  });
  const search = new PostgresSearchProjectionWritePort();
  const activity = new PostgresActivityWritePort();
  const notifications = new ProjectNotificationDispatcher(
    access,
    new PostgresNotificationWritePort(),
  );
  const projects = new PostgresProjectsWritePort();
  const permissions = new ProjectMemberPermissionPolicyService(
    new ProjectMemberPermissionRepository(),
  );
  const modulesService = new ModulesManagementService(
    access,
    uow,
    new ModuleManagementRepository(),
    audit,
    activity,
    search,
    permissions,
  );
  const tasksService = new TasksManagementService(
    access,
    new PostgresModuleQueryPort(),
    new PostgresProjectCodePort(),
    new PostgresProjectMembersQueryPort(),
    uow,
    new TaskManagementRepository(),
    audit,
    activity,
    search,
    notifications,
    new PostgresModuleReadPort(),
    projects,
    permissions,
  );
  workflow = new ProjectBootstrapWorkflow(
    projects,
    new PostgresActiveUsersQueryPort(),
    audit,
    search,
    activity,
    notifications,
    new ModuleCreateCommandPort(modulesService),
    new TaskCreateCommandPort(tasksService),
  );
});

afterAll(async () => {
  await client?.close();
  await auditClient?.close();
});

interface MemberRow {
  readonly user_id: number;
  readonly status: string;
}

describe("ProjectBootstrapWorkflow (real PostgreSQL)", () => {
  test("成功创建项目：创建者+项目成员+空模块集合+审计+三投影同事务", async () => {
    const creatorId = await createUser(client!.sql);
    const memberId = await createUser(client!.sql);
    const name = `项目 ${randomUUID()}`;

    const result = await uow!.run((tx) =>
      workflow!.execute(tx, creatorId, {
        name,
        description: "描述",
        memberIds: [memberId],
      }),
    );

    expect(result.responseStatus).toBe(200);
    expect(result.responseSchemaRef).toBe("CreateProjectResponse");
    expect(result.responseHasBody).toBe(true);
    expect(result.replayAuthContext).toEqual({
      projectId: result.body.project.id,
      actorUserId: creatorId,
    });

    const projectId = result.body.project.id;
    const projects = (await client!.sql`
        SELECT id, code, name, status, row_version, created_by
          FROM app.projects
         WHERE id = ${projectId}
    `) as unknown as readonly {
      id: number;
      code: string;
      name: string;
      status: string;
      row_version: number;
      created_by: number;
    }[];
    expect(projects).toHaveLength(1);
    expect(projects[0]!.status).toBe("NOT_STARTED");
    expect(projects[0]!.created_by).toBe(creatorId);

    const members = (await client!.sql`
        SELECT user_id, status
          FROM app.project_members
         WHERE project_id = ${projectId}
         ORDER BY user_id ASC
    `) as unknown as readonly MemberRow[];
    expect(members.map((row) => row.user_id)).toEqual(
      [creatorId, memberId].sort((left, right) => left - right),
    );
    expect(members.every((row) => row.status === "ACTIVE")).toBe(true);

    const modules = (await client!.sql`
        SELECT id, kind, name
          FROM app.modules
         WHERE project_id = ${projectId}
           AND kind = 'UNCLASSIFIED'
    `) as unknown as readonly { id: number; kind: string; name: string }[];
    expect(modules).toHaveLength(0);

    const audits = (await auditClient!.sql`
        SELECT action, chain_id, target_id
          FROM app.audit_logs
         WHERE project_id = ${projectId}
    `) as unknown as readonly {
      action: string;
      chain_id: string;
      target_id: string;
    }[];
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("project.create");
    expect(audits[0]!.chain_id).toBe(`PROJECT:${projectId}`);

    const searchRows = (await client!.sql`
        SELECT entity_type, title
          FROM app.search_projection
         WHERE project_id = ${projectId}
    `) as unknown as readonly { entity_type: string; title: string }[];
    expect(searchRows).toHaveLength(1);
    expect(searchRows[0]!.entity_type).toBe("PROJECT");
    expect(searchRows[0]!.title).toBe(name);

    const activityRows = (await client!.sql`
        SELECT activity_type, source_entity_type
          FROM app.activity_projection
         WHERE project_id = ${projectId}
    `) as unknown as readonly {
      activity_type: string;
      source_entity_type: string;
    }[];
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]!.activity_type).toBe("PROJECT_CREATED");
    expect(activityRows[0]!.source_entity_type).toBe("PROJECT");

    const notifications = (await client!.sql`
        SELECT recipient_id, project_id, target_path
          FROM app.notifications
         WHERE project_id = ${projectId}
    `) as unknown as readonly {
      recipient_id: number;
      project_id: number;
      target_path: string;
    }[];
    expect(notifications.length).toBeGreaterThanOrEqual(2);
    expect(
      notifications.every(
        (row) => row.target_path === `/projects/${projectId}/activity`,
      ),
    ).toBe(true);
  });

  test("仅创建者：保留项目成员历史且项目不创建模块", async () => {
    const creatorId = await createUser(client!.sql);
    const name = `仅创建者 ${randomUUID()}`;
    const result = await uow!.run((tx) =>
      workflow!.execute(tx, creatorId, {
        name,
        description: "auto member",
        memberIds: [],
      }),
    );
    const projectId = result.body.project.id;
    const modules = (await client!.sql`
        SELECT id FROM app.modules
         WHERE project_id = ${projectId}
           AND kind = 'UNCLASSIFIED'
    `) as unknown as readonly { id: number }[];
    expect(modules).toHaveLength(0);
    const memberRows = (await client!.sql`
        SELECT user_id, status FROM app.project_members
         WHERE project_id = ${projectId}
    `) as unknown as readonly MemberRow[];
    expect(memberRows).toEqual([{ user_id: creatorId, status: "ACTIVE" }]);
  });

  test("可在同一事务内创建模块与任务，并保留负责人归属", async () => {
    const creatorId = await createUser(client!.sql);
    const memberId = await createUser(client!.sql);
    const name = `带结构 ${randomUUID()}`;

    const result = await uow!.run((tx) =>
      workflow!.execute(tx, creatorId, {
        name,
        description: "一次建好模块与任务",
        memberIds: [memberId],
        modules: [
          {
            name: "扫码巡检",
            description: "扫码与异常上报",
            tasks: [
              {
                title: "完成扫码入口",
                description: "验收：首次扫码后可看到最近记录",
                priority: "HIGH",
                assigneeIds: [memberId],
                dueAt: "2026-12-01T00:00:00.000Z",
              },
            ],
          },
          {
            name: "离线补传",
            description: "",
            tasks: [],
          },
        ],
      }),
    );

    const projectId = result.body.project.id;
    const modules = (await client!.sql`
        SELECT id, name
          FROM app.modules
         WHERE project_id = ${projectId}
         ORDER BY sort_order ASC, id ASC
    `) as unknown as readonly { id: number; name: string }[];
    expect(modules.map((row) => row.name)).toEqual(["扫码巡检", "离线补传"]);

    const tasks = (await client!.sql`
        SELECT id, module_id, title, priority, due_at
          FROM app.tasks
         WHERE project_id = ${projectId}
    `) as unknown as readonly {
      id: number;
      module_id: number;
      title: string;
      priority: string;
      due_at: string | null;
    }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.module_id).toBe(modules[0]!.id);
    expect(tasks[0]!.title).toBe("完成扫码入口");
    expect(tasks[0]!.priority).toBe("HIGH");
    expect(new Date(String(tasks[0]!.due_at)).toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );

    const assignees = (await client!.sql`
        SELECT task_id, user_id
          FROM app.task_assignees
         WHERE project_id = ${projectId}
    `) as unknown as readonly { task_id: number; user_id: number }[];
    expect(assignees).toEqual([{ task_id: tasks[0]!.id, user_id: memberId }]);

    const audits = (await auditClient!.sql`
        SELECT action FROM app.audit_logs WHERE project_id = ${projectId}
    `) as unknown as readonly { action: string }[];
    const actions = audits.map((row) => row.action);
    expect(actions).toContain("project.create");
    expect(actions).toContain("module.create");
    expect(actions).toContain("task.create");

    const searchRows = (await client!.sql`
        SELECT entity_type FROM app.search_projection WHERE project_id = ${projectId}
    `) as unknown as readonly { entity_type: string }[];
    expect(new Set(searchRows.map((row) => row.entity_type))).toEqual(
      new Set(["PROJECT", "MODULE", "TASK"]),
    );
  });

  test("任务负责人不在项目成员内时整笔回滚", async () => {
    const creatorId = await createUser(client!.sql);
    const outsiderId = await createUser(client!.sql);
    const name = `越权负责人 ${randomUUID()}`;

    await expect(
      uow!.run((tx) =>
        workflow!.execute(tx, creatorId, {
          name,
          description: "",
          memberIds: [],
          modules: [
            {
              name: "巡检",
              description: "",
              tasks: [
                {
                  title: "越权任务",
                  description: "",
                  priority: "NORMAL",
                  assigneeIds: [outsiderId],
                  dueAt: null,
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapValidationError);

    const leftover = (await client!.sql`
        SELECT id FROM app.projects WHERE name = ${name}
    `) as unknown as readonly { id: number }[];
    expect(leftover).toHaveLength(0);
  });

  test("项目成员为停用用户时整笔回滚", async () => {
    const creatorId = await createUser(client!.sql);
    const disabledId = await createUser(client!.sql, { disabled: true });
    const name = `停用成员 ${randomUUID()}`;

    await expect(
      uow!.run((tx) =>
        workflow!.execute(tx, creatorId, {
          name,
          description: "",
          memberIds: [disabledId],
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapValidationError);

    const leftover = (await client!.sql`
        SELECT id FROM app.projects
         WHERE name = ${name}
    `) as unknown as readonly { id: number }[];
    expect(leftover).toHaveLength(0);
  });

  test("项目成员为不存在用户时整笔回滚", async () => {
    const creatorId = await createUser(client!.sql);
    const name = `不存在成员 ${randomUUID()}`;
    const ghostId = 2147483647;

    await expect(
      uow!.run((tx) =>
        workflow!.execute(tx, creatorId, {
          name,
          description: "",
          memberIds: [ghostId],
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapValidationError);

    const leftover = (await client!.sql`
        SELECT id FROM app.projects
         WHERE name = ${name}
    `) as unknown as readonly { id: number }[];
    expect(leftover).toHaveLength(0);
  });

  test("重复项目编码：映射为 409 PROJECT_CODE_CONFLICT 且不写入第二行", async () => {
    const creatorId = await createUser(client!.sql);
    const code = `DUP_${randomUUID()
      .replace(/[^0-9a-f]/g, "")
      .slice(0, 8)
      .toUpperCase()}`;
    await uow!.run((tx) =>
      workflow!.execute(tx, creatorId, {
        code,
        name: `首个项目 ${randomUUID()}`,
        description: "",
        memberIds: [],
      }),
    );

    const failure = await uow!
      .run((tx) =>
        workflow!.execute(tx, creatorId, {
          code,
          name: `重复编码 ${randomUUID()}`,
          description: "",
          memberIds: [],
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProjectCodeConflictError);
    expect(failure).toMatchObject({
      status: 409,
      code: "PROJECT_CODE_CONFLICT",
    });

    const rows = (await client!.sql`
        SELECT id FROM app.projects WHERE code = ${code}
    `) as unknown as readonly { id: number }[];
    expect(rows).toHaveLength(1);
  });
});

import { postgresProjectMemberPermissions } from "./project-member-permission.helpers.js";
import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import type { TaskStatusRequest } from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import { PostgresFeatureQueryPort } from "../src/modules/features/postgres-feature-query-port.js";
import { PostgresFeatureReadPort } from "../src/modules/features/postgres-feature-read-port.js";
import { PostgresModuleQueryPort } from "../src/modules/modules/postgres-module-query-port.js";
import { PostgresModuleReadPort } from "../src/modules/modules/postgres-module-read-port.js";
import { ProjectNotificationDispatcher } from "../src/modules/projects/project-notification.dispatcher.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { PostgresProjectAccessQueryPort } from "../src/modules/projects/postgres-project-access-query-port.js";
import { PostgresProjectCodePort } from "../src/modules/projects/postgres-project-code-port.js";
import { PostgresProjectMembersQueryPort } from "../src/modules/projects/postgres-project-members-query-port.js";
import { PostgresProjectsWritePort } from "../src/modules/projects/postgres-projects-write-port.js";
import { PostgresSearchProjectionWritePort } from "../src/modules/search/postgres-search-projection-write-port.js";
import { TaskManagementRepository } from "../src/modules/tasks/task-management.repository.js";
import { TasksManagementService } from "../src/modules/tasks/tasks-management.service.js";
import { createProject, createUser, testUrls } from "./database.helpers.js";

/**
 * ADR-056 / ADR-057：维护中项目只要有任务重新变为未收尾（新建、重新打开或恢复），
 * 就在同一事务内回到进行中。这是真实 PostgreSQL 上的端到端证据：状态、审计、活动、
 * 搜索投影与通知由同一个 UnitOfWork 写入，未经 Mock。
 */
const key = randomBytes(32);
let db: DatabaseClient;
let auditDb: DatabaseClient;
let uow: PostgresUnitOfWork;
let management: TasksManagementService;

beforeAll(() => {
  db = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-adr056-maintenance-reopen",
  });
  auditDb = createDatabaseClient(testUrls().auditReader);
  uow = new PostgresUnitOfWork(db);
  const access = new PostgresProjectAccessQueryPort(db);
  management = new TasksManagementService(
    access,
    new PostgresModuleQueryPort(),
    new PostgresFeatureQueryPort(),
    new PostgresFeatureReadPort(),
    new PostgresProjectCodePort(),
    new PostgresProjectMembersQueryPort(),
    uow,
    new TaskManagementRepository(),
    new PostgresAuditWritePort({ currentVersion: 1, keyFor: () => key }),
    new PostgresActivityWritePort(),
    new PostgresSearchProjectionWritePort(),
    new ProjectNotificationDispatcher(
      access,
      new PostgresNotificationWritePort(),
    ),
    new PostgresModuleReadPort(),
    new PostgresProjectsWritePort(),
    postgresProjectMemberPermissions(),
  );
});

afterAll(async () => {
  await db?.close();
  await auditDb?.close();
});

interface Fixture {
  readonly featureId: number;
  readonly moduleId: number;
  readonly projectId: number;
  readonly userId: number;
}

async function fixture(): Promise<Fixture> {
  const userId = await createUser(db.sql);
  const project = await createProject(db.sql, userId);
  const feature = (await db.sql`
    INSERT INTO app.features (project_id, module_id, code, name, created_by)
    VALUES (${project.projectId}, ${project.moduleId}, ${`${project.code}-F-1`}, '维护期功能', ${userId})
    RETURNING id
  `) as unknown as readonly { id: number }[];
  if (feature[0] === undefined) throw new Error("feature fixture failed");
  return {
    featureId: feature[0].id,
    moduleId: project.moduleId,
    projectId: project.projectId,
    userId,
  };
}

const toMaintenance = (f: Fixture) =>
  db.sql`
    UPDATE app.projects
       SET status = 'MAINTENANCE',
           row_version = row_version + 1
     WHERE id = ${f.projectId}
  `;

const toActive = (f: Fixture) =>
  db.sql`
    UPDATE app.projects
       SET status = 'ACTIVE',
           row_version = row_version + 1
     WHERE id = ${f.projectId}
  `;

const readProject = async (projectId: number) =>
  (await db.sql`
    SELECT status, first_task_completed_at AS "firstTaskCompletedAt",
           row_version AS "rowVersion"
      FROM app.projects
     WHERE id = ${projectId}
  `) as unknown as readonly {
    status: string;
    firstTaskCompletedAt: Date | null;
    rowVersion: number;
  }[];

const statusAudits = async (projectId: number) =>
  (await auditDb.sql`
    SELECT actor_id AS "actorId", target_type AS "targetType",
           target_id AS "targetId", event_payload AS "eventPayload"
      FROM app.audit_logs
     WHERE project_id = ${projectId} AND action = 'project.status.change'
     ORDER BY sequence_no
  `) as unknown as readonly {
    actorId: number;
    targetType: string;
    targetId: string;
    eventPayload: Record<string, unknown>;
  }[];

const statusActivities = async (projectId: number) =>
  (await db.sql`
    SELECT activity_type AS "activityType", actor_id AS "actorId",
           metadata, source_status AS "sourceStatus",
           source_row_version AS "sourceRowVersion"
      FROM app.activity_projection
     WHERE project_id = ${projectId} AND activity_type = 'PROJECT_STATUS_CHANGED'
     ORDER BY id
  `) as unknown as readonly {
    activityType: string;
    actorId: number;
    metadata: Record<string, unknown>;
    sourceStatus: string;
    sourceRowVersion: number;
  }[];

const statusNotifications = (projectId: number) =>
  db.sql`
    SELECT id
      FROM app.notifications
     WHERE project_id = ${projectId} AND notification_type = 'project.status.change'
  `;

function create(
  f: Fixture,
  options: { readonly featureLevel?: boolean; readonly title?: string } = {},
) {
  const featureLevel = options.featureLevel ?? true;
  return uow.run((tx) =>
    management.execute(tx, {
      projectId: f.projectId,
      moduleId: f.moduleId,
      featureId: featureLevel ? f.featureId : null,
      operation: featureLevel ? "createTask" : "createModuleTask",
      actorId: f.userId,
      edit: {
        title: options.title ?? "维护期新任务",
        description: "维护期说明",
        priority: "NORMAL",
        assigneeIds: [f.userId],
        dueAt: null,
      },
      requestId: randomUUID(),
    }),
  );
}

/** 直接驱动 TasksManagementService.transition（兼容路由 REOPEN / CANCEL / RESTORE）。 */
function transitionInput(
  f: Fixture,
  task: { readonly id: number; readonly rowVersion: number },
  command: TaskStatusRequest,
  requestId: string = randomUUID(),
): Parameters<TasksManagementService["transition"]>[1] {
  return {
    projectId: f.projectId,
    moduleId: f.moduleId,
    featureId: f.featureId,
    actorId: f.userId,
    taskId: task.id,
    version: task.rowVersion,
    command,
    requestId,
  };
}

const transition = (
  f: Fixture,
  task: { readonly id: number; readonly rowVersion: number },
  command: TaskStatusRequest,
) =>
  uow.run((tx) => management.transition(tx, transitionInput(f, task, command)));

const completeWithoutRecord = (
  f: Fixture,
  task: { readonly id: number; readonly rowVersion: number },
) =>
  transition(f, task, {
    action: "COMPLETE",
    mode: "WITHOUT_RECORD",
    completionReason: "测试验证",
    note: "",
  });

describe("ADR-056 / ADR-057 任务重新变为未收尾时维护中项目回到进行中", () => {
  it("维护中项目新建功能级任务后回到进行中，并写审计、活动与搜索投影，但不发通知", async () => {
    const f = await fixture();
    await toMaintenance(f);
    const before = (await readProject(f.projectId))[0]!;
    expect(before).toMatchObject({
      status: "MAINTENANCE",
      firstTaskCompletedAt: null,
    });

    const task = await create(f);

    const after = (await readProject(f.projectId))[0]!;
    expect(after.status).toBe("ACTIVE");
    // ADR-092：维护中回到进行中只改状态，项目内容版本保持不变
    expect(after.rowVersion).toBe(before.rowVersion);
    // ADR-035 的粘性标记只由任务完成置位，创建任务不得写入
    expect(after.firstTaskCompletedAt).toBeNull();

    const audits = await statusAudits(f.projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: f.userId,
      targetType: "PROJECT",
      targetId: String(f.projectId),
    });
    expect(audits[0]!.eventPayload).toMatchObject({
      automatic: true,
      trigger: "TASK_CREATED",
      taskId: task.id,
      before: { status: "MAINTENANCE" },
      after: { status: "ACTIVE" },
    });

    const activities = await statusActivities(f.projectId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      actorId: f.userId,
      sourceStatus: "ACTIVE",
      sourceRowVersion: after.rowVersion,
    });
    expect(activities[0]!.metadata).toMatchObject({
      trigger: "TASK_CREATED",
      taskId: task.id,
    });

    const projection = (await db.sql`
      SELECT source_status AS "sourceStatus", source_row_version AS "sourceRowVersion"
        FROM app.search_projection
       WHERE entity_type = 'PROJECT' AND entity_id = ${f.projectId}
    `) as unknown as readonly {
      sourceStatus: string;
      sourceRowVersion: number;
    }[];
    expect(projection[0]).toMatchObject({
      sourceStatus: "ACTIVE",
      sourceRowVersion: after.rowVersion,
    });

    // ADR-035 通知口径：只有「未开始 → 进行中」通知全体成员
    expect(await statusNotifications(f.projectId)).toHaveLength(0);

    // 项目已经是进行中，同项目再建任务不会反复推高版本、也不重复写审计
    await create(f, { title: "维护期第二个任务" });
    const again = (await readProject(f.projectId))[0]!;
    expect(again).toMatchObject({
      status: "ACTIVE",
      rowVersion: after.rowVersion,
    });
    expect(await statusAudits(f.projectId)).toHaveLength(1);
    expect(await statusActivities(f.projectId)).toHaveLength(1);
  });

  it("维护中项目新建模块级任务同样回到进行中", async () => {
    const f = await fixture();
    await toMaintenance(f);
    const before = (await readProject(f.projectId))[0]!;

    const task = await create(f, { featureLevel: false });

    expect(task.featureId).toBeNull();
    const after = (await readProject(f.projectId))[0]!;
    expect(after.status).toBe("ACTIVE");
    expect(after.rowVersion).toBe(before.rowVersion);
    const audits = await statusAudits(f.projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.eventPayload).toMatchObject({
      automatic: true,
      trigger: "TASK_CREATED",
      taskId: task.id,
    });
  });

  it("未开始与进行中项目新建任务不改变状态，也不写状态变更副作用", async () => {
    const notStarted = await fixture();
    const notStartedBefore = (await readProject(notStarted.projectId))[0]!;
    await create(notStarted);
    expect((await readProject(notStarted.projectId))[0]).toMatchObject({
      status: "NOT_STARTED",
      rowVersion: notStartedBefore.rowVersion,
    });
    expect(await statusAudits(notStarted.projectId)).toHaveLength(0);
    expect(await statusActivities(notStarted.projectId)).toHaveLength(0);

    const active = await fixture();
    await toActive(active);
    const activeBefore = (await readProject(active.projectId))[0]!;
    await create(active);
    expect((await readProject(active.projectId))[0]).toMatchObject({
      status: "ACTIVE",
      rowVersion: activeBefore.rowVersion,
    });
    expect(await statusAudits(active.projectId)).toHaveLength(0);
    expect(await statusActivities(active.projectId)).toHaveLength(0);
  });

  it("编辑任务不会把维护中项目拉回进行中", async () => {
    const f = await fixture();
    const task = await create(f);
    await toMaintenance(f);
    const maintenance = (await readProject(f.projectId))[0]!;

    await uow.run((tx) =>
      management.execute(tx, {
        projectId: f.projectId,
        moduleId: f.moduleId,
        featureId: f.featureId,
        operation: "updateTask",
        actorId: f.userId,
        taskId: task.id,
        version: task.rowVersion,
        edit: {
          title: "维护期改名",
          description: "维护期说明",
          priority: "NORMAL",
          assigneeIds: [f.userId],
          dueAt: null,
        },
        requestId: randomUUID(),
      }),
    );

    expect(await readProject(f.projectId)).toMatchObject([
      { status: "MAINTENANCE", rowVersion: maintenance.rowVersion },
    ]);
    expect(await statusAudits(f.projectId)).toHaveLength(0);
    expect(await statusActivities(f.projectId)).toHaveLength(0);
  });

  it("任务创建与项目状态变更在同一事务，任一步失败都不留痕", async () => {
    const f = await fixture();
    await toMaintenance(f);
    const before = (await readProject(f.projectId))[0]!;

    await expect(
      uow.run(async (tx) => {
        await management.execute(tx, {
          projectId: f.projectId,
          moduleId: f.moduleId,
          featureId: f.featureId,
          operation: "createTask",
          actorId: f.userId,
          edit: {
            title: "会回滚的任务",
            description: "维护期说明",
            priority: "NORMAL",
            assigneeIds: [f.userId],
            dueAt: null,
          },
          requestId: randomUUID(),
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    expect(await readProject(f.projectId)).toMatchObject([
      { status: "MAINTENANCE", rowVersion: before.rowVersion },
    ]);
    expect(
      await db.sql`
        SELECT id FROM app.tasks
         WHERE project_id = ${f.projectId} AND title = '会回滚的任务'
      `,
    ).toHaveLength(0);
    expect(await statusAudits(f.projectId)).toHaveLength(0);
    expect(await statusActivities(f.projectId)).toHaveLength(0);
    expect(
      await db.sql`
        SELECT entity_id FROM app.search_projection
         WHERE entity_type = 'PROJECT' AND entity_id = ${f.projectId}
      `,
    ).toHaveLength(0);
  });

  it("维护中项目重新打开已完成任务后回到进行中，审计 trigger 为 TASK_REOPENED", async () => {
    const f = await fixture();
    const task = await create(f);
    await toMaintenance(f);
    const maintenance = (await readProject(f.projectId))[0]!;

    // 完成不触发：已完成任务不会让维护中项目重新开工
    const done = await completeWithoutRecord(f, task);
    expect(done.workStatus).toBe("DONE");
    expect(await readProject(f.projectId)).toMatchObject([
      { status: "MAINTENANCE", rowVersion: maintenance.rowVersion },
    ]);
    expect(await statusAudits(f.projectId)).toHaveLength(0);

    const reopened = await transition(f, done, {
      action: "REOPEN",
      reason: null,
    });
    expect(reopened.workStatus).toBe("TODO");

    const after = (await readProject(f.projectId))[0]!;
    expect(after.status).toBe("ACTIVE");
    expect(after.rowVersion).toBe(maintenance.rowVersion);
    // ADR-035 的粘性标记只由首次任务完成置位，状态流转不得写入
    expect(after.firstTaskCompletedAt).toBeNull();

    const audits = await statusAudits(f.projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: f.userId,
      targetType: "PROJECT",
      targetId: String(f.projectId),
    });
    expect(audits[0]!.eventPayload).toMatchObject({
      automatic: true,
      trigger: "TASK_REOPENED",
      taskId: task.id,
      before: { status: "MAINTENANCE" },
      after: { status: "ACTIVE" },
    });

    const activities = await statusActivities(f.projectId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      actorId: f.userId,
      sourceStatus: "ACTIVE",
      sourceRowVersion: after.rowVersion,
    });
    expect(activities[0]!.metadata).toMatchObject({
      trigger: "TASK_REOPENED",
      taskId: task.id,
    });

    const projection = (await db.sql`
      SELECT source_status AS "sourceStatus", source_row_version AS "sourceRowVersion"
        FROM app.search_projection
       WHERE entity_type = 'PROJECT' AND entity_id = ${f.projectId}
    `) as unknown as readonly {
      sourceStatus: string;
      sourceRowVersion: number;
    }[];
    expect(projection[0]).toMatchObject({
      sourceStatus: "ACTIVE",
      sourceRowVersion: after.rowVersion,
    });

    // ADR-035 通知口径：项目状态变更不发通知
    expect(await statusNotifications(f.projectId)).toHaveLength(0);
  });

  it("维护中项目恢复已取消任务后回到进行中，审计 trigger 为 TASK_RESTORED", async () => {
    const f = await fixture();
    const task = await create(f);
    // 取消走同一条兼容路由，但任务并没有重新变成未收尾，因此不触发
    const canceled = await transition(f, task, {
      action: "CANCEL",
      reason: "维护期不再跟进",
    });
    expect(canceled.workStatus).toBe("CANCELED");
    expect(await statusAudits(f.projectId)).toHaveLength(0);

    await toMaintenance(f);
    const maintenance = (await readProject(f.projectId))[0]!;

    const restored = await transition(f, canceled, {
      action: "RESTORE",
      reason: null,
    });
    expect(restored.workStatus).toBe("TODO");

    const after = (await readProject(f.projectId))[0]!;
    expect(after).toMatchObject({
      status: "ACTIVE",
      rowVersion: maintenance.rowVersion,
    });
    const audits = await statusAudits(f.projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.eventPayload).toMatchObject({
      automatic: true,
      trigger: "TASK_RESTORED",
      taskId: task.id,
      before: { status: "MAINTENANCE" },
      after: { status: "ACTIVE" },
    });
    const activities = await statusActivities(f.projectId);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.metadata).toMatchObject({
      trigger: "TASK_RESTORED",
      taskId: task.id,
    });
    expect(await statusNotifications(f.projectId)).toHaveLength(0);
  });

  it("进行中项目重新打开任务不写项目状态变更副作用", async () => {
    const f = await fixture();
    const task = await create(f);
    const done = await completeWithoutRecord(f, task);
    await toActive(f);
    const active = (await readProject(f.projectId))[0]!;

    await transition(f, done, { action: "REOPEN", reason: null });

    expect(await readProject(f.projectId)).toMatchObject([
      { status: "ACTIVE", rowVersion: active.rowVersion },
    ]);
    expect(await statusAudits(f.projectId)).toHaveLength(0);
    expect(await statusActivities(f.projectId)).toHaveLength(0);
  });

  it("任务重新打开与项目状态切换在同一事务，失败一起回滚", async () => {
    const f = await fixture();
    const task = await create(f);
    const done = await completeWithoutRecord(f, task);
    await toMaintenance(f);
    const maintenance = (await readProject(f.projectId))[0]!;

    await expect(
      uow.run(async (tx) => {
        await management.transition(
          tx,
          transitionInput(f, done, { action: "REOPEN", reason: null }),
        );
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    expect(await readProject(f.projectId)).toMatchObject([
      { status: "MAINTENANCE", rowVersion: maintenance.rowVersion },
    ]);
    expect(
      (await db.sql`
        SELECT work_status AS "workStatus", row_version AS "rowVersion"
          FROM app.tasks WHERE id = ${task.id}
      `) as unknown as readonly { workStatus: string; rowVersion: number }[],
    ).toMatchObject([{ workStatus: "DONE", rowVersion: done.rowVersion }]);
    expect(await statusAudits(f.projectId)).toHaveLength(0);
    expect(await statusActivities(f.projectId)).toHaveLength(0);
    expect(
      await db.sql`
        SELECT id FROM app.notifications
         WHERE project_id = ${f.projectId} AND notification_type = 'task.reopen'
      `,
    ).toHaveLength(0);
  });
});

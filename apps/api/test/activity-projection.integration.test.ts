import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "@inpulse/database/client";
import { createDatabaseClient } from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import {
  ActivityWriteValidationError,
  type ActivityWriteInput,
} from "../src/modules/activity/activity.write-port.js";
import { PostgresActivityProjectionReader } from "../src/modules/activity/activity-projection.reader.js";
import { PostgresActivityWritePort } from "../src/modules/activity/postgres-activity-write-port.js";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let client: DatabaseClient | undefined;
let bootstrap: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let auditPort: PostgresAuditWritePort | undefined;
let activityPort: PostgresActivityWritePort | undefined;
let userA: number | undefined;
let project: ProjectFixture | undefined;

const auditKey = Buffer.alloc(32, 0x7a);

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-activity-projection-test",
  });
  bootstrap = createDatabaseClient(testUrls().bootstrap, {
    applicationName: "inpulse-activity-projection-bootstrap-test",
  });
  uow = new PostgresUnitOfWork(client);
  auditPort = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => auditKey,
  });
  activityPort = new PostgresActivityWritePort();
  userA = await createUser(client.sql);
  project = await createProject(client.sql, userA);
});

afterAll(async () => {
  await client?.close();
  await bootstrap?.close();
});

describe("PostgresActivityWritePort (real PostgreSQL)", () => {
  test("在同一事务内写入审计与活动投影，重复来源事件不重复", async () => {
    const occurredAt = new Date("2026-09-08T00:00:01.000Z");
    const sequence = await appendActivity({
      sourceEntityId: 101,
      activityType: "TASK_COMPLETED",
      summary: "完成登录任务",
      sourceStatus: "DONE",
      sourceRowVersion: 1,
      occurredAt,
    });
    expect(sequence).toBeGreaterThan(0);

    await uow!.run((tx) =>
      activityPort!.append(
        tx,
        activityInput(sequence, {
          sourceEntityId: 101,
          activityType: "TASK_COMPLETED",
          summary: "完成登录任务",
          sourceStatus: "DONE",
          sourceRowVersion: 1,
          occurredAt,
        }),
      ),
    );

    const rows = (await client!.sql`
      SELECT id::text AS id,
             source_entity_id AS "sourceEntityId",
             activity_type AS "activityType",
             actor_snapshot AS "actorSnapshot",
             summary,
             visibility_scope AS "visibilityScope",
             source_status AS "sourceStatus",
             source_row_version AS "sourceRowVersion"
        FROM app.activity_projection
       WHERE project_id = ${project!.projectId}
    `) as unknown as readonly {
      id: string;
      sourceEntityId: number;
      activityType: string;
      actorSnapshot: {
        readonly id: number;
        readonly name: string;
        readonly loginName: string;
      };
      summary: string;
      visibilityScope: string;
      sourceStatus: string;
      sourceRowVersion: number;
    }[];
    expect(rows.filter((row) => row.sourceEntityId === 101)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceEntityId: 101,
      activityType: "TASK_COMPLETED",
      actorSnapshot: {
        id: userA!,
        name: expect.any(String),
        loginName: expect.any(String),
      },
      summary: "完成登录任务",
      visibilityScope: "MEMBER",
      sourceStatus: "DONE",
      sourceRowVersion: 1,
    });
  });

  test("USER 操作人缺失时动态写入失败并回滚", async () => {
    await expect(
      uow!.run((tx) =>
        activityPort!.append(
          tx,
          activityInput(999, {
            actorId: 2_147_483_647,
            sourceEntityId: 405,
            activityType: "TASK_COMPLETED",
            summary: "不存在的操作人",
            sourceStatus: "DONE",
            sourceRowVersion: 1,
            occurredAt: new Date("2026-09-08T00:00:02.500Z"),
          }),
        ),
      ),
    ).rejects.toThrow("activity actor does not exist");
  });

  test("SYSTEM 动态不写操作人身份快照", async () => {
    const occurredAt = new Date("2026-09-08T00:00:02.600Z");
    await uow!.run(async (tx) => {
      const audit = await auditPort!.append(tx, {
        projectId: project!.projectId,
        actorType: "SYSTEM",
        actorId: null,
        action: "SYSTEM_ACTIVITY_SNAPSHOT_TEST",
        targetType: "TASK",
        targetId: "406",
        eventPayload: { marker: "system-activity" },
        requestId: randomUUID(),
        occurredAt,
      });
      await activityPort!.append(
        tx,
        activityInput(audit.sequenceNo, {
          actorId: null,
          sourceEntityId: 406,
          activityType: "SYSTEM_ACTIVITY_SNAPSHOT_TEST",
          summary: "系统完成动态",
          sourceStatus: "DONE",
          sourceRowVersion: 1,
          occurredAt,
        }),
      );
    });

    const [row] = (await client!.sql`
      SELECT actor_id AS "actorId", actor_snapshot AS "actorSnapshot"
        FROM app.activity_projection
       WHERE project_id = ${project!.projectId}
         AND source_entity_id = 406
    `) as unknown as readonly {
      actorId: number | null;
      actorSnapshot: Record<string, unknown> | null;
    }[];
    expect(row).toEqual({ actorId: null, actorSnapshot: null });
  });

  test("物理删除操作人后项目动态仍保留快照与原摘要", async () => {
    const deletedActorId = await createUser(client!.sql);
    const [actor] = (await client!.sql`
      SELECT name, login_name AS "loginName"
        FROM app.users
       WHERE id = ${deletedActorId}
    `) as unknown as readonly { name: string; loginName: string }[];
    expect(actor).toBeDefined();

    const occurredAt = new Date("2026-09-08T00:00:02.700Z");
    const summary = `用户 ${actor!.name} 完成了任务`;

    await uow!.run(async (tx) => {
      const audit = await auditPort!.append(tx, {
        projectId: project!.projectId,
        actorType: "USER",
        actorId: deletedActorId,
        action: "TASK_COMPLETED_BY_DELETED_ACTOR",
        targetType: "TASK",
        targetId: "407",
        eventPayload: { marker: "deleted-actor-activity" },
        requestId: randomUUID(),
        occurredAt,
      });
      await activityPort!.append(
        tx,
        activityInput(audit.sequenceNo, {
          actorId: deletedActorId,
          sourceEntityId: 407,
          activityType: "TASK_COMPLETED_BY_DELETED_ACTOR",
          summary,
          sourceStatus: "DONE",
          sourceRowVersion: 1,
          occurredAt,
        }),
      );
    });

    await bootstrap!.sql`DELETE FROM app.users WHERE id = ${deletedActorId}`;
    const [remaining] = (await client!.sql`
      SELECT count(*)::INTEGER AS count
        FROM app.users
       WHERE id = ${deletedActorId}
    `) as unknown as readonly { count: number }[];
    expect(remaining?.count).toBe(0);

    const reader = new PostgresActivityProjectionReader(client!.sql);
    const page = await reader.read({
      projectIds: [project!.projectId],
      adminOnlyProjectIds: [],
      category: "all",
      limit: 100,
      after: null,
    });
    const item = page.items.find(
      (entry) =>
        entry.activityType === "TASK_COMPLETED_BY_DELETED_ACTOR" &&
        entry.sourceEntityId === 407,
    );
    expect(item).toMatchObject({
      actorId: deletedActorId,
      actorName: actor!.name,
      summary,
    });
  });

  test("派生可见性只允许向更高 row_version 推进并更新同一实体全部动态", async () => {
    const first = await appendActivity({
      sourceEntityId: 202,
      sourceEntityType: "CHANGE_RECORD",
      activityType: "CHANGE_RECORD_VOIDED",
      summary: "记录已作废",
      sourceStatus: "PUBLISHED",
      sourceRowVersion: 1,
      visibilityScope: "MEMBER",
      occurredAt: new Date("2026-09-08T00:00:03.000Z"),
    });
    await appendActivity({
      sourceEntityId: 202,
      sourceEntityType: "CHANGE_RECORD",
      activityType: "CHANGE_RECORD_PUBLISHED",
      summary: "记录已发布",
      sourceStatus: "PUBLISHED",
      sourceRowVersion: 1,
      visibilityScope: "MEMBER",
      occurredAt: new Date("2026-09-08T00:00:02.000Z"),
    });

    await uow!.run((tx) =>
      activityPort!.updateEntityVisibility(tx, {
        projectId: project!.projectId,
        sourceEntityType: "CHANGE_RECORD",
        sourceEntityId: 202,
        visibilityScope: "ADMIN_ONLY",
        sourceStatus: "VOID",
        sourceRowVersion: 2,
      }),
    );
    let rows = await entityRows(202);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.visibilityScope === "ADMIN_ONLY")).toBe(
      true,
    );
    expect(rows.every((row) => row.sourceStatus === "VOID")).toBe(true);
    expect(rows.every((row) => row.sourceRowVersion === 2)).toBe(true);

    await uow!.run((tx) =>
      activityPort!.updateEntityVisibility(tx, {
        projectId: project!.projectId,
        sourceEntityType: "CHANGE_RECORD",
        sourceEntityId: 202,
        visibilityScope: "MEMBER",
        sourceStatus: "PUBLISHED",
        sourceRowVersion: 1,
      }),
    );
    rows = await entityRows(202);
    expect(rows.every((row) => row.sourceRowVersion === 2)).toBe(true);
    expect(first).toBeGreaterThan(0);
  });

  test("后续调用失败时审计、活动投影与链表一起回滚", async () => {
    const countBefore = await activityCount();
    await expect(
      uow!.run(async (tx) => {
        const audit = await auditPort!.append(tx, auditInput("TASK_CANCELED"));
        await activityPort!.append(
          tx,
          activityInput(audit.sequenceNo, {
            sourceEntityId: 303,
            activityType: "TASK_CANCELED",
            summary: "任务已取消",
            sourceStatus: "CANCELED",
            sourceRowVersion: 1,
            occurredAt: new Date("2026-09-08T00:00:04.000Z"),
          }),
        );
        throw new Error("boom after projection write");
      }),
    ).rejects.toThrow("boom after projection write");
    expect(await activityCount()).toBe(countBefore);
  });

  test("非法输入在 SQL 前被校验拒绝", async () => {
    await expect(
      activityPort!.append(uow!.run as never, {
        ...activityInput(999, {
          sourceEntityId: 404,
          activityType: "TASK_COMPLETED",
          summary: "错误来源",
          sourceStatus: "DONE",
          sourceRowVersion: 1,
          occurredAt: new Date(),
        }),
        sourceChainId: "SYSTEM",
      }),
    ).rejects.toBeInstanceOf(ActivityWriteValidationError);
  });
});

async function appendActivity(
  overrides: Partial<ActivityWriteInput>,
): Promise<number> {
  return uow!.run(async (tx) => {
    const audit = await auditPort!.append(
      tx,
      auditInput(overrides.activityType ?? "TASK_COMPLETED"),
    );
    await activityPort!.append(tx, activityInput(audit.sequenceNo, overrides));
    return audit.sequenceNo;
  });
}

function activityInput(
  sequence: number,
  overrides: Partial<ActivityWriteInput>,
): ActivityWriteInput {
  return {
    projectId: project!.projectId,
    sourceChainId: `PROJECT:${project!.projectId}`,
    sourceSequence: sequence,
    sourceEntityType: "TASK",
    sourceEntityId: 101,
    activityType: "TASK_COMPLETED",
    actorId: userA!,
    summary: "完成登录任务",
    metadata: {},
    visibilityScope: "MEMBER",
    sourceStatus: "DONE",
    sourceRowVersion: 1,
    occurredAt: new Date("2026-09-08T00:00:05.000Z"),
    ...overrides,
  };
}

function auditInput(
  action: string,
): Parameters<PostgresAuditWritePort["append"]>[1] {
  return {
    projectId: project!.projectId,
    actorType: "USER",
    actorId: userA!,
    action,
    targetType: "TASK",
    targetId: "101",
    eventPayload: { marker: action },
    requestId: randomUUID(),
    clientRequestId: null,
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    occurredAt: new Date("2026-09-08T00:00:00.500Z"),
  };
}

async function entityRows(entityId: number) {
  return (await client!.sql`
    SELECT visibility_scope AS "visibilityScope",
           source_status AS "sourceStatus",
           source_row_version AS "sourceRowVersion"
      FROM app.activity_projection
     WHERE project_id = ${project!.projectId}
       AND source_entity_id = ${entityId}
  `) as unknown as readonly {
    visibilityScope: string;
    sourceStatus: string;
    sourceRowVersion: number;
  }[];
}

async function activityCount(): Promise<number> {
  const rows = (await client!.sql`
    SELECT count(*)::int AS count
      FROM app.activity_projection
     WHERE project_id = ${project!.projectId}
  `) as unknown as readonly { count: number }[];
  return rows[0]?.count ?? 0;
}

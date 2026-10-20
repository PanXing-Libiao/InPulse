import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "@inpulse/database/client";
import { createDatabaseClient } from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { TimeCursorService } from "../src/cursors/time-cursor.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import {
  NotificationQueryValidationError,
  NotificationQueryService,
} from "../src/modules/notifications/notification-query.service.js";
import {
  NotificationNotFoundError,
  NotificationStateService,
} from "../src/modules/notifications/notification.service.js";
import { notificationMuteRules } from "../src/modules/notifications/notification-muted-categories.js";
import {
  NotificationWriteValidationError,
  type NotificationWriteInput,
} from "../src/modules/notifications/notification.write-port.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import {
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
} from "./database.helpers.js";

let client: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let auditPort: PostgresAuditWritePort | undefined;
let writePort: PostgresNotificationWritePort | undefined;
let state: NotificationStateService | undefined;
let queryService: NotificationQueryService | undefined;
let ownerId: number | undefined;
let otherId: number | undefined;
let project: ProjectFixture | undefined;

const auditKey = Buffer.alloc(32, 0x6b);

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-notification-state-test",
  });
  uow = new PostgresUnitOfWork(client);
  auditPort = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => auditKey,
  });
  writePort = new PostgresNotificationWritePort();
  state = new NotificationStateService(client.sql);
  queryService = new NotificationQueryService(
    state,
    new TimeCursorService(
      VersionedHmacKeyring.fromEntries(
        [{ version: 1, key: Buffer.alloc(32, 0x4e) }],
        1,
      ),
      "NOTIFICATION",
    ),
  );
  ownerId = await createUser(client.sql);
  otherId = await createUser(client.sql);
  project = await createProject(client.sql, ownerId);
});

afterAll(async () => {
  await client?.close();
});

describe("PostgresNotificationWritePort / NotificationStateService (real PostgreSQL)", () => {
  test("同一来源事件按收件人与类型去重，不产生重复通知", async () => {
    const sequence = await appendNotification(ownerId!, {
      projectId: project!.projectId,
      notificationType: "PROJECT_JOINED",
      title: "加入项目",
      body: "你已加入项目",
      targetPath: `/projects/${project!.projectId}`,
      createdAt: new Date("2026-09-08T00:00:01.000Z"),
    });
    const first = await uow!.run((tx) =>
      writePort!.write(
        tx,
        notificationInput(sequence, ownerId!, {
          projectId: project!.projectId,
          notificationType: "PROJECT_JOINED",
          title: "加入项目",
          body: "你已加入项目",
          targetPath: `/projects/${project!.projectId}`,
          createdAt: new Date("2026-09-08T00:00:01.000Z"),
        }),
      ),
    );
    expect(first.inserted).toBe(false);

    const second = await uow!.run((tx) =>
      writePort!.write(
        tx,
        notificationInput(sequence, otherId!, {
          projectId: project!.projectId,
          notificationType: "PROJECT_JOINED",
          title: "加入项目",
          body: "你已加入项目",
          targetPath: `/projects/${project!.projectId}`,
          createdAt: new Date("2026-09-08T00:00:01.000Z"),
        }),
      ),
    );
    expect(second.inserted).toBe(true);

    const third = await uow!.run((tx) =>
      writePort!.write(
        tx,
        notificationInput(sequence, ownerId!, {
          projectId: project!.projectId,
          notificationType: "TASK_ASSIGNED",
          title: "任务指派",
          body: "你有一个新任务",
          targetPath: `/tasks/1`,
          createdAt: new Date("2026-09-08T00:00:01.000Z"),
        }),
      ),
    );
    expect(third.inserted).toBe(true);

    const [ownerCount] = await client!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM app.notifications
       WHERE recipient_id = ${ownerId!}
         AND source_chain_id = ${`PROJECT:${project!.projectId}`}
         AND source_sequence = ${sequence}
    `;
    expect(ownerCount?.count).toBe(2);
  });

  test("只返回当前用户自己的通知，未读优先并支持跨组游标分页", async () => {
    const readerId = await createUser(client!.sql);
    const created = [
      new Date("2026-09-08T00:00:06.000Z"),
      new Date("2026-09-08T00:00:05.000Z"),
      new Date("2026-09-08T00:00:04.000Z"),
    ];
    for (const [index, at] of created.entries()) {
      await appendNotification(readerId, {
        projectId: project!.projectId,
        notificationType: `EVENT_${index}`,
        title: `通知 ${index}`,
        body: `正文 ${index}`,
        targetPath: `/projects/${project!.projectId}/activity`,
        createdAt: at,
      });
    }
    await appendNotification(otherId!, {
      projectId: project!.projectId,
      notificationType: "OTHER_USER",
      title: "别人的通知",
      body: "不应出现在列表",
      targetPath: null,
      createdAt: new Date("2026-09-08T00:00:09.000Z"),
    });
    await markRead(readerId, created[1]!);

    const first = await queryService!.query({
      actorUserId: readerId,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.title).toBe("通知 0");
    expect(first.nextCursor).not.toBeNull();

    const second = await queryService!.query({
      actorUserId: readerId,
      limit: 1,
      after: first.nextCursor as string,
    });
    expect(second.items[0]?.title).toBe("通知 2");
    expect(second.items[0]?.readAt).toBeNull();
    expect(second.nextCursor).not.toBeNull();

    const third = await queryService!.query({
      actorUserId: readerId,
      limit: 1,
      after: second.nextCursor as string,
    });
    expect(third.items[0]?.title).toBe("通知 1");
    expect(third.items[0]?.readAt).not.toBeNull();
    expect(third.nextCursor).toBeNull();

    const unread = await queryService!.query({
      actorUserId: readerId,
      unreadOnly: true,
      limit: 50,
    });
    expect(unread.items.map((item) => item.title)).toEqual([
      "通知 0",
      "通知 2",
    ]);
    expect(await state!.countUnread(readerId)).toBe(2);
  });

  test("项目通知选项只过滤对应项目的站内通知与未读数", async () => {
    const otherProject = await createProject(client!.sql, ownerId!);
    const rules = notificationMuteRules(project!.projectId + ":task.assign");
    const beforeAll = await state!.countUnread(ownerId!);
    const beforeMuted = await state!.countUnread(ownerId!, rules);

    await appendNotification(ownerId!, {
      projectId: project!.projectId,
      notificationType: "task.assigned",
      title: "项目 A 任务派发",
      body: "应被项目通知选项隐藏",
      targetPath: "/projects/" + project!.projectId + "/tasks",
      createdAt: new Date("2026-09-08T00:01:01.000Z"),
    });
    await appendNotification(ownerId!, {
      projectId: project!.projectId,
      notificationType: "record.publish",
      title: "项目 A 记录发布",
      body: "未关闭的类别保留",
      targetPath: "/projects/" + project!.projectId + "/records",
      createdAt: new Date("2026-09-08T00:01:02.000Z"),
    });
    const otherAudit = await uow!.run((tx) =>
      auditPort!.append(tx, {
        ...auditInput("PROJECT_B_TASK_ASSIGNED"),
        projectId: otherProject.projectId,
        targetId: String(otherProject.projectId),
      }),
    );
    await uow!.run((tx) =>
      writePort!.write(tx, {
        recipientId: ownerId!,
        projectId: otherProject.projectId,
        sourceChainId: "PROJECT:" + otherProject.projectId,
        sourceSequence: otherAudit.sequenceNo,
        notificationType: "task.assigned",
        title: "项目 B 任务派发",
        body: "只关闭项目 A 的类别",
        targetPath: "/projects/" + otherProject.projectId + "/tasks",
        createdAt: new Date("2026-09-08T00:01:03.000Z"),
      }),
    );
    const systemAudit = await uow!.run((tx) =>
      auditPort!.append(tx, {
        ...auditInput("SYSTEM_TASK_ASSIGNED"),
        projectId: null,
        targetType: "SYSTEM",
        targetId: "0",
      }),
    );
    await uow!.run((tx) =>
      writePort!.write(tx, {
        recipientId: ownerId!,
        projectId: null,
        sourceChainId: "SYSTEM",
        sourceSequence: systemAudit.sequenceNo,
        notificationType: "task.assigned",
        title: "系统任务提醒",
        body: "",
        targetPath: null,
        createdAt: new Date("2026-09-08T00:01:04.000Z"),
      }),
    );

    const page = await state!.read({
      recipientId: ownerId!,
      unreadOnly: false,
      limit: 50,
      after: null,
      hiddenRules: rules,
    });
    const titles = page.items.map((item) => item.title);
    expect(titles).not.toContain("项目 A 任务派发");
    expect(titles).toContain("项目 A 记录发布");
    expect(titles).toContain("项目 B 任务派发");
    expect(titles).toContain("系统任务提醒");

    expect(await state!.countUnread(ownerId!)).toBe(beforeAll + 4);
    expect(await state!.countUnread(ownerId!, rules)).toBe(beforeMuted + 3);
  });

  test("个人通知抑制项只阻止新写入，不隐藏历史通知与未读数", async () => {
    const recipientId = await createUser(client!.sql);
    const otherProject = await createProject(client!.sql, recipientId);

    await appendNotification(recipientId, {
      projectId: project!.projectId,
      notificationType: "task.assigned",
      title: "个人策略-项目 A 任务",
      body: "历史通知保持原状",
      targetPath: "/projects/" + project!.projectId + "/tasks",
      createdAt: new Date("2026-09-08T00:02:01.000Z"),
    });
    const otherAudit = await uow!.run((tx) =>
      auditPort!.append(tx, {
        ...auditInput("PERSONAL_POLICY_PROJECT_B"),
        projectId: otherProject.projectId,
        targetId: String(otherProject.projectId),
      }),
    );
    await uow!.run((tx) =>
      writePort!.write(tx, {
        recipientId,
        projectId: otherProject.projectId,
        sourceChainId: "PROJECT:" + otherProject.projectId,
        sourceSequence: otherAudit.sequenceNo,
        notificationType: "task.assigned",
        title: "个人策略-项目 B 任务",
        body: "同类型跨项目历史也保留",
        targetPath: "/projects/" + otherProject.projectId + "/tasks",
        createdAt: new Date("2026-09-08T00:02:02.000Z"),
      }),
    );
    await appendNotification(recipientId, {
      projectId: project!.projectId,
      notificationType: "record.publish",
      title: "个人策略-记录发布",
      body: "其他类型不受影响",
      targetPath: "/projects/" + project!.projectId + "/records",
      createdAt: new Date("2026-09-08T00:02:03.000Z"),
    });
    expect(await state!.countUnread(recipientId)).toBe(3);

    await client!.sql`
      INSERT INTO app.user_notification_suppressions (
        user_id,
        notification_type,
        setting_key
      )
      VALUES (${recipientId}, ${"task.assigned"}, ${"task.assigned"})
      ON CONFLICT DO NOTHING
    `;

    const page = await state!.read({
      recipientId,
      unreadOnly: false,
      limit: 50,
      after: null,
      hiddenRules: [],
    });
    const titles = page.items.map((item) => item.title);
    expect(titles).toContain("个人策略-项目 A 任务");
    expect(titles).toContain("个人策略-项目 B 任务");
    expect(titles).toContain("个人策略-记录发布");
    expect(await state!.countUnread(recipientId)).toBe(3);

    await appendNotification(recipientId, {
      projectId: project!.projectId,
      notificationType: "task.assigned",
      title: "个人策略-关闭后新任务",
      body: "关闭后不再写入",
      targetPath: "/projects/" + project!.projectId + "/tasks",
      createdAt: new Date("2026-09-08T00:02:04.000Z"),
    });
    const afterWrite = await state!.read({
      recipientId,
      unreadOnly: false,
      limit: 50,
      after: null,
      hiddenRules: [],
    });
    const afterTitles = afterWrite.items.map((item) => item.title);
    expect(afterTitles).not.toContain("个人策略-关闭后新任务");
    expect(afterTitles).toHaveLength(3);
    expect(await state!.countUnread(recipientId)).toBe(3);

    await client!.sql`
      DELETE FROM app.user_notification_suppressions
       WHERE user_id = ${recipientId}
         AND notification_type = ${"task.assigned"}
    `;
  });

  test("签名游标绑定当前用户并支持无重叠分页", async () => {
    const first = await queryService!.query({
      actorUserId: ownerId!,
      limit: 1,
      unreadOnly: false,
    });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await queryService!.query({
      actorUserId: ownerId!,
      limit: 10,
      unreadOnly: false,
      after: first.nextCursor as string,
    });
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.some((item) => item.id === first.items[0]?.id)).toBe(
      false,
    );

    await expect(
      queryService!.query({
        actorUserId: otherId!,
        after: first.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      status: "invalid-cursor",
    } satisfies Partial<NotificationQueryValidationError>);
  });

  test("标记已读/未读和全部已读都只操作本人，越权返回 404", async () => {
    const id = await createNotificationId(ownerId!, "READ_STATE");
    await createNotificationId(otherId!, "READ_STATE_OTHER");

    await uow!.run((tx) =>
      state!.markRead(tx, {
        recipientId: ownerId!,
        notificationId: id,
      }),
    );
    expect(await readAt(id)).not.toBeNull();

    await expect(
      uow!.run((tx) =>
        state!.markRead(tx, {
          recipientId: otherId!,
          notificationId: id,
        }),
      ),
    ).rejects.toBeInstanceOf(NotificationNotFoundError);
    expect(await readAt(id)).not.toBeNull();

    await uow!.run((tx) =>
      state!.markUnread(tx, {
        recipientId: ownerId!,
        notificationId: id,
      }),
    );
    expect(await readAt(id)).toBeNull();

    await uow!.run((tx) => state!.readAll(tx, ownerId!));
    expect(await readAt(id)).not.toBeNull();
    const otherRows = (await client!.sql`
      SELECT read_at AS "readAt"
        FROM app.notifications
       WHERE recipient_id = ${otherId!}
    `) as unknown as readonly { readAt: Date | null }[];
    expect(otherRows.every((row) => row.readAt === null)).toBe(true);

    await expect(
      uow!.run((tx) => state!.assertOwned(tx, otherId!, id)),
    ).rejects.toBeInstanceOf(NotificationNotFoundError);
  });

  test("同一事务内通知因后续失败回滚", async () => {
    const before = await notificationCount();
    await expect(
      uow!.run(async (tx) => {
        const audit = await auditPort!.append(tx, auditInput("ROLLBACK_EVENT"));
        await writePort!.write(
          tx,
          notificationInput(audit.sequenceNo, ownerId!, {
            projectId: project!.projectId,
            notificationType: "ROLLBACK_EVENT",
            title: "回滚通知",
            body: "不应保留",
            targetPath: null,
            createdAt: new Date("2026-09-08T00:00:10.000Z"),
          }),
        );
        throw new Error("boom after notification write");
      }),
    ).rejects.toThrow("boom after notification write");
    expect(await notificationCount()).toBe(before);
  });

  test("写入端口拒绝不匹配项目链和非法目标路径", async () => {
    await expect(
      uow!.run((tx) =>
        writePort!.write(tx, {
          ...notificationInput(1, ownerId!, {
            projectId: project!.projectId,
            notificationType: "INVALID",
            title: "invalid",
            body: "",
            targetPath: "relative/path",
            createdAt: new Date(),
          }),
          sourceChainId: "SYSTEM",
        }),
      ),
    ).rejects.toBeInstanceOf(NotificationWriteValidationError);
  });
});

async function appendNotification(
  recipientId: number,
  input: Omit<
    NotificationWriteInput,
    "recipientId" | "sourceChainId" | "sourceSequence"
  >,
): Promise<number> {
  return uow!.run(async (tx) => {
    const audit = await auditPort!.append(
      tx,
      auditInput(input.notificationType),
    );
    await writePort!.write(
      tx,
      notificationInput(audit.sequenceNo, recipientId, input),
    );
    return audit.sequenceNo;
  });
}

function notificationInput(
  sequence: number,
  recipientId: number,
  input: Omit<
    NotificationWriteInput,
    "recipientId" | "sourceChainId" | "sourceSequence"
  >,
): NotificationWriteInput {
  return {
    recipientId,
    projectId: input.projectId,
    sourceChainId:
      input.projectId === null ? "SYSTEM" : `PROJECT:${input.projectId}`,
    sourceSequence: sequence,
    notificationType: input.notificationType,
    title: input.title,
    body: input.body,
    targetPath: input.targetPath,
    createdAt: input.createdAt,
  };
}

function auditInput(
  action: string,
): Parameters<PostgresAuditWritePort["append"]>[1] {
  return {
    projectId: project!.projectId,
    actorType: "USER",
    actorId: ownerId!,
    action,
    targetType: "PROJECT",
    targetId: String(project!.projectId),
    eventPayload: { action },
    requestId: randomUUID(),
    clientRequestId: null,
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    occurredAt: new Date("2026-09-08T00:00:00.500Z"),
  };
}

async function createNotificationId(
  recipientId: number,
  type: string,
): Promise<number> {
  const sequence = await appendNotification(recipientId, {
    projectId: project!.projectId,
    notificationType: type,
    title: `${type} 通知`,
    body: type,
    targetPath: null,
    createdAt: new Date("2026-09-08T00:00:20.000Z"),
  });
  const rows = (await client!.sql`
    SELECT id::bigint AS id
      FROM app.notifications
     WHERE recipient_id = ${recipientId}
       AND source_sequence = ${sequence}
       AND notification_type = ${type}
  `) as unknown as readonly { id: string }[];
  return Number(rows[0]!.id);
}

async function readAt(id: number): Promise<string | null> {
  const rows = (await client!.sql`
    SELECT to_char(read_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "readAt"
      FROM app.notifications
     WHERE id = ${id}
  `) as unknown as readonly { readAt: string | null }[];
  return rows[0]?.readAt ?? null;
}

async function markRead(recipientId: number, at: Date): Promise<void> {
  const rows = (await client!.sql`
    SELECT id::bigint AS id
      FROM app.notifications
     WHERE recipient_id = ${recipientId}
       AND created_at = ${at.toISOString()}
       AND notification_type LIKE 'EVENT_%'
  `) as unknown as readonly { id: string }[];
  if (rows[0] === undefined) {
    throw new Error("notification fixture not found");
  }
  const id = Number(rows[0].id);
  await uow!.run((tx) =>
    state!.markRead(tx, {
      recipientId,
      notificationId: id,
    }),
  );
}

async function notificationCount(): Promise<number> {
  const rows = (await client!.sql`
    SELECT count(*)::int AS count
      FROM app.notifications
  `) as unknown as readonly { count: number }[];
  return rows[0]?.count ?? 0;
}

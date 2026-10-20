import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "@inpulse/database/client";
import { createDatabaseClient } from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { NotificationPreferencesService } from "../src/modules/notifications/notification-preferences.service.js";
import { NotificationStateService } from "../src/modules/notifications/notification.service.js";
import type { NotificationWriteInput } from "../src/modules/notifications/notification.write-port.js";
import { PostgresNotificationWritePort } from "../src/modules/notifications/postgres-notification-write-port.js";
import { createProject, createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient | undefined;
let uow: PostgresUnitOfWork | undefined;
let audit: PostgresAuditWritePort | undefined;
let writePort: PostgresNotificationWritePort | undefined;
let preferences: NotificationPreferencesService | undefined;
let state: NotificationStateService | undefined;
let actorId: number | undefined;
let projectId: number | undefined;

const auditKey = Buffer.alloc(32, 0x7a);

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-notification-preferences-test",
  });
  uow = new PostgresUnitOfWork(client);
  audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => auditKey,
  });
  writePort = new PostgresNotificationWritePort();
  preferences = new NotificationPreferencesService(client.sql);
  state = new NotificationStateService(client.sql);
  actorId = await createUser(client.sql);
  projectId = (await createProject(client.sql, actorId)).projectId;
});

afterAll(async () => {
  await client?.close();
});

async function writeNotification(
  recipientId: number,
  notificationType: string,
  createdAt: Date,
): Promise<boolean> {
  return uow!.run(async (tx) => {
    const event = await audit!.append(tx, {
      projectId: projectId!,
      actorType: "USER",
      actorId: actorId!,
      action: notificationType,
      targetType: "PROJECT",
      targetId: String(projectId!),
      eventPayload: { notificationType },
      requestId: randomUUID(),
      clientRequestId: null,
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      occurredAt: createdAt,
    });
    const input: NotificationWriteInput = {
      recipientId,
      projectId: projectId!,
      sourceChainId: `PROJECT:${projectId!}`,
      sourceSequence: event.sequenceNo,
      notificationType,
      title: `${notificationType} 通知`,
      body: notificationType,
      targetPath: null,
      createdAt,
    };
    const result = await writePort!.write(tx, input);
    return result.inserted;
  });
}

async function listTypes(userId: number): Promise<readonly string[]> {
  const page = await state!.read({
    recipientId: userId,
    unreadOnly: false,
    limit: 100,
    after: null,
  });
  return page.items.map((item) => item.notificationType);
}

describe("个人通知偏好（真实 PostgreSQL）", () => {
  test("关闭类型只停止后续新写入，历史通知保持原状且重新开启不补发", async () => {
    const userId = await createUser(client!.sql);
    expect(
      await writeNotification(
        userId,
        "task.complete",
        new Date("2026-10-20T05:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      await writeNotification(
        userId,
        "task.assigned",
        new Date("2026-10-20T05:00:01.000Z"),
      ),
    ).toBe(true);
    expect(await listTypes(userId)).toEqual(["task.assigned", "task.complete"]);
    expect(await state!.countUnread(userId)).toBe(2);

    await uow!.run((tx) => preferences!.replace(tx, userId, ["task.complete"]));
    expect(await preferences!.read(userId)).toEqual({
      disabledSettings: ["task.complete"],
    });
    expect(await listTypes(userId)).toEqual(["task.assigned", "task.complete"]);
    expect(await state!.countUnread(userId)).toBe(2);

    expect(
      await writeNotification(
        userId,
        "task.complete",
        new Date("2026-10-20T05:00:02.000Z"),
      ),
    ).toBe(false);
    const [stored] = (await client!.sql`
      SELECT count(*)::INTEGER AS count
        FROM app.notifications
       WHERE recipient_id = ${userId}
         AND notification_type = 'task.complete'
    `) as unknown as readonly { count: number }[];
    expect(stored?.count).toBe(1);

    await uow!.run((tx) => preferences!.replace(tx, userId, []));
    expect(await preferences!.read(userId)).toEqual({ disabledSettings: [] });
    expect(await listTypes(userId)).toEqual(["task.assigned", "task.complete"]);
    expect(await state!.countUnread(userId)).toBe(2);
    expect(
      (await listTypes(userId)).filter((type) => type === "task.complete"),
    ).toHaveLength(1);
  });

  test("关闭开关同时抑制新旧完成事件类型写入", async () => {
    const userId = await createUser(client!.sql);
    await uow!.run((tx) => preferences!.replace(tx, userId, ["task.complete"]));
    expect(
      await writeNotification(
        userId,
        "TASK_COMPLETED",
        new Date("2026-10-20T05:01:00.000Z"),
      ),
    ).toBe(false);
    expect(
      await writeNotification(
        userId,
        "task.complete",
        new Date("2026-10-20T05:01:01.000Z"),
      ),
    ).toBe(false);
    expect(await listTypes(userId)).toEqual([]);
  });

  test("偏好按用户隔离，其他用户仍能收到同类型通知", async () => {
    const mutedUser = await createUser(client!.sql);
    const otherUser = await createUser(client!.sql);
    await uow!.run((tx) =>
      preferences!.replace(tx, mutedUser, ["task.complete"]),
    );
    expect(
      await writeNotification(
        mutedUser,
        "task.complete",
        new Date("2026-10-20T05:02:00.000Z"),
      ),
    ).toBe(false);
    expect(
      await writeNotification(
        otherUser,
        "task.complete",
        new Date("2026-10-20T05:02:01.000Z"),
      ),
    ).toBe(true);
    expect(await listTypes(otherUser)).toEqual(["task.complete"]);
  });
});

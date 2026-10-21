import { describe, expect, test, vi } from "vitest";

import type { PersonalNotificationSetting } from "@inpulse/api-contract";

import type { TransactionContext } from "../src/database/transaction-context.js";
import type { NotificationWritePort } from "../src/modules/notifications/index.js";
import {
  normalizeRecipientIds,
  ProjectNotificationDispatcher,
  type ProjectNotificationEvent,
} from "../src/modules/projects/project-notification.dispatcher.js";
import type { ProjectAccessQueryPort } from "../src/modules/projects/project-access.port.js";

const tx = { db: {} as never, sql: {} as never } satisfies TransactionContext;

const event: ProjectNotificationEvent = {
  projectId: 11,
  sourceChainId: "PROJECT:11",
  sourceSequence: 37,
  notificationType: "task.complete" satisfies PersonalNotificationSetting,
  title: "任务完成",
  body: "P11-T-03",
  targetPath: "/projects/11/modules/3/tasks?taskId=9",
  createdAt: new Date("2026-10-21T03:00:00.000Z"),
};

function setup(
  allowedIds: readonly number[],
  insertedByRecipient: Readonly<Record<number, boolean>> = {},
) {
  const access = {
    checkProjectForWrite: vi.fn(
      async (
        _tx: TransactionContext,
        input: { readonly actorUserId: number },
      ) =>
        allowedIds.includes(input.actorUserId)
          ? {
              kind: "allowed" as const,
              resource: {
                projectId: event.projectId,
                status: "ACTIVE" as const,
                rowVersion: 1,
                isSystemAdmin: false,
              },
            }
          : { kind: "not-found" as const },
    ),
  } as unknown as ProjectAccessQueryPort;
  const notifications = {
    write: vi.fn(
      async (
        _tx: TransactionContext,
        input: { readonly recipientId: number },
      ) => ({
        inserted: insertedByRecipient[input.recipientId] ?? true,
      }),
    ),
  } as unknown as NotificationWritePort;
  return {
    access,
    notifications,
    dispatcher: new ProjectNotificationDispatcher(access, notifications),
  };
}

describe("ProjectNotificationDispatcher", () => {
  test("normalizeRecipientIds 去重、丢弃非法 ID 并按升序返回", () => {
    expect(normalizeRecipientIds([5, 2, 5, 0, -1, 1.5, Number.NaN, 3])).toEqual(
      [2, 3, 5],
    );
  });

  test("只向当前项目有权限的收件人写入，并返回真实插入数", async () => {
    const { access, notifications, dispatcher } = setup([5, 2], { 5: false });

    await expect(
      dispatcher.dispatch(tx, event, [5, 2, 5, 0, Number.NaN, 3]),
    ).resolves.toBe(1);

    expect(
      vi.mocked(access.checkProjectForWrite).mock.calls.map((call) => call[1]),
    ).toEqual([
      { actorUserId: 2, projectId: 11 },
      { actorUserId: 3, projectId: 11 },
      { actorUserId: 5, projectId: 11 },
    ]);
    expect(
      vi.mocked(notifications.write).mock.calls.map((call) => call[1]),
    ).toEqual([
      { ...event, recipientId: 2 },
      { ...event, recipientId: 5 },
    ]);
  });

  test("全部收件人无权访问时不写通知", async () => {
    const { access, notifications, dispatcher } = setup([]);

    await expect(dispatcher.dispatch(tx, event, [8, 9])).resolves.toBe(0);
    expect(access.checkProjectForWrite).toHaveBeenCalledTimes(2);
    expect(notifications.write).not.toHaveBeenCalled();
  });
});

export const projectNotificationCategories = [
  "task.assign",
  "task.status",
  "record",
  "project.member",
  "scope.delete",
] as const;

export type ProjectNotificationCategory =
  (typeof projectNotificationCategories)[number];

export function isProjectNotificationCategory(
  value: string,
): value is ProjectNotificationCategory {
  return (projectNotificationCategories as readonly string[]).includes(value);
}

/**
 * 项目通知类别 -> 站内通知类型。项目群通知选项同时用于过滤站内通知列表；
 * UPPER_SNAKE 条目只为兼容早期演示数据，新事件统一使用 dot.case。
 */
export const notificationTypesByProjectCategory: Readonly<
  Record<ProjectNotificationCategory, readonly string[]>
> = {
  "task.assign": ["task.assigned", "TASK_ASSIGNED"],
  "task.status": [
    "task.complete",
    "TASK_COMPLETED",
    "task.reopen",
    "task.merge",
    "task.unmerge",
  ],
  record: [
    "record.publish",
    "record.version.create",
    "record.leftover.add",
    "leftover.convert",
    "CHANGE_RECORD_VOIDED",
    "CHANGE_RECORD_RESTORED",
  ],
  "project.member": [
    "PROJECT_CREATED",
    "PROJECT_JOINED",
    "project.status.change",
    "project.wrapped",
  ],
  "scope.delete": [],
};

/**
 * 与 packages/api-contract/src/personal-notification-settings.ts 保持同一组
 * 取值；前端不能直接依赖 workspace 契约包，这里作为本地视图的常量来源。
 * 服务端保存的 disabledSettings 只接受这些键。
 */
export const personalNotificationSettings = [
  "PROJECT_JOINED",
  "task.assigned",
  "task.complete",
  "task.reopen",
  "task.merge",
  "task.unmerge",
  "record.publish",
  "record.version.create",
  "record.leftover.add",
  "leftover.convert",
  "project.status.change",
] as const;

export type PersonalNotificationSetting =
  (typeof personalNotificationSettings)[number];

export function isPersonalNotificationSetting(
  value: string,
): value is PersonalNotificationSetting {
  return (personalNotificationSettings as readonly string[]).includes(value);
}

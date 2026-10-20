/**
 * 个人通知策略（服务端唯一口径）：设置页开关 -> 实际站内通知类型。
 *
 * 通知写入端口在落库前按这张表判断收件人是否关闭了对应类型；通知列表与未读数
 * 也按同一口径过滤。UPPER_SNAKE 条目只为兼容早期演示数据，新事件统一使用 dot.case。
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

export const notificationTypesByPersonalSetting: Readonly<
  Record<PersonalNotificationSetting, readonly string[]>
> = {
  PROJECT_JOINED: ["PROJECT_JOINED"],
  "task.assigned": ["task.assigned", "TASK_ASSIGNED"],
  "task.complete": ["task.complete", "TASK_COMPLETED"],
  "task.reopen": ["task.reopen"],
  "task.merge": ["task.merge"],
  "task.unmerge": ["task.unmerge"],
  "record.publish": ["record.publish"],
  "record.version.create": ["record.version.create"],
  "record.leftover.add": ["record.leftover.add"],
  "leftover.convert": ["leftover.convert"],
  "project.status.change": ["project.status.change", "project.wrapped"],
};

export function isPersonalNotificationSetting(
  value: string,
): value is PersonalNotificationSetting {
  return (personalNotificationSettings as readonly string[]).includes(value);
}

export interface ExpandedPersonalNotificationSetting {
  readonly settingKey: PersonalNotificationSetting;
  readonly notificationType: string;
}

/**
 * 把一个或多个个人设置展开为实际通知类型，去重后按设置键、类型稳定排序。
 * 服务端保存抑制项时使用，写入端口据此判断收件人是否关闭该类型。
 */
export function expandPersonalNotificationSettings(
  settings: readonly PersonalNotificationSetting[],
): readonly ExpandedPersonalNotificationSetting[] {
  const expanded = new Map<string, ExpandedPersonalNotificationSetting>();
  for (const settingKey of [...new Set(settings)].sort()) {
    for (const notificationType of notificationTypesByPersonalSetting[
      settingKey
    ]) {
      expanded.set(notificationType, { settingKey, notificationType });
    }
  }
  return [...expanded.values()].sort((left, right) =>
    left.notificationType.localeCompare(right.notificationType),
  );
}

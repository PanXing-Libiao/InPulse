import {
  parseTaskDetailPath,
  type TaskLocation,
} from "@features/tasks/task-links";

/**
 * 顶部铃铛把任务通知交给通知页打开弹窗时携带的路由状态。
 * 任务通知不再直接跳进项目，而是先落到通知汇总页，关闭弹窗后仍停留在汇总页。
 */
export interface NotificationTaskOpenState {
  readonly notificationTaskPath: string;
}

export function createNotificationTaskOpenState(
  targetPath: string,
): NotificationTaskOpenState | null {
  return parseTaskDetailPath(targetPath) === null
    ? null
    : { notificationTaskPath: targetPath };
}

export function readNotificationTaskOpenState(
  state: unknown,
): TaskLocation | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const targetPath = (state as { notificationTaskPath?: unknown })
    .notificationTaskPath;
  return typeof targetPath === "string"
    ? parseTaskDetailPath(targetPath)
    : null;
}

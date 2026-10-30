/**
 * 任务详情深链（跨页面共用）：统一落到模块任务页，由 ?taskId= 打开任务详情。
 * 旧版功能级深链仍由路由兼容层转到同一模块任务页，查询参数原样保留。
 */
export interface TaskLocation {
  readonly projectId: number;
  readonly moduleId: number;
  readonly taskId: number;
}

export function taskDetailPath(task: TaskLocation): string {
  return (
    "/projects/" +
    String(task.projectId) +
    "/modules/" +
    String(task.moduleId) +
    "/tasks?taskId=" +
    String(task.taskId)
  );
}

const MODULE_TASK_PATH = /^\/projects\/(\d+)\/modules\/(\d+)\/tasks\/?$/;
const LEGACY_FEATURE_TASK_PATH =
  /^\/projects\/(\d+)\/modules\/(\d+)\/features(?:\/\d+)?\/?$/;
const INTERNAL_ORIGIN = "http://inpulse.local";

function readEntityId(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 2147483647
    ? value
    : null;
}

/**
 * 从通知 targetPath 反解任务详情位置。新深链指向模块任务页；历史功能级任务
 * 通知仍可解析为同一 moduleId，并在路由层安全回落到模块任务页。
 */
export function parseTaskDetailPath(targetPath: string): TaskLocation | null {
  let url: URL;
  try {
    url = new URL(targetPath, INTERNAL_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_ORIGIN) {
    return null;
  }
  const taskId = readEntityId(url.searchParams.get("taskId"));
  if (taskId === null) {
    return null;
  }
  const match =
    MODULE_TASK_PATH.exec(url.pathname) ??
    LEGACY_FEATURE_TASK_PATH.exec(url.pathname);
  if (!match) {
    return null;
  }
  const projectId = readEntityId(match[1]);
  const moduleId = readEntityId(match[2]);
  return projectId === null || moduleId === null
    ? null
    : { projectId, moduleId, taskId };
}

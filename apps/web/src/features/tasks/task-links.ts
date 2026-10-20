/**
 * 任务详情深链（跨页面共用）：模块级任务回到模块任务页，功能级任务回到功能页，
 * 两者都由 ?taskId= 打开任务抽屉（TasksPanel 从 URL 读取）。
 */
export interface TaskLocation {
  readonly projectId: number;
  readonly moduleId: number;
  readonly featureId: number | null;
  readonly taskId: number;
}

export function taskDetailPath(task: TaskLocation): string {
  const scope =
    task.featureId === null ? "/tasks" : "/features/" + String(task.featureId);
  return (
    "/projects/" +
    String(task.projectId) +
    "/modules/" +
    String(task.moduleId) +
    scope +
    "?taskId=" +
    String(task.taskId)
  );
}

const MODULE_TASK_PATH = /^\/projects\/(\d+)\/modules\/(\d+)\/tasks\/?$/;
const FEATURE_TASK_PATH =
  /^\/projects\/(\d+)\/modules\/(\d+)\/features\/(\d+)\/?$/;
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
 * 从通知 targetPath 反解任务详情位置。通知只携带地址字符串，不携带结构化范围，
 * 点击时按与 taskDetailPath 相同的深链格式还原 project/module/feature/task；
 * 项目动态、记录等非任务深链返回 null，调用方继续按原地址跳转。
 */
export function parseTaskDetailPath(targetPath: string): TaskLocation | null {
  let url: URL;
  try {
    url = new URL(targetPath, INTERNAL_ORIGIN);
  } catch {
    return null;
  }
  // 只接受站内相对深链，避免把外部地址误当成任务详情。
  if (url.origin !== INTERNAL_ORIGIN) {
    return null;
  }
  const taskId = readEntityId(url.searchParams.get("taskId"));
  if (taskId === null) {
    return null;
  }
  const featureMatch = FEATURE_TASK_PATH.exec(url.pathname);
  if (featureMatch) {
    const projectId = readEntityId(featureMatch[1]);
    const moduleId = readEntityId(featureMatch[2]);
    const featureId = readEntityId(featureMatch[3]);
    return projectId === null || moduleId === null || featureId === null
      ? null
      : { projectId, moduleId, featureId, taskId };
  }
  const moduleMatch = MODULE_TASK_PATH.exec(url.pathname);
  if (moduleMatch) {
    const projectId = readEntityId(moduleMatch[1]);
    const moduleId = readEntityId(moduleMatch[2]);
    return projectId === null || moduleId === null
      ? null
      : { projectId, moduleId, featureId: null, taskId };
  }
  return null;
}

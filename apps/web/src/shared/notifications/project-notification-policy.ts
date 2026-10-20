/**
 * 与 packages/api-contract/src/project-notification-categories.ts 保持同一组
 * 取值；前端不能直接依赖 workspace 契约包，这里作为本地视图的常量来源。
 */
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
 * 项目通知选项的本地保存（2026-10-20 用户「每次更改要即刻保存」）：
 * 只记录被关闭的类别，默认全部开启；按项目分别保存，关闭弹窗、刷新页面或
 * 重启浏览器后仍然生效，并同步用于筛掉当前浏览器的站内通知和未读数。
 *
 * 服务端项目群开关由 ADR-090 持久化并由桥接过滤；这里只保留同一弹窗保存成功后
 * 同步写入的当前浏览器站内筛选，不参与群消息投递。存储不可用（隐私模式等）时
 * 静默降级为本次会话内的内存状态。
 */
export const PROJECT_NOTIFICATION_POLICY_STORAGE_KEY =
  "inpulse.project-notification-policy.disabled";

/** 同页写入后立即通知站内通知视图刷新；跨标签页由浏览器 storage 事件兜底。 */
export const PROJECT_NOTIFICATION_POLICY_CHANGED_EVENT =
  "inpulse:project-notification-policy-changed";

type DisabledByProject = Readonly<
  Record<string, readonly ProjectNotificationCategory[]>
>;

function resolveStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseDisabledByProject(raw: string | null): DisabledByProject {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const result: Record<string, readonly ProjectNotificationCategory[]> = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      if (!/^[1-9][0-9]*$/.test(projectId) || !Array.isArray(value)) continue;
      const categories = value.filter(
        (category): category is ProjectNotificationCategory =>
          typeof category === "string" &&
          isProjectNotificationCategory(category),
      );
      if (categories.length > 0) {
        result[projectId] = Array.from(new Set(categories));
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** 读取当前项目被关闭的通知类别；无记录、存储损坏或不可用时返回空集合（全开）。 */
export function readDisabledProjectNotificationTypes(
  projectId: number | null | undefined,
): ReadonlySet<ProjectNotificationCategory> {
  if (projectId === null || projectId === undefined || projectId <= 0) {
    return new Set();
  }
  const storage = resolveStorage();
  if (storage === null) return new Set();
  try {
    const all = parseDisabledByProject(
      storage.getItem(PROJECT_NOTIFICATION_POLICY_STORAGE_KEY),
    );
    return new Set(all[String(projectId)] ?? []);
  } catch {
    return new Set();
  }
}

/** 覆盖保存当前项目的关闭项；projectId 为空或存储不可用时静默跳过。 */
export function writeDisabledProjectNotificationTypes(
  projectId: number | null | undefined,
  disabled: ReadonlySet<ProjectNotificationCategory>,
): void {
  if (projectId === null || projectId === undefined || projectId <= 0) return;
  const storage = resolveStorage();
  if (storage === null) return;
  try {
    const all = parseDisabledByProject(
      storage.getItem(PROJECT_NOTIFICATION_POLICY_STORAGE_KEY),
    );
    const next: Record<string, readonly ProjectNotificationCategory[]> = {
      ...all,
    };
    const key = String(projectId);
    const categories = Array.from(disabled).filter(
      isProjectNotificationCategory,
    );
    if (categories.length === 0) {
      delete next[key];
    } else {
      next[key] = categories;
    }
    storage.setItem(
      PROJECT_NOTIFICATION_POLICY_STORAGE_KEY,
      JSON.stringify(next),
    );
    notifyProjectNotificationPolicyChanged();
  } catch {
    // 写入失败不影响本次会话内的开关状态。
  }
}

/**
 * 生成站内通知只读筛选参数：逗号分隔的 projectId:category 对。
 * 无关闭项、存储不可用或数据损坏时返回 undefined（不筛选）。
 */
export function readMutedProjectCategoriesQuery(): string | undefined {
  const storage = resolveStorage();
  if (storage === null) return undefined;
  try {
    const all = parseDisabledByProject(
      storage.getItem(PROJECT_NOTIFICATION_POLICY_STORAGE_KEY),
    );
    const pairs = Object.entries(all)
      .sort(([left], [right]) => Number(left) - Number(right))
      .flatMap(([projectId, categories]) =>
        categories.map((category) => projectId + ":" + category),
      );
    return pairs.length === 0 ? undefined : pairs.join(",");
  } catch {
    return undefined;
  }
}

/**
 * 订阅项目通知选项变化：同一页面写入后立即触发，其它标签页通过 storage
 * 事件同步。返回取消订阅函数。
 */
export function subscribeProjectNotificationPolicy(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent): void => {
    if (
      event.key === null ||
      event.key === PROJECT_NOTIFICATION_POLICY_STORAGE_KEY
    ) {
      listener();
    }
  };
  window.addEventListener(PROJECT_NOTIFICATION_POLICY_CHANGED_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(
      PROJECT_NOTIFICATION_POLICY_CHANGED_EVENT,
      listener,
    );
    window.removeEventListener("storage", handleStorage);
  };
}

function notifyProjectNotificationPolicyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROJECT_NOTIFICATION_POLICY_CHANGED_EVENT));
}

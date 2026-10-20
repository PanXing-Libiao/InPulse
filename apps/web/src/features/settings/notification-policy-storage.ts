import { notificationScenarios } from "./settings-content";

/**
 * 个人通知策略的本地保存（2026-10-20 用户「每次更改要即刻保存」）：
 * 只记录被关闭的通知类型，默认全部开启；按账号分别保存，刷新、切换页面、
 * 重启浏览器后仍然生效。
 *
 * 当前仓库没有个人通知偏好接口，通知投递也尚未按此开关过滤，因此这里不入库、
 * 不进契约、不写审计——与项目星标、企微提醒忽略一致，属于浏览器本地偏好。
 * 存储不可用（隐私模式等）时静默降级为本次会话内的内存状态。
 */
export const NOTIFICATION_POLICY_STORAGE_KEY =
  "inpulse.notification-policy.disabled";

type DisabledByUser = Readonly<Record<string, readonly string[]>>;

const knownTypeKeys = new Set(notificationScenarios.map((row) => row.key));

function resolveStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function parseDisabledByUser(raw: string | null): DisabledByUser {
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
    const result: Record<string, readonly string[]> = {};
    for (const [userId, value] of Object.entries(parsed)) {
      if (!/^[1-9][0-9]*$/.test(userId) || !Array.isArray(value)) continue;
      const keys = value.filter(
        (key): key is string =>
          typeof key === "string" && knownTypeKeys.has(key),
      );
      if (keys.length > 0) result[userId] = Array.from(new Set(keys));
    }
    return result;
  } catch {
    return {};
  }
}

/** 读取当前账号被关闭的通知类型；无记录、存储损坏或不可用时返回空集合（全开）。 */
export function readDisabledNotificationTypes(
  userId: number | null | undefined,
): ReadonlySet<string> {
  if (userId === null || userId === undefined || userId <= 0) {
    return new Set();
  }
  const storage = resolveStorage();
  if (storage === null) return new Set();
  try {
    const all = parseDisabledByUser(
      storage.getItem(NOTIFICATION_POLICY_STORAGE_KEY),
    );
    return new Set(all[String(userId)] ?? []);
  } catch {
    return new Set();
  }
}

/** 覆盖保存当前账号的关闭项；userId 为空或存储不可用时静默跳过。 */
export function writeDisabledNotificationTypes(
  userId: number | null | undefined,
  disabled: ReadonlySet<string>,
): void {
  if (userId === null || userId === undefined || userId <= 0) return;
  const storage = resolveStorage();
  if (storage === null) return;
  try {
    const all = parseDisabledByUser(
      storage.getItem(NOTIFICATION_POLICY_STORAGE_KEY),
    );
    const next: Record<string, readonly string[]> = { ...all };
    const key = String(userId);
    const keys = Array.from(disabled).filter((item) => knownTypeKeys.has(item));
    if (keys.length === 0) {
      delete next[key];
    } else {
      next[key] = keys;
    }
    storage.setItem(NOTIFICATION_POLICY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写入失败不影响本次会话内的开关状态。
  }
}

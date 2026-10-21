import React from "react";
import { useAuth } from "@features/auth/auth-context";

/**
 * 项目星标（「我的关注」）：**每个账号各自一份**，按登录用户 id 分开存浏览器本地，
 * 不入库、不进契约。同一台浏览器上换账号登录互不影响；跨设备同步需要后端存
 * 「谁关注了哪个项目」，属于后续独立改动。
 */
const STARRED_PROJECTS_STORAGE_KEY_PREFIX = "inpulse.projects.starred";

/** 首版（2026-10-15）把星标存在不带用户 id 的全局 key 上，已被「按账号分仓」取代。 */
const LEGACY_STARRED_PROJECTS_STORAGE_KEY = STARRED_PROJECTS_STORAGE_KEY_PREFIX;

/** 同页多个星标 Hook 的刷新信号；跨标签页仍由原生 `storage` 事件补齐。 */
const STARRED_PROJECTS_CHANGED_EVENT = "inpulse:starred-projects-changed";

interface StarredProjectsChangedDetail {
  readonly userId: number;
  readonly projectIds: readonly number[];
}

function starredProjectsStorageKey(userId: number): string {
  return `${STARRED_PROJECTS_STORAGE_KEY_PREFIX}.${String(userId)}`;
}

/** 解析存储内容：不是数组或含非法项时按「没有那一项」处理，不抛错。 */
function parseStarredProjectIds(raw: string): readonly number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is number =>
        typeof value === "number" && Number.isInteger(value) && value > 0,
    );
  } catch {
    return [];
  }
}

/**
 * 读取该账号已星标项目 ID：内容损坏或存储不可用时按「没有星标」处理，不影响列表渲染。
 *
 * 首版遗留的全局 key 只在没有本账号记录时接管一次——星标刚上线一天，不能让已经点亮的星
 * 因为改按账号分仓而凭空消失；接管后立刻删除，否则下一个在这台浏览器登录的账号会继承
 * 上一个人的星标，正是本次要修掉的行为。
 */
export function readStarredProjectIds(userId: number): readonly number[] {
  try {
    const stored = globalThis.localStorage.getItem(
      starredProjectsStorageKey(userId),
    );
    if (stored !== null) return parseStarredProjectIds(stored);
    const legacy = globalThis.localStorage.getItem(
      LEGACY_STARRED_PROJECTS_STORAGE_KEY,
    );
    if (legacy === null) return [];
    globalThis.localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    const migrated = parseStarredProjectIds(legacy);
    writeStarredProjectIds(userId, migrated);
    return migrated;
  } catch {
    return [];
  }
}

function writeStarredProjectIds(userId: number, ids: readonly number[]): void {
  try {
    globalThis.localStorage.setItem(
      starredProjectsStorageKey(userId),
      JSON.stringify(ids),
    );
  } catch {
    // 写入失败（隐私模式等）：本次会话内仍然生效，只是刷新后不再保留。
  }
}

function notifyStarredProjectsChanged(
  userId: number,
  projectIds: readonly number[],
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<StarredProjectsChangedDetail>(
      STARRED_PROJECTS_CHANGED_EVENT,
      { detail: { userId, projectIds } },
    ),
  );
}

/** 取反：已星标就移除，未星标就追加；不改变其它 ID 的相对顺序。 */
export function toggleStarredProjectId(
  ids: readonly number[],
  projectId: number,
): readonly number[] {
  return ids.includes(projectId)
    ? ids.filter((id) => id !== projectId)
    : [...ids, projectId];
}

/**
 * 星标项目置顶，星标组与未标组内都保持传入顺序（2026-10-21 用户指示）。
 * 项目列表和侧栏项目树必须共用这一条展示规则，避免两处顺序分叉；
 * 这里只调整展示顺序，不改变分档、搜索过滤或数据。
 */
export function orderProjectsStarredFirst<T extends { readonly id: number }>(
  projects: readonly T[],
  isStarred: (projectId: number) => boolean,
): T[] {
  return [...projects].sort(
    (left, right) => Number(isStarred(right.id)) - Number(isStarred(left.id)),
  );
}

export interface ProjectStars {
  readonly isStarred: (projectId: number) => boolean;
  readonly toggleStar: (projectId: number) => void;
}

/**
 * 星标状态：点击即生效（不等服务端，也没有确认弹窗），并立即写回**当前登录账号**自己那份
 * 本地存储。拿不到用户 id（未登录 / 身份未就绪）时不读也不写——星标是账号级偏好，
 * 没有归属就不该落到这台浏览器上。
 */
export function useProjectStars(): ProjectStars {
  const { user } = useAuth();
  const userId = user?.id;
  const [starredIds, setStarredIds] = React.useState<readonly number[]>(() =>
    userId === undefined ? [] : readStarredProjectIds(userId),
  );

  // 身份变化（登录完成 / 换账号）时改读新账号自己那一份，不复用上一份。
  React.useEffect(() => {
    const sync = () => {
      setStarredIds(userId === undefined ? [] : readStarredProjectIds(userId));
    };
    sync();
    if (userId === undefined) return undefined;
    const storageKey = starredProjectsStorageKey(userId);
    const handleStarsChanged = (event: Event) => {
      const detail = (event as CustomEvent<StarredProjectsChangedDetail>)
        .detail;
      if (detail?.userId === userId) {
        setStarredIds(detail.projectIds);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === storageKey ||
        event.key === LEGACY_STARRED_PROJECTS_STORAGE_KEY
      ) {
        sync();
      }
    };
    window.addEventListener(STARRED_PROJECTS_CHANGED_EVENT, handleStarsChanged);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        STARRED_PROJECTS_CHANGED_EVENT,
        handleStarsChanged,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [userId]);

  const toggleStar = React.useCallback(
    (projectId: number) => {
      if (userId === undefined) return;
      const next = toggleStarredProjectId(starredIds, projectId);
      writeStarredProjectIds(userId, next);
      setStarredIds(next);
      notifyStarredProjectsChanged(userId, next);
    },
    [starredIds, userId],
  );

  const isStarred = React.useCallback(
    (projectId: number) => starredIds.includes(projectId),
    [starredIds],
  );

  return { isStarred, toggleStar };
}

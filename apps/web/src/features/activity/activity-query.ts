import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type ActivityDayTotal,
  type ActivityItem,
  type InpulseApiClient,
} from "@generated/api";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export const ACTIVITY_PAGE_LIMIT = 20;

/** 与契约 ACTIVITY_CATEGORIES 一致；「全部」即不传 category。 */
export type ActivityCategory =
  | "all"
  | "task"
  | "record"
  | "feature"
  | "module"
  | "project"
  | "member"
  | "github";

export interface ActivityFeedPage {
  readonly items: readonly ActivityItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** 按日总数：服务端按当前过滤条件下的全量统计，不随翻页增长。 */
  readonly dayTotals: readonly ActivityDayTotal[];
  readonly dayTotalsTruncated: boolean;
}

export interface ActivityFeedOptions {
  /** 锁定单项目（项目详情页）：走项目级路由，保留 404 语义。 */
  readonly lockedProjectId?: number | undefined;
  /** 聚合视图显式收窄到这些项目；缺省表示服务端实时 `AuthorizedProjectScope`。 */
  readonly projectIds?: readonly number[] | undefined;
  /** 缓存隔离键（项目选择）。 */
  readonly scopeKey: string;
  readonly category?: ActivityCategory | undefined;
  readonly client?: InpulseApiClient | undefined;
  readonly includeAdminOnly?: boolean;
  readonly limit?: number;
  readonly enabled?: boolean;
}

export function describeActivityError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return SESSION_EXPIRED_MESSAGE;
    }
    if (error.status === 404) {
      return "项目不存在或你无权访问该项目的动态。";
    }
    if (error.status === 422) {
      return "项目动态参数无效或游标已过期，请刷新后重试。";
    }
  }
  return "项目动态服务暂时不可用，请稍后重试。";
}

/**
 * 服务端一次查询就按 `occurred_at DESC, id DESC` 返回全局倒序的单一流，
 * 翻页游标指向最后一条，因此加载更多只会把更早的条目接在尾部，
 * 不会再往已显示的日期中间插入新条目。
 */
export function flattenActivityPages(
  pages: readonly ActivityFeedPage[],
): readonly ActivityItem[] {
  return pages.flatMap((page) => [...page.items]);
}

/** 首页下发的按日总数（服务端已按当前过滤条件全量统计，翻页不会改变）。 */
export function activityDayTotals(pages: readonly ActivityFeedPage[]): {
  readonly totals: ReadonlyMap<string, number>;
  readonly truncated: boolean;
} {
  const totals = new Map<string, number>();
  for (const entry of pages[0]?.dayTotals ?? []) {
    totals.set(entry.day, entry.count);
  }
  return { totals, truncated: pages[0]?.dayTotalsTruncated ?? false };
}

/** 侧栏或通知跳转到项目动态前预取首屏，避免切换后先露出时间线骨架。 */
export interface ActivityPrefetchOptions {
  readonly projectId?: number | undefined;
  readonly includeAdminOnly?: boolean | undefined;
  readonly client?: InpulseApiClient | undefined;
}

export function prefetchActivityRoute(
  cache: QueryClient,
  { projectId, includeAdminOnly = false, client }: ActivityPrefetchOptions = {},
): Promise<void> {
  if (
    projectId !== undefined &&
    (!Number.isInteger(projectId) || projectId <= 0)
  ) {
    return Promise.resolve();
  }
  const api = client ?? createApiClient();
  const limit = ACTIVITY_PAGE_LIMIT;
  const shared = {
    ...(includeAdminOnly ? { includeAdminOnly: true } : {}),
    limit,
  };
  return Promise.all([
    cache.prefetchQuery({
      queryKey: ["projects"],
      queryFn: ({ signal }) => api.listProjects({ signal }),
    }),
    // 执行人名称来自用户目录；与动态首屏并行预取，避免时间线先显示“用户 #id”。
    cache.prefetchQuery({
      queryKey: ["users", "directory"],
      queryFn: async () => (await api.getUserDirectory()).items,
    }),
    cache.prefetchInfiniteQuery({
      queryKey:
        projectId === undefined
          ? ["activity", "all", "all", "all", includeAdminOnly, limit]
          : [
              "activity",
              "project:" + projectId,
              "all",
              "all",
              includeAdminOnly,
              limit,
            ],
      queryFn: async ({ pageParam, signal }) => {
        const page =
          projectId === undefined
            ? await api.listActivity(
                {
                  ...(pageParam === undefined ? {} : { cursor: pageParam }),
                  ...shared,
                },
                signal ? { signal } : undefined,
              )
            : await api.getProjectActivity(
                projectId,
                {
                  ...(pageParam === undefined ? {} : { cursor: pageParam }),
                  ...shared,
                },
                signal ? { signal } : undefined,
              );
        return {
          items: [...page.items],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          dayTotals: [...page.dayTotals],
          dayTotalsTruncated: page.dayTotalsTruncated,
        };
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage: { readonly nextCursor: string | null }) =>
        lastPage.nextCursor ?? undefined,
    }),
  ]).then(() => undefined);
}

export function useActivityFeedQuery({
  lockedProjectId,
  projectIds,
  scopeKey,
  category,
  client,
  includeAdminOnly = false,
  limit = ACTIVITY_PAGE_LIMIT,
  enabled = true,
}: ActivityFeedOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const scopedIds = projectIds?.join(",") ?? "all";
  const queryKey = [
    "activity",
    scopeKey,
    scopedIds,
    category ?? "all",
    includeAdminOnly,
    limit,
  ] as const;
  // 显式收窄到空集合时没有任何可读范围，不发请求。
  const hasScope =
    lockedProjectId !== undefined ||
    projectIds === undefined ||
    projectIds.length > 0;

  return useInfiniteQuery<
    ActivityFeedPage,
    Error,
    InfiniteData<ActivityFeedPage, string | undefined>,
    readonly ["activity", string, string, string, boolean, number],
    string | undefined
  >({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const shared = {
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
        ...(category === undefined || category === "all" ? {} : { category }),
        ...(includeAdminOnly ? { includeAdminOnly: true } : {}),
        limit,
      };
      const init = signal ? { signal } : undefined;
      const page =
        lockedProjectId === undefined
          ? await apiClient.listActivity(
              {
                ...(projectIds === undefined
                  ? {}
                  : { projectIds: [...projectIds] }),
                ...shared,
              },
              init,
            )
          : await apiClient.getProjectActivity(lockedProjectId, shared, init);
      return {
        items: [...page.items],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        dayTotals: [...page.dayTotals],
        dayTotalsTruncated: page.dayTotalsTruncated,
      };
    },
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && hasScope,
  });
}

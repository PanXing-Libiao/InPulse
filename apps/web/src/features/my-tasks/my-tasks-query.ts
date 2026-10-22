import {
  keepPreviousData,
  useInfiniteQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
} from "@generated/api";
import { MY_TASKS_MOCK_ADAPTER } from "./my-tasks-mock";
import type {
  MyTaskFilters,
  MyTaskGroupsResult,
  MyTaskListResult,
  MyTasksAdapter,
} from "./my-tasks-types";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";
import { createMyTasksServerAdapter } from "./my-tasks-server";
import { readMyTaskFilters } from "./my-tasks-url";

/**
 * F-32 数据访问层。骨架阶段默认使用 mock adapter；接口冻结后新增
 * server adapter 并在页面注入，本文件与页面结构不变。
 */

export function describeMyTasksError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 422)
      return "任务筛选参数无效或游标已过期，请刷新后重试。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "任务列表暂时不可用，请稍后重试。";
}

export interface UseMyTasksQueryOptions {
  readonly filters: MyTaskFilters;
  readonly viewerId: number | null;
  readonly adapter?: MyTasksAdapter;
}

export interface UseMyTaskGroupsQueryOptions {
  /** 工具栏「项目」下拉选定的项目；null 表示「全部项目」（服务端授权范围内跨项目）。 */
  readonly projectId: number | null;
  readonly adapter?: MyTasksAdapter;
}

/** 侧栏进入任务中心前预取默认筛选的首屏与聚合组，避免切换后先露列表骨架。 */
export function prefetchTaskCenterRoute(
  cache: QueryClient,
  options: {
    readonly viewerId: number | null;
    readonly isAdmin: boolean;
    readonly params?: URLSearchParams | undefined;
    readonly client?: InpulseApiClient | undefined;
  },
): Promise<void> {
  const { viewerId, isAdmin, client, params } = options;
  const adapter = createMyTasksServerAdapter(client);
  const filters = readMyTaskFilters(params ?? new URLSearchParams(), {
    isAdmin,
  });
  const api = client ?? createApiClient();
  return Promise.all([
    cache.prefetchQuery({
      queryKey: ["projects"],
      queryFn: ({ signal }) => api.listProjects({ signal }),
    }),
    cache.prefetchInfiniteQuery({
      queryKey: ["my-tasks", adapter.source, viewerId, filters],
      queryFn: ({ pageParam }) =>
        adapter.fetchMyTasks({ filters, viewerId, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (last: MyTaskListResult) =>
        last.hasMore ? last.nextCursor : undefined,
    }),
    cache.prefetchInfiniteQuery({
      queryKey: ["my-task-groups", adapter.source, filters.projectId],
      queryFn: ({ pageParam }) =>
        adapter.fetchTaskGroups({
          projectId: filters.projectId,
          cursor: pageParam,
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (last: MyTaskGroupsResult) =>
        last.hasMore ? last.nextCursor : undefined,
    }),
  ]).then(() => undefined);
}

/**
 * R-7 任务聚合组列表：按 groupId 倒序签名游标分页；服务端已按
 * AuthorizedProjectScope 过滤，非成员项目不会出现在结果中。
 * 失败时不隐藏任务卡片，由视图在列表下方渲染错误态。
 */
export function useMyTaskGroupsQuery({
  projectId,
  adapter = MY_TASKS_MOCK_ADAPTER,
}: UseMyTaskGroupsQueryOptions) {
  return useInfiniteQuery({
    queryKey: ["my-task-groups", adapter.source, projectId],
    queryFn: ({ pageParam }) =>
      adapter.fetchTaskGroups({ projectId, cursor: pageParam }),
    // 换项目会换 queryKey，此时保留上一份聚合组继续渲染：
    // 否则该区块会先塌成 140px 的转圈占位再撑回，下方内容随之上下跳（2026-09-20 修）。
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    retry: false,
  });
}

export function useMyTasksQuery({
  filters,
  viewerId,
  adapter = MY_TASKS_MOCK_ADAPTER,
}: UseMyTasksQueryOptions) {
  const query = useInfiniteQuery({
    queryKey: ["my-tasks", adapter.source, viewerId, filters],
    queryFn: ({ pageParam }) =>
      adapter.fetchMyTasks({ filters, viewerId, cursor: pageParam }),
    // 同一处根因：切换统计卡 / 筛选会换 queryKey，若不保留上一份列表，
    // 列表区（含展示方式图标行）会被「正在加载任务列表…」占位替换，
    // 高度先缩后涨，下方的聚合组卡片随之上跳再落回（2026-09-20 修）。
    placeholderData: keepPreviousData,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    enabled: filters.scope !== "project" || filters.projectId !== null,
    retry: false,
  });
  const first = query.data?.pages[0];
  return {
    ...query,
    data: first
      ? {
          ...first,
          items: query.data!.pages.flatMap((page) => [...page.items]),
        }
      : undefined,
  };
}

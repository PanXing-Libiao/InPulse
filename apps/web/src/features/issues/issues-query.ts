import { useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
} from "@generated/api";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * F-20 遗留问题聚合读：R-6 GET /api/v1/leftover-items 的服务端签名游标分页。
 * 未闭环与已闭环各自独立分页，列表顺序固定 leftoverItemId DESC（服务端口径），
 * 不在前端做过滤或重排。projectId 是服务端筛选参数，0 或缺省表示全部项目。
 */

export const LEFTOVER_ITEMS_PAGE_LIMIT = 20;

export type LeftoverBucket = "OPEN" | "CLOSED";

export interface LeftoverItemsQueryOptions {
  readonly client?: InpulseApiClient | undefined;
  readonly bucket: LeftoverBucket;
  readonly projectId?: number | undefined;
  readonly enabled?: boolean;
  readonly limit?: number;
}

/** 侧栏进入遗留问题前预取未处理与已处理两桶首屏，避免页面先露列表骨架。 */
export function prefetchIssuesRoute(
  cache: QueryClient,
  client?: InpulseApiClient,
): Promise<void> {
  const api = client ?? createApiClient();
  const limit = LEFTOVER_ITEMS_PAGE_LIMIT;
  const jobs: Promise<unknown>[] = [
    cache.prefetchQuery({
      queryKey: ["projects"],
      queryFn: ({ signal }) => api.listProjects({ signal }),
    }),
  ];
  for (const bucket of ["OPEN", "CLOSED"] as const) {
    jobs.push(
      cache.prefetchInfiniteQuery({
        queryKey: ["leftover-items", bucket, 0, limit],
        queryFn: ({ pageParam, signal }) =>
          api.listLeftoverItems(
            {
              bucket,
              limit,
              ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
            },
            signal ? { signal } : undefined,
          ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: {
          readonly hasMore: boolean;
          readonly nextCursor: string | null;
        }) =>
          lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
      }),
    );
  }
  return Promise.all(jobs).then(() => undefined);
}

export function describeIssuesError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 422) return "遗留问题查询参数无效，请刷新页面后重试。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "遗留问题服务暂时不可用，请稍后重试。";
}

export function useLeftoverItemsQuery({
  client,
  bucket,
  projectId,
  enabled = true,
  limit = LEFTOVER_ITEMS_PAGE_LIMIT,
}: LeftoverItemsQueryOptions) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const scopedProjectId =
    typeof projectId === "number" && projectId > 0 ? projectId : 0;
  return useInfiniteQuery({
    queryKey: ["leftover-items", bucket, scopedProjectId, limit],
    queryFn: ({ pageParam, signal }) =>
      api.listLeftoverItems(
        {
          bucket,
          limit,
          ...(scopedProjectId > 0 ? { projectId: scopedProjectId } : {}),
          ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        },
        signal ? { signal } : undefined,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled,
  });
}

/**
 * 未闭环遗留项计数：侧栏导航与任务中心页头共用的轻量查询（2026-09-22 修）。
 *
 * 与遗留问题页的未闭环列表同源（R-6 `bucket=OPEN`，服务端按 AuthorizedProjectScope
 * 过滤），取首页条数；单页上限 100，超出时只显示上限值，不伪造精确值。查询键挂在
 * `shell-counters` 前缀下，由 AppProviders 的全局 MutationCache 在写成功后统一失效，
 * 两处入口数字始终一致。
 */
export const OPEN_LEFTOVER_COUNT_QUERY_KEY = [
  "shell-counters",
  "open-leftovers",
] as const;

/** R-6 单页上限（AGGREGATE_READ_PAGE_LIMIT_MAX）；超出时计数显示为该上限。 */
export const OPEN_LEFTOVER_COUNT_LIMIT = 100;

export interface OpenLeftoverCountOptions {
  readonly client?: InpulseApiClient | undefined;
  readonly enabled?: boolean;
  readonly staleTime?: number;
}

/** 返回未闭环遗留项条数；null 表示尚未加载或不可用（调用方不显示数字）。 */
export function useOpenLeftoverCount({
  client,
  enabled = true,
  staleTime = 60_000,
}: OpenLeftoverCountOptions = {}): number | null {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const query = useQuery({
    queryKey: OPEN_LEFTOVER_COUNT_QUERY_KEY,
    queryFn: ({ signal }) =>
      api.listLeftoverItems(
        { bucket: "OPEN", limit: OPEN_LEFTOVER_COUNT_LIMIT },
        signal ? { signal } : undefined,
      ),
    enabled,
    staleTime,
    retry: false,
  });
  const page = query.data;
  if (!page) return null;
  return page.hasMore ? OPEN_LEFTOVER_COUNT_LIMIT : page.items.length;
}

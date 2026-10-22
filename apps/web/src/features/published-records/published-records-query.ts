import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createApiClient,
  type InpulseApiClient,
  type RecordFeedQueryRequest,
} from "@generated/api";

/**
 * B-1 / B-3b 正式记录分页：页面统一使用跨项目 `listRecordFeed`（项目下拉选
 * 「全部项目」时不下发 projectId），单项目视图由服务端 `projectId` 收窄同一路由。
 */
export const PUBLISHED_RECORDS_PAGE_LIMIT = 20;

export type RecordFeedStatus = NonNullable<RecordFeedQueryRequest["status"]>;
export type RecordFeedSource = NonNullable<RecordFeedQueryRequest["source"]>;

export interface RecordFeedQueryOptions {
  readonly client?: InpulseApiClient | undefined;
  /** 0 表示「全部项目」：服务端按 AuthorizedProjectScope 返回可读项目，不按项目收窄。 */
  readonly projectId: number;
  readonly status: RecordFeedStatus;
  readonly source: RecordFeedSource;
  /** 已完成防抖的关键词；不足 2 字时不作为 q 下发（契约最短 2 字）。 */
  readonly query: string;
  readonly limit?: number;
}

/**
 * B-3b 跨项目记录清单：GET /change-records（listRecordFeed）。
 * 项目 / 状态 / 来源 / 关键词全部是服务端筛选，游标由服务端签名并绑定这些条件；
 * 条件变化即换 queryKey，从第一页重新开始，不做前端重排或已加载页内过滤。
 */
export function prefetchRecordFeedRoute(
  cache: QueryClient,
  projectId: number,
  client?: InpulseApiClient,
): Promise<void> {
  if (!Number.isInteger(projectId) || projectId < 0) return Promise.resolve();
  const api = client ?? createApiClient();
  const limit = PUBLISHED_RECORDS_PAGE_LIMIT;
  return cache.prefetchInfiniteQuery({
    queryKey: ["record-feed", projectId, "PUBLISHED", "ALL", "", limit],
    queryFn: ({ pageParam, signal }) =>
      api.listRecordFeed(
        {
          status: "PUBLISHED",
          source: "ALL",
          limit,
          ...(projectId > 0 ? { projectId } : {}),
          ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        },
        signal ? { signal } : undefined,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: {
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    }) => (lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined),
  });
}

export function useRecordFeedQuery({
  client,
  projectId,
  status,
  source,
  query,
  limit = PUBLISHED_RECORDS_PAGE_LIMIT,
}: RecordFeedQueryOptions) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const term = query.trim();
  return useInfiniteQuery({
    queryKey: ["record-feed", projectId, status, source, term, limit],
    queryFn: ({ pageParam, signal }) =>
      api.listRecordFeed(
        {
          status,
          source,
          limit,
          ...(projectId > 0 ? { projectId } : {}),
          ...(term.length >= 2 ? { q: term } : {}),
          ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        },
        signal ? { signal } : undefined,
      ),
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    retry: false,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
  });
}

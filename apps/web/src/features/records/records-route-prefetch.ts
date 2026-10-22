import type { QueryClient } from "@tanstack/react-query";
import { createApiClient, type InpulseApiClient } from "@generated/api";
import { MY_RECORD_DRAFTS_PAGE_LIMIT } from "@features/record-drafts/record-drafts-query";
import { prefetchRecordFeedRoute } from "@features/published-records/published-records-query";

function prefetchMyRecordDrafts(
  cache: QueryClient,
  api: InpulseApiClient,
): Promise<unknown> {
  return cache.prefetchInfiniteQuery({
    queryKey: ["my-record-drafts", MY_RECORD_DRAFTS_PAGE_LIMIT],
    queryFn: ({ pageParam, signal }) =>
      api.listMyRecordDrafts(
        {
          limit: MY_RECORD_DRAFTS_PAGE_LIMIT,
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

/**
 * 侧栏「迭代记录」默认落在全部项目视图：正式记录首屏 + 我的草稿首屏。
 * 两段数据在页面里各有一块骨架，提前取好后切换过去直接呈现内容。
 */
export function prefetchRecordsRoute(
  cache: QueryClient,
  client?: InpulseApiClient,
): Promise<void> {
  const api = client ?? createApiClient();
  return Promise.all([
    cache.prefetchQuery({
      queryKey: ["projects"],
      queryFn: ({ signal }) => api.listProjects({ signal }),
    }),
    prefetchRecordFeedRoute(cache, 0, client),
    prefetchMyRecordDrafts(cache, api),
  ]).then(() => undefined);
}

/**
 * 记录深链（搜索结果、通知、项目动态）需要的首屏：记录列表、草稿条带与
 * 目标记录详情同时预取。只取列表时，卡片会先落地、详情区随后仍闪一块骨架。
 */
export function prefetchPublishedRecordRoute(
  cache: QueryClient,
  projectId: number,
  recordId: number,
  client?: InpulseApiClient,
): Promise<void> {
  if (
    !Number.isInteger(projectId) ||
    projectId <= 0 ||
    !Number.isInteger(recordId) ||
    recordId <= 0
  ) {
    return Promise.resolve();
  }
  const api = client ?? createApiClient();
  return Promise.all([
    cache.prefetchQuery({
      queryKey: ["projects"],
      queryFn: ({ signal }) => api.listProjects({ signal }),
    }),
    prefetchRecordFeedRoute(cache, projectId, client),
    prefetchMyRecordDrafts(cache, api),
    cache.prefetchQuery({
      queryKey: ["published-record", projectId, recordId],
      queryFn: ({ signal }) =>
        api.getChangeRecord(projectId, recordId, { signal }),
    }),
    cache.prefetchQuery({
      queryKey: ["record-versions", projectId, recordId],
      queryFn: ({ signal }) =>
        api.listChangeRecordVersions(projectId, recordId, { signal }),
    }),
  ]).then(() => undefined);
}

/** 识别 records 深链的 publishedId 并按记录详情预热；其他地址返回 null。 */
export function prefetchRecordPath(
  cache: QueryClient,
  path: string,
  client?: InpulseApiClient,
): Promise<void> | null {
  const url = new URL(path, "http://inpulse.local");
  if (url.pathname !== "/records") return null;
  const projectId = Number(url.searchParams.get("projectId"));
  const recordId = Number(url.searchParams.get("publishedId"));
  if (
    !Number.isInteger(projectId) ||
    projectId <= 0 ||
    !Number.isInteger(recordId) ||
    recordId <= 0
  ) {
    return null;
  }
  return prefetchPublishedRecordRoute(cache, projectId, recordId, client);
}

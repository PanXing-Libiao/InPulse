import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
} from "@generated/api";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export const SEARCH_MIN_LENGTH = 1;
export const SEARCH_MAX_LENGTH = 200;
export const DEFAULT_SEARCH_LIMIT = 20;

export interface SearchQueryOptions {
  readonly query: string;
  readonly client?: InpulseApiClient;
  readonly limit?: number;
}

export function normalizeSearchQuery(query: string): string {
  return query.trim();
}

export function isValidSearchQuery(query: string): boolean {
  const normalized = normalizeSearchQuery(query);
  return (
    normalized.length >= SEARCH_MIN_LENGTH &&
    normalized.length <= SEARCH_MAX_LENGTH
  );
}

export function describeSearchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return SESSION_EXPIRED_MESSAGE;
    }
    if (error.status === 422) {
      return "搜索参数无效或结果游标已过期，请重新搜索。";
    }
    if (error.status === 429) {
      return "搜索请求过于频繁，请稍后重试。";
    }
  }
  return "搜索暂时不可用，请稍后重试。";
}

export function useSearchInfiniteQuery({
  query,
  client,
  limit = DEFAULT_SEARCH_LIMIT,
}: SearchQueryOptions) {
  const normalizedQuery = normalizeSearchQuery(query);
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);

  return useInfiniteQuery({
    queryKey: ["search", normalizedQuery, limit],
    queryFn: ({ pageParam }) =>
      apiClient.getSearch({
        q: normalizedQuery,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        limit,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled: isValidSearchQuery(normalizedQuery),
  });
}

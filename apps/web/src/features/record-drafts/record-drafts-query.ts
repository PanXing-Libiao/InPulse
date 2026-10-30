import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createApiClient, type InpulseApiClient } from "@generated/api";

/**
 * B-1 草稿列表：GET /projects/{projectId}/record-drafts 的服务端签名游标
 * 分页（C-006 envelope）。任务来源草稿仍走 getTaskRecordDrafts 单页读取。
 */
export const RECORD_DRAFTS_PAGE_LIMIT = 20;

/** B-3b：我的草稿（全局）查询键前缀；保存草稿后按此失效条带。 */
export const MY_RECORD_DRAFTS_QUERY_KEY = ["my-record-drafts"] as const;

export const MY_RECORD_DRAFTS_PAGE_LIMIT = 20;

export interface MyRecordDraftsQueryOptions {
  readonly client?: InpulseApiClient | undefined;
  /** 未登录或不显示条带时关闭；服务端只返回当前 actor 的草稿，无他人身份参数。 */
  readonly enabled?: boolean;
  readonly limit?: number;
}

/**
 * B-3b 我的草稿：GET /me/record-drafts（listMyRecordDrafts）。
 * 跨项目返回当前用户仍可访问的项目里的草稿，并回填项目 / 模块名称；
 * 被移出项目后服务端立即不再返回对应草稿。
 */
export function useMyRecordDraftsQuery({
  client,
  enabled = true,
  limit = MY_RECORD_DRAFTS_PAGE_LIMIT,
}: MyRecordDraftsQueryOptions) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  return useInfiniteQuery({
    queryKey: ["my-record-drafts", limit],
    queryFn: ({ pageParam, signal }) =>
      api.listMyRecordDrafts(
        {
          limit,
          ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        },
        signal ? { signal } : undefined,
      ),
    initialPageParam: undefined as string | undefined,
    retry: false,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
    enabled,
  });
}

export interface RecordDraftsQueryOptions {
  readonly client?: InpulseApiClient | undefined;
  readonly projectId: number;
  readonly enabled?: boolean;
  readonly limit?: number;
  /** 只看该用户创建的草稿（项目草稿区传当前用户 id）；省略返回项目内全部草稿。 */
  readonly authorId?: number | undefined;
}

export function useRecordDraftsQuery({
  client,
  projectId,
  enabled = true,
  limit = RECORD_DRAFTS_PAGE_LIMIT,
  authorId,
}: RecordDraftsQueryOptions) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  return useInfiniteQuery({
    queryKey: ["record-drafts", projectId, limit, authorId ?? 0],
    queryFn: ({ pageParam, signal }) =>
      api.listRecordDrafts(
        projectId,
        {
          limit,
          ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
          ...(authorId === undefined ? {} : { authorId }),
        },
        signal ? { signal } : undefined,
      ),
    initialPageParam: undefined as string | undefined,
    retry: false,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
    enabled: enabled && projectId > 0,
  });
}

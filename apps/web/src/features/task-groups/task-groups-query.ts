import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError } from "@generated/api";
import type { TaskGroupAdapter } from "./task-groups-types";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * F-25 数据访问层：R-1 聚合组详情与 R-4 记录分页（服务端签名游标）。
 * 筛选（memberTaskId）由 URL 状态驱动并进入查询键，切换筛选时自动重新分页；
 * 不使用客户端过滤，保证「先过滤后分页」与服务端口径一致。
 */

export const TASK_GROUP_RECORDS_PAGE_SIZE = 20;

export function describeTaskGroupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return "聚合组不存在，或你已无权访问。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "聚合组服务暂时不可用，请稍后重试。";
}

export interface UseTaskGroupQueryOptions {
  readonly groupId: number;
  readonly adapter: TaskGroupAdapter;
  /** 宿主未打开时置 false，避免为关闭的弹层发起请求。 */
  readonly enabled?: boolean;
}

export function useTaskGroupQuery({
  groupId,
  adapter,
  enabled = true,
}: UseTaskGroupQueryOptions) {
  return useQuery({
    queryKey: ["task-group", adapter.source, groupId],
    queryFn: () => adapter.fetchTaskGroup(groupId),
    enabled,
    retry: false,
  });
}

export interface UseTaskGroupRecordsQueryOptions {
  readonly groupId: number;
  readonly memberTaskId: number | null;
  readonly adapter: TaskGroupAdapter;
}

export function useTaskGroupRecordsQuery({
  groupId,
  memberTaskId,
  adapter,
}: UseTaskGroupRecordsQueryOptions) {
  return useInfiniteQuery({
    queryKey: ["task-group-records", adapter.source, groupId, memberTaskId],
    queryFn: ({ pageParam }) =>
      adapter.fetchTaskGroupRecords(groupId, {
        ...(memberTaskId === null ? {} : { memberTaskId }),
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
}

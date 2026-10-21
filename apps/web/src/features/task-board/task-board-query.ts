import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ApiError } from "@generated/api";

import type { TaskBoardAdapter } from "./task-board-types";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/** R-8 数据访问层：沿用页面注入的适配器，不引入额外缓存层。 */

export function describeTaskBoardError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return SESSION_EXPIRED_MESSAGE;
    }
    if (error.status === 404) return "项目不存在或已无权访问。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "任务看板暂时不可用，请稍后重试。";
}

export interface UseTaskBoardQueryOptions {
  readonly projectId: number;
  readonly adapter: TaskBoardAdapter;
  readonly enabled?: boolean | undefined;
}

export function useTaskBoardQuery({
  projectId,
  adapter,
  enabled = true,
}: UseTaskBoardQueryOptions) {
  return useQuery({
    queryKey: ["task-board", adapter.source, projectId],
    queryFn: () => adapter.fetchTaskBoard({ projectId }),
    enabled,
    retry: false,
    // 换项目只换 queryKey（2026-10-10）：看板保留上一份数据，不先塌成骨架再撑回。
    placeholderData: keepPreviousData,
  });
}

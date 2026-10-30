import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type ModuleTaskItem,
  type TaskEditRequest,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export type TaskViewItem = ModuleTaskItem;
export type TaskDraft = TaskEditRequest;
export interface TaskScope {
  projectId: number;
  moduleId: number;
}
export const taskFields = [
  "title",
  "description",
  "priority",
  "assigneeIds",
  "dueAt",
] as const;
export type TaskField = (typeof taskFields)[number];
export function taskEdit(item: TaskViewItem): TaskDraft {
  return {
    title: item.title,
    description: item.description,
    priority: item.priority,
    assigneeIds: [...item.assigneeIds],
    dueAt: item.dueAt,
  };
}
export function mergeTask(
  base: TaskDraft,
  draft: TaskDraft,
  latest: TaskDraft,
) {
  const values = { ...latest };
  const conflicts: TaskField[] = [];
  for (const field of taskFields) {
    if (JSON.stringify(draft[field]) === JSON.stringify(base[field])) continue;
    if (
      JSON.stringify(latest[field]) !== JSON.stringify(base[field]) &&
      JSON.stringify(latest[field]) !== JSON.stringify(draft[field])
    )
      conflicts.push(field);
    Object.assign(values, { [field]: draft[field] });
  }
  return { values, conflicts };
}
export function taskError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return "任务或模块不存在，或你已无权访问。";
    if (error.status === 403) return "权限或安全校验未通过，请重新登录后重试。";
    if (error.status === 409)
      return `${error.message}。输入已保留，请加载最新版本后继续编辑。`;
    if (error.status === 422)
      return `${error.message}，请检查字段及负责人是否仍为项目活跃成员。`;
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "任务服务暂时不可用，输入已保留，可重试。";
}
/**
 * 查询被 `enabled: false` 关闭时 React Query 仍保持 `isPending`，直接用它渲染
 * 加载文案会在「归属尚未选好」时留下一直存在的假加载提示；只有既没有数据、
 * 又确实在取数时才属于真正的首次加载。
 */
export function isFirstLoad(query: {
  readonly isPending: boolean;
  readonly isFetching: boolean;
}): boolean {
  return query.isPending && query.isFetching;
}
export function useTasks(scope: TaskScope, client?: InpulseApiClient) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const args = [scope.projectId, scope.moduleId] as const;
  const query = useQuery({
    queryKey: ["tasks", ...args],
    queryFn: ({ signal }) =>
      api.listModuleTasks(scope.projectId, scope.moduleId, { signal }),
    retry: false,
  });
  const members = useQuery({
    queryKey: ["task-assignees", ...args],
    queryFn: ({ signal }) =>
      api.listModuleTaskAssignees(scope.projectId, scope.moduleId, { signal }),
    retry: false,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async ({
      item,
      edit,
    }: {
      item?: TaskViewItem;
      edit: TaskDraft;
    }) => {
      const body = { ...edit, title: edit.title.trim() };
      const signature = JSON.stringify([
        ...args,
        item?.id,
        item?.rowVersion,
        body,
      ]);
      if (retry.current?.signature !== signature)
        retry.current = { signature, key: createIdempotencyKey("task") };
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retry.current.key,
          ...(item ? { "If-Match": `"${item.rowVersion}"` } : {}),
        },
      };
      return item
        ? api.updateModuleTask(
            scope.projectId,
            scope.moduleId,
            item.id,
            body,
            init,
          )
        : api.createModuleTask(scope.projectId, scope.moduleId, body, init);
    },
    onSuccess: () => {
      retry.current = null;
      void Promise.all(
        [
          "tasks",
          "task-board",
          "modules",
          "project-overview",
          "activity",
          "search",
          "notifications",
          "my-tasks",
          "my-task-groups",
          "task-marks",
          "task-group",
          "task-group-records",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
    },
  });
  return { api, query, members, mutation };
}

import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type TaskEditRequest,
  type TaskItem,
  type ModuleTaskItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export type TaskViewItem = TaskItem | ModuleTaskItem;
export type TaskDraft = TaskEditRequest & { impactFeatureIds?: number[] };
export interface TaskScope {
  projectId: number;
  moduleId: number;
  featureId: number | null;
}
export const taskFields = [
  "title",
  "description",
  "priority",
  "assigneeIds",
  "dueAt",
  "impactFeatureIds",
] as const;
export type TaskField = (typeof taskFields)[number];
export function taskEdit(item: TaskViewItem): TaskDraft {
  return {
    title: item.title,
    description: item.description,
    priority: item.priority,
    assigneeIds: [...item.assigneeIds],
    dueAt: item.dueAt,
    ...(item.scopeType === "MODULE"
      ? { impactFeatureIds: [...item.impactFeatureIds] }
      : {}),
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
    if (error.status === 404) return "任务或功能不存在，或你已无权访问。";
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
export function useTasks(
  scope: TaskScope,
  client?: InpulseApiClient,
  options: { impactOptions?: boolean } = {},
) {
  const impactOptions = options.impactOptions ?? true;
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const args = [scope.projectId, scope.moduleId, scope.featureId] as const;
  const query = useQuery({
    queryKey: ["tasks", ...args],
    queryFn: ({ signal }) =>
      scope.featureId === null
        ? api.listModuleTasks(scope.projectId, scope.moduleId, { signal })
        : api.listTasks(scope.projectId, scope.moduleId, scope.featureId, {
            signal,
          }),
    retry: false,
  });
  const members = useQuery({
    queryKey: ["task-assignees", ...args],
    queryFn: ({ signal }) =>
      scope.featureId === null
        ? api.listModuleTaskAssignees(scope.projectId, scope.moduleId, {
            signal,
          })
        : api.listTaskAssignees(
            scope.projectId,
            scope.moduleId,
            scope.featureId,
            { signal },
          ),
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
      const { impactFeatureIds, ...fields } = edit;
      const body = { ...fields, title: edit.title.trim() };
      const impacts = [...new Set(impactFeatureIds ?? [])].sort(
        (a, b) => a - b,
      );
      const signature = JSON.stringify([
        ...args,
        item?.id,
        item?.rowVersion,
        body,
        ...(scope.featureId === null ? [impacts] : []),
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
      if (scope.featureId === null)
        return item
          ? api.updateModuleTask(
              scope.projectId,
              scope.moduleId,
              item.id,
              { ...body, impactFeatureIds: impacts },
              init,
            )
          : api.createModuleTask(
              scope.projectId,
              scope.moduleId,
              { ...body, impactFeatureIds: impacts },
              init,
            );
      return item
        ? api.updateTask(
            scope.projectId,
            scope.moduleId,
            scope.featureId,
            item.id,
            body,
            init,
          )
        : api.createTask(
            scope.projectId,
            scope.moduleId,
            scope.featureId,
            body,
            init,
          );
    },
    onSuccess: async () => {
      retry.current = null;
      await Promise.all(
        // my-tasks / my-task-groups / task-marks：任务中心与聚合视图按这些键缓存，
        // 编辑（含负责人变化）后必须同批失效，否则中心列表停留旧数据。
        // task-group / task-group-records：聚合组详情的成员块正是这些字段（标题、
        // 负责人、状态、优先级、记录数），编辑后若不失效会一直显示旧值，
        // 只能靠手动刷新（2026-09-22 修）。
        // modules / features / project-overview：新建任务改变待办计数，编辑影响
        // 功能关联会改变统计归属口径（2026-09-24 修）。
        [
          "tasks",
          "task-board",
          "modules",
          "features",
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
  const features = useQuery({
    queryKey: ["task-impact-options", scope.projectId, scope.moduleId],
    queryFn: ({ signal }) =>
      api.listFeatures(scope.projectId, scope.moduleId, { signal }),
    retry: false,
    enabled: impactOptions && scope.featureId === null,
  });
  return { api, query, members, mutation, features };
}

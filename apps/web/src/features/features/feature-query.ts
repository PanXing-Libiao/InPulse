import { useMemo, useRef } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type FeatureEditRequest,
  type FeatureItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export type FeatureChange = {
  action: "create" | "update";
  item?: FeatureItem;
  name: string;
  currentBehavior: string;
  acceptanceCriteria: string;
  tags: string;
};
export function featureErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return `${error.message}。输入已保留，请检查冲突并加载最新版本后继续编辑。`;
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return "项目或功能不存在，或你已无权访问。";
    if (error.status === 403)
      return "你没有执行此操作的权限，或安全校验未通过。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 422) return "请检查功能名称与描述。";
  }
  return "功能服务暂时不可用，请重试。";
}

/**
 * 功能页首屏需要项目详情、模块目录与功能目录三份数据；悬停搜索结果或任务卡片时
 * 提前取好，点击后在旧页仍可见的同一帧内直接渲染完整页面，避免「页面已切换、
 * 数据未到」的空白骨架闪一下。
 */
export function prefetchFeatureRoute(
  cache: QueryClient,
  params: {
    readonly projectId: number;
    readonly moduleId: number;
    readonly featureId?: number | null;
  },
  client?: InpulseApiClient,
): void {
  const { projectId, moduleId, featureId } = params;
  if (
    !Number.isInteger(projectId) ||
    projectId <= 0 ||
    !Number.isInteger(moduleId) ||
    moduleId <= 0
  ) {
    return;
  }
  const api = client ?? createApiClient();
  // 侧栏项目树与页面主体共用项目目录；项目级详情不能替代这层列表缓存。
  void cache.prefetchQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => api.listProjects({ signal }),
  });
  void cache.prefetchQuery({
    queryKey: ["projects", "detail", projectId],
    queryFn: () => api.getProject(projectId),
    staleTime: 60_000,
  });
  void cache.prefetchQuery({
    queryKey: ["modules", projectId],
    queryFn: ({ signal }) => api.listModules(projectId, { signal }),
  });
  void cache.prefetchQuery({
    queryKey: ["features", projectId, moduleId, featureId ?? undefined],
    queryFn: async ({ signal }) => {
      const page = await api.listFeatures(projectId, moduleId, { signal });
      // 侧栏功能树与功能详情页使用不同的 queryKey，但读取的是同一份目录。
      if (featureId !== undefined && featureId !== null) {
        cache.setQueryData(["features", projectId, moduleId, undefined], page);
      }
      return page;
    },
  });
  const prefetchTasks = (targetFeatureId: number | null) => {
    const args = [projectId, moduleId, targetFeatureId] as const;
    void cache.prefetchQuery({
      queryKey: ["tasks", ...args],
      queryFn: ({ signal }) =>
        targetFeatureId === null
          ? api.listModuleTasks(projectId, moduleId, { signal })
          : api.listTasks(projectId, moduleId, targetFeatureId, { signal }),
    });
    void cache.prefetchQuery({
      queryKey: ["task-assignees", ...args],
      queryFn: ({ signal }) =>
        targetFeatureId === null
          ? api.listModuleTaskAssignees(projectId, moduleId, { signal })
          : api.listTaskAssignees(projectId, moduleId, targetFeatureId, {
              signal,
            }),
    });
  };
  prefetchTasks(null);
  if (featureId !== undefined && featureId !== null) {
    prefetchTasks(featureId);
  }
}

export function useFeatures(
  projectId: number,
  moduleId: number,
  featureId?: number,
  client?: InpulseApiClient,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);
  const query = useQuery({
    queryKey: ["features", projectId, moduleId, featureId],
    queryFn: async ({ signal }) =>
      api.listFeatures(projectId, moduleId, { signal }),
    retry: false,
    enabled:
      Number.isInteger(projectId) &&
      projectId > 0 &&
      Number.isInteger(moduleId) &&
      moduleId > 0,
    // 换模块 / 换功能只换 queryKey（2026-10-10）：保留上一份目录原地换数据。
    placeholderData: keepPreviousData,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (change: FeatureChange) => {
      const edit: FeatureEditRequest = {
        name: change.name.trim(),
        currentBehavior: change.currentBehavior,
        acceptanceCriteria: change.acceptanceCriteria,
        tags:
          change.item && change.tags === change.item.tags.join("\n")
            ? [...change.item.tags]
            : change.tags
                .split("\n")
                .map((tag) => tag.trim())
                .filter(Boolean),
      };
      const signature = JSON.stringify([
        projectId,
        moduleId,
        change.action,
        change.item?.id,
        change.item?.rowVersion,
        edit,
      ]);
      if (retryKey.current?.signature !== signature)
        retryKey.current = { signature, key: createIdempotencyKey("feature") };
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retryKey.current.key,
          ...(change.item ? { "If-Match": `"${change.item.rowVersion}"` } : {}),
        },
      };
      if (change.action === "create")
        return api.createFeature(projectId, moduleId, edit, init);
      if (!change.item) throw new Error("Feature selection missing");
      return api.updateFeature(projectId, moduleId, change.item.id, edit, init);
    },
    // 失效刷新必须非阻塞（沿用 ADR-058 实测结论）：query-core 在 `onSuccess` resolve
    // 之后才 dispatch success，也就是全部失效链路跑完 `isPending` 才转 false，而弹窗的
    // 取消按钮、遮罩与 ✕ 都按它上锁——`await` 在这里会让弹窗转圈并卡住不关。
    onSuccess: () => {
      retryKey.current = null;
      void Promise.all([
        cache.invalidateQueries({ queryKey: ["features", projectId] }),
        cache.invalidateQueries({ queryKey: ["feature-similar", projectId] }),
        cache.invalidateQueries({ queryKey: ["activity", projectId] }),
        cache.invalidateQueries({ queryKey: ["search"] }),
      ]);
    },
  });
  return { query, mutation };
}

/** ADR-059：删除功能只认功能 ID 与当前行版本（`If-Match`）。 */
export type FeatureDeletionTarget = {
  readonly id: number;
  readonly rowVersion: number;
};

/**
 * ADR-059：删除功能。服务端在同一事务内软删除功能、其下全部任务，并级联解除
 * 这些任务的 GitHub 链接关联、作废其已发布记录、写审计与项目动态；
 * 模块级影响任务（`scope_type = MODULE`）不被删除，影响关系行作为历史保留。
 * 删除没有恢复入口；功能行只随所属项目的物理删除（ADR-062）一并清除。
 *
 * 失效清单比编辑宽：级联删除了任务，因此任务、看板、聚合组、任务中心、遗留问题、
 * 项目概览与侧栏计数都要重取。失效刷新一律非阻塞（理由同上）。
 */
export function useDeleteFeature(
  projectId: number,
  moduleId: number,
  client?: InpulseApiClient | undefined,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (target: FeatureDeletionTarget) => {
      const csrf = await api.issueCsrfToken();
      return api.deleteFeature(
        projectId,
        moduleId,
        target.id,
        { reason: null },
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "Idempotency-Key": createIdempotencyKey("feature-delete"),
            "If-Match": `"${target.rowVersion}"`,
          },
        },
      );
    },
    onSuccess: () => {
      void Promise.all(
        [
          ["features", projectId],
          ["feature-similar", projectId],
          ["modules", projectId],
          ["tasks"],
          ["task-board"],
          ["task-group"],
          ["task-group-records"],
          ["task-marks"],
          ["my-tasks"],
          ["my-task-groups"],
          ["leftover-items"],
          ["project-overview", projectId],
          ["projects"],
          ["activity", projectId],
          ["activity-center"],
          ["search"],
          ["notifications"],
          ["record-feed"],
          // 被作废的记录可能已在记录页 / 项目主页弹窗里被打开过，按当前项目前缀
          // 一起失效（记录 ID 在删除前未知，取不到逐条 key）。
          ["published-record", projectId],
          ["record-versions", projectId],
        ].map((queryKey) => cache.invalidateQueries({ queryKey })),
      );
      void invalidateShellCounters(cache);
    },
  });
}

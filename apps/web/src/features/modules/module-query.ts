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
  type ModuleEditRequest,
  type ModuleItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/** ADR-044：模块层面已下线归档，模块命令只有新建、编辑与删除（ADR-096）。 */
export type ModuleChange = {
  action: "create" | "update";
  item?: ModuleItem;
  name: string;
  description: string;
};
export function moduleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return `${error.message}。输入已保留，请检查冲突并加载最新版本后继续编辑。`;
    }
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return "项目或模块不存在，或你已无权访问。";
    if (error.status === 403)
      return "你没有执行此操作的权限，或安全校验未通过。";
    if (error.status === 422) return "请检查模块名称或描述。";
  }
  return "模块服务暂时不可用，请重试。";
}

/** 项目主页（模块目录）首屏数据预取：项目详情 + 模块目录。 */
export function prefetchModulesRoute(
  cache: QueryClient,
  projectId: number,
  client?: InpulseApiClient,
): void {
  if (!Number.isInteger(projectId) || projectId <= 0) {
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
}

export function useModules(projectId: number, client?: InpulseApiClient) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);
  const query = useQuery({
    queryKey: ["modules", projectId],
    queryFn: ({ signal }) => api.listModules(projectId, { signal }),
    retry: false,
    enabled: Number.isInteger(projectId) && projectId > 0,
    // 换项目只换 queryKey（2026-10-10 用户指示：项目间切换不要再闪）：保留上一份列表
    // 原地换数据，内容区不会先塌成骨架再撑回。侧栏项目树按项目各持一个实例、
    // projectId 不变，命不中这条占位。
    placeholderData: keepPreviousData,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (change: ModuleChange) => {
      const edit: ModuleEditRequest = {
        name: change.name.trim(),
        description: change.description,
      };
      const signature = JSON.stringify([
        projectId,
        change.action,
        change.item?.id,
        change.item?.rowVersion,
        edit,
      ]);
      if (retryKey.current?.signature !== signature)
        retryKey.current = { signature, key: createIdempotencyKey("module") };
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retryKey.current.key,
          ...(change.item ? { "If-Match": `"${change.item.rowVersion}"` } : {}),
        },
      };
      if (change.action === "create")
        return api.createModule(projectId, edit, init);
      if (!change.item) throw new Error("Module selection missing");
      return api.updateModule(projectId, change.item.id, edit, init);
    },
    // 失效刷新必须非阻塞（沿用 ADR-058 实测结论）：query-core 在 `onSuccess` resolve
    // 之后才 dispatch success，也就是全部失效链路跑完 `isPending` 才转 false，而弹窗的
    // 取消按钮、遮罩与 ✕ 都按它上锁——`await` 在这里会让弹窗转圈并卡住不关。
    onSuccess: () => {
      retryKey.current = null;
      void Promise.all([
        cache.invalidateQueries({ queryKey: ["modules", projectId] }),
        cache.invalidateQueries({ queryKey: ["activity", projectId] }),
        cache.invalidateQueries({ queryKey: ["search"] }),
      ]);
    },
  });
  return { query, mutation };
}

/** ADR-096：删除模块只认模块 ID 与当前行版本（`If-Match`）。 */
export type ModuleDeletionTarget = {
  readonly id: number;
  readonly rowVersion: number;
};

/**
 * ADR-096：删除模块。服务端在同一事务内物理删除模块、其下全部任务，
 * 以及这些实体的全部迭代记录、版本、遗留项与链接关联；只保留审计与项目动态。
 * 删除没有恢复入口，模块及其全部下级不会留下可读快照。
 *
 * 失效清单比编辑宽：级联删除了任务，因此任务、看板、聚合组、任务中心、
 * 遗留问题、项目概览与侧栏计数都要重取。失效刷新一律非阻塞（理由同上）。
 */
export function useDeleteModule(
  projectId: number,
  client?: InpulseApiClient | undefined,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (target: ModuleDeletionTarget) => {
      const csrf = await api.issueCsrfToken();
      return api.deleteModule(
        projectId,
        target.id,
        { reason: null },
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "Idempotency-Key": createIdempotencyKey("module-delete"),
            "If-Match": `"${target.rowVersion}"`,
          },
        },
      );
    },
    onSuccess: () => {
      void Promise.all(
        [
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
          ["record-drafts"],
          ["task-record-drafts"],
          ["my-record-drafts"],
          ["record-summary"],
          // 被永久删除的记录可能已在记录页 / 项目主页弹窗里被打开过，按当前项目前缀
          // 一起失效（记录 ID 在删除前未知，取不到逐条 key）。
          ["published-record", projectId],
          ["record-versions", projectId],
        ].map((queryKey) => cache.invalidateQueries({ queryKey })),
      );
      void invalidateShellCounters(cache);
    },
  });
}

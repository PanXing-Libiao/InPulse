import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type CreateProjectRequest,
  type InpulseApiClient,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export interface ProjectMutationOptions {
  readonly client?: InpulseApiClient | undefined;
}

export function describeProjectListError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return "项目不存在或已无权访问。";
    return "项目列表暂时无法加载，请稍后重试。";
  }
  return "项目列表暂时无法加载，请稍后重试。";
}

export interface ProjectListOptions extends ProjectMutationOptions {
  readonly enabled?: boolean | undefined;
}

export function useProjects({
  client,
  enabled = true,
}: ProjectListOptions = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => apiClient.listProjects({ signal }),
    retry: false,
    enabled,
  });
}

export interface ProjectDetailOptions extends ProjectMutationOptions {
  readonly projectId: number | null;
  readonly enabled?: boolean | undefined;
}

/**
 * ADR-033：`getProject` 响应包含 `currentUserRole`，钩子返回完整响应；
 * 消费方用 `data.project` 取项目、`data.currentUserRole` 判断项目内管理入口。
 */
export function useProjectDetail({
  client,
  projectId,
  enabled = true,
}: ProjectDetailOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["projects", "detail", projectId],
    queryFn: async () => {
      if (projectId === null) {
        throw new Error("projectId is required");
      }
      return apiClient.getProject(projectId);
    },
    enabled: enabled && projectId !== null,
    retry: false,
    staleTime: 60_000,
  });
}

/** ADR-039：项目内管理入口对全体活跃成员开放（含组长）；非成员 `role` 为 null。 */
export function canManageProjectResources(
  isSystemAdmin: boolean,
  role: "MEMBER" | "LEADER" | null | undefined,
): boolean {
  if (isSystemAdmin) return true;
  return role === "MEMBER" || role === "LEADER";
}

/**
 * ADR-062：删除项目只对系统管理员与本项目组长开放，普通成员连入口都不显示；
 * 服务端 `projectDeleterRole` 会以同一口径二次判定。
 */
export function canDeleteProject(
  isSystemAdmin: boolean,
  role: "MEMBER" | "LEADER" | null | undefined,
): boolean {
  return isSystemAdmin || role === "LEADER";
}

/**
 * ADR-059：删除模块与功能同样只对系统管理员与本项目组长开放，普通成员连入口都不
 * 显示；服务端 `scopeDeleterRole` 以同一口径二次判定。
 *
 * 判定式与 `canDeleteProject` 当前相同，但不合并成同一个函数：两者是两条独立裁决
 * （ADR-062 与 ADR-059），以后调整删除项目口径时不能顺带放大模块与功能的删除权。
 */
export function canDeleteCatalogItem(
  isSystemAdmin: boolean,
  role: "MEMBER" | "LEADER" | null | undefined,
): boolean {
  return isSystemAdmin || role === "LEADER";
}

export function describeCreateProjectError(error: unknown): string {
  if (error instanceof ApiError) {
    // 编码冲突是唯一可自助修复的 409，先说清是哪一项冲突（服务端 PROJECT_CODE_CONFLICT）。
    if (error.code === "PROJECT_CODE_CONFLICT") {
      return "项目编码已被占用，请更换项目编码后重试。";
    }
    switch (error.status) {
      case 401:
        return SESSION_EXPIRED_MESSAGE;
      case 403:
        return "安全校验未通过，请刷新页面后重试。";
      case 409:
        return "项目编码已存在或创建请求发生冲突，请刷新后重试。";
      case 422:
        return "项目名称、编码或描述格式不正确，请检查后重试。";
      case 429:
        return "创建项目请求过于频繁，请稍后重试。";
      default:
        return "项目创建暂时失败，请稍后重试。";
    }
  }
  return "项目创建暂时失败，请稍后重试。";
}

export function useCreateProject({ client }: ProjectMutationOptions = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CreateProjectRequest) => {
      const csrf = await apiClient.issueCsrfToken();
      return apiClient.createProject(request, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": createIdempotencyKey("create-project"),
        },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

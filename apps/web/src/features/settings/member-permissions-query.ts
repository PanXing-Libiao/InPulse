import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type ProjectMemberPermissions,
  type ProjectMemberPermissionsUpdateRequest,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

export const PROJECT_MEMBER_PERMISSIONS_QUERY_KEY = [
  "project-member-permissions",
] as const;

export interface SaveProjectMemberPermissionsInput {
  readonly values: ProjectMemberPermissionsUpdateRequest;
  readonly expectedRowVersion: number;
}

export function projectMemberPermissionsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "只有系统管理员可以保存全平台权限配置。";
    if (error.status === 409)
      return "权限配置已被其他管理员更新，请重新加载最新版本后再保存。";
    if (error.status === 422) return "请检查全部权限档位后重新保存。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 503) return "服务暂时不可用，请稍后重试。";
    if (error.code === "PROJECT_MEMBER_PERMISSION_CONFIG_MISSING")
      return "权限配置缺失，请检查数据库迁移是否已执行。";
  }
  return "全平台权限配置服务暂时不可用，请重试。";
}

/**
 * ADR-104 全平台项目成员权限数据层。GET 由所有已登录账号读取；PUT 仅系统
 * 管理员可保存，并携带同步 CSRF、If-Match 和数据库级幂等键。同一失败请求
 * 的自动或人工重试复用幂等键，内容或版本变化后换用新键。
 */
export function useProjectMemberPermissions(
  client?: InpulseApiClient,
  enabled = true,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);

  const query = useQuery({
    queryKey: PROJECT_MEMBER_PERMISSIONS_QUERY_KEY,
    queryFn: ({ signal }) => api.getProjectMemberPermissions({ signal }),
    enabled,
    retry: false,
    staleTime: 0,
  });

  const save = useMutation({
    retry: false,
    mutationFn: async (
      input: SaveProjectMemberPermissionsInput,
    ): Promise<ProjectMemberPermissions> => {
      const signature = JSON.stringify(input);
      if (retryKey.current?.signature !== signature) {
        retryKey.current = {
          signature,
          key: createIdempotencyKey("project-member-permissions"),
        };
      }
      const csrf = await api.issueCsrfToken();
      return api.updateProjectMemberPermissions(input.values, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retryKey.current.key,
          "If-Match": `"${input.expectedRowVersion}"`,
        },
      });
    },
    onSuccess: async (settings) => {
      retryKey.current = null;
      cache.setQueryData(PROJECT_MEMBER_PERMISSIONS_QUERY_KEY, settings);
      await cache.invalidateQueries({
        queryKey: PROJECT_MEMBER_PERMISSIONS_QUERY_KEY,
      });
    },
  });

  return { query, save };
}

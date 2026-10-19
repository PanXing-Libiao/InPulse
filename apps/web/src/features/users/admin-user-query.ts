import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type AdminUserItem,
  type AdminUserUpdateRequest,
  type InpulseApiClient,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";

export type AdminUserChange =
  | {
      readonly action: "update";
      readonly user: AdminUserItem;
      readonly body: AdminUserUpdateRequest;
    }
  | {
      readonly action: "disable" | "enable" | "forceLogout" | "delete";
      readonly user: AdminUserItem;
    };

export function adminUserErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录。";
    if (error.status === 403) return "你没有执行用户管理操作的权限。";
    if (error.status === 404) return "用户不存在，或当前账号无权查看。";
    if (error.status === 409) {
      if (error.code === "ADMIN_USER_VERSION_CONFLICT")
        return "用户信息已在其他窗口被修改，请加载最新版本后重试。";
      if (error.code === "ADMIN_USER_SELF_MUTATION_REJECTED")
        return "不能对当前管理员自己执行停用、降级、删除或强制退出。";
      if (error.code === "ADMIN_USER_LOGIN_CONFLICT")
        return "登录名已存在，请更换后重试。";
      if (error.code === "ADMIN_USER_EMAIL_CONFLICT")
        return "邮箱已被使用，请更换后重试。";
      if (error.code === "ADMIN_USER_ACTIVE_PROJECT_MEMBERSHIP")
        return "该用户仍是项目活跃成员，请先转移组长身份并把账号移出全部项目。";
      if (error.code === "LAST_ACTIVE_ADMIN_REQUIRED")
        return "不能停用、降级或移除最后一名可用管理员，请先指定其他管理员。";
      return "用户当前状态不允许此操作，请检查列表后重试。";
    }
    if (error.status === 422) return "请检查姓名或邮箱。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "用户管理服务暂时不可用，请重试。";
}

function mutationHeaders(
  change: AdminUserChange,
  csrfToken: string,
  idempotencyKey: string,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    "x-csrf-token": csrfToken,
    "Idempotency-Key": idempotencyKey,
  };
  if ("user" in change) {
    headers["If-Match"] = `"${change.user.rowVersion}"`;
  }
  return headers;
}

export function useAdminUserDirectoryQuery(
  client?: InpulseApiClient,
  options: { readonly enabled?: boolean } = {},
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["admin-users"],
    queryFn: ({ signal }) => api.listAdminUsers({ signal }),
    retry: false,
    enabled: options.enabled ?? true,
  });
}

export function useAdminUsers(
  client?: InpulseApiClient,
  options: { readonly enabled?: boolean } = {},
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);

  const query = useAdminUserDirectoryQuery(client, options);

  const mutation = useMutation({
    retry: false,
    mutationFn: async (change: AdminUserChange) => {
      const user = "user" in change ? change.user : undefined;
      const body = "body" in change ? change.body : undefined;
      const signature = JSON.stringify([
        change.action,
        user?.id,
        user?.rowVersion,
        body ?? null,
      ]);
      if (retryKey.current?.signature !== signature) {
        retryKey.current = {
          signature,
          key: createIdempotencyKey("admin-user"),
        };
      }
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: mutationHeaders(change, csrf.csrfToken, retryKey.current.key),
      };
      if (change.action === "update")
        return api.updateUser(change.user.id, change.body, init);
      if (change.action === "disable")
        return api.disableUser(change.user.id, init);
      if (change.action === "enable")
        return api.enableUser(change.user.id, init);
      if (change.action === "delete")
        return api.deleteUser(change.user.id, init);
      return api.forceLogoutUser(change.user.id, init);
    },
    onSuccess: async () => {
      retryKey.current = null;
      await cache.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return { query, mutation };
}

import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type AdminUserDisableRequest,
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
      readonly action: "disable";
      readonly user: AdminUserItem;
      readonly body: AdminUserDisableRequest;
    }
  | {
      readonly action: "enable" | "delete";
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
        return "不能对当前管理员自己执行停用、降级或删除。";
      if (error.code === "ADMIN_USER_OFFBOARDING_TASK_REQUIRED")
        return "还有仅该账号负责的任务未处理，请指定接手人或删除任务。";
      if (error.code === "ADMIN_USER_OFFBOARDING_VERSION_CONFLICT")
        return "任务已在其他窗口被修改，请关闭弹窗后重新打开再处理。";
      if (error.code === "ADMIN_USER_OFFBOARDING_INCOMPLETE")
        return "交接尚未完成，请刷新任务清单后重试。";
      if (error.code === "ADMIN_USER_OFFBOARDING_TASK_NOT_FOUND")
        return "待交接任务不存在或已归属他人，请刷新后重试。";
      if (error.code === "ADMIN_USER_OFFBOARDING_SELF_ASSIGNEE")
        return "不能把待停用账号继续设为接手人。";
      if (error.code === "ADMIN_USER_OFFBOARDING_DELETE_NOT_ALLOWED")
        return "只有唯一负责人任务可以删除；多负责人任务请保留其他人继续负责。";
      if (error.code === "TASK_GROUP_MAIN_LOCKED")
        return "该任务是任务组主任务，请先解除合并后再删除。";
      if (error.code === "TASK_ASSIGNEE_INVALID")
        return "接手人不在项目成员中或已停用，请重新选择。";
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
    if (error.status === 422) {
      if (error.code === "PROJECT_MEMBER_REASSIGNMENT_REQUIRED")
        return "该任务没有其他负责人，必须指定接手人或删除任务。";
      return "请检查姓名、邮箱或任务交接设置。";
    }
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
        return api.disableUser(change.user.id, change.body, init);
      if (change.action === "enable")
        return api.enableUser(change.user.id, init);
      return api.deleteUser(change.user.id, init);
    },
    onSuccess: async () => {
      retryKey.current = null;
      await cache.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return { query, mutation };
}

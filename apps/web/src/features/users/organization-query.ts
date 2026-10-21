import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type OrganizationItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/** ADR-081 组织操作的统一错误文案。 */
export function organizationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "你没有执行组织管理操作的权限。";
    if (error.status === 404) return "组织不存在，或已被删除。";
    if (error.status === 409) {
      if (error.code === "ORGANIZATION_NAME_CONFLICT")
        return "组织名称已存在，请更换后重试。";
      if (error.code === "ORGANIZATION_VERSION_CONFLICT")
        return "组织已在其他窗口被修改，请刷新后重试。";
      return "组织当前状态不允许此操作，请刷新后重试。";
    }
    if (error.status === 422) return "请检查组织名称或成员选择。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "组织服务暂时不可用，请重试。";
}

/** 普通成员只读视图：自己所属组织与同组织成员（脱敏字段）。 */
export function useMyOrganizationMembers(
  client?: InpulseApiClient,
  options: { readonly enabled?: boolean } = {},
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["my-organization-members"],
    queryFn: ({ signal }) => api.getMyOrganizationMembers({ signal }),
    retry: false,
    enabled: options.enabled ?? true,
  });
}

/** 管理员组织列表；组织成员数由成员列表聚合，不新增接口。 */
export function useOrganizations(
  client?: InpulseApiClient,
  options: { readonly enabled?: boolean } = {},
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["organizations"],
    queryFn: ({ signal }) => api.listOrganizations({ signal }),
    retry: false,
    enabled: options.enabled ?? true,
  });
}

export type OrganizationChange =
  | { readonly action: "create"; readonly name: string }
  | {
      readonly action: "rename";
      readonly organization: OrganizationItem;
      readonly name: string;
    }
  | { readonly action: "delete"; readonly organization: OrganizationItem }
  | {
      readonly action: "assign";
      readonly userIds: readonly number[];
      readonly organizationId: number | null;
    };

/**
 * 组织写操作统一入口：先签发 CSRF Token，再按操作携带 If-Match 与
 * Idempotency-Key；成功后联动刷新组织与成员列表。
 */
export function useOrganizationMutations(
  client?: InpulseApiClient,
  onSuccess?: () => void,
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);

  const mutation = useMutation({
    retry: false,
    mutationFn: async (change: OrganizationChange) => {
      const signature = JSON.stringify(change);
      if (retryKey.current?.signature !== signature) {
        retryKey.current = {
          signature,
          key: createIdempotencyKey("organization"),
        };
      }
      const csrf = await api.issueCsrfToken();
      const headers: Record<string, string> = {
        "x-csrf-token": csrf.csrfToken,
        "Idempotency-Key": retryKey.current.key,
      };
      if (change.action === "create") {
        return api.createOrganization({ name: change.name }, { headers });
      }
      if (change.action === "rename") {
        return api.updateOrganization(
          change.organization.id,
          { name: change.name },
          {
            headers: {
              ...headers,
              "If-Match": JSON.stringify(
                String(change.organization.rowVersion),
              ),
            },
          },
        );
      }
      if (change.action === "delete") {
        return api.deleteOrganization(change.organization.id, {
          headers: {
            ...headers,
            "If-Match": JSON.stringify(String(change.organization.rowVersion)),
          },
        });
      }
      return api.assignUsersOrganization(
        { userIds: [...change.userIds], organizationId: change.organizationId },
        { headers },
      );
    },
    onSuccess: async () => {
      retryKey.current = null;
      await cache.invalidateQueries({ queryKey: ["organizations"] });
      await cache.invalidateQueries({ queryKey: ["admin-users"] });
      await cache.invalidateQueries({ queryKey: ["my-organization-members"] });
      onSuccess?.();
    },
  });

  return mutation;
}

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createApiClient,
  type InpulseApiClient,
  type NotificationPreferences,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";

export interface NotificationPreferencesQueryOptions {
  readonly client?: InpulseApiClient | undefined;
  readonly enabled?: boolean;
}

/** 当前登录账号的个人通知偏好；服务端保存，跨浏览器与设备一致。 */
export function useNotificationPreferences({
  client,
  enabled = true,
}: NotificationPreferencesQueryOptions = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["notification-preferences"],
    queryFn: () => apiClient.getNotificationPreferences(),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * 整组替换个人通知偏好。切换时先乐观更新，失败回滚；成功后刷新偏好、
 * 通知列表与未读数，让关闭/开启立即反映到实际投递结果。
 */
export function useUpdateNotificationPreferences({
  client,
}: NotificationPreferencesQueryOptions = {}) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      disabledSettings: NotificationPreferences["disabledSettings"],
    ) => {
      const csrf = await apiClient.issueCsrfToken();
      return apiClient.updateNotificationPreferences(
        { disabledSettings },
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "Idempotency-Key": createIdempotencyKey("notification-preferences"),
          },
        },
      );
    },
    onMutate: async (disabledSettings) => {
      await queryClient.cancelQueries({
        queryKey: ["notification-preferences"],
      });
      const previous = queryClient.getQueryData<NotificationPreferences>([
        "notification-preferences",
      ]);
      queryClient.setQueryData<NotificationPreferences>(
        ["notification-preferences"],
        { disabledSettings },
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(
          ["notification-preferences"],
          context.previous,
        );
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["notification-preferences"],
      });
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

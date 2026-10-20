import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import {
  readMutedProjectCategoriesQuery,
  subscribeProjectNotificationPolicy,
} from "@shared/notifications/project-notification-policy";

export const NOTIFICATION_PAGE_LIMIT = 20;
export const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

export type NotificationFilter = "all" | "unread";

export type NotificationAction =
  | { readonly kind: "read"; readonly notificationId: number }
  | { readonly kind: "unread"; readonly notificationId: number }
  | { readonly kind: "readAll" };

export interface NotificationQueryOptions {
  readonly client?: InpulseApiClient | undefined;
  readonly enabled?: boolean;
  readonly limit?: number;
}

export interface NotificationListOptions extends NotificationQueryOptions {
  readonly filter: NotificationFilter;
}

export function describeNotificationError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "登录状态已失效，请重新登录后再查看通知。";
    }
    if (error.status === 404) {
      return "通知不存在或已不可访问。";
    }
    if (error.status === 409) {
      return "通知状态已变化或请求已被其他操作占用，请刷新后重试。";
    }
  }
  return "通知服务暂时不可用，请稍后重试。";
}

/**
 * 当前浏览器里被项目群通知选项关闭的类别，序列化为 projectId:category。
 * 项目页写入后立即更新，通知列表、未读数和红点会在同一帧内改用新参数。
 */
export function useMutedProjectCategoriesQuery(): string | undefined {
  const [muted, setMuted] = useState(() => readMutedProjectCategoriesQuery());
  useEffect(
    () =>
      subscribeProjectNotificationPolicy(() => {
        setMuted(readMutedProjectCategoriesQuery());
      }),
    [],
  );
  return muted;
}

export function useNotificationUnreadCount({
  client,
  enabled = true,
}: NotificationQueryOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const mutedProjectCategories = useMutedProjectCategoriesQuery();
  return useQuery({
    queryKey: ["notifications", "unread-count", mutedProjectCategories ?? null],
    queryFn: async () => {
      const result = await apiClient.getNotificationUnreadCount(
        mutedProjectCategories === undefined ? {} : { mutedProjectCategories },
      );
      return result.unreadCount;
    },
    enabled,
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
    staleTime: NOTIFICATION_POLL_INTERVAL_MS / 2,
  });
}

export function useNotificationsInfiniteQuery({
  client,
  filter,
  enabled = true,
  limit = NOTIFICATION_PAGE_LIMIT,
}: NotificationListOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const mutedProjectCategories = useMutedProjectCategoriesQuery();
  return useInfiniteQuery({
    queryKey: [
      "notifications",
      "list",
      filter,
      limit,
      mutedProjectCategories ?? null,
    ],
    queryFn: ({ pageParam, signal }) =>
      apiClient.getNotifications(
        {
          ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
          ...(filter === "unread" ? { unreadOnly: true } : {}),
          ...(mutedProjectCategories === undefined
            ? {}
            : { mutedProjectCategories }),
          limit,
        },
        signal ? { signal } : undefined,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled,
  });
}

export function useNotificationActions({ client }: NotificationQueryOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (action: NotificationAction) => {
      const csrf = await apiClient.issueCsrfToken();
      const headers = {
        "x-csrf-token": csrf.csrfToken,
        "Idempotency-Key": createIdempotencyKey("notification-" + action.kind),
      };
      if (action.kind === "read") {
        await apiClient.readNotification(action.notificationId, { headers });
        return;
      }
      if (action.kind === "unread") {
        await apiClient.unreadNotification(action.notificationId, { headers });
        return;
      }
      await apiClient.readAllNotifications({ headers });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

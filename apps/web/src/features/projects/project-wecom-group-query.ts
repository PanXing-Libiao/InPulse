import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type ProjectWecomGroupNotificationOptions,
  type ProjectWecomGroupStatus,
  type ProjectWecomWebhookCreateRequest,
  type ProjectWecomWebhookTarget,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * ADR-106 项目企微群 Webhook 数据层：GET 读取 UNBOUND / BOUND；
 * PUT 保存项目群五类通知开关（先签发 CSRF，再携带一次性 Idempotency-Key）；
 * POST / DELETE 管理项目 Webhook 目标。所有请求都经生成客户端，组件不裸写 fetch。
 * 项目群能力默认由组长 / 系统管理员持有，普通成员只读；个人机器人绑定使用设置页
 * 的独立数据层，不经过本文件。
 */
export const projectWecomGroupQueryKey = (projectId: number) =>
  ["project-wecom-group", projectId] as const;

export function projectWecomGroupErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403)
      return "只有项目组长或系统管理员可以管理企业微信项目群。";
    if (error.status === 404) {
      // 服务端没部署这条路由时，框架兜底 404 的 code 是 NOT_FOUND；业务侧
      // 「项目不存在 / 已不是成员」是 PROJECT_WECOM_GROUP_NOT_FOUND。2026-10-16 实测踩坑：
      // dev API 是旧进程，卡片把「功能还没上线」说成了「你已不是项目成员」，
      // 让用户误以为自己的成员关系出了问题。
      if (error.code === "NOT_FOUND")
        return "当前服务还没有企业微信项目群功能，请让管理员更新后端服务后重试。";
      return "项目不存在或你已不是项目成员。";
    }
    if (error.status === 409) {
      if (error.code === "PROJECT_WECOM_WEBHOOK_ALREADY_BOUND")
        return "这个 Webhook 已经绑定到活跃项目目标，不能重复添加。";
      if (error.code === "PROJECT_WECOM_WEBHOOK_LIMIT_REACHED")
        return "单个项目最多绑定 20 个 Webhook 目标，请先删除不再使用的目标。";
      return "该请求与先前的操作冲突，请刷新页面后重试。";
    }
    if (error.status === 422) {
      if (error.code === "PROJECT_WECOM_WEBHOOK_URL_INVALID")
        return "Webhook 地址必须是企业微信官方群机器人地址，并包含一个合法 key。";
      return "请求参数校验失败，请刷新页面后重试。";
    }
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 503) return "服务暂时不可用，请稍后重试。";
  }
  return "企业微信项目群服务暂时不可用，请重试。";
}

export async function requestProjectWecomWebhookCreation(
  api: InpulseApiClient,
  projectId: number,
  input: ProjectWecomWebhookCreateRequest,
): Promise<ProjectWecomWebhookTarget> {
  const key = createIdempotencyKey("pwg-webhook-create");
  const csrf = await api.issueCsrfToken();
  return api.createProjectWecomWebhook(projectId, input, {
    headers: {
      "x-csrf-token": csrf.csrfToken,
      "Idempotency-Key": key,
    },
  });
}

/** 新建项目成功后的可选 Webhook 接入；项目已有独立事务，此处只追加目标。 */
export function useCreateProjectWecomWebhook(client?: InpulseApiClient) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: ({
      projectId,
      input,
    }: {
      readonly projectId: number;
      readonly input: ProjectWecomWebhookCreateRequest;
    }): Promise<ProjectWecomWebhookTarget> =>
      requestProjectWecomWebhookCreation(api, projectId, input),
    onSuccess: async (_target, variables) => {
      await cache.invalidateQueries({
        queryKey: projectWecomGroupQueryKey(variables.projectId),
      });
    },
  });
}

export function useProjectWecomGroup(
  projectId: number,
  client?: InpulseApiClient,
  options: { readonly enabled?: boolean } = {},
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const enabled = options.enabled ?? true;

  const query = useQuery({
    queryKey: projectWecomGroupQueryKey(projectId),
    queryFn: ({ signal }): Promise<ProjectWecomGroupStatus> =>
      api.getProjectWecomGroup(projectId, { signal }),
    enabled,
    retry: false,
  });

  const createWebhook = useMutation({
    retry: false,
    mutationFn: (input: ProjectWecomWebhookCreateRequest) =>
      requestProjectWecomWebhookCreation(api, projectId, input),
    onSuccess: async () => {
      await cache.invalidateQueries({
        queryKey: projectWecomGroupQueryKey(projectId),
      });
    },
  });

  const deleteWebhook = useMutation({
    retry: false,
    mutationFn: async (bindingId: number): Promise<void> => {
      const key = createIdempotencyKey("pwg-webhook-delete");
      const csrf = await api.issueCsrfToken();
      await api.deleteProjectWecomWebhook(projectId, bindingId, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": key,
        },
      });
    },
    onSuccess: async () => {
      await cache.invalidateQueries({
        queryKey: projectWecomGroupQueryKey(projectId),
      });
    },
  });

  const updateNotificationOptions = useMutation({
    retry: false,
    mutationFn: async (
      options: ProjectWecomGroupNotificationOptions,
    ): Promise<ProjectWecomGroupNotificationOptions> => {
      // 每次切换都是一个新意图，不复用旧 Key，避免旧响应掩盖期间的变化。
      const key = createIdempotencyKey("pwg-notification-options");
      const csrf = await api.issueCsrfToken();
      return api.updateProjectWecomGroupNotificationOptions(
        projectId,
        options,
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "Idempotency-Key": key,
          },
        },
      );
    },
    onSuccess: (options) => {
      cache.setQueryData<ProjectWecomGroupStatus>(
        projectWecomGroupQueryKey(projectId),
        (current) =>
          current === undefined
            ? current
            : { ...current, notificationOptions: options },
      );
    },
  });

  return {
    query,
    updateNotificationOptions,
    createWebhook,
    deleteWebhook,
  };
}

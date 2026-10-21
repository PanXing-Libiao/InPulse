import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type ProjectWecomGroupCode,
  type ProjectWecomGroupNotificationOptions,
  type ProjectWecomGroupStatus,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * ADR-077 项目企微群绑定数据层：GET 读取三态（UNBOUND / PENDING / BOUND）；
 * POST 签发一次性绑定码（securityFlow：只签发 CSRF、重新生成立即作废旧码）；
 * PUT 保存项目群通知开关（先签发 CSRF，再携带一次性 Idempotency-Key）；
 * DELETE 解绑。所有请求都经生成客户端，组件不裸写 fetch。签发、保存与解绑的
 * 服务端门禁是组长 / 系统管理员，普通成员只读。
 */
export const projectWecomGroupQueryKey = (projectId: number) =>
  ["project-wecom-group", projectId] as const;

/** 存在待用绑定码时的轮询间隔：群里发送绑定码后自动发现「已绑定」。 */
const PENDING_POLL_INTERVAL_MS = 5000;

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
    if (error.status === 409)
      return "该请求与先前的操作冲突，请刷新页面后重试。";
    if (error.status === 422) return "请求参数校验失败，请刷新页面后重试。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 503) return "服务暂时不可用，请稍后重试。";
  }
  return "企业微信项目群服务暂时不可用，请重试。";
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
    refetchInterval: (current) =>
      current.state.data?.state === "PENDING"
        ? PENDING_POLL_INTERVAL_MS
        : false,
  });

  const issueCode = useMutation({
    retry: false,
    mutationFn: async (): Promise<ProjectWecomGroupCode> => {
      const csrf = await api.issueCsrfToken();
      return api.createProjectWecomGroupCode(projectId, {
        headers: { "x-csrf-token": csrf.csrfToken },
      });
    },
    onSuccess: async () => {
      await cache.invalidateQueries({
        queryKey: projectWecomGroupQueryKey(projectId),
      });
    },
  });

  const unbind = useMutation({
    retry: false,
    mutationFn: async (): Promise<void> => {
      // DELETE 重复执行结果一致；每次点击使用新的 Idempotency-Key，不跨点击
      // 复用，避免重放旧的成功结果掩盖期间的重新绑定。
      const key = createIdempotencyKey("pwg-unbind");
      const csrf = await api.issueCsrfToken();
      await api.deleteProjectWecomGroup(projectId, {
        headers: { "x-csrf-token": csrf.csrfToken, "Idempotency-Key": key },
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

  return { query, issueCode, updateNotificationOptions, unbind };
}

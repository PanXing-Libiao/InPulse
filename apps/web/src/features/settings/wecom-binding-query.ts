import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type WecomBindingCode,
  type WecomBindingStatus,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * ADR-069 个人企微机器人绑定数据层：GET 读取三态状态；POST 签发一次性绑定
 * 码（securityFlow：只签发 CSRF、不进入通用幂等记录，重新生成会立即作废
 * 旧码）；DELETE 解除绑定（先签发 CSRF，再携带一次性 Idempotency-Key）。
 * 所有请求都经生成客户端，组件不裸写 fetch。
 */
export const WECOM_BINDING_QUERY_KEY = ["wecom-binding"] as const;

/** 存在待用绑定码时的轮询间隔：用户在企微发送绑定码后自动发现「已绑定」。 */
const PENDING_POLL_INTERVAL_MS = 5000;

export function wecomBindingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403)
      return "当前请求未通过同源校验，请刷新页面后重试。";
    if (error.status === 409)
      return "该请求与先前的操作冲突，请刷新页面后重试。";
    if (error.status === 422) return "请求参数校验失败，请刷新页面后重试。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 503) return "服务暂时不可用，请稍后重试。";
  }
  return "企业微信绑定服务暂时不可用，请重试。";
}

export function useWecomBinding(
  client?: InpulseApiClient,
  options: { readonly enabled?: boolean } = {},
) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const enabled = options.enabled ?? true;

  const query = useQuery({
    queryKey: WECOM_BINDING_QUERY_KEY,
    queryFn: ({ signal }): Promise<WecomBindingStatus> =>
      api.getWecomBinding({ signal }),
    enabled,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.state === "PENDING"
        ? PENDING_POLL_INTERVAL_MS
        : false,
  });

  const issueCode = useMutation({
    retry: false,
    mutationFn: async (): Promise<WecomBindingCode> => {
      const csrf = await api.issueCsrfToken();
      return api.createWecomBindingCode({
        headers: { "x-csrf-token": csrf.csrfToken },
      });
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: WECOM_BINDING_QUERY_KEY });
    },
  });

  const unbind = useMutation({
    retry: false,
    mutationFn: async (): Promise<void> => {
      // DELETE 重复执行结果一致；每次点击使用新的 Idempotency-Key，不跨点击
      // 复用，避免重放旧的成功结果掩盖期间的重新绑定。
      const key = createIdempotencyKey("wecom-unbind");
      const csrf = await api.issueCsrfToken();
      await api.deleteWecomBinding({
        headers: { "x-csrf-token": csrf.csrfToken, "Idempotency-Key": key },
      });
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: WECOM_BINDING_QUERY_KEY });
    },
  });

  return { query, issueCode, unbind };
}

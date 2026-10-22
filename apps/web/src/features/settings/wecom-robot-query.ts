import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type WecomRobotConfigUpdateRequest,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import {
  SESSION_EXPIRED_MESSAGE,
  SERVICE_NOT_CONFIGURED_MESSAGE,
} from "@shared/api/request-messages";

/**
 * ADR-070 管理员企业微信机器人配置数据层：GET 读取当前配置与可用状态；
 * PUT 先签发 CSRF Token 再携带一次性 Idempotency-Key 保存（secret 留空
 * 表示保持已存密钥）。所有请求都经生成客户端，组件不裸写 fetch。
 */
export const WECOM_ROBOT_QUERY_KEY = ["wecom-robot-config"] as const;

export function wecomRobotErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403)
      return "只有系统管理员可以查看或修改企业微信机器人配置。";
    if (error.code === "WECOM_ROBOT_CONFIG_KEY_UNAVAILABLE")
      return SERVICE_NOT_CONFIGURED_MESSAGE;
    if (error.status === 409)
      return "该保存请求与先前提交冲突，请刷新页面后按最新状态重试。";
    if (error.status === 422) return "请检查 botId 与 Secret 字段。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 503) return "服务暂时不可用，请稍后重试。";
  }
  return "企业微信机器人配置服务暂时不可用，请重试。";
}

const DISABLED_REASON_TEXT: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: "尚未配置机器人",
  ENCRYPTION_KEY_UNAVAILABLE: "服务器缺少密钥加密主密钥，Secret 不可读取",
  CONFIG_INVALID: "已存配置无法解密，请重新保存 Secret",
};

export function wecomRobotDisabledReasonText(reason: string | null): string {
  if (reason === null) return "已配置，桥接可用";
  return DISABLED_REASON_TEXT[reason] ?? "当前不可用";
}

export function useWecomRobotConfig(client?: InpulseApiClient) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);

  const query = useQuery({
    queryKey: WECOM_ROBOT_QUERY_KEY,
    queryFn: ({ signal }) => api.getWecomRobotConfig({ signal }),
    retry: false,
    staleTime: 30_000,
  });

  const save = useMutation({
    retry: false,
    mutationFn: async (body: WecomRobotConfigUpdateRequest) => {
      const signature = JSON.stringify(body);
      if (retryKey.current?.signature !== signature) {
        retryKey.current = {
          signature,
          key: createIdempotencyKey("wecom-robot"),
        };
      }
      const csrf = await api.issueCsrfToken();
      return api.updateWecomRobotConfig(body, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retryKey.current.key,
        },
      });
    },
    onSuccess: async () => {
      retryKey.current = null;
      await cache.invalidateQueries({ queryKey: WECOM_ROBOT_QUERY_KEY });
    },
  });

  return { query, save };
}

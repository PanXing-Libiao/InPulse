import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type AiAssistSettingsTestResponse,
  type AiAssistSettingsUpdateRequest,
  type InpulseApiClient,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import {
  SESSION_EXPIRED_MESSAGE,
  SERVICE_NOT_CONFIGURED_MESSAGE,
} from "@shared/api/request-messages";

/**
 * ADR-068 管理员 AI 辅助转换配置数据层：GET 读取当前生效状态；PUT 先签发
 * CSRF Token 再携带一次性 Idempotency-Key 保存；POST test 只做上游探测，
 * 不写任何持久化状态。所有请求都经生成客户端，组件不裸写 fetch。
 */
export const AI_ASSIST_SETTINGS_QUERY_KEY = ["ai-assist-settings"] as const;

export function aiAssistSettingsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403)
      return "只有系统管理员可以查看或修改 AI 辅助转换配置。";
    if (error.code === "AI_ASSIST_SETTINGS_KEY_UNAVAILABLE")
      return SERVICE_NOT_CONFIGURED_MESSAGE;
    if (error.status === 409)
      return "该保存请求与先前提交冲突，请刷新页面后按最新状态重试。";
    if (error.status === 422) return "请检查端点、模型、超时与最大输出字段。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
    if (error.status === 503) return "服务暂时不可用，请稍后重试。";
  }
  return "AI 辅助转换配置服务暂时不可用，请重试。";
}

const DISABLED_REASON_TEXT: Readonly<Record<string, string>> = {
  KILL_SWITCH: "已被急停开关关闭（AI_ASSIST_ENABLED 显式为非真值）",
  NOT_ENABLED: "当前未启用",
  CONFIG_INVALID: "配置无效，已按保护策略关闭",
  ENCRYPTION_KEY_UNAVAILABLE: "服务器缺少密钥加密主密钥，密钥不可读取",
};

export function aiAssistDisabledReasonText(reason: string | null): string {
  if (reason === null) return "运行中";
  return DISABLED_REASON_TEXT[reason] ?? "当前不可用";
}

const TEST_REASON_TEXT: Readonly<Record<string, string>> = {
  KILL_SWITCH: "被急停开关关闭，未发起探测",
  NOT_ENABLED: "尚未启用，未发起探测",
  CONFIG_INVALID: "当前配置无效，未发起探测",
  ENCRYPTION_KEY_UNAVAILABLE: "服务器缺少密钥加密主密钥，未发起探测",
  AUTH: "上游鉴权失败，请检查 API 密钥",
  RATE_LIMITED: "上游限流，请稍后重试",
  TIMEOUT: "上游响应超时，请检查端点或网络",
  NETWORK: "无法连接上游端点（网络故障）",
  CONTEXT_LIMIT: "上游判定请求超出上下文限制",
  INVALID_RESPONSE:
    "上游返回了无法识别的内容（请确认服务端点指向 OpenAI 兼容的 chat/completions 服务）",
};

export function aiAssistTestFailureText(reason: string): string {
  return TEST_REASON_TEXT[reason] ?? "测试连接失败，请检查配置";
}

export function useAiAssistSettings(client?: InpulseApiClient) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKey = useRef<{ signature: string; key: string } | null>(null);

  const query = useQuery({
    queryKey: AI_ASSIST_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => api.getAiAssistSettings({ signal }),
    retry: false,
  });

  const save = useMutation({
    retry: false,
    mutationFn: async (body: AiAssistSettingsUpdateRequest) => {
      const signature = JSON.stringify(body);
      if (retryKey.current?.signature !== signature) {
        retryKey.current = {
          signature,
          key: createIdempotencyKey("ai-assist-settings"),
        };
      }
      const csrf = await api.issueCsrfToken();
      return api.updateAiAssistSettings(body, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retryKey.current.key,
        },
      });
    },
    onSuccess: (settings) => {
      retryKey.current = null;
      cache.setQueryData(AI_ASSIST_SETTINGS_QUERY_KEY, settings);
    },
  });

  const test = useMutation({
    retry: false,
    mutationFn: (): Promise<AiAssistSettingsTestResponse> =>
      api.testAiAssistSettings(),
  });

  return { query, save, test };
}

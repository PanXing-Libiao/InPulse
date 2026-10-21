import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type RecordSummaryAssistResponse,
} from "@generated/api";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * ADR-076 迭代总结 AI 改写数据层：POST /record-summaries/assist。
 *
 * 纯校验接口（无 CSRF、无幂等、无持久化副作用）：只把用户自己已经看到的总结
 * 正文按一句话要求交给服务端改写。与 ADR-067 的文档导入辅助转换同族——请求体
 * 不携带任何文件、Cookie 由生成客户端附带，组件层不裸写 fetch。
 */
export interface RecordSummaryAssistInput {
  /** 一句话要求（给谁看、突出什么、篇幅多长），不展开为多轮对话。 */
  readonly requirement: string;
  /** 当前筛选范围下已生成的事实正文全文。 */
  readonly facts: string;
}

export interface RecordSummaryAssistOptions {
  readonly client?: InpulseApiClient | undefined;
}

export function useAssistRecordSummary({ client }: RecordSummaryAssistOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  return useMutation({
    mutationFn: (
      input: RecordSummaryAssistInput,
    ): Promise<RecordSummaryAssistResponse> =>
      apiClient.assistRecordSummary({
        requirement: input.requirement,
        facts: input.facts,
      }),
  });
}

/**
 * 与 ADR-067 同口径的上游失败归类；文案按「总结」场景写，不改文档导入那边的提示
 * （两处提示各自面向自己的界面，共用一张表会把措辞拧在一起）。
 */
const SUMMARY_ASSIST_REASON_MESSAGES: Readonly<Record<string, string>> = {
  auth: "AI 服务鉴权失败，请管理员在「成员与设置 → AI 辅助转换」中检查 API 密钥。",
  "rate-limited": "AI 服务请求过于频繁（上游限流），请稍后重试。",
  timeout: "AI 服务响应超时，请稍后重试或缩小总结范围。",
  network: "无法连接 AI 服务（网络故障），请稍后重试。",
  "context-limit": "总结正文超出模型长度上限，请缩小时间范围后重试。",
  "invalid-response": "AI 服务返回了无法识别的内容，请稍后重试。",
};

/** ADR-076 固定错误码 → 固定中文提示；上游细节只通过 reason 归类，不下发原文。 */
export function describeRecordSummaryAssistError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "AI_ASSIST_DISABLED":
        return "AI 辅助转换未启用或配置无效，请管理员在「成员与设置 → AI 辅助转换」中配置后重试。";
      case "AI_ASSIST_UPSTREAM_FAILED": {
        const reason = error.details["reason"];
        if (
          typeof reason === "string" &&
          reason in SUMMARY_ASSIST_REASON_MESSAGES
        ) {
          return (
            SUMMARY_ASSIST_REASON_MESSAGES[reason] ??
            "AI 服务暂时不可用，请稍后重试。"
          );
        }
        return "AI 服务暂时不可用，请稍后重试。";
      }
      default:
        break;
    }
    switch (error.status) {
      case 401:
        return SESSION_EXPIRED_MESSAGE;
      case 400:
      case 422:
        return "要求或总结正文不符合格式，请检查后重试。";
      default:
        return "AI 改写暂时失败，请稍后重试。";
    }
  }
  return "AI 改写暂时失败，请稍后重试。";
}

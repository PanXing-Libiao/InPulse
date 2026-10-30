import { Logger } from "@nestjs/common";

import type { AiAssistConfig } from "./ai-assist.config.js";
import type { AiAssistImage } from "@inpulse/api-contract";

import type { AiAssistTarget } from "./ai-assist-target.js";
import {
  buildAiAssistMessages,
  type DocumentImportAssistMode,
} from "./ai-assist.prompt.js";
import { buildRecordSummaryAssistMessages } from "./record-summary-assist.prompt.js";
import {
  buildTaskDraftAssistMessages,
  TASK_DRAFT_ASSIST_MAX_OUTPUT_TOKENS,
  type TaskDraftAssistPromptInput,
} from "./task-draft-assist.prompt.js";

/** ADR-067 的固定上游失败分类：仅进入 details.reason，不泄露上游细节。 */
export type AiAssistFailureReason =
  | "auth"
  | "rate-limited"
  | "timeout"
  | "network"
  | "context-limit"
  | "invalid-response";

/** 上游调用失败；HTTP 层统一映射 503 AI_ASSIST_UPSTREAM_FAILED + 固定 reason。 */
export class AiAssistUpstreamError extends Error {
  constructor(readonly reason: AiAssistFailureReason) {
    super(`AI assist upstream failure: ${reason}`);
    this.name = "AiAssistUpstreamError";
  }
}

/**
 * 出站调用的日志标签（ADR-067 2.5 / ADR-076）：只带「调用种类 + 输入规模」，
 * 不带任何正文，因此可以在同一份日志格式里同时容纳文档草稿与总结改写。
 */
interface AiAssistCallLabel {
  readonly kind: "draft" | "summary" | "task-draft";
  readonly mode: DocumentImportAssistMode | undefined;
  readonly inputChars: number;
}

/** 结构化草稿请求：返回模型原始 JSON 文本，由调用方按契约解析与校验。 */
export interface AiAssistTaskDraft {
  readonly content: string;
  readonly model: string;
  readonly truncated: boolean;
}

export interface AiAssistDraft {
  readonly markdown: string;
  readonly model: string;
  /** 上游完成原因为长度上限（finish_reason: length）。 */
  readonly truncated: boolean;
}

/** 一次草稿生成的输入：模式 + 用户原文（补充说明已由前端拼进 text）。 */
export interface AiAssistDraftRequest {
  readonly mode: DocumentImportAssistMode;
  readonly text: string;
  /**
   * 整项目导入时要点名的创建者姓名（本次导入人），由服务端从当前 Session 读出；
   * 只进 system 提示词，不写日志、不落库；取不到时不传，由提示词要求不要编造。
   */
  readonly creatorName?: string | undefined;
  /**
   * ADR-094：项目内导入的 UI 目标。名称由服务端读取并通过权限 / 归属校验；
   * 只进 system 提示词，不写日志、不落库。
   */
  readonly target?: AiAssistTarget | undefined;
  /** 聊天记录等截图：随 user message 转发给多模态模型，不写日志、不落库。 */
  readonly images?: readonly AiAssistImage[] | undefined;
}

const LOGGER_CONTEXT = "DocumentImportAiAssist";
const MAX_RESPONSE_JSON_CHARS = 2_000_000;
/** 契约输出上限 200000 字符；超出按上游响应非法处理（ADR-067 2.7）。 */
const MAX_MARKDOWN_CHARS = 200_000;
const ERROR_BODY_SNIFF_CHARS = 4_000;
/** 测试连接探测请求的固定内容；不含任何用户数据（ADR-068）。 */
const PROBE_CONTENT = "ping";

/**
 * OpenAI 兼容 chat/completions 出站适配器（ADR-067 2.2 / ADR-068）：
 * 只发送 model / messages / max_tokens / temperature / stream，不发送 Cookie、
 * CSRF 或用户凭证，不复用用户 Session，不自动重试；密钥只用于 Authorization
 * 头。配置由调用方逐次解析（数据库或环境变量），所有调用都在数据库事务之外。
 */
export class DocumentImportAiAssistClient {
  private readonly logger = new Logger(LOGGER_CONTEXT);

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async generateDraft(
    config: AiAssistConfig,
    input: AiAssistDraftRequest,
  ): Promise<AiAssistDraft> {
    const startedAt = Date.now();
    const label: AiAssistCallLabel = {
      kind: "draft",
      mode: input.mode,
      inputChars: input.text.length,
    };
    const response = await this.callUpstream(
      config,
      {
        model: config.model,
        messages: buildAiAssistMessages(input),
        max_tokens: config.maxTokens,
        temperature: 0.2,
        stream: false,
      },
      startedAt,
      label,
    );
    let draft: AiAssistDraft;
    try {
      draft = await this.parseSuccessResponse(response, config);
    } catch (error) {
      // 2xx 但结构不对：把上游状态码记进日志，才分得清「上游报错」和「上游换了返回形状」。
      if (error instanceof AiAssistUpstreamError) {
        this.logCall(
          label,
          config,
          "failed",
          startedAt,
          error.reason,
          response.status,
        );
      }
      throw error;
    }
    this.logCall(label, config, "ok", startedAt, undefined, response.status);
    return draft;
  }

  /**
   * ADR-076 迭代总结 AI 改写：把用户已经看到的事实正文按一句话要求改写。
   * 与 ADR-067 共用同一份运行时配置、同一套失败分类与截断判定，只有提示词与
   * 日志标签不同（仍然不记录正文与密钥）。
   */
  async generateSummaryDraft(
    config: AiAssistConfig,
    input: { readonly requirement: string; readonly facts: string },
  ): Promise<AiAssistDraft> {
    const label: AiAssistCallLabel = {
      kind: "summary",
      mode: undefined,
      inputChars: input.facts.length + input.requirement.length,
    };
    const startedAt = Date.now();
    const response = await this.callUpstream(
      config,
      {
        model: config.model,
        messages: buildRecordSummaryAssistMessages(input),
        max_tokens: config.maxTokens,
        temperature: 0.2,
        stream: false,
      },
      startedAt,
      label,
    );
    let draft: AiAssistDraft;
    try {
      draft = await this.parseSuccessResponse(response, config);
    } catch (error) {
      if (error instanceof AiAssistUpstreamError) {
        this.logCall(
          label,
          config,
          "failed",
          startedAt,
          error.reason,
          response.status,
        );
      }
      throw error;
    }
    this.logCall(label, config, "ok", startedAt, undefined, response.status);
    return draft;
  }

  /**
   * 新建任务 AI 识别：要求模型输出固定 JSON 草稿。与总结改写共用运行时配置、
   * 失败分类与截断判定；这里只负责取回模型内容，JSON 解析、字段裁剪与
   * 真实 ID 匹配全部交给 HTTP 服务，客户端不信任模型输出。
   */
  async generateTaskDraft(
    config: AiAssistConfig,
    input: TaskDraftAssistPromptInput,
  ): Promise<AiAssistTaskDraft> {
    const startedAt = Date.now();
    const label: AiAssistCallLabel = {
      kind: "task-draft",
      mode: undefined,
      inputChars:
        input.message.length +
        input.history.reduce((total, item) => total + item.text.length, 0),
    };
    const response = await this.callUpstream(
      config,
      {
        model: config.model,
        messages: buildTaskDraftAssistMessages(input),
        max_tokens: Math.min(
          config.maxTokens,
          TASK_DRAFT_ASSIST_MAX_OUTPUT_TOKENS,
        ),
        temperature: 0.1,
        stream: false,
      },
      startedAt,
      label,
    );
    let draft: AiAssistDraft;
    try {
      draft = await this.parseSuccessResponse(response, config);
    } catch (error) {
      if (error instanceof AiAssistUpstreamError) {
        this.logCall(
          label,
          config,
          "failed",
          startedAt,
          error.reason,
          response.status,
        );
      }
      throw error;
    }
    this.logCall(label, config, "ok", startedAt, undefined, response.status);
    return {
      content: draft.markdown,
      model: draft.model,
      truncated: draft.truncated,
    };
  }

  /**
   * ADR-068 测试连接：max_tokens=1 的最小探测请求；不发送用户数据。
   * 失败抛 AiAssistUpstreamError（HTTP 层映射固定分类）。
   */
  async probe(config: AiAssistConfig): Promise<{ readonly model: string }> {
    const startedAt = Date.now();
    const response = await this.callUpstream(
      config,
      {
        model: config.model,
        messages: [{ role: "user", content: PROBE_CONTENT }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      },
      startedAt,
      undefined,
    );
    try {
      let raw: string;
      try {
        raw = await response.text();
      } catch {
        throw new AiAssistUpstreamError("invalid-response");
      }
      if (raw.length > MAX_RESPONSE_JSON_CHARS) {
        throw new AiAssistUpstreamError("invalid-response");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new AiAssistUpstreamError("invalid-response");
      }
      const choices = isRecord(payload) ? payload["choices"] : undefined;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const message =
        isRecord(first) && isRecord(first["message"])
          ? first["message"]
          : undefined;
      if (message === undefined || typeof message["content"] !== "string") {
        throw new AiAssistUpstreamError("invalid-response");
      }
      const responseModel = isRecord(payload) ? payload["model"] : undefined;
      const model =
        typeof responseModel === "string" && responseModel.trim().length > 0
          ? responseModel.trim().slice(0, 200)
          : config.model;
      this.logCall(
        undefined,
        config,
        "ok",
        startedAt,
        undefined,
        response.status,
      );
      return { model };
    } catch (error) {
      if (error instanceof AiAssistUpstreamError) {
        this.logCall(
          undefined,
          config,
          "failed",
          startedAt,
          error.reason,
          response.status,
        );
      }
      throw error;
    }
  }

  private async callUpstream(
    config: AiAssistConfig,
    body: Readonly<Record<string, unknown>>,
    startedAt: number,
    label: AiAssistCallLabel | undefined,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const reason: AiAssistFailureReason = isAbortLikeError(error)
        ? "timeout"
        : "network";
      this.logCall(label, config, "failed", startedAt, reason);
      throw new AiAssistUpstreamError(reason);
    }
    if (!response.ok) {
      const reason = await this.classifyErrorResponse(response);
      this.logCall(label, config, "failed", startedAt, reason, response.status);
      throw new AiAssistUpstreamError(reason);
    }
    return response;
  }

  private async classifyErrorResponse(
    response: Response,
  ): Promise<AiAssistFailureReason> {
    if (response.status === 401 || response.status === 403) {
      return "auth";
    }
    if (response.status === 429) {
      return "rate-limited";
    }
    // 读取有限长度的上游错误体做上下文超限启发式判断；正文不进日志。
    let bodyText: string;
    try {
      bodyText = (await response.text()).slice(0, ERROR_BODY_SNIFF_CHARS);
    } catch {
      bodyText = "";
    }
    if (
      response.status === 400 ||
      response.status === 413 ||
      response.status === 422
    ) {
      // 「文件太大 / 载荷过大」在两个上游都表现为 400/413，提示用户精简比
      // 「返回了无法识别的内容」有用得多。
      if (
        /context|token|too long|too large|maximum|length|payload|request entity/i.test(
          bodyText,
        )
      ) {
        return "context-limit";
      }
    }
    return "invalid-response";
  }

  private async parseSuccessResponse(
    response: Response,
    config: AiAssistConfig,
  ): Promise<AiAssistDraft> {
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw new AiAssistUpstreamError("invalid-response");
    }
    if (raw.length > MAX_RESPONSE_JSON_CHARS) {
      throw new AiAssistUpstreamError("invalid-response");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AiAssistUpstreamError("invalid-response");
    }
    const choices = isRecord(payload) ? payload["choices"] : undefined;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message =
      isRecord(first) && isRecord(first["message"])
        ? first["message"]
        : undefined;
    const content = message === undefined ? undefined : message["content"];
    const finishReason = isRecord(first) ? first["finish_reason"] : undefined;
    if (typeof content !== "string") {
      throw new AiAssistUpstreamError("invalid-response");
    }
    const markdown = content.trim();
    if (markdown.length === 0) {
      // 推理模型（响应里带 reasoning_content）会先把输出预算花在推理上：预算耗尽时
      // 上游照样回 200，但 content 为空且 finish_reason=length，正文永远没机会输出。
      // 这不是「返回形状非法」，归到长度上限，让提示落到可操作的方向上。
      throw new AiAssistUpstreamError(
        finishReason === "length" ? "context-limit" : "invalid-response",
      );
    }
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      throw new AiAssistUpstreamError("invalid-response");
    }
    const responseModel = isRecord(payload) ? payload["model"] : undefined;
    const model =
      typeof responseModel === "string" && responseModel.trim().length > 0
        ? responseModel.trim().slice(0, 200)
        : config.model;
    return {
      markdown,
      model,
      truncated: finishReason === "length",
    };
  }

  private logCall(
    label: AiAssistCallLabel | undefined,
    config: AiAssistConfig,
    status: "ok" | "failed",
    startedAt: number,
    reason: AiAssistFailureReason | undefined,
    upstreamStatus: number | null = null,
  ): void {
    // 只记录调用元数据，不记录正文与密钥（ADR-067 2.5 / ADR-068 2.3）。
    // 失败时带上上游 HTTP 状态码：不然「上游报错」和「上游换了返回形状」在日志里长得一样。
    const line = JSON.stringify({
      kind: label?.kind ?? "probe",
      mode:
        label === undefined
          ? "PROBE"
          : (label.mode ?? label.kind.toUpperCase()),
      model: config.model,
      inputChars: label?.inputChars ?? 0,
      status,
      reason: reason ?? "none",
      upstreamStatus,
      elapsedMs: Date.now() - startedAt,
    });
    if (status === "ok") {
      this.logger.log(line);
    } else {
      this.logger.warn(line);
    }
  }
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

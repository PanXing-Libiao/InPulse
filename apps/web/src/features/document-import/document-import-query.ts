import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type DocumentImportAssistRequest,
  type DocumentImportAssistResponse,
  type InpulseApiClient,
  type ProjectDocumentImportPreviewResponse,
  type ProjectDocumentImportResult,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * ADR-064 文档导入数据层；ADR-067 追加 AI 辅助转换（assistDocumentImport）。
 *
 * 预览是只读校验接口（不写任何持久化状态）；执行是数据库级幂等写命令，
 * 先签发 CSRF Token 再携带一次性 Idempotency-Key，所有请求都走生成客户端。
 * 文档原文长度上限与契约常量 `DOCUMENT_IMPORT_MAX_TEXT_LENGTH` 保持一致。
 * AI 分析与导入链路完全独立：生成草稿不落库，用户确认后仍走既有预览/导入。
 */
export const DOCUMENT_IMPORT_MAX_TEXT_LENGTH = 200_000;

export type DocumentImportMode = "NEW_PROJECT" | "PROJECT";

/** ADR-094：AI 辅助转换的目标；只携带 ID，名称由服务端重新读取。 */
export type DocumentImportAssistTarget = NonNullable<
  DocumentImportAssistRequest["target"]
>;

export interface DocumentImportOptions {
  readonly mode: DocumentImportMode;
  readonly projectId?: number | undefined;
  readonly client?: InpulseApiClient | undefined;
}

export interface DocumentImportIssueView {
  readonly severity: "ERROR" | "WARNING";
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

function requireProjectId(projectId: number | undefined): number {
  if (projectId === undefined) {
    throw new Error("projectId is required for in-project document import");
  }
  return projectId;
}

/** 从 422 错误明细中提取行级问题；错误体不是该形态时返回空数组。 */
export function documentImportIssuesFromError(
  error: unknown,
): readonly DocumentImportIssueView[] {
  if (!(error instanceof ApiError)) return [];
  const raw = error.details["issues"];
  if (!Array.isArray(raw)) return [];
  const issues: DocumentImportIssueView[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const severity = candidate["severity"];
    const line = candidate["line"];
    const code = candidate["code"];
    const message = candidate["message"];
    if (severity !== "ERROR" && severity !== "WARNING") continue;
    if (
      typeof line !== "number" ||
      typeof code !== "string" ||
      typeof message !== "string"
    ) {
      continue;
    }
    issues.push({ severity, line, code, message });
  }
  return issues;
}

/** 稳定、脱敏的用户提示；服务器内部消息不下发到界面。 */
export function describeDocumentImportError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "DOCUMENT_IMPORT_INVALID":
        return "文档存在错误，请修正问题清单后重新预览。";
      case "DOCUMENT_IMPORT_STALE":
        return "文档内容与预览结果不一致，请重新预览后再导入。";
      case "DOCUMENT_IMPORT_DUPLICATE":
        return "这份文档已经导入过，请勿重复导入。";
      case "DOCUMENT_IMPORT_CONFLICT":
        return "文档与现有数据冲突，请重新预览后重试。";
      case "PROJECT_CODE_CONFLICT":
        return "项目编码已被占用，请修改文档中的项目编码后重新预览。";
      case "PROJECT_NOT_FOUND":
        return "项目不存在或你没有访问权限。";
      default:
        break;
    }
    switch (error.status) {
      case 401:
        return SESSION_EXPIRED_MESSAGE;
      case 403:
        return "安全校验未通过，请刷新页面后重试。";
      case 409:
        return "导入请求发生冲突，请重新预览后重试。";
      case 422:
        return "文档格式不正确，请按固定模板检查后重试。";
      case 429:
        return "导入请求过于频繁，请稍后重试。";
      default:
        return "导入暂时失败，请稍后重试。";
    }
  }
  return "导入暂时失败，请稍后重试。";
}
export function usePreviewDocumentImport({
  mode,
  projectId,
  client,
}: DocumentImportOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  return useMutation({
    mutationFn: (
      document: string,
    ): Promise<ProjectDocumentImportPreviewResponse> => {
      if (mode === "NEW_PROJECT") {
        return apiClient.previewProjectImport({ document });
      }
      return apiClient.previewProjectDocumentImport(
        requireProjectId(projectId),
        { document },
      );
    },
  });
}

export interface ApplyDocumentImportInput {
  readonly document: string;
  readonly expectedDigest: string;
}

export function useApplyDocumentImport({
  mode,
  projectId,
  client,
}: DocumentImportOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: ApplyDocumentImportInput,
    ): Promise<ProjectDocumentImportResult> => {
      const csrf = await apiClient.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": createIdempotencyKey("document-import"),
        },
      };
      const body = {
        document: input.document,
        expectedDigest: input.expectedDigest,
      };
      if (mode === "NEW_PROJECT") {
        return apiClient.importProject(body, init);
      }
      return apiClient.importProjectDocument(
        requireProjectId(projectId),
        body,
        init,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (projectId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: ["modules", projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["projects", "detail", projectId],
        });
      }
    },
  });
}

/** 契约层的分析模式：整项目导入对应 WHOLE_PROJECT，项目内导入对应 IN_PROJECT。 */
export type DocumentImportAssistMode = "IN_PROJECT" | "WHOLE_PROJECT";

export function resolveDocumentImportAssistMode(
  mode: DocumentImportMode,
): DocumentImportAssistMode {
  return mode === "NEW_PROJECT" ? "WHOLE_PROJECT" : "IN_PROJECT";
}

export interface AssistDocumentImportInput {
  readonly text: string;
  readonly target?: DocumentImportAssistTarget | undefined;
}

/**
 * ADR-067 AI 辅助转换：纯校验接口（csrf / idempotency 均 none），
 * 请求只携带模式、抽取后的纯文本与 ADR-094 的可选目标，不发送文件本身。
 */
export function useAssistDocumentImport({
  mode,
  client,
}: DocumentImportOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  const assistMode = resolveDocumentImportAssistMode(mode);
  return useMutation({
    mutationFn: (
      input: AssistDocumentImportInput,
    ): Promise<DocumentImportAssistResponse> =>
      apiClient.assistDocumentImport({
        mode: assistMode,
        text: input.text,
        ...(input.target === undefined ? {} : { target: input.target }),
      }),
  });
}

interface DocumentImportTargetQueryOptions {
  readonly projectId?: number | undefined;
  readonly client?: InpulseApiClient | undefined;
  readonly enabled?: boolean | undefined;
}

/**
 * ADR-094：文档导入目标选择器复用项目模块目录。查询键与模块列表查询相同，
 * 因此从模块页打开导入弹窗时通常直接命中已有缓存。
 */
export function useDocumentImportTargetModules({
  projectId,
  client,
  enabled,
}: DocumentImportTargetQueryOptions) {
  const apiClient = useMemo(() => client ?? createApiClient(), [client]);
  return useQuery({
    queryKey: ["modules", projectId],
    queryFn: ({ signal }) => {
      if (projectId === undefined) {
        throw new Error("projectId is required");
      }
      return apiClient.listModules(projectId, { signal });
    },
    enabled:
      (enabled ?? true) &&
      projectId !== undefined &&
      Number.isInteger(projectId) &&
      projectId > 0,
    retry: false,
  });
}

const AI_ASSIST_REASON_MESSAGES: Readonly<Record<string, string>> = {
  auth: "AI 服务鉴权失败，请管理员在「成员与设置 → AI 辅助转换」中检查 API 密钥。",
  "rate-limited": "AI 服务请求过于频繁（上游限流），请稍后重试。",
  timeout: "AI 服务响应超时，请稍后重试或精简文档。",
  network: "无法连接 AI 服务（网络故障），请稍后重试或先手动粘贴模板。",
  "context-limit":
    "文档超出模型长度上限，或模型推理占满了输出预算：请精简文档或分次生成，也可让管理员调高「最大输出 tokens」。",
  "invalid-response": "AI 服务返回了无法识别的内容，请稍后重试。",
};

/** ADR-067 固定错误码 → 固定中文提示；上游细节只通过 reason 归类，不下发原文。 */
export function describeDocumentImportAssistError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "AI_ASSIST_DISABLED":
        return "AI 辅助转换未启用或配置无效，请管理员在「成员与设置 → AI 辅助转换」中配置后重试。";
      case "DOCUMENT_IMPORT_TARGET_NOT_FOUND":
        return "导入位置不存在，或你已没有该项目的写权限，请重新选择后再试。";
      case "AI_ASSIST_UPSTREAM_FAILED": {
        const reason = error.details["reason"];
        if (typeof reason === "string" && reason in AI_ASSIST_REASON_MESSAGES) {
          return (
            AI_ASSIST_REASON_MESSAGES[reason] ??
            "AI 服务暂时不可用，请稍后重试。"
          );
        }
        return "AI 服务暂时不可用，请稍后重试或先手动粘贴模板。";
      }
      default:
        break;
    }
    switch (error.status) {
      case 401:
        return SESSION_EXPIRED_MESSAGE;
      case 400:
        return "请求格式不正确，请检查后重试。";
      case 422:
        return "AI 整理请求未通过校验，请检查导入位置和文档内容后重试；若持续失败，请联系管理员。";
      default:
        return "AI 分析暂时失败，请稍后重试，或先手动粘贴模板。";
    }
  }
  return "AI 分析暂时失败，请稍后重试，或先手动粘贴模板。";
}

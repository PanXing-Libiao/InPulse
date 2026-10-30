import { useRef, useState } from "react";
import { Button } from "antd";
import { useMutation } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type TaskDraftAssistDraft,
} from "@generated/api";
import {
  assistImagePayload,
  imageFilesFromClipboard,
  useAssistAttachments,
  type AssistImageAttachment,
} from "@features/common/assist-image";

const PRIORITY_LABELS: Readonly<Record<string, string>> = {
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};

export interface TaskDraftAssistApplyResult {
  readonly applied: number;
  readonly conflicts: readonly string[];
}

interface AssistantMessage {
  readonly role: "USER" | "ASSISTANT";
  readonly text: string;
  readonly draft?: TaskDraftAssistDraft;
  readonly notes?: readonly string[];
  readonly confidence?: "HIGH" | "MEDIUM" | "LOW";
  readonly applied?: TaskDraftAssistApplyResult;
}

export interface TaskDraftAssistPaneProps {
  readonly api: InpulseApiClient;
  readonly projectId: number;
  readonly moduleId: number;
  readonly featureId: number;
  readonly disabled: boolean;
  readonly onApply: (draft: TaskDraftAssistDraft) => TaskDraftAssistApplyResult;
}

/**
 * 新建任务弹窗右侧的 AI 助手。视觉与文档导入的 AI 助手共用同一套
 * `.import-assist*` 设计系统样式；行为只做预填，永不直接创建任务。
 *
 * 每次发送都把最近 10 条对话带回服务端，AI 因而能处理「截止改到下周五」
 * 这类追问；结构化草稿只用于当前消息回填与展示，服务端每次都会重新匹配
 * 真实的成员 / 模块 / 功能 ID。
 */
export function TaskDraftAssistPane({
  api,
  projectId,
  moduleId,
  featureId,
  disabled,
  onApply,
}: TaskDraftAssistPaneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { attachments, imageError, addFromClipboard, remove, clear } =
    useAssistAttachments();

  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      readonly text: string;
      readonly history: readonly AssistantMessage[];
      readonly images: readonly AssistImageAttachment[];
    }) => {
      const history = input.history.slice(-10).map((message) => ({
        role:
          message.role === "USER" ? ("USER" as const) : ("ASSISTANT" as const),
        text: historyText(message),
      }));
      const body = {
        message: input.text,
        history,
        ...(moduleId > 0 ? { moduleId } : {}),
        ...(featureId > 0 ? { featureId } : {}),
        ...(input.images.length > 0
          ? { images: assistImagePayload(input.images) }
          : {}),
      };
      return projectId > 0
        ? api.assistTaskDraft(projectId, body)
        : api.assistTaskDraftStandalone(body);
    },
    onSuccess: (response) => {
      setMessages((current) => [
        ...current,
        {
          role: "ASSISTANT",
          text: response.reply,
          draft: response.draft,
          notes: response.notes,
          confidence: response.confidence,
        },
      ]);
      setComposer("");
      setError(null);
    },
    onError: (cause) => {
      setMessages((current) => current.slice(0, -1));
      setError(assistErrorText(cause));
      setComposer("");
    },
  });

  const busy = mutation.isPending;
  const canSend =
    !disabled &&
    !busy &&
    (composer.trim().length > 0 || attachments.length > 0);

  function send(): void {
    const text = composer.trim();
    const images = attachments;
    if ((text.length === 0 && images.length === 0) || disabled || busy) return;
    const history = messages;
    const shownText =
      images.length === 0
        ? text
        : (text.length === 0 ? "（截图）" : text) +
          " · " +
          images.length +
          " 张截图";
    setMessages((current) => [...current, { role: "USER", text: shownText }]);
    setComposer("");
    clear();
    setError(null);
    mutation.mutate({ text, history, images });
  }

  function apply(message: AssistantMessage): void {
    if (!message.draft || message.applied) return;
    const result = onApply(message.draft);
    setMessages((current) =>
      current.map((item) =>
        item === message ? { ...item, applied: result } : item,
      ),
    );
  }

  return (
    <aside
      className="import-assist task-create-assist"
      data-testid="task-draft-assist"
    >
      <div className="import-assist-head">
        <span className="import-assist-name">AI 助手</span>
        <span className="import-assist-headright">
          <span className="import-pill">对话式</span>
          <a
            className="task-assist-config"
            href="/settings?tab=aiAssist"
            data-testid="task-draft-assist-settings"
          >
            配置
          </a>
        </span>
      </div>

      <div
        className="import-assist-msgs"
        data-testid="task-draft-assist-messages"
      >
        {messages.length === 0 && !busy ? (
          <div className="import-assist-empty">
            <div>还没有任务草稿</div>
            <div>先粘贴聊天截图或描述任务，项目可以稍后再选</div>
          </div>
        ) : null}
        {messages.map((message, index) => (
          <div
            className={message.role === "USER" ? "import-msg me" : "import-msg"}
            key={index}
          >
            <div>{message.text}</div>
            {message.draft ? (
              <TaskDraftSummary
                draft={message.draft}
                applied={message.applied ?? null}
                onApply={() => apply(message)}
                onRetry={() => inputRef.current?.focus()}
              />
            ) : null}
            {message.notes && message.notes.length > 0 ? (
              <ul className="task-assist-notes">
                {message.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        {busy ? (
          <div
            className="import-msg is-busy"
            data-testid="task-draft-assist-busy"
          >
            <span className="import-busy-dot" aria-hidden="true" />
            正在整理成任务草稿…
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="task-assist-error" role="alert">
          {error}
        </p>
      ) : null}

      {attachments.length > 0 || imageError !== null ? (
        <div
          className="assist-attachments"
          data-testid="task-assist-attachments"
        >
          {attachments.map((item) => (
            <span className="assist-attachment" key={item.id}>
              <img src={item.previewUrl} alt="截图预览" />
              <button
                type="button"
                aria-label="移除截图"
                onClick={() => remove(item.id)}
              >
                ×
              </button>
            </span>
          ))}
          {imageError !== null ? (
            <span className="assist-attachment-error" role="alert">
              {imageError}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="import-composer">
        <input
          ref={inputRef}
          aria-label="描述任务"
          value={composer}
          disabled={disabled || busy}
          placeholder={busy ? "正在识别…" : "描述任务，或粘贴聊天记录截图"}
          onChange={(event) => {
            setComposer(event.currentTarget.value);
            setError(null);
          }}
          onPaste={(event) => {
            if (imageFilesFromClipboard(event.clipboardData).length === 0) {
              return;
            }
            event.preventDefault();
            void addFromClipboard(event.clipboardData);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              send();
            }
          }}
        />
        <Button
          type="primary"
          data-testid="task-draft-assist-send"
          loading={busy}
          disabled={!canSend}
          onClick={send}
        >
          发送
        </Button>
      </div>
    </aside>
  );
}

function TaskDraftSummary({
  draft,
  applied,
  onApply,
  onRetry,
}: {
  readonly draft: TaskDraftAssistDraft;
  readonly applied: TaskDraftAssistApplyResult | null;
  readonly onApply: () => void;
  readonly onRetry: () => void;
}) {
  const rows: { label: string; value: string }[] = [];
  if (draft.title) rows.push({ label: "标题", value: draft.title });
  if (draft.moduleName) {
    rows.push({
      label: "归属",
      value:
        draft.featureName === null
          ? draft.moduleName
          : draft.moduleName + " / " + draft.featureName,
    });
  }
  if (draft.assigneeNames.length > 0) {
    rows.push({ label: "负责人", value: draft.assigneeNames.join("、") });
  }
  if (draft.priority) {
    rows.push({
      label: "优先级",
      value: PRIORITY_LABELS[draft.priority] ?? draft.priority,
    });
  }
  if (draft.dueAt) {
    rows.push({ label: "截止", value: formatDueAt(draft.dueAt) });
  }
  if (rows.length === 0) {
    return (
      <div className="task-assist-actions">
        <span className="task-assist-hint">
          这次没识别出可填的字段，可以补充一句再试。
        </span>
        <Button size="small" onClick={onRetry}>
          重新描述
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="task-assist-summary">
        {rows.map((row) => (
          <div className="task-assist-row" key={row.label}>
            <span>{row.label}</span>
            <b>{row.value}</b>
          </div>
        ))}
      </div>
      {applied === null ? (
        <div className="task-assist-actions">
          <Button type="primary" size="small" onClick={onApply}>
            填入左侧
          </Button>
          <Button size="small" onClick={onRetry}>
            重新描述
          </Button>
        </div>
      ) : (
        <div className="task-assist-applied">
          已填入 {applied.applied} 项
          {applied.conflicts.length > 0
            ? "；未覆盖已有内容：" + applied.conflicts.join("、")
            : "；创建前请再核对一遍"}
        </div>
      )}
    </>
  );
}

/** 历史只带用户可见的回复与上轮草稿摘要，不带模型原始 JSON。 */
function historyText(message: AssistantMessage): string {
  if (!message.draft) return message.text.slice(0, 1_900);
  const draft = message.draft;
  const summary = JSON.stringify({
    title: draft.title,
    description: draft.description?.slice(0, 300) ?? null,
    priority: draft.priority,
    dueAt: draft.dueAt,
    module: draft.moduleName,
    feature: draft.featureName,
    assignees: draft.assigneeNames,
  });
  return (message.text + "\n[上轮草稿] " + summary).slice(0, 1_900);
}

function formatDueAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function assistErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return "AI 助手未启用或暂时不可用，请稍后重试。";
    }
    if (error.status === 404) return "项目不存在或无权访问。";
    if (error.status === 401) return "登录状态已失效，请重新登录。";
    return error.message || "AI 助手暂时不可用，请稍后重试。";
  }
  return "AI 助手暂时不可用，请稍后重试。";
}

import { useRef, useState } from "react";
import { Button } from "antd";
import { useMutation } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type TaskDraftAssistDraft,
  type TaskDraftAssistSuggestions,
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

export interface TaskDraftAssistApplyOptions {
  readonly applyModule: boolean;
}

export interface TaskDraftAssistApplyResult {
  readonly applied: number;
  readonly conflicts: readonly string[];
}

interface AssignmentDecision {
  readonly projectId?: number | undefined;
  readonly moduleId?: number | undefined;
  readonly dismissedProject?: boolean | undefined;
  readonly dismissedModule?: boolean | undefined;
}

interface AssistantMessage {
  readonly role: "USER" | "ASSISTANT";
  readonly text: string;
  readonly draft?: TaskDraftAssistDraft;
  readonly suggestions?: TaskDraftAssistSuggestions;
  readonly notes?: readonly string[];
  readonly confidence?: "HIGH" | "MEDIUM" | "LOW";
  readonly applied?: TaskDraftAssistApplyResult;
  readonly decision?: AssignmentDecision;
}

export interface TaskDraftAssistPaneProps {
  readonly api: InpulseApiClient;
  readonly projectId: number;
  readonly moduleId: number;
  readonly disabled: boolean;
  readonly projectLocked?: boolean | undefined;
  readonly moduleLocked?: boolean | undefined;
  readonly onApply: (
    draft: TaskDraftAssistDraft,
    options: TaskDraftAssistApplyOptions,
  ) => TaskDraftAssistApplyResult;
  readonly onConfirmProject: (projectId: number) => void;
  readonly onConfirmModule: (moduleId: number) => void;
  readonly onChangeProject: () => void;
  readonly onChangeModule: () => void;
}

/**
 * 新建任务弹窗右侧的 AI 助手。视觉与文档导入的 AI 助手共用同一套
 * `.import-assist*` 设计系统样式；行为只做预填，永不直接创建任务。
 *
 * 项目与模块不再自动写回：服务端只返回授权范围内的候选，前端用确认卡让
 * 用户点「是」或去左侧更改。多候选时不替用户猜，全部列出供点选。
 */
export function TaskDraftAssistPane({
  api,
  projectId,
  moduleId,
  disabled,
  projectLocked = false,
  moduleLocked = false,
  onApply,
  onConfirmProject,
  onConfirmModule,
  onChangeProject,
  onChangeModule,
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
          suggestions: response.suggestions,
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
    const hasModuleSuggestion = (message.suggestions?.modules.length ?? 0) > 0;
    const result = onApply(message.draft, {
      applyModule: !moduleLocked && !hasModuleSuggestion,
    });
    setMessages((current) =>
      current.map((item) =>
        item === message ? { ...item, applied: result } : item,
      ),
    );
  }

  function updateDecision(
    message: AssistantMessage,
    next: AssignmentDecision,
  ): void {
    setMessages((current) =>
      current.map((item) =>
        item === message
          ? { ...item, decision: { ...item.decision, ...next } }
          : item,
      ),
    );
  }

  function confirmProject(
    message: AssistantMessage,
    nextProjectId: number,
  ): void {
    if (disabled || projectLocked) return;
    updateDecision(message, {
      projectId: nextProjectId,
      moduleId: undefined,
      dismissedProject: false,
    });
    onConfirmProject(nextProjectId);
  }

  function confirmModule(
    message: AssistantMessage,
    nextModuleId: number,
  ): void {
    if (disabled || moduleLocked) return;
    updateDecision(message, { moduleId: nextModuleId, dismissedModule: false });
    onConfirmModule(nextModuleId);
  }

  function changeProject(message: AssistantMessage): void {
    updateDecision(message, { dismissedProject: true });
    onChangeProject();
  }

  function changeModule(message: AssistantMessage): void {
    updateDecision(message, { dismissedModule: true });
    onChangeModule();
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
                hasAssignmentSuggestion={
                  (message.suggestions?.projects.length ?? 0) > 0 ||
                  (message.suggestions?.modules.length ?? 0) > 0
                }
                onApply={() => apply(message)}
                onRetry={() => inputRef.current?.focus()}
              />
            ) : null}
            {message.suggestions ? (
              <AssignmentSuggestion
                suggestions={message.suggestions}
                projectId={projectId}
                moduleId={moduleId}
                decision={message.decision}
                disabled={disabled}
                projectLocked={projectLocked}
                moduleLocked={moduleLocked}
                onConfirmProject={(id) => confirmProject(message, id)}
                onConfirmModule={(id) => confirmModule(message, id)}
                onChangeProject={() => changeProject(message)}
                onChangeModule={() => changeModule(message)}
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

function AssignmentSuggestion({
  suggestions,
  projectId,
  moduleId,
  decision,
  disabled,
  projectLocked,
  moduleLocked,
  onConfirmProject,
  onConfirmModule,
  onChangeProject,
  onChangeModule,
}: {
  readonly suggestions: TaskDraftAssistSuggestions;
  readonly projectId: number;
  readonly moduleId: number;
  readonly decision: AssignmentDecision | undefined;
  readonly disabled: boolean;
  readonly projectLocked: boolean;
  readonly moduleLocked: boolean;
  readonly onConfirmProject: (projectId: number) => void;
  readonly onConfirmModule: (moduleId: number) => void;
  readonly onChangeProject: () => void;
  readonly onChangeModule: () => void;
}) {
  const projects = suggestions.projects;
  const modules = suggestions.modules;
  const confirmedProject = projects.find(
    (item) => item.id === (decision?.projectId ?? projectId),
  );
  const selectedProjectIsSuggested =
    projects.length === 0 || confirmedProject !== undefined;
  const visibleModules =
    projectId > 0 && selectedProjectIsSuggested && !moduleLocked ? modules : [];
  const confirmedModule = visibleModules.find(
    (item) => item.id === (decision?.moduleId ?? moduleId),
  );
  const manualProjectChoice = projectId > 0 && confirmedProject === undefined;
  const manualModuleChoice = moduleId > 0 && confirmedModule === undefined;
  const showProjectCard =
    !projectLocked &&
    projects.length > 0 &&
    confirmedProject === undefined &&
    !manualProjectChoice &&
    decision?.dismissedProject !== true;
  const showProjectDismissed =
    !projectLocked &&
    projects.length > 0 &&
    confirmedProject === undefined &&
    !manualProjectChoice &&
    decision?.dismissedProject === true;
  const showModuleCard =
    visibleModules.length > 0 &&
    confirmedModule === undefined &&
    !manualModuleChoice &&
    decision?.dismissedModule !== true;
  const showModuleDismissed =
    visibleModules.length > 0 &&
    confirmedModule === undefined &&
    !manualModuleChoice &&
    decision?.dismissedModule === true;

  if (
    confirmedProject === undefined &&
    confirmedModule === undefined &&
    !showProjectCard &&
    !showProjectDismissed &&
    !showModuleCard &&
    !showModuleDismissed
  ) {
    return null;
  }

  return (
    <div
      className="task-assist-suggestion"
      data-testid="task-assist-suggestion"
    >
      {confirmedProject !== undefined ? (
        <div className="task-assist-suggestion-confirmed">
          已确认项目：{confirmedProject.name}
        </div>
      ) : null}
      {showProjectDismissed ? (
        <div className="task-assist-suggestion-muted">
          项目归属请在左侧下拉选择
        </div>
      ) : showProjectCard ? (
        <div className="task-assist-suggestion-block">
          <div className="task-assist-suggestion-title">
            {projects.length === 1
              ? "像是「" + projects[0]?.name + "」这个项目，是这个吗？"
              : "可能是这几个项目，选一个："}
          </div>
          <div className="task-assist-suggestion-actions">
            {projects.map((project, index) => (
              <Button
                key={project.id}
                size="small"
                type={index === 0 ? "primary" : "default"}
                data-testid={
                  index === 0
                    ? "task-assist-confirm-project"
                    : "task-assist-confirm-project-" + String(project.id)
                }
                disabled={disabled}
                onClick={() => onConfirmProject(project.id)}
              >
                {projects.length === 1
                  ? "是，用这个"
                  : "用「" + project.name + "」"}
              </Button>
            ))}
            <Button
              size="small"
              data-testid="task-assist-change-project"
              disabled={disabled}
              onClick={onChangeProject}
            >
              更改
            </Button>
          </div>
        </div>
      ) : null}

      {confirmedModule !== undefined ? (
        <div className="task-assist-suggestion-confirmed">
          已确认模块：{confirmedModule.name}
        </div>
      ) : null}
      {showModuleDismissed ? (
        <div className="task-assist-suggestion-muted">
          模块归属请在左侧下拉选择
        </div>
      ) : showModuleCard ? (
        <div className="task-assist-suggestion-block">
          <div className="task-assist-suggestion-title">
            {visibleModules.length === 1
              ? "像是「" + visibleModules[0]?.name + "」这个模块，对吗？"
              : "可能是这几个模块，选一个："}
          </div>
          <div className="task-assist-suggestion-actions">
            {visibleModules.map((module, index) => (
              <Button
                key={module.id}
                size="small"
                type={index === 0 ? "primary" : "default"}
                data-testid={
                  index === 0
                    ? "task-assist-confirm-module"
                    : "task-assist-confirm-module-" + String(module.id)
                }
                disabled={disabled}
                onClick={() => onConfirmModule(module.id)}
              >
                {visibleModules.length === 1
                  ? "是，用这个"
                  : "用「" + module.name + "」"}
              </Button>
            ))}
            <Button
              size="small"
              data-testid="task-assist-change-module"
              disabled={disabled}
              onClick={onChangeModule}
            >
              更改
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TaskDraftSummary({
  draft,
  applied,
  hasAssignmentSuggestion,
  onApply,
  onRetry,
}: {
  readonly draft: TaskDraftAssistDraft;
  readonly applied: TaskDraftAssistApplyResult | null;
  readonly hasAssignmentSuggestion: boolean;
  readonly onApply: () => void;
  readonly onRetry: () => void;
}) {
  const rows: { label: string; value: string }[] = [];
  if (draft.title) rows.push({ label: "标题", value: draft.title });
  if (draft.moduleName) {
    rows.push({ label: "建议模块", value: draft.moduleName });
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
            {hasAssignmentSuggestion ? "填入其余字段" : "填入左侧"}
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
    project: message.suggestions?.projects[0]?.name ?? null,
    module: draft.moduleName,
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

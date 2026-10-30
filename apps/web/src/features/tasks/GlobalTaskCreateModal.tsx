import { taskDetailPath, type TaskLocation } from "./task-links";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button } from "antd";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type TaskDraftAssistDraft,
  type TaskEditRequest,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { CalmSelect } from "@features/common/components/CalmSelect";
import {
  CalmDateTimeInput,
  toLocalDateTimeInput,
} from "@features/common/components/CalmDateTimeInput";
import { priorityDotColor } from "@features/common/priority-select-option";
import { projectSelectOption } from "@features/common/project-select-option";
import { useProjects } from "@features/projects/project-query";
import { useModules } from "@features/modules/module-query";
import { isFirstLoad, taskError } from "./task-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import {
  TaskDraftAssistPane,
  type TaskDraftAssistApplyOptions,
  type TaskDraftAssistApplyResult,
} from "./TaskDraftAssistPane";

type Priority = TaskEditRequest["priority"];

const priorityLabels: Record<Priority, string> = {
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};

function linksOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

export interface GlobalTaskCreateModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly client?: InpulseApiClient | undefined;
  /**
   * 从项目页或模块任务页打开时预置归属。传入 moduleId 时项目与模块都锁定为
   * 当前页面归属；只传 projectId 时仍允许用户选择或新建模块。
   */
  readonly preset?:
    | {
        readonly projectId?: number;
        readonly moduleId?: number;
      }
    | undefined;
  readonly onCreated?: (taskId: number) => void;
  readonly onCreatedLocation?: ((task: TaskLocation) => void) | undefined;
}

/**
 * 跨项目新建任务。归属固定为项目 → 模块 → 任务；模块由用户显式选择或与任务
 * 一并创建，指派人列表必须等真实项目归属确定后才能读取。
 */
export function GlobalTaskCreateModal({
  open,
  onClose,
  client,
  preset,
  onCreated,
  onCreatedLocation,
}: GlobalTaskCreateModalProps) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKeys = useRef(new Map<string, string>());

  const [createdLocation, setCreatedLocation] = useState<TaskLocation | null>(
    null,
  );
  const [projectId, setProjectId] = useState(preset?.projectId ?? 0);
  const [moduleId, setModuleId] = useState(preset?.moduleId ?? 0);
  const [newModule, setNewModule] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [linkText, setLinkText] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failedLinks, setFailedLinks] = useState<string[]>([]);
  // 每次重新打开都换一个 key，右侧助手随之清空上一轮对话。
  const [assistResetToken, setAssistResetToken] = useState(0);

  const presetProjectId = preset?.projectId ?? 0;
  const presetModuleId = preset?.moduleId ?? 0;
  const lockedModule = presetModuleId > 0;

  useEffect(() => {
    if (!open) return;
    setAssistResetToken((token) => token + 1);
    setCreatedLocation(null);
    setProjectId(presetProjectId);
    setModuleId(presetModuleId);
    setNewModule("");
    setTitle("");
    setDescription("");
    setPriority("NORMAL");
    setAssigneeIds([]);
    setDueAt(null);
    setLinkText("");
    setInvalid(null);
    setFailedLinks([]);
    retryKeys.current.clear();
  }, [open, presetProjectId, presetModuleId]);

  const projects = useProjects({ client, enabled: open });
  const modules = useModules(open ? projectId : 0, client);

  const lockedModuleName = lockedModule
    ? ((modules.query.data?.items ?? []).find((item) => item.id === moduleId)
        ?.name ?? null)
    : null;

  const targetReady =
    projectId > 0 &&
    (moduleId > 0 || (moduleId === -1 && newModule.trim().length > 0));

  const assignees = useQuery({
    queryKey: ["task-assignees", projectId],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(projectId, { signal }),
    retry: false,
    enabled: open && projectId > 0,
  });

  function keyFor(signature: string): string {
    const existing = retryKeys.current.get(signature);
    if (existing) return existing;
    const created = createIdempotencyKey("task");
    retryKeys.current.set(signature, created);
    return created;
  }

  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const body: TaskEditRequest = {
        title: title.trim(),
        description,
        priority,
        assigneeIds,
        dueAt,
      };
      const init = {
        headers: {
          "x-csrf-token": (await api.issueCsrfToken()).csrfToken,
          "Idempotency-Key": keyFor(
            JSON.stringify([projectId, moduleId, body, newModule]),
          ),
        },
      };
      const created =
        moduleId === -1
          ? await api.createTaskWithScope(
              projectId,
              {
                module: {
                  kind: "new",
                  input: { name: newModule.trim(), description: "" },
                },
                task: body,
              },
              init,
            )
          : await api.createModuleTask(projectId, moduleId, body, init);
      const taskId = "taskId" in created ? created.taskId : created.id;
      const resolvedModuleId =
        "taskId" in created ? created.moduleId : created.moduleId;
      const rejected: string[] = [];
      for (const url of linksOf(linkText)) {
        try {
          const currentLinks = await api.listExternalLinks("TASK", taskId);
          await api.addExternalLink(
            "TASK",
            taskId,
            { url },
            {
              headers: {
                "x-csrf-token": init.headers["x-csrf-token"],
                "If-Match": `"${currentLinks.rowVersion}"`,
                "Idempotency-Key": keyFor(
                  JSON.stringify(["link", taskId, url]),
                ),
              },
            },
          );
        } catch {
          rejected.push(url);
        }
      }
      return {
        taskId,
        rejected,
        location: {
          projectId,
          moduleId: resolvedModuleId,
          taskId,
        } satisfies TaskLocation,
      };
    },
    onSuccess: async ({ taskId, rejected, location }) => {
      retryKeys.current.clear();
      setFailedLinks(rejected);
      setCreatedLocation(location);
      await Promise.all(
        [
          "tasks",
          "task-board",
          "modules",
          "activity",
          "search",
          "notifications",
          "my-tasks",
          "my-task-groups",
          "project-overview",
          "task-groups",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      onCreated?.(taskId);
      if (rejected.length === 0) {
        reset();
        onClose();
        onCreatedLocation?.(location);
      }
    },
  });

  function reset(): void {
    setCreatedLocation(null);
    setNewModule("");
    setTitle("");
    setDescription("");
    setPriority("NORMAL");
    setAssigneeIds([]);
    setDueAt(null);
    setLinkText("");
    setInvalid(null);
    setFailedLinks([]);
  }

  function close(): void {
    if (mutation.isPending) return;
    reset();
    onClose();
  }

  /**
   * AI 只做预填：空字段直接写，已有内容一律不覆盖，并把冲突字段回报给助手面板。
   * 归属先于负责人写入，避免模块切换时把刚识别的成员清掉。
   */
  function applyAssistDraft(
    draft: TaskDraftAssistDraft,
    options: TaskDraftAssistApplyOptions,
  ): TaskDraftAssistApplyResult {
    const conflicts: string[] = [];
    let applied = 0;

    if (draft.title !== null) {
      const current = title.trim();
      if (current.length === 0) {
        setTitle(draft.title);
        applied += 1;
      } else if (current !== draft.title) {
        conflicts.push("标题");
      }
    }

    if (draft.description !== null) {
      const current = description.trim();
      if (current.length === 0) {
        setDescription(draft.description);
        applied += 1;
      } else if (current !== draft.description.trim()) {
        conflicts.push("任务说明");
      }
    }

    if (draft.priority !== null && draft.priority !== priority) {
      if (priority === "NORMAL") {
        setPriority(draft.priority);
        applied += 1;
      } else {
        conflicts.push("优先级");
      }
    }

    if (draft.dueAt !== null) {
      const sameDue =
        dueAt !== null &&
        new Date(dueAt).getTime() === new Date(draft.dueAt).getTime();
      if (!sameDue) {
        if (dueAt === null) {
          setDueAt(draft.dueAt);
          applied += 1;
        } else {
          conflicts.push("截止时间");
        }
      }
    }

    if (options.applyModule && draft.moduleId !== null) {
      if (lockedModule || (moduleId !== 0 && moduleId !== draft.moduleId)) {
        conflicts.push("所属模块");
      } else if (moduleId === 0) {
        setModuleId(draft.moduleId);
        applied += 1;
      }
    }

    if (draft.assigneeIds.length > 0) {
      const sameAssignees =
        assigneeIds.length === draft.assigneeIds.length &&
        assigneeIds.every((id) => draft.assigneeIds.includes(id));
      if (sameAssignees) {
        // 已经一致，不重复计入。
      } else if (assigneeIds.length === 0) {
        setAssigneeIds([...draft.assigneeIds]);
        applied += 1;
      } else {
        conflicts.push("负责人");
      }
    }

    return { applied, conflicts };
  }

  /** 用户点确认卡后才写项目；切换项目时清空模块和负责人，避免跨项目串数据。 */
  function confirmAssistProject(nextProjectId: number): void {
    if (presetProjectId > 0 || nextProjectId === projectId) return;
    setProjectId(nextProjectId);
    setModuleId(0);
    setNewModule("");
    setAssigneeIds([]);
    setInvalid(null);
  }

  /** 用户点确认卡后才写模块；仍走与左侧下拉相同的清空负责人逻辑。 */
  function confirmAssistModule(nextModuleId: number): void {
    if (lockedModule || nextModuleId === moduleId) return;
    setModuleId(nextModuleId);
    setNewModule("");
    setAssigneeIds([]);
    setInvalid(null);
  }

  /** 「更改」只把焦点送回左侧，不替用户做任何选择。 */
  function focusAssistPicker(id: string): void {
    const input = document.getElementById(id);
    if (input === null) return;
    if (typeof input.scrollIntoView === "function") {
      input.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    input.focus({ preventScroll: true });
    const trigger = input.closest(".ant-select");
    if (trigger instanceof HTMLElement) {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (createdLocation || mutation.isPending) return;
    if (!targetReady) {
      setInvalid("请选择任务归属，或填写新模块名称。");
      return;
    }
    if (title.trim().length === 0) {
      setInvalid("请输入任务标题。");
      return;
    }
    if (title.trim().length > 500) {
      setInvalid("任务标题最多 500 字。");
      return;
    }
    if (description.length > 50000) {
      setInvalid("任务说明最多 50000 字。");
      return;
    }
    if (assigneeIds.length === 0) {
      setInvalid("请至少指派一名项目活跃成员作为负责人。");
      return;
    }
    setInvalid(null);
    mutation.mutate();
  }

  const projectName = projects.data?.items.find(
    (project) => project.id === projectId,
  )?.name;

  const busy = mutation.isPending;
  const createError =
    mutation.isError && !(mutation.error instanceof ApiError)
      ? "任务服务暂时不可用，输入已保留，可重试。"
      : mutation.isError
        ? taskError(mutation.error)
        : null;

  return (
    <Modal
      open={open}
      className="catalog-modal task-create-ai"
      size="lg"
      eyebrow={projectName ?? "任务中心"}
      title="新建任务"
      onCancel={close}
      mask={{ closable: !busy }}
      closable={!busy}
    >
      <form className="catalog-form calm-form" onSubmit={submit}>
        <div className="dialog-form task-create-layout">
          <div className="task-create-main">
            {createError && <Alert type="error" title={createError} />}
            {failedLinks.length > 0 && (
              <Alert
                type="warning"
                title={`任务已创建，但 ${failedLinks.length} 个 GitHub 链接未能关联：${failedLinks.join("、")}`}
              />
            )}
            {createdLocation && failedLinks.length > 0 && (
              <a href={taskDetailPath(createdLocation)}>
                查看已创建任务并管理 GitHub 链接
              </a>
            )}
            {invalid && <Alert type="warning" title={invalid} />}

            <fieldset
              className="task-form-fields"
              disabled={busy || createdLocation !== null}
            >
              {lockedModule ? (
                <div className="calm-field">
                  <span className="field-label">所属项目</span>
                  <p className="task-fixed-project">
                    {projectName ?? "正在加载项目…"}
                  </p>
                </div>
              ) : (
                <div className="calm-field">
                  <label htmlFor="global-task-project">所属项目</label>
                  <CalmSelect
                    id="global-task-project"
                    ariaLabel="所属项目"
                    value={projectId}
                    appearance="rich"
                    onChange={(next) => {
                      setProjectId(Number(next));
                      setModuleId(0);
                      setNewModule("");
                      setAssigneeIds([]);
                    }}
                    options={[
                      { value: 0, label: "请选择项目", disabled: true },
                      ...(projects.data?.items ?? []).map(projectSelectOption),
                    ]}
                    animated
                  />
                  {projects.isError && (
                    <p role="alert">项目列表加载失败，请稍后重试。</p>
                  )}
                </div>
              )}

              {lockedModule ? (
                <div className="calm-field">
                  <span className="field-label">所属模块</span>
                  <p className="task-fixed-project">
                    {lockedModuleName ?? "正在加载模块…"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="calm-field">
                    <label htmlFor="global-task-module">所属模块</label>
                    <CalmSelect
                      id="global-task-module"
                      ariaLabel="所属模块"
                      value={moduleId}
                      disabled={projectId === 0}
                      appearance="menu"
                      onChange={(next) => {
                        setModuleId(Number(next));
                        setAssigneeIds([]);
                      }}
                      options={[
                        {
                          value: 0,
                          label:
                            projectId === 0 ? "请先选择项目" : "请选择模块",
                          disabled: true,
                        },
                        { value: -1, label: "自定义 · 创建新模块" },
                        ...(modules.query.data?.items ?? []).map((module) => ({
                          value: module.id,
                          label: module.name,
                        })),
                      ]}
                      animated
                    />
                  </div>
                  {modules.query.isError && (
                    <p role="alert">模块加载失败，请重试。</p>
                  )}
                </>
              )}

              {moduleId === -1 && (
                <div className="calm-field">
                  <label htmlFor="new-module-name">新模块名称</label>
                  <input
                    id="new-module-name"
                    value={newModule}
                    maxLength={200}
                    onChange={(event) => setNewModule(event.target.value)}
                  />
                  <small>提交任务时一起创建。</small>
                </div>
              )}

              <div className="calm-field">
                <label htmlFor="global-task-title">任务标题</label>
                <input
                  id="global-task-title"
                  value={title}
                  maxLength={500}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>

              <div className="calm-field">
                <label htmlFor="global-task-assignee">指派给</label>
                <CalmSelect
                  id="global-task-assignee"
                  value={assigneeIds}
                  onChange={(next) => setAssigneeIds(next.map(Number))}
                  options={(assignees.data?.items ?? []).map((member) => ({
                    value: member.id,
                    label: member.name,
                    avatarUrl: member.avatarUrl ?? null,
                  }))}
                  appearance="member"
                  multiple
                  maxTagCount={2}
                  placeholder={
                    targetReady
                      ? "请选择项目成员（可多选）"
                      : "请先选择任务归属"
                  }
                  disabled={!targetReady}
                  ariaLabel="负责人"
                  animated
                />
                {targetReady && isFirstLoad(assignees) && (
                  <CalmSkeleton
                    variant="list"
                    rows={2}
                    compact
                    label="正在加载项目成员…"
                  />
                )}
                {assignees.isError && (
                  <Alert
                    type="error"
                    title={taskError(assignees.error)}
                    action={
                      <Button
                        className="secondary-button"
                        onClick={() => void assignees.refetch()}
                      >
                        重试项目成员
                      </Button>
                    }
                  />
                )}
              </div>

              <div className="form-row">
                <div className="calm-field">
                  <label htmlFor="global-task-priority">优先级</label>
                  <CalmSelect
                    id="global-task-priority"
                    ariaLabel="优先级"
                    value={priority}
                    appearance="menu"
                    onChange={(next) => setPriority(next as Priority)}
                    options={Object.entries(priorityLabels).map(
                      ([value, label]) => ({
                        value,
                        label,
                        dotColor: priorityDotColor(value),
                      }),
                    )}
                    animated
                  />
                </div>
                <div className="calm-field">
                  <label htmlFor="global-task-due">截止时间</label>
                  <CalmDateTimeInput
                    id="global-task-due"
                    value={toLocalDateTimeInput(dueAt)}
                    onChange={(next) =>
                      setDueAt(
                        next === "" ? null : new Date(next).toISOString(),
                      )
                    }
                  />
                </div>
              </div>

              <div className="calm-field">
                <label htmlFor="global-task-description">任务说明</label>
                <textarea
                  id="global-task-description"
                  rows={3}
                  maxLength={50000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              <div className="calm-field">
                <label htmlFor="global-task-links">GitHub 链接</label>
                <textarea
                  id="global-task-links"
                  rows={2}
                  placeholder="只接受 github.com 的 HTTPS 链接；受限域名会被拒绝。"
                  value={linkText}
                  onChange={(event) => setLinkText(event.target.value)}
                />
              </div>
            </fieldset>
          </div>
          <TaskDraftAssistPane
            key={assistResetToken}
            api={api}
            projectId={projectId}
            moduleId={moduleId}
            disabled={busy || createdLocation !== null}
            projectLocked={presetProjectId > 0}
            moduleLocked={lockedModule}
            onApply={applyAssistDraft}
            onConfirmProject={confirmAssistProject}
            onConfirmModule={confirmAssistModule}
            onChangeProject={() => focusAssistPicker("global-task-project")}
            onChangeModule={() => focusAssistPicker("global-task-module")}
          />
        </div>
        <div className="calm-action-footer">
          <Button className="secondary-button" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button
            className="primary-button"
            htmlType="submit"
            loading={busy}
            disabled={!targetReady || createdLocation !== null}
          >
            创建任务
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { taskDetailPath, type TaskLocation } from "./task-links";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
import {
  CreateProjectModal,
  type ProjectCreationDraft,
} from "@features/projects/CreateProjectModal";
import { useProjects } from "@features/projects/project-query";
import { projectWecomGroupErrorMessage } from "@features/projects/project-wecom-group-query";
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

const CREATE_PROJECT_OPTION = -2;
const CUSTOM_MODULE_OPTION = "自定义 · 创建新模块";

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
  /** 当前用户信息用于把创建者固定在项目成员里。 */
  readonly creatorName?: string | undefined;
  readonly creatorUserId?: number | undefined;
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
  creatorName,
  creatorUserId,
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
  const [creatingModule, setCreatingModule] = useState(false);
  const [newModule, setNewModule] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [linkText, setLinkText] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failedLinks, setFailedLinks] = useState<string[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState<ProjectCreationDraft | null>(
    null,
  );
  const [materializedProjectId, setMaterializedProjectId] = useState<
    number | null
  >(null);
  const [createdProjectNotice, setCreatedProjectNotice] = useState<
    string | null
  >(null);
  const [projectStepBusy, setProjectStepBusy] = useState(false);
  const projectFormId = useId();
  // 每次重新打开都换一个 key，右侧助手随之清空上一轮对话。
  const [assistResetToken, setAssistResetToken] = useState(0);

  const presetProjectId = preset?.projectId ?? 0;
  const presetModuleId = preset?.moduleId ?? 0;
  const lockedModule = presetModuleId > 0;
  const pendingProject = projectDraft !== null;
  /** 项目草稿或已预置模块时锁左侧项目；仅从项目页预置项目仍可切换。 */
  const projectFieldLocked = lockedModule || pendingProject;
  const creatingModuleForNewProject = pendingProject;
  const moduleAssistLocked = lockedModule || creatingModuleForNewProject;
  // 仅预置项目时仍允许用户通过 AI 候选卡切换；预置模块或内联新建项目才锁定。
  const projectAssistLocked = projectFieldLocked;
  const canReturnToProject = pendingProject && materializedProjectId === null;

  useEffect(() => {
    if (!open) return;
    setAssistResetToken((token) => token + 1);
    setCreatedLocation(null);
    setCreatingProject(false);
    setProjectDraft(null);
    setMaterializedProjectId(null);
    setCreatedProjectNotice(null);
    setProjectStepBusy(false);
    setProjectId(presetProjectId);
    setModuleId(presetModuleId);
    setCreatingModule(false);
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

  const targetReady = pendingProject
    ? newModule.trim().length > 0
    : projectId > 0 &&
      (moduleId > 0 || (creatingModule && newModule.trim().length > 0));

  const assignees = useQuery({
    queryKey: ["task-assignees", projectId],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(projectId, { signal }),
    retry: false,
    enabled: open && projectId > 0 && !pendingProject,
  });

  const taskAssigneeOptions =
    projectDraft === null
      ? (assignees.data?.items ?? []).map((member) => ({
          value: member.id,
          label: member.name,
          avatarUrl: member.avatarUrl ?? null,
        }))
      : projectDraft.assignees.map((member) => ({
          value: member.id,
          label: member.name,
        }));

  function keyFor(signature: string, prefix = "task"): string {
    const existing = retryKeys.current.get(signature);
    if (existing) return existing;
    const created = createIdempotencyKey(prefix);
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
      const csrfToken = (await api.issueCsrfToken()).csrfToken;
      let resolvedProjectId = materializedProjectId ?? projectId;
      if (projectDraft !== null && resolvedProjectId <= 0) {
        const createdProject = await api.createProject(projectDraft.request, {
          headers: {
            "x-csrf-token": csrfToken,
            "Idempotency-Key": keyFor(
              JSON.stringify(["create-project", projectDraft.request]),
              "create-project",
            ),
          },
        });
        resolvedProjectId = createdProject.project.id;
        setMaterializedProjectId(resolvedProjectId);
        void cache.invalidateQueries({ queryKey: ["projects"] });
      }
      if (resolvedProjectId <= 0) {
        throw new Error("missing-project");
      }
      const init = {
        headers: {
          "x-csrf-token": csrfToken,
          "Idempotency-Key": keyFor(
            JSON.stringify([
              resolvedProjectId,
              moduleId,
              creatingModule,
              body,
              newModule,
            ]),
          ),
        },
      };
      const createNewModule = projectDraft !== null || creatingModule;
      const created = createNewModule
        ? await api.createTaskWithScope(
            resolvedProjectId,
            {
              module: {
                kind: "new",
                input: { name: newModule.trim(), description: "" },
              },
              task: body,
            },
            init,
          )
        : await api.createModuleTask(resolvedProjectId, moduleId, body, init);
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
                "x-csrf-token": csrfToken,
                "If-Match": JSON.stringify(String(currentLinks.rowVersion)),
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
      let notice: string | null = null;
      if (projectDraft !== null && projectDraft.webhook !== null) {
        const webhook = projectDraft.webhook;
        try {
          await api.createProjectWecomWebhook(resolvedProjectId, webhook, {
            headers: {
              "x-csrf-token": csrfToken,
              "Idempotency-Key": keyFor(
                JSON.stringify(["create-project-webhook", resolvedProjectId]),
              ),
            },
          });
        } catch (error) {
          notice =
            "项目与任务已创建，但企业微信群 Webhook 未添加：" +
            projectWecomGroupErrorMessage(error) +
            "可稍后在项目「消息通知」中重试。";
        }
      }
      return {
        taskId,
        rejected,
        notice,
        location: {
          projectId: resolvedProjectId,
          moduleId: resolvedModuleId,
          taskId,
        } satisfies TaskLocation,
      };
    },
    onSuccess: async ({ taskId, rejected, notice, location }) => {
      retryKeys.current.clear();
      setFailedLinks(rejected);
      setCreatedProjectNotice(notice);
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
          "projects",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      onCreated?.(taskId);
      if (rejected.length === 0 && notice === null) {
        reset();
        onClose();
        onCreatedLocation?.(location);
      }
    },
  });

  function reset(): void {
    setCreatedLocation(null);
    setCreatingProject(false);
    setProjectDraft(null);
    setMaterializedProjectId(null);
    setCreatedProjectNotice(null);
    setProjectStepBusy(false);
    setCreatingModule(false);
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
    if (mutation.isPending || projectStepBusy) return;
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
          setDueAt(new Date(draft.dueAt).toISOString());
          applied += 1;
        } else {
          conflicts.push("截止时间");
        }
      }
    }

    if (options.applyModule && draft.moduleId !== null) {
      if (
        moduleAssistLocked ||
        creatingModule ||
        (moduleId !== 0 && moduleId !== draft.moduleId)
      ) {
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
    if (projectAssistLocked || nextProjectId === projectId) return;
    setProjectId(nextProjectId);
    setModuleId(0);
    setCreatingModule(false);
    setNewModule("");
    setAssigneeIds([]);
    setInvalid(null);
  }

  /** 用户点确认卡后才写模块；仍走与左侧下拉相同的清空负责人逻辑。 */
  function confirmAssistModule(nextModuleId: number): void {
    if (moduleAssistLocked || nextModuleId === moduleId) return;
    setModuleId(nextModuleId);
    setCreatingModule(false);
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

  function handleProjectSelect(nextValue: number | string): void {
    const next = Number(nextValue);
    if (next === CREATE_PROJECT_OPTION) {
      setCreatingProject(true);
      setProjectDraft(null);
      setMaterializedProjectId(null);
      setProjectId(0);
      setModuleId(0);
      setCreatingModule(false);
      setNewModule("");
      setAssigneeIds([]);
      setCreatedProjectNotice(null);
      setInvalid(null);
      return;
    }
    setProjectId(next);
    setModuleId(0);
    setCreatingModule(false);
    setNewModule("");
    setAssigneeIds([]);
  }

  function handleProjectDraft(draft: ProjectCreationDraft): void {
    const allowedAssigneeIds = new Set(draft.assignees.map((item) => item.id));
    setProjectDraft(draft);
    setProjectId(0);
    setModuleId(0);
    setCreatingModule(false);
    setMaterializedProjectId(null);
    setCreatingProject(false);
    setProjectStepBusy(false);
    setAssigneeIds((current) =>
      current.filter((assigneeId) => allowedAssigneeIds.has(assigneeId)),
    );
    setCreatedProjectNotice(null);
    setInvalid(null);
  }

  function returnToTaskForm(): void {
    if (projectStepBusy) return;
    setCreatingProject(false);
    setInvalid(null);
  }

  function returnToProjectForm(): void {
    if (mutation.isPending || projectStepBusy || !canReturnToProject) return;
    setCreatingProject(true);
    setInvalid(null);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (createdLocation || mutation.isPending) return;
    if (!targetReady) {
      setInvalid(
        pendingProject
          ? "请填写所属模块名称。"
          : "请选择任务归属，或填写模块名称。",
      );
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

  const projectName =
    projectDraft?.request.name ??
    projects.data?.items.find((project) => project.id === projectId)?.name;

  const busy = mutation.isPending || projectStepBusy;
  const baseCreateError =
    mutation.isError && !(mutation.error instanceof ApiError)
      ? "任务服务暂时不可用，输入已保留，可重试。"
      : mutation.isError
        ? taskError(mutation.error)
        : null;
  const createError = mutation.isError
    ? materializedProjectId !== null
      ? "项目已创建，但任务创建失败。" + (baseCreateError ?? "")
      : baseCreateError
    : null;

  return (
    <Modal
      open={open}
      className={
        creatingProject
          ? "catalog-modal task-create-modal task-create-project"
          : "catalog-modal task-create-modal task-create-ai"
      }
      size="lg"
      eyebrow={creatingProject ? "任务中心" : (projectName ?? "任务中心")}
      title={creatingProject ? "新建项目" : "新建任务"}
      onCancel={close}
      mask={{ closable: !busy }}
      closable={!busy}
      footer={
        creatingProject ? (
          <>
            <Button disabled={projectStepBusy} onClick={returnToTaskForm}>
              返回任务
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              form={projectFormId}
              loading={projectStepBusy}
            >
              下一步
            </Button>
          </>
        ) : undefined
      }
    >
      {creatingProject ? (
        <CreateProjectModal
          inline
          open={open}
          formId={projectFormId}
          client={api}
          creatorName={creatorName ?? "创建者"}
          creatorUserId={creatorUserId}
          deferCreation
          initialDraft={projectDraft}
          onDraftReady={handleProjectDraft}
          onCreated={() => undefined}
          onClose={returnToTaskForm}
          onBusyChange={setProjectStepBusy}
        />
      ) : (
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
              {createdLocation &&
                (failedLinks.length > 0 || createdProjectNotice !== null) && (
                  <a href={taskDetailPath(createdLocation)}>查看已创建任务</a>
                )}
              {createdProjectNotice && (
                <Alert type="warning" title={createdProjectNotice} />
              )}
              {invalid && <Alert type="warning" title={invalid} />}

              <fieldset
                className="task-form-fields"
                disabled={busy || createdLocation !== null}
              >
                {projectFieldLocked ? (
                  <div className="calm-field">
                    <span className="field-label required-field">所属项目</span>
                    <p className="task-fixed-project">
                      {projectName ?? "正在加载项目…"}
                    </p>
                  </div>
                ) : (
                  <div className="calm-field">
                    <label
                      className="required-field"
                      htmlFor="global-task-project"
                    >
                      所属项目
                    </label>
                    <CalmSelect
                      id="global-task-project"
                      ariaLabel="所属项目"
                      value={projectId}
                      appearance="rich"
                      loading={projects.isPending}
                      onChange={handleProjectSelect}
                      options={[
                        { value: 0, label: "请选择项目", disabled: true },
                        {
                          value: CREATE_PROJECT_OPTION,
                          label: "自定义 · 创建新项目",
                          iconText: "＋",
                          description: "先填写项目，再继续任务，最后一起创建",
                        },
                        ...(projects.data?.items ?? []).map(
                          projectSelectOption,
                        ),
                      ]}
                      animated
                    />
                    {projects.isError && (
                      <p role="alert">项目列表加载失败，请稍后重试。</p>
                    )}
                  </div>
                )}

                {creatingModuleForNewProject ? (
                  <div className="calm-field">
                    <label className="required-field" htmlFor="new-module-name">
                      所属模块名称
                    </label>
                    <input
                      id="new-module-name"
                      value={newModule}
                      maxLength={200}
                      placeholder="请输入模块名称"
                      onChange={(event) => setNewModule(event.target.value)}
                    />
                    <small>提交任务时一起创建。</small>
                  </div>
                ) : lockedModule ? (
                  <div className="calm-field">
                    <span className="field-label required-field">所属模块</span>
                    <p className="task-fixed-project">
                      {lockedModuleName ?? "正在加载模块…"}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="calm-field">
                      <label
                        className="required-field"
                        htmlFor="global-task-module"
                      >
                        所属模块
                      </label>
                      <CalmSelect
                        id="global-task-module"
                        ariaLabel="所属模块"
                        value={creatingModule ? CUSTOM_MODULE_OPTION : moduleId}
                        disabled={projectId === 0}
                        loading={projectId > 0 && modules.query.isPending}
                        appearance="menu"
                        onChange={(next) => {
                          if (next === CUSTOM_MODULE_OPTION) {
                            setModuleId(0);
                            setCreatingModule(true);
                          } else {
                            setModuleId(Number(next));
                            setCreatingModule(false);
                          }
                          setAssigneeIds([]);
                        }}
                        options={[
                          {
                            value: 0,
                            label:
                              projectId === 0 ? "请先选择项目" : "请选择模块",
                            disabled: true,
                          },
                          {
                            value: CUSTOM_MODULE_OPTION,
                            label: CUSTOM_MODULE_OPTION,
                          },
                          ...(modules.query.data?.items ?? []).map(
                            (module) => ({
                              value: module.id,
                              label: module.name,
                            }),
                          ),
                        ]}
                        animated
                      />
                    </div>
                    {modules.query.isError && (
                      <p role="alert">模块加载失败，请重试。</p>
                    )}
                    {creatingModule && (
                      <div className="calm-field">
                        <label
                          className="required-field"
                          htmlFor="new-module-name"
                        >
                          新模块名称
                        </label>
                        <input
                          id="new-module-name"
                          value={newModule}
                          maxLength={200}
                          onChange={(event) => setNewModule(event.target.value)}
                        />
                        <small>提交任务时一起创建。</small>
                      </div>
                    )}
                  </>
                )}

                <div className="calm-field">
                  <label className="required-field" htmlFor="global-task-title">
                    任务标题
                  </label>
                  <input
                    id="global-task-title"
                    value={title}
                    maxLength={500}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </div>

                <div className="calm-field">
                  <label
                    className="required-field"
                    htmlFor="global-task-assignee"
                  >
                    指派给
                  </label>
                  <CalmSelect
                    id="global-task-assignee"
                    value={assigneeIds}
                    onChange={(next) => setAssigneeIds(next.map(Number))}
                    options={taskAssigneeOptions}
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
                  {!pendingProject && targetReady && isFirstLoad(assignees) && (
                    <CalmSkeleton
                      variant="list"
                      rows={2}
                      compact
                      label="正在加载项目成员…"
                    />
                  )}
                  {!pendingProject && assignees.isError && (
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
              projectLocked={projectAssistLocked}
              moduleLocked={moduleAssistLocked}
              onApply={applyAssistDraft}
              onConfirmProject={confirmAssistProject}
              onConfirmModule={confirmAssistModule}
              onChangeProject={() => focusAssistPicker("global-task-project")}
              onChangeModule={() => focusAssistPicker("global-task-module")}
            />
          </div>
          <div className="calm-action-footer">
            {canReturnToProject && (
              <Button
                className="secondary-button"
                onClick={returnToProjectForm}
                disabled={busy}
              >
                返回修改项目
              </Button>
            )}
            <Button
              className="secondary-button"
              onClick={close}
              disabled={busy}
            >
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
      )}
    </Modal>
  );
}

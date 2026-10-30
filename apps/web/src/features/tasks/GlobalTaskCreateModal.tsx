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
import { CalmSegmented } from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import {
  CalmDateTimeInput,
  toLocalDateTimeInput,
} from "@features/common/components/CalmDateTimeInput";
import { priorityDotColor } from "@features/common/priority-select-option";
import { projectSelectOption } from "@features/common/project-select-option";
import { useProjects } from "@features/projects/project-query";
import { useModules } from "@features/modules/module-query";
import { useFeatures } from "@features/features/feature-query";
import { isFirstLoad, taskError } from "./task-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import {
  TaskDraftAssistPane,
  type TaskDraftAssistApplyResult,
} from "./TaskDraftAssistPane";

/** 任务范围与后端路由一一对应：功能级走功能任务，模块级走模块任务。 */
type TaskScope = "FEATURE" | "MODULE";
type Priority = TaskEditRequest["priority"];

const priorityLabels: Record<Priority, string> = {
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};
const scopeOptions: ReadonlyArray<{ value: TaskScope; label: string }> = [
  { value: "FEATURE", label: "功能级" },
  { value: "MODULE", label: "模块级" },
];

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
  /** 从项目/模块/功能页面打开时预置归属，避免用户重复选择。 */
  readonly preset?:
    | {
        readonly projectId?: number;
        readonly moduleId?: number;
        readonly featureId?: number;
      }
    | undefined;
  /**
   * 调用它的页面已经固定任务范围时传值：隐藏「任务范围」分段控件并锁定该范围，
   * 其余字段与任务中心完全一致。
   */
  readonly lockedScope?: TaskScope | undefined;
  readonly onCreated?: (taskId: number) => void;
  readonly onCreatedLocation?: ((task: TaskLocation) => void) | undefined;
}

/**
 * 跨项目新建任务。归属由用户显式选择后再启用表单，
 * 因为指派人列表与影响功能选项都必须先确定真实归属才能读取。
 */
export function GlobalTaskCreateModal({
  open,
  onClose,
  client,
  preset,
  lockedScope,
  onCreated,
  onCreatedLocation,
}: GlobalTaskCreateModalProps) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const retryKeys = useRef(new Map<string, string>());

  const [scope, setScope] = useState<TaskScope>(
    lockedScope ??
      (preset?.featureId ? "FEATURE" : preset?.moduleId ? "MODULE" : "FEATURE"),
  );
  const [projectId, setProjectId] = useState<number>(preset?.projectId ?? 0);
  const [moduleId, setModuleId] = useState<number>(preset?.moduleId ?? 0);
  const [featureId, setFeatureId] = useState<number>(preset?.featureId ?? 0);
  const [createdLocation, setCreatedLocation] = useState<TaskLocation | null>(
    null,
  );
  const [newModule, setNewModule] = useState("");
  const [newFeature, setNewFeature] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [impactFeatureIds, setImpactFeatureIds] = useState<number[]>([]);
  const [linkText, setLinkText] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failedLinks, setFailedLinks] = useState<string[]>([]);
  // 每次重新打开都换一个 key，右侧助手随之清空上一轮对话。
  const [assistResetToken, setAssistResetToken] = useState(0);

  const presetProjectId = preset?.projectId ?? 0;
  const presetModuleId = preset?.moduleId ?? 0;
  const presetFeatureId = preset?.featureId ?? 0;

  useEffect(() => {
    if (!open) return;
    setAssistResetToken((token) => token + 1);
    setCreatedLocation(null);
    setScope(
      lockedScope ??
        (presetFeatureId ? "FEATURE" : presetModuleId ? "MODULE" : "FEATURE"),
    );
    setProjectId(presetProjectId);
    setModuleId(presetModuleId);
    // 模块级任务不指定所属功能：锁定为模块级时清掉可能预置的功能归属。
    setFeatureId(lockedScope === "MODULE" ? 0 : presetFeatureId);
    setNewModule("");
    setNewFeature("");
    setTitle("");
    setDescription("");
    setPriority("NORMAL");
    setAssigneeIds([]);
    setDueAt(null);
    setImpactFeatureIds([]);
    setLinkText("");
    setInvalid(null);
    setFailedLinks([]);
    retryKeys.current.clear();
  }, [open, presetProjectId, presetModuleId, presetFeatureId, lockedScope]);

  const projects = useProjects({ client, enabled: open });
  const modules = useModules(open ? projectId : 0, client);
  const features = useFeatures(
    open ? projectId : 0,
    moduleId,
    undefined,
    client,
  );

  // 锁定模块级的页面（模块任务列表）已由路由固定模块：与所属项目一样只回显名称，
  // 不再让用户重选（2026-09-24 产品反馈）。
  const lockedModule = lockedScope === "MODULE";
  const lockedModuleName = lockedModule
    ? ((modules.query.data?.items ?? []).find((item) => item.id === moduleId)
        ?.name ?? null)
    : null;

  const targetReady =
    projectId > 0 &&
    (moduleId > 0 || (moduleId === -1 && newModule.trim().length > 0)) &&
    (scope === "MODULE" ||
      featureId > 0 ||
      (featureId === -1 && newFeature.trim().length > 0));

  const assignees = useQuery({
    queryKey: [
      "task-assignees",
      projectId,
      moduleId,
      scope === "MODULE" ? null : featureId,
    ],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(projectId, { signal }),
    retry: false,
    enabled: open && projectId > 0,
  });

  const impactOptions = useQuery({
    queryKey: ["task-impact-options", projectId, moduleId],
    queryFn: ({ signal }) => api.listFeatures(projectId, moduleId, { signal }),
    retry: false,
    enabled: open && scope === "MODULE" && projectId > 0 && moduleId > 0,
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
      const impacts = [...new Set(impactFeatureIds)].sort((a, b) => a - b);
      const init = {
        headers: {
          "x-csrf-token": (await api.issueCsrfToken()).csrfToken,
          "Idempotency-Key": keyFor(
            JSON.stringify([
              projectId,
              moduleId,
              featureId,
              scope,
              body,
              impacts,
              newModule,
              newFeature,
            ]),
          ),
        },
      };
      const createdScope =
        moduleId === -1 || (scope === "FEATURE" && featureId === -1)
          ? await api.createTaskWithScope(
              projectId,
              {
                module:
                  moduleId === -1
                    ? {
                        kind: "new",
                        input: { name: newModule.trim(), description: "" },
                      }
                    : { kind: "existing", id: moduleId },
                feature:
                  scope === "MODULE"
                    ? null
                    : featureId === -1
                      ? {
                          kind: "new",
                          input: {
                            name: newFeature.trim(),
                            currentBehavior: "",
                            acceptanceCriteria: "",
                            tags: [],
                          },
                        }
                      : { kind: "existing", id: featureId },
                task: body,
                impactFeatureIds: scope === "MODULE" ? impacts : [],
              },
              init,
            )
          : null;
      const task = createdScope
        ? { id: createdScope.taskId }
        : scope === "MODULE"
          ? await api.createModuleTask(
              projectId,
              moduleId,
              { ...body, impactFeatureIds: impacts },
              init,
            )
          : await api.createTask(projectId, moduleId, featureId, body, init);
      // 关联链接是创建后的独立写入：任务已落库时只报告未成功的链接，
      // 不用回滚任务，避免用户丢失已填写的表单。
      const rejected: string[] = [];
      for (const url of linksOf(linkText)) {
        try {
          const currentLinks = await api.listExternalLinks("TASK", task.id);
          await api.addExternalLink(
            "TASK",
            task.id,
            { url },
            {
              headers: {
                "x-csrf-token": init.headers["x-csrf-token"],
                "If-Match": `"${currentLinks.rowVersion}"`,
                "Idempotency-Key": keyFor(
                  JSON.stringify(["link", task.id, url]),
                ),
              },
            },
          );
        } catch {
          rejected.push(url);
        }
      }
      return {
        task,
        rejected,
        location: createdScope ?? {
          projectId,
          moduleId,
          featureId: scope === "MODULE" ? null : featureId,
          taskId: task.id,
        },
      };
    },
    onSuccess: async ({ task, rejected, location }) => {
      retryKeys.current.clear();
      setFailedLinks(rejected);
      setCreatedLocation(location);
      await Promise.all(
        [
          "tasks",
          "task-board",
          "modules",
          "features",
          "activity",
          "search",
          "notifications",
          "my-tasks",
          "my-task-groups",
          "project-overview",
          "task-groups",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      // 任务已经落库，无论链接是否全部关联成功都要通知调用方；
      // 只有全部成功才自动关闭，否则保留弹窗让用户看到失败明细。
      onCreated?.(task.id);
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
    setNewFeature("");
    setTitle("");
    setDescription("");
    setPriority("NORMAL");
    setAssigneeIds([]);
    setDueAt(null);
    setImpactFeatureIds([]);
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

    let nextModuleId = moduleId;
    if (draft.moduleId !== null) {
      if (moduleId === 0) {
        setModuleId(draft.moduleId);
        nextModuleId = draft.moduleId;
        applied += 1;
      } else if (moduleId !== draft.moduleId) {
        conflicts.push("所属模块");
      }
    }

    if (draft.featureId !== null) {
      if (lockedScope === "MODULE") {
        conflicts.push("所属功能");
      } else if (nextModuleId !== (draft.moduleId ?? 0)) {
        // 模块已经另有归属，功能不能再跨模块写入。
        conflicts.push("所属功能");
      } else if (featureId === 0) {
        setScope("FEATURE");
        setFeatureId(draft.featureId);
        applied += 1;
      } else if (featureId !== draft.featureId) {
        conflicts.push("所属功能");
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

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (createdLocation || mutation.isPending) return;
    if (!targetReady) {
      setInvalid("请选择任务归属，或填写自定义模块、功能名称。");
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
  /** 影响功能只有在模块确定后才能读选项；自定义新建模块同理不可选。 */
  const impactPlaceholder =
    moduleId === -1
      ? "新建模块暂不支持影响功能"
      : moduleId === 0
        ? "请先选择模块"
        : "可多选，可为空";

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
              {lockedScope ? (
                // 页面已经固定归属：项目只回显名称，不再让用户重选（2026-09-24 产品反馈）。
                <div className="calm-field">
                  <span className="field-label">所属项目</span>
                  <p className="task-fixed-project">
                    {projectName ?? "正在加载项目…"}
                  </p>
                </div>
              ) : null}
              {lockedModule ? (
                <div className="calm-field">
                  <span className="field-label">所属模块</span>
                  <p className="task-fixed-project">
                    {lockedModuleName ?? "正在加载模块…"}
                  </p>
                </div>
              ) : null}
              <div className="calm-field">
                <label htmlFor="global-task-title">任务标题</label>
                <input
                  id="global-task-title"
                  value={title}
                  maxLength={500}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>

              {lockedScope ? null : (
                <div className="calm-field">
                  <span
                    className="field-label"
                    title="功能级：推进一个具体功能；模块级：跨功能或模块整体工作。"
                  >
                    任务范围
                  </span>
                  <CalmSegmented
                    label="任务范围"
                    options={scopeOptions}
                    value={scope}
                    onChange={(next) => {
                      setScope(next);
                      setAssigneeIds([]);
                      if (next === "MODULE") setFeatureId(0);
                    }}
                  />
                </div>
              )}

              {/* 锁定归属时项目已由上面的只读行给出，这里不再渲染选择器。 */}
              {lockedScope ? null : (
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
                      setFeatureId(0);
                      setAssigneeIds([]);
                      setImpactFeatureIds([]);
                    }}
                    options={[
                      // 占位项只作提示，禁用以防用户主动选回「未选择」清掉归属（2026-09-22 产品反馈）。
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

              {/* 锁定模块级时模块已由上面的只读行给出，这里不再渲染选择器。 */}
              {lockedModule ? null : (
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
                      setFeatureId(Number(next) === -1 ? -1 : 0);
                      setAssigneeIds([]);
                      setImpactFeatureIds([]);
                    }}
                    options={[
                      {
                        value: 0,
                        label: projectId === 0 ? "请先选择项目" : "请选择模块",
                        disabled: true,
                      },
                      { value: -1, label: "自定义 · 创建新模块" },
                      // ADR-044：模块已无归档只读态，模块选项全部可选。
                      ...(modules.query.data?.items ?? []).map((module) => ({
                        value: module.id,
                        label: module.name,
                      })),
                    ]}
                    animated
                  />
                </div>
              )}

              {moduleId === -1 && (
                <div className="calm-field">
                  <label htmlFor="new-module-name">新模块名称</label>
                  <input
                    id="new-module-name"
                    value={newModule}
                    maxLength={200}
                    onChange={(e) => setNewModule(e.target.value)}
                  />
                  <small>提交任务时一起创建。</small>
                </div>
              )}
              {modules.query.isError && (
                <p role="alert">模块加载失败，请重试。</p>
              )}

              {scope === "MODULE" && (
                // 2026-09-24 产品反馈：影响功能紧跟在所属模块下面，并用下拉多选与其它归属选择器同一交互。
                <div className="calm-field">
                  <label htmlFor="global-task-impact-features">影响功能</label>
                  <CalmSelect
                    id="global-task-impact-features"
                    ariaLabel="影响功能"
                    value={impactFeatureIds}
                    multiple
                    maxTagCount={2}
                    appearance="menu"
                    placeholder={impactPlaceholder}
                    disabled={moduleId <= 0}
                    loading={moduleId > 0 && isFirstLoad(impactOptions)}
                    onChange={(next) =>
                      setImpactFeatureIds(
                        [...new Set(next.map(Number))].sort((a, b) => a - b),
                      )
                    }
                    options={(impactOptions.data?.items ?? []).map(
                      (feature) => ({
                        value: feature.id,
                        label: feature.name,
                      }),
                    )}
                    animated
                  />
                  {impactOptions.isError && (
                    <Alert
                      type="error"
                      title={taskError(impactOptions.error)}
                      action={
                        <Button
                          className="secondary-button"
                          onClick={() => void impactOptions.refetch()}
                        >
                          重试影响功能
                        </Button>
                      }
                    />
                  )}
                </div>
              )}

              {scope === "FEATURE" && (
                <div className="calm-field">
                  <label htmlFor="global-task-feature">所属功能</label>
                  <CalmSelect
                    id="global-task-feature"
                    ariaLabel="所属功能"
                    value={featureId}
                    disabled={moduleId === 0}
                    appearance="menu"
                    onChange={(next) => {
                      setFeatureId(Number(next));
                      setAssigneeIds([]);
                    }}
                    options={[
                      {
                        value: 0,
                        label: moduleId === 0 ? "请先选择模块" : "请选择功能",
                        disabled: true,
                      },
                      { value: -1, label: "自定义 · 创建新功能" },
                      ...(features.query.data?.items ?? []).map((feature) => ({
                        value: feature.id,
                        label: feature.name,
                      })),
                    ]}
                    animated
                  />
                </div>
              )}

              {scope === "FEATURE" && featureId === -1 && (
                <div className="calm-field">
                  <label htmlFor="new-feature-name">新功能名称</label>
                  <input
                    id="new-feature-name"
                    value={newFeature}
                    maxLength={500}
                    onChange={(e) => setNewFeature(e.target.value)}
                  />
                  <small>
                    提交任务时一起创建，稍后可在功能档案补充说明与验收标准。
                  </small>
                </div>
              )}
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
                  rows={4}
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
                  placeholder="每行一个链接，可选"
                  value={linkText}
                  onChange={(event) => setLinkText(event.target.value)}
                />
                <p>只接受 github.com 的 HTTPS 链接；受限域名会被拒绝。</p>
              </div>
            </fieldset>
          </div>
          <TaskDraftAssistPane
            key={assistResetToken}
            api={api}
            projectId={projectId}
            moduleId={moduleId}
            featureId={featureId}
            disabled={busy || createdLocation !== null}
            onApply={applyAssistDraft}
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

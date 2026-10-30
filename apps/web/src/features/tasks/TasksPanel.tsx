import { GlobalTaskCreateModal } from "./GlobalTaskCreateModal";
import { taskDetailPath, type TaskLocation } from "./task-links";
import {
  DETACHED_ASSIGNEE_HINT,
  detachedAssigneeTitle,
  isDetachedAssignee,
  withDetachedMark,
} from "./detached-assignee";
import { TaskOriginFacts } from "./task-origin";
import { ExternalLinksPanel } from "@features/external-links/ExternalLinksPanel";
import { MergeIntoMainTaskModal } from "@features/task-groups/MergeIntoMainTaskModal";
import { TaskGroupDetailModal } from "@features/task-groups/TaskGroupDetailModal";
import { createTaskGroupServerAdapter } from "@features/task-groups/task-groups-server";
import {
  RecordDetailModal,
  type RecordDetailTarget,
} from "@features/published-records/RecordDetailModal";
import {
  RecordDraftEditorModal,
  type RecordDraftEditorTarget,
} from "@features/record-drafts/RecordDraftEditorModal";
import { useNavigate } from "react-router-dom";
import { LeftoverTaskSource } from "./LeftoverTaskSource";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { TaskStatusPanel } from "./TaskStatusPanel";
import { useTaskMarks, type TaskMark } from "./task-marks";
import { prefetchModulesRoute } from "@features/modules/module-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input } from "antd";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import {
  preloadRoutePath,
  routePreloadHandlers,
} from "@shared/routing/route-preload";
import { AppModal as Modal } from "@features/common/components/AppModal";
import {
  CalmDateTimeInput,
  toLocalDateTimeInput,
} from "@features/common/components/CalmDateTimeInput";
import { Controller, useForm } from "react-hook-form";
import {
  ApiError,
  type InpulseApiClient,
  type PublishedRecord,
  type ReadableRecord,
  type TaskStatusRequest,
} from "@generated/api";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { SuccessToast } from "@features/common/components/SuccessToast";
import {
  beijingTodayStart,
  formatBeijingDate,
  formatBeijingMinute,
} from "@features/common/beijing-time";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSegmented,
  CalmTabs,
} from "@features/common/components/Calm";
import {
  CalmSelect,
  type CalmSelectOption,
} from "@features/common/components/CalmSelect";
import { priorityDotColor } from "@features/common/priority-select-option";
import { taskToneClassName } from "@features/common/task-tone";
import {
  isFirstLoad,
  mergeTask,
  taskEdit,
  taskError,
  useTasks,
  type TaskScope,
  type TaskField,
  type TaskViewItem,
  type TaskDraft,
} from "./task-query";
import { isCardClick } from "@features/common/card-click";
import { useUserDirectoryQuery } from "@features/users/user-directory-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

const labels: Record<TaskField, string> = {
  title: "任务标题",
  description: "任务说明",
  priority: "优先级",
  assigneeIds: "负责人",
  dueAt: "截止时间",
};
const priorityLabels = {
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};
const statusLabels = { TODO: "未完成", DONE: "已完成", CANCELED: "已取消" };
/* 优先级徽章色调与 task-tone.ts 的 taskPriorityBadgeTone 同源：紧急红 / 高金（amber）/
   普通淡蓝（2026-09-23 九次配色定案，与「进行中」同一套蓝）。 */
const priorityTone = {
  NORMAL: "blue",
  HIGH: "amber",
  URGENT: "red",
} as const;
const statusTone = {
  TODO: "blue",
  DONE: "green",
  CANCELED: "gray",
} as const;
export const taskStatusFilterOptions: readonly CalmSelectOption[] = [
  { value: "TODO", label: "未完成", dotColor: "#1467d8" },
  { value: "DONE", label: "已完成", dotColor: "#4a9278" },
  { value: "ALL", label: "全部状态" },
];
const empty: TaskDraft = {
  title: "",
  description: "",
  priority: "NORMAL",
  assigneeIds: [],
  dueAt: null,
};
type Merge = ReturnType<typeof mergeTask> & {
  latest: TaskViewItem;
  choices: Partial<Record<TaskField, "draft" | "latest">>;
};
/**
 * C-1 关系徽章：groupRole 为 null 表示未加入 ACTIVE 聚合组（未入组），
 * 徽章与「查看主任务」入口一并隐藏；数据来自页面级一次批量 R-5 调用。
 */
function relationBadge(mark: TaskMark | undefined): {
  readonly label: "主任务" | "分支任务";
  readonly tone: "violet" | "cyan";
  readonly title: string;
} | null {
  if (mark?.groupRole === "MAIN")
    return { label: "主任务", tone: "violet", title: "聚合组统一入口" };
  if (mark?.groupRole === "SOURCE")
    return {
      label: "分支任务",
      tone: "cyan",
      title: "分支任务，保留原始状态与历史",
    };
  return null;
}
/**
 * 裁决修订 D-2：由遗留问题转换而来的任务在卡片、列表与详情统一显示「遗留问题」
 * 徽章；数据来自 R-5 批量标记（hasLeftoverSource），读取失败时按缺席隐藏。
 */
const LEFTOVER_SOURCE_BADGE = {
  label: "遗留问题",
  tone: "leftover",
  title: "由遗留问题转换而来的跟进任务",
} as const;
/** 一律按北京时间渲染服务端时间串，避免在非 +8 环境显示成另一天。 */
const formatDate = (value: string | null) =>
  value ? formatBeijingMinute(value) : "未设置";
const formatDay = (value: string | null) =>
  value ? formatBeijingDate(value) : "日期不可用";
const dueLabel = (value: string | null) =>
  value ? "截止 " + formatDate(value) : "未设置截止";
/**
 * 任务详情的迭代记录列表只给摘要：整行可点开记录详情弹窗（与聚合组记录列表
 * 同一实现），正文不在列表里预加载。
 */
function recordDetailTarget(record: ReadableRecord): RecordDetailTarget {
  return {
    recordId: record.id,
    code: record.code,
    title: record.title,
    recordStatus: record.status,
    publishedAt: record.publishedAt,
  };
}
type DetailTab = "info" | "records" | "branches";
/**
 * C-3：任务详情弹窗动作行的截止徽章（设计师稿 dueInfo）：按本地日历日计算
 * 与今天的差值，色调映射 calm-due 的 due-* 色板；已完成/已取消不提示逾期。
 * 2026-09-22 起只驱动日期徽章 / 截止列的文字色，不再决定卡片底色。
 */
function dueInfo(
  value: string | null,
  workStatus: TaskViewItem["workStatus"],
): {
  label: string;
  tone: "gray" | "red" | "amber" | "blue";
} {
  if (value === null) return { label: "未设置截止", tone: "gray" };
  if (workStatus === "DONE") return { label: "已完成", tone: "gray" };
  if (workStatus === "CANCELED") return { label: "已取消", tone: "gray" };
  const days = Math.round(
    (beijingTodayStart(new Date(value)) - beijingTodayStart()) / 86_400_000,
  );
  if (days < 0)
    return { label: "已逾期 " + Math.abs(days) + "天", tone: "red" };
  if (days === 0) return { label: "今天截止", tone: "amber" };
  if (days === 1) return { label: "明天截止", tone: "amber" };
  if (days <= 7) return { label: days + " 天后截止", tone: "blue" };
  return { label: "截止 " + formatDate(value), tone: "gray" };
}
/**
 * 任务表格的截止色调：与详情徽章同一套判定——逾期实心深红签、马上到期浅红签，
 * 未设置 / 已完成 / 已取消 / 更远日期不上色（原先这里对每一行都写死了 due-overdue）。
 */
function dueToneClass(
  value: string | null,
  workStatus: TaskViewItem["workStatus"],
): string | undefined {
  const tone = dueInfo(value, workStatus).tone;
  if (tone === "red") return "due-overdue";
  if (tone === "amber") return "due-soon";
  return undefined;
}
/** C-3：动作行左端的截止徽章。 */
function TaskDueBadge({ item }: { readonly item: TaskViewItem }) {
  const due = dueInfo(item.dueAt, item.workStatus);
  return (
    <span className={"calm-due due-" + due.tone}>
      <InpulseIcon name="clock" size={14} />
      {due.label}
    </span>
  );
}

/**
 * ADR-096：删除任务专用错误文案。`taskError` 是编辑场景的通用映射（「输入已保留，
 * 请加载最新版本后继续编辑」），删除弹窗没有输入也没有重载按钮，因此 409 直接
 * 透出服务端原因（如版本冲突或幂等摘要冲突），不追加编辑话术。
 */
function deletionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "权限或安全校验未通过，请重新登录后重试。";
    if (error.status === 404) return "任务不存在，或你已无权访问。";
    if (error.status === 409 || error.status === 422)
      return `${error.message}。`;
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "任务服务暂时不可用，请稍后重试。";
}

/**
 * ADR-096：删除任务二次确认。服务端永久删除任务本体、状态历史、负责人、
 * 影响关系、聚合组关系、外部链接关联，以及该任务的全部迭代记录、版本与
 * 遗留项；只保留审计日志、项目动态与 `task.delete` 事件。删除没有恢复入口，
 * 确认文案必须说明这一不可逆范围。
 */
function TaskDeletionConfirm({
  item,
  open,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  item: TaskViewItem | undefined;
  open: boolean;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      className="catalog-modal"
      open={open && item !== undefined}
      eyebrow={item ? `${item.code} / 删除任务` : "删除任务"}
      title="确认删除任务"
      tone="danger"
      icon="alert"
      onCancel={onCancel}
      mask={{ closable: true }}
      footer={
        <>
          <Button className="secondary-button" onClick={onCancel}>
            取消
          </Button>
          <Button
            className="primary-button danger-button"
            data-testid="confirm-delete-task"
            loading={pending}
            onClick={onConfirm}
          >
            确认删除
          </Button>
        </>
      }
    >
      <div className="catalog-form">
        <div className="dialog-form">
          <Alert
            showIcon
            type="warning"
            title={`确认删除任务「${item?.title ?? ""}」？`}
            description="删除后不可恢复；任务及其全部迭代记录、版本、遗留项和 GitHub 链接关联会被永久删除，仅保留审计日志与项目动态。"
          />
          {error ? (
            <Alert showIcon type="error" title={deletionError(error)} />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function MergeIntoTargetModal({
  task,
  api,
  onClose,
  onMerged,
}: {
  task: TaskViewItem;
  api: InpulseApiClient;
  onClose: () => void;
  onMerged: (groupId: number) => void;
}) {
  return (
    <MergeIntoMainTaskModal
      open
      task={{
        id: task.id,
        code: task.code,
        title: task.title,
        projectId: task.projectId,
      }}
      api={api}
      onClose={onClose}
      onMerged={(groupId) => {
        onClose();
        onMerged(groupId);
      }}
    />
  );
}

/**
 * 任务详情的来源行与状态弹层的归属面包屑统一由 `./task-origin` 提供，
 * 两处都从只读契约解析项目 / 模块名称，不显示编号。
 */
export function TasksPanel({
  projectId,
  moduleId,
  writable,
  client,
  mode = "panel",
  initialTaskId,
  onDetailClose,
  onOpenTask,
  view: viewProp,
  onViewChange,
  search = "",
  onSearchChange,
  statusFilter: statusFilterProp,
  onStatusFilterChange,
  showHeader = true,
  suppressCreateAction = false,
  createOpen = false,
  onCreateClose,
  onCountChange,
}: TaskScope & {
  writable: boolean;
  client?: InpulseApiClient | undefined;
  /**
   * `detail`：只渲染任务详情弹窗及其子弹窗，不渲染面板头部、任务列表与新建入口，
   * 供任务中心等跨项目页在当前页面就地打开完整任务详情（含写操作）；
   * 缺省 `panel` 保持模块任务页的完整面板。
   */
  mode?: "panel" | "detail";
  /** `detail` 模式初始选中的任务；缺省回退 URL 的 `?taskId=`。 */
  initialTaskId?: number | null;
  /** 详情弹窗关闭后的回调；`detail` 模式由宿主卸载本组件，回到触发页面。 */
  onDetailClose?: () => void;
  /**
   * 聚合组详情里点击成员任务标题时就地打开任务详情：由宿主页面提供（与任务中心
   * 同一实现），缺省时成员标题按纯文本渲染。成员任务可能属于其他模块，
   * 因此不能复用本面板自己那份按范围读取的详情弹窗。
   */
  onOpenTask?: ((location: TaskLocation) => void) | undefined;
  /**
   * 宿主页面把「卡片/列表」、状态筛选与搜索放到页面级工具条时，用受控属性传入；
   * 不传则沿用面板内的本地状态。
   */
  view?: "cards" | "list" | undefined;
  onViewChange?: ((view: "cards" | "list") => void) | undefined;
  search?: string | undefined;
  onSearchChange?: ((search: string) => void) | undefined;
  statusFilter?: string | undefined;
  onStatusFilterChange?: ((status: string) => void) | undefined;
  /** 关闭面板自带的标题/筛选行，由宿主页面提供同一组控件。 */
  showHeader?: boolean | undefined;
  /** 宿主页面已提供页头「新建任务」入口时，面板内不再重复渲染创建按钮。 */
  suppressCreateAction?: boolean | undefined;
  /** 宿主页面点击「新建任务」后置真，复用本面板内同一个模块级创建弹窗。 */
  createOpen?: boolean | undefined;
  onCreateClose?: (() => void) | undefined;
  /** 任务总数回传给宿主，用于标签上的计数。 */
  onCountChange?: ((count: number) => void) | undefined;
}) {
  const scope = { projectId, moduleId };
  const { api, query, members, mutation } = useTasks(scope, client);
  const [viewState, setViewState] = useState<"cards" | "list">("cards");
  const view = viewProp ?? viewState;
  const changeView = (next: "cards" | "list") => {
    if (onViewChange) onViewChange(next);
    else setViewState(next);
  };
  // 面板进入时默认显示全部状态，未完成 → 已完成的分组顺序由服务端排序给出；
  // 取消任务已改为删除，不再提供「已取消」筛选入口。
  const [statusFilterState, setStatusFilterState] = useState("ALL");
  const statusFilter = statusFilterProp ?? statusFilterState;
  const changeStatusFilter = (next: string) => {
    if (onStatusFilterChange) onStatusFilterChange(next);
    else setStatusFilterState(next);
  };
  const [selectedId, setSelectedId] = useState<number | null>(
    () =>
      initialTaskId ??
      (Number(new URLSearchParams(window.location.search).get("taskId")) ||
        null),
  );
  // C-3：详情弹窗的标签页与状态操作。statusToken 每次打开动作弹窗递增，
  // 父级据此更换 key，让输入、冲突与幂等重试键随重新挂载清空。
  const [tab, setTab] = useState<DetailTab>("info");
  const [statusAction, setStatusAction] = useState<
    TaskStatusRequest["action"] | null
  >(null);
  /** ADR-096：删除任务的二次确认。删除即物理删除，没有恢复入口。 */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [statusToken, setStatusToken] = useState(0);
  const [selection, setSelection] = useState<{ item?: TaskViewItem } | null>(
    null,
  );
  const [merge, setMerge] = useState<Merge | null>(null);
  const [mergeInto, setMergeInto] = useState(false);
  /** 当前就地打开的聚合组详情（null 表示弹层关闭）；聚合组入口不再整页跳转。 */
  const [openGroupId, setOpenGroupId] = useState<number | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [success, setSuccess] = useState(false);
  /** 聚合组弹层里解除合并后需要整批重读的 R-5 标记缓存。 */
  const queryClient = useQueryClient();
  /** 当前打开的迭代记录详情（null 表示弹层关闭）。 */
  const [openRecordId, setOpenRecordId] = useState<number | null>(null);
  /**
   * 本任务里「记录一次迭代」刚发布成功的记录。正式记录列表是另一条只读查询，
   * 刷新落地前先用发布响应渲染详情弹层，用户点「查看正式记录」不会点了没反应。
   */
  const [publishedRecord, setPublishedRecord] =
    useState<PublishedRecord | null>(null);
  /** 迭代记录弹窗目标：与记录页共用同一个弹窗组件，写草稿不再离开当前页面。 */
  const [draftTarget, setDraftTarget] =
    useState<RecordDraftEditorTarget | null>(null);
  const generation = useRef(0);
  const saving = useRef(false);
  /** 「在项目中打开」的目标页 chunk 就绪前保持弹窗在场，避免闪出空列表或骨架。 */
  const openingInProject = useRef(false);
  const {
    control,
    handleSubmit,
    reset,
    getValues,
    formState: { errors },
  } = useForm<TaskDraft>({ defaultValues: empty });
  const navigate = useNavigate();
  /**
   * 面板新建弹窗开关：null 关闭；"page" 由页面固定模块归属。
   */
  const [createMode, setCreateMode] = useState<"page" | null>(null);
  // 聚合组详情与任务中心共用同一弹窗实现；本面板只负责把当前选中组传给它。
  const groupAdapter = useMemo(() => createTaskGroupServerAdapter(api), [api]);
  const current = query.data?.items.find((item) => item.id === selectedId);
  // 页面级一次批量（R-5）：任务集合变化时整批重读，不按任务逐个请求。
  const marks = useTaskMarks(
    api,
    query.data?.items.map((item) => item.id) ?? [],
  );
  const currentMark = current ? marks.get(current.id) : undefined;
  const currentBadge = relationBadge(currentMark);
  // 主任务自身就是统一入口，只有分支任务显示「查看主任务」；
  // groupRole 为 null（未入组）时不显示任何导航入口（C-1）。
  const currentGroupId =
    currentMark?.groupRole === "SOURCE" ? currentMark.groupId : null;
  const currentRecordCount = currentMark?.publishedRecordCount ?? 0;
  const currentTaskPath =
    current === undefined
      ? null
      : taskDetailPath({
          projectId: current.projectId,
          moduleId: current.moduleId,
          taskId: current.id,
        });
  /**
   * 任务详情打开时预取「在项目中打开」的落地页数据：弹窗至少会停留几秒，
   * 足够把项目详情与模块目录取好，点击后在旧页仍可见的同一帧内直接渲染
   * 完整页面，不再先空一帧再补骨架。
   */
  useEffect(() => {
    if (current === undefined) return;
    prefetchModulesRoute(queryClient, current.projectId, client);
  }, [current, client, queryClient]);
  // 迭代记录标签页按设计师稿直接列出本任务的已发布记录与草稿：两者都是既有
  // 只读契约（listChangeRecords / getTaskRecordDrafts），客户端按 taskId 过滤，不新增路由。
  const detailTaskId = current?.id ?? 0;
  const detailModuleId = current?.moduleId ?? 0;
  const taskRecords = useQuery({
    queryKey: ["task-published-records", projectId, detailTaskId],
    queryFn: ({ signal }) =>
      api.listChangeRecords(projectId, { limit: 100 }, { signal }),
    enabled: detailTaskId > 0,
    retry: false,
  });
  const taskDrafts = useQuery({
    queryKey: ["task-record-drafts", projectId, detailModuleId, detailTaskId],
    queryFn: ({ signal }) =>
      api.getTaskRecordDrafts(projectId, detailModuleId, detailTaskId, {
        signal,
      }),
    enabled: detailTaskId > 0,
    retry: false,
  });
  const taskPublished = (taskRecords.data?.items ?? []).filter(
    (record) => record.taskId === detailTaskId,
  );
  // 列表刷新后按编号重新定位：弹窗不会因查询返回新对象而闪退。
  const openRecord =
    openRecordId === null
      ? null
      : (taskPublished.find((record) => record.id === openRecordId) ??
        (publishedRecord?.id === openRecordId ? publishedRecord : null));
  const taskDraftItems = taskDrafts.data?.items ?? [];
  // C-1/C-3：R-5 的 groupId 与 groupRole 同生共死；这里给「合并与分支」标签页
  // 与标签文案一份显式的关系视图模型（未入组为 null）。
  const currentRelation =
    currentMark &&
    currentMark.groupRole !== null &&
    currentMark.groupId !== null
      ? { groupId: currentMark.groupId, role: currentMark.groupRole }
      : null;
  const taskWritable = writable && current?.lifecycleStatus === "ACTIVE";
  const searchKeyword = search.trim().toLocaleLowerCase();
  const visibleItems =
    query.data?.items.filter((item) => {
      if (statusFilter !== "ALL" && item.workStatus !== statusFilter) {
        return false;
      }
      if (searchKeyword === "") return true;
      return (
        item.title.toLocaleLowerCase().includes(searchKeyword) ||
        item.code.toLocaleLowerCase().includes(searchKeyword) ||
        item.description.toLocaleLowerCase().includes(searchKeyword)
      );
    }) ?? [];
  const taskCount = query.data?.items.length;
  useEffect(() => {
    if (taskCount !== undefined) onCountChange?.(taskCount);
  }, [taskCount, onCountChange]);
  // 创建人与状态历史操作人未必在任务指派人候选中：用项目活跃成员名单解析姓名，
  // 仍解析不到（已移出项目或停用）时回退中性编号，不冒充负责人语义。
  const projectMembers = useQuery({
    queryKey: ["project-active-members", projectId],
    queryFn: ({ signal }) =>
      api.listActiveProjectMembers(projectId, { signal }),
    retry: false,
  });
  // 创建人/操作人可能不是本项目成员（如系统管理员跨项目操作）：项目活跃成员与
  // 指派人候选都解析不到时，用全站用户目录兜底姓名，仍解析不到才回退中性编号。
  const userDirectory = useUserDirectoryQuery({ client });
  const personName = (id: number) =>
    projectMembers.data?.items.find((m) => m.id === id)?.name ??
    members.data?.items.find((m) => m.id === id)?.name ??
    userDirectory.data?.find((u) => u.id === id)?.name ??
    "用户 #" + id;

  /**
   * 活跃项目成员 id 集合（成员候选名单与项目活跃成员名单同源）：名单还没回来时为
   * null，此时一律不标「已移出」，免得加载那一瞬间把所有人都误标一遍。
   */
  const activeMemberIds = useMemo<ReadonlySet<number> | null>(() => {
    const source = members.data ?? projectMembers.data;
    return source === undefined
      ? null
      : new Set(source.items.map((item) => item.id));
  }, [members.data, projectMembers.data]);
  /**
   * 负责人姓名。已移出项目的人用「姓名（已移出项目）」呈现——2026-10-16 实测反馈：
   * 这里原来回退成「用户 #2（历史负责人）」，把内部编号暴露给了用户，也说不清该怎么办。
   */
  const memberName = (id: number, serverName?: string) =>
    withDetachedMark(
      serverName ?? personName(id),
      isDetachedAssignee(activeMemberIds, id),
    );
  /** 多负责人平权（ADR-040）：服务端姓名与 ID 同序返回，逐人展示。 */
  const memberNames = (
    ids: readonly number[],
    names: readonly string[] = [],
  ) =>
    ids.length === 0
      ? "未指派"
      : ids.map((id, index) => memberName(id, names[index])).join("、");
  /** hover 文案：姓名之外把「请重新分配」的处置指引一并带上。 */
  const assigneeTitle = (
    ids: readonly number[],
    names: readonly string[] = [],
  ) =>
    ids.length === 0
      ? "负责人：未指派"
      : "负责人：" +
        ids
          .map((id, index) =>
            detachedAssigneeTitle(
              names[index] ?? personName(id),
              isDetachedAssignee(activeMemberIds, id),
            ),
          )
          .join("、");
  /** 负责人候选项：活跃成员 + 当前任务残留的负责人（已移出项目的带标记与处置指引）。 */
  const assigneeOptions = useMemo(() => {
    const items = members.data?.items ?? [];
    const list: CalmSelectOption[] = items.map((member) => ({
      value: member.id,
      label: member.name,
      avatarUrl: member.avatarUrl ?? null,
    }));
    const selected = selection?.item;
    for (const currentId of selected?.assigneeIds ?? [])
      if (!list.some((option) => option.value === currentId))
        list.unshift({
          value: currentId,
          label: memberName(
            currentId,
            selected?.assigneeNames?.[selected.assigneeIds.indexOf(currentId)],
          ),
          description:
            activeMemberIds === null ? "可保留" : DETACHED_ASSIGNEE_HINT,
        });
    return list;
  }, [
    members.data,
    projectMembers.data,
    userDirectory.data,
    activeMemberIds,
    selection,
  ]);
  // ADR-054：任务层面已下线归档，只读只可能来自任务自身无效或调用方传入的只读范围。
  const editReadOnly =
    selection?.item !== undefined &&
    (!writable || selection.item.lifecycleStatus !== "ACTIVE");
  const openDetail = (id: number) => {
    setSelectedId(id);
    setTab("info");
    setStatusAction(null);
    setPublishedRecord(null);
  };
  const closeDetail = () => {
    setSelectedId(null);
    setTab("info");
    setStatusAction(null);
    setOpenRecordId(null);
    setPublishedRecord(null);
    setDeleteOpen(false);
    onDetailClose?.();
  };
  /**
   * 先等目标页面 chunk 就绪，再关闭弹窗并导航。直接在点击时 closeDetail()
   * 会让通知列表或任务中心先露出来一帧，随后才被新页面替换；先预加载能把
   * 「关弹窗 → 空一帧 → 新页淡入」合并成一次完整切换。
   */
  const openInProject = (path: string) => {
    if (openingInProject.current) {
      return;
    }
    openingInProject.current = true;
    void preloadRoutePath(path).finally(() => {
      openingInProject.current = false;
      closeDetail();
      navigate(path);
    });
  };
  /**
   * C-3：状态操作入口。每次点击递增 token，任务状态弹窗重新挂载，
   * 上一次的输入、冲突提示与幂等重试键都不会沿用。
   */
  const openStatus = (next: TaskStatusRequest["action"]) => {
    setStatusToken((value) => value + 1);
    setStatusAction(next);
  };
  const open = (item?: TaskViewItem, options?: { keepDetail?: boolean }) => {
    // 从详情进入编辑时保留 selectedId，让同一个弹层原地切换内容，
    // 不再卸载遮罩、重播入场动画（否则会闪一帧）。
    if (options?.keepDetail !== true) setSelectedId(null);
    setTab("info");
    setStatusAction(null);
    setOpenRecordId(null);
    // 详情回退 / 合并交接只清 selection、不清删除确认态，避免打开任务时误弹确认框。
    setDeleteOpen(false);
    generation.current++;
    setSelection(item ? { item: { ...item } } : {});
    reset(item ? taskEdit(item) : empty);
    mutation.reset();
    setMerge(null);
    setMergeInto(false);
    setReloadError(null);
    setSuccess(false);
    void members.refetch();
  };
  /** 新建任务入口：归属固定为当前模块。 */
  const startCreate = () => {
    setCreateMode("page");
  };
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const close = () => {
    if (saving.current || reloading) return;
    generation.current++;
    // detail 模式没有面板可回退：关闭编辑弹窗后重新打开任务详情弹窗。
    const returnId = mode === "detail" ? (selection?.item?.id ?? null) : null;
    setSelection(null);
    setMerge(null);
    setDeleteOpen(false);
    if (returnId !== null) {
      openDetail(returnId);
    } else {
      // 非 detail 模式仍按原行为退回任务列表；编辑期间保留 selectedId 只是为了
      // 让详情 → 编辑共用遮罩，关闭时要把这份临时保留的详情状态一并清掉。
      setSelectedId(null);
    }
  };
  /**
   * ADR-096：删除任务。服务端在同一事务内永久删除任务及其全部迭代记录、版本、
   * 遗留项与链接关联，解除聚合组并写审计与项目动态；前端只负责二次确认与
   * 失效缓存，不提供恢复入口。
   */
  const deletion = useMutation({
    mutationFn: async (item: TaskViewItem) => {
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": createIdempotencyKey("task-delete"),
          "If-Match": `"${item.rowVersion}"`,
        },
      };
      return api.deleteModuleTask(
        projectId,
        moduleId,
        item.id,
        { reason: null },
        init,
      );
    },
    retry: false,
    onSuccess: () => {
      setDeleteOpen(false);
      setSelection(null);
      // 从详情进入编辑时 selectedId 仍然保留；任务已被物理删除，必须把详情
      // 一并退出，否则同一个弹层会切换到「任务不存在」的空详情。
      closeDetail();
      // 刷新必须非阻塞：query-core 在 `onSuccess` resolve 之后才 dispatch success，
      // 也就是这 20 条失效链路跑完 `isPending` 才转 false；而确认弹窗的取消按钮、
      // 遮罩与 ✕ 都按它上锁——await 在这里会让弹窗一直转圈并且关不掉。
      void Promise.all(
        [
          ["tasks"],
          ["task-board"],
          ["task-group"],
          ["task-group-records"],
          ["task-marks"],
          ["my-tasks"],
          ["my-task-groups"],
          ["modules"],
          ["project-overview"],
          ["projects"],
          ["activity"],
          ["activity-center"],
          ["search"],
          ["notifications"],
          ["record-feed"],
          ["record-drafts"],
          ["task-record-drafts"],
          ["my-record-drafts"],
          ["record-summary"],
          ["leftover-items"],
          ["task-external-links"],
          // 被永久删除的记录可能已在记录页 / 项目主页弹窗里被打开过，按当前项目前缀
          // 一起失效（记录 ID 在删除前未知，取不到逐条 key）。
          ["published-record", projectId],
          ["record-versions", projectId],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      // 删除会改变侧栏计数（任务中心未完成 / 遗留问题），与记录被永久删除同一处理。
      void invalidateShellCounters(queryClient);
    },
  });
  /**
   * 2026-10-09 改版：任务级操作（取消任务 / 合并到主任务）从详情弹窗动作行搬到
   * 「编辑任务」弹窗页脚。详情与编辑共用同一个弹层，点这两枚按钮先把内容切回
   * 详情，再触发各自原有的确认流程，不会出现弹窗套弹窗，也不会重建遮罩。
   * 开放条件与详情动作行同一口径：只对未完成任务、且通过同一条写入门禁。
   * ADR-096：页脚第一枚已由「取消任务」改为「删除任务」（二次确认后物理删除），
   * 条件由 `deletion.isPending` 承担。
   */
  const editorTaskOpsEnabled = selection?.item !== undefined && !editReadOnly;
  const handOffToDetail = (): boolean => {
    if (saving.current || reloading) return false;
    const id = selection?.item?.id ?? null;
    generation.current++;
    setSelection(null);
    setMerge(null);
    setDeleteOpen(false);
    if (id === null) return false;
    openDetail(id);
    setOpenRecordId(null);
    return true;
  };
  const cancelFromEditor = () => {
    if (saving.current || reloading || deletion.isPending) return;
    deletion.reset();
    setDeleteOpen(true);
  };
  const mergeFromEditor = () => {
    if (handOffToDetail()) setMergeInto(true);
  };
  const save = handleSubmit(async (edit) => {
    if (
      !selection ||
      saving.current ||
      reloading ||
      merge ||
      conflict ||
      reloadError ||
      !writable
    )
      return;
    saving.current = true;
    try {
      const result = await mutation.mutateAsync({ ...selection, edit });
      openDetail(result.id);
      setSelection(null);
      setSuccess(true);
    } catch {
      /* Keep input and retry key. */
    } finally {
      saving.current = false;
    }
  });
  const reload = async () => {
    if (!selection?.item) return;
    const stamp = generation.current;
    const base = selection.item;
    const draft = getValues();
    setReloading(true);
    try {
      const latest = await api.getModuleTask(projectId, moduleId, base.id);
      if (stamp !== generation.current) return;
      if (stamp !== generation.current) return;
      if (latest.lifecycleStatus !== "ACTIVE") {
        setReloadError("任务已无效，草稿已保留，当前不能保存。");
        return;
      }
      const result = mergeTask(taskEdit(base), draft, taskEdit(latest));
      if (result.conflicts.length) setMerge({ ...result, latest, choices: {} });
      else {
        reset(result.values);
        setSelection({ item: latest });
        mutation.reset();
        setReloadError(null);
      }
    } catch (error) {
      if (stamp === generation.current) setReloadError(taskError(error));
    } finally {
      if (stamp === generation.current) setReloading(false);
    }
  };
  const applyMerge = () => {
    if (!merge || merge.conflicts.some((field) => !merge.choices[field]))
      return;
    const values = { ...merge.values };
    for (const field of merge.conflicts)
      if (merge.choices[field] === "latest")
        Object.assign(values, { [field]: taskEdit(merge.latest)[field] });
    reset(values);
    setSelection({ item: merge.latest });
    setMerge(null);
    mutation.reset();
    setReloadError(null);
  };
  return (
    <section aria-label="模块任务" className="tasks-panel">
      {mode === "detail" ? null : (
        <>
          {(createMode !== null || createOpen) && (
            <GlobalTaskCreateModal
              open
              onClose={() => {
                setCreateMode(null);
                onCreateClose?.();
              }}
              client={client}
              preset={{ projectId, moduleId }}
              onCreatedLocation={(task) => {
                // 2026-09-28：模块级面板的「新建任务」改用任务中心同一弹窗后，创建
                // 成功只会改写地址栏；已经挂载的面板不会再读 URL 的 ?taskId=。
                // 就地打开详情且不写地址栏——留下 ?taskId= 会让刷新后重新弹出详情，
                // 与「刷新回到列表」的既有口径冲突。
                if (
                  task.projectId === projectId &&
                  task.moduleId === moduleId
                ) {
                  openDetail(task.taskId);
                  return;
                }
                navigate(taskDetailPath(task));
              }}
            />
          )}
          {showHeader ? (
            <div className="calm-section-title">
              <div className="task-panel-heading">
                <h3>模块任务</h3>
                {/* 计数与筛选合并进标题行：不再单起一行「任务数：…」与筛选行。 */}
                {query.data && (
                  <CalmBadge tone="gray" title="当前模块的任务总数">
                    {query.data.items.length} 个任务
                  </CalmBadge>
                )}
              </div>
              <div className="module-view-controls">
                {query.data && (
                  <CalmSelect
                    className="task-status-filter"
                    value={statusFilter}
                    onChange={(next) => changeStatusFilter(String(next))}
                    options={taskStatusFilterOptions}
                    appearance="menu"
                    ariaLabel="任务状态筛选"
                    animated
                  />
                )}
                <CalmSegmented
                  label="展示方式"
                  value={view}
                  options={[
                    { value: "cards", label: "卡片" },
                    { value: "list", label: "列表" },
                  ]}
                  onChange={changeView}
                />
                {onSearchChange !== undefined ? (
                  <div className="task-search module-task-search">
                    <InpulseIcon name="search" size={15} />
                    <input
                      aria-label="搜索当前模块的任务"
                      placeholder="搜索当前模块的任务"
                      value={search}
                      onChange={(event) => onSearchChange(event.target.value)}
                    />
                  </div>
                ) : null}
                {suppressCreateAction ||
                (query.isSuccess && !query.data?.items.length) ? null : (
                  <Button
                    className="primary-button"
                    disabled={!writable}
                    onClick={startCreate}
                  >
                    <InpulseIcon name="plus" size={15} />
                    新建任务
                  </Button>
                )}
              </div>
            </div>
          ) : null}
          {!writable && (
            <p className="permission-hint">
              <InpulseIcon name="alert" size={14} />
              当前范围只读，不能新建或修改任务。
            </p>
          )}
          {success && (
            <SuccessToast
              testId="task-save-success"
              title="任务已保存"
              onDismiss={() => setSuccess(false)}
            />
          )}
          {query.isPending ? (
            <CalmSkeleton variant="list" rows={4} label="正在加载任务" />
          ) : query.isError ? (
            <Alert
              type="error"
              title={taskError(query.error)}
              action={
                <Button
                  className="secondary-button"
                  onClick={() => void query.refetch()}
                >
                  重试任务列表
                </Button>
              }
            />
          ) : !query.data?.items.length ? (
            <CalmEmptyState
              icon="zap"
              title="暂无任务"
              description="为当前模块创建一项具体执行工作。"
            >
              {suppressCreateAction ? null : (
                <Button
                  className="primary-button"
                  disabled={!writable}
                  onClick={startCreate}
                >
                  <InpulseIcon name="plus" size={15} />
                  新建任务
                </Button>
              )}
            </CalmEmptyState>
          ) : !visibleItems.length ? (
            <CalmEmptyState
              icon={searchKeyword === "" ? "zap" : "search"}
              title={
                searchKeyword === "" ? "当前状态暂无任务" : "没有匹配的任务"
              }
              description={
                searchKeyword === ""
                  ? "可切换状态筛选查看历史任务。"
                  : "调整关键词后重试，或清空搜索查看当前模块的全部任务。"
              }
            >
              {searchKeyword !== "" && onSearchChange ? (
                <Button
                  className="secondary-button"
                  onClick={() => onSearchChange("")}
                >
                  清空搜索
                </Button>
              ) : null}
            </CalmEmptyState>
          ) : view === "list" ? (
            <div className="module-task-list-scroll">
              <table className="module-task-list-table">
                <caption className="sr-only">任务列表</caption>
                <thead>
                  <tr>
                    <th scope="col">编号</th>
                    <th scope="col">任务</th>
                    <th scope="col">负责人</th>
                    <th scope="col">优先级</th>
                    <th scope="col">截止</th>
                    <th scope="col">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const badge = relationBadge(marks.get(item.id));
                    const leftoverSource =
                      marks.get(item.id)?.hasLeftoverSource === true;
                    const subtitle = [
                      badge === null ? null : badge.label,
                      leftoverSource ? LEFTOVER_SOURCE_BADGE.label : null,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ");
                    // 标题本身就是入口，副标题只留归属提示，不再重复详情入口文案。
                    return (
                      <tr
                        key={item.id}
                        className={taskToneClassName(
                          item.priority,
                          item.workStatus,
                        )}
                      >
                        <td>
                          <span className="task-id">{item.code}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="module-task-list-open"
                            aria-label={item.title}
                            onClick={() => openDetail(item.id)}
                          >
                            <strong>{item.title}</strong>
                            {subtitle === "" ? null : <span>{subtitle}</span>}
                          </button>
                        </td>
                        <td>
                          {memberNames(item.assigneeIds, item.assigneeNames)}
                        </td>
                        <td>
                          <CalmBadge tone={priorityTone[item.priority]}>
                            {priorityLabels[item.priority]}
                          </CalmBadge>
                        </td>
                        <td
                          className={dueToneClass(item.dueAt, item.workStatus)}
                        >
                          {dueLabel(item.dueAt)}
                        </td>
                        <td>
                          <CalmBadge tone={statusTone[item.workStatus]}>
                            {statusLabels[item.workStatus]}
                          </CalmBadge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="calm-task-grid">
              {visibleItems.map((item) => {
                const badge = relationBadge(marks.get(item.id));
                const recordCount =
                  marks.get(item.id)?.publishedRecordCount ?? 0;
                const leftoverSource =
                  marks.get(item.id)?.hasLeftoverSource === true;
                return (
                  <article
                    className={
                      "calm-task-card " +
                      taskToneClassName(item.priority, item.workStatus)
                    }
                    key={item.id}
                    tabIndex={0}
                    /* 整卡即详情入口：卡片本身带可读名称，键盘 Tab 到卡片时
                       屏幕阅读器能读出「查看任务详情：<标题>」，同时给测试一个
                       稳定的定位入口（不再渲染重复的「任务详情」按钮）。 */
                    aria-label={"查看任务详情：" + item.title}
                    onClick={(event) => {
                      if (!isCardClick(event)) return;
                      openDetail(item.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      if (event.target !== event.currentTarget) return;
                      event.preventDefault();
                      openDetail(item.id);
                    }}
                  >
                    {/* 与任务中心卡片同款：编号与「未完成」都不占徽章位；
                        标签落到分隔线以下的左下角，负责人移到横线上方右侧。 */}
                    <h3>{item.title}</h3>
                    {/* 卡片正文是任务介绍；归属由页面语境表达。 */}
                    <p
                      className={
                        "task-card-desc" +
                        (item.description === "" ? " is-placeholder" : "")
                      }
                      title={
                        item.description === ""
                          ? "暂无任务描述"
                          : item.description
                      }
                    >
                      {item.description === ""
                        ? "暂无任务描述"
                        : item.description}
                    </p>
                    <div className="calm-card-assignee">
                      <span
                        title={assigneeTitle(
                          item.assigneeIds,
                          item.assigneeNames,
                        )}
                      >
                        <InpulseIcon name="users" size={14} />
                        {memberNames(item.assigneeIds, item.assigneeNames)}
                      </span>
                    </div>
                    <div className="calm-card-bottom">
                      <span className="task-card-badges">
                        <CalmBadge
                          tone={priorityTone[item.priority]}
                          title={"优先级：" + priorityLabels[item.priority]}
                        >
                          {priorityLabels[item.priority]}
                        </CalmBadge>
                        {badge !== null && (
                          <CalmBadge tone={badge.tone} title={badge.title}>
                            {badge.label}
                          </CalmBadge>
                        )}
                        {leftoverSource && (
                          <CalmBadge
                            tone={LEFTOVER_SOURCE_BADGE.tone}
                            title={LEFTOVER_SOURCE_BADGE.title}
                          >
                            {LEFTOVER_SOURCE_BADGE.label}
                          </CalmBadge>
                        )}
                        {item.workStatus === "TODO" ? null : (
                          <CalmBadge tone={statusTone[item.workStatus]}>
                            {statusLabels[item.workStatus]}
                          </CalmBadge>
                        )}
                      </span>
                      <span
                        className={dueToneClass(item.dueAt, item.workStatus)}
                        title={"截止：" + formatDate(item.dueAt)}
                      >
                        <InpulseIcon name="clock" size={14} />
                        {dueLabel(item.dueAt)}
                      </span>
                    </div>
                    <div className="task-card-footer">
                      <span className="task-card-counts">
                        <span title={"更新 " + formatDate(item.updatedAt)}>
                          <InpulseIcon name="calendar" size={13} />
                          更新 {formatDay(item.updatedAt)}
                        </span>
                        {recordCount > 0 && (
                          <span title={recordCount + " 条已发布迭代记录"}>
                            <InpulseIcon name="gitBranch" size={13} />
                            记录 {recordCount} 条
                          </span>
                        )}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
      <TaskGroupDetailModal
        groupId={openGroupId}
        adapter={groupAdapter}
        api={api}
        onClose={() => setOpenGroupId(null)}
        onOpenTask={onOpenTask}
        onChanged={() => {
          // 解除合并会改变任务在聚合组里的关系标记，整批重读 R-5 标记。
          void queryClient.invalidateQueries({ queryKey: ["task-marks"] });
        }}
      />
      {openRecord === null ? null : (
        <RecordDetailModal
          projectId={projectId}
          record={recordDetailTarget(openRecord)}
          api={api}
          onClose={() => setOpenRecordId(null)}
          onChanged={() => {
            // 修订、作废与遗留项操作会改变列表里的编号状态与正文。
            void taskRecords.refetch();
          }}
        />
      )}
      {draftTarget === null ? null : (
        <RecordDraftEditorModal
          api={api}
          target={draftTarget}
          projectId={projectId}
          writable={taskWritable}
          onClose={() => setDraftTarget(null)}
          // 草稿列表由弹窗内部失效；本任务正式记录列表是另一条只读查询，发布后需自行刷新。
          onSaved={(_draft, published) => {
            setDraftTarget(null);
            if (!published) return;
            // 发布成功就在原地给出落点：正式记录列表刷新期间也能直接打开详情。
            setPublishedRecord(published);
            void taskRecords.refetch();
          }}
        />
      )}
      <Modal
        open={selectedId !== null || selection !== null}
        title={
          selection === null
            ? undefined
            : selection.item
              ? "编辑任务"
              : "新建任务"
        }
        label={selection === null ? "任务详情" : undefined}
        size={selection === null ? "xl" : "lg"}
        onCancel={selection === null ? closeDetail : close}
        className={
          selection !== null
            ? "catalog-modal"
            : query.isPending
              ? "task-modal is-loading"
              : "task-modal"
        }
        focusToken={selection === null ? (selectedId ?? "detail") : "edit"}
        mask={{
          closable:
            selection === null ? true : !mutation.isPending && !reloading,
        }}
      >
        {selection !== null ? (
          <form
            className="catalog-form calm-form"
            onSubmit={(event) => void save(event)}
          >
            <div className="dialog-form">
              {editReadOnly && (
                <Alert type="info" title="任务已无效，表单只读。" />
              )}
              {mutation.isError && (
                <Alert type="error" title={taskError(mutation.error)} />
              )}
              {reloadError && <Alert type="error" title={reloadError} />}
              {conflict && selection?.item && (
                <Button
                  className="secondary-button"
                  loading={reloading}
                  onClick={() => void reload()}
                >
                  加载最新版本后继续编辑
                </Button>
              )}
              {merge && (
                <div className="merge-panel">
                  <div className="calm-section-title">
                    <h3>解决编辑冲突</h3>
                  </div>
                  {merge.conflicts.map((field) => (
                    <div className="merge-choice" key={field}>
                      <p>{labels[field]}存在冲突</p>
                      <p>我的输入：{String(merge.values[field] ?? "未设置")}</p>
                      <p>
                        最新值：
                        {String(taskEdit(merge.latest)[field] ?? "未设置")}
                      </p>
                      <div className="catalog-actions">
                        <Button
                          className="secondary-button"
                          onClick={() =>
                            setMerge({
                              ...merge,
                              choices: { ...merge.choices, [field]: "draft" },
                            })
                          }
                        >
                          保留我的{labels[field]}
                        </Button>
                        <Button
                          className="secondary-button"
                          onClick={() =>
                            setMerge({
                              ...merge,
                              choices: { ...merge.choices, [field]: "latest" },
                            })
                          }
                        >
                          采用最新{labels[field]}
                        </Button>
                        <span>
                          {merge.choices[field] ? "已选择" : "请选择"}
                        </span>
                      </div>
                    </div>
                  ))}
                  <Button
                    className="primary-button"
                    disabled={merge.conflicts.some(
                      (field) => !merge.choices[field],
                    )}
                    onClick={applyMerge}
                  >
                    应用合并结果
                  </Button>
                </div>
              )}
              <fieldset
                className="task-form-fields"
                disabled={mutation.isPending || reloading || !!merge}
              >
                <div className="calm-field">
                  <label htmlFor="task-title">任务标题</label>
                  <Controller
                    name="title"
                    control={control}
                    rules={{
                      validate: (value) =>
                        value.trim().length > 0 || "请输入任务标题",
                      maxLength: { value: 500, message: "最多500字" },
                    }}
                    render={({ field }) => <Input {...field} id="task-title" />}
                  />
                  {errors.title && <p role="alert">{errors.title.message}</p>}
                </div>
                <div className="calm-field">
                  {/* 可见标签与任务中心弹窗统一为「指派给」，无障碍名称仍是「负责人」：
                      CalmSelect 交互辅助按 aria-label 定位这个下拉。 */}
                  <label htmlFor="task-assignee">指派给</label>
                  <Controller
                    name="assigneeIds"
                    control={control}
                    rules={{
                      validate: (value) =>
                        value.length > 0 || "请至少选择一名负责人",
                    }}
                    render={({ field }) => (
                      <CalmSelect
                        id="task-assignee"
                        value={field.value}
                        onChange={(next) => field.onChange(next.map(Number))}
                        options={assigneeOptions}
                        appearance="member"
                        multiple
                        maxTagCount={2}
                        placeholder="请选择项目成员（可多选）"
                        ariaLabel="负责人"
                        animated
                      />
                    )}
                  />
                  {errors.assigneeIds && (
                    <p role="alert">{errors.assigneeIds.message}</p>
                  )}
                  {isFirstLoad(members) && (
                    <CalmSkeleton
                      variant="list"
                      rows={2}
                      compact
                      label="正在加载项目成员…"
                    />
                  )}
                  {members.isError && (
                    <Alert
                      type="error"
                      title={taskError(members.error)}
                      action={
                        <Button
                          className="secondary-button"
                          onClick={() => void members.refetch()}
                        >
                          重试项目成员
                        </Button>
                      }
                    />
                  )}
                </div>
                <div className="form-row">
                  <div className="calm-field">
                    <label htmlFor="task-priority">优先级</label>
                    <Controller
                      name="priority"
                      control={control}
                      render={({ field }) => (
                        <CalmSelect
                          id="task-priority"
                          ariaLabel="优先级"
                          value={field.value}
                          appearance="menu"
                          onChange={(next) => field.onChange(next)}
                          onBlur={field.onBlur}
                          options={Object.entries(priorityLabels).map(
                            ([value, label]) => ({
                              value,
                              label,
                              dotColor: priorityDotColor(value),
                            }),
                          )}
                          animated
                        />
                      )}
                    />
                  </div>
                  <div className="calm-field">
                    <label htmlFor="task-due">截止时间</label>
                    <Controller
                      name="dueAt"
                      control={control}
                      render={({ field }) => (
                        <CalmDateTimeInput
                          id="task-due"
                          value={toLocalDateTimeInput(field.value)}
                          onBlur={field.onBlur}
                          inputRef={field.ref}
                          onChange={(next) =>
                            field.onChange(
                              next === "" ? null : new Date(next).toISOString(),
                            )
                          }
                        />
                      )}
                    />
                  </div>
                </div>
                <div className="calm-field">
                  <label htmlFor="task-description">任务说明</label>
                  <Controller
                    name="description"
                    control={control}
                    rules={{
                      maxLength: {
                        value: 50000,
                        message: "说明最多 50000 字",
                      },
                    }}
                    render={({ field }) => (
                      <Input.TextArea
                        {...field}
                        id="task-description"
                        rows={4}
                      />
                    )}
                  />
                  {errors.description && (
                    <p role="alert">{errors.description.message}</p>
                  )}
                </div>
              </fieldset>
            </div>
            <div className="calm-action-footer">
              {/* 2026-10-09 改版：任务级操作从详情弹窗动作行搬到这里，沿用
                  「编辑项目 → 删除项目」的页脚最左位置（ADR-062 同一约定），
                  与表单自己的「取消 / 保存」分开。 */}
              {selection?.item?.workStatus === "TODO" ? (
                <div className="footer-leading task-op-actions">
                  <Button
                    className="tint-danger-button"
                    disabled={!editorTaskOpsEnabled || deletion.isPending}
                    onClick={cancelFromEditor}
                  >
                    <InpulseIcon name="alert" size={15} />
                    删除任务
                  </Button>
                  <Button
                    className="tint-violet-button"
                    disabled={!editorTaskOpsEnabled}
                    onClick={mergeFromEditor}
                  >
                    <InpulseIcon name="gitMerge" size={15} />
                    合并到主任务
                  </Button>
                </div>
              ) : null}
              <Button
                className="secondary-button"
                onClick={close}
                disabled={mutation.isPending || reloading}
              >
                取消
              </Button>
              <Button
                className="primary-button"
                htmlType="submit"
                loading={mutation.isPending}
                disabled={
                  !writable || reloading || !!merge || conflict || !!reloadError
                }
              >
                {/* 与任务中心弹窗一致：新建说「创建任务」，编辑仍说「保存」。 */}
                {selection?.item ? "保存" : "创建任务"}
              </Button>
            </div>
          </form>
        ) : selectedId !== null ? (
          <>
            {query.isPending ? (
              /* 加载态先摆出真弹层的骨架（头部 + 撑满的正文），盒子按视口上限开，
                 避免先闪出一条 140px 窄条再撑到 844px（2026-09-30 首帧尺寸修复）。 */
              <>
                <div className="drawer-header task-modal-header">
                  <div>
                    <span
                      className="calm-sk task-modal-sk-title"
                      aria-hidden="true"
                    />
                    <div className="task-modal-badges" aria-hidden="true">
                      <span className="calm-sk task-modal-sk-chip" />
                      <span className="calm-sk task-modal-sk-chip short" />
                      <span className="calm-sk task-modal-sk-chip short" />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭任务详情"
                    onClick={closeDetail}
                  >
                    <InpulseIcon name="x" size={19} />
                  </button>
                </div>
                <div className="task-modal-loading-body">
                  <CalmSkeleton
                    variant="lines"
                    rows={6}
                    label="正在加载任务详情"
                  />
                </div>
              </>
            ) : query.isError ? (
              <Alert
                type="error"
                title={taskError(query.error)}
                action={
                  <Button
                    className="secondary-button"
                    onClick={() => void query.refetch()}
                  >
                    重试任务详情
                  </Button>
                }
              />
            ) : !current ? (
              <Alert type="warning" title="任务不存在或无法访问。" />
            ) : (
              <>
                <div className="drawer-header task-modal-header">
                  <div className="task-modal-header-main">
                    {/* 2026-10-09 任务详情弹窗改版（定稿方案 ②A）：头部只留标题 +
                        状态/优先级徽章 + 编码 + 关闭按钮（实测 76px → 约 48px）；
                        「GitHub 链接 / 在项目中打开」并进下方动作行，与
                        「编辑任务 / 完成任务」同排，中间用一道竖线把跳转与操作分开。 */}
                    <div className="task-modal-title">
                      <h2>{current.title}</h2>
                      <div className="task-modal-badges">
                        <CalmBadge tone={statusTone[current.workStatus]}>
                          {statusLabels[current.workStatus]}
                        </CalmBadge>
                        <CalmBadge tone={priorityTone[current.priority]}>
                          {priorityLabels[current.priority]}
                        </CalmBadge>
                        {currentBadge !== null && (
                          <CalmBadge
                            tone={currentBadge.tone}
                            title={currentBadge.title}
                          >
                            {currentBadge.label}
                          </CalmBadge>
                        )}
                        {currentMark?.hasLeftoverSource === true && (
                          <CalmBadge
                            tone={LEFTOVER_SOURCE_BADGE.tone}
                            title={LEFTOVER_SOURCE_BADGE.title}
                          >
                            {LEFTOVER_SOURCE_BADGE.label}
                          </CalmBadge>
                        )}
                      </div>
                      <span
                        className="task-id"
                        title={"任务编码 " + current.code}
                      >
                        {current.code}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭任务详情"
                    onClick={closeDetail}
                  >
                    <InpulseIcon name="x" size={19} />
                  </button>
                </div>
                {publishedRecord !== null && (
                  <SuccessToast
                    testId="task-record-published-success"
                    title={"迭代记录已发布：" + publishedRecord.code}
                    actions={
                      <Button
                        className="secondary-button"
                        onClick={() => setOpenRecordId(publishedRecord.id)}
                      >
                        查看正式记录
                      </Button>
                    }
                    onDismiss={() => setPublishedRecord(null)}
                  />
                )}
                <div className="calm-task-actions">
                  <TaskDueBadge item={current} />
                  {/* 2026-10-09 改版（定稿方案 ②A）：GitHub 链接与「在项目中打开」从
                      头部挪到本行，与「编辑任务 / 完成任务」同排；「取消任务 / 合并到
                      主任务」搬到「编辑任务」弹窗页脚，动作行只留「编辑任务」+ 状态
                      主操作；主按钮靠既有的 margin-left:auto 顶到最右。 */}
                  <ExternalLinksPanel
                    key={current.id}
                    targetType="TASK"
                    targetId={current.id}
                    client={api}
                    triggerClassName="secondary-button"
                  />
                  {/* 任务中心等跨项目页打开详情时页面里看不到项目结构：
                      这里给一条回模块任务页的入口，落地后由 ?taskId= 打开同一个任务。 */}
                  {mode === "detail" && (
                    <Button
                      className="secondary-button"
                      title="跳转到该任务所在的模块任务页"
                      {...(currentTaskPath === null
                        ? {}
                        : routePreloadHandlers(currentTaskPath))}
                      onClick={() => {
                        if (currentTaskPath !== null) {
                          openInProject(currentTaskPath);
                        }
                      }}
                    >
                      <InpulseIcon name="folder" size={14} />
                      在项目中打开
                    </Button>
                  )}
                  <span className="ta-sep" aria-hidden="true" />
                  <Button
                    className="secondary-button"
                    disabled={!taskWritable}
                    onClick={() => open(current, { keepDetail: true })}
                  >
                    <InpulseIcon name="pencil" size={14} />
                    编辑任务
                  </Button>
                  {current.workStatus === "TODO" && (
                    <Button
                      className="primary-button"
                      disabled={!taskWritable}
                      onClick={() => openStatus("COMPLETE")}
                    >
                      <InpulseIcon name="check" size={15} />
                      完成任务
                    </Button>
                  )}
                  {current.workStatus === "DONE" && (
                    <Button
                      className="primary-button"
                      disabled={!taskWritable}
                      onClick={() => openStatus("REOPEN")}
                    >
                      <InpulseIcon name="rotateCcw" size={15} />
                      重新打开
                    </Button>
                  )}
                  {/* ADR-096：取消任务改为「删除任务」（编辑弹窗页脚），删除即永久清除、
                      不提供恢复入口，因此这里不再渲染「恢复任务」。 */}
                </div>
                <CalmTabs
                  label="任务内容"
                  activeKey={tab}
                  onChange={setTab}
                  items={[
                    { key: "info", label: "任务信息" },
                    {
                      key: "records",
                      label:
                        currentRecordCount > 0
                          ? "迭代记录 " + currentRecordCount
                          : "迭代记录",
                    },
                    {
                      key: "branches",
                      label: currentRelation
                        ? "合并与分支 · #" + currentRelation.groupId
                        : "合并与分支",
                    },
                  ]}
                />
                <div className="task-modal-grid">
                  <div className="task-modal-main">
                    {tab === "info" && (
                      <>
                        <section className="calm-description">
                          <h3>任务描述</h3>
                          <p>{current.description || "暂无任务说明"}</p>
                        </section>
                        <div className="task-modal-links">
                          {/* 2026-09-24 产品要求删除「打开模块任务」：任务中心详情动作行
                              的「在项目中打开」已指向同一地址，正文里重复。 */}
                          <a
                            href={`/records?projectId=${projectId}&moduleId=${moduleId}&taskId=${current.id}`}
                          >
                            打开迭代记录
                          </a>
                          {currentRecordCount > 0 && (
                            <span
                              className="task-record-count"
                              title={currentRecordCount + " 条已发布迭代记录"}
                            >
                              <InpulseIcon name="gitBranch" size={13} />
                              迭代记录 {currentRecordCount} 条
                            </span>
                          )}
                          {currentGroupId !== null && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => setOpenGroupId(currentGroupId)}
                            >
                              <InpulseIcon name="gitBranch" size={14} />
                              查看主任务
                              <InpulseIcon name="chevronRight" size={13} />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    {tab === "records" && (
                      <>
                        <div className="calm-section-title">
                          <div>
                            <h3>本任务迭代记录</h3>
                            <small>
                              {currentRecordCount > 0
                                ? "已发布 " +
                                  currentRecordCount +
                                  " 条，多个版本不重复计数"
                                : "一个任务可以没有记录，也可以产生多条记录"}
                            </small>
                          </div>
                          <Button
                            className="primary-button"
                            disabled={!taskWritable || !taskDrafts.data?.source}
                            onClick={() => {
                              const source = taskDrafts.data?.source;
                              if (!source) return;
                              setDraftTarget({ kind: "source", source });
                            }}
                          >
                            <InpulseIcon name="zap" size={15} />
                            记录一次迭代
                          </Button>
                        </div>
                        {taskRecords.isPending || taskDrafts.isPending ? (
                          <CalmSkeleton
                            variant="list"
                            rows={3}
                            label="正在加载迭代记录"
                          />
                        ) : taskRecords.isError || taskDrafts.isError ? (
                          <Alert
                            type="error"
                            title="迭代记录加载失败，请重试。"
                            action={
                              <Button
                                onClick={() => {
                                  void taskRecords.refetch();
                                  void taskDrafts.refetch();
                                }}
                              >
                                重试
                              </Button>
                            }
                          />
                        ) : taskPublished.length === 0 &&
                          taskDraftItems.length === 0 ? (
                          <div className="calm-empty">
                            <InpulseIcon name="gitBranch" size={25} />
                            <strong>该任务还没有迭代记录</strong>
                            <p>
                              可以直接发布一条迭代记录，也可以先保存草稿稍后补充；发布记录不会改变任务状态。
                            </p>
                          </div>
                        ) : (
                          <ul className="task-record-list">
                            {taskPublished.map((record) => (
                              <li key={"published-" + record.id}>
                                {/* 整行摘要可点开详情弹窗；关联链接与徽章留在按钮外，
                                    避免交互元素嵌套。 */}
                                <button
                                  type="button"
                                  className="task-record-open"
                                  data-testid={"task-record-open-" + record.id}
                                  aria-haspopup="dialog"
                                  onClick={() => setOpenRecordId(record.id)}
                                >
                                  <span className="task-record-open-text">
                                    <strong>{record.title}</strong>
                                    <small>
                                      {record.code +
                                        " · " +
                                        formatDay(record.publishedAt) +
                                        " · " +
                                        (record.handlerName ??
                                          personName(record.handlerId))}
                                    </small>
                                  </span>
                                  <InpulseIcon
                                    name="chevronRight"
                                    size={14}
                                    className="task-record-open-chevron"
                                  />
                                </button>
                                <CalmBadge
                                  tone={
                                    record.status === "VOID" ? "gray" : "green"
                                  }
                                >
                                  {record.status === "VOID"
                                    ? "已作废"
                                    : "已发布"}
                                </CalmBadge>
                              </li>
                            ))}
                            {taskDraftItems.map((draft) => (
                              <li key={"draft-" + draft.id}>
                                <a
                                  href={
                                    "/records?projectId=" +
                                    projectId +
                                    "&moduleId=" +
                                    draft.moduleId +
                                    "&taskId=" +
                                    detailTaskId +
                                    "&recordId=" +
                                    draft.id
                                  }
                                >
                                  <strong>{draft.title || "未命名草稿"}</strong>
                                  <small>
                                    {"草稿 · 更新于 " +
                                      formatDay(draft.updatedAt) +
                                      " · 处理人 " +
                                      (draft.handlerName ??
                                        personName(draft.handlerId))}
                                  </small>
                                </a>
                                <CalmBadge tone="amber">草稿</CalmBadge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                    {tab === "branches" && (
                      <section className="merge-panel">
                        {currentRelation === null ? (
                          <div className="calm-empty">
                            <InpulseIcon name="gitMerge" size={25} />
                            <strong>当前是独立任务</strong>
                            <p>
                              发现重复任务时可以合并到主任务，合并后形成主分支与分支任务，历史全部保留。
                            </p>
                          </div>
                        ) : (
                          <>
                            <div className="calm-section-title">
                              <div>
                                <h3>
                                  {currentRelation.role === "MAIN"
                                    ? "主任务"
                                    : "分支任务"}{" "}
                                  · 聚合组 #{currentRelation.groupId}
                                </h3>
                                <small>
                                  {currentRelation.role === "MAIN"
                                    ? "本任务是聚合组的统一入口，分支任务保留各自的状态与历史。"
                                    : "本任务是分支任务，原始状态、负责人、迭代记录与外部链接全部保留。"}
                                </small>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                setOpenGroupId(currentRelation.groupId)
                              }
                            >
                              <InpulseIcon name="gitBranch" size={14} />
                              {currentRelation.role === "MAIN"
                                ? "打开聚合组"
                                : "查看主任务"}
                              <InpulseIcon name="chevronRight" size={13} />
                            </button>
                          </>
                        )}
                      </section>
                    )}
                  </div>
                  <aside className="task-modal-facts">
                    <dl className="calm-meta">
                      <TaskOriginFacts
                        projectId={current.projectId}
                        moduleId={current.moduleId}
                        client={client}
                      />
                      <dt>负责人</dt>
                      <dd>
                        {memberNames(
                          current.assigneeIds,
                          current.assigneeNames,
                        )}
                      </dd>
                      <dt>创建人</dt>
                      <dd>
                        {current.creatorName ?? personName(current.creatorId)}
                      </dd>
                      <dt>截止时间</dt>
                      <dd>{formatDate(current.dueAt)}</dd>
                      <dt>创建时间</dt>
                      <dd>{formatDate(current.createdAt)}</dd>
                      <dt>更新时间</dt>
                      <dd>{formatDate(current.updatedAt)}</dd>
                      <dt>数据版本</dt>
                      <dd>v{current.rowVersion}</dd>
                    </dl>
                  </aside>
                </div>
                <div className="task-modal-bottom">
                  <LeftoverTaskSource api={api} taskId={current.id} />
                  <TaskStatusPanel
                    key={statusToken}
                    item={current}
                    api={api}
                    writable={taskWritable}
                    action={statusAction}
                    onClose={() => setStatusAction(null)}
                  />
                </div>
                {mergeInto && (
                  <MergeIntoTargetModal
                    task={current}
                    api={api}
                    onClose={() => setMergeInto(false)}
                    onMerged={(groupId) => setOpenGroupId(groupId)}
                  />
                )}
              </>
            )}
          </>
        ) : null}
      </Modal>
      {/* ADR-096：删除确认弹窗必须渲染在编辑弹窗**之外**（与编辑弹窗平级）。
          曾把它挂在编辑弹窗子树内，而 rc-dialog 会 memo 化编辑弹窗的 children，
          `open=false` / `pending=false` 的 prop 更新永远传不进去：删除成功后确认弹窗
          会卡在打开态一直转圈、遮罩不撤、body 滚动锁死（已用两个变体实测对照确认）。 */}
      <TaskDeletionConfirm
        item={selection?.item}
        open={deleteOpen}
        pending={deletion.isPending}
        error={deletion.error}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          const item = selection?.item;
          if (item) deletion.mutate(item);
        }}
      />
    </section>
  );
}

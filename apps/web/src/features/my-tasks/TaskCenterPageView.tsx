import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button } from "antd";
import {
  createApiClient,
  type InpulseApiClient,
  type ProjectItem,
} from "@generated/api";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { ProjectLogo } from "@features/common/components/ProjectLogo";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSegmented,
  type CalmBadgeTone,
} from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { priorityDotColor } from "@features/common/priority-select-option";
import {
  taskPriorityBadgeTone,
  taskPriorityLabel,
  taskToneClassName,
  type TaskDueTone,
} from "@features/common/task-tone";
import { projectSelectOption } from "@features/common/project-select-option";
import { MY_TASKS_MOCK_ADAPTER } from "./my-tasks-mock";
import {
  describeMyTasksError,
  useMyTaskGroupsQuery,
  useMyTasksQuery,
} from "./my-tasks-query";
import type { TaskLocation } from "@features/tasks/task-links";
import {
  countActiveMyTaskFilters,
  DEFAULT_MY_TASK_FILTERS,
} from "./my-tasks-url";
import {
  listMyTasksV1Gaps,
  matchesMyTasksLocalFilters,
  MY_TASKS_V1_LOCAL_FILTER_SUPPORT,
} from "./my-tasks-v1-query";
import {
  formatDayIso,
  isBeforeTodayIso,
  isTodayIso,
  isWithinNextDaysIso,
} from "./my-tasks-time";
import { GlobalTaskCreateModal } from "@features/tasks/GlobalTaskCreateModal";
import { TaskGroupDetailModal } from "@features/task-groups/TaskGroupDetailModal";
import { createTaskGroupServerAdapter } from "@features/task-groups/task-groups-server";
import {
  MY_TASKS_FULL_FILTER_SUPPORT,
  type MyTaskFilters,
  type MyTaskGithubFilter,
  type MyTaskGroupItem,
  type MyTaskLevel,
  type MyTaskListItem,
  type MyTaskPriority,
  type MyTaskRecordFilter,
  type MyTaskRelation,
  type MyTaskStats,
  type MyTaskStatusFilter,
  type MyTasksAdapter,
  type MyTasksFilterGap,
  type MyTasksFilterSupport,
  type MyTaskWorkStatus,
} from "./my-tasks-types";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

/** 任务中心搜索框的 URL 同步延迟：避开输入法组合期和逐键导航。 */
const TASK_QUERY_SYNC_DELAY_MS = 250;

const statusLabels: Record<MyTaskWorkStatus, string> = {
  TODO: "未完成",
  DONE: "已完成",
  CANCELED: "已取消",
};

const statusTone: Record<MyTaskWorkStatus, "blue" | "green" | "gray"> = {
  TODO: "blue",
  DONE: "green",
  CANCELED: "gray",
};

/**
 * 聚合组是否已经没有未完成分支——「归到已完成那边」的唯一判据（2026-09-22 产品口径）。
 * 已取消与已完成一样算收尾，否则被取消的分支会永远把组留在「未完成」档；没有分支的
 * CLOSED 组不算已完成（没有事实可派生）。卡片、组行与工具栏「未完成 / 已完成」归属
 * 都走这一处，避免多处判定漂移。
 */
function isTaskGroupCompleted(group: MyTaskGroupItem): boolean {
  return (
    group.branches.length > 0 &&
    !group.branches.some((branch) => branch.workStatus === "TODO")
  );
}

const priorityOrder: readonly MyTaskPriority[] = ["URGENT", "HIGH", "NORMAL"];

/**
 * 组内未完成（TODO）分支里最高的一档优先级，没有未完成分支时返回 null。
 * 这是组卡底色 / 优先级徽章与「未完成 / 进行中的组按内部最高优先级排序」的唯一来源
 * （2026-09-22 产品口径），`describeTaskGroup` 与 `taskGroupPriorityRank` 都走这一处。
 */
function highestOpenPriority(group: MyTaskGroupItem): MyTaskPriority | null {
  return (
    priorityOrder.find((candidate) =>
      group.branches.some(
        (branch) =>
          branch.workStatus === "TODO" && branch.priority === candidate,
      ),
    ) ?? null
  );
}

/**
 * 聚合组的排序档位（2026-09-22 产品口径「未完成状态（未开始 / 进行中）的组合任务按内部
 * 未完成任务中的最高优先级排序」）：紧急 → 高 → 普通，没有未完成分支的组（已完成、
 * 已关闭且无分支）排到最后。同档内不动服务端给的顺序（R-7 按 id 倒序），前端不另立次级口径。
 */
function taskGroupPriorityRank(group: MyTaskGroupItem): number {
  const priority = highestOpenPriority(group);
  return priority === null
    ? priorityOrder.length
    : priorityOrder.indexOf(priority);
}

/** 未完成分支：组卡的派生优先级与派生截止都只看这些分支。 */
function openBranchesOf(group: MyTaskGroupItem) {
  return group.branches.filter((branch) => branch.workStatus === "TODO");
}

/**
 * 组卡的截止事实：未完成分支里最早的一条；没有未完成分支、或分支都没设截止时为 null。
 * 卡片右下角文案、列表截止列与排序都走这一处，避免三处各算一遍。
 */
function earliestOpenDueAt(group: MyTaskGroupItem): string | null {
  return (
    openBranchesOf(group)
      .map((branch) => branch.dueAt)
      .filter((dueAt): dueAt is string => dueAt !== null)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
  );
}

/**
 * 服务端 apps/api/src/modules/tasks/task-list-order.ts 的紧急桶：标记紧急 0 →
 * 已逾期 1 → 今/明日截止 2 → 其余 3。任务卡与组卡共用这一处判定：组卡的「来源」不适用，
 * 「紧急」取未完成分支最高一档，「截止」取未完成分支最早一条。
 * 遗留问题来源**不在这一级**，它是优先级之后的独立一级（见 leftoverRankOf）：
 * 2026-09-24 产品定案「遗留问题只会在同优先级里面高一点……以后不管是别人拉取还是，
 * 都要以这个为准」，不得再并回紧急桶。
 */
function urgencyBucketOf(
  priority: MyTaskPriority | null,
  dueAt: string | null,
): number {
  if (priority === "URGENT") return 0;
  if (dueAt !== null && isBeforeTodayIso(dueAt)) return 1;
  if (dueAt === null) return 3;
  // 「今/明日截止」= 今天 0 点起、后天 0 点前，与日期文案的同日判定同一把尺子。
  if (isWithinNextDaysIso(dueAt, 2)) return 2;
  return 3;
}

function taskUrgencyBucket(item: MyTaskListItem): number {
  if (item.workStatus !== "TODO") return 3;
  return urgencyBucketOf(item.priority, item.dueAt);
}

function taskGroupUrgencyBucket(group: MyTaskGroupItem): number {
  if (isTaskGroupCompleted(group)) return 3;
  return urgencyBucketOf(highestOpenPriority(group), earliestOpenDueAt(group));
}

/** 服务端排序键第一级：未完成 0 → 已完成 1 → 已取消 2。 */
function statusGroupRankOf(workStatus: MyTaskWorkStatus): number {
  if (workStatus === "TODO") return 0;
  if (workStatus === "DONE") return 1;
  return 2;
}

/**
 * 服务端排序键第二级：完成时间倒序（仅「已完成」分组有值，2026-09-22 产品口径「这个排序
 * 按照完成时间，越晚越排前面」）。时间戳取负后参与升序比较，等价于越晚完成越靠前；
 * 未完成 / 已取消与聚合组都没有完成时间这个事实，取 0（= 服务端的 '-infinity' 归一），
 * 因此排在已完成任务之后、彼此之间不产生高低。
 */
function completedRankOf(
  workStatus: MyTaskWorkStatus,
  completedAt: string | null,
): number {
  if (workStatus !== "DONE" || completedAt === null) return 0;
  const parsed = Date.parse(completedAt);
  return Number.isNaN(parsed) ? 0 : -parsed;
}

/** 服务端排序键第四级：优先级档位；未知优先级排在已知各档之后。 */
function priorityRankOf(priority: MyTaskPriority | null): number {
  if (priority === null) return priorityOrder.length;
  const index = priorityOrder.indexOf(priority);
  return index === -1 ? priorityOrder.length : index;
}

/**
 * 服务端排序键第五级：遗留问题来源 0 / 其余 1（仅未完成参与，非未完成恒 1）。
 * 2026-09-24 产品定案：它只让同优先级的任务提前，不越过更高优先级；组卡没有「来源」
 * 这个事实，固定取 1。
 */
function leftoverRankOf(hasLeftoverSource: boolean): number {
  return hasLeftoverSource ? 0 : 1;
}

/** 服务端排序键第六级：截止时间戳；未设置截止按最大处理，排在有截止的之后。 */
function dueRankOf(dueAt: string | null): number {
  return dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(dueAt);
}

function compareGridRank(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * 卡片视图与列表视图共用的一份顺序（2026-09-22 产品口径「（它们）同样是一个优先级的，
 * 按照截止日期从近到远排序」，同日追加「已完成按完成时间，越晚越排前面」）：逐级比较
 * 「状态分组 → 完成时间倒序 → 紧急桶 → 优先级 → 遗留问题来源 → 截止时间」，六级都取自服务端
 * task-list-order.ts 的排序键，组卡因此与任务卡混排，不再固定追加在网格 / 表格尾部。
 * 两侧仍是各自签名游标的分页结果，前端只在已加载页内按同一把尺子合并，不伪造跨页
 * 完整顺序；Array.prototype.sort 稳定，同键保持「任务在前、组保持 R-7 顺序」。
 */
type TaskCenterGridEntry =
  | {
      readonly kind: "task";
      readonly item: MyTaskListItem;
      readonly rank: readonly number[];
    }
  | {
      readonly kind: "group";
      readonly group: MyTaskGroupItem;
      readonly rank: readonly number[];
    };

/**
 * 列表区块只保留空态文案：工作状态由工具栏「未完成 / 已完成」筛选项表达，
 * 「未完成 / n 项 · 服务端按任务编号倒序」两行文字已按产品要求删除（2026-09-20）。
 * 空态仍必须跟随工作状态，否则「已完成 0 项」会看起来像数据丢失。
 */
const listEmptyTitles: Record<MyTaskStatusFilter, string> = {
  open: "没有匹配的未完成任务",
  done: "没有匹配的已完成任务",
  all: "没有匹配的任务",
};

const displayOptions = [
  { value: "cards" as const, label: "卡片" },
  { value: "list" as const, label: "列表" },
];

/**
 * 工具栏「工作状态」筛选（2026-09-21 定案）：承接原先由四张统计卡承担的工作状态切换，
 * 只保留产品要求的「未完成 / 已完成」两档；URL 里遗留的 status=all 不属于任何档位，
 * 因此不高亮任何一项，而不是把它误报成「未完成」。
 *
 * 2026-09-22（方案 A 定稿）：两档各自带 R-3 统计的数量——myOpen / completed 取负责人
 * 维度、按当前 project 范围计算，与列表筛选同口径；stats 不可知（适配器未接线或尚未
 * 加载）时两档都传 null，由 CalmSegmented 不渲染角标，不把「不知道」显示成 0。
 */
function statusOptions(stats: MyTaskStats | null): ReadonlyArray<{
  readonly value: MyTaskStatusFilter;
  readonly label: string;
  readonly count: number | null;
}> {
  return [
    { value: "open", label: "未完成", count: stats?.myOpen ?? null },
    { value: "done", label: "已完成", count: stats?.completed ?? null },
  ];
}

const filterGapLabels: Record<MyTasksFilterGap, string> = {
  "scope:created": "我创建的",
  "scope:all": "全部任务",
  "scope:project-without-id": "全部可访问项目",
  "filter:priority": "优先级",
  "filter:relation": "合并关系",
  "filter:github": "GitHub 关联",
  "filter:query": "关键词搜索",
  "filter:canceled-with-open": "已取消与未完成合并显示",
};

/**
 * 本地筛选提示：服务端没有对应参数、只对已加载页生效时必须显式说明，
 * 否则会被读成服务端全量收敛。
 */
function localFilterNote(
  localGaps: readonly MyTasksFilterGap[],
  loaded: number,
): string {
  return (
    "以下条件在已加载的 " +
    loaded +
    " 条任务上本地筛选（服务端暂未提供参数）：" +
    localGaps.map((gap) => filterGapLabels[gap]).join("、") +
    "；点“加载更多”可扩大范围。"
  );
}

/**
 * 截止文案与紧迫度只认「工作状态 + 截止时间」两个事实：任务行传自己的字段，
 * 聚合组行传未完成分支里最早的一条（2026-09-22 口径），判定只此一处。
 */
interface DueSubject {
  readonly workStatus: MyTaskListItem["workStatus"];
  readonly dueAt: string | null;
}

function dueLabelOf(subject: DueSubject): string {
  if (subject.dueAt === null) return "未设置截止";
  if (subject.workStatus === "TODO" && isBeforeTodayIso(subject.dueAt))
    return "已逾期 " + formatDayIso(subject.dueAt);
  if (isTodayIso(subject.dueAt)) return "今天截止";
  return formatDayIso(subject.dueAt);
}

function dueLabel(item: MyTaskListItem): string {
  return dueLabelOf(item);
}

/**
 * 截止紧迫度：已逾期 / 今天到期（马上到期），其余（已完成、已取消、明天以后）
 * 返回 null。2026-09-22 起只派生列表截止列的文字色，不再决定卡片底色
 * （产品口径「逾期的不搞特殊了，原本的优先级是什么就呈现什么颜色」），判定只此一处。
 */
function dueToneOf(subject: DueSubject): TaskDueTone | null {
  if (subject.dueAt === null || subject.workStatus !== "TODO") return null;
  if (isBeforeTodayIso(subject.dueAt)) return "overdue";
  if (isTodayIso(subject.dueAt)) return "soon";
  return null;
}

/**
 * 白底表面上的两档红文字色（色值见 design-system.css 的 .due-overdue / .due-soon），
 * 只用在列表视图的截止列：卡片整卡按任务自己的优先级铺色，不再往里套一层日期签。
 */
function dueToneClass(subject: DueSubject): string | undefined {
  const tone = dueToneOf(subject);
  if (tone === "overdue") return "due-overdue";
  if (tone === "soon") return "due-soon";
  return undefined;
}

export interface TaskCenterPageViewProps {
  readonly filters: MyTaskFilters;
  readonly onFiltersChange: (next: MyTaskFilters) => void;
  readonly viewerId: number | null;
  readonly projects: readonly ProjectItem[];
  readonly advancedOpen: boolean;
  readonly onToggleAdvanced: () => void;
  readonly onOpenIssues: () => void;
  readonly onOpenTask?: (task: TaskLocation) => void;
  /**
   * 页头「遗留问题」入口的计数（2026-09-22 修）：页面层注入外壳计数
   * （R-6 未闭环桶，与侧栏导航同一个数字）。undefined 表示调用方未接线，
   * 回退适配器字段；null 表示计数尚未加载——不显示角标。
   *
   * 为什么不用 R-3 的 leftoverCount：它的 SQL 要求 leftover_task_links 与
   * ACTIVE 同时成立，而链接行只在「遗留项转任务」事务内写入、同一事务把条目
   * 置成 CONVERTED，两者互斥使该字段在真实数据下恒为 0（集成测试用夹具直接
   * 插链接才得到非零），页头因此改与侧栏同源。
   */
  readonly leftoverCount?: number | null;
  readonly adapter?: MyTasksAdapter;
  /** 与页面共用同一个生成客户端；缺省时弹窗自行创建。 */
  readonly client?: InpulseApiClient | undefined;
}

/**
 * F-32 任务中心页面视图。数据来自注入的 adapter：页面默认注入 server
 * adapter（R-3 listMyTasks），mock 只用于测试与降级演示；项目名等公共字段
 * 来自 A 的 listProjects 端口（在页面层注入）。
 * 契约缺口（统计、范围计数、遗留问题、优先级/截止时间等）按适配器声明的
 * filterSupport 与可选字段显式降级：禁用或标注，不虚构数值。
 */
export const TaskCenterPageView: React.FC<TaskCenterPageViewProps> = ({
  filters,
  onFiltersChange,
  viewerId,
  projects,
  advancedOpen,
  onToggleAdvanced,
  onOpenIssues,
  onOpenTask,
  leftoverCount: leftoverCountOverride,
  adapter,
  client,
}) => {
  const activeAdapter = adapter ?? MY_TASKS_MOCK_ADAPTER;
  /**
   * 搜索框保留一份本地草稿：URL 是筛选真相，但不能在每个按键（尤其是中文输入法
   * 组合期）都导航重渲染，否则组合串会被打断成重复拼音。输入停止后再同步 URL。
   */
  const [queryDraft, setQueryDraft] = useState(filters.query);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const querySyncTimerRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const filtersRef = useRef(filters);
  const lastSyncedQueryRef = useRef(filters.query);
  // 聚合组详情经 C 域 R-1 / R-4 读取，与任务中心自己的 MyTasks 适配器无关。
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const groupAdapter = useMemo(() => createTaskGroupServerAdapter(api), [api]);
  /** 当前打开的聚合组（null 表示弹层关闭）：卡片不再跳转详情页。 */
  const [openGroupId, setOpenGroupId] = useState<number | null>(null);
  const taskQuery = useMyTasksQuery({
    filters,
    viewerId,
    adapter: activeAdapter,
  });
  const groupsQuery = useMyTaskGroupsQuery({
    projectId: filters.projectId,
    adapter: activeAdapter,
  });
  const groups =
    groupsQuery.data?.pages.flatMap((page) => [...page.items]) ?? [];
  const result = taskQuery.data;
  const items = result?.items ?? [];
  /** R-3 统计：工作状态两档的数量角标用它，null 表示不可知（不渲染角标）。 */
  const stats = result?.stats ?? null;
  // 优先用页面注入的外壳计数（R-6 未闭环桶，与侧栏一致）；只有调用方未接线
  // （undefined）才回退适配器字段，null 表示计数尚未加载、不显示角标。
  const leftoverCount =
    leftoverCountOverride !== undefined
      ? leftoverCountOverride
      : (result?.leftoverCount ?? null);
  const filterSupport: MyTasksFilterSupport =
    result?.filterSupport ?? MY_TASKS_FULL_FILTER_SUPPORT;
  /**
   * 服务端缺口的两个分支：可本地计算的条件（relation / github / query）保持控件可用，
   * 只在提示条里说明"仅对已加载页生效"；无法本地计算的条件（scope:created /
   * scope:all）不做本地降级，避免把部分结果说成服务端收敛。
   */
  const localGaps = listMyTasksV1Gaps(filters).filter(
    (gap) => !filterSupport[gap] && MY_TASKS_V1_LOCAL_FILTER_SUPPORT[gap],
  );
  const enabled = (gap: MyTasksFilterGap): boolean =>
    filterSupport[gap] || MY_TASKS_V1_LOCAL_FILTER_SUPPORT[gap];
  const projectNames = new Map<number, string>(
    projects.map((project) => [project.id, project.name]),
  );
  /**
   * 项目水印（2026-10-10 产品定案）：项目标识取编码前两位（与项目列表页、遗留问题
   * 来源行同一个 ProjectLogo），放大成卡片右下角的一枚浅色字母水印，只当背景肌理，
   * 不再占归属行的位置。本水印只在任务中心生效，项目详情里的任务面板不加。
   * R-3 的任务项只带 projectId / projectName、不带项目编码，这里复用页面已注入的
   * 项目列表做映射；项目不在可见列表里时整枚水印不渲染，也不凭空造字母。
   */
  const projectCodes = new Map<number, string>(
    projects.map((project) => [project.id, project.code]),
  );
  const projectNameOf = (item: MyTaskListItem): string =>
    projectNames.get(item.projectId) ?? item.projectName;
  const matchedItems = items.filter((item) =>
    matchesMyTasksLocalFilters(item, filters, filterSupport),
  );
  /**
   * 已合并任务不再单独出卡片（2026-09-21 产品定案）：ACTIVE 聚合组的主任务与来源
   * 分支由聚合组卡片代表，任务卡片、列表行与折叠明细都不再重复这一份。
   * 判定用 R-3 的 groupRole——服务端只对 ACTIVE 组的 ACTIVE 成员返回，解除合并后
   * 自动回 null，因此不受聚合组列表分页与读取失败影响。
   * 例外：用户显式按合并关系筛选（主任务 / 分支任务）时保留成员卡片本身，
   * 否则这两个选项永远筛不出任何结果。
   */
  const visibleItems =
    filters.relation === "MAIN" || filters.relation === "SOURCE"
      ? matchedItems
      : matchedItems.filter((item) => item.groupRole === null);
  const openItems = visibleItems.filter((item) => item.workStatus === "TODO");
  const doneItems = visibleItems.filter((item) => item.workStatus === "DONE");
  const canceledItems = visibleItems.filter(
    (item) => item.workStatus === "CANCELED",
  );
  /**
   * 主列表取当前工作状态对应的集合：「已完成 / 全部」的结果必须直接可见，
   * 否则工具栏切到「已完成」时页面上仍只有「未完成 0 项」与空态。
   */
  const primaryItems =
    filters.status === "done"
      ? doneItems
      : filters.status === "all"
        ? visibleItems
        : openItems;
  /**
   * 聚合组的工作状态口径与卡片徽章同源（2026-09-22 产品口径）：只要还有未收尾
   * （TODO）分支就是「未完成」——「进行中」属于未完成；全部分支收尾（已完成 /
   * 已取消）才是「已完成」。工具栏两档因此同时作用于任务与聚合组，已完成的组
   * 不再留在未完成视图里；服务端对 CLOSED 组不返回分支，这类无分支的组按
   * 「无未收尾工作」同样落到已完成档，不会永远占着未完成。
   */
  const groupHasOpenWork = (group: MyTaskGroupItem): boolean =>
    group.branches.some((branch) => branch.workStatus === "TODO");
  const primaryGroups =
    filters.status === "done"
      ? groups.filter((group) => !groupHasOpenWork(group))
      : filters.status === "all"
        ? groups
        : groups.filter(groupHasOpenWork);
  /**
   * 任务卡片与聚合组卡片任一存在即渲染列表区：聚合组混排进任务网格后不再单列
   * 「还没有聚合组」空态，任务为空但聚合组存在时也不能显示任务空态；
   * 已合并任务被隐藏时同理，它由聚合组卡片代表。
   */
  const hasListContent = primaryItems.length > 0 || primaryGroups.length > 0;
  /** 今日待办是「未完成」的子集，空态必须点明它更窄，否则看起来像漏了任务。 */
  const todayTodoActive =
    filters.status === "open" && filters.todayTodo !== false;
  const listEmptyTitle = todayTodoActive
    ? "今天没有待办任务"
    : listEmptyTitles[filters.status];
  /** 空态按范围说明服务端边界：R-3 的负责人固定为当前会话用户。 */
  const listEmptyDescription = todayTodoActive
    ? filters.projectId === null
      ? "今日待办只含逾期、遗留、紧急或 7 天内到期的任务；点工具栏「未完成」可看全部未完成任务。"
      : "当前项目没有逾期、遗留、紧急或 7 天内到期的未完成任务。"
    : filters.projectId !== null
      ? "当前项目没有符合条件的任务，可调整筛选或新建任务。"
      : "调整筛选条件，或到对应功能页创建新任务。";
  const activeFilterCount = countActiveMyTaskFilters(filters);
  const [createOpen, setCreateOpen] = useState(false);

  const update = (patch: Partial<MyTaskFilters>) => {
    // 定时器触发时可能已经切换过项目 / 优先级：以最新 filters 为底，避免旧闭包覆盖新筛选。
    onFiltersChange({
      ...filtersRef.current,
      ...(patch.status !== undefined
        ? { overdue: false, todayTodo: false }
        : {}),
      ...patch,
    });
  };

  const clearQuerySync = () => {
    if (querySyncTimerRef.current !== null) {
      window.clearTimeout(querySyncTimerRef.current);
      querySyncTimerRef.current = null;
    }
  };

  const syncQueryNow = (next: string) => {
    clearQuerySync();
    const normalized = next.trim();
    if (normalized === lastSyncedQueryRef.current) return;
    lastSyncedQueryRef.current = normalized;
    update({ query: normalized });
  };

  const scheduleQuerySync = (next: string) => {
    clearQuerySync();
    const normalized = next.trim();
    if (normalized === lastSyncedQueryRef.current) return;
    querySyncTimerRef.current = window.setTimeout(() => {
      querySyncTimerRef.current = null;
      if (composingRef.current) return;
      lastSyncedQueryRef.current = normalized;
      update({ query: normalized });
    }, TASK_QUERY_SYNC_DELAY_MS);
  };

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setQueryDraft(next);
    const native = event.nativeEvent as { isComposing?: boolean };
    if (composingRef.current || native.isComposing === true) {
      clearQuerySync();
      return;
    }
    scheduleQuerySync(next);
  };

  const handleQueryCompositionStart = () => {
    composingRef.current = true;
    clearQuerySync();
  };

  const handleQueryCompositionEnd = (
    event: React.CompositionEvent<HTMLInputElement>,
  ) => {
    composingRef.current = false;
    const next = event.currentTarget.value;
    setQueryDraft(next);
    syncQueryNow(next);
  };

  const handleQueryBlur = () => {
    if (composingRef.current) return;
    const next = queryDraft.trim();
    if (next !== queryDraft) setQueryDraft(next);
    syncQueryNow(next);
  };

  const handleQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      syncQueryNow(queryDraft);
    }
  };

  useEffect(() => {
    filtersRef.current = filters;
    lastSyncedQueryRef.current = filters.query;
    if (composingRef.current) return;
    if (document.activeElement === searchInputRef.current) return;
    setQueryDraft(filters.query);
  }, [filters]);

  useEffect(
    () => () => {
      if (querySyncTimerRef.current !== null) {
        window.clearTimeout(querySyncTimerRef.current);
        querySyncTimerRef.current = null;
      }
    },
    [],
  );

  /**
   * 任务中心只做跨项目查看与定位，不复制功能档案的写入口（状态推进 / 生成迭代记录 /
   * 合并 / 关联链接 / 任务编辑只在任务详情弹窗中提供）。卡片与列表行点击后经
   * onOpenTask 交回页面，由 TasksPage 在当前页面就地打开功能档案同款的任务详情
   * 弹窗（不改变地址栏、不跳转），写入口仍只有这一个。
   */
  const openTask = (item: MyTaskListItem) =>
    onOpenTask?.({
      projectId: item.projectId,
      moduleId: item.moduleId,
      featureId: item.featureId,
      taskId: item.taskId,
    });

  const relationLabelOf = (item: MyTaskListItem): string => {
    if (item.groupRole === "MAIN") return "主任务";
    if (item.groupRole === "SOURCE") return "分支任务";
    return "独立任务";
  };

  /**
   * 任务负责人展示（ADR-040）：负责人是平权集合，卡片与列表行都要列出全部人，
   * 用「、」连接，与聚合组卡、功能档案任务面板同一口径。
   */
  const assigneeNamesOf = (item: MyTaskListItem): string => {
    const names = item.assignees.map((assignee) => assignee.name);
    return names.length === 0 ? "—" : names.join("、");
  };

  const renderCard = (item: MyTaskListItem) => {
    const due = dueLabel(item);
    const assigneeNames = assigneeNamesOf(item);
    const projectCode = projectCodes.get(item.projectId);
    const belongingScope =
      item.moduleName +
      (item.featureName === null ? "" : " · " + item.featureName);
    return (
      <button
        type="button"
        className={
          "calm-task-card " + taskToneClassName(item.priority, item.workStatus)
        }
        key={item.taskId}
        data-testid={"my-task-" + item.taskId}
        onClick={() => openTask(item)}
      >
        {/* 2026-09-22 二次定案：编号与「未完成」都不占徽章位；标签从右上角下移到分隔线
            以下的左下角，负责人移到分隔线上方的右侧。 */}
        {/* 项目水印（2026-10-10 产品定案）：项目标识放大成卡片右下角的一枚浅色水印。
            绝对定位、在流外，不撑高卡片；配色与压层级见 design-system.css。 */}
        {projectCode === undefined ? null : (
          <ProjectLogo code={projectCode} className="watermark" />
        )}
        <h3>{item.title}</h3>
        {/* 归属行（2026-10-10 产品要求）：加大加粗的项目名 + 「模块 · 功能」，一行省略；
            项目标识已上移到卡片右下角的水印，不再在这行占位。 */}
        <p className="task-belonging">
          <strong className="belonging-project">{projectNameOf(item)}</strong>
          {" · " + belongingScope}
        </p>
        <div className="calm-card-assignee">
          <span title={"负责人：" + assigneeNames}>
            <InpulseIcon name="users" size={14} />
            {assigneeNames}
          </span>
        </div>
        <div className="calm-card-bottom">
          <span className="task-card-badges">
            <CalmBadge
              tone={taskPriorityBadgeTone(item.priority)}
              title={"优先级：" + taskPriorityLabel(item.priority)}
            >
              {taskPriorityLabel(item.priority)}
            </CalmBadge>
            {item.scopeType === "MODULE" ? (
              <CalmBadge tone="violet">模块级</CalmBadge>
            ) : null}
            {item.groupRole !== null ? (
              <CalmBadge tone={item.groupRole === "MAIN" ? "violet" : "cyan"}>
                {item.groupRole === "MAIN" ? "主任务" : "分支任务"}
              </CalmBadge>
            ) : null}
            {item.hasLeftoverSource ? (
              <CalmBadge tone="leftover" title="由遗留问题转换而来的跟进任务">
                遗留问题
              </CalmBadge>
            ) : null}
            {item.workStatus === "TODO" ? null : (
              <CalmBadge tone={statusTone[item.workStatus]}>
                {statusLabels[item.workStatus]}
              </CalmBadge>
            )}
          </span>
          <span className={dueToneClass(item)} title={"截止：" + due}>
            <InpulseIcon name="clock" size={14} />
            {due}
          </span>
        </div>
        {/* 页脚恒渲染、只让计数按有无记录出现（2026-10-08 产品要求「已完成和未完成
            任务卡片的布局也要一样大」）：原先没有已发布记录时整块不渲染，未完成档的卡片
            就比有记录的已完成卡片矮一截。空页脚由 CSS 的 min-height 占位（见
            design-system.css 的 `.calm-task-card .task-card-footer`），两种卡片等高。 */}
        <div className="task-card-footer">
          {item.publishedRecordCount > 0 ? (
            <span className="task-card-counts">
              <span title={item.publishedRecordCount + " 条已发布迭代记录"}>
                <InpulseIcon name="gitBranch" size={13} />
                记录 {item.publishedRecordCount} 条
              </span>
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  /**
   * 聚合组卡片的负责人名单（2026-09-21 产品要求）：组内分支可以由不同人负责，
   * 卡片要把全部负责人都列出来，不能只显示主任务负责人。按 userId 去重（同一人
   * 同时挂主任务与分支任务时只出现一次）；服务端已把主任务排在分支首位，保持
   * 原始顺序即可让主任务负责人在最前。
   */
  const branchAssigneeNames = (group: MyTaskGroupItem): readonly string[] => {
    const seen = new Set<number>();
    const names: string[] = [];
    for (const branch of group.branches) {
      if (seen.has(branch.assignee.userId)) continue;
      seen.add(branch.assignee.userId);
      names.push(branch.assignee.name);
    }
    return names;
  };

  /**
   * 聚合组的派生态（2026-09-21 产品定案）：卡片与列表行共用同一份事实，避免两处
   * 判定漂移。优先级取未完成（TODO）分支中最高的一档；该分支完成后自动落到第二高，
   * 全部分支收尾后按「已完成」呈现并隐藏优先级徽章。组卡与组行配色（2026-09-22 产品
   * 定案「组合任务取消紫色，按合并任务以内部未完成任务中的最高优先级显示颜色」）直接
   * 复用任务卡片的 `.tone-prio-*`：进行中跟随上面的派生优先级，全部分支收尾取完成青碧，
   * 已关闭且无分支没有事实可派生、走中性灰；聚合组不再有紫色 / 靛蓝那套组专用色。
   * 组自身的 ACTIVE / CLOSED 合并语义不变。
   * 已取消与已完成一样算收尾，否则被取消的分支会永远压住组优先级。
   */
  const describeTaskGroup = (group: MyTaskGroupItem) => {
    const mainBranch =
      group.branches.find((branch) => branch.role === "MAIN") ?? null;
    const assigneeNames = branchAssigneeNames(group);
    const assigneeText =
      assigneeNames.length === 0 ? "—" : assigneeNames.join("、");
    const assigneeTitle =
      assigneeNames.length === 0
        ? "已关闭的聚合组：负责人保留在详情中"
        : assigneeNames.length === 1 && mainBranch !== null
          ? "主任务负责人：" + assigneeText
          : "各分支负责人：" + assigneeText + "（含主任务与全部分支任务）";
    const doneCount = group.branches.filter(
      (branch) => branch.workStatus === "DONE",
    ).length;
    const active = group.status === "ACTIVE";
    const priority = highestOpenPriority(group);
    const completed = isTaskGroupCompleted(group);
    // 组卡 / 组行只吃任务卡片那套 .tone-prio-*，判定与任务卡片完全同源：已完成取完成青碧、
    // 无分支的已关闭组取中性灰，其余按未完成分支最高优先级取色；已逾期 / 今天到期不覆盖
    // 底色（2026-09-22 产品口径），只在右下角日期文案与列表截止列用红色提示。
    // 组件状态徽章（2026-09-22 产品口径）：组内没有任何分支完成 →「未开始」；任意分支
    // 完成 →「进行中」；全部分支收尾 →「已完成」，并随 completed 一并归到工具栏「已完成」
    // 那一档。已取消与已完成一样算收尾，所以「已完成」看的是 completed（未完成分支已清空），
    // 而 doneCount 只数 DONE——存在已取消分支时两者可以不同，徽章文案以 completed 为准；
    // 徽章的 title 保留「n / N 条分支任务已完成」的明细计数。已关闭且没有分支的组没有可判定
    // 的事实，保留既有的「已关闭」，不参与未开始 / 进行中 / 已完成三态。
    const stateLabel =
      group.branches.length === 0
        ? active
          ? "未开始"
          : "已关闭"
        : completed
          ? "已完成"
          : doneCount > 0
            ? "进行中"
            : "未开始";
    const stateTone: CalmBadgeTone =
      stateLabel === "已完成"
        ? "green"
        : stateLabel === "进行中"
          ? "blue"
          : "gray";
    const stateTitle =
      group.branches.length === 0
        ? "已关闭的聚合组：分支历史保留在详情中"
        : doneCount + " / " + group.branches.length + " 条分支任务已完成";
    // 列表行的「归属 / 截止 / 迭代」三列（2026-09-22 产品口径）：归属跟随主任务所在
    // 模块 / 功能；截止取未完成（TODO）分支中最早的一条——该条完成后自动落到下一条，
    // 未完成分支都没设截止时与任务行同文案「未设置截止」（2026-09-22 产品补充）；
    // 迭代汇总全部分支的 PUBLISHED 记录数（与任务行同口径，含分支任务而不只是主任务）。
    // 三列都只读服务端透传的事实字段，不在渲染处另算。
    const ownershipText =
      mainBranch === null
        ? "—"
        : mainBranch.moduleName +
          (mainBranch.featureName === null
            ? ""
            : " / " + mainBranch.featureName);
    const ownershipTitle =
      mainBranch === null
        ? "已关闭的聚合组：分支归属保留在详情中"
        : "归属跟随主任务：" + ownershipText;
    const unfinishedDueAt = earliestOpenDueAt(group);
    // 未完成分支都没设截止时走 dueLabelOf 的既有口径（「未设置截止」），与任务行同文案；
    // 只有无分支的 CLOSED 组才保留「—」，此时不存在任何分支截止事实。
    const hasBranches = group.branches.length > 0;
    const dueSubject: DueSubject = {
      workStatus: "TODO",
      dueAt: unfinishedDueAt,
    };
    // 整卡 tone：与任务卡片同一套口径——全部分支收尾取完成青碧、无分支的已关闭组取中性灰、
    // 其余按未完成分支里的最高优先级取色。已逾期 / 今天到期不参与配色（2026-09-22 产品口径
    // 「逾期的不搞特殊了，原本的优先级是什么就呈现什么颜色」），只在右下角日期文案与列表截止
    // 列用红色提示；组卡底色因此与任务卡片、列表组行三处同源。
    const tone = completed
      ? taskToneClassName("NORMAL", "DONE")
      : priority === null
        ? taskToneClassName("NORMAL", "CANCELED")
        : taskToneClassName(priority, "TODO");
    const dueText = hasBranches ? dueLabelOf(dueSubject) : "—";
    const dueTitle =
      unfinishedDueAt === null
        ? hasBranches
          ? "未完成分支都没有设置截止时间（分支截止见详情）"
          : "已关闭的聚合组：分支历史保留在详情中"
        : "未完成分支中最早的截止：" + dueText;
    const dueTone = dueToneClass(dueSubject);
    const recordTotal = group.branches.reduce(
      (total, branch) => total + branch.publishedRecordCount,
      0,
    );
    const recordTitle =
      group.branches.length === 0
        ? "已关闭的聚合组：分支历史保留在详情中"
        : recordTotal +
          " 条 PUBLISHED 迭代记录（合计 " +
          group.branches.length +
          " 条分支，与任务行同口径）";
    return {
      assigneeText,
      assigneeTitle,
      doneCount,
      stateLabel,
      stateTone,
      stateTitle,
      active,
      priority,
      completed,
      tone,
      ownershipText,
      ownershipTitle,
      dueText,
      dueTitle,
      dueTone,
      recordTotal,
      recordTitle,
    };
  };

  /**
   * 聚合组卡片（2026-09-21 产品定案）：与任务卡片同款外观、同一网格呈现，
   * 卡片只做入口——分支明细、来源类型、解除合并与主任务直达都在聚合组弹窗里，
   * 卡片上只额外列出去重后的分支负责人（可能多人）。CLOSED 组按服务端口径
   * 没有分支，只保留组名与状态。
   * 纵向排版（2026-09-22 产品要求「这个卡片的布局要和 P2 一样」，同日追加「组合任务的
   * 排版和单个任务排版对齐统一」）：与任务卡片逐行同构——标题、归属、负责人（右对齐贴
   * 分隔线）、分隔线以下「左下角标签组 + 右下角截止」。顶部「编号 + 徽章」行与卡片上的
   * 编号一并删除，编号只留在列表视图与弹窗里；「查看详情 / 解除合并」提示与页脚整块不再
   * 渲染（整卡即弹窗入口）。分支完成计数不再单占右上角一行，改由状态徽章承载。
   */
  const renderGroupCard = (group: MyTaskGroupItem) => {
    const {
      assigneeText,
      assigneeTitle,
      stateLabel,
      stateTitle,
      stateTone,
      priority: groupPriority,
      tone: groupTone,
      dueText,
      dueTitle,
      dueTone,
    } = describeTaskGroup(group);
    const groupProjectCode = projectCodes.get(group.projectId);
    return (
      <button
        type="button"
        className={"calm-task-card task-group-card " + groupTone}
        key={"group-" + group.groupId}
        data-testid={"my-task-group-" + group.groupId}
        aria-haspopup="dialog"
        onClick={() => setOpenGroupId(group.groupId)}
      >
        {/* 2026-09-22 组卡排版（产品要求「这个卡片的布局要和 P2 一样」，随后追加「把左下角
            已完成放到右上角、取消提示文案，直接点卡片就能看详情」，同日再次追加「组合任务的
            排版和单个任务排版对齐统一」）：与任务卡片逐行同构——标题 → 归属 → 负责人右对齐
            贴分隔线 → 分隔线以下「左下角标签组 + 右下角截止」。原来单占右上角一行的分支完成
            计数改由状态徽章（未开始 / 进行中 / 已完成）表达，「n / N 条分支任务已完成」的明细
            计数放进该徽章的 title；底部那一排只留三枚徽章（优先级 / 聚合组 / 状态），分支数收进
            「聚合组」徽章的 title——272px 卡片里第四枚标签必然折到第三行，把这一排顶高。右下角
            让给任务卡同款的截止（取未完成分支中最早的一条）。顶部「编号 + 徽章」行与卡片上的
            编号一并删除，编号只留在列表视图与弹窗里；没有分支的 CLOSED 组同样只渲染这一套
            结构，截止占位为「—」。 */}
        {/* 项目水印与任务卡片同口径（2026-10-10 产品定案）：右下角一枚浅色字母水印。 */}
        {groupProjectCode === undefined ? null : (
          <ProjectLogo code={groupProjectCode} className="watermark" />
        )}
        <h3>{group.name}</h3>
        {/* 归属行与任务卡片同口径（2026-10-10）：只留加大加粗的项目名。 */}
        <p className="task-belonging">
          <strong className="belonging-project">
            {projectNames.get(group.projectId) ?? group.projectName}
          </strong>
        </p>
        <div className="calm-card-assignee">
          <span title={assigneeTitle}>
            <InpulseIcon name="users" size={14} />
            <span className="task-group-assignee-names">{assigneeText}</span>
          </span>
          <span
            title={
              group.branches.length > 0
                ? "包含主分支与全部分支任务"
                : "已关闭的聚合组：分支历史保留在详情中"
            }
          >
            <InpulseIcon name="gitMerge" size={14} />
            {group.branches.length > 0
              ? group.branches.length + " 条分支"
              : "—"}
          </span>
        </div>
        <div className="calm-card-bottom">
          <span className="task-card-badges">
            {groupPriority === null ? null : (
              <CalmBadge
                tone={taskPriorityBadgeTone(groupPriority)}
                title={
                  "优先级：" +
                  taskPriorityLabel(groupPriority) +
                  "（未完成分支中最高）"
                }
              >
                {taskPriorityLabel(groupPriority)}
              </CalmBadge>
            )}
            {/* 底部那一排只留三枚徽章（2026-09-22 三次调整）：272px 卡片里四个标签必然
                折行，把底部那一排顶到三行、整卡比任务卡片高一截；分支数改成「聚合组」
                徽章的 title（列表视图仍逐字给出「编号 · 聚合组 · n 条分支」）。 */}
            <CalmBadge
              tone="violet"
              title={
                group.branches.length > 0
                  ? "聚合组：包含 " +
                    group.branches.length +
                    " 条分支（主分支与全部来源分支）"
                  : "已关闭的聚合组：分支历史保留在详情中"
              }
            >
              聚合组
            </CalmBadge>
            <CalmBadge tone={stateTone} title={stateTitle}>
              {stateLabel}
            </CalmBadge>
          </span>
          <span className={dueTone} title={dueTitle}>
            <InpulseIcon name="clock" size={14} />
            {dueText}
          </span>
        </div>
        {/* 组卡没有记录计数，页脚盒仍与任务卡片保持同构（2026-10-08 产品要求「已完成和
            未完成任务卡片的布局也要一样大」）。任务卡片的空页脚自 2026-10-10 起由
            `.calm-task-card .task-card-footer:empty { display: none }` 隐藏、不再占高度，
            组卡这个空盒同理不占高度，保留它只为与任务卡片逐行同构（断言见
            TaskCenterPageView.test.tsx）。 */}
        <div className="task-card-footer" />
      </button>
    );
  };

  /**
   * 列表模式整行可点（2026-09-23 产品要求）：点击任务行 / 聚合组行的任意横向位置都能
   * 打开详情，不再只靠「任务」列那一小块标题热区。三点约束：
   * 1. 行内唯一的交互元素是标题按钮，命中按钮时直接返回、交给按钮自己的 onClick，避免
   *    一次点击触发两遍；键盘可达性仍由该按钮承担（行不加 tabIndex，不新增 Tab 停靠点）。
   * 2. 拖选标题 / 编号想复制（选区非空）时不打开弹窗。
   * 3. 只挂在 <tr> 上，不改列结构，列宽与省略号规则不受影响。
   */
  const rowClickOpens =
    (open: () => void) => (event: React.MouseEvent<HTMLTableRowElement>) => {
      const { target } = event;
      if (target instanceof Element && target.closest("button") !== null)
        return;
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      open();
    };

  /**
   * 列表视图下的聚合组行（2026-09-22 产品要求：聚合组要跟随「卡片 / 列表」切换）：
   * 与任务行共用同一张表格与表头，列语义保持一致——任务列给组名、「编号 · 聚合组」
   * 与分支数，负责人取去重后的分支名单；优先级取未完成分支最高一档，状态取「未开始 /
   * 进行中 / 已完成」三态（与组卡同源，见 describeTaskGroup）。归属跟随主任务所在
   * 模块 / 功能；截止取未完成分支中最早的一条（该条完成后自动落到下一条）；迭代汇总
   * 全部分支的 PUBLISHED 记录数——三列与卡片共用 `describeTaskGroup`，不在渲染处另算。
   * 整行沿用派生优先级配色，与卡片视图及任务行同一套 `tone-prio-*` 色值（组行只吃浅色变量）。
   */
  const renderGroupRow = (group: MyTaskGroupItem) => {
    const {
      assigneeText,
      assigneeTitle,
      stateLabel,
      stateTitle,
      stateTone,
      priority: groupPriority,
      tone: groupTone,
      ownershipText,
      ownershipTitle,
      dueText,
      dueTitle,
      dueTone,
      recordTotal,
      recordTitle,
    } = describeTaskGroup(group);
    return (
      <tr
        key={"group-" + group.groupId}
        data-testid={"my-task-group-" + group.groupId}
        className={groupTone}
        onClick={rowClickOpens(() => setOpenGroupId(group.groupId))}
      >
        <td>
          <button
            type="button"
            className="feature-list-open"
            aria-haspopup="dialog"
            onClick={() => setOpenGroupId(group.groupId)}
          >
            <strong>{group.name}</strong>
            <span>
              {group.code + " · 聚合组"}
              {group.branches.length > 0
                ? " · " + group.branches.length + " 条分支"
                : ""}
            </span>
          </button>
        </td>
        <td>{projectNames.get(group.projectId) ?? group.projectName}</td>
        <td title={ownershipTitle}>{ownershipText}</td>
        <td title={assigneeTitle}>{assigneeText}</td>
        <td>
          {groupPriority === null ? (
            "—"
          ) : (
            <CalmBadge
              tone={taskPriorityBadgeTone(groupPriority)}
              title={
                "优先级：" +
                taskPriorityLabel(groupPriority) +
                "（未完成分支中最高）"
              }
            >
              {taskPriorityLabel(groupPriority)}
            </CalmBadge>
          )}
        </td>
        <td className={dueTone} title={dueTitle}>
          {dueText}
        </td>
        <td title={recordTitle}>{recordTotal}</td>
        <td>
          <CalmBadge tone={stateTone} title={stateTitle}>
            {stateLabel}
          </CalmBadge>
        </td>
      </tr>
    );
  };

  const taskEntriesOf = (
    items: readonly MyTaskListItem[],
  ): readonly TaskCenterGridEntry[] =>
    items.map((item) => ({
      kind: "task" as const,
      item,
      rank: [
        statusGroupRankOf(item.workStatus),
        completedRankOf(item.workStatus, item.completedAt),
        taskUrgencyBucket(item),
        priorityRankOf(item.priority),
        leftoverRankOf(item.workStatus === "TODO" && item.hasLeftoverSource),
        dueRankOf(item.dueAt),
      ],
    }));
  const gridEntries: readonly TaskCenterGridEntry[] = [
    ...taskEntriesOf(primaryItems),
    ...primaryGroups.map((group) => ({
      kind: "group" as const,
      group,
      rank: [
        groupHasOpenWork(group) ? 0 : 1,
        // 组卡没有完成时间这个事实（R-7 分支 DTO 不透传 completed_at），取归一值 0：
        // 已完成的组排在已完成任务之后，组之间保持服务端的 groupId DESC 顺序。
        0,
        taskGroupUrgencyBucket(group),
        taskGroupPriorityRank(group),
        // 组卡也没有「遗留问题来源」这个事实，固定取 1（与服务端非未完成分支同值）。
        1,
        dueRankOf(earliestOpenDueAt(group)),
      ],
    })),
  ].sort((left, right) => compareGridRank(left.rank, right.rank));

  const renderTable = (entries: readonly TaskCenterGridEntry[]) => (
    <div className="feature-list-scroll">
      <table className="feature-list-table task-center-table">
        <caption className="sr-only">跨项目任务列表</caption>
        <thead>
          <tr>
            <th scope="col">任务</th>
            <th scope="col">项目</th>
            <th scope="col">归属</th>
            <th scope="col">负责人</th>
            <th scope="col">优先级</th>
            <th scope="col">截止</th>
            <th scope="col">迭代</th>
            <th scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) =>
            entry.kind === "group" ? (
              renderGroupRow(entry.group)
            ) : (
              <tr
                key={entry.item.taskId}
                className={taskToneClassName(
                  entry.item.priority,
                  entry.item.workStatus,
                )}
                onClick={rowClickOpens(() => openTask(entry.item))}
              >
                <td>
                  <button
                    type="button"
                    className="feature-list-open"
                    onClick={() => openTask(entry.item)}
                  >
                    <strong>{entry.item.title}</strong>
                    {/* 编号不再是独立列：并入标题下方小字，把列宽让给标题。 */}
                    <span>
                      {entry.item.code + " · " + relationLabelOf(entry.item)}
                      {entry.item.scopeType === "MODULE" ? " · 模块级" : ""}
                      {entry.item.hasLeftoverSource ? " · 遗留问题" : ""}
                    </span>
                  </button>
                </td>
                <td>{projectNameOf(entry.item)}</td>
                <td>
                  {entry.item.moduleName +
                    (entry.item.featureName === null
                      ? ""
                      : " / " + entry.item.featureName)}
                </td>
                <td title={assigneeNamesOf(entry.item)}>
                  {assigneeNamesOf(entry.item)}
                </td>
                <td>
                  <CalmBadge tone={taskPriorityBadgeTone(entry.item.priority)}>
                    {taskPriorityLabel(entry.item.priority)}
                  </CalmBadge>
                </td>
                <td className={dueToneClass(entry.item)}>
                  {dueLabel(entry.item) ?? "—"}
                </td>
                <td>{entry.item.publishedRecordCount}</td>
                <td>
                  <CalmBadge tone={statusTone[entry.item.workStatus]}>
                    {statusLabels[entry.item.workStatus]}
                  </CalmBadge>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <section
      className="task-center"
      aria-label="任务中心"
      data-testid="task-center"
    >
      <div className="sticky-page-band task-center-page-band">
        <div className="page-header">
          <div>
            <h1>任务中心</h1>
            <p>
              所有工作从这里展开：任务负责推进，完成后沉淀为迭代记录，遗留问题继续转为新任务。
            </p>
          </div>
          <div className="catalog-actions">
            {/* 2026-09-22（方案 A）：数量由裸文字改为数量签，与工具栏的状态角标同一种表达。
                签对辅助技术隐藏（与侧栏 `.nav-item em` 同口径），按钮名改由 aria-label
                显式给出，仍是「遗留问题 N」，读屏与既有用例口径不变。 */}
            <button
              type="button"
              className="secondary-button"
              aria-label={
                leftoverCount !== null && leftoverCount > 0
                  ? "遗留问题 " + leftoverCount
                  : "遗留问题"
              }
              onClick={onOpenIssues}
            >
              <InpulseIcon name="alert" size={15} />
              遗留问题
              {leftoverCount !== null && leftoverCount > 0 ? (
                <em className="header-count" aria-hidden="true">
                  {leftoverCount}
                </em>
              ) : null}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => setCreateOpen(true)}
            >
              <InpulseIcon name="plus" size={16} />
              新建任务
            </button>
          </div>
        </div>

        {activeAdapter.source === "mock" ? (
          <div className="skeleton-note" data-testid="task-center-mock-notice">
            <InpulseIcon name="alert" size={16} />
            <span>
              <strong>骨架数据：</strong>
              {activeAdapter.notice}
            </span>
          </div>
        ) : null}

        {filters.overdue && (
          <p>
            仅显示已逾期任务
            {filters.projectId !== null
              ? ` · ${projectNames.get(filters.projectId) ?? "当前项目"}`
              : ""}{" "}
            <button type="button" onClick={() => update({ overdue: false })}>
              清除逾期筛选
            </button>
          </p>
        )}
        {/* 2026-09-22（方案 A）一体化控制条：工作状态（带数量）· 搜索 · 项目 / 优先级 /
            任务范围 · 展示方式收进同一条白底控制条。既有结构全部保留——「更多筛选」仍是
            `.task-toolbar` 的直接子元素与 `.secondary-button`（设计系统按定案把它常驻
            display:none，靠 DOM 事件展开面板），间距仍由 `.task-center` 的页头 / 工具栏
            外边距决定，标题到工具栏与工具栏到卡片的节奏不变。 */}
        <div className="toolbar task-toolbar task-toolbar-bar">
          <CalmSegmented
            label="工作状态"
            value={filters.status}
            options={statusOptions(stats)}
            onChange={(status) => update({ status })}
          />
          <span className="task-toolbar-divider" aria-hidden="true" />
          <div className="task-search">
            <InpulseIcon name="search" size={16} />
            <input
              ref={searchInputRef}
              value={queryDraft}
              placeholder="搜索任务编号、标题、描述、归属或负责人"
              aria-label="搜索任务"
              disabled={!enabled("filter:query")}
              onChange={handleQueryChange}
              onCompositionStart={handleQueryCompositionStart}
              onCompositionEnd={handleQueryCompositionEnd}
              onBlur={handleQueryBlur}
              onKeyDown={handleQueryKeyDown}
            />
          </div>
          {/* 下拉自身已显示「全部项目 / 项目名」，重复的文字标签已按产品要求删除；
              无障碍定位仍由 CalmSelect 的 aria-label 提供。 */}
          <CalmSelect
            ariaLabel="项目"
            animated
            value={filters.projectId === null ? "" : String(filters.projectId)}
            onChange={(next) => {
              const parsed = typeof next === "number" ? next : Number(next);
              update({
                projectId:
                  Number.isInteger(parsed) && parsed > 0 ? parsed : null,
              });
            }}
            options={[
              { value: "", label: "全部项目" },
              ...projects.map((project) => projectSelectOption(project)),
            ]}
            appearance="rich"
          />
          <CalmSelect
            ariaLabel="优先级"
            animated
            value={filters.priority ?? ""}
            disabled={!enabled("filter:priority")}
            appearance="menu"
            onChange={(next) =>
              update({
                priority: next === "" ? null : (next as MyTaskPriority),
              })
            }
            options={[
              // 收起态直接显示「全部优先级」而不是「全部」，否则单看触发器看不出
              // 这是哪个维度的筛选；与任务看板 TaskBoardToolbar 的同名选项保持一致。
              { value: "", label: "全部优先级" },
              ...priorityOrder.map((priority) => ({
                value: priority,
                label: taskPriorityLabel(priority),
                dotColor: priorityDotColor(priority),
              })),
            ]}
          />
          <CalmSelect
            ariaLabel="任务范围"
            animated
            value={filters.level ?? ""}
            appearance="notion"
            onChange={(next) =>
              update({
                level: next === "" ? null : (next as MyTaskLevel),
              })
            }
            options={[
              { value: "", label: "功能级与模块级" },
              { value: "FEATURE", label: "功能级任务", emoji: "\u{1F3AF}" },
              { value: "MODULE", label: "模块级任务", emoji: "\u{1F9E9}" },
            ]}
          />
          <button
            type="button"
            className="secondary-button"
            aria-expanded={advancedOpen}
            onClick={onToggleAdvanced}
          >
            <InpulseIcon name="sliders" size={15} />
            更多筛选{activeFilterCount > 0 ? " · " + activeFilterCount : ""}
          </button>
          <div className="task-toolbar-view">
            <CalmSegmented
              label="展示方式"
              value={filters.display}
              options={displayOptions}
              onChange={(display) => update({ display })}
            />
          </div>
        </div>
      </div>

      {localGaps.length > 0 ? (
        <p className="view-description" data-testid="task-center-local-note">
          {localFilterNote(localGaps, items.length)}
        </p>
      ) : null}

      {advancedOpen ? (
        <div className="filter-panel">
          <label>
            合并关系
            <CalmSelect
              ariaLabel="合并关系"
              animated
              value={filters.relation ?? ""}
              disabled={!enabled("filter:relation")}
              appearance="menu"
              onChange={(next) =>
                update({
                  relation: next === "" ? null : (next as MyTaskRelation),
                })
              }
              options={[
                { value: "", label: "全部" },
                { value: "STANDALONE", label: "独立任务" },
                { value: "MAIN", label: "主任务" },
                { value: "SOURCE", label: "分支任务" },
              ]}
            />
          </label>
          <label>
            是否有迭代记录
            <CalmSelect
              ariaLabel="是否有迭代记录"
              animated
              value={filters.hasRecord ?? ""}
              appearance="menu"
              onChange={(next) =>
                update({
                  hasRecord: next === "" ? null : (next as MyTaskRecordFilter),
                })
              }
              options={[
                { value: "", label: "全部" },
                { value: "yes", label: "有记录" },
                { value: "no", label: "无记录" },
              ]}
            />
          </label>
          <label>
            是否有 GitHub
            <CalmSelect
              ariaLabel="是否有 GitHub"
              animated
              value={filters.hasGithub ?? ""}
              disabled={!enabled("filter:github")}
              appearance="menu"
              onChange={(next) =>
                update({
                  hasGithub: next === "" ? null : (next as MyTaskGithubFilter),
                })
              }
              options={[
                { value: "", label: "全部" },
                { value: "yes", label: "已关联" },
                { value: "no", label: "未关联" },
              ]}
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={filters.includeCanceled}
              disabled={!enabled("filter:canceled-with-open")}
              onChange={(event) =>
                update({ includeCanceled: event.target.checked })
              }
            />
            显示已取消任务（不计入完成率）
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => onFiltersChange(DEFAULT_MY_TASK_FILTERS)}
          >
            重置筛选
          </button>
        </div>
      ) : null}

      {filters.scope === "project" && filters.projectId === null ? (
        <CalmEmptyState
          icon="folder"
          title="请选择项目"
          description="选择项目后查看该项目内全员的任务。"
        />
      ) : taskQuery.isPending ? (
        <CalmSkeleton variant="list" rows={4} label="正在加载任务列表…" />
      ) : taskQuery.isError ? (
        <Alert type="error" title={describeMyTasksError(taskQuery.error)} />
      ) : (
        <>
          {/*
            工作状态已由工具栏「未完成 / 已完成」筛选表达，这里不再重复标题与
            「n 项 · 排序」两行文字。2026-10-08：原来的展示方式图标（列表当前是
            卡片还是表格）与工具栏「卡片 / 列表」切换完全重复，按用户指示删除；
            工具栏到列表的 30px 由 .task-center .task-toolbar 的下外边距承担。
          */}
          {hasListContent ? (
            filters.display === "cards" ? (
              // 聚合组卡片与任务卡片同一网格混排，顺序由 gridEntries 统一决定
              // （状态分组 → 紧急桶 → 优先级 → 遗留问题来源 → 截止时间近到远），不再把组卡固定在尾部。
              <div className="calm-task-grid">
                {gridEntries.map((entry) =>
                  entry.kind === "task"
                    ? renderCard(entry.item)
                    : renderGroupCard(entry.group),
                )}
              </div>
            ) : (
              // 聚合组跟随展示方式切换（2026-09-22 产品要求）：列表视图下组行与
              // 任务行同表，且与卡片视图同一顺序。
              renderTable(gridEntries)
            )
          ) : groupsQuery.isPending ? (
            // 任务为空且聚合组仍在加载：先给加载态，避免空态一闪再被组卡片顶掉。
            <CalmSkeleton variant="list" rows={4} label="正在加载任务列表…" />
          ) : (
            <CalmEmptyState
              icon="check"
              title={listEmptyTitle}
              description={listEmptyDescription}
            />
          )}
          {filters.status === "open" && doneItems.length > 0 ? (
            <details
              className="calm-disclosure history-block"
              open={openItems.length === 0}
            >
              <summary>
                已完成 {doneItems.length} 项 · 保留编号、负责人与全部迭代记录
              </summary>
              {renderTable(taskEntriesOf(doneItems))}
            </details>
          ) : null}
          {filters.status !== "all" && canceledItems.length > 0 ? (
            <details className="calm-disclosure history-block">
              <summary>
                已取消 {canceledItems.length} 项 · 默认折叠，不计入完成率
              </summary>
              {renderTable(taskEntriesOf(canceledItems))}
            </details>
          ) : null}
        </>
      )}

      {groupsQuery.isError ? (
        // 聚合组读取失败不回退成员去重（判据在任务侧 groupRole）：错误就地提示，
        // 未入组的任务卡片照常可用。
        <Alert type="error" title={describeMyTasksError(groupsQuery.error)} />
      ) : null}

      {taskQuery.hasNextPage || groupsQuery.hasNextPage ? (
        <div className="task-more-row">
          {taskQuery.hasNextPage ? (
            <Button
              loading={taskQuery.isFetchingNextPage}
              onClick={() => void taskQuery.fetchNextPage()}
            >
              加载更多任务
            </Button>
          ) : null}
          {groupsQuery.hasNextPage ? (
            <button
              type="button"
              className="secondary-button"
              disabled={groupsQuery.isFetchingNextPage}
              onClick={() => void groupsQuery.fetchNextPage()}
            >
              {groupsQuery.isFetchingNextPage ? "正在加载…" : "加载更多聚合组"}
            </button>
          ) : null}
        </div>
      ) : null}

      <TaskGroupDetailModal
        groupId={openGroupId}
        adapter={groupAdapter}
        api={api}
        onClose={() => setOpenGroupId(null)}
        onChanged={() => void groupsQuery.refetch()}
        onOpenTask={onOpenTask}
      />

      <GlobalTaskCreateModal
        onCreatedLocation={onOpenTask}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        client={client}
        preset={
          filters.projectId !== null
            ? { projectId: filters.projectId }
            : undefined
        }
      />
    </section>
  );
};

export default TaskCenterPageView;

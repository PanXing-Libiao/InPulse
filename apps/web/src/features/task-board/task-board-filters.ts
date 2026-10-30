import type {
  TaskBoardCard,
  TaskBoardFilters,
  TaskBoardModule,
  TaskBoardPriority,
  TaskBoardStatusFilter,
  TaskBoardTimeFilter,
  TaskBoardView,
  UserRef,
} from "./task-board-types";

/**
 * 任务看板 URL 状态与本地筛选。
 *
 * 与 F-30（任务中心）同一约定：筛选状态由 URL 承载，页面不保留内部副本。
 * 参数：view=board|list、status=all|open|done、time=all|overdue|today、
 * priority=NORMAL|HIGH|URGENT、owner=<userId>、q=<关键词>。
 * 与默认值相同的项不写入 URL；非法值一律回退默认值。
 *
 * 筛选在本地执行（服务端一次返回项目全量看板），顶部统计不受筛选影响，
 * 这与「统计恒为项目全量口径」的定稿一致。
 */

export const DEFAULT_TASK_BOARD_FILTERS: TaskBoardFilters = {
  view: "board",
  status: "all",
  time: "all",
  priority: null,
  assigneeId: null,
  query: "",
};

const viewValues: readonly TaskBoardView[] = ["board", "list"];
const statusValues: readonly TaskBoardStatusFilter[] = ["all", "open", "done"];
const timeValues: readonly TaskBoardTimeFilter[] = ["all", "overdue", "today"];
const priorityValues: readonly TaskBoardPriority[] = [
  "NORMAL",
  "HIGH",
  "URGENT",
];

function pick<T extends string>(
  values: readonly T[],
  raw: string | null,
): T | null {
  if (raw === null) return null;
  return values.find((value) => value === raw) ?? null;
}

function readPositiveId(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
    return null;
  }
  return parsed;
}

export function readTaskBoardFilters(
  params: URLSearchParams,
): TaskBoardFilters {
  return {
    view:
      pick(viewValues, params.get("view")) ?? DEFAULT_TASK_BOARD_FILTERS.view,
    status:
      pick(statusValues, params.get("status")) ??
      DEFAULT_TASK_BOARD_FILTERS.status,
    time:
      pick(timeValues, params.get("time")) ?? DEFAULT_TASK_BOARD_FILTERS.time,
    priority: pick(priorityValues, params.get("priority")),
    assigneeId: readPositiveId(params.get("owner")),
    query: params.get("q") ?? "",
  };
}

export function writeTaskBoardFilters(
  filters: TaskBoardFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.view !== DEFAULT_TASK_BOARD_FILTERS.view) {
    params.set("view", filters.view);
  }
  if (filters.status !== DEFAULT_TASK_BOARD_FILTERS.status) {
    params.set("status", filters.status);
  }
  if (filters.time !== DEFAULT_TASK_BOARD_FILTERS.time) {
    params.set("time", filters.time);
  }
  if (filters.priority !== null) {
    params.set("priority", filters.priority);
  }
  if (filters.assigneeId !== null) {
    params.set("owner", String(filters.assigneeId));
  }
  const term = filters.query.trim();
  if (term.length > 0) {
    params.set("q", term);
  }
  return params;
}

/** 是否存在生效中的筛选（视图切换不算筛选）。 */
export function hasActiveTaskBoardFilters(filters: TaskBoardFilters): boolean {
  return (
    filters.status !== DEFAULT_TASK_BOARD_FILTERS.status ||
    filters.time !== DEFAULT_TASK_BOARD_FILTERS.time ||
    filters.priority !== null ||
    filters.assigneeId !== null ||
    filters.query.trim().length > 0
  );
}

/**
 * 单张卡片是否命中筛选。搜索覆盖编号 / 标题 / 负责人姓名，
 * 与预览一致；时间筛选只认服务端 dueState，不在前端重算逾期。
 */
export function matchesTaskBoardCard(
  card: TaskBoardCard,
  filters: TaskBoardFilters,
): boolean {
  if (filters.status === "open" && card.workStatus !== "TODO") return false;
  if (filters.status === "done" && card.workStatus !== "DONE") return false;
  if (filters.time === "overdue" && card.dueState !== "OVERDUE") return false;
  if (filters.time === "today" && card.dueState !== "TODAY") return false;
  if (filters.priority !== null && card.priority !== filters.priority) {
    return false;
  }
  if (
    filters.assigneeId !== null &&
    !card.assignees.some((assignee) => assignee.userId === filters.assigneeId)
  ) {
    return false;
  }
  const term = filters.query.trim().toLowerCase();
  if (term.length > 0) {
    const haystack = [
      card.code,
      card.title,
      ...card.assignees.map((assignee) => assignee.name),
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(term)) return false;
  }
  return true;
}

/** 过滤后仍按模块泳道组织；过滤为空的泳道整体隐藏（与预览一致）。 */
export function filterTaskBoardModules(
  modules: readonly TaskBoardModule[],
  filters: TaskBoardFilters,
): readonly TaskBoardModule[] {
  const result: TaskBoardModule[] = [];
  for (const lane of modules) {
    const tasks = lane.tasks.filter((card) =>
      matchesTaskBoardCard(card, filters),
    );
    if (tasks.length === 0) continue;
    result.push({ ...lane, tasks });
  }
  return result;
}

export function countTaskBoardTasks(
  modules: readonly TaskBoardModule[],
): number {
  let total = 0;
  for (const lane of modules) {
    total += lane.tasks.length;
  }
  return total;
}

/**
 * 负责人下拉选项：看板内实际出现的负责人按姓名排序去重（ADR-040 集合口径，
 * 多负责人的任务每个人都要进选项）。选项来自全量看板（不受筛选影响），
 * 避免「筛选后选项消失」无法回退。
 */
export function collectTaskBoardAssignees(
  modules: readonly TaskBoardModule[],
): readonly UserRef[] {
  const byId = new Map<number, UserRef>();
  for (const lane of modules) {
    for (const card of lane.tasks) {
      for (const assignee of card.assignees) {
        if (!byId.has(assignee.userId)) {
          byId.set(assignee.userId, assignee);
        }
      }
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-Hans-CN"),
  );
}

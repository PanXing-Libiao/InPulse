import type {
  MyTaskDisplay,
  MyTaskFilters,
  MyTaskPriority,
  MyTaskRecordFilter,
  MyTaskRelation,
  MyTaskScope,
  MyTaskStatusFilter,
} from "./my-tasks-types";

/**
 * 任务中心 URL 状态（F-30：筛选状态由 URL 承载，页面不保留内部副本）。
 *
 * 参数约定：scope=mine|created|project|all、project=<项目 id>、
 * status=open|done|all、priority、relation、record=yes|no、
 * github=yes|no、canceled=1、q=<关键词>、view=cards|list、more=1、today=1、overdue=1。
 * 与默认值相同的项不写入 URL；非法值一律回退默认值。
 */

export const MY_TASKS_MORE_PARAM = "more";

export const DEFAULT_MY_TASK_FILTERS: MyTaskFilters = {
  scope: "mine",
  projectId: null,
  status: "open",
  // 2026-09-21 起「今日待办」不再有 UI 入口（原四张统计卡已删除）：缺省口径
  // 是「全部未完成任务」，只有显式 ?today=1 才收窄到今日待办。
  todayTodo: false,
  priority: null,
  relation: null,
  hasRecord: null,
  hasGithub: null,
  includeCanceled: false,
  query: "",
  display: "cards",
};

const scopeValues: readonly MyTaskScope[] = [
  "mine",
  "created",
  "project",
  "all",
];
const statusValues: readonly MyTaskStatusFilter[] = ["open", "done", "all"];
const priorityValues: readonly MyTaskPriority[] = ["NORMAL", "HIGH", "URGENT"];
const relationValues: readonly MyTaskRelation[] = [
  "STANDALONE",
  "MAIN",
  "SOURCE",
];
const yesNoValues: readonly MyTaskRecordFilter[] = ["yes", "no"];
const displayValues: readonly MyTaskDisplay[] = ["cards", "list"];

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
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2147483647)
    return null;
  return parsed;
}

/**
 * 「今日待办」只在工作状态为「未完成」时有意义：服务端 todayTodo 与 DONE / CANCELED 求交恒为空。
 * 2026-09-21 起工具栏只提供「未完成 / 已完成」两档，今日待办不再有 UI 入口，
 * 因此不带 today 时一律按「全部未完成任务」处理，只有显式 today=1 才收窄。
 */
function readTodayTodo(params: URLSearchParams): boolean {
  return params.get("today") === "1";
}

export interface ReadMyTaskFiltersOptions {
  readonly isAdmin?: boolean;
}

export function readMyTaskFilters(
  params: URLSearchParams,
  options: ReadMyTaskFiltersOptions = {},
): MyTaskFilters {
  const scope =
    pick(scopeValues, params.get("scope")) ?? DEFAULT_MY_TASK_FILTERS.scope;
  const status =
    pick(statusValues, params.get("status")) ?? DEFAULT_MY_TASK_FILTERS.status;
  return {
    scope: scope === "all" && options.isAdmin !== true ? "mine" : scope,
    projectId: readPositiveId(params.get("project")),
    ...(params.get("overdue") === "1" ? { overdue: true } : {}),
    todayTodo: readTodayTodo(params),
    status,
    priority: pick(priorityValues, params.get("priority")),
    relation: pick(relationValues, params.get("relation")),
    hasRecord: pick(yesNoValues, params.get("record")),
    hasGithub: pick(yesNoValues, params.get("github")),
    includeCanceled: params.get("canceled") === "1",
    query: params.get("q") ?? "",
    display:
      pick(displayValues, params.get("view")) ??
      DEFAULT_MY_TASK_FILTERS.display,
  };
}

export interface WriteMyTaskFiltersOptions {
  readonly advancedOpen?: boolean;
}

export function writeMyTaskFilters(
  filters: MyTaskFilters,
  options: WriteMyTaskFiltersOptions = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.scope !== DEFAULT_MY_TASK_FILTERS.scope)
    params.set("scope", filters.scope);
  // 项目筛选（工具栏「项目」下拉）是常驻条件：选定项目即写入 URL，
  // 不再要求 scope=project 或逾期钻取才保留。
  if (filters.projectId !== null)
    params.set("project", String(filters.projectId));
  if (filters.status !== DEFAULT_MY_TASK_FILTERS.status)
    params.set("status", filters.status);
  if (filters.priority !== null) params.set("priority", filters.priority);
  if (filters.relation !== null) params.set("relation", filters.relation);
  if (filters.hasRecord !== null) params.set("record", filters.hasRecord);
  if (filters.hasGithub !== null) params.set("github", filters.hasGithub);
  if (filters.includeCanceled) params.set("canceled", "1");
  const term = filters.query.trim();
  if (term.length > 0) params.set("q", term);
  if (filters.display !== DEFAULT_MY_TASK_FILTERS.display)
    params.set("view", filters.display);
  if (filters.overdue) params.set("overdue", "1");
  // 今日待办只在「未完成」视图下存在，且缺省即「全部未完成」：
  // 只有显式收窄到今日待办才写 today=1；已完成 / 全部视图不存在该筛选，不写。
  if (filters.status === "open" && filters.todayTodo === true)
    params.set("today", "1");
  if (options.advancedOpen === true) params.set(MY_TASKS_MORE_PARAM, "1");
  return params;
}

export function readMyTaskAdvancedOpen(params: URLSearchParams): boolean {
  return params.get(MY_TASKS_MORE_PARAM) === "1";
}

/** 高级筛选角标计数；口径与设计师稿「更多筛选」一致。 */
export function countActiveMyTaskFilters(filters: MyTaskFilters): number {
  return [
    filters.query.trim().length > 0,
    filters.status !== DEFAULT_MY_TASK_FILTERS.status,
    filters.priority !== null,
    filters.relation !== null,
    filters.hasRecord !== null,
    filters.hasGithub !== null,
    filters.includeCanceled,
  ].filter(Boolean).length;
}

import type { TaskGroupListItem } from "@generated/api";

/**
 * F-32 我的任务（跨项目列表）：筛选条件与列表项类型。
 *
 * 字段对齐 docs/a-contract-review-f25-f29-f32.md 的冻结 R-3 DTO
 * （MyTaskItem / MyTasksQueryRequest）：契约提供的字段（含第二轮扩展的 priority / dueAt / completedAt /
 * creatorId / githubLinkCount / groupId）均为必填，null 表示契约明确定义的
 * 「未设置」；仅 description 仍无契约来源，保持可选，未提供时为 undefined，
 * 显示层必须显式降级，不得静默忽略或虚构数值。
 */

export type MyTaskScope = "mine" | "created" | "project" | "all";

export type MyTaskStatusFilter = "open" | "done" | "all";

export type MyTaskPriority = "NORMAL" | "HIGH" | "URGENT";

export type MyTaskRelation = "STANDALONE" | "MAIN" | "SOURCE";

export type MyTaskRecordFilter = "yes" | "no";

export type MyTaskGithubFilter = "yes" | "no";

export type MyTaskDisplay = "cards" | "list";

export type MyTaskWorkStatus = "TODO" | "DONE" | "CANCELED";

/** 任务中心筛选状态；由 URL 承载（F-30），不使用组件内部副本。 */
export interface MyTaskFilters {
  readonly scope: MyTaskScope;
  readonly overdue?: boolean;
  /** 「今日待办」筛选：未完成且命中 逾期 / 遗留来源 / 紧急 / 7 个日历日内到期 之一。 */
  readonly todayTodo?: boolean;
  readonly projectId: number | null;
  readonly status: MyTaskStatusFilter;
  readonly priority: MyTaskPriority | null;
  readonly relation: MyTaskRelation | null;
  readonly hasRecord: MyTaskRecordFilter | null;
  readonly hasGithub: MyTaskGithubFilter | null;
  readonly includeCanceled: boolean;
  readonly query: string;
  readonly display: MyTaskDisplay;
}

export interface MyTaskAssigneeRef {
  readonly userId: number;
  readonly name: string;
  readonly avatarUrl: string | null;
}

export interface MyTaskListItem {
  readonly taskId: number;
  readonly code: string;
  readonly title: string;
  /** R-3 契约未提供；undefined 表示不可知，显示层不得展示描述。 */
  readonly description?: string | null;
  readonly projectId: number;
  readonly projectName: string;
  readonly moduleId: number;
  readonly moduleName: string;
  readonly workStatus: MyTaskWorkStatus;
  readonly lifecycleStatus: "ACTIVE" | "INVALID";
  readonly priority: MyTaskPriority;
  /** null 表示确实未设置截止；R-3 已提供该字段，不再有「不可知」态。 */
  readonly dueAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly creatorId: number;
  /**
   * 全部负责人，恒非空、按 userId 升序（ADR-040）。assignee 是它的派生标量
   * （等于 assignees[0]），保留给只关心单个负责人的调用方；展示一律用 assignees。
   */
  readonly assignees: readonly MyTaskAssigneeRef[];
  readonly assignee: MyTaskAssigneeRef;
  readonly hasPublishedRecord: boolean;
  /**
   * 该任务的 PUBLISHED 正式记录条数（裁决修订 D-1，与 hasPublishedRecord 同源同口径：
   * 按 change_records 计数，不按版本计数），恒有
   * hasPublishedRecord === publishedRecordCount > 0；F-25 步骤 3 的「迭代记录 n 条」。
   */
  readonly publishedRecordCount: number;
  readonly groupRole: "MAIN" | "SOURCE" | null;
  readonly githubLinkCount: number;
  /** 与 groupRole 同源、同空同非空；供「查看主任务」入口按组导航（C-1）。 */
  readonly groupId: number | null;
  /**
   * 任务是否由遗留问题转换而来（F-20，裁决修订 D-2）：按 leftover_task_links
   * 存在链接行判定，与来源记录当前状态无关；true 时显示「遗留问题」徽章。
   */
  readonly hasLeftoverSource: boolean;
}

/**
 * 今日待办卡的四个来源子计数：各自独立计数、可以互相重叠（同一任务既逾期又来自遗留问题
 * 时两个子项都 +1），其并集即 todayTodo，不保证四项之和等于 todayTodo。
 */
export interface MyTaskTodayTodoBreakdown {
  readonly overdue: number;
  readonly leftover: number;
  readonly urgent: number;
  readonly dueWithinDays: number;
}

/**
 * 统计卡片口径；与列表筛选相互独立，按当前范围（scope/project）计算。
 * todayTodo / myOpen / completed 取负责人维度，created 取创建人维度（无论指派给谁）。
 */
export interface MyTaskStats {
  readonly todayTodo: number;
  readonly todayTodoBreakdown: MyTaskTodayTodoBreakdown;
  readonly myOpen: number;
  readonly completed: number;
  readonly created: number;
}

export interface MyTaskLeftoverSample {
  readonly recordCode: string;
  readonly summary: string;
}

/**
 * UI 筛选面相对冻结 R-3 契约的缺口（参数维度）。
 *
 * 第二轮契约扩展后，priority 与「未完成并含已取消」已可由参数表达；
 * 其余缺口（created / all 范围、relation、github、query）在设计师稿与
 * 骨架 UI 中存在但 R-3 参数仍无法表达，服务端适配器必须显式降级
 * （禁用或标注「后续迭代」），不得静默忽略，也不得把未登记的参数写进请求。
 */
export type MyTasksFilterGap =
  | "scope:created"
  | "scope:all"
  | "scope:project-without-id"
  | "filter:priority"
  | "filter:relation"
  | "filter:github"
  | "filter:query"
  | "filter:canceled-with-open";

/** 适配器对每个缺口的表达能力；false 表示该筛选必须显式降级。 */
export type MyTasksFilterSupport = Readonly<Record<MyTasksFilterGap, boolean>>;

/** mock 适配器完整支持全部筛选（演示数据集在本地过滤）。 */
export const MY_TASKS_FULL_FILTER_SUPPORT: MyTasksFilterSupport = {
  "scope:created": true,
  "scope:all": true,
  "scope:project-without-id": true,
  "filter:priority": true,
  "filter:relation": true,
  "filter:github": true,
  "filter:query": true,
  "filter:canceled-with-open": true,
};

/**
 * R-7 聚合组列表：直接消费服务端 DTO（MyTaskGroupItem 即 TaskGroupListItem），
 * 视图不复制任务或记录实体；CLOSED 组按服务端口径返回空 branches 与 null mainTask。
 */
export type MyTaskGroupItem = TaskGroupListItem;

export interface MyTaskGroupsResult {
  readonly items: readonly MyTaskGroupItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface MyTaskGroupsQueryInput {
  /** 工具栏「项目」下拉选定的项目；null 表示「全部项目」，跨项目（服务端 AuthorizedProjectScope）。 */
  readonly projectId: number | null;
  readonly cursor: string | null;
}

export interface MyTaskListResult {
  readonly items: readonly MyTaskListItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** R-3 已提供聚合统计；null 仅表示适配器未接线或尚未加载。 */
  readonly stats: MyTaskStats | null;
  /** 延后项（A 裁决 §10.3）：R-3 暂缓返回；null 表示不可知。2026-09-20 起任务中心
   * 移除范围分段行，显示层不再渲染该计数（字段保留供契约回填）。 */
  readonly scopeCounts: Readonly<Record<MyTaskScope, number>> | null;
  /** R-3 已提供遗留问题计数；null 仅表示适配器未接线。 */
  readonly leftoverCount: number | null;
  /** R-3 已提供遗留问题样例；null 表示当前范围无遗留或适配器未接线。 */
  readonly leftoverSample: MyTaskLeftoverSample | null;
  /** 适配器可表达的筛选维度；结果缺省时按完整能力处理。 */
  readonly filterSupport: MyTasksFilterSupport;
}

export interface MyTasksQueryInput {
  readonly cursor?: string | null;
  readonly filters: MyTaskFilters;
  readonly viewerId: number | null;
}

/** 数据源适配器；页面默认注入 server 实现，mock 只用于测试与降级演示。 */
export interface MyTasksAdapter {
  readonly source: "mock" | "server";
  readonly notice: string;
  fetchMyTasks(input: MyTasksQueryInput): Promise<MyTaskListResult>;
  /** R-7 聚合组列表（与任务卡片同一网格呈现）；缺数据时返回空页而不是隐藏列表区。 */
  fetchTaskGroups(input: MyTaskGroupsQueryInput): Promise<MyTaskGroupsResult>;
}

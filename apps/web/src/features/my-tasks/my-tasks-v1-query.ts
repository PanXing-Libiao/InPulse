import type { MyTaskItem } from "@generated/api";
import type {
  MyTaskFilters,
  MyTaskListItem,
  MyTaskPriority,
  MyTasksFilterGap,
  MyTasksFilterSupport,
  MyTaskWorkStatus,
} from "./my-tasks-types";

/**
 * R-3 listMyTasks 的 A 岗冻结契约映射（F-32 任务中心）。
 *
 * 冻结事实见 docs/a-contract-review-f25-f29-f32.md §2、§3、§10、§11：
 * 路径 GET /api/v1/me/tasks，参数支持 cursor / limit / ownership /
 * projectId / workStatus / hasPublishedRecord / priority /
 * includeCanceled，归属主体固定为当前用户（ownership 只区分负责与创建两个自指
 * 维度），排序固定 id DESC，limit 默认 20、上限 100。
 *
 * 本文件只做「UI 筛选状态 → 冻结查询参数」的纯映射、R-3 条目映射与缺口盘点：
 * 不发起请求、不引入生成客户端实现、不改契约。请求由 my-tasks-server.ts
 * 经生成客户端发起；mock adapter 只保留用于前端测试与降级演示。
 */

export const MY_TASKS_V1_PATH = "/api/v1/me/tasks";
export const MY_TASKS_V1_LIMIT_DEFAULT = 20;
export const MY_TASKS_V1_LIMIT_MAX = 100;

/** 冻结的 R-3 查询参数；未赋值的键表示不发送该参数。 */
export interface MyTasksV1Query {
  readonly cursor?: string;
  readonly limit?: number;
  /** 归属维度：ASSIGNEE（负责，缺省/「我负责的」）或 CREATOR（创建，「我创建的」）。 */
  readonly ownership?: "ASSIGNEE" | "CREATOR";
  readonly projectId?: number;
  readonly workStatus?: MyTaskWorkStatus;
  readonly hasPublishedRecord?: boolean;
  /** 单值优先级筛选；与 workStatus 正交（A 裁决 §10.3）。 */
  readonly priority?: MyTaskPriority;
  /** 与 workStatus=TODO 组合表达「未完成并含已取消」（A 裁决 §10.3）。 */
  readonly includeCanceled?: boolean;
  /** 今日待办集合：未完成且命中 逾期 / 遗留来源 / 紧急 / 7 个日历日内到期 之一。 */
  readonly todayTodo?: boolean;
}

export interface MyTasksV1QueryOptions {
  /** 上一页返回的签名游标；null 或空串表示首页。 */
  readonly cursor?: string | null;
  /** 每页条数；非正整数回退默认值，超过上限按上限收口。 */
  readonly limit?: number;
}

/** 兼容别名：缺口类型定义在 my-tasks-types.ts，供适配器能力表复用。 */
export type MyTasksV1FilterGap = MyTasksFilterGap;

/**
 * R-3 契约对各项 UI 筛选的表达能力：第二轮扩展与 ownership 扩展后
 * priority、「未完成并含已取消」与「我创建的」可由参数表达；其余 5 项仍无契约来源
 * （见 docs/a-contract-review-f25-f29-f32.md §3、§10 与 Q-08 ~ Q-10），
 * 服务端适配器按本表显式降级。
 */
export const MY_TASKS_V1_FILTER_SUPPORT: MyTasksFilterSupport = {
  "scope:created": true,
  "scope:all": false,
  "scope:project-without-id": true,
  "filter:priority": true,
  "filter:relation": false,
  "filter:github": false,
  "filter:query": false,
  "filter:canceled-with-open": true,
};

/**
 * R-3 无对应参数、但视图可在已加载页上本地计算的条件。
 *
 * 这些条件不改变请求，只在已加载的结果集内收窄显示；调用方必须同时提示
 * 结果受分页限制，不得把本地筛选结果说成服务端筛选结果。
 * scope:all 无法本地计算：R-3 只服务当前用户的自指维度（负责人或创建者），
 * 「全部任务」需要跨用户的授权范围，非管理员不得放开。
 */
export const MY_TASKS_V1_LOCAL_FILTER_SUPPORT: MyTasksFilterSupport = {
  "scope:created": false,
  "scope:all": false,
  "scope:project-without-id": false,
  "filter:priority": false,
  "filter:relation": true,
  "filter:github": true,
  "filter:query": true,
  "filter:canceled-with-open": false,
};

/**
 * 骨架列表项相对冻结 DTO 的缺口（字段维度）。
 *
 * 第二轮扩展后仅剩 description（A 裁决暂缓）；映射层保持 undefined，
 * 显示层不得展示描述。
 */
export const MY_TASKS_V1_MISSING_ITEM_FIELDS = ["description"] as const;

/**
 * 响应维度的缺口：第二轮扩展后 stats / leftoverCount / leftoverSample
 * 已由 R-3 提供；scopeCounts 为 A 裁决 §10.3 延后项，保持 null（2026-09-20
 * 起任务中心移除范围分段行，显示层不再渲染该计数）。
 */
export const MY_TASKS_V1_MISSING_RESPONSE_PARTS = ["scopeCounts"] as const;

/** 取「未完成」时是否要求把已取消任务一并计入（映射为 includeCanceled=true）。 */
export function requiresCanceledUnion(filters: MyTaskFilters): boolean {
  return filters.status === "open" && filters.includeCanceled;
}

/**
 * status=all 不带 workStatus；open 与 done 映射为单值。
 */
export function toMyTasksV1WorkStatus(
  filters: MyTaskFilters,
): MyTaskWorkStatus | null {
  if (filters.status === "open") return "TODO";
  if (filters.status === "done") return "DONE";
  return null;
}

/**
 * 范围 → 归属维度（Q-08 的自指维度，不引入他人身份参数）：
 * created = CREATOR（当前用户创建），其余范围都是 ASSIGNEE（当前用户负责）。
 * 缺省不发送该参数，服务端按 ASSIGNEE 处理，与历史行为一致。
 */
export function toMyTasksV1Ownership(
  filters: MyTaskFilters,
): "ASSIGNEE" | "CREATOR" | null {
  return filters.scope === "created" ? "CREATOR" : null;
}

/** 非正整数回退默认值，超过上限按上限收口，与服务端 422 边界保持一致。 */
export function clampMyTasksV1Limit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return MY_TASKS_V1_LIMIT_DEFAULT;
  return Math.min(limit, MY_TASKS_V1_LIMIT_MAX);
}

export function toMyTasksV1Query(
  filters: MyTaskFilters,
  options: MyTasksV1QueryOptions = {},
): MyTasksV1Query {
  const query: {
    cursor?: string;
    limit: number;
    ownership?: "ASSIGNEE" | "CREATOR";
    projectId?: number;
    workStatus?: MyTaskWorkStatus;
    hasPublishedRecord?: boolean;
    priority?: MyTaskPriority;
    includeCanceled?: boolean;
    todayTodo?: boolean;
  } = {
    limit: clampMyTasksV1Limit(options.limit ?? MY_TASKS_V1_LIMIT_DEFAULT),
  };

  const cursor = options.cursor ?? null;
  if (cursor !== null && cursor.length > 0) query.cursor = cursor;
  const ownership = toMyTasksV1Ownership(filters);
  if (ownership !== null) query.ownership = ownership;
  // 项目筛选是工具栏的常驻条件：选定项目后，与 scope / ownership 一起收窄，
  // 「我负责的 / 我创建的 + 所选项目」都要下发 projectId。
  if (filters.projectId !== null) query.projectId = filters.projectId;
  const workStatus = toMyTasksV1WorkStatus(filters);
  if (workStatus !== null) query.workStatus = workStatus;
  if (filters.hasRecord !== null) {
    query.hasPublishedRecord = filters.hasRecord === "yes";
  }
  if (filters.priority !== null) query.priority = filters.priority;
  if (requiresCanceledUnion(filters)) query.includeCanceled = true;
  // 今日待办只存在于「未完成」视图（服务端 todayTodo 与 DONE / CANCELED 求交恒为空），
  // 已完成 / 全部视图即使过滤器带该位也不下发，避免发出必然为空的组合。
  if (filters.status === "open" && filters.todayTodo === true)
    query.todayTodo = true;
  return query;
}

/**
 * 无损映射 R-3 条目到骨架视图；仅 description 无契约来源保持 undefined，
 * 显示层据此显式降级（见 MY_TASKS_V1_MISSING_ITEM_FIELDS）。
 */
export function fromV1MyTaskItem(item: MyTaskItem): MyTaskListItem {
  return {
    taskId: item.taskId,
    code: item.code,
    title: item.title,
    projectId: item.projectId,
    projectName: item.projectName,
    moduleId: item.moduleId,
    moduleName: item.moduleName,
    workStatus: item.workStatus,
    lifecycleStatus: item.lifecycleStatus,
    updatedAt: item.updatedAt,
    assignees: item.assignees.map((assignee) => ({
      userId: assignee.userId,
      name: assignee.name,
      avatarUrl: assignee.avatarUrl,
    })),
    assignee: {
      userId: item.assignee.userId,
      name: item.assignee.name,
      avatarUrl: item.assignee.avatarUrl,
    },
    priority: item.priority,
    dueAt: item.dueAt,
    completedAt: item.completedAt,
    creatorId: item.creatorId,
    githubLinkCount: item.githubLinkCount,
    hasPublishedRecord: item.hasPublishedRecord,
    publishedRecordCount: item.publishedRecordCount,
    groupRole: item.groupRole,
    groupId: item.groupId,
    hasLeftoverSource: item.hasLeftoverSource,
  };
}

/**
 * 列出当前筛选状态下 V1 无法表达的项；空数组表示可完整映射。
 * 调用方应在接线时据此决定 UI 降级，不得把缺口当作已实现能力。
 */
export function listMyTasksV1Gaps(
  filters: MyTaskFilters,
): readonly MyTasksV1FilterGap[] {
  const gaps: MyTasksV1FilterGap[] = [];
  if (filters.scope === "all") gaps.push("scope:all");
  if (filters.relation !== null) gaps.push("filter:relation");
  if (filters.hasGithub !== null) gaps.push("filter:github");
  if (filters.query.trim().length > 0) gaps.push("filter:query");
  return gaps;
}

/**
 * 在已加载结果集上本地收窄；只处理 server 未提供而本地可计算的条件。
 * 返回值必须与「结果受分页限制」的提示一起呈现。
 */
export function matchesMyTasksLocalFilters(
  item: MyTaskListItem,
  filters: MyTaskFilters,
  support: MyTasksFilterSupport,
): boolean {
  if (!support["filter:relation"] && filters.relation !== null) {
    const relation = item.groupRole ?? "STANDALONE";
    if (relation !== filters.relation) return false;
  }
  if (!support["filter:github"] && filters.hasGithub !== null) {
    if (item.githubLinkCount > 0 !== (filters.hasGithub === "yes")) {
      return false;
    }
  }
  const needle = filters.query.trim().toLowerCase();
  if (!support["filter:query"] && needle.length > 0) {
    const haystack = [
      item.code,
      item.title,
      item.projectName,
      item.moduleName,
      ...item.assignees.map((assignee) => assignee.name),
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

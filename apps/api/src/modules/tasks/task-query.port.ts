import { Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  taskListKeysetPredicate,
  taskListOrderBy,
  taskListSortKeyFor,
  type TaskListSortKey,
} from "./task-list-order.js";

/** 任务身份、归属与状态的稳定读模型。 */
export interface TaskReadModel {
  taskId: number;
  projectId: number;
  moduleId: number;
  code: string;
  title: string;
  creatorId: number;
  assigneeId: number;
  priority: TaskPriority;
  workStatus: "TODO" | "DONE" | "CANCELED";
  // ADR-054：任务归档已下线，ARCHIVED 不可达；INVALID 仍是「标记无效」的历史取值。
  lifecycleStatus: "ACTIVE" | "INVALID";
  /** 截止时间（null = 未设置）；由适配器在读取边界还原为 Date。 */
  dueAt: Date | null;
  rowVersion: number;
}

export type TaskWorkStatus = "TODO" | "DONE" | "CANCELED";
export type TaskLifecycleStatus = "ACTIVE" | "INVALID";

/** excludedTaskIds 的条目上限：超限即拒绝，禁止把无界集合带进 SQL 参数。 */
export const TASK_EXCLUDED_IDS_MAX = 1000;

/** listByIds 的 taskIds 条目上限：超限即拒绝，禁止把无界数组带进 SQL 参数。 */
export const TASK_READ_IDS_MAX = 1000;

export type TaskListInputErrorReason =
  "invalid-limit" | "invalid-excluded-task-ids" | "invalid-task-ids";

/** 端口入参越界；调用方（应用层）负责映射为 422。 */
export class TaskListInputError extends Error {
  readonly reason: TaskListInputErrorReason;

  constructor(reason: TaskListInputErrorReason, message: string) {
    super(message);
    this.name = "TaskListInputError";
    this.reason = reason;
  }
}

export interface TaskListFilter {
  /**
   * 服务端生成的授权项目范围（AuthorizedProjectScope.projectIds）。端口不校验
   * 成员关系；空数组必须短路返回空集，不得退化为无 WHERE 的全表扫描。
   */
  readonly projectIds: readonly number[];
  readonly assigneeId?: number;
  readonly workStatuses?: readonly TaskWorkStatus[];
  /**
   * 功能设计 §29.1「有效任务」中 B 侧可表达的部分：
   * lifecycle_status <> 'INVALID' AND work_status <> 'CANCELED'。
   * 「不是历史来源分支」在 C 域，由调用方通过 excludedTaskIds 传入。
   */
  readonly effectiveOnly?: boolean;
  /**
   * C 域算出的排除集合（历史来源分支的任务 ID）。必须在同一条 SQL 内于分页前
   * 应用（A 裁决 §6 冲突 B）；长度上限 TASK_EXCLUDED_IDS_MAX，超限抛
   * TaskListInputError。
   */
  readonly excludedTaskIds?: readonly number[];
}

export interface TaskListPageInput extends TaskListFilter {
  /** 1..100，上限由契约层拒绝；端口只校验正整数。 */
  readonly limit: number;
  /** 上一页返回的 next；缺省表示第一页。端口只接收已解码的排序键位置。 */
  readonly after?: TaskListSortKey;
}

export interface TaskListRow {
  readonly taskId: number;
  readonly projectId: number;
  readonly moduleId: number;
  readonly code: string;
  readonly title: string;
  readonly assigneeId: number;
  readonly workStatus: TaskWorkStatus;
  readonly lifecycleStatus: TaskLifecycleStatus;
  readonly rowVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TaskListPage {
  readonly items: readonly TaskListRow[];
  /** 还有下一页时为最后一条的排序键（下一页游标签名的 keyset 位置），否则为 null。 */
  readonly next: TaskListSortKey | null;
  readonly hasMore: boolean;
}

/**
 * 当前 Drizzle + postgres-js 组合把时间类型解析器覆盖成透传，时间列以文本返回；
 * 适配器在边界统一还原为 Date，保证端口签名与运行时行为一致。
 */
export interface TaskListRowRaw extends Omit<
  TaskListRow,
  "createdAt" | "updatedAt"
> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function mapTaskListRow(row: TaskListRowRaw): TaskListRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * TaskReadModel 的时间列在驱动层以文本返回，读取边界统一还原为 Date；
 * 三处 SQL 必须显式选择 `due_at AS "dueAt"`，遗漏会让契约校验拿到 undefined。
 */
interface TaskReadRowRaw extends Omit<TaskReadModel, "dueAt"> {
  readonly dueAt: string | null;
}

function mapTaskReadRow(row: TaskReadRowRaw): TaskReadModel {
  return {
    ...row,
    dueAt: row.dueAt === null ? null : new Date(row.dueAt),
  };
}

interface TaskBoardTaskRowRaw extends Omit<
  TaskBoardTaskRow,
  "dueAt" | "completedAt" | "assigneeIds"
> {
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly assigneeIds: number[] | null;
}

interface TaskBoardStatsRowRaw extends TaskBoardStatsTotals {
  readonly moduleId: number | null;
}

function mapTaskBoardTaskRow(row: TaskBoardTaskRowRaw): TaskBoardTaskRow {
  return {
    ...row,
    dueAt: row.dueAt === null ? null : new Date(row.dueAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    // array_agg 对无负责人的任务返回 NULL；集合为空由聚合读按数据不一致拒绝。
    assigneeIds: row.assigneeIds ?? [],
  };
}

/** R-8 任务看板：单项目一次返回的任务上限，超出截断并在响应上标记。 */
export const TASK_BOARD_TASKS_MAX = 1000;

/** 任务优先级；与 app.tasks.tasks_priority_check 的取值一致（R-8）。 */
export type TaskPriority = "NORMAL" | "HIGH" | "URGENT";

/**
 * 卡片截止状态；只对未完成任务取值（已完成 / 已取消 / 未设截止为 NONE）。
 * 由服务端按 Asia/Shanghai 与查询时刻的 now() 计算，前端不得按客户端时钟重算。
 */
export type TaskBoardDueState = "OVERDUE" | "TODAY" | "SCHEDULED" | "NONE";

/** R-8 看板列表入参；excludedTaskIds 为 C 域历史来源分支，在 LIMIT 之前过滤。 */
export interface TaskBoardListInput {
  readonly projectId: number;
  readonly excludedTaskIds?: readonly number[];
}

/** R-8 看板任务卡行；时间列在适配器边界还原为 Date。 */
export interface TaskBoardTaskRow {
  readonly taskId: number;
  readonly moduleId: number;
  readonly code: string;
  readonly title: string;
  /** 全部负责人，按 user_id 升序（ADR-040）；无负责人的任务在适配器边界归一为空数组。 */
  readonly assigneeIds: readonly number[];
  readonly priority: TaskPriority;
  readonly workStatus: TaskWorkStatus;
  readonly dueAt: Date | null;
  readonly completedAt: Date | null;
  readonly dueState: TaskBoardDueState;
}

/** R-8 看板任务页；truncated = true 表示超过 TASK_BOARD_TASKS_MAX 被截断。 */
export interface TaskBoardTaskPage {
  readonly items: readonly TaskBoardTaskRow[];
  readonly truncated: boolean;
}

/** R-8 看板状态计数；项目级与模块级共用同一形状，日界与周界由 SQL 按 Asia/Shanghai 计算。 */
export interface TaskBoardStatsTotals {
  readonly total: number;
  readonly done: number;
  readonly open: number;
  readonly canceled: number;
  readonly overdue: number;
  readonly dueToday: number;
  readonly completedThisWeek: number;
}

/** R-8 看板统计入参；与列表同一集合口径，不受列表截断影响。 */
export interface TaskBoardStatsInput {
  readonly projectId: number;
  readonly excludedTaskIds?: readonly number[];
}

/** R-8 模块级统计行（GROUPING SETS 的分组行）。 */
export interface TaskBoardModuleStatsRow extends TaskBoardStatsTotals {
  readonly moduleId: number;
}

/**
 * R-8 统计结果：totals 为项目级（GROUPING SETS 的总计行，无任务时为零值），
 * modules 为各模块分组行；两者同一集合、同一 now() 口径。
 */
export interface TaskBoardStatsResult {
  readonly totals: TaskBoardStatsTotals;
  readonly modules: readonly TaskBoardModuleStatsRow[];
}

/** F-33 迭代总结已完成任务入参；projectIds 必须来自服务端 AuthorizedProjectScope。 */
export interface SummaryTaskReadInput {
  readonly projectIds: readonly number[];
  /** 完成自然日下界（含），Asia/Shanghai 日历日，格式 YYYY-MM-DD。 */
  readonly fromDate: string;
  /** 完成自然日上界（含），Asia/Shanghai 日历日，格式 YYYY-MM-DD。 */
  readonly toDate: string;
  readonly projectId?: number;
  /** 收窄到单个负责人（task_assignees 之一）。 */
  readonly assigneeId?: number;
  readonly limit: number;
}

/**
 * F-33 已完成任务行：work_status = DONE 且 completed_at 落在范围内；已失效
 * （lifecycle_status = INVALID）的任务不进入总结。assigneeId 取多负责人中最小
 * 的 user_id，与任务列表、看板同一口径。
 */
export interface SummaryTaskRow {
  readonly taskId: number;
  readonly code: string;
  readonly projectId: number;
  readonly moduleId: number;
  readonly title: string;
  readonly completedAt: Date;
  readonly assigneeId: number | null;
}

export interface SummaryTaskPage {
  readonly items: readonly SummaryTaskRow[];
  readonly total: number;
  readonly hasMore: boolean;
}

interface SummaryTaskRowRaw extends Omit<SummaryTaskRow, "completedAt"> {
  readonly completedAt: string;
}

/** Caller authorizes the project. lock requires project/module locks first. */
export abstract class TaskQueryPort {
  /**
   * 项目无关的预读，供请求只携带任务 ID、需要先解析真实归属的命令使用。
   * 预读结果不得用于写决策：取得父级与任务锁后必须重新读取；
   * 跨项目或不可访问的统一按不存在处理。
   */
  abstract findByTaskId(
    tx: TransactionContext,
    taskId: number,
  ): Promise<TaskReadModel | undefined>;
  abstract find(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
  ): Promise<TaskReadModel | undefined>;
  abstract lock(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
  ): Promise<TaskReadModel | undefined>;

  /**
   * 批量按 ID 读取（R-1 聚合组成员、R-4 记录来源标签）。只读、不取锁。
   *
   * 约定：
   * 1. projectIds 与 taskIds 任一为空时短路返回空集，不发出任何 SQL。
   * 2. SQL 同时带 project_id 与 id 条件，跨项目串联不会返回结果；
   *    调用方必须先把两者限制在服务端授权范围内。
   * 3. taskIds 上限 TASK_READ_IDS_MAX，超限抛 TaskListInputError。
   */
  abstract listByIds(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly TaskReadModel[]>;

  /**
   * 跨项目分页列表（F-29 未完成任务、F-32 我的任务）。只读、不取锁。
   *
   * 约定：
   * 1. projectIds 必须来自服务端生成的 AuthorizedProjectScope；端口不校验成员关系。
   * 2. projectIds 为空时短路返回空页，不发出任何 SQL。
   * 3. 排序固定，且与任务中心、任务面板共用 task-list-order.ts 的同一排序键
   *    （状态分组 → 紧急桶 → 优先级 → 遗留问题 → 截止时间 → 任务 ID，ADR-037）；
   *    该排序不命中 tasks_project_status_idx / tasks_assignee_status_idx 的排序尾，
   *    当前不新增索引（见 ADR-037 §4）。
   * 4. excludedTaskIds 在分页前过滤，保证先过滤后分页。
   * 5. 游标签名不属于端口职责：调用方解码游标后传入 after（排序键元组），并
   *    用返回的 next 自行签发（与 ActivityProjectionReader + TimeCursorService 同一分工）。
   * 6. 记录维度筛选（是否有正式记录）需要 change_records，本端口不承载，见
   *    MyTaskQueryPort（A 裁决 §6 冲突 A）。
   */
  abstract list(
    tx: TransactionContext,
    input: TaskListPageInput,
  ): Promise<TaskListPage>;

  /** 与 list 同口径的不分页计数（F-29「未完成任务」）。只读、不取锁。 */
  abstract count(
    tx: TransactionContext,
    filter: TaskListFilter,
  ): Promise<number>;

  /**
   * R-8 任务看板列表：一次读取项目内全部活跃任务（lifecycle_status = ACTIVE，
   * 含已取消，不含无效），并在 LIMIT 之前应用 excludedTaskIds。
   *
   * 约定：
   * 1. 调用方必须先完成项目授权（与 find / list 同一约定），端口不校验成员关系。
   * 2. 排序固定「逾期 -> 未完成 -> 已完成（完成时间倒序）-> 已取消」；未完成
   *    桶内先按优先级 紧急 -> 高 -> 普通，再按截止时间升序（NULL 最后）。
   *    已完成与已取消不参与优先级排序。末键 taskId ASC 保证稳定；
   *    不提供 sort 参数。
   * 3. 上限 TASK_BOARD_TASKS_MAX，超出截断并置 truncated = true；调用方负责在
   *    响应上向用户说明截断，不得静默丢弃。
   * 4. dueState 在同一 SQL 内按 Asia/Shanghai 与 now() 计算。
   */
  abstract listForBoard(
    tx: TransactionContext,
    input: TaskBoardListInput,
  ): Promise<TaskBoardTaskPage>;

  /**
   * R-8 看板统计：与 listForBoard 同一集合的 FILTER 聚合，不受列表截断影响。
   * 日界（dueToday）与周界（completedThisWeek）按 Asia/Shanghai 计算，
   * 与 R-3 统计同一表达式口径。项目级与模块级由 GROUPING SETS 一次返回。
   * 只读、不取锁。
   */
  abstract boardStats(
    tx: TransactionContext,
    input: TaskBoardStatsInput,
  ): Promise<TaskBoardStatsResult>;

  /**
   * F-33 迭代总结已完成任务：work_status = DONE 且 completed_at 落在 [from, to) 内，
   * 排除 lifecycle_status = INVALID；固定 completed_at DESC, id DESC。total 与筛选
   * 同口径，不受 limit 截断。只读、不取锁；projectIds 为空时短路返回空页。
   */
  abstract summaryCompletedTasks(
    tx: TransactionContext,
    input: SummaryTaskReadInput,
  ): Promise<SummaryTaskPage>;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TaskListInputError(
      "invalid-limit",
      "task list limit must be a positive integer",
    );
  }
}

function assertReadTaskIds(taskIds: readonly number[]): void {
  if (taskIds.length > TASK_READ_IDS_MAX) {
    throw new TaskListInputError(
      "invalid-task-ids",
      `taskIds exceeds the ${TASK_READ_IDS_MAX} entry limit`,
    );
  }
  for (const taskId of taskIds) {
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      throw new TaskListInputError(
        "invalid-task-ids",
        "taskIds must contain positive integers",
      );
    }
  }
}

function assertExcludedTaskIds(
  excludedTaskIds: readonly number[] | undefined,
): void {
  if (excludedTaskIds === undefined) {
    return;
  }
  if (excludedTaskIds.length > TASK_EXCLUDED_IDS_MAX) {
    throw new TaskListInputError(
      "invalid-excluded-task-ids",
      `excludedTaskIds exceeds the ${TASK_EXCLUDED_IDS_MAX} entry limit`,
    );
  }
  for (const taskId of excludedTaskIds) {
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      throw new TaskListInputError(
        "invalid-excluded-task-ids",
        "excludedTaskIds must contain positive integers",
      );
    }
  }
}

@Injectable()
export class PostgresTaskQueryPort extends TaskQueryPort {
  async findByTaskId(tx: TransactionContext, taskId: number) {
    const [row] = await tx.sql<
      TaskReadRowRaw[]
    >`SELECT id AS "taskId",project_id AS "projectId",module_id AS "moduleId",code,title,creator_id AS "creatorId",(SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id=app.tasks.id) AS "assigneeId",priority,work_status AS "workStatus",lifecycle_status AS "lifecycleStatus",due_at AS "dueAt",row_version AS "rowVersion"FROM app.tasks WHERE id=${taskId} AND deleted_at IS NULL`;
    return row === undefined ? undefined : mapTaskReadRow(row);
  }
  async find(tx: TransactionContext, projectId: number, taskId: number) {
    const [row] = await tx.sql<
      TaskReadRowRaw[]
    >`SELECT id AS "taskId",project_id AS "projectId",module_id AS "moduleId",code,title,creator_id AS "creatorId",(SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id=app.tasks.id) AS "assigneeId",priority,work_status AS "workStatus",lifecycle_status AS "lifecycleStatus",due_at AS "dueAt",row_version AS "rowVersion"FROM app.tasks WHERE id=${taskId} AND project_id=${projectId} AND deleted_at IS NULL`;
    return row === undefined ? undefined : mapTaskReadRow(row);
  }
  async lock(tx: TransactionContext, projectId: number, taskId: number) {
    await tx.sql`SELECT id FROM app.tasks WHERE id=${taskId} AND project_id=${projectId} AND deleted_at IS NULL FOR UPDATE`;
    // Separate READ COMMITTED statement sees relationships committed while waiting for the row.
    return this.find(tx, projectId, taskId);
  }

  async listByIds(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly TaskReadModel[]> {
    assertReadTaskIds(taskIds);
    if (projectIds.length === 0 || taskIds.length === 0) {
      return [];
    }
    const projects = [...projectIds];
    const tasks = [...taskIds];
    const rows = await tx.sql<
      TaskReadRowRaw[]
    >`SELECT id AS "taskId",project_id AS "projectId",module_id AS "moduleId",code,title,creator_id AS "creatorId",(SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id=app.tasks.id) AS "assigneeId",priority,work_status AS "workStatus",lifecycle_status AS "lifecycleStatus",due_at AS "dueAt",row_version AS "rowVersion"FROM app.tasks WHERE project_id = ANY(${projects}::integer[]) AND id = ANY(${tasks}::integer[]) AND deleted_at IS NULL ORDER BY id ASC`;
    return rows.map(mapTaskReadRow);
  }

  async list(
    tx: TransactionContext,
    input: TaskListPageInput,
  ): Promise<TaskListPage> {
    assertLimit(input.limit);
    assertExcludedTaskIds(input.excludedTaskIds);
    if (input.projectIds.length === 0) {
      return { items: [], next: null, hasMore: false };
    }
    const projectIds = [...input.projectIds];
    const assigneeId = input.assigneeId ?? null;
    const workStatuses = input.workStatuses ? [...input.workStatuses] : null;
    const effectiveOnly = input.effectiveOnly === true;
    const excludedTaskIds = input.excludedTaskIds
      ? [...input.excludedTaskIds]
      : null;
    const after = input.after ?? null;

    const rows = await tx.sql<TaskListRowRaw[]>`
      SELECT t.id AS "taskId",
             t.project_id AS "projectId",
             t.module_id AS "moduleId",
             t.code,
             t.title,
             (SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id = t.id) AS "assigneeId",
             t.work_status AS "workStatus",
             t.lifecycle_status AS "lifecycleStatus",
             t.row_version AS "rowVersion",
             t.created_at AS "createdAt",
             t.updated_at AS "updatedAt"
        FROM app.tasks t
       WHERE t.project_id = ANY(${projectIds}::integer[])          AND t.deleted_at IS NULL         AND (${assigneeId}::integer IS NULL OR EXISTS (SELECT 1 FROM app.task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${assigneeId}))
         AND (${workStatuses}::text[] IS NULL OR t.work_status = ANY(${workStatuses}::text[]))
         AND (${effectiveOnly}::boolean = false OR (t.lifecycle_status <> 'INVALID' AND t.work_status <> 'CANCELED'))
         AND (${excludedTaskIds}::integer[] IS NULL OR t.id <> ALL(${excludedTaskIds}::integer[]))
         AND ${taskListKeysetPredicate(tx.sql, after)}
       ORDER BY ${taskListOrderBy(tx.sql)}
       LIMIT ${input.limit + 1}
    `;
    const hasMore = rows.length > input.limit;
    const items = (hasMore ? rows.slice(0, input.limit) : rows).map(
      mapTaskListRow,
    );
    const last = items.length === 0 ? null : items[items.length - 1];
    // 排序键只在需要续页时为页尾任务查一次；查不到（并发删除）则视为没有下一页。
    const next =
      hasMore && last ? await taskListSortKeyFor(tx.sql, last.taskId) : null;
    return {
      items,
      hasMore: hasMore && next !== null,
      next,
    };
  }

  async count(tx: TransactionContext, filter: TaskListFilter): Promise<number> {
    assertExcludedTaskIds(filter.excludedTaskIds);
    if (filter.projectIds.length === 0) {
      return 0;
    }
    const projectIds = [...filter.projectIds];
    const assigneeId = filter.assigneeId ?? null;
    const workStatuses = filter.workStatuses ? [...filter.workStatuses] : null;
    const effectiveOnly = filter.effectiveOnly === true;
    const excludedTaskIds = filter.excludedTaskIds
      ? [...filter.excludedTaskIds]
      : null;

    const [row] = await tx.sql<{ total: number }[]>`
      SELECT COUNT(*)::integer AS total
        FROM app.tasks t
       WHERE t.project_id = ANY(${projectIds}::integer[])          AND t.deleted_at IS NULL         AND (${assigneeId}::integer IS NULL OR EXISTS (SELECT 1 FROM app.task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${assigneeId}))
         AND (${workStatuses}::text[] IS NULL OR t.work_status = ANY(${workStatuses}::text[]))
         AND (${effectiveOnly}::boolean = false OR (t.lifecycle_status <> 'INVALID' AND t.work_status <> 'CANCELED'))
         AND (${excludedTaskIds}::integer[] IS NULL OR t.id <> ALL(${excludedTaskIds}::integer[]))
    `;
    return row?.total ?? 0;
  }

  async listForBoard(
    tx: TransactionContext,
    input: TaskBoardListInput,
  ): Promise<TaskBoardTaskPage> {
    assertExcludedTaskIds(input.excludedTaskIds);
    const excludedTaskIds = input.excludedTaskIds
      ? [...input.excludedTaskIds]
      : null;
    const rows = await tx.sql<TaskBoardTaskRowRaw[]>`
      SELECT t.id AS "taskId",
             t.module_id AS "moduleId",
             t.code,
             t.title,
             (SELECT array_agg(ta.user_id ORDER BY ta.user_id) FROM app.task_assignees ta WHERE ta.task_id = t.id) AS "assigneeIds",
             t.priority,
             t.work_status AS "workStatus",
             t.due_at AS "dueAt",
             t.completed_at AS "completedAt",
             CASE
               WHEN t.work_status <> 'TODO' OR t.due_at IS NULL THEN 'NONE'
               WHEN t.due_at < now() THEN 'OVERDUE'
               WHEN t.due_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 day') AT TIME ZONE 'Asia/Shanghai' THEN 'TODAY'
               ELSE 'SCHEDULED'
             END AS "dueState"
        FROM app.tasks t
       WHERE t.project_id = ${input.projectId}          AND t.deleted_at IS NULL         AND t.lifecycle_status = 'ACTIVE'
         AND (${excludedTaskIds}::integer[] IS NULL OR t.id <> ALL(${excludedTaskIds}::integer[]))
       ORDER BY CASE
                  WHEN t.work_status = 'DONE' THEN 2
                  WHEN t.work_status = 'CANCELED' THEN 3
                  WHEN t.due_at IS NOT NULL AND t.due_at < now() THEN 0
                  ELSE 1
                END,
                CASE WHEN t.work_status = 'TODO' THEN CASE t.priority
                  WHEN 'URGENT' THEN 0
                  WHEN 'HIGH' THEN 1
                  WHEN 'NORMAL' THEN 2
                  ELSE 2
                END END ASC NULLS LAST,
                CASE WHEN t.work_status = 'DONE' THEN t.completed_at END DESC NULLS LAST,
                t.due_at ASC NULLS LAST,
                t.id ASC
       LIMIT ${TASK_BOARD_TASKS_MAX + 1}
    `;
    const truncated = rows.length > TASK_BOARD_TASKS_MAX;
    const visible = truncated ? rows.slice(0, TASK_BOARD_TASKS_MAX) : rows;
    return {
      items: visible.map(mapTaskBoardTaskRow),
      truncated,
    };
  }

  async boardStats(
    tx: TransactionContext,
    input: TaskBoardStatsInput,
  ): Promise<TaskBoardStatsResult> {
    assertExcludedTaskIds(input.excludedTaskIds);
    const excludedTaskIds = input.excludedTaskIds
      ? [...input.excludedTaskIds]
      : null;
    const rows = await tx.sql<TaskBoardStatsRowRaw[]>`
      SELECT t.module_id AS "moduleId",
             COUNT(*)::integer AS "total",
             COUNT(*) FILTER (WHERE t.work_status = 'DONE')::integer AS "done",
             COUNT(*) FILTER (WHERE t.work_status = 'TODO')::integer AS "open",
             COUNT(*) FILTER (WHERE t.work_status = 'CANCELED')::integer AS "canceled",
             COUNT(*) FILTER (WHERE t.work_status = 'TODO' AND t.due_at < now())::integer AS "overdue",
             COUNT(*) FILTER (
               WHERE t.work_status = 'TODO'
                 AND t.due_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
                 AND t.due_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 day') AT TIME ZONE 'Asia/Shanghai'
             )::integer AS "dueToday",
             COUNT(*) FILTER (
               WHERE t.work_status = 'DONE'
                 AND t.completed_at >= date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
             )::integer AS "completedThisWeek"
        FROM app.tasks t
       WHERE t.project_id = ${input.projectId}          AND t.deleted_at IS NULL         AND t.lifecycle_status = 'ACTIVE'
         AND (${excludedTaskIds}::integer[] IS NULL OR t.id <> ALL(${excludedTaskIds}::integer[]))
       GROUP BY GROUPING SETS ((), (t.module_id))
    `;
    let totals: TaskBoardStatsTotals | null = null;
    const modules: TaskBoardModuleStatsRow[] = [];
    for (const row of rows) {
      const item: TaskBoardStatsTotals = {
        total: row.total,
        done: row.done,
        open: row.open,
        canceled: row.canceled,
        overdue: row.overdue,
        dueToday: row.dueToday,
        completedThisWeek: row.completedThisWeek,
      };
      if (row.moduleId === null) {
        totals = item;
      } else {
        modules.push({ moduleId: row.moduleId, ...item });
      }
    }
    return {
      totals: totals ?? {
        total: 0,
        done: 0,
        open: 0,
        canceled: 0,
        overdue: 0,
        dueToday: 0,
        completedThisWeek: 0,
      },
      modules,
    };
  }

  async summaryCompletedTasks(
    tx: TransactionContext,
    input: SummaryTaskReadInput,
  ): Promise<SummaryTaskPage> {
    assertLimit(input.limit);
    if (input.projectIds.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }
    const projects = [...input.projectIds];
    const projectId = input.projectId ?? null;
    const assigneeId = input.assigneeId ?? null;
    const rows = await tx.sql<SummaryTaskRowRaw[]>`
      SELECT t.id AS "taskId",
             t.code AS code,
             t.project_id AS "projectId",
             t.module_id AS "moduleId",
             t.title AS title,
             t.completed_at AS "completedAt",
             (SELECT min(ta.user_id) FROM app.task_assignees ta WHERE ta.task_id = t.id) AS "assigneeId"
        FROM app.tasks t
       WHERE t.project_id = ANY(${projects}::integer[])          AND t.deleted_at IS NULL         AND t.work_status = 'DONE'
         AND t.lifecycle_status <> 'INVALID'
         AND t.completed_at >= (${input.fromDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND t.completed_at < (${input.toDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
         AND (${projectId}::integer IS NULL OR t.project_id = ${projectId})
         AND (${assigneeId}::integer IS NULL OR EXISTS (SELECT 1 FROM app.task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${assigneeId}))
       ORDER BY t.completed_at DESC, t.id DESC
       LIMIT ${input.limit + 1}
    `;
    const [countRow] = await tx.sql<{ total: number }[]>`
      SELECT COUNT(*)::integer AS total
        FROM app.tasks t
       WHERE t.project_id = ANY(${projects}::integer[])          AND t.deleted_at IS NULL         AND t.work_status = 'DONE'
         AND t.lifecycle_status <> 'INVALID'
         AND t.completed_at >= (${input.fromDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND t.completed_at < (${input.toDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
         AND (${projectId}::integer IS NULL OR t.project_id = ${projectId})
         AND (${assigneeId}::integer IS NULL OR EXISTS (SELECT 1 FROM app.task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${assigneeId}))
    `;
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      items: visible.map((row) => ({
        ...row,
        completedAt: new Date(row.completedAt),
      })),
      total: countRow?.total ?? 0,
      hasMore,
    };
  }
}

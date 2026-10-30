import { Injectable } from "@nestjs/common";

import { RECORD_SUMMARY_ITEM_MAX } from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";

/** 列表条数上限：契约层已按 A 裁决 Q-06 收口到 1..10，端口再兜一层。 */
export const CHANGE_RECORD_READ_LIMIT_MAX = 100;

/** countPublishedByTask 的 taskIds 上限，避免无界数组进入 SQL 参数。 */
export const CHANGE_RECORD_TASK_IDS_MAX = 1000;

export type ChangeRecordReadInputErrorReason =
  "invalid-limit" | "invalid-task-ids";

/** 端口入参越界；调用方（应用层）负责映射为 422。 */
export class ChangeRecordReadInputError extends Error {
  readonly reason: ChangeRecordReadInputErrorReason;

  constructor(reason: ChangeRecordReadInputErrorReason, message: string) {
    super(message);
    this.name = "ChangeRecordReadInputError";
    this.reason = reason;
  }
}

export interface RecordCountInput {
  readonly projectId: number;
  /** 省略 = 项目内全部模块。 */
  readonly moduleId?: number;
}

export interface RecentRecordItem {
  readonly recordId: number;
  readonly projectId: number;
  readonly moduleId: number;
  readonly code: string;
  readonly title: string;
  readonly currentVersion: number;
  readonly publishedAt: Date;
}

export interface LeftoverItemSummary {
  readonly leftoverItemId: number;
  readonly recordId: number;
  /** 记录编号；PUBLISHED / VOID 记录的 code 非空（0000 的 state CHECK）。 */
  readonly recordCode: string;
  /** 来源记录当前标题（change_records.title）；R-2 裁决 §10.2。 */
  readonly recordTitle: string;
  readonly projectId: number;
  readonly content: string;
  readonly createdAt: Date;
}

/**
 * 当前 Drizzle + postgres-js 组合把时间类型解析器覆盖成透传，时间列以文本返回；
 * 适配器在边界统一还原为 Date，保证端口签名与运行时行为一致。
 */
interface RecentRecordRowRaw extends Omit<RecentRecordItem, "publishedAt"> {
  readonly publishedAt: string;
}

interface LeftoverItemRowRaw extends Omit<LeftoverItemSummary, "createdAt"> {
  readonly createdAt: string;
}

/**
 * R-6 遗留问题列表的展示分桶：OPEN = 父记录 PUBLISHED 且遗留项 ACTIVE；
 * CLOSED = 父记录 VOID 或遗留项 CONVERTED / RESOLVED。VOIDED 为父记录状态派生的
 * 有效状态，不写入 change_record_leftover_items，恢复记录后自然回到原状态。
 */
export type LeftoverListBucket = "OPEN" | "CLOSED";

/** R-6 列表入参；projectIds 必须来自服务端 AuthorizedProjectScope，端口不校验授权。 */
export interface LeftoverListReadInput {
  readonly projectIds: readonly number[];
  readonly bucket?: LeftoverListBucket;
  readonly limit: number;
  readonly afterLeftoverItemId?: number;
}

/** R-6 列表行：内容取最新版本快照；任务字段只返回 ID，编号由应用层解析。 */
export interface LeftoverListRow {
  readonly leftoverItemId: number;
  readonly recordId: number;
  readonly recordCode: string;
  readonly recordTitle: string;
  readonly projectId: number;
  readonly moduleId: number;
  readonly authorId: number;
  readonly authorName?: string;
  readonly publishedAt: Date;
  readonly content: string;
  readonly status: "ACTIVE" | "CONVERTED" | "RESOLVED" | "VOIDED";
  /** 来源任务（记录归属任务）；独立记录为 null。 */
  readonly sourceTaskId: number | null;
  /** 已生成跟进任务；未转换或「已解决」遗留项为 null。 */
  readonly followupTaskId: number | null;
}

/** R-6 分页结果：hasMore 为 true 时 nextLeftoverItemId 是最后一条的 keyset 位置。 */
export interface LeftoverListPage {
  readonly items: readonly LeftoverListRow[];
  readonly nextLeftoverItemId: number | null;
  readonly hasMore: boolean;
}

interface LeftoverListRowRaw extends Omit<LeftoverListRow, "publishedAt"> {
  readonly publishedAt: string;
}

/**
 * 任务 → PUBLISHED 正式记录数映射条目（功能设计 §29.4：按 change_records 计数，
 * 不按版本计数；裁决修订 D-1）。计数为 0 的任务不出现，
 * 消费端按 `?? 0` 补齐，恒有 `hasPublishedRecord === count > 0`。
 */
export interface TaskPublishedRecordCountItem {
  readonly taskId: number;
  readonly count: number;
}

/** R-4 聚合组记录页入参；taskIds 为空表示没有候选任务。 */
export interface TaskGroupRecordReadInput {
  readonly projectId: number;
  readonly taskIds: readonly number[];
  readonly limit: number;
  readonly afterRecordId?: number;
}

export interface TaskGroupRecordRow {
  readonly recordId: number;
  readonly code: string;
  readonly title: string;
  readonly status: "PUBLISHED" | "VOID";
  readonly taskId: number;
  readonly publishedAt: Date;
}

export interface TaskGroupRecordPage {
  readonly items: readonly TaskGroupRecordRow[];
  /** 还有下一页时为最后一条的 id（keyset 位置），否则为 null。 */
  readonly nextRecordId: number | null;
  readonly hasMore: boolean;
}

interface TaskGroupRecordRowRaw extends Omit<
  TaskGroupRecordRow,
  "publishedAt"
> {
  readonly publishedAt: string;
}
/** F-33 迭代总结记录入参；projectIds 必须来自服务端 AuthorizedProjectScope，端口不校验授权。 */
export interface RecordSummaryReadInput {
  readonly projectIds: readonly number[];
  /** 起始自然日（含），Asia/Shanghai 日历日，格式 YYYY-MM-DD。 */
  readonly fromDate: string;
  /** 结束自然日（含），Asia/Shanghai 日历日，格式 YYYY-MM-DD。 */
  readonly toDate: string;
  /** 收窄到单个项目；越权项目由授权范围收敛，端口不额外校验。 */
  readonly projectId?: number;
  /** 收窄到单个作者。 */
  readonly authorId?: number;
  readonly limit: number;
}

/**
 * F-33 正文要点行：一条 PUBLISHED 记录。changeSolution / resultVerification 取自
 * current_payload，两者都是记录正文的原文，服务端不做措辞改写。
 */
export interface RecordSummaryRecordRow {
  readonly recordId: number;
  readonly recordCode: string;
  readonly projectId: number;
  readonly moduleId: number;
  readonly title: string;
  readonly changeSolution: string;
  readonly resultVerification: string;
  readonly authorId: number;
  readonly authorName?: string;
  readonly publishedAt: Date;
  readonly taskId: number | null;
}

export interface RecordSummaryRecordPage {
  readonly items: readonly RecordSummaryRecordRow[];
  /** 与筛选同口径的总数，不受 limit 截断影响。 */
  readonly total: number;
  readonly hasMore: boolean;
}

/** F-33 遗留问题入参；口径为来源记录的 published_at 落在 [from, to) 内。 */
export interface RecordSummaryLeftoverReadInput {
  readonly projectIds: readonly number[];
  /** 起始自然日（含），Asia/Shanghai 日历日，格式 YYYY-MM-DD。 */
  readonly fromDate: string;
  /** 结束自然日（含），Asia/Shanghai 日历日，格式 YYYY-MM-DD。 */
  readonly toDate: string;
  readonly projectId?: number;
  readonly authorId?: number;
  readonly limit: number;
}

/**
 * F-33 遗留问题行：内容取最新版本快照（与 R-6 同一口径）；status 为遗留项当前
 * 有效处置状态，CONVERTED / RESOLVED 为已处理，父记录 VOID 时为 VOIDED（已作废）。
 * 三者在 totals.closedLeftoverCount 中统一计入已收尾数量。
 */
export interface RecordSummaryLeftoverRow {
  readonly leftoverItemId: number;
  readonly recordId: number;
  readonly recordCode: string;
  readonly recordTitle: string;
  readonly projectId: number;
  readonly authorId: number;
  readonly authorName?: string;
  readonly content: string;
  readonly status: "ACTIVE" | "CONVERTED" | "RESOLVED" | "VOIDED";
  readonly followupTaskId: number | null;
  readonly publishedAt: Date;
}

export interface RecordSummaryLeftoverPage {
  readonly items: readonly RecordSummaryLeftoverRow[];
  /** 与筛选同口径的遗留项总数。 */
  readonly total: number;
  /** 其中已处理或已作废（CONVERTED / RESOLVED / VOIDED）的数量。 */
  readonly closedTotal: number;
  readonly hasMore: boolean;
}

interface RecordSummaryRecordRowRaw extends Omit<
  RecordSummaryRecordRow,
  "publishedAt"
> {
  readonly publishedAt: string;
}

interface RecordSummaryLeftoverRowRaw extends Omit<
  RecordSummaryLeftoverRow,
  "publishedAt"
> {
  readonly publishedAt: string;
}

/**
 * 记录域（B）的项目维度只读聚合端口，服务 F-29 项目概览与 R-1 / R-3 的记录维度。
 *
 * 约定：
 * 1. 只读、不取锁；不校验项目授权，调用方必须先取得 AuthorizedProjectScope。
 * 2. 统计口径按功能设计 §29.4：计数基于 change_records（不按版本计数），
 *    每条任务记录都按 change_records 行计数。
 * 3. 记录可见性按 A 裁决 Q-13：只有 PUBLISHED 与 VOID 可见，DRAFT 不可见。
 */
export abstract class ChangeRecordReadPort {
  /** F-29 迭代记录数：只计 status = PUBLISHED，VOID / DRAFT 不计。 */
  abstract countPublished(
    tx: TransactionContext,
    input: RecordCountInput,
  ): Promise<number>;

  /** F-29 最近迭代：只计 PUBLISHED，按 published_at DESC, id DESC 稳定排序。 */
  abstract listRecentPublished(
    tx: TransactionContext,
    input: RecordCountInput & { readonly limit: number },
  ): Promise<readonly RecentRecordItem[]>;

  /**
   * F-29 未处理遗留问题：只取 status = ACTIVE 且父记录为 PUBLISHED；父记录
   * VOID 时遗留项派生为已作废，不再进入待处理统计。按 created_at DESC, id DESC
   * 稳定排序。
   */
  abstract listActiveLeftovers(
    tx: TransactionContext,
    input: RecordCountInput & { readonly limit: number },
  ): Promise<readonly LeftoverItemSummary[]>;

  /**
   * R-6 遗留问题列表（F-20 / F-32）：跨项目按授权范围汇总可见记录（PUBLISHED /
   * VOID，A 裁决 Q-13）的遗留项，内容口径与 listActiveLeftovers 相同（最新版本
   * 快照）。固定 leftoverItemId DESC 与 keyset 分页；只读、不取锁，调用方必须先
   * 取得 AuthorizedProjectScope。projectIds 为空短路返回空页，不发出 SQL。
   */
  abstract listLeftovers(
    tx: TransactionContext,
    input: LeftoverListReadInput,
  ): Promise<LeftoverListPage>;
  /**
   * F-29 待处理遗留问题总数（R-2 裁决 §10.2）：与 listActiveLeftovers 同一过滤，
   * 不受 activeLeftoverLimit 影响；不按版本重复计数。
   */
  abstract countActiveLeftovers(
    tx: TransactionContext,
    input: RecordCountInput,
  ): Promise<number>;

  /**
   * 任务 → PUBLISHED 正式记录数映射（裁决修订 D-1 / §11.6）：单条 SQL、按
   * task_id 升序，供 R-1 成员项、R-3 列表项与 R-5 批量标记同时消费；
   * 计数为 0 的任务不出现，消费端按 `?? 0` 补齐（恒有
   * hasPublishedRecord === publishedRecordCount > 0）。
   *
   * R-3 的记录维度筛选不依赖本方法：MyTaskQueryPort.list 在同一分页 SQL 内用
   * 等价 EXISTS 先过滤后分页；本方法只为本页或本次请求的 taskIds 补齐计数。
   * projectIds 或 taskIds 为空时短路返回空集，不发出 SQL；
   * taskIds 上限 CHANGE_RECORD_TASK_IDS_MAX，超限抛 ChangeRecordReadInputError。
   */
  abstract countPublishedByTask(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly TaskPublishedRecordCountItem[]>;

  /**
   * 任务 → 遗留问题来源标记（裁决修订 D-2 / F-20）：返回 taskIds 中在
   * leftover_task_links 存在链接行的任务 ID（升序）。链接行由转换 Workflow 写入
   * 且永不删除（leftover_item_id 主键 + task_id 唯一），因此存在即「由遗留问题
   * 转换而来」，与来源记录当前状态（PUBLISHED / VOID）及遗留项处置状态
   * （CONVERTED / RESOLVED）无关；供 R-3 列表项与 R-5 批量标记同时消费。
   * projectIds 或 taskIds 为空时短路返回空集，不发出 SQL；
   * taskIds 上限 CHANGE_RECORD_TASK_IDS_MAX，超限抛 ChangeRecordReadInputError。
   */
  abstract listLeftoverSourceTaskIds(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly number[]>;

  /**
   * R-4 聚合组记录分页：只返回 PUBLISHED 与 VOID（A 裁决 Q-13），
   * 固定 recordId DESC，taskIds 为空短路返回空页；只读、不取锁，
   * 调用方必须先取得 AuthorizedProjectScope 并把 taskIds 限制在组成员内。
   */
  abstract listVisibleRecordsByTaskIds(
    tx: TransactionContext,
    input: TaskGroupRecordReadInput,
  ): Promise<TaskGroupRecordPage>;

  /**
   * F-33 迭代总结记录：范围内（published_at 落在 [from, to)）status = PUBLISHED 的
   * 记录，按现时可见性取数——不作废、不含草稿。固定 published_at DESC, id DESC，
   * 便于正文按时间倒序阅读；total 与筛选同口径，不受 limit 截断。
   * 只读、不取锁；projectIds 为空时短路返回空页，不发出 SQL。
   */
  abstract summaryRecords(
    tx: TransactionContext,
    input: RecordSummaryReadInput,
  ): Promise<RecordSummaryRecordPage>;

  /**
   * F-33 迭代总结遗留问题：来源记录在范围内且仍可见（PUBLISHED / VOID）的遗留项，
   * 内容取最新版本快照；父记录 VOID 时 status 派生为 VOIDED；closedTotal 为其中
   * CONVERTED / RESOLVED / VOIDED 的数量，用于总结
   * 正文的「已处理或已作废 X 条」口径。固定 leftoverItemId DESC；只读、不取锁。
   * projectIds 为空时短路返回空页，不发出 SQL。
   */
  abstract summaryLeftovers(
    tx: TransactionContext,
    input: RecordSummaryLeftoverReadInput,
  ): Promise<RecordSummaryLeftoverPage>;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ChangeRecordReadInputError(
      "invalid-limit",
      "change record read limit must be a positive integer",
    );
  }
  if (limit > CHANGE_RECORD_READ_LIMIT_MAX) {
    throw new ChangeRecordReadInputError(
      "invalid-limit",
      `limit exceeds CHANGE_RECORD_READ_LIMIT_MAX (${CHANGE_RECORD_READ_LIMIT_MAX})`,
    );
  }
}

/**
 * F-33 总结取数专用 limit 校验：总结要一次取完范围内的事实（上限由契约
 * `RECORD_SUMMARY_ITEM_MAX` 定义），不适用分页接口的
 * `CHANGE_RECORD_READ_LIMIT_MAX`（100）口径。
 */
function assertSummaryLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ChangeRecordReadInputError(
      "invalid-limit",
      "record summary limit must be a positive integer",
    );
  }
  if (limit > RECORD_SUMMARY_ITEM_MAX) {
    throw new ChangeRecordReadInputError(
      "invalid-limit",
      `limit exceeds RECORD_SUMMARY_ITEM_MAX (${RECORD_SUMMARY_ITEM_MAX})`,
    );
  }
}

function assertTaskIds(taskIds: readonly number[] | undefined): void {
  if (taskIds === undefined) {
    return;
  }
  if (taskIds.length > CHANGE_RECORD_TASK_IDS_MAX) {
    throw new ChangeRecordReadInputError(
      "invalid-task-ids",
      `taskIds exceeds CHANGE_RECORD_TASK_IDS_MAX (${CHANGE_RECORD_TASK_IDS_MAX}) entries`,
    );
  }
  for (const taskId of taskIds) {
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      throw new ChangeRecordReadInputError(
        "invalid-task-ids",
        "taskIds must contain positive integers",
      );
    }
  }
}

@Injectable()
export class PostgresChangeRecordReadPort extends ChangeRecordReadPort {
  async countPublished(
    tx: TransactionContext,
    input: RecordCountInput,
  ): Promise<number> {
    const moduleId = input.moduleId ?? null;
    const [row] = await tx.sql<{ total: number }[]>`
      SELECT COUNT(*)::integer AS total
        FROM app.change_records cr
       WHERE cr.project_id = ${input.projectId}
         AND cr.status = 'PUBLISHED'
         AND (${moduleId}::integer IS NULL OR cr.module_id = ${moduleId})
    `;
    return row?.total ?? 0;
  }

  async listRecentPublished(
    tx: TransactionContext,
    input: RecordCountInput & { readonly limit: number },
  ): Promise<readonly RecentRecordItem[]> {
    assertLimit(input.limit);
    const moduleId = input.moduleId ?? null;
    const rows = await tx.sql<RecentRecordRowRaw[]>`
      SELECT cr.id AS "recordId",
             cr.project_id AS "projectId",
             cr.module_id AS "moduleId",
             cr.code AS code,
             cr.title AS title,
             cr.current_version AS "currentVersion",
             cr.published_at AS "publishedAt"
        FROM app.change_records cr
       WHERE cr.project_id = ${input.projectId}
         AND cr.status = 'PUBLISHED'
         AND (${moduleId}::integer IS NULL OR cr.module_id = ${moduleId})
       ORDER BY cr.published_at DESC, cr.id DESC
       LIMIT ${input.limit}
    `;
    return rows.map((row) => ({
      ...row,
      publishedAt: new Date(row.publishedAt),
    }));
  }

  async listActiveLeftovers(
    tx: TransactionContext,
    input: RecordCountInput & { readonly limit: number },
  ): Promise<readonly LeftoverItemSummary[]> {
    assertLimit(input.limit);
    const moduleId = input.moduleId ?? null;
    const rows = await tx.sql<LeftoverItemRowRaw[]>`
      SELECT li.id AS "leftoverItemId",
             li.record_id AS "recordId",
             cr.code AS "recordCode",
             cr.title AS "recordTitle",
             li.project_id AS "projectId",
             vl.content_snapshot AS content,
             li.created_at AS "createdAt"
        FROM app.change_record_leftover_items li
        JOIN app.change_records cr
          ON cr.id = li.record_id
         AND cr.project_id = li.project_id
         AND cr.status = 'PUBLISHED'
        JOIN LATERAL (
          SELECT v.content_snapshot
            FROM app.change_record_version_leftovers v
           WHERE v.leftover_item_id = li.id
             AND v.record_id = li.record_id
             AND v.project_id = li.project_id
           ORDER BY v.version_no DESC
           LIMIT 1
        ) vl ON TRUE
       WHERE li.project_id = ${input.projectId}
         AND li.status = 'ACTIVE'
         AND (${moduleId}::integer IS NULL OR cr.module_id = ${moduleId})
       ORDER BY li.created_at DESC, li.id DESC
       LIMIT ${input.limit}
    `;
    return rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
    }));
  }

  async listLeftovers(
    tx: TransactionContext,
    input: LeftoverListReadInput,
  ): Promise<LeftoverListPage> {
    assertLimit(input.limit);
    if (input.projectIds.length === 0) {
      return { items: [], nextLeftoverItemId: null, hasMore: false };
    }
    const projects = [...input.projectIds];
    const bucketCondition =
      input.bucket === undefined
        ? tx.sql``
        : input.bucket === "OPEN"
          ? tx.sql`AND cr.status = 'PUBLISHED' AND li.status = 'ACTIVE'`
          : tx.sql`AND (cr.status = 'VOID' OR li.status IN ('CONVERTED', 'RESOLVED'))`;
    const after = input.afterLeftoverItemId ?? null;
    const rows = await tx.sql<LeftoverListRowRaw[]>`
      SELECT li.id AS "leftoverItemId",
             li.record_id AS "recordId",
             cr.code AS "recordCode",
             cr.title AS "recordTitle",
             li.project_id AS "projectId",
             cr.module_id AS "moduleId",
             cr.author_id AS "authorId",
             cr.author_snapshot->>'name' AS "authorName",
             cr.published_at AS "publishedAt",
             vl.content_snapshot AS content,
             CASE WHEN cr.status = 'VOID' THEN 'VOIDED' ELSE li.status END AS status,
             cr.task_id AS "sourceTaskId",
             ltl.task_id AS "followupTaskId"
        FROM app.change_record_leftover_items li
        JOIN app.change_records cr
          ON cr.id = li.record_id
         AND cr.project_id = li.project_id
         AND cr.status IN ('PUBLISHED', 'VOID')
        JOIN LATERAL (
          SELECT v.content_snapshot
            FROM app.change_record_version_leftovers v
           WHERE v.leftover_item_id = li.id
             AND v.record_id = li.record_id
             AND v.project_id = li.project_id
           ORDER BY v.version_no DESC
           LIMIT 1
        ) vl ON TRUE
        LEFT JOIN app.leftover_task_links ltl
          ON ltl.leftover_item_id = li.id
         AND ltl.project_id = li.project_id
       WHERE li.project_id = ANY(${projects}::integer[])
         ${bucketCondition}
         AND (${after}::integer IS NULL OR li.id < ${after})
       ORDER BY li.id DESC
       LIMIT ${input.limit + 1}
    `;
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    const items = visible.map((row) => ({
      ...row,
      publishedAt: new Date(row.publishedAt),
    }));
    const last = items.length === 0 ? null : items[items.length - 1]!;
    return {
      items,
      hasMore,
      nextLeftoverItemId: hasMore && last !== null ? last.leftoverItemId : null,
    };
  }

  async countActiveLeftovers(
    tx: TransactionContext,
    input: RecordCountInput,
  ): Promise<number> {
    const moduleId = input.moduleId ?? null;
    const [row] = await tx.sql<{ total: number }[]>`
      SELECT COUNT(*)::integer AS total
        FROM app.change_record_leftover_items li
        JOIN app.change_records cr
          ON cr.id = li.record_id
         AND cr.project_id = li.project_id
         AND cr.status = 'PUBLISHED'
       WHERE li.project_id = ${input.projectId}
         AND li.status = 'ACTIVE'
         AND (${moduleId}::integer IS NULL OR cr.module_id = ${moduleId})
    `;
    return row?.total ?? 0;
  }

  async countPublishedByTask(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly TaskPublishedRecordCountItem[]> {
    assertTaskIds(taskIds);
    if (projectIds.length === 0 || taskIds.length === 0) {
      return [];
    }
    const projects = [...projectIds];
    const tasks = [...taskIds];
    return (await tx.sql<TaskPublishedRecordCountItem[]>`
      SELECT cr.task_id AS "taskId",
             COUNT(*)::integer AS count
        FROM app.change_records cr
       WHERE cr.project_id = ANY(${projects}::integer[])
         AND cr.status = ${"PUBLISHED"}
         AND cr.task_id = ANY(${tasks}::integer[])
       GROUP BY cr.task_id
       ORDER BY cr.task_id ASC
    `) as unknown as readonly TaskPublishedRecordCountItem[];
  }

  async listLeftoverSourceTaskIds(
    tx: TransactionContext,
    projectIds: readonly number[],
    taskIds: readonly number[],
  ): Promise<readonly number[]> {
    assertTaskIds(taskIds);
    if (projectIds.length === 0 || taskIds.length === 0) {
      return [];
    }
    const projects = [...projectIds];
    const tasks = [...taskIds];
    return (
      await tx.sql<{ taskId: number }[]>`
      SELECT ltl.task_id AS "taskId"
        FROM app.leftover_task_links ltl
       WHERE ltl.project_id = ANY(${projects}::integer[])
         AND ltl.task_id = ANY(${tasks}::integer[])
       ORDER BY ltl.task_id ASC
    `
    ).map((row) => row.taskId);
  }

  async listVisibleRecordsByTaskIds(
    tx: TransactionContext,
    input: TaskGroupRecordReadInput,
  ): Promise<TaskGroupRecordPage> {
    assertLimit(input.limit);
    assertTaskIds(input.taskIds);
    if (input.taskIds.length === 0) {
      return { items: [], nextRecordId: null, hasMore: false };
    }
    const tasks = [...input.taskIds];
    const after = input.afterRecordId ?? null;
    const rows = await tx.sql<TaskGroupRecordRowRaw[]>`
      SELECT cr.id AS "recordId",
             cr.code AS code,
             cr.title AS title,
             cr.status AS status,
             cr.task_id AS "taskId",
             cr.published_at AS "publishedAt"
        FROM app.change_records cr
       WHERE cr.project_id = ${input.projectId}
         AND cr.status IN (${"PUBLISHED"}, ${"VOID"})
         AND cr.task_id = ANY(${tasks}::integer[])
         AND (${after}::integer IS NULL OR cr.id < ${after})
       ORDER BY cr.id DESC
       LIMIT ${input.limit + 1}
    `;
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    const items = visible.map((row) => ({
      ...row,
      publishedAt: new Date(row.publishedAt),
    }));
    const last = items.length === 0 ? null : items[items.length - 1]!;
    return {
      items,
      hasMore,
      nextRecordId: hasMore && last !== null ? last.recordId : null,
    };
  }

  async summaryRecords(
    tx: TransactionContext,
    input: RecordSummaryReadInput,
  ): Promise<RecordSummaryRecordPage> {
    assertSummaryLimit(input.limit);
    if (input.projectIds.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }
    const projects = [...input.projectIds];
    const projectId = input.projectId ?? null;
    const authorId = input.authorId ?? null;
    const rows = await tx.sql<RecordSummaryRecordRowRaw[]>`
      SELECT cr.id AS "recordId",
             cr.code AS "recordCode",
             cr.project_id AS "projectId",
             cr.module_id AS "moduleId",
             cr.title AS title,
             COALESCE(cr.current_payload->>'changeSolution', '') AS "changeSolution",
             COALESCE(cr.current_payload->>'resultVerification', '') AS "resultVerification",
             cr.author_id AS "authorId",
             cr.author_snapshot->>'name' AS "authorName",
             cr.published_at AS "publishedAt",
             cr.task_id AS "taskId"
        FROM app.change_records cr
       WHERE cr.project_id = ANY(${projects}::integer[])
         AND cr.status = 'PUBLISHED'
         AND cr.published_at >= (${input.fromDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND cr.published_at < (${input.toDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
         AND (${projectId}::integer IS NULL OR cr.project_id = ${projectId})
         AND (${authorId}::integer IS NULL OR cr.author_id = ${authorId})
       ORDER BY cr.published_at DESC, cr.id DESC
       LIMIT ${input.limit + 1}
    `;
    const [countRow] = await tx.sql<{ total: number }[]>`
      SELECT COUNT(*)::integer AS total
        FROM app.change_records cr
       WHERE cr.project_id = ANY(${projects}::integer[])
         AND cr.status = 'PUBLISHED'
         AND cr.published_at >= (${input.fromDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND cr.published_at < (${input.toDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
         AND (${projectId}::integer IS NULL OR cr.project_id = ${projectId})
         AND (${authorId}::integer IS NULL OR cr.author_id = ${authorId})
    `;
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      items: visible.map((row) => ({
        ...row,
        publishedAt: new Date(row.publishedAt),
      })),
      total: countRow?.total ?? 0,
      hasMore,
    };
  }

  async summaryLeftovers(
    tx: TransactionContext,
    input: RecordSummaryLeftoverReadInput,
  ): Promise<RecordSummaryLeftoverPage> {
    assertSummaryLimit(input.limit);
    if (input.projectIds.length === 0) {
      return { items: [], total: 0, closedTotal: 0, hasMore: false };
    }
    const projects = [...input.projectIds];
    const projectId = input.projectId ?? null;
    const authorId = input.authorId ?? null;
    const rows = await tx.sql<RecordSummaryLeftoverRowRaw[]>`
      SELECT li.id AS "leftoverItemId",
             li.record_id AS "recordId",
             cr.code AS "recordCode",
             cr.title AS "recordTitle",
             li.project_id AS "projectId",
             cr.author_id AS "authorId",
             cr.author_snapshot->>'name' AS "authorName",
             vl.content_snapshot AS content,
             CASE WHEN cr.status = 'VOID' THEN 'VOIDED' ELSE li.status END AS status,
             ltl.task_id AS "followupTaskId",
             cr.published_at AS "publishedAt"
        FROM app.change_record_leftover_items li
        JOIN app.change_records cr
          ON cr.id = li.record_id
         AND cr.project_id = li.project_id
         AND cr.status IN ('PUBLISHED', 'VOID')
        JOIN LATERAL (
          SELECT v.content_snapshot
            FROM app.change_record_version_leftovers v
           WHERE v.leftover_item_id = li.id
             AND v.record_id = li.record_id
             AND v.project_id = li.project_id
           ORDER BY v.version_no DESC
           LIMIT 1
        ) vl ON TRUE
        LEFT JOIN app.leftover_task_links ltl
          ON ltl.leftover_item_id = li.id
         AND ltl.project_id = li.project_id
       WHERE li.project_id = ANY(${projects}::integer[])
         AND cr.published_at >= (${input.fromDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND cr.published_at < (${input.toDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
         AND (${projectId}::integer IS NULL OR li.project_id = ${projectId})
         AND (${authorId}::integer IS NULL OR cr.author_id = ${authorId})
       ORDER BY li.id DESC
       LIMIT ${input.limit + 1}
    `;
    const [countRow] = await tx.sql<{ total: number; closedTotal: number }[]>`
      SELECT COUNT(*)::integer AS total,
             COUNT(*) FILTER (WHERE cr.status = 'VOID' OR li.status IN ('CONVERTED', 'RESOLVED'))::integer AS "closedTotal"
        FROM app.change_record_leftover_items li
        JOIN app.change_records cr
          ON cr.id = li.record_id
         AND cr.project_id = li.project_id
         AND cr.status IN ('PUBLISHED', 'VOID')
       WHERE li.project_id = ANY(${projects}::integer[])
         AND cr.published_at >= (${input.fromDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')
         AND cr.published_at < (${input.toDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
         AND (${projectId}::integer IS NULL OR li.project_id = ${projectId})
         AND (${authorId}::integer IS NULL OR cr.author_id = ${authorId})
    `;
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      items: visible.map((row) => ({
        ...row,
        publishedAt: new Date(row.publishedAt),
      })),
      total: countRow?.total ?? 0,
      closedTotal: countRow?.closedTotal ?? 0,
      hasMore,
    };
  }
}

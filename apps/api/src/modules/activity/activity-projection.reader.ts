import type { Sql } from "postgres";

import type { TimeCursorValue } from "../../cursors/time-cursor.js";
import type { ActivitySourceEntityType } from "./activity.write-port.js";

/**
 * 与契约 `ActivityCategory` 对齐的服务端分类口径。映射必须与前端 chip 行
 * 一一对应：`github` / `member` 按 `activity_type` 前缀，`task` / `record` /
 * `feature` / `module` 按 `sourceEntityType`，`project` 是兜底桶。
 */
export type ActivityCategoryFilter =
  | "all"
  | "task"
  | "record"
  | "feature"
  | "module"
  | "project"
  | "member"
  | "github";

/**
 * 分类条件是枚举驱动的常量 SQL 片段，不接受用户输入拼接。
 * `project` 是兜底桶，必须与前端「其余归项目」的分支保持一致。
 */
const ACTIVITY_CATEGORY_SQL: Readonly<Record<ActivityCategoryFilter, string>> =
  {
    all: "",
    github: "AND activity_type LIKE 'EXTERNAL_LINK%'",
    member: "AND activity_type LIKE 'PROJECT_MEMBER%'",
    task: "AND source_entity_type IN ('TASK','TASK_GROUP')",
    record: "AND source_entity_type IN ('CHANGE_RECORD','LEFTOVER_ITEM')",
    feature: "AND source_entity_type = 'FEATURE'",
    module: "AND source_entity_type = 'MODULE'",
    project:
      "AND NOT (activity_type LIKE 'EXTERNAL_LINK%' OR activity_type LIKE 'PROJECT_MEMBER%' OR source_entity_type IN ('TASK','TASK_GROUP','CHANGE_RECORD','LEFTOVER_ITEM','FEATURE','MODULE'))",
  };

export interface ActivityProjectionReadInput {
  readonly projectIds: readonly number[];
  /** ADMIN_ONLY 可见的项目集合；空数组表示只返回 MEMBER。 */
  readonly adminOnlyProjectIds: readonly number[];
  readonly category: ActivityCategoryFilter;
  readonly limit: number;
  readonly after: TimeCursorValue | null;
}

export interface ActivityProjectionDayTotalsInput {
  readonly projectIds: readonly number[];
  readonly adminOnlyProjectIds: readonly number[];
  readonly category: ActivityCategoryFilter;
  /** 读取上限（调用方传「上限 + 1」以便判断截断）。 */
  readonly limit: number;
}

export interface ActivityProjectionItem {
  readonly id: string;
  readonly projectId: number;
  readonly sourceEntityType: ActivitySourceEntityType;
  readonly sourceEntityId: number;
  readonly activityType: string;
  readonly actorId: number | null;
  /**
   * 操作人展示名：ADR-087 起优先使用写入时的身份快照；没有快照的历史行
   * 才回退当前用户目录。系统事件为 null。
   */
  readonly actorName: string | null;
  readonly summary: string;
  readonly occurredAt: string;
}

export interface ActivityProjectionPage {
  readonly items: readonly ActivityProjectionItem[];
  readonly last: TimeCursorValue | null;
}

export interface ActivityDayTotal {
  /** Asia/Shanghai 自然日，格式 YYYY-MM-DD。 */
  readonly day: string;
  readonly count: number;
}

export interface ActivityProjectionReader {
  read(input: ActivityProjectionReadInput): Promise<ActivityProjectionPage>;
  readDayTotals(
    input: ActivityProjectionDayTotalsInput,
  ): Promise<readonly ActivityDayTotal[]>;
}

interface ActivityProjectionRow {
  readonly id: string;
  readonly project_id: number;
  readonly source_entity_type: string;
  readonly source_entity_id: number;
  readonly activity_type: string;
  readonly actor_id: number | null;
  readonly actor_name: string | null;
  readonly summary: string;
  readonly occurred_at: string;
}

interface ActivityDayTotalRow {
  readonly day: string;
  readonly count: number;
}

export class PostgresActivityProjectionReader {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async read(
    input: ActivityProjectionReadInput,
  ): Promise<ActivityProjectionPage> {
    if (input.projectIds.length === 0) {
      return { items: [], last: null };
    }
    const rows = await this.#sql.unsafe<ActivityProjectionRow[]>(
      `SELECT
         id::text,
         project_id,
         source_entity_type,
         source_entity_id,
         activity_type,
         actor_id,
         CASE
           WHEN activity_projection.actor_snapshot->>'id' = activity_projection.actor_id::text
             AND btrim(activity_projection.actor_snapshot->>'name') <> ''
             THEN btrim(activity_projection.actor_snapshot->>'name')
           ELSE COALESCE(
             (SELECT u.name
                FROM app.users AS u
               WHERE u.id = activity_projection.actor_id),
             (SELECT d.name
                FROM app.deleted_user_identities AS d
               WHERE d.user_id = activity_projection.actor_id)
           )
         END AS actor_name,
         summary,
         to_char(occurred_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
       FROM app.activity_projection
      WHERE project_id = ANY($1::int[])
        AND (
          visibility_scope = 'MEMBER'
          OR (visibility_scope = 'ADMIN_ONLY' AND project_id = ANY($2::int[]))
        )
        ${ACTIVITY_CATEGORY_SQL[input.category]}
        AND (
          $3::timestamptz IS NULL
          OR occurred_at < $3::timestamptz
          OR (occurred_at = $3::timestamptz AND id < $4::bigint)
        )
      ORDER BY occurred_at DESC, id DESC
      LIMIT $5`,
      [
        [...input.projectIds],
        [...input.adminOnlyProjectIds],
        input.after?.at ?? null,
        input.after?.id ?? "0",
        input.limit + 1,
      ],
    );

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        sourceEntityType: row.source_entity_type as ActivitySourceEntityType,
        sourceEntityId: row.source_entity_id,
        activityType: row.activity_type,
        actorId: row.actor_id,
        actorName: row.actor_name,
        summary: row.summary,
        occurredAt: row.occurred_at,
      })),
      last:
        last === undefined || !hasMore
          ? null
          : { at: last.occurred_at, id: last.id },
    };
  }

  /**
   * 按 Asia/Shanghai 自然日统计与列表同一过滤条件的全量总数；日界换算在 SQL
   * 内完成，不使用进程时区。返回按日期倒序，最多 `limit` 行。
   */
  async readDayTotals(
    input: ActivityProjectionDayTotalsInput,
  ): Promise<readonly ActivityDayTotal[]> {
    if (input.projectIds.length === 0) {
      return [];
    }
    const rows = await this.#sql.unsafe<ActivityDayTotalRow[]>(
      `SELECT
         to_char((occurred_at AT TIME ZONE 'Asia/Shanghai')::date,
                 'YYYY-MM-DD') AS day,
         count(*)::int AS count
       FROM app.activity_projection
      WHERE project_id = ANY($1::int[])
        AND (
          visibility_scope = 'MEMBER'
          OR (visibility_scope = 'ADMIN_ONLY' AND project_id = ANY($2::int[]))
        )
        ${ACTIVITY_CATEGORY_SQL[input.category]}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $3`,
      [[...input.projectIds], [...input.adminOnlyProjectIds], input.limit],
    );
    return rows.map((row) => ({ day: row.day, count: row.count }));
  }
}

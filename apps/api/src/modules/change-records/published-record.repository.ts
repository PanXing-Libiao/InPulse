import { Injectable } from "@nestjs/common";
import {
  publishedRecordSchema,
  voidedRecordSchema,
  type ReadableRecord,
  changeRecordVersionSchema,
  type PublishedRecord,
  type ChangeRecordVersion,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { TimeCursorValue } from "../../cursors/time-cursor.js";
import { normalizedLeftoverEntries } from "./leftover-entries.js";
/** B-3b 记录清单来源筛选：主任务 / 来源任务 / 模块级直接创建。 */
export type RecordFeedSourceFilter = "MAIN" | "SOURCE" | "MODULE";
/** B-3b 跨项目清单入参；projectIds 必须来自服务端 AuthorizedProjectScope。 */
export interface RecordFeedListInput {
  readonly projectIds: readonly number[];
  /** 已按管理员可见性收敛的 status 集合（非管理员不出现 VOID）。 */
  readonly statuses: readonly ("PUBLISHED" | "VOID")[];
  readonly source: RecordFeedSourceFilter | null;
  /** 归一化后的检索词；null 表示不启用全文过滤。 */
  readonly normalizedQuery: string | null;
  /** 与 statuses 对应的搜索投影可见性白名单。 */
  readonly visibilityScopes: readonly ("MEMBER" | "ADMIN_ONLY")[];
  readonly limit: number;
  readonly after: TimeCursorValue | null;
}
export interface RecordFeedListPage {
  readonly items: ReadableRecord[];
  readonly last: TimeCursorValue | null;
  readonly hasMore: boolean;
}
type RecordFeedRow = Row & {
  voidedAt: Date | null;
  voidReason: string | null;
  publishedAtCursor: string;
};
/**
 * ACTIVE 聚合组内的来源任务关系（与 TaskGroupMembershipReadPort 同一口径：
 * 组成员与组都必须处于 ACTIVE，且双向带 project_id 防跨项目串联）。
 */
function activeSourceExists(tx: TransactionContext) {
  return tx.sql`EXISTS (
          SELECT 1
            FROM app.task_group_members m
            JOIN app.task_groups g
              ON g.id = m.group_id
             AND g.project_id = m.project_id
           WHERE m.project_id = change_records.project_id
             AND m.task_id = change_records.task_id
             AND m.status = 'ACTIVE'
             AND g.status = 'ACTIVE'
             AND m.role = 'SOURCE'
        )`;
}
/** MAIN = 任务来源中未被 ACTIVE 组合并为来源任务的记录；MODULE 为无任务记录。 */
function sourceCondition(
  tx: TransactionContext,
  source: RecordFeedSourceFilter | null,
) {
  if (source === null) return tx.sql``;
  if (source === "SOURCE") return tx.sql`AND ${activeSourceExists(tx)}`;
  if (source === "MAIN")
    return tx.sql`AND task_id IS NOT NULL AND NOT ${activeSourceExists(tx)}`;
  return tx.sql`AND task_id IS NULL`;
}
type Row = Omit<
  PublishedRecord,
  | "createdAt"
  | "updatedAt"
  | "publishedAt"
  | "title"
  | "contextProblem"
  | "changeSolution"
  | "resultVerification"
  | "remainingIssues"
  | "leftovers"
  | "status"
> & {
  status: "PUBLISHED" | "VOID";
  title: string;
  currentPayload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date;
};
export interface RecordListPageInput {
  readonly projectId: number;
  readonly limit: number;
  readonly after: TimeCursorValue | null;
}

export interface RecordListPageResult {
  readonly items: ReadableRecord[];
  readonly last: TimeCursorValue | null;
  readonly hasMore: boolean;
}

@Injectable()
export class PublishedRecordRepository {
  private columns(tx: TransactionContext) {
    return tx.sql`id,project_id AS "projectId",module_id AS "moduleId",task_id AS "taskId",title,handler_id AS "handlerId",handler_snapshot->>'name' AS "handlerName",author_id AS "authorId",author_snapshot->>'name' AS "authorName",status,code,current_version AS "currentVersion",published_at AS "publishedAt",current_payload AS "currentPayload",row_version AS "rowVersion",created_at AS "createdAt",updated_at AS "updatedAt"`;
  }
  private async dto(tx: TransactionContext, row: Row) {
    const { currentPayload, ...identity } = row;
    const leftovers =
      await tx.sql`SELECT l.id,CASE WHEN ${row.status} = 'VOID' THEN 'VOIDED' ELSE l.status END AS status,l.row_version AS "rowVersion",v.content_snapshot AS content,t.task_id AS "linkedTaskId" FROM app.change_record_version_leftovers v JOIN app.change_record_leftover_items l ON l.id=v.leftover_item_id AND l.project_id=v.project_id AND l.record_id=v.record_id LEFT JOIN app.leftover_task_links t ON t.leftover_item_id=l.id AND t.project_id=l.project_id WHERE v.record_id=${row.id} AND v.project_id=${row.projectId} AND v.version_no=${row.currentVersion} ORDER BY l.id`;
    return {
      ...currentPayload,
      ...identity,
      remainingIssues: normalizedLeftoverEntries(
        currentPayload.remainingIssues,
        leftovers.map((leftover) => leftover.id),
      ),
      leftovers,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      publishedAt: new Date(row.publishedAt).toISOString(),
    };
  }
  async find(tx: TransactionContext, projectId: number, recordId: number) {
    const [row] = await tx.sql<
      Row[]
    >`SELECT ${this.columns(tx)} FROM app.change_records WHERE id=${recordId} AND project_id=${projectId} AND status='PUBLISHED'`;
    return row
      ? publishedRecordSchema.parse(await this.dto(tx, row))
      : undefined;
  }
  async listPublishedPage(
    tx: TransactionContext,
    input: RecordListPageInput,
  ): Promise<RecordListPageResult> {
    const rows = await tx.sql<
      (Row & { publishedAtCursor: string })[]
    >`SELECT ${this.columns(tx)},to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAtCursor" FROM app.change_records WHERE project_id=${input.projectId} AND status='PUBLISHED' AND (${input.after?.at ?? null}::timestamptz IS NULL OR published_at < ${input.after?.at ?? null}::timestamptz OR (published_at = ${input.after?.at ?? null}::timestamptz AND id < ${input.after?.id ?? "0"}::bigint)) ORDER BY published_at DESC,id DESC LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit,
      pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = await Promise.all(
      pageRows.map(async (row) => {
        const { publishedAtCursor: _cursor, ...base } = row;
        return publishedRecordSchema.parse(await this.dto(tx, base));
      }),
    );
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items,
      hasMore,
      last:
        hasMore && lastRow !== undefined
          ? { at: lastRow.publishedAtCursor, id: String(lastRow.id) }
          : null,
    };
  }
  async findVoided(
    tx: TransactionContext,
    projectId: number,
    recordId: number,
  ) {
    const [row] = await tx.sql<
      (Row & { voidedAt: Date; voidReason: string })[]
    >`SELECT ${this.columns(tx)},voided_at AS "voidedAt",void_reason AS "voidReason" FROM app.change_records WHERE id=${recordId} AND project_id=${projectId} AND status='VOID'`;
    if (!row) return undefined;
    const { voidedAt, voidReason, ...base } = row;
    const content = await this.dto(tx, base);
    return voidedRecordSchema.parse({
      ...content,
      status: "VOID",
      voidedAt: new Date(voidedAt).toISOString(),
      voidReason,
    });
  }
  async listVoidedPage(
    tx: TransactionContext,
    input: RecordListPageInput,
  ): Promise<RecordListPageResult> {
    const rows = await tx.sql<
      (Row & {
        voidedAt: Date;
        voidReason: string;
        publishedAtCursor: string;
      })[]
    >`SELECT ${this.columns(tx)},voided_at AS "voidedAt",void_reason AS "voidReason",to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAtCursor" FROM app.change_records WHERE project_id=${input.projectId} AND status='VOID' AND (${input.after?.at ?? null}::timestamptz IS NULL OR published_at < ${input.after?.at ?? null}::timestamptz OR (published_at = ${input.after?.at ?? null}::timestamptz AND id < ${input.after?.id ?? "0"}::bigint)) ORDER BY published_at DESC,id DESC LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit,
      pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = await Promise.all(
      pageRows.map(async (row) => {
        const {
          voidedAt,
          voidReason,
          publishedAtCursor: _cursor,
          ...base
        } = row;
        const content = await this.dto(tx, base);
        return voidedRecordSchema.parse({
          ...content,
          status: "VOID",
          voidedAt: new Date(voidedAt).toISOString(),
          voidReason,
        });
      }),
    );
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items,
      hasMore,
      last:
        hasMore && lastRow !== undefined
          ? { at: lastRow.publishedAtCursor, id: String(lastRow.id) }
          : null,
    };
  }
  /**
   * B-3b 跨项目记录清单（GET /change-records）分页：status、来源与 q 全部在
   * SQL 层过滤后再按 published_at DESC, id DESC 做 keyset 分页，翻页不经过
   * 应用层重排；q 复用 CHANGE_RECORD 全文投影（PGroonga，普通查询必须带
   * app.pgroonga_query_escape）。VOID 行沿用 voidedRecordSchema 形状。
   */
  async listFeedPage(
    tx: TransactionContext,
    input: RecordFeedListInput,
  ): Promise<RecordFeedListPage> {
    const projects = [...input.projectIds];
    const statuses = [...input.statuses];
    const visibilityScopes = [...input.visibilityScopes];
    const source = sourceCondition(tx, input.source);
    const rows = await tx.sql<RecordFeedRow[]>`
      SELECT ${this.columns(tx)},
             voided_at AS "voidedAt",
             void_reason AS "voidReason",
             to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAtCursor"
        FROM app.change_records
       WHERE project_id = ANY(${projects}::integer[])
         AND status = ANY(${statuses}::text[])
         ${source}
         AND (${input.normalizedQuery}::text IS NULL OR EXISTS (
               SELECT 1
                 FROM app.search_projection sp
                WHERE sp.project_id = change_records.project_id
                  AND sp.entity_type = 'CHANGE_RECORD'
                  AND sp.entity_id = change_records.id
                  AND sp.visibility_scope = ANY(${visibilityScopes}::text[])
                  AND sp.normalized_search_text &@~ app.pgroonga_query_escape(${input.normalizedQuery})
             ))
         AND (${input.after?.at ?? null}::timestamptz IS NULL OR published_at < ${input.after?.at ?? null}::timestamptz OR (published_at = ${input.after?.at ?? null}::timestamptz AND id < ${input.after?.id ?? "0"}::bigint))
       ORDER BY published_at DESC,id DESC
       LIMIT ${input.limit + 1}
    `;
    const hasMore = rows.length > input.limit,
      pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = await Promise.all(
      pageRows.map(async (row) => {
        const {
          voidedAt,
          voidReason,
          publishedAtCursor: _cursor,
          ...base
        } = row;
        const content = await this.dto(tx, base);
        if (base.status === "PUBLISHED")
          return publishedRecordSchema.parse(content);
        if (voidedAt === null || voidReason === null)
          throw new Error(
            `change record ${row.id} is VOID without void snapshot`,
          );
        return voidedRecordSchema.parse({
          ...content,
          status: "VOID",
          voidedAt: new Date(voidedAt).toISOString(),
          voidReason,
        });
      }),
    );
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items,
      hasMore,
      last:
        hasMore && lastRow !== undefined
          ? { at: lastRow.publishedAtCursor, id: String(lastRow.id) }
          : null,
    };
  }
  async versions(
    tx: TransactionContext,
    record: ReadableRecord,
    versionNo?: number,
  ): Promise<ChangeRecordVersion[]> {
    const rows = await tx.sql<
      {
        recordId: number;
        projectId: number;
        versionNo: number;
        title: string;
        payload: Record<string, unknown>;
        createdBy: number;
        createdAt: Date;
      }[]
    >`SELECT record_id AS "recordId",project_id AS "projectId",version_no AS "versionNo",title_snapshot AS title,payload,created_by AS "createdBy",created_at AS "createdAt" FROM app.change_record_versions WHERE record_id=${record.id} AND project_id=${record.projectId} AND version_no<=${record.currentVersion} ${versionNo === undefined ? tx.sql`` : tx.sql`AND version_no=${versionNo}`} ORDER BY version_no DESC`;
    return Promise.all(
      rows.map(async (row) => {
        const { payload, ...identity } = row;
        const leftovers =
          await tx.sql`SELECT leftover_item_id AS id,content_snapshot AS content FROM app.change_record_version_leftovers WHERE record_id=${record.id} AND project_id=${record.projectId} AND version_no=${row.versionNo} ORDER BY leftover_item_id`;
        return changeRecordVersionSchema.parse({
          ...payload,
          ...identity,
          remainingIssues: normalizedLeftoverEntries(
            payload.remainingIssues,
            leftovers.map((leftover) => leftover.id),
          ),
          leftovers,
          createdAt: new Date(row.createdAt).toISOString(),
        });
      }),
    );
  }
}

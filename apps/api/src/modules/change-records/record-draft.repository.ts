import { Injectable } from "@nestjs/common";
import {
  recordDraftItemSchema,
  type RecordDraftContent,
  type RecordDraftItem,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { TimeCursorValue } from "../../cursors/time-cursor.js";
import { normalizedLeftoverEntries } from "./leftover-entries.js";

export interface RecordDraftListPageInput {
  readonly projectId: number;
  readonly limit: number;
  readonly after: TimeCursorValue | null;
  /** 只返回该作者创建的草稿（项目草稿区传当前用户）；省略返回项目内全部草稿。 */
  readonly authorId?: number;
}

export interface RecordDraftListPageResult {
  readonly items: RecordDraftItem[];
  readonly last: TimeCursorValue | null;
  readonly hasMore: boolean;
}

/** B-3b 我的草稿入参；projectIds 必须来自服务端 AuthorizedProjectScope。 */
export interface MyRecordDraftListInput {
  readonly authorId: number;
  readonly projectIds: readonly number[];
  readonly limit: number;
  readonly after: TimeCursorValue | null;
}

export interface MyRecordDraftListPage {
  readonly items: RecordDraftItem[];
  readonly last: TimeCursorValue | null;
  readonly hasMore: boolean;
}

export interface DraftScope {
  projectId: number;
  moduleId: number;
}
type Row = {
  id: number;
  projectId: number;
  moduleId: number;
  taskId: number | null;
  title: string;
  handlerId: number;
  authorId: number;
  authorName: string;
  handlerName: string;
  status: string;
  code: null;
  currentVersion: number;
  publishedAt: null;
  currentPayload: Record<string, unknown>;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
};
const dto = (row: Row) => {
  const { currentPayload, ...fields } = row;
  return recordDraftItemSchema.parse({
    ...currentPayload,
    ...fields,
    remainingIssues: normalizedLeftoverEntries(
      currentPayload.remainingIssues,
      [],
    ),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
};
@Injectable()
export class RecordDraftRepository {
  async bindSource(
    tx: TransactionContext,
    before: RecordDraftItem,
    taskId: number,
  ) {
    const rows =
      await tx.sql`UPDATE app.change_records SET task_id=${taskId},row_version=row_version+1,updated_at=GREATEST(clock_timestamp(),updated_at) WHERE id=${before.id} AND project_id=${before.projectId} AND status='DRAFT' AND task_id IS NULL AND row_version=${before.rowVersion} RETURNING id`;
    return rows.length ? this.find(tx, before.projectId, before.id) : undefined;
  }
  async authorsForTask(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
  ) {
    const rows = await tx.sql<
      { authorId: number }[]
    >`SELECT DISTINCT author_id AS "authorId" FROM app.change_records WHERE project_id=${projectId} AND task_id=${taskId} ORDER BY author_id`;
    return rows.map((row) => row.authorId);
  }
  private columns(tx: TransactionContext) {
    return tx.sql`id, project_id AS "projectId",module_id AS "moduleId",task_id AS "taskId",title,handler_id AS "handlerId",handler_snapshot->>'name' AS "handlerName",author_id AS "authorId",author_snapshot->>'name' AS "authorName",status,code,
    current_version AS "currentVersion",published_at AS "publishedAt",current_payload AS "currentPayload",
    row_version AS "rowVersion",created_at AS "createdAt",updated_at AS "updatedAt"`;
  }
  async find(
    tx: TransactionContext,
    projectId: number,
    recordId: number,
    lock = false,
  ): Promise<RecordDraftItem | undefined> {
    const [row] = await tx.sql<
      Row[]
    >`SELECT ${this.columns(tx)} FROM app.change_records WHERE project_id=${projectId} AND id=${recordId} AND status='DRAFT' ${lock ? tx.sql`FOR UPDATE` : tx.sql``}`;
    return row ? dto(row) : undefined;
  }
  /**
   * 草稿列表分页（B-1）：created_at DESC,id DESC 与签名游标 keyset 一致，
   * 取 limit+1 判断 hasMore；last 只在还有下一页时返回；可选作者过滤。
   */
  async listPage(
    tx: TransactionContext,
    input: RecordDraftListPageInput,
  ): Promise<RecordDraftListPageResult> {
    const afterAt = input.after?.at ?? null,
      afterId = input.after?.id ?? "0",
      authorId = input.authorId ?? null;
    const rows = await tx.sql<
      (Row & { createdAtCursor: string })[]
    >`SELECT ${this.columns(tx)},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtCursor" FROM app.change_records WHERE project_id=${input.projectId} AND status='DRAFT' AND (${authorId}::integer IS NULL OR author_id=${authorId}::integer) AND (${afterAt}::timestamptz IS NULL OR created_at < ${afterAt}::timestamptz OR (created_at = ${afterAt}::timestamptz AND id < ${afterId}::bigint)) ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit,
      pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = pageRows.map((row) => {
      const { createdAtCursor: _cursor, ...base } = row;
      return dto(base);
    });
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items,
      hasMore,
      last:
        hasMore && lastRow !== undefined
          ? { at: lastRow.createdAtCursor, id: String(lastRow.id) }
          : null,
    };
  }
  /**
   * B-3b 我的草稿（跨项目）：author_id 恒为当前 actor，排序与单项目草稿列表
   * 一致（created_at DESC, id DESC）；被移出项目后该项目的草稿立即不再返回。
   */
  async listMyDraftsPage(
    tx: TransactionContext,
    input: MyRecordDraftListInput,
  ): Promise<MyRecordDraftListPage> {
    const projects = [...input.projectIds];
    const afterAt = input.after?.at ?? null,
      afterId = input.after?.id ?? "0";
    const rows = await tx.sql<
      (Row & { createdAtCursor: string })[]
    >`SELECT ${this.columns(tx)},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtCursor" FROM app.change_records WHERE author_id=${input.authorId} AND status='DRAFT' AND project_id = ANY(${projects}::integer[]) AND (${afterAt}::timestamptz IS NULL OR created_at < ${afterAt}::timestamptz OR (created_at = ${afterAt}::timestamptz AND id < ${afterId}::bigint)) ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit,
      pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = pageRows.map((row) => {
      const { createdAtCursor: _cursor, ...base } = row;
      return dto(base);
    });
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items,
      hasMore,
      last:
        hasMore && lastRow !== undefined
          ? { at: lastRow.createdAtCursor, id: String(lastRow.id) }
          : null,
    };
  }
  async create(
    tx: TransactionContext,
    scope: DraftScope,
    actorId: number,
    content: RecordDraftContent,
    source?: { taskId: number; handlerId: number },
  ): Promise<RecordDraftItem> {
    const { title, ...payload } = content;
    const [row] = await tx.sql<
      { id: number }[]
    >`INSERT INTO app.change_records(project_id,module_id,title,handler_id,author_id,status,current_payload,task_id)
      VALUES (${scope.projectId},${scope.moduleId},${title},${source?.handlerId ?? actorId},${actorId},'DRAFT',${JSON.stringify(payload)}::jsonb,${source?.taskId ?? null}) RETURNING id`;
    return (await this.find(tx, scope.projectId, row!.id))!;
  }
  async listForTask(tx: TransactionContext, projectId: number, taskId: number) {
    const rows = await tx.sql<
      Row[]
    >`SELECT ${this.columns(tx)} FROM app.change_records WHERE project_id=${projectId} AND task_id=${taskId} AND status='DRAFT' ORDER BY id DESC`;
    return rows.map(dto);
  }
  /**
   * 物理删除一条草稿及其子行，由 0026 的 app.delete_change_record_draft 完成：
   * app_runtime 没有 change_records 的 DELETE 权限（已发布记录必须由数据库挡住
   * 物理删除），删除能力收在 SECURITY DEFINER 函数里，只对草稿开放。
   * 行不存在或版本不一致返回 false，由服务映射 409。
   */
  async deleteDraft(
    tx: TransactionContext,
    projectId: number,
    recordId: number,
    expectedRowVersion: number,
  ): Promise<boolean> {
    const rows = await tx.sql<
      { deleted: boolean }[]
    >`SELECT app.delete_change_record_draft(${projectId},${recordId},${expectedRowVersion}) AS deleted`;
    return rows[0]?.deleted === true;
  }
  async update(
    tx: TransactionContext,
    before: RecordDraftItem,
    content: RecordDraftContent,
  ): Promise<RecordDraftItem | undefined> {
    const { title, ...payload } = content;
    const rows =
      await tx.sql`UPDATE app.change_records SET title=${title},current_payload=${JSON.stringify(payload)}::jsonb,row_version=row_version+1,updated_at=GREATEST(clock_timestamp(),updated_at)
      WHERE id=${before.id} AND project_id=${before.projectId} AND status='DRAFT' AND row_version=${before.rowVersion} RETURNING id`;
    return rows.length ? this.find(tx, before.projectId, before.id) : undefined;
  }
}

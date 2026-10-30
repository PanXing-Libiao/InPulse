import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  SearchProjectionWritePort,
  type SearchProjectionWriteInput,
} from "../search/index.js";

/**
 * F-26 遗留问题搜索分类（功能设计 §24.1 / §24.2）：记录发布、作废/恢复与
 * 遗留项转任务在同一事务内把记录的遗留项刷新为独立 `LEFTOVER` 搜索投影。
 *
 * 口径（A 裁决，2026-09-11）：
 * - entityId 为 `change_record_leftover_items.id`；内容取该遗留项最新版本的
 *   `content_snapshot`（版本号最大者），尚无快照的遗留项不投影。
 * - title 取内容至多 500 字符，超出时保留前 499 字符并以省略号结尾，不改写
 *   内容本身；summary 标注处置状态与来源记录，供搜索结果区分进度。
 * - 可见性跟随父记录：PUBLISHED 为 MEMBER、VOID 为 ADMIN_ONLY，与
 *   CHANGE_RECORD 投影同一规则；sourceStatus 为遗留项状态。
 */

export const LEFTOVER_PROJECTION_TITLE_MAX = 500;

export type LeftoverProjectionStatus = "ACTIVE" | "CONVERTED" | "RESOLVED";

/** 投影所需的记录身份；记录状态仅影响投影可见性。 */
export interface LeftoverProjectionRecord {
  readonly id: number;
  readonly projectId: number;
  readonly code: string;
  readonly title: string;
  readonly status: string;
}

const LEFTOVER_STATUS_LABELS: Readonly<
  Record<LeftoverProjectionStatus, string>
> = {
  ACTIVE: "待处理",
  RESOLVED: "已解决",
  CONVERTED: "已转为任务",
};

export function leftoverProjectionTitle(content: string): string {
  if (content.length <= LEFTOVER_PROJECTION_TITLE_MAX) return content;
  return `${content.slice(0, LEFTOVER_PROJECTION_TITLE_MAX - 1)}…`;
}

export function leftoverProjectionSummary(
  status: LeftoverProjectionStatus,
  record: Pick<LeftoverProjectionRecord, "code" | "title">,
): string {
  return `${LEFTOVER_STATUS_LABELS[status]} · ${record.code} ${record.title}`;
}

export function buildLeftoverProjectionInput(
  record: LeftoverProjectionRecord,
  leftover: {
    readonly id: number;
    readonly status: LeftoverProjectionStatus;
    readonly rowVersion: number;
    readonly content: string;
  },
): SearchProjectionWriteInput {
  return {
    projectId: record.projectId,
    entityType: "LEFTOVER",
    entityId: leftover.id,
    moduleId: null,
    recordId: record.id,
    title: leftoverProjectionTitle(leftover.content),
    summary: leftoverProjectionSummary(leftover.status, record),
    rawText: [record.code, record.title, leftover.content].join("\n"),
    visibilityScope: record.status === "VOID" ? "ADMIN_ONLY" : "MEMBER",
    sourceStatus: leftover.status,
    sourceRowVersion: leftover.rowVersion,
  };
}

interface LeftoverProjectionRow {
  readonly id: number;
  readonly status: LeftoverProjectionStatus;
  readonly rowVersion: number;
  readonly content: string | null;
}

@Injectable()
export class LeftoverSearchProjectionSync {
  constructor(
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
  ) {}

  /** 调用方持有写事务与父级校验；本方法只读遗留项并 upsert 投影。 */
  async syncRecord(
    tx: TransactionContext,
    record: LeftoverProjectionRecord,
  ): Promise<void> {
    const rows = await tx.sql<LeftoverProjectionRow[]>`
      SELECT li.id,
             li.status,
             li.row_version AS "rowVersion",
             vl.content_snapshot AS content
        FROM app.change_record_leftover_items li
        LEFT JOIN LATERAL (
          SELECT v.content_snapshot
            FROM app.change_record_version_leftovers v
           WHERE v.leftover_item_id = li.id
             AND v.record_id = li.record_id
             AND v.project_id = li.project_id
           ORDER BY v.version_no DESC
           LIMIT 1
        ) vl ON TRUE
       WHERE li.project_id = ${record.projectId}
         AND li.record_id = ${record.id}
       ORDER BY li.id
    `;
    for (const row of rows) {
      if (row.content === null) continue;
      await this.search.upsert(
        tx,
        buildLeftoverProjectionInput(record, {
          id: row.id,
          status: row.status,
          rowVersion: row.rowVersion,
          content: row.content,
        }),
      );
    }
  }
}

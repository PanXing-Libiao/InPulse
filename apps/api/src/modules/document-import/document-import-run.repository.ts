import { Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";

/** ADR-064 / ADR-109 文档导入批次行；同项目同摘要唯一，运行记录不可更新不可删除。 */
export interface DocumentImportRunRecord {
  readonly id: number;
  readonly projectId: number;
  readonly documentDigest: string;
  readonly templateVersion: string;
  readonly actorId: number;
  readonly moduleCount: number;
  readonly taskCount: number;
  readonly reusedModuleCount: number;
  readonly addedMemberCount: number;
  readonly createdAt: string;
}

/** 预览/执行查重所需的既有批次摘要（含操作者显示名）。 */
export interface DocumentImportDuplicateRecord {
  readonly projectId: number;
  readonly importedAt: string;
  readonly actorName: string;
}

export interface InsertDocumentImportRunInput {
  readonly projectId: number;
  readonly documentDigest: string;
  readonly templateVersion: string;
  readonly actorId: number;
  readonly moduleCount: number;
  readonly taskCount: number;
  readonly reusedModuleCount: number;
  readonly addedMemberCount: number;
}

interface RunRow {
  readonly id: number;
  readonly projectId: number;
  readonly documentDigest: string;
  readonly templateVersion: string;
  readonly actorId: number;
  readonly moduleCount: number;
  readonly taskCount: number;
  readonly reusedModuleCount: number;
  readonly addedMemberCount: number;
  readonly createdAt: string | Date;
}

interface DuplicateRow {
  readonly projectId: number;
  readonly createdAt: string | Date;
  readonly actorName: string;
}

const toRunRecord = (row: RunRow): DocumentImportRunRecord => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
});

const toDuplicateRecord = (
  row: DuplicateRow,
): DocumentImportDuplicateRecord => ({
  projectId: row.projectId,
  importedAt: new Date(row.createdAt).toISOString(),
  actorName: row.actorName,
});

/**
 * ADR-064 文档导入批次仓储。查重分两种口径：
 * 1. 项目内导入只查目标项目（同一文档可以合法地导入到不同项目）；
 * 2. 整项目导入时项目尚不存在，按摘要全局匹配任意项目的既有批次。
 * 唯一约束 (project_id, document_digest) 是并发场景的最后防线。
 */
@Injectable()
export class DocumentImportRunRepository {
  async findDuplicateInProject(
    tx: TransactionContext,
    projectId: number,
    documentDigest: string,
  ): Promise<DocumentImportDuplicateRecord | undefined> {
    const [row] = await tx.sql<DuplicateRow[]>`
      SELECT r.project_id AS "projectId",
             r.created_at AS "createdAt",
             r.actor_snapshot->>'name' AS "actorName"
        FROM app.document_import_runs r
       WHERE r.project_id = ${projectId}
         AND r.document_digest = ${documentDigest}
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1
    `;
    return row === undefined ? undefined : toDuplicateRecord(row);
  }

  async findDuplicateGlobally(
    tx: TransactionContext,
    documentDigest: string,
  ): Promise<DocumentImportDuplicateRecord | undefined> {
    const [row] = await tx.sql<DuplicateRow[]>`
      SELECT r.project_id AS "projectId",
             r.created_at AS "createdAt",
             r.actor_snapshot->>'name' AS "actorName"
        FROM app.document_import_runs r
       WHERE r.document_digest = ${documentDigest}
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1
    `;
    return row === undefined ? undefined : toDuplicateRecord(row);
  }

  async insert(
    tx: TransactionContext,
    input: InsertDocumentImportRunInput,
  ): Promise<DocumentImportRunRecord> {
    const [row] = await tx.sql<RunRow[]>`
      INSERT INTO app.document_import_runs (
        project_id,
        document_digest,
        template_version,
        actor_id,
        module_count,
        task_count,
        reused_module_count,
        added_member_count
      ) VALUES (
        ${input.projectId},
        ${input.documentDigest},
        ${input.templateVersion},
        ${input.actorId},
        ${input.moduleCount},
        ${input.taskCount},
        ${input.reusedModuleCount},
        ${input.addedMemberCount}
      )
      RETURNING id,
                project_id AS "projectId",
                document_digest AS "documentDigest",
                template_version AS "templateVersion",
                actor_id AS "actorId",
                module_count AS "moduleCount",
                task_count AS "taskCount",
                reused_module_count AS "reusedModuleCount",
                added_member_count AS "addedMemberCount",
                created_at AS "createdAt"
    `;
    return toRunRecord(row!);
  }
}

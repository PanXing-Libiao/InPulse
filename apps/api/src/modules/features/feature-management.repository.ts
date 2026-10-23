import { Injectable } from "@nestjs/common";
import {
  featureItemSchema,
  type FeatureEditRequest,
  type FeatureItem,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  featureStatColumns,
  lifecycleRankExpression,
} from "../../stats/card-stat-columns.js";

type Row = Omit<FeatureItem, "createdAt" | "updatedAt" | "stats"> & {
  createdAt: string | Date;
  updatedAt: string | Date;
  openTaskCount: number;
  completedTaskCount: number;
  recordCount: number;
};
const dto = (row: Row): FeatureItem => {
  const { openTaskCount, completedTaskCount, recordCount, ...rest } = row;
  return featureItemSchema.parse({
    ...rest,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    stats: { openTaskCount, completedTaskCount, recordCount },
  });
};

/** ADR-096：删除功能命令读取的原始行，含行版本，不解析为 `FeatureItem`。 */
export interface FeatureDeletionRow {
  readonly id: number;
  readonly projectId: number;
  readonly moduleId: number;
  readonly code: string;
  readonly name: string;
  readonly rowVersion: number;
}

/** ADR-096：功能物理删除后的结果快照与级联计数。 */
export interface FeatureHardDeletedRow extends FeatureDeletionRow {
  readonly deletedAt: string;
  readonly deletedTaskCount: number;
  readonly deletedRecordCount: number;
  readonly removedLinkCount: number;
}

@Injectable()
export class FeatureManagementRepository {
  async list(
    tx: TransactionContext,
    projectId: number,
    moduleId: number,
  ): Promise<FeatureItem[]> {
    const rows = await tx.sql<
      Row[]
    >`SELECT f.id, f.project_id AS "projectId", f.module_id AS "moduleId", f.code, f.name, f.current_behavior AS "currentBehavior", f.acceptance_criteria AS "acceptanceCriteria", f.tags, f.created_by AS "createdBy", f.created_by_snapshot->>'name' AS "createdByName", f.row_version AS "rowVersion", f.created_at AS "createdAt", f.updated_at AS "updatedAt", ${featureStatColumns(tx.sql, "f")} FROM app.features f WHERE f.project_id = ${projectId} AND f.module_id = ${moduleId} AND f.deleted_at IS NULL ORDER BY ${lifecycleRankExpression(tx.sql, "feature", "f")}, f.created_at DESC, f.id DESC`;
    return rows.map(dto);
  }

  async find(
    tx: TransactionContext,
    projectId: number,
    featureId: number,
    moduleId: number,
    lock = false,
  ): Promise<FeatureItem | undefined> {
    const rows = await tx.sql<
      Row[]
    >`SELECT f.id, f.project_id AS "projectId", f.module_id AS "moduleId", f.code, f.name, f.current_behavior AS "currentBehavior", f.acceptance_criteria AS "acceptanceCriteria", f.tags, f.created_by AS "createdBy", f.created_by_snapshot->>'name' AS "createdByName", f.row_version AS "rowVersion", f.created_at AS "createdAt", f.updated_at AS "updatedAt", ${featureStatColumns(tx.sql, "f")} FROM app.features f WHERE f.project_id = ${projectId} AND f.id = ${featureId} AND f.module_id = ${moduleId} AND f.deleted_at IS NULL ${lock ? tx.sql`FOR UPDATE` : tx.sql``}`;
    return rows[0] === undefined ? undefined : dto(rows[0]);
  }

  async candidates(
    tx: TransactionContext,
    projectId: number,
    ids: readonly number[],
  ): Promise<FeatureItem[]> {
    if (!ids.length) return [];
    const rows = await tx.sql<
      { id: number; moduleId: number }[]
    >`SELECT id, module_id AS "moduleId" FROM app.features WHERE project_id = ${projectId} AND id = ANY(${tx.sql.array([...ids])}::int[]) AND deleted_at IS NULL ORDER BY id`;
    return Promise.all(
      rows.map(
        async (row) => (await this.find(tx, projectId, row.id, row.moduleId))!,
      ),
    );
  }

  async create(
    tx: TransactionContext,
    projectId: number,
    actorId: number,
    moduleId: number,
    code: string,
    input: FeatureEditRequest,
  ): Promise<FeatureItem> {
    const rows = await tx.sql<
      { id: number }[]
    >`INSERT INTO app.features (project_id, module_id, code, name, current_behavior, acceptance_criteria, tags, created_by) VALUES (${projectId}, ${moduleId}, ${code}, ${input.name}, ${input.currentBehavior}, ${input.acceptanceCriteria ?? ""}, ${tx.sql.array(input.tags)}, ${actorId}) RETURNING id`;
    return (await this.find(tx, projectId, rows[0]!.id, moduleId))!;
  }

  async update(
    tx: TransactionContext,
    current: FeatureItem,
    next: {
      name: string;
      currentBehavior: string;
      acceptanceCriteria: string;
      tags: string[];
    },
  ): Promise<FeatureItem | undefined> {
    const rows = await tx.sql<
      { id: number }[]
    >`UPDATE app.features SET name = ${next.name}, current_behavior = ${next.currentBehavior}, acceptance_criteria = ${next.acceptanceCriteria}, tags = ${tx.sql.array(next.tags)}, updated_at = now(), row_version = row_version + 1 WHERE id = ${current.id} AND project_id = ${current.projectId} AND row_version = ${current.rowVersion} RETURNING id`;
    return rows.length
      ? this.find(tx, current.projectId, current.id, current.moduleId)
      : undefined;
  }

  /**
   * ADR-096：删除命令的原始行读取，`lock` 时对功能行取排他锁；历史软删除行视为
   * 不存在。
   */
  async findForDeletion(
    tx: TransactionContext,
    projectId: number,
    moduleId: number,
    featureId: number,
    lock = false,
  ): Promise<FeatureDeletionRow | undefined> {
    const rows = await tx.sql<
      FeatureDeletionRow[]
    >`SELECT id, project_id AS "projectId", module_id AS "moduleId", code, name, row_version AS "rowVersion" FROM app.features WHERE project_id = ${projectId} AND module_id = ${moduleId} AND id = ${featureId} AND deleted_at IS NULL ${lock ? tx.sql`FOR UPDATE` : tx.sql``}`;
    return rows[0];
  }

  /**
   * ADR-096：功能物理删除。功能、其下全部任务、这些任务的记录以及归属于该功能
   * 的全部记录及下级数据由数据库窄口函数同一事务删除。
   */
  async hardDelete(
    tx: TransactionContext,
    current: FeatureDeletionRow,
    actorId: number,
    reason: string,
  ): Promise<FeatureHardDeletedRow | undefined> {
    const rows = await tx.sql<{ result: FeatureHardDeletedRow | null }[]>`
      SELECT app.hard_delete_feature(
        ${current.projectId}, ${current.moduleId}, ${current.id},
        ${current.rowVersion}, ${actorId}, ${reason}
      ) AS result
    `;
    return rows[0]?.result ?? undefined;
  }
}

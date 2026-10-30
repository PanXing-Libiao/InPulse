import { Injectable } from "@nestjs/common";
import {
  moduleItemSchema,
  type ModuleEditRequest,
  type ModuleItem,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  lifecycleRankExpression,
  moduleStatColumns,
} from "../../stats/card-stat-columns.js";

type Row = Omit<ModuleItem, "createdAt" | "updatedAt" | "stats"> & {
  createdAt: string | Date;
  updatedAt: string | Date;
  openTaskCount: number;
  completedTaskCount: number;
};
const dto = (row: Row): ModuleItem => {
  const { openTaskCount, completedTaskCount, ...rest } = row;
  return moduleItemSchema.parse({
    ...rest,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    stats: { openTaskCount, completedTaskCount },
  });
};

/** ADR-096：删除模块命令读取的原始行，含行版本，不解析为 `ModuleItem`。 */
export interface ModuleDeletionRow {
  readonly id: number;
  readonly projectId: number;
  readonly code: string;
  readonly name: string;
  readonly kind: ModuleItem["kind"];
  readonly rowVersion: number;
}

/** ADR-096：模块物理删除后的结果快照与级联计数。 */
export interface ModuleHardDeletedRow extends ModuleDeletionRow {
  readonly deletedAt: string;
  readonly deletedTaskCount: number;
  readonly deletedRecordCount: number;
  readonly removedLinkCount: number;
}

@Injectable()
export class ModuleManagementRepository {
  async list(tx: TransactionContext, projectId: number): Promise<ModuleItem[]> {
    const rows = await tx.sql<
      Row[]
    >`SELECT m.id, m.code, m.project_id AS "projectId", m.name, m.description, m.kind, m.sort_order AS "sortOrder", m.row_version AS "rowVersion", m.created_at AS "createdAt", m.updated_at AS "updatedAt", ${moduleStatColumns(tx.sql, "m")} FROM app.modules m WHERE m.project_id = ${projectId} AND m.deleted_at IS NULL ORDER BY ${lifecycleRankExpression(tx.sql, "module", "m")}, m.created_at DESC, m.id DESC`;
    return rows.map(dto);
  }

  async find(
    tx: TransactionContext,
    projectId: number,
    moduleId: number,
    lock = false,
  ): Promise<ModuleItem | undefined> {
    const rows = await tx.sql<
      Row[]
    >`SELECT m.id, m.code, m.project_id AS "projectId", m.name, m.description, m.kind, m.sort_order AS "sortOrder", m.row_version AS "rowVersion", m.created_at AS "createdAt", m.updated_at AS "updatedAt", ${moduleStatColumns(tx.sql, "m")} FROM app.modules m WHERE m.project_id = ${projectId} AND m.id = ${moduleId} AND m.deleted_at IS NULL ${lock ? tx.sql`FOR UPDATE` : tx.sql``}`;
    return rows[0] === undefined ? undefined : dto(rows[0]);
  }

  async create(
    tx: TransactionContext,
    projectId: number,
    actorId: number,
    input: ModuleEditRequest,
  ): Promise<ModuleItem> {
    const rows = await tx.sql<
      { id: number }[]
    >`INSERT INTO app.modules (project_id, name, description, kind, created_by) VALUES (${projectId}, ${input.name}, ${input.description}, 'NORMAL', ${actorId}) RETURNING id`;
    return (await this.find(tx, projectId, rows[0]!.id))!;
  }

  /** ADR-044：模块只有名称与描述可改，已无生命周期状态可写。 */
  async update(
    tx: TransactionContext,
    current: ModuleItem,
    next: { name: string; description: string },
  ): Promise<ModuleItem | undefined> {
    const rows = await tx.sql<
      { id: number }[]
    >`UPDATE app.modules SET name = ${next.name}, description = ${next.description}, updated_at = now(), row_version = row_version + 1 WHERE id = ${current.id} AND project_id = ${current.projectId} AND row_version = ${current.rowVersion} RETURNING id`;
    return rows.length
      ? this.find(tx, current.projectId, current.id)
      : undefined;
  }

  /**
   * ADR-096：删除命令的原始行读取，`lock` 时对模块行取排他锁，阻止与子级写命令
   * 的写前 `FOR SHARE` 检查并行；历史软删除行视为不存在。
   */
  async findForDeletion(
    tx: TransactionContext,
    projectId: number,
    moduleId: number,
    lock = false,
  ): Promise<ModuleDeletionRow | undefined> {
    const rows = await tx.sql<
      ModuleDeletionRow[]
    >`SELECT id, project_id AS "projectId", code, name, kind, row_version AS "rowVersion" FROM app.modules WHERE project_id = ${projectId} AND id = ${moduleId} AND deleted_at IS NULL ${lock ? tx.sql`FOR UPDATE` : tx.sql``}`;
    return rows[0];
  }

  /**
   * ADR-096：模块物理删除。模块、全部任务、全部迭代记录及下级数据由
   * 数据库窄口函数同一事务删除；只保留审计、项目动态与删除事件。
   */
  async hardDelete(
    tx: TransactionContext,
    current: ModuleDeletionRow,
    actorId: number,
    reason: string,
  ): Promise<ModuleHardDeletedRow | undefined> {
    const rows = await tx.sql<{ result: ModuleHardDeletedRow | null }[]>`
      SELECT app.hard_delete_module(
        ${current.projectId}, ${current.id}, ${current.rowVersion},
        ${actorId}, ${reason}
      ) AS result
    `;
    return rows[0]?.result ?? undefined;
  }
}

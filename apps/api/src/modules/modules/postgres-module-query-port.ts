import type { TransactionContext } from "../../database/transaction-context.js";
import {
  ModuleQueryPort,
  type CheckModuleForWriteInput,
  type ModuleForWriteResource,
  type ModuleWriteCheckResult,
} from "./module-query.port.js";

export class PostgresModuleQueryPort extends ModuleQueryPort {
  async checkModuleForWrite(
    tx: TransactionContext,
    input: CheckModuleForWriteInput,
  ): Promise<ModuleWriteCheckResult> {
    // ADR-044：模块只有 ACTIVE 一种状态，取锁成功即代表可写。
    // ADR-096：历史软删除的模块一律视为不存在，不泄露其存在性。
    const [resource] = await tx.sql<ModuleForWriteResource[]>`
      SELECT id AS "moduleId", project_id AS "projectId",
        row_version AS "rowVersion"
      FROM app.modules
      WHERE id = ${input.moduleId} AND project_id = ${input.projectId}
        AND deleted_at IS NULL
      FOR SHARE
    `;
    if (!resource) return { kind: "not-found" };
    return { kind: "allowed", resource };
  }
}

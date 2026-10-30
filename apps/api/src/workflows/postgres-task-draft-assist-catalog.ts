import type { TransactionContext } from "../database/transaction-context.js";
import {
  TaskDraftAssistCatalogPort,
  type TaskDraftAssistCatalog,
} from "./task-draft-assist.catalog.port.js";

/** 候选上限：超过后只取前 N 条，避免把整个超大项目塞进一次提示词。 */
export const TASK_DRAFT_ASSIST_MAX_MODULES = 200;
export const TASK_DRAFT_ASSIST_MAX_FEATURES = 500;

export class PostgresTaskDraftAssistCatalog extends TaskDraftAssistCatalogPort {
  async load(
    tx: TransactionContext,
    projectId: number,
  ): Promise<TaskDraftAssistCatalog> {
    const modules = await tx.sql<{ id: number; name: string }[]>`
      SELECT id, name
        FROM app.modules
       WHERE project_id = ${projectId}
         AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT ${TASK_DRAFT_ASSIST_MAX_MODULES}
    `;
    const features = await tx.sql<
      {
        id: number;
        moduleId: number;
        moduleName: string;
        name: string;
      }[]
    >`
      SELECT f.id,
             f.module_id AS "moduleId",
             m.name AS "moduleName",
             f.name
        FROM app.features f
        JOIN app.modules m
          ON m.id = f.module_id
         AND m.project_id = f.project_id
         AND m.deleted_at IS NULL
       WHERE f.project_id = ${projectId}
         AND f.deleted_at IS NULL
       ORDER BY f.id ASC
       LIMIT ${TASK_DRAFT_ASSIST_MAX_FEATURES}
    `;
    return { modules, features };
  }
}

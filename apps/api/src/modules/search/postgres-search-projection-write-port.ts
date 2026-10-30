import { ExternalLinkQueryPort } from "../external-links/external-link-query.port.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  validateSearchProjectionWriteInput,
  SearchProjectionCapacityError,
  SearchProjectionWritePort,
  type SearchProjectionWriteInput,
} from "./search-projection.write-port.js";

/**
 * 显式接收调用方事务的搜索投影写适配器。
 * 规范化在应用层完成，数据库约束仍是最终防线；旧 source_row_version
 * 不会覆盖已持久化的较新投影状态。
 */
export class PostgresSearchProjectionWritePort extends SearchProjectionWritePort {
  async upsert(
    tx: TransactionContext,
    input: SearchProjectionWriteInput,
  ): Promise<void> {
    validateSearchProjectionWriteInput(input);
    const urls = await new ExternalLinkQueryPort().urls(
      tx,
      input.projectId,
      input.entityType,
      input.entityId,
    );
    let normalizedSearchText: string;
    try {
      normalizedSearchText = validateSearchProjectionWriteInput({
        ...input,
        rawText: [input.rawText, ...urls].join("\n"),
      });
    } catch (error) {
      if (urls.length) throw new SearchProjectionCapacityError();
      throw error;
    }

    await tx.sql`
      INSERT INTO app.search_projection (
        project_id,
        entity_type,
        entity_id,
        module_id,
        record_id,
        title,
        summary,
        raw_text,
        normalized_search_text,
        visibility_scope,
        source_status,
        source_row_version
      )
      VALUES (
        ${input.projectId},
        ${input.entityType},
        ${input.entityId},
        ${input.moduleId},
        ${input.recordId},
        ${input.title},
        ${input.summary},
        ${input.rawText},
        ${normalizedSearchText},
        ${input.visibilityScope},
        ${input.sourceStatus},
        ${input.sourceRowVersion}
      )
      ON CONFLICT (project_id, entity_type, entity_id)
      DO UPDATE SET
        module_id = EXCLUDED.module_id,
        record_id = EXCLUDED.record_id,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        raw_text = EXCLUDED.raw_text,
        normalized_search_text = EXCLUDED.normalized_search_text,
        visibility_scope = EXCLUDED.visibility_scope,
        source_status = EXCLUDED.source_status,
        source_row_version = EXCLUDED.source_row_version,
        updated_at = now()
      WHERE app.search_projection.source_row_version <=
            EXCLUDED.source_row_version
    `;
  }

  async remove(
    tx: TransactionContext,
    projectId: number,
    entityType: SearchProjectionWriteInput["entityType"],
    entityId: number,
  ): Promise<void> {
    await tx.sql`DELETE FROM app.search_projection WHERE project_id=${projectId} AND entity_type=${entityType} AND entity_id=${entityId}`;
  }
}

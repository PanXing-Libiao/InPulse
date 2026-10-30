import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  SearchProjectionWritePort,
  type SearchProjectionWriteInput,
} from "./search-projection.write-port.js";
/** Refresh derived link identifiers using the existing source text; never overwrite business content. */
@Injectable()
export class ExternalLinkSearchPort {
  constructor(
    @Inject(SearchProjectionWritePort)
    private readonly writer: SearchProjectionWritePort,
  ) {}
  async refresh(
    tx: TransactionContext,
    projectId: number,
    entityType: string,
    entityId: number,
    version: number,
  ) {
    const [row] = await tx.sql<
      SearchProjectionWriteInput[]
    >`SELECT project_id AS "projectId",entity_type AS "entityType",entity_id AS "entityId",module_id AS "moduleId",record_id AS "recordId",title,summary,raw_text AS "rawText",visibility_scope AS "visibilityScope",source_status AS "sourceStatus",source_row_version AS "sourceRowVersion" FROM app.search_projection WHERE project_id=${projectId} AND entity_type=${entityType} AND entity_id=${entityId}`;
    // Drafts intentionally have no search projection until publication.
    if (row)
      await this.writer.upsert(tx, { ...row, sourceRowVersion: version });
  }
}

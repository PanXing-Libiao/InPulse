import type { TransactionContext } from "../../database/transaction-context.js";
import type { ExternalLinkTargetType } from "@inpulse/api-contract";
export const linkAssociation = {
  PROJECT: { table: "project_external_links", column: "project_id" },
  TASK: { table: "task_external_links", column: "task_id" },
  CHANGE_RECORD: {
    table: "change_record_external_links",
    column: "change_record_id",
  },
} as const;
/** Stable read port owned by ExternalLinks. Caller authorizes the real target. */
export class ExternalLinkQueryPort {
  async urls(
    tx: TransactionContext,
    projectId: number,
    type: string,
    id: number,
  ): Promise<string[]> {
    if (!(type in linkAssociation)) return [];
    const association = linkAssociation[type as ExternalLinkTargetType];
    const rows = await tx.sql<
      { url: string }[]
    >`SELECT l.normalized_url AS url FROM app.external_links l JOIN ${tx.sql("app." + association.table)} a ON a.link_id=l.id AND a.project_id=l.project_id WHERE a.project_id=${projectId} AND ${tx.sql("a." + association.column)}=${id} ORDER BY l.id`;
    return rows.map((row) => row.url);
  }
}

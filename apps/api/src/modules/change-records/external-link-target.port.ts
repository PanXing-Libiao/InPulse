import { Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import type {
  LinkTarget,
  LinkTargetLock,
  LinkTargetQueryPort,
  LinkTargetCommandPort,
} from "../external-links/link-target.port.js";
@Injectable()
export class RecordLinkQueryPort implements LinkTargetQueryPort {
  async find(
    tx: TransactionContext,
    id: number,
    lock?: LinkTargetLock,
  ): Promise<LinkTarget | undefined> {
    const [row] = await tx.sql<
      LinkTarget[]
    >`SELECT id,project_id AS "projectId",module_id AS "moduleId",status AS status,row_version AS "rowVersion",code,title FROM app.change_records WHERE id=${id} ${lock === "update" ? tx.sql`FOR UPDATE` : lock === "share" ? tx.sql`FOR SHARE` : tx.sql``}`;
    return row;
  }
}
@Injectable()
export class RecordLinkCommandPort implements LinkTargetCommandPort {
  async advance(tx: TransactionContext, target: LinkTarget) {
    const rows =
      await tx.sql`UPDATE app.change_records SET row_version=row_version+1,updated_at=GREATEST(clock_timestamp(),updated_at) WHERE id=${target.id} AND project_id=${target.projectId} AND row_version=${target.rowVersion} RETURNING id`;
    return rows.length > 0;
  }
}

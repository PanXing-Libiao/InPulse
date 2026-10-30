import { Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import type {
  LinkTarget,
  LinkTargetLock,
  LinkTargetQueryPort,
  LinkTargetCommandPort,
} from "../external-links/link-target.port.js";
@Injectable()
export class TaskLinkQueryPort implements LinkTargetQueryPort {
  async find(
    tx: TransactionContext,
    id: number,
    lock?: LinkTargetLock,
  ): Promise<LinkTarget | undefined> {
    const [row] = await tx.sql<
      LinkTarget[]
    >`SELECT id,project_id AS "projectId",module_id AS "moduleId",lifecycle_status AS status,row_version AS "rowVersion",code,title FROM app.tasks WHERE id=${id} AND deleted_at IS NULL ${lock === "update" ? tx.sql`FOR UPDATE` : lock === "share" ? tx.sql`FOR SHARE` : tx.sql``}`;
    return row;
  }
}
@Injectable()
export class TaskLinkCommandPort implements LinkTargetCommandPort {
  async advance(tx: TransactionContext, target: LinkTarget) {
    const rows =
      await tx.sql`UPDATE app.tasks SET row_version=row_version+1,updated_at=GREATEST(clock_timestamp(),updated_at) WHERE id=${target.id} AND project_id=${target.projectId} AND row_version=${target.rowVersion} RETURNING id`;
    return rows.length > 0;
  }
}

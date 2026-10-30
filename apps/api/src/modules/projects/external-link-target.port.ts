import { Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import type {
  LinkTarget,
  LinkTargetLock,
  LinkTargetQueryPort,
  LinkTargetCommandPort,
} from "../external-links/link-target.port.js";
@Injectable()
export class ProjectLinkQueryPort implements LinkTargetQueryPort {
  async find(
    tx: TransactionContext,
    id: number,
    lock?: LinkTargetLock,
  ): Promise<LinkTarget | undefined> {
    const [row] = await tx.sql<
      LinkTarget[]
    >`SELECT id,id AS "projectId",NULL::int AS "moduleId",status AS status,row_version AS "rowVersion",code,name AS "title" FROM app.projects WHERE id=${id} ${lock === "update" ? tx.sql`FOR UPDATE` : lock === "share" ? tx.sql`FOR SHARE` : tx.sql``}`;
    return row;
  }
}
@Injectable()
export class ProjectLinkCommandPort implements LinkTargetCommandPort {
  async advance(tx: TransactionContext, target: LinkTarget) {
    const rows =
      await tx.sql`UPDATE app.projects SET row_version=row_version+1,updated_at=GREATEST(clock_timestamp(),updated_at) WHERE id=${target.id} AND id=${target.projectId} AND row_version=${target.rowVersion} RETURNING id`;
    return rows.length > 0;
  }
}

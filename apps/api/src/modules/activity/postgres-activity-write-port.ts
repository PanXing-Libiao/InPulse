import type { TransactionContext } from "../../database/transaction-context.js";
import {
  ActivityWritePort,
  ActivityWriteValidationError,
  validateActivityVisibilityUpdateInput,
  validateActivityWriteInput,
  type ActivityVisibilityUpdateInput,
  type ActivityWriteInput,
} from "./activity.write-port.js";

interface ActivityActorSnapshot {
  readonly id: number;
  readonly name: string;
  readonly loginName: string;
}

/**
 * 显式接收调用方事务的活动投影写适配器。来源审计唯一约束由数据库兜底；
 * 可见性更新只允许向更高版本推进，避免过期事件覆盖最新状态。
 *
 * ADR-087：USER 动态在写入时固化操作人身份快照，后续用户行被删除也不会
 * 影响项目动态的展示名。SYSTEM 动态不读取用户表。
 */
export class PostgresActivityWritePort extends ActivityWritePort {
  async append(
    tx: TransactionContext,
    input: ActivityWriteInput,
  ): Promise<void> {
    validateActivityWriteInput(input);
    const actorSnapshot = await this.loadActorSnapshot(tx, input.actorId);
    await tx.sql`
      INSERT INTO app.activity_projection (
        project_id,
        source_chain_id,
        source_sequence,
        source_entity_type,
        source_entity_id,
        activity_type,
        actor_id,
        actor_snapshot,
        summary,
        metadata,
        visibility_scope,
        source_status,
        source_row_version,
        occurred_at
      )
      VALUES (
        ${input.projectId},
        ${input.sourceChainId},
        ${input.sourceSequence},
        ${input.sourceEntityType},
        ${input.sourceEntityId},
        ${input.activityType},
        ${input.actorId},
        ${actorSnapshot === null ? null : JSON.stringify(actorSnapshot)},
        ${input.summary},
        ${JSON.stringify(input.metadata)},
        ${input.visibilityScope},
        ${input.sourceStatus},
        ${input.sourceRowVersion},
        ${input.occurredAt.toISOString()}
      )
      ON CONFLICT (source_chain_id, source_sequence) DO NOTHING
    `;
  }

  async updateEntityVisibility(
    tx: TransactionContext,
    input: ActivityVisibilityUpdateInput,
  ): Promise<void> {
    validateActivityVisibilityUpdateInput(input);
    await tx.sql`
      UPDATE app.activity_projection
         SET visibility_scope = ${input.visibilityScope},
             source_status = ${input.sourceStatus},
             source_row_version = ${input.sourceRowVersion}
       WHERE project_id = ${input.projectId}
         AND source_entity_type = ${input.sourceEntityType}
         AND source_entity_id = ${input.sourceEntityId}
         AND source_row_version < ${input.sourceRowVersion}
    `;
  }

  private async loadActorSnapshot(
    tx: TransactionContext,
    actorId: number | null,
  ): Promise<ActivityActorSnapshot | null> {
    if (actorId === null) {
      return null;
    }
    const rows = (await tx.sql`
      SELECT id, name, login_name AS "loginName"
        FROM app.users
       WHERE id = ${actorId}
    `) as unknown as readonly ActivityActorSnapshot[];
    const actor = rows[0];
    if (actor === undefined) {
      throw new ActivityWriteValidationError("activity actor does not exist");
    }
    return {
      id: actor.id,
      name: actor.name,
      loginName: actor.loginName,
    };
  }
}

import { Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";

/** ADR-070 单行机器人配置记录；密文列只允许出现在服务端内存与数据库密文中。 */
export interface WecomRobotConfigRecord {
  readonly id: number;
  readonly botId: string;
  readonly secretCiphertext: Buffer;
  readonly secretKeyVersion: number;
  readonly secretHint: string;
  readonly botProfileUrl: string | null;
  readonly updatedByName: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export interface UpsertWecomRobotConfigInput {
  readonly botId: string;
  readonly secretCiphertext: Buffer;
  readonly secretKeyVersion: number;
  readonly secretHint: string;
  readonly botProfileUrl: string | null;
  readonly updatedBy: number;
}

interface ConfigRow {
  readonly id: number;
  readonly botId: string;
  readonly secretCiphertext: Buffer;
  readonly secretKeyVersion: number;
  readonly secretHint: string;
  readonly botProfileUrl: string | null;
  readonly updatedByName: string | null;
  readonly updatedAt: string | Date;
  readonly rowVersion: number;
}

const toRecord = (row: ConfigRow): WecomRobotConfigRecord => ({
  id: row.id,
  botId: row.botId,
  secretCiphertext: row.secretCiphertext,
  secretKeyVersion: row.secretKeyVersion,
  secretHint: row.secretHint,
  botProfileUrl: row.botProfileUrl,
  updatedByName: row.updatedByName ?? "未知",
  updatedAt: new Date(row.updatedAt).toISOString(),
  rowVersion: row.rowVersion,
});

/**
 * ADR-070 单行机器人配置仓储。读路径可选 `forUpdate`（写命令内取显式行锁，
 * 只锁配置行本身）；upsert 每次成功更新都递增 row_version。
 */
@Injectable()
export class WecomRobotConfigRepository {
  async find(
    tx: TransactionContext,
    forUpdate = false,
  ): Promise<WecomRobotConfigRecord | undefined> {
    const [row] = await tx.sql<ConfigRow[]>`
      SELECT c.id,
             c.bot_id AS "botId",
             c.secret_ciphertext AS "secretCiphertext",
             c.secret_key_version AS "secretKeyVersion",
             c.secret_hint AS "secretHint",
             c.bot_profile_url AS "botProfileUrl",
             c.updated_by_snapshot->>'name' AS "updatedByName",
             c.updated_at AS "updatedAt",
             c.row_version AS "rowVersion"
        FROM app.wecom_robot_config c
       WHERE c.id = 1
       ${forUpdate ? tx.sql`FOR UPDATE OF c` : tx.sql``}
    `;
    return row === undefined ? undefined : toRecord(row);
  }

  async upsert(
    tx: TransactionContext,
    input: UpsertWecomRobotConfigInput,
  ): Promise<void> {
    await tx.sql`
      INSERT INTO app.wecom_robot_config (
        id,
        bot_id,
        secret_ciphertext,
        secret_key_version,
        secret_hint,
        bot_profile_url,
        updated_by,
        updated_at,
        row_version
      ) VALUES (
        1,
        ${input.botId},
        ${input.secretCiphertext},
        ${input.secretKeyVersion},
        ${input.secretHint},
        ${input.botProfileUrl},
        ${input.updatedBy},
        now(),
        1
      )
      ON CONFLICT (id) DO UPDATE SET
        bot_id = EXCLUDED.bot_id,
        secret_ciphertext = EXCLUDED.secret_ciphertext,
        secret_key_version = EXCLUDED.secret_key_version,
        secret_hint = EXCLUDED.secret_hint,
        bot_profile_url = EXCLUDED.bot_profile_url,
        updated_by = EXCLUDED.updated_by,
        updated_at = now(),
        row_version = app.wecom_robot_config.row_version + 1
    `;
  }
}

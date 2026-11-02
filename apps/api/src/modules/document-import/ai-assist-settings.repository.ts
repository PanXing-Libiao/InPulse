import { Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";

/** ADR-068 单行配置记录；密文列只允许出现在服务端内存与数据库密文中。 */
export interface AiAssistSettingsRecord {
  readonly id: number;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly summaryModel: string | null;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly apiKeyCiphertext: Buffer;
  readonly apiKeyKeyVersion: number;
  readonly apiKeyHint: string;
  readonly updatedBy: number;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export interface UpsertAiAssistSettingsInput {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly summaryModel: string | null;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly apiKeyCiphertext: Buffer;
  readonly apiKeyKeyVersion: number;
  readonly apiKeyHint: string;
  readonly updatedBy: number;
}

interface SettingsRow {
  readonly id: number;
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly summaryModel: string | null;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly apiKeyCiphertext: Buffer;
  readonly apiKeyKeyVersion: number;
  readonly apiKeyHint: string;
  readonly updatedBy: number;
  readonly updatedAt: string | Date;
  readonly rowVersion: number;
}

const toRecord = (row: SettingsRow): AiAssistSettingsRecord => ({
  ...row,
  updatedAt: new Date(row.updatedAt).toISOString(),
});

/**
 * ADR-068 单行配置仓储。读路径可选 `forUpdate`（写命令内取显式行锁）；
 * upsert 每次成功更新都递增 row_version。
 */
@Injectable()
export class AiAssistSettingsRepository {
  async find(
    tx: TransactionContext,
    forUpdate = false,
  ): Promise<AiAssistSettingsRecord | undefined> {
    const [row] = await tx.sql<SettingsRow[]>`
      SELECT id,
             enabled,
             endpoint,
             model,
             summary_model AS "summaryModel",
             timeout_ms AS "timeoutMs",
             max_tokens AS "maxTokens",
             api_key_ciphertext AS "apiKeyCiphertext",
             api_key_key_version AS "apiKeyKeyVersion",
             api_key_hint AS "apiKeyHint",
             updated_by AS "updatedBy",
             updated_at AS "updatedAt",
             row_version AS "rowVersion"
        FROM app.ai_assist_settings
       WHERE id = 1
       ${forUpdate ? tx.sql`FOR UPDATE` : tx.sql``}
    `;
    return row === undefined ? undefined : toRecord(row);
  }

  async upsert(
    tx: TransactionContext,
    input: UpsertAiAssistSettingsInput,
  ): Promise<AiAssistSettingsRecord> {
    const [row] = await tx.sql<SettingsRow[]>`
      INSERT INTO app.ai_assist_settings (
        id,
        enabled,
        endpoint,
        model,
        summary_model,
        timeout_ms,
        max_tokens,
        api_key_ciphertext,
        api_key_key_version,
        api_key_hint,
        updated_by,
        updated_at,
        row_version
      ) VALUES (
        1,
        ${input.enabled},
        ${input.endpoint},
        ${input.model},
        ${input.summaryModel},
        ${input.timeoutMs},
        ${input.maxTokens},
        ${input.apiKeyCiphertext},
        ${input.apiKeyKeyVersion},
        ${input.apiKeyHint},
        ${input.updatedBy},
        now(),
        1
      )
      ON CONFLICT (id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        endpoint = EXCLUDED.endpoint,
        model = EXCLUDED.model,
        summary_model = EXCLUDED.summary_model,
        timeout_ms = EXCLUDED.timeout_ms,
        max_tokens = EXCLUDED.max_tokens,
        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
        api_key_key_version = EXCLUDED.api_key_key_version,
        api_key_hint = EXCLUDED.api_key_hint,
        updated_by = EXCLUDED.updated_by,
        updated_at = now(),
        row_version = app.ai_assist_settings.row_version + 1
      RETURNING id,
                enabled,
                endpoint,
                model,
                summary_model AS "summaryModel",
                timeout_ms AS "timeoutMs",
                max_tokens AS "maxTokens",
                api_key_ciphertext AS "apiKeyCiphertext",
                api_key_key_version AS "apiKeyKeyVersion",
                api_key_hint AS "apiKeyHint",
                updated_by AS "updatedBy",
                updated_at AS "updatedAt",
                row_version AS "rowVersion"
    `;
    if (row === undefined) {
      throw new Error("ai_assist_settings upsert returned no row");
    }
    return toRecord(row);
  }
}

import type { Sql } from "postgres";

import type { TimeCursorValue } from "../../cursors/time-cursor.js";
import type { TransactionContext } from "../../database/transaction-context.js";

export interface NotificationItem {
  readonly id: string;
  readonly projectId: number | null;
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly targetPath: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationReadInput {
  readonly recipientId: number;
  readonly unreadOnly: boolean;
  readonly limit: number;
  readonly after: TimeCursorValue | null;
  readonly hiddenRules?: readonly string[];
}

export class NotificationNotFoundError extends Error {
  readonly code = "NOTIFICATION_NOT_FOUND" as const;

  constructor() {
    super("notification does not exist or does not belong to the current user");
    this.name = "NotificationNotFoundError";
  }
}

export class NotificationStateService {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async read(input: NotificationReadInput): Promise<{
    readonly items: readonly NotificationItem[];
    readonly last: TimeCursorValue | null;
  }> {
    const rows = await this.#sql.unsafe<NotificationRow[]>(
      `SELECT
         id::text,
         project_id,
         notification_type,
         title,
         body,
         target_path,
         to_char(created_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         to_char(read_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at
       FROM app.notifications
      WHERE recipient_id = $1
        AND ($2::boolean IS FALSE OR read_at IS NULL)
        AND (
          $3::timestamptz IS NULL
          OR created_at < $3::timestamptz
          OR (created_at = $3::timestamptz AND id < $4::bigint)
        )
        AND (
          project_id IS NULL
          OR NOT (
            project_id::text || '|' || notification_type
              = ANY ($6::text[])
          )
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
      [
        input.recipientId,
        input.unreadOnly,
        input.after?.at ?? null,
        input.after?.id ?? "0",
        input.limit + 1,
        input.hiddenRules ?? [],
      ],
    );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        notificationType: row.notification_type,
        title: row.title,
        body: row.body,
        targetPath: row.target_path,
        createdAt: row.created_at,
        readAt: row.read_at,
      })),
      last:
        last === undefined || !hasMore
          ? null
          : { at: last.created_at, id: last.id },
    };
  }

  async countUnread(
    recipientId: number,
    hiddenRules: readonly string[] = [],
  ): Promise<number> {
    const rows = (await this.#sql.unsafe<{ count: number }[]>(
      `SELECT count(*)::INTEGER AS count
         FROM app.notifications
        WHERE recipient_id = $1
          AND read_at IS NULL
          AND (
            project_id IS NULL
            OR NOT (
              project_id::text || '|' || notification_type
                = ANY ($2::text[])
            )
          )`,
      [recipientId, hiddenRules],
    )) as unknown as readonly { count: number }[];
    return rows[0]?.count ?? 0;
  }

  async markRead(
    tx: TransactionContext,
    input: { readonly recipientId: number; readonly notificationId: number },
  ): Promise<void> {
    const rows = (await tx.sql`
      UPDATE app.notifications
         SET read_at = COALESCE(read_at, now())
       WHERE id = ${input.notificationId}
         AND recipient_id = ${input.recipientId}
      RETURNING id
    `) as unknown as readonly { id: string }[];
    if (rows.length === 0) {
      throw new NotificationNotFoundError();
    }
  }

  async markUnread(
    tx: TransactionContext,
    input: { readonly recipientId: number; readonly notificationId: number },
  ): Promise<void> {
    const rows = (await tx.sql`
      UPDATE app.notifications
         SET read_at = NULL
       WHERE id = ${input.notificationId}
         AND recipient_id = ${input.recipientId}
      RETURNING id
    `) as unknown as readonly { id: string }[];
    if (rows.length === 0) {
      throw new NotificationNotFoundError();
    }
  }

  async readAll(tx: TransactionContext, recipientId: number): Promise<void> {
    await tx.sql`
      UPDATE app.notifications
         SET read_at = COALESCE(read_at, now())
       WHERE recipient_id = ${recipientId}
    `;
  }

  async assertOwned(
    tx: TransactionContext,
    recipientId: number,
    notificationId: number,
  ): Promise<void> {
    const rows = (await tx.sql`
      SELECT id
        FROM app.notifications
       WHERE id = ${notificationId}
         AND recipient_id = ${recipientId}
       LIMIT 1
    `) as unknown as readonly { id: string }[];
    if (rows.length === 0) {
      throw new NotificationNotFoundError();
    }
  }
}

interface NotificationRow {
  readonly id: string;
  readonly project_id: number | null;
  readonly notification_type: string;
  readonly title: string;
  readonly body: string;
  readonly target_path: string | null;
  readonly created_at: string;
  readonly read_at: string | null;
}

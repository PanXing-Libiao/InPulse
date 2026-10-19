import type { TransactionContext } from "../database/transaction-context.js";

/**
 * Session 认证状态。ADR-031 移除 TOTP 后只存在完整认证态；数据库
 * `auth_state` 仍保留历史取值，查询按 AUTHENTICATED 过滤直到 contract 迁移。
 */
export type UserAuthState = "AUTHENTICATED";

export interface ValidUserSession {
  readonly id: number;
  readonly userId: number;
  readonly authVersionAtIssue: number;
  readonly authState: UserAuthState;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface UserSessionInsert {
  readonly userId: number;
  readonly tokenHash: Buffer;
  readonly tokenHashKeyVersion: number;
  readonly authVersionAtIssue: number;
  readonly authState: UserAuthState;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface CreatedUserSession {
  readonly id: number;
  readonly authState: UserAuthState;
}

export interface UserSessionRepository {
  create(
    tx: TransactionContext,
    insert: UserSessionInsert,
  ): Promise<CreatedUserSession>;
  findValidByTokenHashes(
    tx: TransactionContext,
    tokenHashes: readonly Buffer[],
  ): Promise<ValidUserSession | undefined>;
  findValidUnlockedByTokenHashes(
    tx: TransactionContext,
    tokenHashes: readonly Buffer[],
  ): Promise<ValidUserSession | undefined>;
  lockById(
    tx: TransactionContext,
    sessionId: number,
  ): Promise<ValidUserSession | undefined>;
  revoke(tx: TransactionContext, sessionId: number): Promise<boolean>;
  revokeAllForUser(tx: TransactionContext, userId: number): Promise<number>;
}

/**
 * 查询仍有效的用户 Session，并实时校验用户启用状态与
 * `auth_version_at_issue = users.auth_version`；停用、撤销、过期、
 * 改密后的 Session 都按无效处理。
 */
export class PostgresUserSessionRepository implements UserSessionRepository {
  async create(
    tx: TransactionContext,
    insert: UserSessionInsert,
  ): Promise<CreatedUserSession> {
    const rows = (await tx.sql`
      INSERT INTO app.user_sessions (
        user_id,
        token_hash,
        token_hash_key_version,
        auth_version_at_issue,
        auth_state,
        recovery_rotation_generation,
        recovery_rotation_consumed_generation,
        created_at,
        last_seen_at,
        idle_expires_at,
        absolute_expires_at
      )
      VALUES (
        ${insert.userId},
        ${insert.tokenHash},
        ${insert.tokenHashKeyVersion},
        ${insert.authVersionAtIssue},
        ${insert.authState},
        0,
        0,
        now(),
        now(),
        ${insert.idleExpiresAt.toISOString()},
        ${insert.absoluteExpiresAt.toISOString()}
      )
      RETURNING id, auth_state AS "authState"
    `) as unknown as readonly CreatedUserSession[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("user session insert returned no row");
    }
    return { ...row };
  }

  async findValidByTokenHashes(
    tx: TransactionContext,
    tokenHashes: readonly Buffer[],
  ): Promise<ValidUserSession | undefined> {
    if (tokenHashes.length === 0) {
      return undefined;
    }
    const rows = (await tx.sql`
      SELECT us.id,
             us.user_id AS "userId",
             us.auth_version_at_issue AS "authVersionAtIssue",
             us.auth_state AS "authState",
             us.idle_expires_at AS "idleExpiresAt",
             us.absolute_expires_at AS "absoluteExpiresAt"
        FROM app.user_sessions AS us
        JOIN app.users AS u ON u.id = us.user_id
       WHERE us.token_hash IN ${tx.sql(tokenHashes)}
         AND us.revoked_at IS NULL
         AND u.disabled_at IS NULL
         AND u.status = 'ACTIVE'
         AND u.auth_version = us.auth_version_at_issue
         AND us.idle_expires_at > now()
         AND us.absolute_expires_at > now()
         AND us.auth_state = 'AUTHENTICATED'
       ORDER BY us.id
       LIMIT 1
       FOR UPDATE OF us
    `) as unknown as readonly (Omit<
      ValidUserSession,
      "idleExpiresAt" | "absoluteExpiresAt"
    > & {
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    })[];
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          ...row,
          idleExpiresAt: new Date(row.idleExpiresAt),
          absoluteExpiresAt: new Date(row.absoluteExpiresAt),
        };
  }

  async findValidUnlockedByTokenHashes(
    tx: TransactionContext,
    tokenHashes: readonly Buffer[],
  ): Promise<ValidUserSession | undefined> {
    if (tokenHashes.length === 0) {
      return undefined;
    }
    const rows = (await tx.sql`
      SELECT us.id,
             us.user_id AS "userId",
             us.auth_version_at_issue AS "authVersionAtIssue",
             us.auth_state AS "authState",
             us.idle_expires_at AS "idleExpiresAt",
             us.absolute_expires_at AS "absoluteExpiresAt"
        FROM app.user_sessions AS us
        JOIN app.users AS u ON u.id = us.user_id
       WHERE us.token_hash IN ${tx.sql(tokenHashes)}
         AND us.revoked_at IS NULL
         AND u.disabled_at IS NULL
         AND u.status = 'ACTIVE'
         AND u.auth_version = us.auth_version_at_issue
         AND us.idle_expires_at > now()
         AND us.absolute_expires_at > now()
         AND us.auth_state = 'AUTHENTICATED'
       ORDER BY us.id
       LIMIT 1
    `) as unknown as readonly (Omit<
      ValidUserSession,
      "idleExpiresAt" | "absoluteExpiresAt"
    > & {
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    })[];
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          ...row,
          idleExpiresAt: new Date(row.idleExpiresAt),
          absoluteExpiresAt: new Date(row.absoluteExpiresAt),
        };
  }

  async lockById(
    tx: TransactionContext,
    sessionId: number,
  ): Promise<ValidUserSession | undefined> {
    const rows = (await tx.sql`
      SELECT us.id,
             us.user_id AS "userId",
             us.auth_version_at_issue AS "authVersionAtIssue",
             us.auth_state AS "authState",
             us.idle_expires_at AS "idleExpiresAt",
             us.absolute_expires_at AS "absoluteExpiresAt"
        FROM app.user_sessions AS us
        JOIN app.users AS u ON u.id = us.user_id
       WHERE us.id = ${sessionId}
         AND us.revoked_at IS NULL
         AND u.disabled_at IS NULL
         AND u.status = 'ACTIVE'
         AND u.auth_version = us.auth_version_at_issue
         AND us.idle_expires_at > now()
         AND us.absolute_expires_at > now()
         AND us.auth_state = 'AUTHENTICATED'
       FOR UPDATE OF us
    `) as unknown as readonly (Omit<
      ValidUserSession,
      "idleExpiresAt" | "absoluteExpiresAt"
    > & {
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    })[];
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          ...row,
          idleExpiresAt: new Date(row.idleExpiresAt),
          absoluteExpiresAt: new Date(row.absoluteExpiresAt),
        };
  }

  async revoke(tx: TransactionContext, sessionId: number): Promise<boolean> {
    const rows = (await tx.sql`
      UPDATE app.user_sessions
         SET revoked_at = now()
       WHERE id = ${sessionId}
         AND revoked_at IS NULL
      RETURNING id
    `) as unknown as readonly { id: number }[];
    return rows.length > 0;
  }

  async revokeAllForUser(
    tx: TransactionContext,
    userId: number,
  ): Promise<number> {
    const rows = (await tx.sql`
      UPDATE app.user_sessions
         SET revoked_at = now()
       WHERE user_id = ${userId}
         AND revoked_at IS NULL
      RETURNING id
    `) as unknown as readonly { id: number }[];
    return rows.length;
  }
}

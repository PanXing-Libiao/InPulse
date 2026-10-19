import type { TransactionContext } from "../database/transaction-context.js";

export interface UserCredential {
  readonly id: number;
  readonly loginName: string;
  /** SSO 自动开通的账号没有本地口令，该字段为 NULL 且本地登录必然失败。 */
  readonly passwordHash: string | null;
  readonly isAdmin: boolean;
  readonly status: "ACTIVE" | "DISABLED";
  readonly authVersion: number;
  readonly disabledAt: Date | null;
}

export interface UserSessionIssueSnapshot {
  readonly id: number;
  readonly isAdmin: boolean;
  readonly authVersion: number;
}

export interface UserCredentialRepository {
  findById(
    tx: TransactionContext,
    userId: number,
  ): Promise<UserCredential | undefined>;
  findByNormalizedLoginName(
    tx: TransactionContext,
    loginName: string,
  ): Promise<UserCredential | undefined>;
  lockForSessionIssue(
    tx: TransactionContext,
    userId: number,
    expectedAuthVersion: number,
  ): Promise<UserSessionIssueSnapshot | undefined>;
  incrementAuthVersion(
    tx: TransactionContext,
    userId: number,
  ): Promise<boolean>;
}

/**
 * 用户凭据查询。登录名使用与 `users_login_name_normalized_unique` 一致的
 * `lower(btrim(...))` 语义；最终签发 Session 前按用户行 `FOR SHARE` 重新确认
 * 启用状态与 `auth_version`，防止校验期间停用或改密后签发旧凭据 Session。
 */
export class PostgresUserCredentialRepository implements UserCredentialRepository {
  async findById(
    tx: TransactionContext,
    userId: number,
  ): Promise<UserCredential | undefined> {
    const rows = (await tx.sql`
      SELECT id,
             login_name AS "loginName",
             password_hash AS "passwordHash",
             is_admin AS "isAdmin",
             status,
             auth_version AS "authVersion",
             disabled_at AS "disabledAt"
        FROM app.users
       WHERE id = ${userId}
       LIMIT 1
    `) as unknown as readonly UserCredential[];
    const row = rows[0];
    return row === undefined ? undefined : { ...row };
  }

  async findByNormalizedLoginName(
    tx: TransactionContext,
    loginName: string,
  ): Promise<UserCredential | undefined> {
    const rows = (await tx.sql`
      SELECT id,
             login_name AS "loginName",
             password_hash AS "passwordHash",
             is_admin AS "isAdmin",
             status,
             auth_version AS "authVersion",
             disabled_at AS "disabledAt"
        FROM app.users
       WHERE lower(btrim(login_name)) = lower(btrim(${loginName}))
       LIMIT 1
    `) as unknown as readonly UserCredential[];
    const row = rows[0];
    return row === undefined ? undefined : { ...row };
  }

  async lockForSessionIssue(
    tx: TransactionContext,
    userId: number,
    expectedAuthVersion: number,
  ): Promise<UserSessionIssueSnapshot | undefined> {
    const rows = (await tx.sql`
      SELECT id,
             is_admin AS "isAdmin",
             auth_version AS "authVersion"
        FROM app.users
       WHERE id = ${userId}
         AND status = 'ACTIVE'
         AND disabled_at IS NULL
         AND deleted_at IS NULL
         AND auth_version = ${expectedAuthVersion}
       FOR SHARE
    `) as unknown as readonly UserSessionIssueSnapshot[];
    const row = rows[0];
    return row === undefined ? undefined : { ...row };
  }

  async incrementAuthVersion(
    tx: TransactionContext,
    userId: number,
  ): Promise<boolean> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET auth_version = auth_version + 1,
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${userId}
         AND deleted_at IS NULL
      RETURNING id
    `) as unknown as readonly { id: number }[];
    return rows.length > 0;
  }
}

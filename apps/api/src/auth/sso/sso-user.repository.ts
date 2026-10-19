import type { TransactionContext } from "../../database/transaction-context.js";

/** SSO 用户映射读取的字段集合；不包含任何 Credential 或 Session 材料。 */
export interface SsoUserRecord {
  readonly id: number;
  readonly loginName: string;
  readonly name: string;
  readonly email: string | null;
  readonly ssoSubject: string | null;
  readonly status: "ACTIVE" | "DISABLED";
  readonly isAdmin: boolean;
  readonly authVersion: number;
  readonly disabledAt: Date | null;
  readonly deletedAt: Date | null;
}

/** 本次登录与本地账号的匹配结果分类，用于审计与测试断言。 */
export type SsoIdentityOutcome = "subject" | "linked" | "provisioned";

export type SsoIdentityMapping =
  | {
      readonly kind: "mapped";
      readonly user: SsoUserRecord;
      readonly outcome: SsoIdentityOutcome;
    }
  | { readonly kind: "conflict"; readonly reason: SsoIdentityConflict };

export type SsoIdentityConflict =
  | "email-mismatch"
  | "email-taken"
  | "subject-bound-to-other-account"
  | "concurrent-bind";

/** 只保留业务需要的 claim；Casdoor 的 isAdmin 等其余字段不得进入本结构。 */
export interface SsoIdentityClaims {
  readonly subject: string;
  readonly loginName: string;
  readonly displayName: string;
  readonly email: string | null;
}

interface SsoUserRow {
  readonly id: number;
  readonly loginName: string;
  readonly name: string;
  readonly email: string | null;
  readonly ssoSubject: string | null;
  readonly status: "ACTIVE" | "DISABLED";
  readonly isAdmin: boolean;
  readonly authVersion: number;
  readonly disabledAt: string | null;
  readonly deletedAt: string | null;
}

function toRecord(row: SsoUserRow): SsoUserRecord {
  return {
    ...row,
    disabledAt: row.disabledAt === null ? null : new Date(row.disabledAt),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt),
  };
}

function normalize(value: string | null): string | undefined {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 「平台没有任何账号」判定窗口的事务级 advisory lock 两段式键（0x496E506C 即 "InPl"）。 */
const FIRST_ACCOUNT_ADMIN_LOCK_CLASS = 0x496e506c;
const FIRST_ACCOUNT_ADMIN_LOCK_KEY = 1;

/**
 * SSO 用户映射与 JIT 开通（ADR-032；首个账号的管理员授予由 ADR-075 修订）。查找顺序固定为：
 * sso_subject 命中 -> 登录名命中且未绑定且邮箱一致时自动绑定 -> 自动开通；
 * 邮箱不一致或 subject 已绑定其他账号时一律拒绝，防止同名或换绑接管账号。
 * 所有写入都在调用方事务内完成，数据库唯一索引是最终防线。
 */
export class PostgresSsoUserRepository {
  async mapIdentity(
    tx: TransactionContext,
    claims: SsoIdentityClaims,
  ): Promise<SsoIdentityMapping> {
    const bySubject = await this.findBySubject(tx, claims.subject);
    if (bySubject !== undefined) {
      // 墓碑账号不可再写资料；登录编排会按 DISABLED 干净拒绝，不能先 syncProfile
      // 触发 users 不可变触发器并误报 500。
      if (bySubject.deletedAt !== null) {
        return { kind: "mapped", user: bySubject, outcome: "subject" };
      }
      const synced = await this.syncProfile(tx, bySubject, claims);
      return { kind: "mapped", user: synced, outcome: "subject" };
    }

    const byLoginName = await this.lockByLoginName(tx, claims.loginName);
    if (byLoginName !== undefined) {
      if (byLoginName.ssoSubject === claims.subject) {
        return { kind: "mapped", user: byLoginName, outcome: "subject" };
      }
      if (byLoginName.ssoSubject !== null) {
        return {
          kind: "conflict",
          reason: "subject-bound-to-other-account",
        };
      }
      const claimEmail = normalize(claims.email);
      if (
        claimEmail === undefined ||
        claimEmail !== normalize(byLoginName.email)
      ) {
        return { kind: "conflict", reason: "email-mismatch" };
      }
      const bound = await this.bindSubject(tx, byLoginName.id, claims);
      if (bound === undefined) {
        return { kind: "conflict", reason: "concurrent-bind" };
      }
      return { kind: "mapped", user: bound, outcome: "linked" };
    }

    const email = normalize(claims.email);
    if (email !== undefined) {
      const owner = await this.emailOwnerId(tx, email);
      if (owner !== undefined) {
        return { kind: "conflict", reason: "email-taken" };
      }
    }
    const created = await this.provision(tx, claims);
    return { kind: "mapped", user: created, outcome: "provisioned" };
  }

  private async findBySubject(
    tx: TransactionContext,
    subject: string,
  ): Promise<SsoUserRecord | undefined> {
    const rows = (await tx.sql`
      SELECT id,
             login_name AS "loginName",
             name,
             email,
             sso_subject AS "ssoSubject",
             status,
             is_admin AS "isAdmin",
             auth_version AS "authVersion",
             disabled_at AS "disabledAt",
                deleted_at AS "deletedAt"
        FROM app.users
       WHERE sso_subject = ${subject}
       LIMIT 1
       FOR UPDATE
    `) as unknown as readonly SsoUserRow[];
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  private async lockByLoginName(
    tx: TransactionContext,
    loginName: string,
  ): Promise<SsoUserRecord | undefined> {
    const rows = (await tx.sql`
      SELECT id,
             login_name AS "loginName",
             name,
             email,
             sso_subject AS "ssoSubject",
             status,
             is_admin AS "isAdmin",
             auth_version AS "authVersion",
             disabled_at AS "disabledAt",
                deleted_at AS "deletedAt"
        FROM app.users
       WHERE lower(btrim(login_name)) = lower(btrim(${loginName}))
       FOR UPDATE
    `) as unknown as readonly SsoUserRow[];
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  private async emailOwnerId(
    tx: TransactionContext,
    email: string,
  ): Promise<number | undefined> {
    const rows = (await tx.sql`
      SELECT id
        FROM app.users
       WHERE lower(btrim(email)) = lower(btrim(${email}))
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    return rows[0]?.id;
  }

  private async bindSubject(
    tx: TransactionContext,
    userId: number,
    claims: SsoIdentityClaims,
  ): Promise<SsoUserRecord | undefined> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET sso_subject = ${claims.subject},
             name = ${claims.displayName},
             email = ${claims.email},
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${userId}
         AND sso_subject IS NULL
         AND deleted_at IS NULL
      RETURNING id,
                login_name AS "loginName",
                name,
                email,
                sso_subject AS "ssoSubject",
                status,
                is_admin AS "isAdmin",
                auth_version AS "authVersion",
                disabled_at AS "disabledAt",
                deleted_at AS "deletedAt"
    `) as unknown as readonly SsoUserRow[];
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  private async provision(
    tx: TransactionContext,
    claims: SsoIdentityClaims,
  ): Promise<SsoUserRecord> {
    // ADR-075：先用事务级 advisory lock 串行化「空库判定 -> 开通」窗口：
    // 并发首登只有先提交的事务能成为管理员，后到者在锁释放后重新判定。
    await tx.sql`
      SELECT pg_advisory_xact_lock(
        ${FIRST_ACCOUNT_ADMIN_LOCK_CLASS}::int4,
        ${FIRST_ACCOUNT_ADMIN_LOCK_KEY}::int4
      )
    `;
    const emptiness = (await tx.sql`
      SELECT NOT EXISTS (SELECT 1 FROM app.users) AS "firstAccount"
    `) as unknown as readonly { readonly firstAccount: boolean }[];
    const isFirstAccount = emptiness[0]?.firstAccount === true;
    const rows = (await tx.sql`
      INSERT INTO app.users (
        login_name,
        name,
        email,
        sso_subject,
        password_hash,
        is_admin,
        status
      )
      VALUES (
        ${claims.loginName},
        ${claims.displayName},
        ${claims.email},
        ${claims.subject},
        NULL,
        ${isFirstAccount},
        'ACTIVE'
      )
      RETURNING id,
                login_name AS "loginName",
                name,
                email,
                sso_subject AS "ssoSubject",
                status,
                is_admin AS "isAdmin",
                auth_version AS "authVersion",
                disabled_at AS "disabledAt",
                deleted_at AS "deletedAt"
    `) as unknown as readonly SsoUserRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("sso user insert returned no row");
    }
    return toRecord(row);
  }

  /**
   * 每次登录同步展示字段：`name` 始终跟随 DisplayName；`email` 只在 claim 提供
   * 且未被其他账号占用时更新。全部字段一致时不写库，避免无意义的版本递增。
   */
  private async syncProfile(
    tx: TransactionContext,
    current: SsoUserRecord,
    claims: SsoIdentityClaims,
  ): Promise<SsoUserRecord> {
    let email = current.email;
    const claimEmail = claims.email;
    if (claimEmail !== null && claimEmail !== current.email) {
      const owner = await this.emailOwnerId(tx, claimEmail);
      if (owner === undefined || owner === current.id) {
        email = claimEmail;
      }
    }
    const profileChanged =
      claims.displayName !== current.name || email !== current.email;
    if (!profileChanged) {
      return current;
    }
    const rows = (await tx.sql`
      UPDATE app.users
         SET name = ${claims.displayName},
             email = ${email},
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${current.id}
         AND deleted_at IS NULL
      RETURNING id,
                login_name AS "loginName",
                name,
                email,
                sso_subject AS "ssoSubject",
                status,
                is_admin AS "isAdmin",
                auth_version AS "authVersion",
                disabled_at AS "disabledAt",
                deleted_at AS "deletedAt"
    `) as unknown as readonly SsoUserRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("sso user profile sync returned no row");
    }
    return toRecord(row);
  }
}

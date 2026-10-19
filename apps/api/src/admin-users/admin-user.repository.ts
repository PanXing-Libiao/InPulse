import type {
  AdminUserCreateRequest,
  AdminUserItem,
  AdminUserUpdateRequest,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";

type AdminUserRow = Omit<
  AdminUserItem,
  "disabledAt" | "deletedAt" | "createdAt" | "updatedAt"
> & {
  disabledAt: Date | string | null;
  deletedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const dto = (row: AdminUserRow): AdminUserItem => ({
  ...row,
  disabledAt:
    row.disabledAt === null ? null : new Date(row.disabledAt).toISOString(),
  deletedAt:
    row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

/** F-03 用户管理 PostgreSQL 仓储；只处理持久化，不判断业务流转。 */
export class AdminUserRepository {
  async list(tx: TransactionContext): Promise<AdminUserItem[]> {
    const rows = (await tx.sql`
      SELECT id,
             login_name AS "loginName",
             name,
             email,
             avatar_url AS "avatarUrl",
             is_admin AS "isAdmin",
             organization_id AS "organizationId",
             status,
             row_version AS "rowVersion",
             disabled_at AS "disabledAt",
                deleted_at AS "deletedAt",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
        FROM app.users
       WHERE deleted_at IS NULL
       ORDER BY id DESC
       LIMIT 1000
    `) as unknown as readonly AdminUserRow[];
    return rows.map(dto);
  }

  async find(
    tx: TransactionContext,
    userId: number,
    lock = false,
  ): Promise<AdminUserItem | undefined> {
    const rows = lock
      ? await tx.sql<AdminUserRow[]>`
          SELECT id,
                 login_name AS "loginName",
                 name,
                 email,
                 avatar_url AS "avatarUrl",
                 is_admin AS "isAdmin",
                 organization_id AS "organizationId",
                 status,
                 row_version AS "rowVersion",
                 disabled_at AS "disabledAt",
                deleted_at AS "deletedAt",
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"
            FROM app.users
           WHERE id = ${userId}
           FOR UPDATE
           LIMIT 1
        `
      : await tx.sql<AdminUserRow[]>`
          SELECT id,
                 login_name AS "loginName",
                 name,
                 email,
                 avatar_url AS "avatarUrl",
                 is_admin AS "isAdmin",
                 organization_id AS "organizationId",
                 status,
                 row_version AS "rowVersion",
                 disabled_at AS "disabledAt",
                deleted_at AS "deletedAt",
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"
            FROM app.users
           WHERE id = ${userId}
           LIMIT 1
        `;
    const row = rows[0];
    return row === undefined ? undefined : dto(row);
  }

  async create(
    tx: TransactionContext,
    input: AdminUserCreateRequest,
    passwordHash: string,
  ): Promise<AdminUserItem> {
    const rows = (await tx.sql`
      INSERT INTO app.users (
        login_name,
        name,
        email,
        avatar_url,
        password_hash,
        is_admin
      )
      VALUES (
        ${input.loginName},
        ${input.name},
        ${input.email ?? null},
        ${input.avatarUrl ?? null},
        ${passwordHash},
        ${input.isAdmin}
      )
      RETURNING id
    `) as unknown as readonly { id: number }[];
    const created = await this.find(tx, rows[0]!.id);
    if (created === undefined) {
      throw new Error("created user row could not be reloaded");
    }
    return created;
  }

  async update(
    tx: TransactionContext,
    current: AdminUserItem,
    input: AdminUserUpdateRequest,
  ): Promise<AdminUserItem | undefined> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET name = ${input.name ?? current.name},
             email = ${input.email === undefined ? current.email : input.email},
             avatar_url = ${
               input.avatarUrl === undefined
                 ? current.avatarUrl
                 : input.avatarUrl
             },
             is_admin = ${input.isAdmin ?? current.isAdmin},
             updated_at = now(),
             row_version = row_version + 1
       WHERE id = ${current.id}
         AND deleted_at IS NULL
         AND row_version = ${current.rowVersion}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (rows.length === 0) {
      return undefined;
    }
    return this.find(tx, current.id);
  }

  async disable(
    tx: TransactionContext,
    current: AdminUserItem,
  ): Promise<AdminUserItem | undefined> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET status = 'DISABLED',
             disabled_at = now(),
             auth_version = auth_version + 1,
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${current.id}
         AND deleted_at IS NULL
         AND row_version = ${current.rowVersion}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (rows.length === 0) {
      return undefined;
    }
    return this.find(tx, current.id);
  }

  async enable(
    tx: TransactionContext,
    current: AdminUserItem,
  ): Promise<AdminUserItem | undefined> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET status = 'ACTIVE',
             disabled_at = NULL,
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${current.id}
         AND deleted_at IS NULL
         AND row_version = ${current.rowVersion}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (rows.length === 0) {
      return undefined;
    }
    return this.find(tx, current.id);
  }

  async forceLogout(
    tx: TransactionContext,
    current: AdminUserItem,
  ): Promise<AdminUserItem | undefined> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET auth_version = auth_version + 1,
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${current.id}
         AND deleted_at IS NULL
         AND row_version = ${current.rowVersion}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (rows.length === 0) {
      return undefined;
    }
    return this.find(tx, current.id);
  }

  /**
   * 不可逆墓碑化：清除登录名、个人资料、口令、组织与管理员身份，保留主键。
   * 只有服务层校验完停用态、版本与活跃项目关系后才可调用。
   */
  async delete(
    tx: TransactionContext,
    current: AdminUserItem,
  ): Promise<AdminUserItem | undefined> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET login_name = 'deleted-user-' || id::text,
             name = '删除用户',
             email = NULL,
             avatar_url = NULL,
             password_hash = NULL,
             organization_id = NULL,
             is_admin = false,
             status = 'DISABLED',
             disabled_at = COALESCE(disabled_at, now()),
             auth_version = auth_version + 1,
             deleted_at = now(),
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ${current.id}
         AND deleted_at IS NULL
         AND row_version = ${current.rowVersion}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (rows.length === 0) {
      return undefined;
    }
    return this.find(tx, current.id);
  }

  /**
   * 锁定并返回全部可用管理员（ACTIVE 且未停用）。ADR-031 之后管理员身份
   * 只按 `users.is_admin` 判定，不再要求已注册 TOTP；调用方据此保证不会
   * 移除或停用最后一名管理员。
   */
  async activeAdminIds(tx: TransactionContext): Promise<readonly number[]> {
    const rows = (await tx.sql`
      SELECT u.id
        FROM app.users AS u
       WHERE u.is_admin = true
         AND u.status = 'ACTIVE'
         AND u.disabled_at IS NULL
         AND u.deleted_at IS NULL
       ORDER BY u.id
       FOR UPDATE OF u
    `) as unknown as readonly { id: number }[];
    return rows.map((row) => row.id);
  }
}

import type {
  MyOrganizationMemberItem,
  OrganizationItem,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";

type OrganizationRow = {
  readonly id: number;
  readonly name: string;
  readonly rowVersion: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

const dto = (row: OrganizationRow): OrganizationItem => ({
  id: row.id,
  name: row.name,
  rowVersion: row.rowVersion,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

/** 同组织成员列表上限；与用户目录的 300 条口径一致。 */
export const ORGANIZATION_MEMBER_LIMIT = 300;

/**
 * ADR-081 组织 PostgreSQL 仓储；只处理持久化，不决定业务状态流转。
 * 组织行为配置维度：读路径无锁，写路径由 Service 显式取行锁。
 */
export class OrganizationRepository {
  async list(tx: TransactionContext): Promise<OrganizationItem[]> {
    const rows = (await tx.sql`
      SELECT id,
             name,
             row_version AS "rowVersion",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
        FROM app.organizations
       ORDER BY id
    `) as unknown as readonly OrganizationRow[];
    return rows.map(dto);
  }

  async find(
    tx: TransactionContext,
    organizationId: number,
    lock = false,
  ): Promise<OrganizationItem | undefined> {
    const rows = lock
      ? await tx.sql<OrganizationRow[]>`
          SELECT id,
                 name,
                 row_version AS "rowVersion",
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"
            FROM app.organizations
           WHERE id = ${organizationId}
           FOR UPDATE
           LIMIT 1
        `
      : await tx.sql<OrganizationRow[]>`
          SELECT id,
                 name,
                 row_version AS "rowVersion",
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"
            FROM app.organizations
           WHERE id = ${organizationId}
           LIMIT 1
        `;
    const row = rows[0];
    return row === undefined ? undefined : dto(row);
  }

  async create(
    tx: TransactionContext,
    name: string,
  ): Promise<OrganizationItem> {
    const rows = (await tx.sql`
      INSERT INTO app.organizations (name)
      VALUES (${name})
      RETURNING id
    `) as unknown as readonly { id: number }[];
    const created = await this.find(tx, rows[0]!.id);
    if (created === undefined) {
      throw new Error("created organization row could not be reloaded");
    }
    return created;
  }

  async updateName(
    tx: TransactionContext,
    current: OrganizationItem,
    name: string,
  ): Promise<OrganizationItem | undefined> {
    const rows = (await tx.sql`
      UPDATE app.organizations
         SET name = ${name},
             updated_at = now(),
             row_version = row_version + 1
       WHERE id = ${current.id}
         AND row_version = ${current.rowVersion}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    if (rows.length === 0) {
      return undefined;
    }
    return this.find(tx, current.id);
  }

  async remove(
    tx: TransactionContext,
    current: OrganizationItem,
  ): Promise<void> {
    await tx.sql`
      DELETE FROM app.organizations
       WHERE id = ${current.id}
    `;
  }

  /**
   * 删除组织前显式把成员归属清空并递增行版本：users 的 row_version 触发器
   * 要求每次 UPDATE 都递增版本，数据库级 ON DELETE SET NULL 无法满足该
   * 不变量，因此删除路径必须在同一事务内先清空成员再删除组织。
   */
  async clearMembers(
    tx: TransactionContext,
    organizationId: number,
  ): Promise<number> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET organization_id = NULL,
             row_version = row_version + 1,
             updated_at = now()
       WHERE organization_id = ${organizationId}
         AND deleted_at IS NULL
      RETURNING id
    `) as unknown as readonly { id: number }[];
    return rows.length;
  }

  /**
   * 归属切换前对目标组织取共享锁，防止组织被并发删除后仍写入归属；
   * 返回 false 表示组织不存在（422）。
   */
  async lockOrganizationForAssign(
    tx: TransactionContext,
    organizationId: number,
  ): Promise<boolean> {
    const rows = (await tx.sql`
      SELECT id
        FROM app.organizations
       WHERE id = ${organizationId}
       FOR SHARE
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    return rows.length > 0;
  }

  /** 按用户 ID 升序逐个锁定目标行（升序取锁，避免与并发归属切换死锁）。 */
  async lockUsers(
    tx: TransactionContext,
    userIds: readonly number[],
  ): Promise<readonly number[]> {
    const rows = (await tx.sql`
      SELECT id
        FROM app.users
       WHERE id = ANY(${userIds}::integer[])
         AND deleted_at IS NULL
       ORDER BY id
       FOR UPDATE
    `) as unknown as readonly { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * 批量切换组织归属：只更新 organization_id 实际变化的行，
   * 重复调用返回 0，版本不无谓增长。
   */
  async assignUsers(
    tx: TransactionContext,
    userIds: readonly number[],
    organizationId: number | null,
  ): Promise<number> {
    const rows = (await tx.sql`
      UPDATE app.users
         SET organization_id = ${organizationId},
             row_version = row_version + 1,
             updated_at = now()
       WHERE id = ANY(${userIds}::integer[])
         AND deleted_at IS NULL
         AND organization_id IS DISTINCT FROM ${organizationId}
      RETURNING id
    `) as unknown as readonly { id: number }[];
    return rows.length;
  }

  /** 读取成员当前归属；行不存在（理论不可达）返回 null。 */
  async findUserOrganizationId(
    tx: TransactionContext,
    userId: number,
  ): Promise<number | null> {
    const rows = (await tx.sql`
      SELECT organization_id AS "organizationId"
        FROM app.users
       WHERE id = ${userId}
       LIMIT 1
    `) as unknown as readonly { organizationId: number | null }[];
    return rows[0]?.organizationId ?? null;
  }

  /** 同组织 ACTIVE 成员脱敏列表；不返回登录名、邮箱、停用状态。 */
  async listActiveMembers(
    tx: TransactionContext,
    organizationId: number,
  ): Promise<MyOrganizationMemberItem[]> {
    const rows = (await tx.sql`
      SELECT id,
             name,
             avatar_url AS "avatarUrl",
             is_admin AS "isAdmin"
        FROM app.users
       WHERE organization_id = ${organizationId}
         AND status = 'ACTIVE'
         AND disabled_at IS NULL
       ORDER BY id DESC, name ASC
       LIMIT ${ORGANIZATION_MEMBER_LIMIT}
    `) as unknown as readonly MyOrganizationMemberItem[];
    return rows.map((row) => ({ ...row }));
  }
}

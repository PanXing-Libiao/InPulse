import type {
  MyOrganizationMemberItem,
  OrganizationItem,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";

type OrganizationSource = "LOCAL" | "CASDOOR";

type OrganizationRow = {
  readonly id: number;
  readonly name: string;
  readonly source: OrganizationSource;
  readonly groupPath: string | null;
  readonly parentId: number | null;
  readonly rowVersion: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

export interface AssignableUserRow {
  readonly id: number;
  readonly managedBySso: boolean;
}

export const ORGANIZATION_MEMBER_LIMIT = 300;

const dto = (row: OrganizationRow): OrganizationItem => ({
  id: row.id,
  name: row.name,
  source: row.source,
  groupPath: row.groupPath,
  parentId: row.parentId,
  rowVersion: row.rowVersion,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

/** ADR-097 组织 PostgreSQL 仓储；LOCAL 可管理，CASDOOR 由 SSO 同步。 */
export class OrganizationRepository {
  async list(tx: TransactionContext): Promise<OrganizationItem[]> {
    const rows = (await tx.sql`
      SELECT id,
             name,
             source,
             sso_group_path AS "groupPath",
             parent_id AS "parentId",
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
                 source,
                 sso_group_path AS "groupPath",
                 parent_id AS "parentId",
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
                 source,
                 sso_group_path AS "groupPath",
                 parent_id AS "parentId",
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

  async listForUser(
    tx: TransactionContext,
    userId: number,
  ): Promise<OrganizationItem[]> {
    const rows = (await tx.sql`
      SELECT o.id,
             o.name,
             o.source,
             o.sso_group_path AS "groupPath",
             o.parent_id AS "parentId",
             o.row_version AS "rowVersion",
             o.created_at AS "createdAt",
             o.updated_at AS "updatedAt"
        FROM app.user_organizations AS uo
        JOIN app.organizations AS o ON o.id = uo.organization_id
       WHERE uo.user_id = ${userId}
       ORDER BY o.id
    `) as unknown as readonly OrganizationRow[];
    return rows.map(dto);
  }

  async createLocal(
    tx: TransactionContext,
    name: string,
  ): Promise<OrganizationItem> {
    const rows = (await tx.sql`
      INSERT INTO app.organizations (name, source)
      VALUES (${name}, 'LOCAL')
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
         AND source = 'LOCAL'
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
         AND source = 'LOCAL'
    `;
  }

  async clearMembers(
    tx: TransactionContext,
    organizationId: number,
  ): Promise<number> {
    const rows = (await tx.sql`
      DELETE FROM app.user_organizations
       WHERE organization_id = ${organizationId}
      RETURNING user_id AS "userId"
    `) as unknown as readonly { readonly userId: number }[];
    const userIds = [...new Set(rows.map((row) => row.userId))];
    if (userIds.length === 0) {
      return 0;
    }
    await tx.sql`
      UPDATE app.users
         SET row_version = row_version + 1,
             updated_at = now()
       WHERE id = ANY(${userIds}::integer[])
         AND deleted_at IS NULL
    `;
    return userIds.length;
  }

  async lockUsers(
    tx: TransactionContext,
    userIds: readonly number[],
  ): Promise<readonly AssignableUserRow[]> {
    return (await tx.sql`
      SELECT id,
             sso_subject IS NOT NULL AS "managedBySso"
        FROM app.users
       WHERE id = ANY(${userIds}::integer[])
         AND deleted_at IS NULL
       ORDER BY id
       FOR UPDATE
    `) as unknown as readonly AssignableUserRow[];
  }

  async assignUsers(
    tx: TransactionContext,
    userIds: readonly number[],
    organizationId: number | null,
  ): Promise<number> {
    const current = (await tx.sql`
      SELECT u.id,
             array_remove(
               array_agg(uo.organization_id ORDER BY uo.organization_id),
               NULL
             ) AS "organizationIds"
        FROM app.users AS u
        LEFT JOIN app.user_organizations AS uo ON uo.user_id = u.id
       WHERE u.id = ANY(${userIds}::integer[])
         AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.id
    `) as unknown as readonly {
      readonly id: number;
      readonly organizationIds: readonly (number | null)[];
    }[];
    const changedUserIds = current
      .filter((row) => {
        const ids = row.organizationIds.filter(
          (value): value is number => value !== null,
        );
        return organizationId === null
          ? ids.length > 0
          : ids.length !== 1 || ids[0] !== organizationId;
      })
      .map((row) => row.id);
    if (changedUserIds.length === 0) {
      return 0;
    }

    await tx.sql`
      DELETE FROM app.user_organizations
       WHERE user_id = ANY(${changedUserIds}::integer[])
    `;
    if (organizationId !== null) {
      for (const userId of changedUserIds) {
        await tx.sql`
          INSERT INTO app.user_organizations (user_id, organization_id, source)
          VALUES (${userId}, ${organizationId}, 'MANUAL')
        `;
      }
    }
    await tx.sql`
      UPDATE app.users
         SET row_version = row_version + 1,
             updated_at = now()
       WHERE id = ANY(${changedUserIds}::integer[])
         AND deleted_at IS NULL
    `;
    return changedUserIds.length;
  }

  async listActiveMembers(
    tx: TransactionContext,
    organizationIds: readonly number[],
  ): Promise<MyOrganizationMemberItem[]> {
    if (organizationIds.length === 0) {
      return [];
    }
    const rows = (await tx.sql`
      SELECT u.id,
             u.name,
             u.avatar_url AS "avatarUrl",
             u.is_admin AS "isAdmin",
             array_agg(
               DISTINCT uo_all.organization_id
               ORDER BY uo_all.organization_id
             ) AS "organizationIds"
        FROM app.users AS u
        JOIN app.user_organizations AS uo_match
          ON uo_match.user_id = u.id
         AND uo_match.organization_id = ANY(${organizationIds}::integer[])
        JOIN app.user_organizations AS uo_all ON uo_all.user_id = u.id
       WHERE u.status = 'ACTIVE'
         AND u.disabled_at IS NULL
         AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.id DESC, u.name ASC
       LIMIT ${ORGANIZATION_MEMBER_LIMIT}
    `) as unknown as readonly MyOrganizationMemberItem[];
    return rows.map((row) => ({
      ...row,
      organizationIds: [...row.organizationIds],
    }));
  }
}

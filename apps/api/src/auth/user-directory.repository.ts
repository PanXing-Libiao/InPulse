import type { UserDirectoryItem } from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";

export const USER_DIRECTORY_LIMIT = 300;

/** 用户目录查询边界；只读取启用用户，不返回登录名、邮箱或凭据字段。 */
export interface UserDirectoryRepository {
  findActiveDirectory(
    tx: TransactionContext,
  ): Promise<readonly UserDirectoryItem[]>;
}

export class PostgresUserDirectoryRepository implements UserDirectoryRepository {
  async findActiveDirectory(
    tx: TransactionContext,
  ): Promise<readonly UserDirectoryItem[]> {
    const rows = (await tx.sql`
      SELECT u.id,
             u.name,
             u.avatar_url AS "avatarUrl",
             u.is_admin AS "isAdmin",
             COALESCE(
               (
                 SELECT jsonb_agg(
                   jsonb_build_object(
                     'id', o.id,
                     'name', o.name,
                     'source', o.source,
                     'groupPath', o.sso_group_path
                   )
                   ORDER BY o.id
                 )
                   FROM app.user_organizations AS uo
                   JOIN app.organizations AS o ON o.id = uo.organization_id
                  WHERE uo.user_id = u.id
               ),
               '[]'::jsonb
             ) AS "organizations"
        FROM app.users AS u
       WHERE u.status = 'ACTIVE'
         AND u.disabled_at IS NULL
         AND u.deleted_at IS NULL
       ORDER BY u.id DESC, u.name ASC
       LIMIT ${USER_DIRECTORY_LIMIT}
    `) as unknown as readonly UserDirectoryItem[];
    return rows.map((row) => ({ ...row }));
  }
}

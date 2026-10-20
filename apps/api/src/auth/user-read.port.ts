import type { TransactionContext } from "../database/transaction-context.js";

export interface UserRefItem {
  readonly userId: number;
  readonly name: string;
  readonly avatarUrl: string | null;
}

/**
 * 聚合读使用的用户引用只读端口（R-3 我的任务负责人）。只返回展示所需的最小
 * 字段，不暴露登录名、邮箱或凭据；调用方必须先把 userId 集合限制在
 * 服务端授权范围内，端口不校验授权。
 *
 * 停用用户同样返回：任务负责人是历史事实，列表仍需渲染其姓名与头像；该结果
 * 不得用于成员选择，成员选择走 UserDirectoryRepository 的启用用户目录。
 */
export abstract class UserReadPort {
  abstract listByIds(
    tx: TransactionContext,
    userIds: readonly number[],
  ): Promise<readonly UserRefItem[]>;
}

export class PostgresUserReadPort extends UserReadPort {
  async listByIds(
    tx: TransactionContext,
    userIds: readonly number[],
  ): Promise<readonly UserRefItem[]> {
    if (userIds.length === 0) {
      return [];
    }
    const ids = [...userIds];
    return (await tx.sql<UserRefItem[]>`
      SELECT id AS "userId", name, avatar_url AS "avatarUrl"
        FROM app.users
       WHERE id = ANY(${ids}::integer[])
      UNION ALL
      SELECT d.user_id AS "userId", d.name, NULL::text AS "avatarUrl"
        FROM app.deleted_user_identities AS d
       WHERE d.user_id = ANY(${ids}::integer[])
         AND NOT EXISTS (
           SELECT 1 FROM app.users AS u WHERE u.id = d.user_id
         )
      ORDER BY "userId" ASC
    `) as unknown as readonly UserRefItem[];
  }
}

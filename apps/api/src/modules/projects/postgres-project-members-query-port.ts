import type { TransactionContext } from "../../database/transaction-context.js";
import {
  ProjectMembersQueryPort,
  type ActiveProjectMemberProfile,
  type AssignableProjectMember,
  type UserProjectMembership,
} from "./project-members-query.port.js";

export class PostgresProjectMembersQueryPort extends ProjectMembersQueryPort {
  async listActiveMembers(
    tx: TransactionContext,
    input: { actorUserId: number; projectId: number },
  ): Promise<AssignableProjectMember[] | undefined> {
    // 任务指派人响应（TaskAssigneesResponse）是 strict Schema：
    // 这里必须裁掉角色与加入时间，否则响应序列化会因未知字段失败。
    const profiles = await this.listActiveMemberProfiles(tx, input);
    return profiles?.map(({ id, name, avatarUrl }) => ({
      id,
      name,
      avatarUrl,
    }));
  }
  async listActiveMemberProfiles(
    tx: TransactionContext,
    input: { actorUserId: number; projectId: number },
  ): Promise<ActiveProjectMemberProfile[] | undefined> {
    const [authorized] =
      await tx.sql`SELECT 1 FROM app.projects p JOIN app.users actor ON actor.id = ${input.actorUserId} AND actor.status = 'ACTIVE' AND actor.disabled_at IS NULL WHERE p.id = ${input.projectId} AND (actor.is_admin OR EXISTS (SELECT 1 FROM app.project_members m WHERE m.project_id = p.id AND m.user_id = actor.id AND m.status = 'ACTIVE'))`;
    if (!authorized) return undefined;
    const rows = await tx.sql<
      {
        readonly id: number;
        readonly name: string;
        readonly avatarUrl: string | null;
        readonly role: "MEMBER" | "LEADER";
        readonly joinedAt: Date | string;
      }[]
    >`SELECT u.id,
             u.name,
             u.avatar_url AS "avatarUrl",
             m.role,
             m.joined_at AS "joinedAt"
        FROM app.users u
        JOIN app.project_members m
          ON m.user_id = u.id
         AND m.project_id = ${input.projectId}
         AND m.status = 'ACTIVE'
       WHERE u.status = 'ACTIVE'
         AND u.disabled_at IS NULL
       ORDER BY u.id`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      avatarUrl: row.avatarUrl,
      role: row.role,
      joinedAt: new Date(row.joinedAt).toISOString(),
    }));
  }
  async listActiveMemberIds(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<readonly number[]> {
    const rows = await tx.sql<{ readonly id: number }[]>`
      SELECT u.id
        FROM app.users u
       WHERE u.status = 'ACTIVE'
         AND u.disabled_at IS NULL
         AND EXISTS (
           SELECT 1
             FROM app.project_members m
            WHERE m.project_id = ${input.projectId}
              AND m.user_id = u.id
              AND m.status = 'ACTIVE'
         )
       ORDER BY u.id
    `;
    return rows.map((row) => row.id);
  }
  async findActiveRole(
    tx: TransactionContext,
    input: { projectId: number; userId: number },
  ): Promise<"MEMBER" | "LEADER" | undefined> {
    const [row] = await tx.sql<
      {
        role: "MEMBER" | "LEADER";
      }[]
    >`SELECT role FROM app.project_members WHERE project_id = ${input.projectId} AND user_id = ${input.userId} AND status = 'ACTIVE' LIMIT 1`;
    return row?.role;
  }
  async listActiveMembershipsForUser(
    tx: TransactionContext,
    input: { readonly userId: number },
  ): Promise<readonly UserProjectMembership[]> {
    return (await tx.sql<
      readonly UserProjectMembership[]
    >`SELECT m.project_id AS "projectId",
             p.name AS "projectName",
             m.role
        FROM app.project_members AS m
        JOIN app.projects AS p ON p.id = m.project_id
       WHERE m.user_id = ${input.userId}
         AND m.status = 'ACTIVE'
       ORDER BY m.project_id
       FOR SHARE OF m`) as unknown as readonly UserProjectMembership[];
  }

  async checkAssignableMember(
    tx: TransactionContext,
    input: { projectId: number; userId: number },
  ): Promise<"allowed" | "not-found"> {
    const [user] =
      await tx.sql`SELECT id FROM app.users WHERE id = ${input.userId} AND status = 'ACTIVE' AND disabled_at IS NULL FOR SHARE`;
    if (!user) return "not-found";
    const [member] =
      await tx.sql`SELECT id FROM app.project_members WHERE project_id = ${input.projectId} AND user_id = ${input.userId} AND status = 'ACTIVE' FOR SHARE`;
    return member ? "allowed" : "not-found";
  }
}

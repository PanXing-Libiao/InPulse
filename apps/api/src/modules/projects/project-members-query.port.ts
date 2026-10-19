import type { TransactionContext } from "../../database/transaction-context.js";

export interface AssignableProjectMember {
  readonly id: number;
  readonly name: string;
  readonly avatarUrl: string | null;
}

/** ADR-033：只读成员视图在指派人字段外附带项目内角色与加入时间。 */
export interface ActiveProjectMemberProfile extends AssignableProjectMember {
  readonly role: "MEMBER" | "LEADER";
  readonly joinedAt: string;
}
export interface UserProjectMembership {
  readonly projectId: number;
  readonly projectName: string;
  readonly role: "MEMBER" | "LEADER";
}

export abstract class ProjectMembersQueryPort {
  /** Reauthorizes inside tx; undefined means project missing or inaccessible. */
  abstract listActiveMembers(
    tx: TransactionContext,
    input: { actorUserId: number; projectId: number },
  ): Promise<AssignableProjectMember[] | undefined>;
  /**
   * ADR-033：只读成员列表附带项目内角色与加入时间，授权范围与
   * listActiveMembers 相同；供 `listActiveProjectMembers` 序列化。
   */
  abstract listActiveMemberProfiles(
    tx: TransactionContext,
    input: { actorUserId: number; projectId: number },
  ): Promise<ActiveProjectMemberProfile[] | undefined>;
  /**
   * ADR-035：列出项目全部 ACTIVE 成员的 userId（按 id 升序），供项目开工时
   * 通知全体成员。调用方已持有项目锁并完成写权限校验，这里不再二次授权。
   */
  abstract listActiveMemberIds(
    tx: TransactionContext,
    input: { readonly projectId: number },
  ): Promise<readonly number[]>;
  /**
   * ADR-033：读取指定用户在项目内的 ACTIVE 成员角色；无 ACTIVE 成员关系
   * （含非成员与已移除）返回 undefined。调用方已持有事务与项目锁。
   */
  abstract findActiveRole(
    tx: TransactionContext,
    input: { projectId: number; userId: number },
  ): Promise<"MEMBER" | "LEADER" | undefined>;
  /**
   * ADR-082：用户墓碑化前检查是否仍属于任一项目的 ACTIVE 成员。
   * 调用方持有目标用户行锁；这里按 project_id 升序并锁定成员行。
   */
  abstract listActiveMembershipsForUser(
    tx: TransactionContext,
    input: { readonly userId: number },
  ): Promise<readonly UserProjectMembership[]>;
  /** Caller already authorizes and locks project/module/feature, then locks task for edits.
   * Locks user then membership FOR SHARE; only for creation or changed assignee.
   * Never use this to invalidate an unchanged historical assignee.
   */
  abstract checkAssignableMember(
    tx: TransactionContext,
    input: { projectId: number; userId: number },
  ): Promise<"allowed" | "not-found">;
}

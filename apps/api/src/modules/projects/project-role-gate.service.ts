import { Inject, Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "./project-access.port.js";
import { ProjectMembersQueryPort } from "./project-members-query.port.js";
import {
  ProjectCapabilityAccessError,
  ProjectMemberPermissionPolicyService,
} from "./project-member-permission-policy.service.js";

/**
 * ADR-104：项目内能力由全平台单行配置按三档实时判定。
 * - ALL_MEMBERS：系统管理员、项目组长与普通活跃成员；
 * - LEADERS_ONLY：系统管理员或项目组长；
 * - ADMINS_ONLY：仅系统管理员。
 *
 * 查看项目与动态、创建项目、个人通知与企业微信固定开放；作废 / 恢复记录、
 * 系统管理与审计固定仅系统管理员。门禁结果不缓存进 Session。
 */
export type ProjectManageRole = "SYSTEM_ADMIN" | "MEMBER" | "LEADER";

/**
 * 项目内角色门禁：只读实时成员关系、全局管理员标记与单行权限配置。
 * 返回类型化结果，HTTP/Use Case 负责映射 403/404：
 * - NOT_MEMBER：非本项目活跃成员（含已移除），调用方按资源不存在 404；
 * - 其余角色表示已通过该能力校验，调用方只需再应用与该能力无关的业务约束。
 */
export type ProjectRoleGateResult = ProjectManageRole | "NOT_MEMBER";

interface ForbiddenOverride {
  readonly code: string;
  readonly message: string;
}

@Injectable()
export class ProjectRoleGateService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}

  async manageRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<ProjectRoleGateResult> {
    const scope = await this.access.getAuthorizedSearchScope(actorUserId);
    if (scope.isSystemAdmin) return "SYSTEM_ADMIN";
    if (!scope.projectIds.includes(projectId)) return "NOT_MEMBER";
    const role = await this.members.findActiveRole(tx, {
      projectId,
      userId: actorUserId,
    });
    return role ?? "NOT_MEMBER";
  }

  /**
   * ADR-053 / ADR-104 角色任命门禁：默认仅系统管理员与项目组长可转移组长；
   * 管理员可把该能力放宽到全体成员或收紧为仅系统管理员。成功时返回调用者
   * 的真实项目角色，调用方仍须校验“只能转交其他活跃成员、不能自设”等业务约束。
   */
  async roleSetterRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<ProjectRoleGateResult> {
    return this.gate(tx, actorUserId, projectId, "projectLeaderTransfer", {
      code: "PROJECT_MEMBER_ROLE_FORBIDDEN",
      message: "当前平台权限配置不允许该成员任命或转移项目组长",
    });
  }

  /**
   * ADR-062 / ADR-104 项目删除门禁：默认仅系统管理员与项目组长；管理员可把
   * 该能力放宽或收紧。非成员仍按资源不存在 404，能力拒绝由统一错误映射为 403。
   */
  async projectDeleterRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<ProjectRoleGateResult> {
    return this.gate(tx, actorUserId, projectId, "projectDelete", {
      code: "PROJECT_DELETE_FORBIDDEN",
      message: "当前平台权限配置不允许该成员删除项目",
    });
  }

  /**
   * ADR-096 / ADR-104 模块删除门禁。模块删除复用 moduleDelete，
   * 对外错误码仍由调用方指定，保持模块命令的诊断稳定。
   */
  async scopeDeleterRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
    forbidden: ForbiddenOverride = {
      code: "MODULE_DELETE_FORBIDDEN",
      message: "当前平台权限配置不允许该成员删除模块",
    },
  ): Promise<ProjectRoleGateResult> {
    return this.gate(tx, actorUserId, projectId, "moduleDelete", forbidden);
  }

  /**
   * 删除重放门禁：两类资源都已物理删除，不能再按行可读性复核；仍实时读取
   * 当前成员角色与全平台配置，配置、角色或用户状态变化后不得回放旧响应。
   */
  async scopeDeleterReplayRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
    forbidden?: ForbiddenOverride,
  ): Promise<ProjectRoleGateResult> {
    return this.scopeDeleterRole(tx, actorUserId, projectId, forbidden);
  }

  /**
   * ADR-077 / ADR-104 项目企微群绑定门禁：默认组长或系统管理员；管理员可调整
   * 三档。解绑幂等重放复用同一方法，配置或成员关系变化同样即时生效。
   */
  async wecomGroupBinderRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<ProjectRoleGateResult> {
    return this.gate(tx, actorUserId, projectId, "projectWecomGroup", {
      code: "PROJECT_WECOM_GROUP_FORBIDDEN",
      message: "当前平台权限配置不允许该成员管理项目企业微信群",
    });
  }

  private async gate(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
    capability:
      | "projectLeaderTransfer"
      | "projectDelete"
      | "moduleDelete"
      | "projectWecomGroup",
    forbidden: ForbiddenOverride,
  ): Promise<ProjectRoleGateResult> {
    const decision = await this.permissions.evaluate(tx, {
      actorUserId,
      projectId,
      capabilities: [capability],
    });
    if (decision.kind === "not-member") return "NOT_MEMBER";
    if (decision.kind === "forbidden") {
      throw new ProjectCapabilityAccessError(
        403,
        forbidden.code,
        forbidden.message,
        capability,
      );
    }
    return decision.role;
  }
}

import { Inject, Injectable } from "@nestjs/common";

import type { TransactionContext } from "../../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "./project-access.port.js";
import { ProjectMembersQueryPort } from "./project-members-query.port.js";

/**
 * ADR-039：项目内管理操作（成员增删、项目状态变更）对全体活跃成员开放，
 * `LEADER` 只是身份标识，不再单独授予管理权；
 * 例外清单固定为：ADR-053 组长可以转移组长身份（`roleSetterRole`），
 * ADR-049/ADR-062 只有组长与系统管理员可以删除项目（`projectDeleterRole`，
 * 删除自 ADR-062 起是物理且不可撤销的），ADR-059 只有组长与系统管理员可以
 * 删除模块与功能（`scopeDeleterRole`），ADR-077 只有组长与系统管理员可以
 * 签发/解绑项目企微群绑定（`wecomGroupBinderRole`）。
 */
export type ProjectManageRole = "SYSTEM_ADMIN" | "MEMBER" | "LEADER";

/**
 * ADR-039 项目内角色门禁：只读实时成员关系与全局管理员标记，不缓存进
 * Session。返回类型化结果，HTTP/Use Case 负责映射 403/404：
 * - `NOT_MEMBER`：非本项目活跃成员（含已移除），调用方按资源不存在 404；
 * - 其余（含 `MEMBER`）均放行，调用方只需排除 `NOT_MEMBER`。
 */
export type ProjectRoleGateResult = ProjectManageRole | "NOT_MEMBER";

@Injectable()
export class ProjectRoleGateService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
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
   * ADR-053 角色任命门禁：与 `manageRole` 同源但口径更窄，只有系统管理员与
   * 本项目组长放行（组长只能把其他活跃成员设为组长完成转移，目标与角色约束
   * 由调用方校验），本项目普通成员归入 `MEMBER`（403），非成员归入
   * `NOT_MEMBER`（404）。单独成方法是为了防止以后有人拿 `manageRole` 放行成员
   * 自行改角色。
   */
  async roleSetterRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<"SYSTEM_ADMIN" | "LEADER" | "MEMBER" | "NOT_MEMBER"> {
    const role = await this.manageRole(tx, actorUserId, projectId);
    if (role === "SYSTEM_ADMIN" || role === "LEADER") return role;
    if (role === "NOT_MEMBER") return "NOT_MEMBER";
    return "MEMBER";
  }

  /**
   * ADR-049 / ADR-062 项目删除门禁：只有系统管理员与本项目组长放行，本项目
   * 普通成员归入 `MEMBER`（403 PROJECT_DELETE_FORBIDDEN），非成员归入
   * `NOT_MEMBER`（404）。与 `roleSetterRole` 同源但语义不同，单独成方法，
   * 避免删除权限被未来的「成员可管理」改动顺带放大。删除自 ADR-062 起是
   * 物理删除，不再有还原与彻底删除两条后置命令，因此只需这一个门禁。
   */
  async projectDeleterRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<"SYSTEM_ADMIN" | "LEADER" | "MEMBER" | "NOT_MEMBER"> {
    const role = await this.manageRole(tx, actorUserId, projectId);
    if (role === "SYSTEM_ADMIN" || role === "LEADER") return role;
    if (role === "NOT_MEMBER") return "NOT_MEMBER";
    return "MEMBER";
  }

  /**
   * ADR-059 模块与功能删除门禁：只有系统管理员与本项目组长放行，本项目普通成员
   * 归入 `MEMBER`（403 `MODULE_DELETE_FORBIDDEN` / `FEATURE_DELETE_FORBIDDEN`），
   * 非成员（含已移除）归入 `NOT_MEMBER`（404，不泄露存在性）。这里单独成方法而
   * 不复用 `projectDeleterRole`：删除模块/功能会级联删除其功能、任务与迭代记录，
   * 与删除整个项目是两档不同的授权面，任何一侧调整都不应静默影响另一侧。
   */
  async scopeDeleterRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<"SYSTEM_ADMIN" | "LEADER" | "MEMBER" | "NOT_MEMBER"> {
    const role = await this.manageRole(tx, actorUserId, projectId);
    if (role === "SYSTEM_ADMIN" || role === "LEADER") return role;
    if (role === "NOT_MEMBER") return "NOT_MEMBER";
    return "MEMBER";
  }

  /**
   * ADR-096 删除重放门禁（`moduleDeleteReplayAuthorizer` / `featureDeleteReplayAuthorizer`）：
   * 模块与功能行已物理删除、退出可读范围，首次执行用的资源复核必然 404，因此重放
   * 只复核「如果模块还在，这个人当初还能不能删」——仍读实时成员关系，组长被转移
   * 或移除、降级为普通成员后重放一律拒绝，系统管理员保持放行；项目本身已删除时
   * 授权范围必然不含它，同样拒绝。当前认证（Session 有效、用户未被停用）由 HTTP
   * 层在调用前完成。
   */
  async scopeDeleterReplayRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<"SYSTEM_ADMIN" | "LEADER" | "MEMBER" | "NOT_MEMBER"> {
    return this.scopeDeleterRole(tx, actorUserId, projectId);
  }

  /**
   * ADR-077 项目企微群绑定门禁：只有系统管理员与本项目组长可以签发一次性
   * 绑定码或解绑（普通成员 403 `PROJECT_WECOM_GROUP_FORBIDDEN`，非成员
   * 404）。与删除门禁同源但单独成方法，避免绑定权限被未来的「成员可管理」
   * 改动顺带放大；解绑幂等重放复用同一方法，因此重放时组长被转移、成员被
   * 移除或项目已删除一律拒绝，系统管理员保持放行。
   */
  async wecomGroupBinderRole(
    tx: TransactionContext,
    actorUserId: number,
    projectId: number,
  ): Promise<"SYSTEM_ADMIN" | "LEADER" | "MEMBER" | "NOT_MEMBER"> {
    const role = await this.manageRole(tx, actorUserId, projectId);
    if (role === "SYSTEM_ADMIN" || role === "LEADER") return role;
    if (role === "NOT_MEMBER") return "NOT_MEMBER";
    return "MEMBER";
  }
}

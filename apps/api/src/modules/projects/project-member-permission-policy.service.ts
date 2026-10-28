import { Inject, Injectable } from "@nestjs/common";
import type {
  ProjectMemberPermissionCapability,
  ProjectMemberPermissionLevel,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";
import { ProjectMemberPermissionRepository } from "./project-member-permission.repository.js";

export type ProjectMemberPermissionRole = "SYSTEM_ADMIN" | "LEADER" | "MEMBER";

export type ProjectMemberPermissionDecision =
  | {
      readonly kind: "allowed";
      readonly role: ProjectMemberPermissionRole;
    }
  | { readonly kind: "not-member" }
  | {
      readonly kind: "forbidden";
      readonly role: "LEADER" | "MEMBER";
      readonly deniedCapabilities: readonly ProjectMemberPermissionCapability[];
    };

/** 项目能力门禁失败；403 表示活跃成员被全局配置拒绝，404 表示成员关系已消失。 */
export class ProjectCapabilityAccessError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: string,
    message: string,
    readonly capability:
      ProjectMemberPermissionCapability | undefined = undefined,
  ) {
    super(message);
    this.name = "ProjectCapabilityAccessError";
  }
}

const notFound = (): ProjectCapabilityAccessError =>
  new ProjectCapabilityAccessError(
    404,
    "PROJECT_NOT_FOUND",
    "项目不存在或当前用户无权访问",
  );

const forbidden = (
  capabilities: readonly ProjectMemberPermissionCapability[],
): ProjectCapabilityAccessError =>
  new ProjectCapabilityAccessError(
    403,
    "PROJECT_CAPABILITY_FORBIDDEN",
    "当前平台权限配置不允许执行该操作",
    capabilities[0],
  );

function levelAllows(
  level: ProjectMemberPermissionLevel,
  role: ProjectMemberPermissionRole,
): boolean {
  if (role === "SYSTEM_ADMIN") return true;
  if (level === "ALL_MEMBERS") return true;
  if (level === "LEADERS_ONLY") return role === "LEADER";
  if (level === "ADMINS_ONLY") return false;
  return false;
}

/**
 * ADR-104：全平台项目成员能力的唯一运行时判定入口。
 *
 * 每次调用都在当前事务内实时读取用户状态、全局管理员标记、项目 ACTIVE 成员
 * 角色与单行配置，不缓存到 Session 或进程内对象。系统管理员始终通过；
 * 非成员统一返回 not-member；活跃成员按能力三档判定。配置行缺失或未知值
 * 按 fail closed 处理。
 */
@Injectable()
export class ProjectMemberPermissionPolicyService {
  constructor(
    @Inject(ProjectMemberPermissionRepository)
    private readonly repository: ProjectMemberPermissionRepository,
  ) {}

  async evaluate(
    tx: TransactionContext,
    input: {
      readonly actorUserId: number;
      readonly projectId: number;
      readonly capabilities: readonly ProjectMemberPermissionCapability[];
    },
  ): Promise<ProjectMemberPermissionDecision> {
    const users = (await tx.sql`
      SELECT is_admin AS "isAdmin", status, disabled_at AS "disabledAt"
        FROM app.users
       WHERE id = ${input.actorUserId}
    `) as unknown as readonly {
      readonly isAdmin: boolean;
      readonly status: string;
      readonly disabledAt: Date | string | null;
    }[];
    const user = users[0];
    if (
      user === undefined ||
      user.status !== "ACTIVE" ||
      user.disabledAt !== null
    ) {
      return { kind: "not-member" };
    }
    if (user.isAdmin) return { kind: "allowed", role: "SYSTEM_ADMIN" };

    const memberships = (await tx.sql`
      SELECT role
        FROM app.project_members
       WHERE project_id = ${input.projectId}
         AND user_id = ${input.actorUserId}
         AND status = 'ACTIVE'
       LIMIT 1
    `) as unknown as readonly { readonly role: "LEADER" | "MEMBER" }[];
    const role = memberships[0]?.role;
    if (role === undefined) return { kind: "not-member" };

    if (input.capabilities.length === 0) return { kind: "allowed", role };
    const settings = await this.repository.find(tx);
    if (settings === undefined) {
      throw new Error("project member permission settings row is missing");
    }
    const deniedCapabilities = input.capabilities.filter(
      (capability) => !levelAllows(settings[capability], role),
    );
    return deniedCapabilities.length === 0
      ? { kind: "allowed", role }
      : { kind: "forbidden", role, deniedCapabilities };
  }

  async assertCapabilities(
    tx: TransactionContext,
    input: {
      readonly actorUserId: number;
      readonly projectId: number;
      readonly capabilities: readonly ProjectMemberPermissionCapability[];
    },
  ): Promise<ProjectMemberPermissionRole> {
    const decision = await this.evaluate(tx, input);
    if (decision.kind === "not-member") throw notFound();
    if (decision.kind === "forbidden") {
      throw forbidden(decision.deniedCapabilities);
    }
    return decision.role;
  }
}

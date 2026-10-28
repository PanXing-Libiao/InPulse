import { Inject, Injectable } from "@nestjs/common";
import {
  projectMemberReplayContextSchema,
  type AddProjectMemberResponse,
  type ProjectMemberRecordItem,
  type ProjectMemberUnfinishedTasksResponse,
  type ProjectMembersListResponse,
  type RemoveProjectMemberResponse,
} from "@inpulse/api-contract";

import { AuditWritePort } from "../../audit/audit.port.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { IdempotencyExecutionResult } from "../../idempotency/runner.js";
import { ActivityWritePort } from "../activity/index.js";
import { PROJECT_NOTIFICATION_TYPES } from "../notifications/index.js";
import { ProjectMemberTaskCommandPort } from "../tasks/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "./project-access.port.js";
import { ProjectNotificationDispatcher } from "./project-notification.dispatcher.js";
import { ProjectRoleGateService } from "./project-role-gate.service.js";
import { ProjectMemberPermissionPolicyService } from "./project-member-permission-policy.service.js";
import type { ProjectMemberPermissionCapability } from "@inpulse/api-contract";
import { PROJECT_MEMBER_ROLE_CHANGE_ACTIVITY } from "./project-member-events.js";
import {
  ActiveUsersQueryPort,
  type ProjectMemberRecord,
  type ProjectRecord,
  ProjectsWritePort,
} from "./projects-write.port.js";
import type {
  RemoveProjectMemberRequest,
  SetProjectMemberRoleRequest,
  SetProjectMemberRoleResponse,
} from "@inpulse/api-contract";

const PROJECT_MEMBER_ADD_ACTIVITY = "PROJECT_MEMBER_ADDED";
const PROJECT_MEMBER_REMOVE_ACTIVITY = "PROJECT_MEMBER_REMOVED";
const PROJECT_MEMBER_JOIN_NOTIFICATION =
  PROJECT_NOTIFICATION_TYPES.projectJoined;

export class ProjectMemberManagementError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectMemberManagementError";
  }
}

export interface ProjectMemberCommandResult extends IdempotencyExecutionResult {
  readonly body:
    | AddProjectMemberResponse
    | RemoveProjectMemberResponse
    | SetProjectMemberRoleResponse;
}

/**
 * F-05 项目成员管理：所有命令只接收显式 TransactionContext，
 * 成员读写、审计、活动与通知投影在同一个事务内提交。
 */
@Injectable()
export class ProjectMemberManagementService {
  constructor(
    @Inject(ProjectsWritePort) private readonly projects: ProjectsWritePort,
    @Inject(ActiveUsersQueryPort)
    private readonly activeUsers: ActiveUsersQueryPort,
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ProjectMemberTaskCommandPort)
    private readonly tasks: ProjectMemberTaskCommandPort,
    @Inject(ProjectRoleGateService)
    private readonly roleGate: ProjectRoleGateService,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(ProjectNotificationDispatcher)
    private readonly notifications: ProjectNotificationDispatcher,
  ) {}

  async listMembers(
    tx: TransactionContext,
    projectId: number,
    actorId: number,
  ): Promise<ProjectMembersListResponse> {
    await this.requireReadProject(tx, projectId);
    await this.requireManageRole(tx, actorId, projectId);
    const items = (await this.projects.listMembers(tx, { projectId })).map(
      (record) => this.toContractMember(record),
    );
    return { items };
  }

  async listUnfinishedTasks(
    tx: TransactionContext,
    projectId: number,
    userId: number,
    actorId: number,
  ): Promise<ProjectMemberUnfinishedTasksResponse> {
    await this.requireReadProject(tx, projectId);
    await this.requireManageRole(tx, actorId, projectId);
    const member = await this.projects.findLatestMember(tx, {
      projectId,
      userId,
    });
    if (member === undefined || member.status !== "ACTIVE") {
      throw this.notFound();
    }
    const items = await this.tasks.listUnfinished(tx, projectId, userId);
    return { items };
  }

  async addMember(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly userId: number;
      readonly requestId: string;
    },
  ): Promise<ProjectMemberCommandResult> {
    const project = await this.requireWritableProject(tx, input);
    await this.requireManageRole(tx, input.actorId, input.projectId);
    await this.permissions.assertCapabilities(tx, {
      actorUserId: input.actorId,
      projectId: input.projectId,
      capabilities: ["projectMemberManage"],
    });
    const active = await this.activeUsers.findActiveUserIds(tx, [input.userId]);
    if (active.length !== 1) {
      throw new ProjectMemberManagementError(
        422,
        "PROJECT_MEMBER_USER_INVALID",
        "目标用户不存在或已停用，不能添加为项目成员",
      );
    }
    const latest = await this.projects.findLatestMember(
      tx,
      { projectId: input.projectId, userId: input.userId },
      true,
    );
    if (latest?.status === "ACTIVE") {
      throw this.alreadyActive();
    }

    // ADR-053：项目必须始终保留一名组长；无活跃组长的项目（历史或夹具清理
    // 残留）重新加人时第一位成员直接成为组长，否则提交时延迟约束会拒绝。
    const joiningRole = await this.resolveJoiningRole(tx, input.projectId);

    let member: ProjectMemberRecord;
    try {
      member = await this.projects.addMemberHistory(tx, {
        projectId: input.projectId,
        userId: input.userId,
        role: joiningRole,
      });
    } catch (error) {
      if (isActiveUniqueViolation(error)) {
        throw this.alreadyActive();
      }
      if (isUniqueViolation(error, "project_members_one_leader")) {
        throw new ProjectMemberManagementError(
          409,
          "PROJECT_MEMBER_LEADER_CONFLICT",
          "该项目已存在组长，请刷新成员列表后重试",
        );
      }
      throw error;
    }

    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId: project.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.member.add",
      targetType: "USER",
      targetId: String(input.userId),
      eventPayload: {
        projectId: project.projectId,
        userId: input.userId,
        membershipId: member.membershipId,
        joinedAt: member.joinedAt,
        role: member.role,
      },
      requestId: input.requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: project.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: project.projectId,
      activityType: PROJECT_MEMBER_ADD_ACTIVITY,
      actorId: input.actorId,
      summary:
        member.role === "LEADER"
          ? `将用户 ${member.name} 添加为项目成员并任命为组长`
          : `将用户 ${member.name} 添加为项目成员`,
      metadata: {
        userId: member.userId,
        membershipId: member.membershipId,
        role: member.role,
      },
      visibilityScope: "MEMBER",
      sourceStatus: project.status,
      sourceRowVersion: project.rowVersion,
      occurredAt,
    });
    await this.notifications.dispatch(
      tx,
      {
        projectId: project.projectId,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        notificationType: PROJECT_MEMBER_JOIN_NOTIFICATION,
        title: `已加入项目 ${project.name}`,
        body: "你已被系统管理员添加为项目成员",
        targetPath: `/projects/${project.projectId}/activity`,
        createdAt: occurredAt,
      },
      [member.userId],
    );

    const body: AddProjectMemberResponse = {
      member: this.toContractMember(member),
    };
    return {
      responseStatus: 200,
      responseSchemaRef: "AddProjectMemberResponse",
      responseHasBody: true,
      responseBody: body,
      replayAuthContext: {
        projectId: project.projectId,
        memberUserId: member.userId,
      },
      body,
    };
  }

  async removeMember(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly userId: number;
      readonly request: RemoveProjectMemberRequest;
      readonly requestId: string;
    },
  ): Promise<ProjectMemberCommandResult> {
    const project = await this.requireWritableProject(tx, input);
    await this.requireManageRole(tx, input.actorId, input.projectId);
    await this.permissions.assertCapabilities(tx, {
      actorUserId: input.actorId,
      projectId: input.projectId,
      capabilities: ["projectMemberManage"],
    });
    const latest = await this.projects.findLatestMember(tx, {
      projectId: input.projectId,
      userId: input.userId,
    });
    if (latest === undefined || latest.status !== "ACTIVE") {
      throw this.notFound();
    }
    if (latest.role === "LEADER") {
      throw new ProjectMemberManagementError(
        409,
        "PROJECT_MEMBER_LEADER_PROTECTED",
        "项目组长不能被移除，请先把其他成员设为组长（转移）后再移除，项目至少要保留一名成员",
      );
    }

    const reassignedTaskIds = await this.tasks.reassign(tx, {
      actorId: input.actorId,
      projectId: input.projectId,
      targetUserId: input.userId,
      assignments: input.request.reassignments,
      requestId: input.requestId,
    });

    const removed = await this.projects.removeMember(tx, {
      projectId: input.projectId,
      userId: input.userId,
    });
    if (removed === undefined) {
      throw this.notFound();
    }
    const remaining = await this.tasks.listUnfinished(
      tx,
      input.projectId,
      input.userId,
    );

    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId: project.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.member.remove",
      targetType: "USER",
      targetId: String(input.userId),
      eventPayload: {
        projectId: project.projectId,
        userId: input.userId,
        membershipId: removed.membershipId,
        removedAt: removed.removedAt,
        reassignedTaskIds,
        unfinishedTaskCount: remaining.length,
      },
      requestId: input.requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: project.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: project.projectId,
      activityType: PROJECT_MEMBER_REMOVE_ACTIVITY,
      actorId: input.actorId,
      summary: `已将用户 ${removed.name} 移出项目`,
      metadata: {
        userId: removed.userId,
        membershipId: removed.membershipId,
        reassignedTaskIds,
        unfinishedTaskCount: remaining.length,
      },
      visibilityScope: "MEMBER",
      sourceStatus: project.status,
      sourceRowVersion: project.rowVersion,
      occurredAt,
    });

    const body: RemoveProjectMemberResponse = {
      member: this.toContractMember(removed),
      reassignedTaskIds,
      unfinishedTaskCount: remaining.length,
    };
    return {
      responseStatus: 200,
      responseSchemaRef: "RemoveProjectMemberResponse",
      responseHasBody: true,
      responseBody: body,
      replayAuthContext: {
        projectId: project.projectId,
        memberUserId: removed.userId,
      },
      body,
    };
  }

  /**
   * ADR-053：任命与转移组长。系统管理员可把任意活跃成员设为组长；本项目组长
   * 只能把其他活跃成员设为组长以转交身份（不能自设、不能撤销）。普通成员
   * 403，目标必须为 ACTIVE 成员；组长唯一性由部分唯一索引报 409，撤销组长
   * 只能通过转移（新组长产生时旧组长自动降级）。
   */
  async setRole(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly userId: number;
      readonly role: SetProjectMemberRoleRequest["role"];
      readonly requestId: string;
    },
  ): Promise<ProjectMemberCommandResult> {
    const project = await this.requireWritableProject(tx, input);
    const setter = await this.roleGate.roleSetterRole(
      tx,
      input.actorId,
      input.projectId,
    );
    if (setter === "NOT_MEMBER") throw this.notFound();
    // ADR-053：非管理员调用者只能把身份转交给其他活跃成员，不能自设、不能撤销。
    if (
      setter !== "SYSTEM_ADMIN" &&
      (input.role !== "LEADER" || input.userId === input.actorId)
    ) {
      throw new ProjectMemberManagementError(
        403,
        "PROJECT_MEMBER_ROLE_FORBIDDEN",
        "当前调用者只能把其他活跃成员设为组长来转移身份",
      );
    }
    const target = await this.projects.findLatestMember(
      tx,
      { projectId: input.projectId, userId: input.userId },
      true,
    );
    if (target === undefined || target.status !== "ACTIVE") {
      throw this.notFound();
    }
    // ADR-053：项目必须始终保留一名组长，禁止直接降级现任组长；
    // 撤销组长只能通过「先任命新组长」的转移路径（新组长产生时旧组长自动降级）。
    if (input.role === "MEMBER" && target.role === "LEADER") {
      throw new ProjectMemberManagementError(
        409,
        "PROJECT_MEMBER_LEADER_REQUIRED",
        "项目必须保留一名组长，请先把其他成员设为组长（转移）",
      );
    }
    let updated: ProjectMemberRecord | undefined;
    try {
      updated = await this.projects.setMemberRole(tx, {
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
      });
    } catch (error) {
      if (isUniqueViolation(error, "project_members_one_leader")) {
        throw new ProjectMemberManagementError(
          409,
          "PROJECT_MEMBER_LEADER_CONFLICT",
          "该项目已存在组长，请先转移现有组长身份后重试",
        );
      }
      throw error;
    }
    if (updated === undefined) {
      throw this.notFound();
    }

    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId: project.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.member.role.set",
      targetType: "USER",
      targetId: String(input.userId),
      eventPayload: {
        projectId: project.projectId,
        userId: input.userId,
        membershipId: updated.membershipId,
        role: updated.role,
      },
      requestId: input.requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: project.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: project.projectId,
      activityType: PROJECT_MEMBER_ROLE_CHANGE_ACTIVITY,
      actorId: input.actorId,
      summary: `将用户 ${updated.name} 的项目角色设置为 ${updated.role}`,
      metadata: {
        userId: updated.userId,
        membershipId: updated.membershipId,
        role: updated.role,
      },
      visibilityScope: "MEMBER",
      sourceStatus: project.status,
      sourceRowVersion: project.rowVersion,
      occurredAt,
    });

    const body = { member: this.toContractMember(updated) };
    return {
      responseStatus: 200,
      responseSchemaRef: "SetProjectMemberRoleResponse",
      responseHasBody: true,
      responseBody: body,
      replayAuthContext: {
        projectId: project.projectId,
        memberUserId: updated.userId,
      },
      body,
    };
  }

  async replayAuthorizer(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
    capability: Extract<
      ProjectMemberPermissionCapability,
      "projectMemberManage" | "projectLeaderTransfer"
    >,
  ): Promise<void> {
    const parsed = projectMemberReplayContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new Error("invalid project member replay context");
    }
    await this.requireWritableProject(tx, {
      actorId,
      projectId: parsed.data.projectId,
    });
    await this.requireManageRole(tx, actorId, parsed.data.projectId);
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId: parsed.data.projectId,
      capabilities: [capability],
    });
    const project = await this.projects.findProject(tx, {
      projectId: parsed.data.projectId,
    });
    if (project === undefined) {
      throw this.notFound();
    }
    const member = await this.projects.findLatestMember(tx, {
      projectId: parsed.data.projectId,
      userId: parsed.data.memberUserId,
    });
    if (member === undefined) {
      throw this.notFound();
    }
  }

  private async requireReadProject(
    tx: TransactionContext,
    projectId: number,
  ): Promise<ProjectRecord> {
    const project = await this.projects.findProject(tx, { projectId });
    if (project === undefined) {
      throw this.notFound();
    }
    return project;
  }

  /**
   * ADR-039 项目内管理门禁：系统管理员或本项目任意活跃成员通过；
   * 非成员/已移除 404（不泄露项目存在性）。
   */
  private async requireManageRole(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
  ): Promise<void> {
    const role = await this.roleGate.manageRole(tx, actorId, projectId);
    if (role === "NOT_MEMBER") throw this.notFound();
  }

  /**
   * ADR-053：项目无活跃组长时（只可能来自历史数据或夹具清理），
   * 第一位加入的成员直接成为组长，保证「有成员就必须有组长」。
   */
  private async resolveJoiningRole(
    tx: TransactionContext,
    projectId: number,
  ): Promise<"MEMBER" | "LEADER"> {
    const members = await this.projects.listMembers(tx, { projectId });
    return members.some(
      (record) => record.status === "ACTIVE" && record.role === "LEADER",
    )
      ? "MEMBER"
      : "LEADER";
  }

  private async requireWritableProject(
    tx: TransactionContext,
    input: { readonly actorId: number; readonly projectId: number },
  ): Promise<ProjectRecord> {
    const check = await this.access.checkProjectForWrite(tx, {
      actorUserId: input.actorId,
      projectId: input.projectId,
    });
    if (check.kind === "not-found") {
      throw this.notFound();
    }
    const project = await this.projects.findProject(tx, {
      projectId: input.projectId,
    });
    if (project === undefined) {
      throw this.notFound();
    }
    return project;
  }

  private toContractMember(
    record: ProjectMemberRecord,
  ): ProjectMemberRecordItem {
    return {
      membershipId: record.membershipId,
      projectId: record.projectId,
      userId: record.userId,
      name: record.name,
      avatarUrl: record.avatarUrl,
      status: record.status,
      role: record.role,
      joinedAt: record.joinedAt,
      removedAt: record.removedAt,
    };
  }

  private notFound(): ProjectMemberManagementError {
    return new ProjectMemberManagementError(
      404,
      "PROJECT_MEMBER_NOT_FOUND",
      "项目或成员不存在，或当前身份无权访问",
    );
  }

  private alreadyActive(): ProjectMemberManagementError {
    return new ProjectMemberManagementError(
      409,
      "PROJECT_MEMBER_ALREADY_ACTIVE",
      "该用户已是项目活跃成员",
    );
  }
}

function isActiveUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error, "project_members_active_unique");
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === constraint
  );
}

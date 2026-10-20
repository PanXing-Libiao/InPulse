import { Inject, Injectable } from "@nestjs/common";

import { AuditWritePort } from "../../audit/audit.port.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ActivityWritePort } from "../activity/index.js";
import { PROJECT_MEMBER_ROLE_CHANGE_ACTIVITY } from "./project-member-events.js";
import { ProjectsWritePort } from "./projects-write.port.js";

/** 停用账号前的组长移交输入；新组长只能来自该项目的 ACTIVE 成员。 */
export interface ProjectLeaderTransferInput {
  readonly actorId: number;
  readonly projectId: number;
  readonly fromUserId: number;
  readonly newLeaderUserId: number;
  readonly requestId: string;
}

export class ProjectLeaderTransferError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectLeaderTransferError";
  }
}

/** 跨域组长移交命令边界；调用方必须显式传入同一个 TransactionContext。 */
export abstract class ProjectLeaderTransferPort {
  abstract transferLeader(
    tx: TransactionContext,
    input: ProjectLeaderTransferInput,
  ): Promise<void>;
}

/**
 * ADR-053 / ADR-089：把现任组长身份转交给项目内另一名 ACTIVE 成员。
 * 先校验待停用账号仍是组长，再复用 setMemberRole 的「先降级原组长、
 * 再提升目标」路径；审计与项目动态和停用命令共用同一事务。
 */
@Injectable()
export class PostgresProjectLeaderTransferPort extends ProjectLeaderTransferPort {
  constructor(
    @Inject(ProjectsWritePort) private readonly projects: ProjectsWritePort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
  ) {
    super();
  }

  async transferLeader(
    tx: TransactionContext,
    input: ProjectLeaderTransferInput,
  ): Promise<void> {
    if (input.fromUserId === input.newLeaderUserId) {
      throw new ProjectLeaderTransferError(
        422,
        "PROJECT_LEADER_TARGET_INVALID",
        "不能把组长移交给待停用账号",
      );
    }
    const project = await this.projects.findProject(tx, {
      projectId: input.projectId,
    });
    if (project === undefined) {
      throw new ProjectLeaderTransferError(
        404,
        "PROJECT_LEADER_PROJECT_NOT_FOUND",
        "项目不存在或已被删除",
      );
    }
    const current = await this.projects.findLatestMember(
      tx,
      { projectId: input.projectId, userId: input.fromUserId },
      true,
    );
    if (
      current === undefined ||
      current.status !== "ACTIVE" ||
      current.role !== "LEADER"
    ) {
      throw new ProjectLeaderTransferError(
        409,
        "PROJECT_LEADER_NOT_CURRENT",
        "待停用账号已不是该项目组长，请刷新后重试",
      );
    }
    const target = await this.projects.findLatestMember(
      tx,
      { projectId: input.projectId, userId: input.newLeaderUserId },
      true,
    );
    if (target === undefined || target.status !== "ACTIVE") {
      throw new ProjectLeaderTransferError(
        422,
        "PROJECT_LEADER_TARGET_INVALID",
        "新组长必须是该项目的活跃成员",
      );
    }
    const updated = await this.projects.setMemberRole(tx, {
      projectId: input.projectId,
      userId: input.newLeaderUserId,
      role: "LEADER",
    });
    if (updated === undefined) {
      throw new ProjectLeaderTransferError(
        409,
        "PROJECT_LEADER_TRANSFER_CONFLICT",
        "组长身份已变化，请刷新后重试",
      );
    }
    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId: project.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.member.role.set",
      targetType: "USER",
      targetId: String(input.newLeaderUserId),
      eventPayload: {
        projectId: project.projectId,
        userId: input.newLeaderUserId,
        previousLeaderUserId: input.fromUserId,
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
      summary: `将用户 ${updated.name} 的项目角色设置为 LEADER`,
      metadata: {
        userId: updated.userId,
        membershipId: updated.membershipId,
        role: updated.role,
        previousLeaderUserId: input.fromUserId,
      },
      visibilityScope: "MEMBER",
      sourceStatus: project.status,
      sourceRowVersion: project.rowVersion,
      occurredAt,
    });
  }
}

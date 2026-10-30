import { Inject, Injectable } from "@nestjs/common";
import type {
  CreateProjectRequest,
  CreateProjectResponse,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";
import { AuditWritePort } from "../../audit/audit.port.js";
import type { IdempotencyExecutionResult } from "../../idempotency/runner.js";
import { SearchProjectionWritePort } from "../search/index.js";
import { ActivityWritePort } from "../activity/index.js";
import { PROJECT_NOTIFICATION_TYPES } from "../notifications/index.js";
import {
  ActiveUsersQueryPort,
  ProjectsWritePort,
  type ProjectCreatedRecord,
} from "./projects-write.port.js";
import { ProjectNotificationDispatcher } from "./project-notification.dispatcher.js";
import { resolveProjectCode } from "./project-code.js";

const PROJECT_CREATE_ACTIVITY_TYPE = "PROJECT_CREATED";
const PROJECT_CREATE_NOTIFICATION_TYPE =
  PROJECT_NOTIFICATION_TYPES.projectJoined;

export class ProjectBootstrapValidationError extends Error {
  readonly code = "PROJECT_BOOTSTRAP_VALIDATION_ERROR" as const;
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "ProjectBootstrapValidationError";
  }
}

export class ProjectBootstrapConflictError extends Error {
  readonly code = "PROJECT_BOOTSTRAP_CONFLICT" as const;
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ProjectBootstrapConflictError";
  }
}

/**
 * 项目编码冲突：`app.projects` 的 `projects_code_unique` 是全局唯一约束，插入重复
 * 编码时 PostgreSQL 抛 23505。映射成独立错误码，前端才能说明「是编码被占用」。
 */
export class ProjectCodeConflictError extends Error {
  readonly code = "PROJECT_CODE_CONFLICT" as const;
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ProjectCodeConflictError";
  }
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === constraint
  );
}

export interface ProjectBootstrapDeps {
  readonly projects: ProjectsWritePort;
  readonly activeUsers: ActiveUsersQueryPort;
  readonly audit: AuditWritePort;
  readonly search: SearchProjectionWritePort;
  readonly activity: ActivityWritePort;
  readonly notifications: ProjectNotificationDispatcher;
}

/**
 * F-04 项目创建单事务编排（技术设计 §6.2）。
 * 只接收显式 `TransactionContext`；创建者/项目成员 ACTIVE 校验、项目、
 * 审计、通知、活动与搜索投影全部在同一事务内。任一成员无效/停用/重复整笔回滚。
 */
@Injectable()
export class ProjectBootstrapWorkflow {
  constructor(
    @Inject(ProjectsWritePort) private readonly projects: ProjectsWritePort,
    @Inject(ActiveUsersQueryPort)
    private readonly activeUsers: ActiveUsersQueryPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(ProjectNotificationDispatcher)
    private readonly notifications: ProjectNotificationDispatcher,
  ) {}

  async execute(
    tx: TransactionContext,
    actorId: number,
    request: CreateProjectRequest,
  ): Promise<
    IdempotencyExecutionResult & { readonly body: CreateProjectResponse }
  > {
    let code: string;
    try {
      code = resolveProjectCode(request.name, request.code);
    } catch {
      throw new ProjectBootstrapValidationError(
        "项目编码无法从名称派生或请求编码无效",
      );
    }

    let project: ProjectCreatedRecord;
    try {
      project = await this.projects.createProject(tx, {
        code,
        name: request.name,
        description: request.description,
        createdBy: actorId,
      });
    } catch (error) {
      if (uniqueViolation(error, "projects_code_unique")) {
        throw new ProjectCodeConflictError(
          "项目编码已被占用，请更换项目编码后重试",
        );
      }
      throw error;
    }

    const allMemberIds = Array.from(
      new Set([actorId, ...request.memberIds]),
    ).sort((a, b) => a - b);
    const activeIds = await this.activeUsers.findActiveUserIds(
      tx,
      allMemberIds,
    );
    if (activeIds.length !== allMemberIds.length) {
      throw new ProjectBootstrapValidationError("项目成员必须全部为已启用用户");
    }

    const memberRecords: {
      userId: number;
      status: "ACTIVE";
      role: "MEMBER" | "LEADER";
      joinedAt: string;
    }[] = [];
    for (const userId of allMemberIds) {
      // ADR-033：创建者成员行以 LEADER 落库，其余项目成员为 MEMBER。
      const record = await this.projects.addMember(tx, {
        projectId: project.projectId,
        userId,
        ...(userId === actorId ? { role: "LEADER" as const } : {}),
      });
      if (record.status !== "ACTIVE") {
        throw new ProjectBootstrapConflictError("项目成员必须为活跃状态");
      }
      memberRecords.push({
        userId: record.userId,
        status: record.status,
        role: record.role,
        joinedAt: record.joinedAt,
      });
    }

    const occurredAt = new Date();
    const requestId = `project-bootstrap:${project.projectId}`;
    const audit = await this.audit.append(tx, {
      projectId: project.projectId,
      actorType: "USER",
      actorId,
      action: "project.create",
      targetType: "PROJECT",
      targetId: String(project.projectId),
      eventPayload: {
        code: project.code,
        name: project.name,
        description: project.description,
      },
      requestId,
      occurredAt,
    });

    const chainId = audit.chainId;
    const sequenceNo = audit.sequenceNo;

    await this.search.upsert(tx, {
      projectId: project.projectId,
      entityType: "PROJECT",
      entityId: project.projectId,
      moduleId: null,
      recordId: null,
      title: project.name,
      summary: project.description,
      rawText: `${project.code} ${project.name} ${project.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: "NOT_STARTED",
      sourceRowVersion: 1,
    });

    await this.activity.append(tx, {
      projectId: project.projectId,
      sourceChainId: chainId,
      sourceSequence: sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: project.projectId,
      activityType: PROJECT_CREATE_ACTIVITY_TYPE,
      actorId,
      summary: `创建了项目 ${project.name}`,
      metadata: { code: project.code },
      visibilityScope: "MEMBER",
      sourceStatus: "NOT_STARTED",
      sourceRowVersion: 1,
      occurredAt,
    });

    await this.notifications.dispatch(
      tx,
      {
        projectId: project.projectId,
        sourceChainId: chainId,
        sourceSequence: sequenceNo,
        notificationType: PROJECT_CREATE_NOTIFICATION_TYPE,
        title: `已加入项目 ${project.name}`,
        body: "你已加入该项目，成为项目成员",
        targetPath: `/projects/${project.projectId}/activity`,
        createdAt: occurredAt,
      },
      allMemberIds,
    );

    const body: CreateProjectResponse = {
      project: {
        id: project.projectId,
        code: project.code,
        name: project.name,
        description: project.description,
        status: "NOT_STARTED",
        rowVersion: project.rowVersion,
        createdBy: project.createdBy,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      members: memberRecords,
    };

    return {
      responseStatus: 200,
      responseSchemaRef: "CreateProjectResponse",
      responseHasBody: true,
      responseBody: body,
      replayAuthContext: {
        projectId: project.projectId,
        actorUserId: actorId,
      },
      body,
    };
  }
}

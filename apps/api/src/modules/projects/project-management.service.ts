import { Inject, Injectable } from "@nestjs/common";
import {
  projectReplayContextSchema,
  type ProjectDetailResponse,
  type ProjectEditRequest,
  type ProjectItem,
} from "@inpulse/api-contract";

import { AuditWritePort } from "../../audit/index.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ActivityWritePort } from "../activity/index.js";
import { SearchProjectionWritePort } from "../search/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "./project-access.port.js";
import { ProjectMembersQueryPort } from "./project-members-query.port.js";
import { ProjectRoleGateService } from "./project-role-gate.service.js";
import { ProjectMemberPermissionPolicyService } from "./project-member-permission-policy.service.js";
import { ProjectStartNotifier } from "./project-start.notifier.js";
import { ProjectWrapNotifier } from "./project-wrap.notifier.js";
import {
  ProjectsWritePort,
  type ProjectChangeRecord,
} from "./projects-write.port.js";

const PROJECT_UPDATE_ACTIVITY = "PROJECT_UPDATED";
const PROJECT_STATUS_CHANGED_ACTIVITY = "PROJECT_STATUS_CHANGED";
const PROJECT_WRAPPED_ACTIVITY = "PROJECT_WRAPPED";

/** F-06.3 状态接口可写入的目标态：项目三态，不存在归档。 */
export type ProjectLifecycleTarget = "NOT_STARTED" | "ACTIVE" | "MAINTENANCE";

const PROJECT_STATUS_LABELS: Readonly<Record<string, string>> = {
  NOT_STARTED: "未开始",
  ACTIVE: "进行中",
  MAINTENANCE: "维护中",
};

export class ProjectManagementError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectManagementError";
  }
}

const missing = () =>
  new ProjectManagementError(
    404,
    "PROJECT_NOT_FOUND",
    "项目不存在或当前用户无权访问",
  );

const versionConflict = () =>
  new ProjectManagementError(
    409,
    "PROJECT_VERSION_CONFLICT",
    "项目版本已变化，请重新加载后编辑",
  );

/**
 * F-06.1 项目编辑：只接收显式 TransactionContext，名称/描述更新、
 * 审计、活动与搜索投影在同一事务内提交；编码创建后不可修改。
 */
@Injectable()
export class ProjectManagementService {
  constructor(
    @Inject(ProjectsWritePort) private readonly projects: ProjectsWritePort,
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(ProjectRoleGateService)
    private readonly roles: ProjectRoleGateService,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
    @Inject(ProjectStartNotifier)
    private readonly startNotifier: ProjectStartNotifier,
    @Inject(ProjectWrapNotifier)
    private readonly wrapNotifier: ProjectWrapNotifier,
  ) {}

  /** 写前授权：实时成员关系与用户状态由 Port 读取；项目三态下没有只读态。 */
  async authorize(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
  ): Promise<void> {
    const check = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (check.kind === "not-found") throw missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities: ["projectEdit"],
    });
  }

  /** 幂等重放前的当前权限复核；任一门禁失败都不得返回已存成功结果。 */
  async replay(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const resource = projectReplayContextSchema.safeParse(context);
    if (!resource.success) {
      throw new Error("invalid project replay context");
    }
    await this.authorize(tx, actorId, resource.data.projectId);
  }

  async updateProject(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly version: number;
      readonly edit: ProjectEditRequest;
      readonly requestId: string;
    },
  ): Promise<ProjectDetailResponse> {
    await this.authorize(tx, input.actorId, input.projectId);
    const current = await this.projects.findProjectForChange(
      tx,
      { projectId: input.projectId },
      true,
    );
    if (current === undefined) throw missing();
    if (current.rowVersion !== input.version) throw versionConflict();

    const updated = await this.projects.updateProjectDetails(tx, {
      projectId: input.projectId,
      expectedRowVersion: input.version,
      name: input.edit.name,
      description: input.edit.description,
    });
    if (updated === undefined) throw versionConflict();

    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId: updated.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.update",
      targetType: "PROJECT",
      targetId: String(updated.projectId),
      eventPayload: {
        before: {
          name: current.name,
          description: current.description,
          rowVersion: current.rowVersion,
        },
        after: {
          name: updated.name,
          description: updated.description,
          rowVersion: updated.rowVersion,
        },
      },
      requestId: input.requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: updated.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: updated.projectId,
      activityType: PROJECT_UPDATE_ACTIVITY,
      actorId: input.actorId,
      summary: `更新了项目 ${updated.name}`,
      metadata: { code: updated.code },
      visibilityScope: "MEMBER",
      sourceStatus: updated.status,
      sourceRowVersion: updated.rowVersion,
      occurredAt,
    });
    await this.search.upsert(tx, {
      projectId: updated.projectId,
      entityType: "PROJECT",
      entityId: updated.projectId,
      moduleId: null,
      featureId: null,
      recordId: null,
      title: updated.name,
      summary: updated.description.slice(0, 5000),
      rawText: `${updated.code} ${updated.name} ${updated.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: updated.status,
      sourceRowVersion: updated.rowVersion,
    });

    return {
      project: this.toItem(updated),
      currentUserRole:
        (await this.members.findActiveRole(tx, {
          projectId: updated.projectId,
          userId: input.actorId,
        })) ?? null,
    };
  }

  /**
   * F-06.3 项目状态变更：按全平台 projectEdit 配置判定，系统管理员始终可切换；
   * 项目在未开始、进行中、维护中之间手动切换，三态下不存在归档，也没有归档流程。
   *
   * 三条硬约束在服务端拦截，前端置灰只是提示：
   * - 未开始与维护中之间禁止直接互改，必须先经过进行中；
   * - 项目内出现过已完成任务后不可回退未开始（粘性标记永不回落）；
   * - 进入维护中要求项目下任务全部收尾（未完成且未取消的任务数为 0）。
   *
   * 只有「未开始 → 进行中」通知全体活跃成员；维护中不通知，避免反复切换刷屏。
   * ADR-092：状态变更不推进 `row_version`，`If-Match` 仍以当前内容版本保护在途编辑；
   * 状态、审计 `project.status.change`、活动与搜索投影在同一事务提交。
   */
  async changeProjectStatus(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly version: number;
      readonly target: ProjectLifecycleTarget;
      readonly requestId: string;
    },
  ): Promise<ProjectDetailResponse> {
    await this.authorize(tx, input.actorId, input.projectId);
    const current = await this.projects.findProjectForChange(
      tx,
      { projectId: input.projectId },
      true,
    );
    if (current === undefined) throw missing();
    if (current.rowVersion !== input.version) throw versionConflict();
    if (current.status === input.target) {
      throw new ProjectManagementError(
        409,
        "PROJECT_STATE_CONFLICT",
        "项目已处于目标状态",
      );
    }
    if (input.target === "NOT_STARTED") {
      if (current.firstTaskCompletedAt !== null) {
        throw new ProjectManagementError(
          409,
          "PROJECT_STATUS_NOT_STARTED_LOCKED",
          "项目已有任务完成，不能回退为未开始",
        );
      }
      if (current.status === "MAINTENANCE") {
        throw new ProjectManagementError(
          409,
          "PROJECT_STATUS_LEVEL_SKIP",
          "维护中的项目不能直接切换为未开始，请先切换为进行中",
        );
      }
    }
    if (input.target === "MAINTENANCE" && current.status === "NOT_STARTED") {
      throw new ProjectManagementError(
        409,
        "PROJECT_STATUS_LEVEL_SKIP",
        "未开始的项目不能直接切换为维护中，请先切换为进行中",
      );
    }
    if (input.target === "MAINTENANCE") {
      const openTaskCount = await this.projects.countOpenTasks(tx, {
        projectId: input.projectId,
      });
      if (openTaskCount > 0) {
        throw new ProjectManagementError(
          409,
          "PROJECT_MAINTENANCE_TASKS_OPEN",
          `项目下仍有 ${openTaskCount} 个未完成、也未取消的任务，请先完成或取消全部任务再切换为维护中`,
        );
      }
    }
    const updated = await this.projects.updateProjectStatus(tx, {
      projectId: input.projectId,
      expectedRowVersion: input.version,
      status: input.target,
    });
    if (updated === undefined) throw versionConflict();
    const occurredAt = new Date();
    const wrap =
      current.status !== "MAINTENANCE" && updated.status === "MAINTENANCE"
        ? await this.projects.createProjectWrap(tx, {
            projectId: updated.projectId,
            actorId: input.actorId,
            sealedAt: occurredAt,
          })
        : undefined;
    const event = await this.audit.append(tx, {
      projectId: updated.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.status.change",
      targetType: "PROJECT",
      targetId: String(updated.projectId),
      eventPayload: {
        before: { status: current.status, rowVersion: current.rowVersion },
        after: { status: updated.status, rowVersion: updated.rowVersion },
        wrapped: wrap !== undefined,
        ...(wrap === undefined
          ? {}
          : {
              wrapTemplateVersion: wrap.templateVersion,
              wrapStats: wrap.snapshot.stats,
            }),
      },
      requestId: input.requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: updated.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: updated.projectId,
      activityType:
        wrap === undefined
          ? PROJECT_STATUS_CHANGED_ACTIVITY
          : PROJECT_WRAPPED_ACTIVITY,
      actorId: input.actorId,
      summary:
        wrap === undefined
          ? `项目状态：${PROJECT_STATUS_LABELS[current.status] ?? current.status} → ${PROJECT_STATUS_LABELS[updated.status] ?? updated.status}（${updated.name}）`
          : `项目封箱：${updated.name} 主体交付完成，正式进入维护。${wrap.snapshot.stats.completedTaskCount} 个任务、${wrap.snapshot.stats.publishedRecordCount} 篇记录、${wrap.snapshot.stats.activeMemberCount} 个人、${wrap.snapshot.stats.durationDays} 天。`,
      metadata: {
        code: updated.code,
        beforeStatus: current.status,
        afterStatus: updated.status,
        ...(wrap === undefined
          ? {}
          : {
              wrapTemplateVersion: wrap.templateVersion,
              wrapStats: wrap.snapshot.stats,
            }),
      },
      visibilityScope: "MEMBER",
      sourceStatus: updated.status,
      sourceRowVersion: updated.rowVersion,
      occurredAt,
    });
    await this.search.upsert(tx, {
      projectId: updated.projectId,
      entityType: "PROJECT",
      entityId: updated.projectId,
      moduleId: null,
      featureId: null,
      recordId: null,
      title: updated.name,
      summary: updated.description.slice(0, 5000),
      rawText: `${updated.code} ${updated.name} ${updated.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: updated.status,
      sourceRowVersion: updated.rowVersion,
    });
    if (wrap !== undefined) {
      await this.wrapNotifier.notify(tx, {
        projectId: updated.projectId,
        chainId: event.chainId,
        sequenceNo: event.sequenceNo,
        occurredAt,
        snapshot: wrap.snapshot,
      });
    }
    if (current.status === "NOT_STARTED" && updated.status === "ACTIVE") {
      await this.startNotifier.notify(tx, {
        projectId: updated.projectId,
        code: updated.code,
        name: updated.name,
        chainId: event.chainId,
        sequenceNo: event.sequenceNo,
        occurredAt,
      });
    }
    return {
      project: this.toItem(updated),
      currentUserRole:
        (await this.members.findActiveRole(tx, {
          projectId: updated.projectId,
          userId: input.actorId,
        })) ?? null,
    };
  }

  /**
   * ADR-062 / ADR-104 项目删除（物理删除）：按全平台 projectDelete 档位判定；
   * 被配置拒绝返回 403 `PROJECT_DELETE_FORBIDDEN`，非成员统一 404；
   * 删除不可撤销，且要求 `If-Match` 版本一致（版本过期 409）。
   *
   * 删除完全交给数据库的 `app.purge_project`：`app_runtime` 没有业务表的
   * DELETE 权限，只有这个 SECURITY DEFINER 窄口能在同一事务内按外键顺序清空
   * 模块、功能、任务、聚合组、迭代记录、遗留项、外部链接、成员关系、通知、
   * 动态与搜索投影，最后删除项目行本身。
   *
   * ADR-085：项目自己的 `PROJECT:<id>` 审计日志与链头不随项目删除，继续作为
   * 只读历史保留；项目行消失后不再写项目动态与搜索投影（它们都在被清空的表里），
   * **不发通知**：通知的深链指向已不存在的项目，发出去就是死链。SYSTEM 审计链
   * 新增 `project.delete`（操作者、项目编码与名称、删除时的状态、删除行数与保留
   * 审计行数），因此删除之后仍可查到「谁在什么时候删掉了哪个项目」并回看项目链
   * （仅管理员可见）；项目编码随行释放，可以被后续新项目复用。
   */
  async deleteProject(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly version: number;
      readonly requestId: string;
    },
  ): Promise<void> {
    const role = await this.roles.projectDeleterRole(
      tx,
      input.actorId,
      input.projectId,
    );
    if (role === "NOT_MEMBER") throw missing();
    const current = await this.projects.findProjectForChange(
      tx,
      { projectId: input.projectId },
      true,
    );
    if (current === undefined) throw missing();
    if (current.rowVersion !== input.version) throw versionConflict();

    const counts = await this.projects.purgeProject(tx, {
      projectId: input.projectId,
    });
    await this.audit.append(tx, {
      // 项目链按 ADR-085 保留，不写入已冻结的项目历史；本次操作记在 SYSTEM 链。
      projectId: null,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.delete",
      targetType: "PROJECT",
      targetId: String(input.projectId),
      eventPayload: {
        code: current.code,
        name: current.name,
        status: current.status,
        rowVersion: current.rowVersion,
        actorRole: role,
        records: counts,
      },
      requestId: input.requestId,
      occurredAt: new Date(),
    });
  }

  private toItem(record: ProjectChangeRecord): ProjectItem {
    return {
      id: record.projectId,
      code: record.code,
      name: record.name,
      description: record.description,
      status: record.status,
      hasCompletedTask: record.firstTaskCompletedAt !== null,
      rowVersion: record.rowVersion,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      memberCount: record.memberCount,
      stats: record.stats,
    };
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type {
  TaskCompletionRequest,
  ModuleTaskItem,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import { AuditWritePort } from "../../audit/index.js";
import { ActivityWritePort } from "../activity/index.js";
import { PROJECT_NOTIFICATION_TYPES } from "../notifications/index.js";
import { SearchProjectionWritePort } from "../search/index.js";
import {
  ProjectNotificationDispatcher,
  ProjectStartNotifier,
  ProjectsWritePort,
} from "../projects/index.js";
import { TaskManagementRepository } from "./task-management.repository.js";
import { TaskManagementError } from "./tasks-management.service.js";
import type { TaskReadModel } from "./task-query.port.js";
/**
 * Workflow owns authorization and all parent/task/branch locks. This port never opens a transaction.
 * ADR-035：任务完成同时是项目「第一次有产出」的判定点，见 recordProjectOutput。
 */
export abstract class TaskCompletionCommandPort {
  abstract complete(
    tx: TransactionContext,
    actorId: number,
    source: TaskReadModel,
    input: TaskCompletionRequest,
    recordAuthors: readonly number[],
    requestId: string,
  ): Promise<ModuleTaskItem>;
}
@Injectable()
export class PostgresTaskCompletionCommandPort extends TaskCompletionCommandPort {
  constructor(
    @Inject(TaskManagementRepository)
    private readonly repository: TaskManagementRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(ProjectNotificationDispatcher)
    private readonly notifications: ProjectNotificationDispatcher,
    @Inject(ProjectsWritePort) private readonly projects: ProjectsWritePort,
    @Inject(ProjectStartNotifier)
    private readonly projectStarted: ProjectStartNotifier,
  ) {
    super();
  }
  async complete(
    tx: TransactionContext,
    actorId: number,
    source: TaskReadModel,
    input: TaskCompletionRequest,
    recordAuthors: readonly number[],
    requestId: string,
  ) {
    const before = await this.repository.find(tx, source, source.taskId);
    if (!before)
      throw new TaskManagementError(
        404,
        "TASK_NOT_FOUND",
        "任务不存在或无法访问",
      );
    if (before.rowVersion !== input.expectedRowVersion)
      throw new TaskManagementError(
        409,
        "TASK_VERSION_CONFLICT",
        "任务版本已变化，请加载最新任务",
      );
    if (before.workStatus !== "TODO" || before.lifecycleStatus !== "ACTIVE")
      throw new TaskManagementError(
        409,
        "TASK_STATE_CONFLICT",
        "任务当前状态不允许完成",
      );
    const note =
      input.mode === "WITHOUT_RECORD"
        ? `${input.completionReason}，不关联迭代记录${input.note ? `：${input.note}` : ""}`
        : null;
    const result = await this.repository.transition(
      tx,
      before,
      actorId,
      "DONE",
      note,
      input.mode === "WITHOUT_RECORD" ? input.completionReason : "发布迭代记录",
    );
    if (!result)
      throw new TaskManagementError(
        409,
        "TASK_VERSION_CONFLICT",
        "任务版本或状态已变化",
      );
    const event = await this.audit.append(tx, {
      projectId: source.projectId,
      actorType: "USER",
      actorId,
      action: "task.status",
      targetType: "TASK",
      targetId: String(source.taskId),
      eventPayload: {
        before,
        after: result,
        mode: input.mode,
        completionNote: note,
      },
      requestId,
    });
    await this.activity.append(tx, {
      projectId: source.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "TASK",
      sourceEntityId: source.taskId,
      activityType: "task.complete",
      actorId,
      summary: `任务完成：${result.title}`,
      metadata: {
        taskId: result.id,
        moduleId: result.moduleId,
      },
      visibilityScope: "MEMBER",
      sourceStatus: "DONE",
      sourceRowVersion: result.rowVersion,
      occurredAt: new Date(result.updatedAt),
    });
    await this.search.upsert(tx, {
      projectId: source.projectId,
      entityType: "TASK",
      entityId: source.taskId,
      moduleId: result.moduleId,
      recordId: null,
      title: result.title,
      summary: result.description.slice(0, 5000),
      rawText: `${result.code}\n${result.title}\n${result.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: "DONE",
      sourceRowVersion: result.rowVersion,
    });
    await this.notifications.dispatch(
      tx,
      {
        projectId: source.projectId,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        notificationType: PROJECT_NOTIFICATION_TYPES.taskComplete,
        title: `任务完成：${result.title}`.slice(0, 500),
        body: result.code,
        targetPath: `/projects/${source.projectId}/modules/${source.moduleId}/tasks?taskId=${source.taskId}`,
        createdAt: new Date(result.updatedAt),
      },
      [result.creatorId, ...recordAuthors, ...result.assigneeIds],
    );
    await this.recordProjectOutput(tx, actorId, source, result, requestId);
    return result;
  }

  /**
   * ADR-035：任务完成是项目「第一次有产出」的唯一来源，同一事务内完成两件事——
   * 置位永不回落的 first_task_completed_at；项目仍为未开始时自动升级为进行中，
   * 并按项目开工写审计、活动、搜索投影与全体成员通知。
   * 其余状态只补标记，不产生任何额外副作用。
   */
  private async recordProjectOutput(
    tx: TransactionContext,
    actorId: number,
    source: TaskReadModel,
    result: ModuleTaskItem,
    requestId: string,
  ): Promise<void> {
    const completion = await this.projects.recordFirstTaskCompletion(tx, {
      projectId: source.projectId,
      completedAt: new Date(result.updatedAt),
    });
    if (
      completion === undefined ||
      completion.previousStatus !== "NOT_STARTED" ||
      completion.status !== "ACTIVE"
    ) {
      return;
    }
    const occurredAt = new Date(result.updatedAt);
    const event = await this.audit.append(tx, {
      projectId: completion.projectId,
      actorType: "USER",
      actorId,
      action: "project.status.change",
      targetType: "PROJECT",
      targetId: String(completion.projectId),
      eventPayload: {
        automatic: true,
        trigger: "TASK_COMPLETED",
        taskId: source.taskId,
        before: { status: completion.previousStatus },
        after: { status: completion.status },
      },
      requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: completion.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: completion.projectId,
      activityType: "PROJECT_STATUS_CHANGED",
      actorId,
      summary: `项目开工：${completion.name} 由未开始进入进行中`,
      metadata: {
        code: completion.code,
        trigger: "TASK_COMPLETED",
        taskId: source.taskId,
      },
      visibilityScope: "MEMBER",
      sourceStatus: completion.status,
      sourceRowVersion: completion.rowVersion,
      occurredAt,
    });
    await this.search.upsert(tx, {
      projectId: completion.projectId,
      entityType: "PROJECT",
      entityId: completion.projectId,
      moduleId: null,
      recordId: null,
      title: completion.name,
      summary: completion.description.slice(0, 5000),
      rawText: `${completion.code} ${completion.name} ${completion.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: completion.status,
      sourceRowVersion: completion.rowVersion,
    });
    await this.projectStarted.notify(tx, {
      projectId: completion.projectId,
      code: completion.code,
      name: completion.name,
      chainId: event.chainId,
      sequenceNo: event.sequenceNo,
      occurredAt,
    });
  }
}

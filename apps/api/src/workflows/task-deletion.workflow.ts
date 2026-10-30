import { Inject, Injectable } from "@nestjs/common";
import { AuditWritePort } from "../audit/index.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { ActivityWritePort } from "../modules/activity/index.js";
import { TaskDeletionCommandPort } from "../modules/tasks/task-deletion.command-port.js";
import type { TaskScope } from "../modules/tasks/task-management.repository.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";

const missing = () =>
  new TaskManagementError(
    404,
    "TASK_NOT_FOUND",
    "任务或所属模块不存在或无法访问",
  );
const conflict = () =>
  new TaskManagementError(
    409,
    "TASK_STATE_CONFLICT",
    "任务已被并发修改，请刷新后重试",
  );

/** ADR-096：删除任务的响应，字段与 DeleteTaskRequest 的响应契约一一对应。 */
export interface TaskDeletionResult {
  readonly id: number;
  readonly projectId: number;
  readonly moduleId: number;
  readonly code: string;
  readonly title: string;
  readonly workStatus: "TODO" | "DONE" | "CANCELED";
  readonly deletedRecordCount: number;
  readonly removedLinkCount: number;
  readonly detachedGroupRole: "MAIN" | "SOURCE" | null;
}

const DEFAULT_REASON = "任务已被删除";

/** ADR-096：级联交接等事务内删除任务的共享输入。 */
export interface TaskDeletionInTransactionInput {
  readonly projectId: number;
  readonly taskId: number;
  /** 调用方已持有任务行锁时为该任务的当前版本。 */
  readonly rowVersion: number;
  readonly actorId: number;
  readonly reason: string;
  readonly requestId: string;
}

/**
 * ADR-096：删除任务。数据库窄口函数在同一事务内物理删除任务本体、状态历史、
 * 负责人、影响关系、外部链接关联、聚合组关系与该任务全部迭代记录及其版本、
 * 遗留项；工作流只追加审计和项目动态，因此「谁删了哪条任务」仍可追溯。
 *
 * 删除不可恢复：没有还原路由，也不保留任务或记录快照。
 */
@Injectable()
export class TaskDeletionWorkflow {
  constructor(
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(TaskDeletionCommandPort)
    private readonly commands: TaskDeletionCommandPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
  ) {}

  async delete(
    actorId: number,
    scope: TaskScope,
    taskId: number,
    expectedRowVersion: number,
    reason: string | null,
    requestId: string,
  ): Promise<TaskDeletionResult> {
    const deletionReason = reason?.trim() ? reason.trim() : DEFAULT_REASON;
    return this.uow.run(async (tx) => {
      // 父级与归属门禁：与其它任务写命令同一口径（项目可写、模块存在）。
      await this.commands.authorize(tx, actorId, scope, taskId);
      const current = await this.commands.find(tx, scope, taskId);
      if (!current) throw missing();
      return this.deleteWithinTransaction(tx, {
        projectId: scope.projectId,
        taskId,
        rowVersion: expectedRowVersion,
        actorId,
        reason: deletionReason,
        requestId,
      });
    });
  }

  /**
   * 在同一事务内删除单个任务；管理员账号停用交接等跨域工作流复用本入口。
   * 调用方必须已经完成授权与归属复核。
   */
  async deleteWithinTransaction(
    tx: TransactionContext,
    input: TaskDeletionInTransactionInput,
  ): Promise<TaskDeletionResult> {
    const { projectId, taskId, actorId, reason, requestId } = input;
    const deleted = await this.commands.hardDelete(
      tx,
      { id: taskId, projectId },
      input.rowVersion,
      actorId,
      reason,
    );
    if (!deleted) throw conflict();
    const occurredAt = new Date(deleted.deletedAt);
    const event = await this.audit.append(tx, {
      projectId,
      actorType: "USER",
      actorId,
      action: "task.delete",
      targetType: "TASK",
      targetId: String(taskId),
      eventPayload: {
        taskId,
        code: deleted.code,
        title: deleted.title,
        moduleId: deleted.moduleId,
        workStatus: deleted.workStatus,
        reason,
        deletedRecordCount: deleted.deletedRecordCount,
        removedLinkCount: deleted.removedLinkCount,
        detachedGroupId: deleted.detachedGroupId,
        detachedGroupRole: deleted.detachedGroupRole,
      },
      requestId,
    });
    const visibility = {
      projectId,
      sourceEntityType: "TASK" as const,
      sourceEntityId: taskId,
      visibilityScope: "MEMBER" as const,
      sourceStatus: "DELETED",
      sourceRowVersion: input.rowVersion + 1,
    };
    await this.activity.updateEntityVisibility(tx, visibility);
    await this.activity.append(tx, {
      ...visibility,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      activityType: "TASK_DELETED",
      actorId,
      summary: "删除任务：" + deleted.title,
      metadata: {
        taskId,
        code: deleted.code,
        moduleId: deleted.moduleId,
        workStatus: deleted.workStatus,
        deletedRecordCount: deleted.deletedRecordCount,
        removedLinkCount: deleted.removedLinkCount,
        detachedGroupId: deleted.detachedGroupId,
        detachedGroupRole: deleted.detachedGroupRole,
      },
      occurredAt,
    });
    return {
      id: deleted.id,
      projectId: deleted.projectId,
      moduleId: deleted.moduleId,
      code: deleted.code,
      title: deleted.title,
      workStatus: deleted.workStatus,
      deletedRecordCount: deleted.deletedRecordCount,
      removedLinkCount: deleted.removedLinkCount,
      detachedGroupRole: deleted.detachedGroupRole,
    };
  }
}

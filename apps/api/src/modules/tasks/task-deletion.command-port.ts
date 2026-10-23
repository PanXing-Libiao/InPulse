import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  TaskManagementRepository,
  type TaskHardDeletedRow,
  type TaskRecord,
  type TaskScope,
} from "./task-management.repository.js";
import { TasksManagementService } from "./tasks-management.service.js";

/**
 * ADR-096：任务删除在本域需要暴露的边界。跨域编排由 `TaskDeletionWorkflow`
 * 承担，本 Port 只提供任务行的写前门禁、读取与物理删除。
 */
export abstract class TaskDeletionCommandPort {
  /** `taskId` 只在执行侧传入；幂等重放时任务已删除，只复核项目可写与父级归属。 */
  abstract authorize(
    tx: TransactionContext,
    actorId: number,
    scope: TaskScope,
    taskId?: number,
  ): Promise<void>;
  abstract find(
    tx: TransactionContext,
    scope: TaskScope,
    taskId: number,
  ): Promise<TaskRecord | undefined>;
  /** ADR-096：物理删除任务及其全部下级数据；版本不一致时返回 undefined。 */
  abstract hardDelete(
    tx: TransactionContext,
    current: Pick<TaskRecord, "id" | "projectId">,
    expectedRowVersion: number,
    actorId: number,
    reason: string,
  ): Promise<TaskHardDeletedRow | undefined>;
}

@Injectable()
export class SqlTaskDeletionCommandPort extends TaskDeletionCommandPort {
  constructor(
    @Inject(TasksManagementService)
    private readonly tasks: TasksManagementService,
    @Inject(TaskManagementRepository)
    private readonly repository: TaskManagementRepository,
  ) {
    super();
  }

  authorize(
    tx: TransactionContext,
    actorId: number,
    scope: TaskScope,
    taskId: number,
  ): Promise<void> {
    return this.tasks.authorize(tx, actorId, scope, taskId);
  }

  find(
    tx: TransactionContext,
    scope: TaskScope,
    taskId: number,
  ): Promise<TaskRecord | undefined> {
    return this.repository.find(tx, scope, taskId);
  }

  hardDelete(
    tx: TransactionContext,
    current: Pick<TaskRecord, "id" | "projectId">,
    expectedRowVersion: number,
    actorId: number,
    reason: string,
  ): Promise<TaskHardDeletedRow | undefined> {
    return this.repository.hardDelete(
      tx,
      current,
      expectedRowVersion,
      actorId,
      reason,
    );
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { TaskEditRequest, ModuleTaskItem } from "@inpulse/api-contract";
import { TasksManagementService } from "./tasks-management.service.js";
export interface FollowupScope {
  projectId: number;
  moduleId: number;
}
export abstract class FollowupTaskCommandPort {
  abstract create(
    tx: TransactionContext,
    actorId: number,
    scope: FollowupScope,
    edit: TaskEditRequest,
    requestId: string,
  ): Promise<ModuleTaskItem>;
  abstract replay(
    tx: TransactionContext,
    actorId: number,
    scope: FollowupScope,
    taskId: number,
  ): Promise<void>;
}
@Injectable()
export class PostgresFollowupTaskCommandPort extends FollowupTaskCommandPort {
  constructor(
    @Inject(TasksManagementService)
    private readonly service: TasksManagementService,
  ) {
    super();
  }
  create(
    tx: TransactionContext,
    actorId: number,
    scope: FollowupScope,
    edit: TaskEditRequest,
    requestId: string,
  ) {
    return this.service.execute(tx, {
      ...scope,
      actorId,
      edit,
      requestId,
      operation: "createModuleTask",
      assignmentNotificationType: "leftover.convert",
    });
  }
  replay(
    tx: TransactionContext,
    actorId: number,
    scope: FollowupScope,
    taskId: number,
  ) {
    return this.service.replay(tx, actorId, {
      projectId: scope.projectId,
      moduleId: scope.moduleId,
      taskId,
    });
  }
}

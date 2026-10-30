import { Inject, Injectable } from "@nestjs/common";
import type { TaskEditRequest } from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { FollowupScope } from "./followup-task.port.js";
import { TasksManagementService } from "./tasks-management.service.js";
@Injectable()
export class TaskCreateCommandPort {
  constructor(
    @Inject(TasksManagementService)
    private readonly service: TasksManagementService,
  ) {}
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

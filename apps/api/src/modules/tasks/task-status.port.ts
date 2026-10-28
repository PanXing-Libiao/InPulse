import { Inject, Injectable } from "@nestjs/common";
import type {
  TaskStatusRequest,
  TaskItem,
  ModuleTaskItem,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  TasksManagementService,
  TaskManagementError,
} from "./tasks-management.service.js";
export interface TaskStatusResource {
  projectId: number;
  moduleId: number;
  featureId: number | null;
  taskId: number;
}
export type OtherTaskStatusRequest = Exclude<
  TaskStatusRequest,
  { action: "COMPLETE" }
>;
/** Existing non-completion status behavior, explicitly participating in its caller's transaction. */
export abstract class TaskStatusCommandPort {
  abstract authorize(
    tx: TransactionContext,
    actorId: number,
    resource: TaskStatusResource,
  ): Promise<void>;
  abstract apply(
    tx: TransactionContext,
    actorId: number,
    resource: TaskStatusResource,
    version: number,
    command: OtherTaskStatusRequest,
    requestId: string,
  ): Promise<TaskItem | ModuleTaskItem>;
  abstract replay(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void>;
}
@Injectable()
export class ExistingTaskStatusCommandPort extends TaskStatusCommandPort {
  constructor(
    @Inject(TasksManagementService)
    private readonly service: TasksManagementService,
  ) {
    super();
  }
  authorize(
    tx: TransactionContext,
    actorId: number,
    resource: TaskStatusResource,
  ) {
    return this.service.authorize(
      tx,
      actorId,
      resource,
      resource.taskId,
      "taskLifecycle",
    );
  }
  apply(
    tx: TransactionContext,
    actorId: number,
    resource: TaskStatusResource,
    version: number,
    command: OtherTaskStatusRequest,
    requestId: string,
  ) {
    if (!["REOPEN", "CANCEL", "RESTORE"].includes(command.action))
      throw new TaskManagementError(
        400,
        "TASK_COMPLETION_WORKFLOW_REQUIRED",
        "完成任务必须使用组合流程",
      );
    return this.service.transition(tx, {
      ...resource,
      actorId,
      version,
      command,
      requestId,
    });
  }
  replay(tx: TransactionContext, actorId: number, context: unknown) {
    return this.service.replay(tx, actorId, context, "taskLifecycle");
  }
}

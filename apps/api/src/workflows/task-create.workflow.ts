import { ProjectCreationLockPort } from "../modules/projects/project-creation-lock.port.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import { Inject, Injectable } from "@nestjs/common";
import type {
  TaskCreateRequest,
  TaskCreateResult,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../database/transaction-context.js";
import { ModuleCreateCommandPort } from "../modules/modules/create.command-port.js";
import { TaskCreateCommandPort } from "../modules/tasks/create.command-port.js";
@Injectable()
export class TaskCreateWorkflow {
  constructor(
    @Inject(ProjectCreationLockPort)
    private readonly projectLock: ProjectCreationLockPort,
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleCreateCommandPort)
    private readonly modules: ModuleCreateCommandPort,
    @Inject(TaskCreateCommandPort)
    private readonly tasks: TaskCreateCommandPort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}
  async execute(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    input: TaskCreateRequest,
    requestId: string,
  ): Promise<TaskCreateResult> {
    await this.projectLock.lock(tx, projectId);
    const access = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (access.kind === "not-found")
      throw new TaskManagementError(
        404,
        "PROJECT_NOT_FOUND",
        "项目不存在或无法访问",
      );
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities:
        input.module.kind === "new" ? ["taskEdit", "moduleEdit"] : ["taskEdit"],
    });
    const moduleId =
      input.module.kind === "existing"
        ? input.module.id
        : (
            await this.modules.create(
              tx,
              actorId,
              projectId,
              input.module.input,
              requestId,
            )
          ).id;
    const task = await this.tasks.create(
      tx,
      actorId,
      { projectId, moduleId },
      input.task,
      requestId,
    );
    return { projectId, moduleId, taskId: task.id };
  }
  async replay(
    tx: TransactionContext,
    actorId: number,
    result: TaskCreateResult,
    input: TaskCreateRequest,
  ) {
    if (input.module.kind === "new") {
      await this.permissions.assertCapabilities(tx, {
        actorUserId: actorId,
        projectId: result.projectId,
        capabilities: ["moduleEdit"],
      });
    }
    return this.tasks.replay(tx, actorId, result, result.taskId);
  }
}

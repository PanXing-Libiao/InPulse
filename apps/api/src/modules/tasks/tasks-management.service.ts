import { Inject, Injectable } from "@nestjs/common";
import {
  taskReplayContextSchema,
  moduleTaskReplayContextSchema,
  type TaskEditRequest,
  type TaskStatusRequest,
  taskStatusRequestSchema,
  taskStatusHistoryResponseSchema,
} from "@inpulse/api-contract";
import { UserReadPort } from "../../auth/user-read.port.js";
import { AuditWritePort } from "../../audit/index.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
  ProjectCodePort,
  ProjectMembersQueryPort,
  ProjectsWritePort,
} from "../projects/index.js";
import { ModuleQueryPort, ModuleReadPort } from "../modules/index.js";
import { FeatureQueryPort, FeatureReadPort } from "../features/index.js";
import { ActivityWritePort } from "../activity/index.js";
import { SearchProjectionWritePort } from "../search/index.js";
import { NotificationWritePort } from "../notifications/index.js";
import {
  TaskManagementRepository,
  type TaskScope,
  type TaskRecord,
} from "./task-management.repository.js";

/**
 * 任务写命令：只有创建与编辑；任务的生命周期状态不被任何命令写入
 * （ADR-054：任务归档与恢复已下线，ARCHIVED 不可达）。
 */
export type TaskOperation =
  "createTask" | "updateTask" | "createModuleTask" | "updateModuleTask";

export class TaskManagementError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missing = () =>
  new TaskManagementError(
    404,
    "TASK_NOT_FOUND",
    "任务或所属功能不存在或无法访问",
  );

@Injectable()
export class TasksManagementService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(FeatureQueryPort) private readonly features: FeatureQueryPort,
    @Inject(FeatureReadPort) private readonly featureRead: FeatureReadPort,
    @Inject(ProjectCodePort) private readonly codes: ProjectCodePort,
    @Inject(ProjectMembersQueryPort)
    private readonly members: ProjectMembersQueryPort,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(TaskManagementRepository)
    private readonly repository: TaskManagementRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(NotificationWritePort)
    private readonly notifications: NotificationWritePort,
    @Inject(ModuleReadPort) private readonly moduleRead: ModuleReadPort,
    @Inject(ProjectsWritePort) private readonly projects: ProjectsWritePort,
    @Inject(UserReadPort) private readonly users: UserReadPort,
  ) {}
  async read(
    actorId: number,
    scope: TaskScope,
    taskId?: number,
    assignees = false,
    history = false,
  ) {
    const authorized = await this.access.getAuthorizedSearchScope(actorId);
    if (!authorized.projectIds.includes(scope.projectId)) throw missing();
    return this.uow.run(async (tx) => {
      if (
        !(scope.featureId === null
          ? await this.moduleRead.find(tx, scope.projectId, scope.moduleId)
          : await this.featureRead.find(
              tx,
              scope.projectId,
              scope.moduleId,
              scope.featureId,
            ))
      )
        throw missing();
      if (assignees) {
        const items = await this.members.listActiveMembers(tx, {
          actorUserId: actorId,
          projectId: scope.projectId,
        });
        if (!items) throw missing();
        return { items };
      }
      if (taskId !== undefined) {
        const item = await this.repository.find(tx, scope, taskId);
        if (!item) throw missing();
        if (history) {
          const rows = await this.repository.history(tx, scope, taskId);
          const users = await this.users.listByIds(tx, [
            ...new Set(rows.map((row) => row.changedBy)),
          ]);
          const names = new Map(users.map((user) => [user.userId, user.name]));
          return taskStatusHistoryResponseSchema.parse({
            items: rows.map((row) => ({
              ...row,
              changedByName: names.get(row.changedBy) ?? "删除用户",
            })),
          });
        }
        return item;
      }
      return { items: await this.repository.list(tx, scope) };
    });
  }
  /** ADR-045：功能与模块都不再有归档只读态，写前检查只剩归属与父级取锁。 */
  async authorize(
    tx: TransactionContext,
    actorId: number,
    scope: TaskScope,
    taskId?: number,
  ): Promise<void> {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId: scope.projectId,
    });
    if (project.kind === "not-found") throw missing();
    // Resolve full identity before reporting any archived state.
    if (
      !(scope.featureId === null
        ? await this.moduleRead.find(tx, scope.projectId, scope.moduleId)
        : await this.featureRead.find(
            tx,
            scope.projectId,
            scope.moduleId,
            scope.featureId,
          ))
    )
      throw missing();
    if (
      taskId !== undefined &&
      !(await this.repository.find(tx, scope, taskId))
    )
      throw missing();
    const module = await this.modules.checkModuleForWrite(tx, scope);
    const feature =
      scope.featureId === null
        ? module
        : await this.features.checkFeatureForWrite(tx, {
            ...scope,
            featureId: scope.featureId,
          });
    if (module.kind === "not-found" || feature.kind === "not-found")
      throw missing();
  }
  async replay(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const parsed = moduleTaskReplayContextSchema.safeParse(context);
    const resource = parsed.success
      ? { ...parsed.data, featureId: null }
      : taskReplayContextSchema.parse(context);
    await this.authorize(tx, actorId, resource, resource.taskId);
    if (parsed.success)
      for (const featureId of parsed.data.impactFeatureIds)
        if (
          !(await this.featureRead.find(
            tx,
            resource.projectId,
            resource.moduleId,
            featureId,
          ))
        )
          throw missing();
  }
  private async lockModuleTask(
    tx: TransactionContext,
    input: TaskScope & { taskId?: number; version?: number },
    target: number[],
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await tx.sql`SAVEPOINT task_impact_locks`;
      const previous =
        input.taskId === undefined
          ? []
          : await this.repository.impacts(tx, input, input.taskId);
      const ids = [
        ...new Set([...target, ...previous.map((r) => r.featureId)]),
      ].sort((a, b) => a - b);
      for (const featureId of ids) {
        const check = await this.features.checkFeatureForWrite(tx, {
          projectId: input.projectId,
          moduleId: input.moduleId,
          featureId,
        });
        if (check.kind === "not-found") throw missing();
      }
      const before =
        input.taskId === undefined
          ? undefined
          : await this.repository.find(tx, input, input.taskId, true);
      if (input.taskId !== undefined && !before) throw missing();
      if (before && before.rowVersion !== input.version)
        throw new TaskManagementError(
          409,
          "TASK_VERSION_CONFLICT",
          "任务版本已变化，请重新加载后编辑",
        );
      const current =
        input.taskId === undefined
          ? []
          : await this.repository.impacts(tx, input, input.taskId);
      if (JSON.stringify(previous) === JSON.stringify(current)) {
        await tx.sql`RELEASE SAVEPOINT task_impact_locks`;
        return { before, previous };
      }
      await tx.sql`ROLLBACK TO SAVEPOINT task_impact_locks`;
      await tx.sql`RELEASE SAVEPOINT task_impact_locks`;
    }
    throw new TaskManagementError(
      409,
      "TASK_IMPACT_CONFLICT",
      "影响功能已变化，请重新加载后编辑",
    );
  }
  async execute(
    tx: TransactionContext,
    input: TaskScope & {
      operation: TaskOperation;
      actorId: number;
      taskId?: number;
      version?: number;
      edit: TaskEditRequest;
      requestId: string;
      impactFeatureIds?: number[];
      assignmentNotificationType?: "leftover.convert";
    },
  ): Promise<TaskRecord> {
    await this.authorize(tx, input.actorId, input, input.taskId);
    let before: TaskRecord | undefined;
    const target = input.impactFeatureIds ?? [];
    let previousImpacts: Awaited<
      ReturnType<TaskManagementRepository["impacts"]>
    > = [];
    if (input.featureId === null) {
      const locked = await this.lockModuleTask(tx, input, target);
      before = locked.before;
      previousImpacts = locked.previous;
    }
    if (
      input.operation === "updateTask" ||
      input.operation === "updateModuleTask"
    ) {
      before ??= await this.repository.find(tx, input, input.taskId!, true);
      if (!before) throw missing();
      if (before.rowVersion !== input.version)
        throw new TaskManagementError(
          409,
          "TASK_VERSION_CONFLICT",
          "任务版本已变化，请重新加载后编辑",
        );
      if (before.lifecycleStatus !== "ACTIVE")
        throw new TaskManagementError(
          409,
          "TASK_STATE_CONFLICT",
          "任务当前只读",
        );
    }
    const assigneeIds = input.edit.assigneeIds;
    const assigned =
      !before ||
      before.assigneeIds.length !== assigneeIds.length ||
      before.assigneeIds.some((userId, index) => userId !== assigneeIds[index]);
    // 多负责人平权：集合内每个人都必须是当前项目的活跃成员（ADR-040）。
    if (assigned)
      for (const userId of assigneeIds)
        if (
          (await this.members.checkAssignableMember(tx, {
            projectId: input.projectId,
            userId,
          })) !== "allowed"
        )
          throw new TaskManagementError(
            422,
            "TASK_ASSIGNEE_INVALID",
            "负责人必须是当前项目的活跃成员",
          );
    let result = before
      ? await this.repository.update(tx, before, input.edit)
      : await this.repository.create(
          tx,
          input,
          input.actorId,
          await this.codes.allocateTaskCode(tx, input.projectId),
          input.edit,
        );
    if (!result)
      throw new TaskManagementError(
        409,
        "TASK_VERSION_CONFLICT",
        "任务版本已变化，请重新加载后编辑",
      );
    if (input.featureId === null) {
      await this.repository.replaceImpacts(tx, result, target);
      result = (await this.repository.find(tx, input, result.id))!;
    }
    const afterImpacts =
      input.featureId === null
        ? await this.repository.impacts(tx, input, result.id)
        : [];
    const action = before ? "update" : "create";
    const event = await this.audit.append(tx, {
      projectId: result.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: `task.${action}`,
      targetType: "TASK",
      targetId: String(result.id),
      eventPayload: {
        before: before ?? null,
        after: result,
        ...(input.featureId === null
          ? {
              impactsBefore: previousImpacts,
              impactsAfter: afterImpacts,
              added: target.filter(
                (id) => !previousImpacts.some((r) => r.featureId === id),
              ),
              removed: previousImpacts
                .filter((r) => !target.includes(r.featureId))
                .map((r) => r.featureId),
            }
          : {}),
      },
      requestId: input.requestId,
    });
    await this.activity.append(tx, {
      projectId: result.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "TASK",
      sourceEntityId: result.id,
      activityType: `task.${action}`,
      actorId: input.actorId,
      summary: `任务${before ? "更新" : "创建"}：${result.title}`,
      metadata: {
        taskId: result.id,
        moduleId: result.moduleId,
        featureId: result.featureId,
      },
      visibilityScope: "MEMBER",
      sourceStatus: result.workStatus,
      sourceRowVersion: result.rowVersion,
      occurredAt: new Date(result.updatedAt),
    });
    await this.search.upsert(tx, {
      projectId: result.projectId,
      entityType: "TASK",
      entityId: result.id,
      moduleId: result.moduleId,
      featureId: result.featureId,
      recordId: null,
      title: result.title,
      summary: result.description.slice(0, 5000),
      rawText: `${result.code}\n${result.title}\n${result.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: result.workStatus,
      sourceRowVersion: result.rowVersion,
    });
    if (assigned) {
      // 只通知本次新增的负责人：留任者已持有任务，重复提醒会造成噪声（ADR-040）。
      const previousAssignees = new Set(before?.assigneeIds ?? []);
      for (const recipientId of assigneeIds.filter(
        (userId) => !previousAssignees.has(userId),
      ))
        await this.notifications.write(tx, {
          projectId: result.projectId,
          recipientId,
          sourceChainId: event.chainId,
          sourceSequence: event.sequenceNo,
          notificationType: input.assignmentNotificationType ?? "task.assigned",
          title: `任务指派：${result.title}`.slice(0, 500),
          body: result.code,
          targetPath:
            result.featureId === null
              ? `/projects/${result.projectId}/modules/${result.moduleId}/tasks?taskId=${result.id}`
              : `/projects/${result.projectId}/modules/${result.moduleId}/features/${result.featureId}?taskId=${result.id}`,
          createdAt: new Date(result.updatedAt),
        });
    }
    if (!before)
      await this.reopenMaintenanceProject(tx, input, result, "TASK_CREATED");
    return result;
  }

  /**
   * ADR-056 / ADR-057：任务重新变为未收尾（新建、重新打开或恢复）后，维护中项目
   * 就不再是「主体已完成、只做小修小补」，同一事务内回到进行中，并写审计、活动与
   * 搜索投影；未开始与进行中项目不变，因此重复调用不会反复推高项目版本。
   * 通知沿用 ADR-035 口径：不通知成员。
   */
  private async reopenMaintenanceProject(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly actorId: number;
      readonly requestId: string;
    },
    result: TaskRecord,
    trigger: "TASK_CREATED" | "TASK_REOPENED" | "TASK_RESTORED",
  ): Promise<void> {
    const reopened = await this.projects.reopenMaintenanceProject(tx, {
      projectId: input.projectId,
    });
    if (reopened === undefined) return;
    const occurredAt = new Date(result.updatedAt);
    const event = await this.audit.append(tx, {
      projectId: reopened.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.status.change",
      targetType: "PROJECT",
      targetId: String(reopened.projectId),
      eventPayload: {
        automatic: true,
        trigger,
        taskId: result.id,
        before: { status: "MAINTENANCE" },
        after: { status: reopened.status },
      },
      requestId: input.requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId: reopened.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "PROJECT",
      sourceEntityId: reopened.projectId,
      activityType: "PROJECT_STATUS_CHANGED",
      actorId: input.actorId,
      summary: `项目重新开工：${reopened.name} 由维护中回到进行中`,
      metadata: {
        code: reopened.code,
        trigger,
        taskId: result.id,
      },
      visibilityScope: "MEMBER",
      sourceStatus: reopened.status,
      sourceRowVersion: reopened.rowVersion,
      occurredAt,
    });
    await this.search.upsert(tx, {
      projectId: reopened.projectId,
      entityType: "PROJECT",
      entityId: reopened.projectId,
      moduleId: null,
      featureId: null,
      recordId: null,
      title: reopened.name,
      summary: reopened.description.slice(0, 5000),
      rawText: `${reopened.code} ${reopened.name} ${reopened.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: reopened.status,
      sourceRowVersion: reopened.rowVersion,
    });
  }

  async transition(
    tx: TransactionContext,
    input: TaskScope & {
      actorId: number;
      taskId: number;
      version: number;
      command: TaskStatusRequest;
      requestId: string;
    },
  ): Promise<TaskRecord> {
    const command = taskStatusRequestSchema.parse(input.command);
    await this.authorize(tx, input.actorId, input, input.taskId);
    // Current impact features are locked and rechecked, but never become MODULE parents.
    const before =
      input.featureId === null
        ? (await this.lockModuleTask(tx, input, [])).before
        : await this.repository.find(tx, input, input.taskId, true);
    if (!before) throw missing();
    if (before.rowVersion !== input.version)
      throw new TaskManagementError(
        409,
        "TASK_VERSION_CONFLICT",
        "任务版本已变化，请重新加载",
      );
    const transitions = {
      COMPLETE: ["TODO", "DONE"],
      REOPEN: ["DONE", "TODO"],
      CANCEL: ["TODO", "CANCELED"],
      RESTORE: ["CANCELED", "TODO"],
    } as const;
    const [from, to] = transitions[command.action];
    if (before.lifecycleStatus !== "ACTIVE" || before.workStatus !== from)
      throw new TaskManagementError(
        409,
        "TASK_STATE_CONFLICT",
        "任务当前状态不允许此操作",
      );
    const note =
      command.action === "COMPLETE"
        ? `${command.completionReason}，不涉及功能变化${command.note ? `：${command.note}` : ""}`
        : null;
    const reason =
      command.action === "COMPLETE" ? command.completionReason : command.reason;
    const result = await this.repository.transition(
      tx,
      before,
      input.actorId,
      to,
      note,
      reason,
    );
    if (!result)
      throw new TaskManagementError(
        409,
        "TASK_VERSION_CONFLICT",
        "任务版本已变化，请重新加载",
      );
    const labels = {
      COMPLETE: "完成",
      REOPEN: "重新打开",
      CANCEL: "取消",
      RESTORE: "恢复",
    };
    const action = `task.${command.action.toLowerCase()}`;
    const event = await this.audit.append(tx, {
      projectId: result.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "task.status",
      targetType: "TASK",
      targetId: String(result.id),
      eventPayload: { before, after: result, command, completionNote: note },
      requestId: input.requestId,
    });
    await this.activity.append(tx, {
      projectId: result.projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "TASK",
      sourceEntityId: result.id,
      activityType: action,
      actorId: input.actorId,
      summary: `任务${labels[command.action]}：${result.title}`,
      metadata: {
        taskId: result.id,
        moduleId: result.moduleId,
        featureId: result.featureId,
      },
      visibilityScope: "MEMBER",
      sourceStatus: result.workStatus,
      sourceRowVersion: result.rowVersion,
      occurredAt: new Date(result.updatedAt),
    });
    await this.search.upsert(tx, {
      projectId: result.projectId,
      entityType: "TASK",
      entityId: result.id,
      moduleId: result.moduleId,
      featureId: result.featureId,
      recordId: null,
      title: result.title,
      summary: result.description.slice(0, 5000),
      rawText: `${result.code}\n${result.title}\n${result.description}`,
      visibilityScope: "MEMBER",
      sourceStatus: result.workStatus,
      sourceRowVersion: result.rowVersion,
    });
    if (command.action === "COMPLETE" || command.action === "REOPEN") {
      const recipients = [
        ...new Set(
          command.action === "COMPLETE"
            ? [result.creatorId]
            : [...result.assigneeIds, result.creatorId],
        ),
      ].sort((a, b) => a - b);
      for (const recipientId of recipients)
        await this.notifications.write(tx, {
          projectId: result.projectId,
          recipientId,
          sourceChainId: event.chainId,
          sourceSequence: event.sequenceNo,
          notificationType: action,
          title: `任务${labels[command.action]}：${result.title}`.slice(0, 500),
          body: result.code,
          targetPath:
            result.featureId === null
              ? `/projects/${result.projectId}/modules/${result.moduleId}/tasks?taskId=${result.id}`
              : `/projects/${result.projectId}/modules/${result.moduleId}/features/${result.featureId}?taskId=${result.id}`,
          createdAt: new Date(result.updatedAt),
        });
    }
    // ADR-057：任务重新变为未收尾（重新打开 / 恢复）时维护中项目同样回到进行中；
    // 完成与取消不触发——它们不会让项目重新产生未收尾任务。
    if (command.action === "REOPEN" || command.action === "RESTORE")
      await this.reopenMaintenanceProject(
        tx,
        input,
        result,
        command.action === "REOPEN" ? "TASK_REOPENED" : "TASK_RESTORED",
      );
    return result;
  }
}

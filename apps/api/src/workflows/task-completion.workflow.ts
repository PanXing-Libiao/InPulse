import { Inject, Injectable } from "@nestjs/common";
import {
  taskCompletionRequestSchema,
  taskCompletionReplayContextSchema,
  type TaskCompletionRequest,
  type TaskCompletionResponse,
  type RecordDraftItem,
  type TaskCompletionReplayContext,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";
import { ModuleQueryPort } from "../modules/modules/index.js";
import { FeatureQueryPort } from "../modules/features/index.js";
import {
  TaskQueryPort,
  TaskCompletionCommandPort,
  TaskManagementError,
} from "../modules/tasks/index.js";
import { TaskBranchQueryPort } from "../modules/task-groups/index.js";
import {
  RecordDraftQueryPort,
  RecordDraftCommandPort,
  RecordPublicationCommandPort,
  RecordDraftError,
} from "../modules/change-records/index.js";
const missing = () =>
  new TaskManagementError(
    404,
    "TASK_COMPLETION_NOT_FOUND",
    "任务或记录不存在或无法访问",
  );
@Injectable()
export class TaskCompletionWorkflow {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(FeatureQueryPort) private readonly features: FeatureQueryPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(TaskBranchQueryPort) private readonly branches: TaskBranchQueryPort,
    @Inject(RecordDraftQueryPort)
    private readonly records: RecordDraftQueryPort,
    @Inject(RecordDraftCommandPort)
    private readonly drafts: RecordDraftCommandPort,
    @Inject(RecordPublicationCommandPort)
    private readonly publications: RecordPublicationCommandPort,
    @Inject(TaskCompletionCommandPort)
    private readonly completion: TaskCompletionCommandPort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}
  async authorize(
    tx: TransactionContext,
    actorId: number,
    taskId: number,
    requiresRecordWrite = false,
  ) {
    const source = await this.tasks.findByTaskId(tx, taskId);
    if (!source) throw missing();
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId: source.projectId,
    });
    if (project.kind === "not-found") throw missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId: source.projectId,
      capabilities: requiresRecordWrite
        ? ["taskLifecycle", "recordWrite"]
        : ["taskLifecycle"],
    });
    return source;
  }
  private async prepare(
    tx: TransactionContext,
    actorId: number,
    taskId: number,
    draftId?: number,
    replay?: TaskCompletionReplayContext,
    requiresRecordWrite = false,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await tx.sql`SAVEPOINT task_completion_locks`;
      const previous = await this.authorize(
        tx,
        actorId,
        taskId,
        requiresRecordWrite,
      );
      if (
        replay &&
        (previous.projectId !== replay.projectId ||
          previous.moduleId !== replay.moduleId ||
          previous.featureId !== replay.featureId)
      )
        throw missing();
      const record =
        draftId === undefined
          ? undefined
          : await this.records.findDraft(tx, previous.projectId, draftId);
      if (
        draftId !== undefined &&
        (!record ||
          record.moduleId !== previous.moduleId ||
          record.featureId !== previous.featureId ||
          record.scopeType !== previous.scopeType ||
          (record.taskId !== null && record.taskId !== taskId))
      )
        throw missing();
      const branch = await this.branches.find(tx, previous.projectId, taskId);
      // ADR-044/ADR-045：模块与功能都已无归档只读态，这里只保留归属校验与父级 FOR SHARE 取锁。
      const module = await this.modules.checkModuleForWrite(tx, previous);
      if (module.kind === "not-found") throw missing();
      const ids = [
        ...new Set([
          ...(previous.featureId === null
            ? previous.impactFeatureIds
            : [previous.featureId]),
          ...(record?.impactFeatureIds ?? []),
          ...(replay?.record?.impactFeatureIds ?? []),
          ...(replay?.impactFeatureIds ?? []),
        ]),
      ].sort((a, b) => a - b);
      for (const featureId of ids) {
        const feature = await this.features.checkFeatureForWrite(tx, {
          projectId: previous.projectId,
          moduleId: previous.moduleId,
          featureId,
        });
        if (feature.kind === "not-found") throw missing();
      }
      const source = await this.tasks.lock(tx, previous.projectId, taskId);
      const currentBranch = await this.branches.lock(
        tx,
        previous.projectId,
        taskId,
      );
      const lockedRecord =
        draftId === undefined
          ? undefined
          : await this.records.lockDraft(tx, previous.projectId, draftId);
      if (
        JSON.stringify(source) !== JSON.stringify(previous) ||
        JSON.stringify(branch) !== JSON.stringify(currentBranch) ||
        JSON.stringify(record) !== JSON.stringify(lockedRecord)
      ) {
        await tx.sql`ROLLBACK TO SAVEPOINT task_completion_locks`;
        await tx.sql`RELEASE SAVEPOINT task_completion_locks`;
        continue;
      }
      if (!source) throw missing();
      if (source.lifecycleStatus !== "ACTIVE")
        throw new TaskManagementError(409, "TASK_STATE_CONFLICT", "任务已无效");
      if (
        currentBranch?.role === "SOURCE" &&
        currentBranch.sourceKind === "HISTORICAL"
      )
        throw new TaskManagementError(
          409,
          "TASK_HISTORICAL_SOURCE",
          "历史分支不承接新的执行工作，请转到主任务",
        );
      await tx.sql`RELEASE SAVEPOINT task_completion_locks`;
      return { source, record: lockedRecord };
    }
    throw new TaskManagementError(
      409,
      "TASK_COMPLETION_CONFLICT",
      "任务、草稿或合并关系变化频繁，请重新加载",
    );
  }
  async execute(
    tx: TransactionContext,
    actorId: number,
    taskId: number,
    input: TaskCompletionRequest,
    requestId: string,
  ): Promise<TaskCompletionResponse> {
    const command = taskCompletionRequestSchema.parse(input);
    const requiresRecordWrite = command.mode === "WITH_RECORD";
    const { source, record } = await this.prepare(
      tx,
      actorId,
      taskId,
      "recordDraftId" in command ? command.recordDraftId : undefined,
      undefined,
      requiresRecordWrite,
    );
    if (source.rowVersion !== command.expectedRowVersion)
      throw new TaskManagementError(
        409,
        "TASK_VERSION_CONFLICT",
        "任务版本已变化，请加载最新任务",
      );
    if (source.workStatus !== "TODO")
      throw new TaskManagementError(
        409,
        "TASK_STATE_CONFLICT",
        "只有待办任务可以完成",
      );
    let draft: RecordDraftItem | undefined;
    if (command.mode === "WITH_RECORD") {
      if ("record" in command)
        draft = await this.drafts.createFromTask(
          tx,
          actorId,
          source,
          command.record,
          requestId,
        );
      else {
        if (!record || record.rowVersion !== command.recordExpectedRowVersion)
          throw new RecordDraftError(
            409,
            "RECORD_VERSION_CONFLICT",
            "草稿版本已变化，请加载最新草稿",
          );
        draft = await this.drafts.bindForCompletion(
          tx,
          actorId,
          source,
          record.id,
          command.recordExpectedRowVersion,
          requestId,
        );
      }
    }
    const authors = await this.records.authorsForTask(
      tx,
      source.projectId,
      source.taskId,
    );
    const task = await this.completion.complete(
      tx,
      actorId,
      source,
      command,
      authors,
      requestId,
    );
    const published = draft
      ? await this.publications.publish(
          tx,
          actorId,
          source.projectId,
          draft.id,
          draft.rowVersion,
          requestId,
        )
      : null;
    return { task, record: published };
  }
  async replay(
    tx: TransactionContext,
    actorId: number,
    taskId: number,
    context: unknown,
  ) {
    const saved = taskCompletionReplayContextSchema.parse(context);
    if (saved.taskId !== taskId) throw missing();
    await this.prepare(
      tx,
      actorId,
      taskId,
      undefined,
      saved,
      saved.record !== null,
    );
    if (saved.record) await this.publications.replay(tx, actorId, saved.record);
  }
}

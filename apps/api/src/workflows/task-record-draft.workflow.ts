import { UserReadPort } from "../auth/user-read.port.js";
import { Inject, Injectable } from "@nestjs/common";
import type { RecordDraftContent } from "@inpulse/api-contract";
import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";
import { ModuleQueryPort } from "../modules/modules/index.js";
import { FeatureQueryPort } from "../modules/features/index.js";
import { TaskQueryPort } from "../modules/tasks/index.js";
import {
  RecordDraftCommandPort,
  RecordDraftQueryPort,
  RecordDraftError,
} from "../modules/change-records/index.js";

export interface TaskDraftPath {
  projectId: number;
  moduleId: number;
  taskId: number;
  recordId?: number;
}
const missing = () =>
  new RecordDraftError(
    404,
    "RECORD_SOURCE_NOT_FOUND",
    "来源任务或草稿不存在或无法访问",
  );
@Injectable()
export class TaskRecordDraftWorkflow {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(FeatureQueryPort) private readonly features: FeatureQueryPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(RecordDraftQueryPort)
    private readonly records: RecordDraftQueryPort,
    @Inject(RecordDraftCommandPort)
    private readonly commands: RecordDraftCommandPort,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(UserReadPort) private readonly users: UserReadPort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}
  async read(actorId: number, path: TaskDraftPath) {
    const authorized = await this.access.getAuthorizedSearchScope(actorId);
    if (!authorized.projectIds.includes(path.projectId)) throw missing();
    return this.uow.run(async (tx) => {
      const source = await this.tasks.find(tx, path.projectId, path.taskId);
      if (!source || source.moduleId !== path.moduleId) throw missing();
      const [assignee] = await this.users.listByIds(tx, [source.assigneeId]);
      return {
        // 契约只暴露 TaskRecordDraftsResponse.source 的固定字段，额外读模型字段不得外泄。
        source: {
          taskId: source.taskId,
          projectId: source.projectId,
          moduleId: source.moduleId,
          featureId: source.featureId,
          scopeType: source.scopeType,
          title: source.title,
          assigneeId: source.assigneeId,
          assigneeName: assignee?.name ?? null,
          workStatus: source.workStatus,
          lifecycleStatus: source.lifecycleStatus,
          rowVersion: source.rowVersion,
          impactFeatureIds: source.impactFeatureIds,
        },
        items: await this.records.listForTask(tx, path.projectId, path.taskId),
      };
    });
  }
  async authorize(
    tx: TransactionContext,
    actorId: number,
    path: TaskDraftPath,
  ) {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId: path.projectId,
    });
    if (project.kind === "not-found") throw missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId: path.projectId,
      capabilities: ["recordWrite"],
    });
    const task = await this.tasks.find(tx, path.projectId, path.taskId);
    if (!task || task.moduleId !== path.moduleId) throw missing();
    // ADR-044：模块已无归档只读态；ADR-054：来源任务只有「无效」一种只读态。
    const module = await this.modules.checkModuleForWrite(tx, path);
    if (module.kind === "not-found") throw missing();
    if (task.lifecycleStatus !== "ACTIVE")
      throw new RecordDraftError(
        409,
        "RECORD_PARENT_ARCHIVED",
        "来源任务已无效，所属范围只读",
      );
  }
  private async prepare(
    tx: TransactionContext,
    actorId: number,
    path: TaskDraftPath,
  ) {
    await this.authorize(tx, actorId, path);
    for (let attempt = 0; attempt < 3; attempt++) {
      await tx.sql`SAVEPOINT record_source_locks`;
      const previous = await this.tasks.find(tx, path.projectId, path.taskId);
      if (!previous || previous.moduleId !== path.moduleId) throw missing();
      const record =
        path.recordId === undefined
          ? undefined
          : await this.records.findDraft(tx, path.projectId, path.recordId);
      if (
        path.recordId !== undefined &&
        (!record ||
          record.taskId !== path.taskId ||
          record.moduleId !== path.moduleId ||
          record.featureId !== previous.featureId)
      )
        throw missing();
      const ids = [
        ...new Set([
          ...(previous.featureId === null
            ? previous.impactFeatureIds
            : [previous.featureId]),
          ...(record?.impactFeatureIds ?? []),
        ]),
      ].sort((a, b) => a - b);
      for (const featureId of ids) {
        const feature = await this.features.checkFeatureForWrite(tx, {
          projectId: path.projectId,
          moduleId: path.moduleId,
          featureId,
        });
        if (feature.kind === "not-found") throw missing();
      }
      const source = await this.tasks.lock(tx, path.projectId, path.taskId);
      if (!source || source.moduleId !== path.moduleId) throw missing();
      if (JSON.stringify(source) !== JSON.stringify(previous)) {
        await tx.sql`ROLLBACK TO SAVEPOINT record_source_locks`;
        await tx.sql`RELEASE SAVEPOINT record_source_locks`;
        continue;
      }
      if (source.lifecycleStatus !== "ACTIVE")
        throw new RecordDraftError(
          409,
          "RECORD_PARENT_ARCHIVED",
          "来源任务已无效",
        );
      await tx.sql`RELEASE SAVEPOINT record_source_locks`;
      return { source, record };
    }
    throw new RecordDraftError(
      409,
      "RECORD_SOURCE_CONFLICT",
      "来源任务变化频繁，请重新加载",
    );
  }
  async execute(
    tx: TransactionContext,
    actorId: number,
    path: TaskDraftPath,
    version: number,
    input: Omit<RecordDraftContent, "title"> & { title: string | null },
    requestId: string,
  ) {
    const { source, record } = await this.prepare(tx, actorId, path);
    if (path.recordId === undefined) {
      if (source.rowVersion !== version)
        throw new RecordDraftError(
          409,
          "RECORD_SOURCE_VERSION_CONFLICT",
          "来源任务版本已变化，请加载最新任务",
        );
      return this.commands.createFromTask(
        tx,
        actorId,
        source,
        { ...input, title: input.title ?? source.title },
        requestId,
      );
    }
    if (!record || record.rowVersion !== version)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本已变化，请加载最新内容后合并",
      );
    return this.commands.updateFromTask(
      tx,
      actorId,
      source,
      record.id,
      version,
      { ...input, title: input.title ?? record.title },
      requestId,
    );
  }
  async replay(
    tx: TransactionContext,
    actorId: number,
    path: TaskDraftPath,
    context: {
      projectId: number;
      recordId: number;
      moduleId: number;
      taskId: number | null;
      impactFeatureIds: readonly number[];
    },
  ) {
    if (
      context.projectId !== path.projectId ||
      context.moduleId !== path.moduleId ||
      context.taskId !== path.taskId
    )
      throw missing();
    // Saved impact resources are immutable within F-17. Prepare checks their current identity,
    // the true parent, task, and current draft before exposing the cached response.
    const { record } = await this.prepare(tx, actorId, {
      ...path,
      recordId: context.recordId,
    });
    if (
      !record ||
      JSON.stringify(record.impactFeatureIds) !==
        JSON.stringify(context.impactFeatureIds)
    )
      throw missing();
  }
}

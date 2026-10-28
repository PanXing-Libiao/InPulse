import { Inject, Injectable } from "@nestjs/common";
import {
  schemaRegistry,
  type LeftoverTaskRequest,
  type PublishedRecord,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";
import { ModuleQueryPort } from "../modules/modules/index.js";
import {
  FeatureQueryPort,
  FeatureReadPort,
} from "../modules/features/index.js";
import {
  TaskQueryPort,
  FollowupTaskCommandPort,
} from "../modules/tasks/index.js";
import {
  LeftoverRecordCommandPort,
  LeftoverSearchProjectionSync,
  RecordDraftError,
} from "../modules/change-records/index.js";
import { AuditWritePort } from "../audit/index.js";
import { ActivityWritePort } from "../modules/activity/index.js";
import { SearchProjectionWritePort } from "../modules/search/index.js";
export class LeftoverTaskError extends RecordDraftError {
  constructor(
    status: 404 | 409 | 422,
    code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(status, code, message);
  }
}
const missing = () =>
  new LeftoverTaskError(
    404,
    "LEFTOVER_NOT_FOUND",
    "记录、遗留项或任务不存在或无法访问",
  );
const taskDescriptionLimit = 50000;
const taskDescriptionDivider = "—————————";
/**
 * 2026-09-30 产品口径 A：用户补的任务说明放在最前，来源记录、遗留项编号与遗留原文
 * 继续由服务端拼在其后，转换前后的留痕口径不变。两者共用同一个说明字段，
 * 合计超过 tasks_description_check 的 50000 上限时必须在写库前给出 422。
 */
function composeTaskDescription(
  authored: string | undefined,
  recordTitle: string,
  recordCode: string,
  recordVersion: number,
  leftoverItemId: number,
  content: string,
): string {
  const source = `来源记录：${recordTitle}（${recordCode} v${recordVersion}）\n遗留项 #${leftoverItemId}\n\n${content}`;
  const note = authored?.trim();
  if (!note) return source;
  const composed = `${note}\n\n${taskDescriptionDivider}\n${source}`;
  if (composed.length > taskDescriptionLimit)
    throw new LeftoverTaskError(
      422,
      "LEFTOVER_TASK_DESCRIPTION_TOO_LONG",
      "任务说明加上来源记录与遗留原文后超过 50000 字，请缩短说明",
    );
  return composed;
}
@Injectable()
export class LeftoverTaskWorkflow {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(FeatureQueryPort) private readonly features: FeatureQueryPort,
    @Inject(FeatureReadPort) private readonly featureRead: FeatureReadPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(FollowupTaskCommandPort)
    private readonly createTask: FollowupTaskCommandPort,
    @Inject(LeftoverRecordCommandPort)
    private readonly records: LeftoverRecordCommandPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(LeftoverSearchProjectionSync)
    private readonly leftovers: LeftoverSearchProjectionSync,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}
  async authorize(tx: TransactionContext, actorId: number, projectId: number) {
    const check = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (check.kind === "not-found") throw missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities: ["recordWrite"],
    });
  }
  private leftoverItem(
    record: PublishedRecord,
    leftoverItemId: number | undefined,
  ) {
    if (leftoverItemId !== undefined)
      return record.leftovers.find(
        (leftover) => leftover.id === leftoverItemId,
      );
    if (record.leftovers.length === 0) throw missing();
    if (record.leftovers.length > 1)
      throw new LeftoverTaskError(
        409,
        "LEFTOVER_SELECTION_REQUIRED",
        "记录包含多条遗留问题，请指定要处理的遗留项",
        {
          leftoverItemIds: record.leftovers.map((leftover) => leftover.id),
        },
      );
    return record.leftovers[0];
  }
  /**
   * 指定条目已不在当前正式版本快照中时的处理：仍属于本记录说明已被移除，
   * 按 LEFTOVER_NOT_ACTIVE 拒绝；完全不存在或不属于本记录返回 undefined，
   * 由调用方按 404 处理，不泄露条目存在性。
   */
  private async removedItem(
    tx: TransactionContext,
    p: number,
    r: number,
    leftoverItemId: number | undefined,
  ) {
    if (leftoverItemId === undefined) return undefined;
    if (await this.records.lockItem(tx, p, r, leftoverItemId))
      throw new LeftoverTaskError(
        409,
        "LEFTOVER_NOT_ACTIVE",
        "当前正式版本没有可转换的遗留问题",
      );
    return undefined;
  }
  private async prepare(
    tx: TransactionContext,
    actorId: number,
    p: number,
    r: number,
    resultImpacts: number[] = [],
    leftoverItemId?: number,
  ) {
    await this.authorize(tx, actorId, p);
    for (let attempt = 0; attempt < 3; attempt++) {
      await tx.sql`SAVEPOINT leftover_parent_locks`;
      const before = await this.records.find(tx, p, r);
      if (!before) throw missing();
      // ADR-044/ADR-045：模块与功能都已无归档只读态，这里只保留归属校验与父级 FOR SHARE 取锁。
      const module = await this.modules.checkModuleForWrite(tx, before);
      if (module.kind === "not-found") throw missing();
      const inherited: { id: number; name: string }[] = [];
      const ids = [
        ...new Set([
          ...(before.featureId === null
            ? before.impactFeatureIds
            : [before.featureId]),
          ...resultImpacts,
        ]),
      ].sort((a, b) => a - b);
      for (const id of ids) {
        const check = await this.features.checkFeatureForWrite(tx, {
          projectId: p,
          moduleId: before.moduleId,
          featureId: id,
        });
        if (check.kind === "not-found") throw missing();
        const feature = await this.featureRead.find(tx, p, before.moduleId, id);
        if (!feature) throw missing();
        if (before.featureId === null && before.impactFeatureIds.includes(id))
          inherited.push({ id, name: feature.name });
      }
      const record = await this.records.lock(tx, p, r);
      if (!record) throw missing();
      if (
        record.moduleId !== before.moduleId ||
        record.featureId !== before.featureId ||
        JSON.stringify(record.impactFeatureIds) !==
          JSON.stringify(before.impactFeatureIds)
      ) {
        await tx.sql`ROLLBACK TO SAVEPOINT leftover_parent_locks`;
        await tx.sql`RELEASE SAVEPOINT leftover_parent_locks`;
        continue;
      }
      const target = this.leftoverItem(record, leftoverItemId),
        item = target
          ? await this.records.lockItem(tx, p, r, target.id)
          : await this.removedItem(tx, p, r, leftoverItemId);
      if (!item) throw missing();
      await tx.sql`RELEASE SAVEPOINT leftover_parent_locks`;
      return { record, item, inherited };
    }
    throw new LeftoverTaskError(
      409,
      "LEFTOVER_SCOPE_CONFLICT",
      "记录影响集合已变化，请刷新确认",
    );
  }
  private async taskReference(
    tx: TransactionContext,
    actorId: number,
    record: PublishedRecord,
    taskId: number,
  ) {
    const task = await this.tasks.find(tx, record.projectId, taskId);
    if (
      !task ||
      task.moduleId !== record.moduleId ||
      task.featureId !== record.featureId
    )
      throw missing();
    await this.authorize(tx, actorId, task.projectId);
    return {
      projectId: task.projectId,
      moduleId: task.moduleId,
      featureId: task.featureId,
      taskId,
    };
  }
  async preview(
    tx: TransactionContext,
    actorId: number,
    p: number,
    r: number,
    leftoverItemId?: number,
  ) {
    const { record, item, inherited } = await this.prepare(
      tx,
      actorId,
      p,
      r,
      [],
      leftoverItemId,
    );
    return {
      recordId: r,
      recordVersion: record.currentVersion,
      rowVersion: record.rowVersion,
      leftoverItemId: item.id,
      leftoverRowVersion: item.rowVersion,
      status: item.status,
      content: record.leftovers.find((l) => l.id === item.id)?.content ?? "",
      inheritedImpacts: inherited,
      linkedTask:
        item.linkedTaskId === null
          ? null
          : await this.taskReference(tx, actorId, record, item.linkedTaskId),
    };
  }
  async execute(
    tx: TransactionContext,
    actorId: number,
    p: number,
    r: number,
    input: LeftoverTaskRequest,
    requestId: string,
  ) {
    const { record, item, inherited } = await this.prepare(
      tx,
      actorId,
      p,
      r,
      [],
      input.leftoverItemId,
    );
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId: p,
      capabilities: ["taskEdit"],
    });
    if (item.id !== input.leftoverItemId) throw missing();
    if (item.linkedTaskId !== null)
      throw new LeftoverTaskError(
        409,
        "LEFTOVER_ALREADY_CONVERTED",
        "遗留项已转为任务",
        {
          task: await this.taskReference(
            tx,
            actorId,
            record,
            item.linkedTaskId,
          ),
        },
      );
    const content = record.leftovers.find((l) => l.id === item.id)?.content;
    if (
      record.currentVersion !== input.recordVersion ||
      record.rowVersion !== input.expectedRowVersion ||
      item.rowVersion !== input.leftoverExpectedRowVersion
    )
      throw new LeftoverTaskError(
        409,
        "LEFTOVER_VERSION_CONFLICT",
        "记录或遗留项版本已变化，请刷新确认",
      );
    if (item.status !== "ACTIVE" || !content)
      throw new LeftoverTaskError(
        409,
        "LEFTOVER_NOT_ACTIVE",
        "当前正式版本没有可转换的遗留问题",
      );
    const impactFeatureIds = inherited.map((f) => f.id);
    if (
      JSON.stringify(
        [...input.expectedImpactFeatureIds].sort((a, b) => a - b),
      ) !== JSON.stringify(impactFeatureIds)
    )
      throw new LeftoverTaskError(
        409,
        "LEFTOVER_IMPACTS_CHANGED",
        "继承的影响功能已变化，请刷新预览并确认",
      );
    const task = await this.createTask.create(
      tx,
      actorId,
      {
        projectId: p,
        moduleId: record.moduleId,
        featureId: record.featureId,
        impactFeatureIds,
      },
      {
        title: input.title,
        assigneeIds: input.assigneeIds,
        priority: input.priority,
        dueAt: input.dueAt,
        description: composeTaskDescription(
          input.description,
          record.title,
          record.code,
          record.currentVersion,
          item.id,
          content,
        ),
      },
      requestId,
    );
    await this.records.convert(tx, record, item, task.id, actorId);
    const event = await this.audit.append(tx, {
      projectId: p,
      actorType: "USER",
      actorId,
      action: "leftover.convert",
      targetType: "CHANGE_RECORD",
      targetId: String(r),
      eventPayload: {
        recordId: r,
        recordVersion: record.currentVersion,
        leftoverItemId: item.id,
        taskId: task.id,
        contentSnapshot: content,
        sourceImpactFeatureIds: record.impactFeatureIds,
        inheritedImpactFeatureIds: impactFeatureIds,
        before: { status: item.status, rowVersion: item.rowVersion },
        after: { status: "CONVERTED", rowVersion: item.rowVersion + 1 },
      },
      requestId,
    });
    await this.activity.append(tx, {
      projectId: p,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "CHANGE_RECORD",
      sourceEntityId: r,
      activityType: "leftover.convert",
      actorId,
      summary: `遗留问题已转任务：${task.title}`,
      metadata: { recordId: r, taskId: task.id, leftoverItemId: item.id },
      visibilityScope: "MEMBER",
      sourceStatus: "PUBLISHED",
      sourceRowVersion: record.rowVersion + 1,
      occurredAt: new Date(task.createdAt),
    });
    await this.search.upsert(tx, {
      projectId: p,
      entityType: "CHANGE_RECORD",
      entityId: r,
      moduleId: null,
      featureId: null,
      recordId: null,
      title: record.title,
      summary: record.changeSolution.slice(0, 5000),
      rawText: [
        record.code,
        record.title,
        record.contextProblem,
        record.changeSolution,
        record.resultVerification,
        ...record.remainingIssues.map((entry) => entry.content),
      ].join("\n"),
      visibilityScope: "MEMBER",
      sourceStatus: "PUBLISHED",
      sourceRowVersion: record.rowVersion + 1,
    });
    await this.leftovers.syncRecord(tx, record);
    return {
      projectId: p,
      moduleId: record.moduleId,
      featureId: record.featureId,
      taskId: task.id,
      recordId: r,
      leftoverItemId: item.id,
      recordVersion: record.currentVersion,
      recordRowVersion: record.rowVersion + 1,
      leftoverRowVersion: item.rowVersion + 1,
      impactFeatureIds,
    };
  }
  async replay(
    tx: TransactionContext,
    actorId: number,
    p: number,
    r: number,
    context: unknown,
  ) {
    const saved =
      schemaRegistry.LeftoverTaskReplayContext.schema.parse(context);
    if (saved.projectId !== p || saved.recordId !== r) throw missing();
    const { record, item } = await this.prepare(
      tx,
      actorId,
      p,
      r,
      saved.impactFeatureIds,
    );
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId: p,
      capabilities: ["taskEdit"],
    });
    if (
      item.id !== saved.leftoverItemId ||
      item.status !== "CONVERTED" ||
      item.linkedTaskId !== saved.taskId ||
      record.moduleId !== saved.moduleId ||
      record.featureId !== saved.featureId
    )
      throw missing();
    await this.taskReference(tx, actorId, record, saved.taskId);
    await this.createTask.replay(tx, actorId, saved, saved.taskId);
  }
  async source(tx: TransactionContext, actorId: number, taskId: number) {
    const task = await this.tasks.findByTaskId(tx, taskId);
    if (!task) throw missing();
    await this.authorize(tx, actorId, task.projectId);
    const source = await this.records.source(tx, task.projectId, taskId);
    if (source) {
      const record = await this.records.find(
        tx,
        source.projectId,
        source.recordId,
      );
      if (!record) throw missing();
      await this.taskReference(tx, actorId, record, taskId);
    }
    return { source };
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { AuditWritePort } from "../audit/index.js";
import type { TransactionContext } from "../database/transaction-context.js";
import { PostgresUnitOfWork } from "../database/unit-of-work.js";
import { ActivityWritePort } from "../modules/activity/index.js";
import {
  ModuleDeletionCommandPort,
  moduleDeletionMissing,
  moduleDeletionVersionConflict,
  moduleUnclassifiedProtected,
} from "../modules/modules/module-deletion.command-port.js";
import type { ModuleHardDeletedRow } from "../modules/modules/module-management.repository.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";

/** ADR-096：删除模块的响应，字段与 ModuleDeletionResponse 契约一一对应。 */
export interface ModuleDeletionResult {
  readonly id: number;
  readonly projectId: number;
  readonly code: string;
  readonly name: string;
  readonly kind: ModuleHardDeletedRow["kind"];
  readonly deletedTaskCount: number;
  readonly deletedRecordCount: number;
  readonly removedLinkCount: number;
}

const DEFAULT_MODULE_REASON = "模块已被删除";

/**
 * ADR-096 / ADR-109：删除模块的跨域编排。数据库窄口函数在同一事务内完成
 * 全部物理级联：模块删除包含其下全部任务、迭代记录与下级数据。
 *
 * 工作流只追加一条顶层 module.delete 事件和项目动态，不再为级联任务逐条
 * 伪造删除事件，也不保留记录快照。
 */
@Injectable()
export class ScopeDeletionWorkflow {
  constructor(
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleDeletionCommandPort)
    private readonly modules: ModuleDeletionCommandPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
  ) {}

  async deleteModule(
    actorId: number,
    projectId: number,
    moduleId: number,
    expectedRowVersion: number,
    reason: string | null,
    requestId: string,
  ): Promise<ModuleDeletionResult> {
    const deletionReason = reason?.trim()
      ? reason.trim()
      : DEFAULT_MODULE_REASON;
    return this.uow.run(async (tx) => {
      await this.modules.authorize(tx, actorId, projectId);
      if (!(await this.lockProject(tx, actorId, projectId)))
        throw moduleDeletionMissing();
      const current = await this.modules.findForDeletion(
        tx,
        projectId,
        moduleId,
        true,
      );
      if (!current) throw moduleDeletionMissing();
      if (current.kind !== "NORMAL") throw moduleUnclassifiedProtected();
      if (current.rowVersion !== expectedRowVersion)
        throw moduleDeletionVersionConflict();

      const deleted = await this.modules.hardDelete(
        tx,
        current,
        actorId,
        deletionReason,
      );
      if (!deleted) throw moduleDeletionVersionConflict();
      const occurredAt = new Date(deleted.deletedAt);
      const event = await this.audit.append(tx, {
        projectId,
        actorType: "USER",
        actorId,
        action: "module.delete",
        targetType: "MODULE",
        targetId: String(moduleId),
        eventPayload: {
          moduleId,
          code: deleted.code,
          name: deleted.name,
          kind: deleted.kind,
          deletedTaskCount: deleted.deletedTaskCount,
          deletedRecordCount: deleted.deletedRecordCount,
          removedLinkCount: deleted.removedLinkCount,
          reason: deletionReason,
        },
        requestId,
      });
      const visibility = {
        projectId,
        sourceEntityType: "MODULE" as const,
        sourceEntityId: moduleId,
        visibilityScope: "MEMBER" as const,
        sourceStatus: "DELETED",
        sourceRowVersion: current.rowVersion + 1,
      };
      await this.activity.updateEntityVisibility(tx, visibility);
      await this.activity.append(tx, {
        ...visibility,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        activityType: "MODULE_DELETED",
        actorId,
        summary: "删除模块：" + deleted.name,
        metadata: {
          moduleId,
          code: deleted.code,
          kind: deleted.kind,
          deletedTaskCount: deleted.deletedTaskCount,
          deletedRecordCount: deleted.deletedRecordCount,
          removedLinkCount: deleted.removedLinkCount,
        },
        occurredAt,
      });
      return {
        id: deleted.id,
        projectId: deleted.projectId,
        code: deleted.code,
        name: deleted.name,
        kind: deleted.kind,
        deletedTaskCount: deleted.deletedTaskCount,
        deletedRecordCount: deleted.deletedRecordCount,
        removedLinkCount: deleted.removedLinkCount,
      };
    });
  }

  /**
   * 项目行的 FOR SHARE：与其它写命令一致地在最外层先锁项目，再锁下级。
   * 未命中时返回 false，由调用方抛出与自身资源一致的 404。
   */
  private async lockProject(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
  ): Promise<boolean> {
    const check = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    return check.kind !== "not-found";
  }
}

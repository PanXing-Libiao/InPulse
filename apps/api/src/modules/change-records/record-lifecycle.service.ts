import { Inject, Injectable } from "@nestjs/common";
import { schemaRegistry } from "@inpulse/api-contract";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { ModuleQueryPort } from "../modules/index.js";
import { AuditWritePort } from "../../audit/index.js";
import { ActivityWritePort } from "../activity/index.js";
import { SearchProjectionWritePort } from "../search/index.js";
import { PublishedRecordRepository } from "./published-record.repository.js";
import { RecordPublicationRepository } from "./record-publication.repository.js";
import { RecordLifecycleRepository } from "./record-lifecycle.repository.js";
import { RecordDraftError } from "./record-drafts.service.js";
import { validatePublishedRecordSearch } from "./record-publication-effects.js";
import { LeftoverSearchProjectionSync } from "./leftover-search-projection.js";
/** 作废后的记录快照：副作用链需要状态、版本与正文，因此复用作废读路径的返回类型。 */
type VoidedRecordSnapshot = NonNullable<
  Awaited<ReturnType<PublishedRecordRepository["findVoided"]>>
>;
/** 副作用链同时服务作废与恢复，恢复读的是已发布视图，因此两个快照都可接受。 */
type LifecycleRecordSnapshot =
  | VoidedRecordSnapshot
  | NonNullable<Awaited<ReturnType<PublishedRecordRepository["find"]>>>;
const missing = () =>
  new RecordDraftError(404, "CHANGE_RECORD_NOT_FOUND", "记录不存在或无法访问");
const conflict = () =>
  new RecordDraftError(
    409,
    "RECORD_STATE_CONFLICT",
    "记录状态或版本已变化，请刷新后重试",
  );
@Injectable()
export class RecordLifecycleService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(RecordPublicationRepository)
    private readonly identities: RecordPublicationRepository,
    @Inject(PublishedRecordRepository)
    private readonly records: PublishedRecordRepository,
    @Inject(RecordLifecycleRepository)
    private readonly repository: RecordLifecycleRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(LeftoverSearchProjectionSync)
    private readonly leftovers: LeftoverSearchProjectionSync,
  ) {}
  async replay(tx: TransactionContext, actorId: number, context: unknown) {
    const { projectId, recordId } =
      schemaRegistry.RecordLifecycleReplayContext.schema.parse(context);
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (project.kind === "not-found") throw missing();
    if (!project.resource.isSystemAdmin)
      throw new RecordDraftError(403, "ADMIN_REQUIRED", "仅管理员可以操作");
    const record = await this.identities.identity(tx, projectId, recordId);
    if (!record || !["PUBLISHED", "VOID"].includes(record.status))
      throw missing();
    // Replay exposes only identity and the original status; archived parents remain readable.
  }
  async transition(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    expectedVersion: number,
    restore: boolean,
    input: unknown,
    requestId: string,
    reauthorize: () => Promise<number>,
  ) {
    const parsed =
      schemaRegistry.RecordLifecycleRequest.schema.safeParse(input);
    if (!parsed.success)
      throw new RecordDraftError(
        422,
        "RECORD_REASON_REQUIRED",
        "请填写非空原因",
      );
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (project.kind === "not-found") throw missing();
    if (!project.resource.isSystemAdmin)
      throw new RecordDraftError(403, "ADMIN_REQUIRED", "仅管理员可以操作");
    const before = await this.identities.identity(tx, projectId, recordId);
    if (!before) throw missing();
    // ADR-044/ADR-109：模块无归档只读态，这里只保留归属校验与父级 FOR SHARE 取锁。
    const module = await this.modules.checkModuleForWrite(tx, {
      projectId,
      moduleId: before.moduleId,
    });
    if (module.kind === "not-found") throw missing();
    const locked = await this.identities.identity(
      tx,
      projectId,
      recordId,
      true,
    );
    if (!locked) throw missing();
    if (
      locked.moduleId !== before.moduleId ||
      locked.status !== (restore ? "VOID" : "PUBLISHED") ||
      locked.rowVersion !== expectedVersion
    )
      throw conflict();
    if ((await reauthorize()) !== actorId)
      throw new RecordDraftError(403, "ADMIN_REQUIRED", "当前管理员身份已变化");
    if (
      !(await this.repository.transition(
        tx,
        projectId,
        recordId,
        expectedVersion,
        restore,
        parsed.data.reason,
      ))
    )
      throw conflict();
    const after = restore
      ? await this.records.find(tx, projectId, recordId)
      : await this.records.findVoided(tx, projectId, recordId);
    if (!after) throw conflict();
    await this.applyLifecycleEffects(tx, {
      projectId,
      recordId,
      actorId,
      requestId,
      restore,
      reason: parsed.data.reason,
      lockedStatus: locked.status,
      lockedRowVersion: locked.rowVersion,
      after,
    });
    return schemaRegistry.RecordLifecycleResult.schema.parse({
      id: after.id,
      projectId: after.projectId,
      status: after.status,
      rowVersion: after.rowVersion,
    });
  }

  /** 作废/恢复共用的副作用链：审计、动态可见性与条目、搜索投影、遗留项投影。 */
  private async applyLifecycleEffects(
    tx: TransactionContext,
    input: {
      readonly projectId: number;
      readonly recordId: number;
      readonly actorId: number;
      readonly requestId: string;
      readonly restore: boolean;
      readonly reason: string;
      readonly lockedStatus: string;
      readonly lockedRowVersion: number;
      readonly after: LifecycleRecordSnapshot;
    },
  ): Promise<void> {
    const { after, restore } = input;
    const action = restore ? "CHANGE_RECORD_RESTORED" : "CHANGE_RECORD_VOIDED";
    const event = await this.audit.append(tx, {
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action,
      targetType: "CHANGE_RECORD",
      targetId: String(input.recordId),
      eventPayload: {
        before: {
          status: input.lockedStatus,
          rowVersion: input.lockedRowVersion,
        },
        after: { status: after.status, rowVersion: after.rowVersion },
        reason: input.reason,
      },
      requestId: input.requestId,
    });
    const visibility = {
      projectId: input.projectId,
      sourceEntityType: "CHANGE_RECORD" as const,
      sourceEntityId: input.recordId,
      visibilityScope: restore ? ("MEMBER" as const) : ("ADMIN_ONLY" as const),
      sourceStatus: after.status,
      sourceRowVersion: after.rowVersion,
    };
    await this.activity.updateEntityVisibility(tx, visibility);
    await this.activity.append(tx, {
      ...visibility,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      activityType: action,
      actorId: input.actorId,
      summary: `${restore ? "恢复" : "作废"}迭代记录：${after.title}`,
      metadata: {
        recordId: input.recordId,
        moduleId: after.moduleId,
        version: after.currentVersion,
      },
      occurredAt: new Date(after.updatedAt),
    });
    await this.search.upsert(tx, {
      ...validatePublishedRecordSearch(after),
      visibilityScope: visibility.visibilityScope,
      sourceStatus: after.status,
    });
    await this.leftovers.syncRecord(tx, after);
  }
}

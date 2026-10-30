import { Inject, Injectable } from "@nestjs/common";
import type {
  RecordDraftCommandPort,
  RecordDraftQueryPort,
  RecordSourceSnapshot,
} from "./record-draft.port.js";
import {
  RECORD_PAGE_LIMIT_DEFAULT,
  recordDraftReplayContextSchema,
  type IndependentRecordDraftRequest,
  type RecordDraftContent,
  type RecordDraftDeleteResult,
  type RecordDraftItem,
  type RecordDraftPage,
} from "@inpulse/api-contract";
import {
  TimeCursorError,
  TimeCursorService,
  type TimeCursorValue,
} from "../../cursors/time-cursor.js";
import { AuditWritePort } from "../../audit/index.js";
import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { ModuleQueryPort, ModuleReadPort } from "../modules/index.js";
import {
  RecordDraftRepository,
  type DraftScope,
} from "./record-draft.repository.js";

const RECORD_DRAFT_LIST_NAMESPACE = "RECORD_DRAFTS";

/** B-1 草稿列表分页参数：limit 1..100 默认 20，cursor 为服务端签名游标。 */
export interface RecordDraftListCommand {
  readonly cursor?: string;
  readonly limit?: number;
  /** 只看某个作者创建的草稿（项目草稿区传当前用户）；省略返回项目内全部草稿。 */
  readonly authorId?: number;
}

/** 作者过滤进入游标绑定：同一游标换作者或去掉作者都按筛选不匹配拒绝。 */
const draftListFilterKey = (authorId: number | undefined): string | null =>
  authorId === undefined ? null : `authorId=${authorId}`;

export class RecordDraftError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missing = () =>
  new RecordDraftError(
    404,
    "RECORD_DRAFT_NOT_FOUND",
    "草稿或所属范围不存在或无法访问",
  );
@Injectable()
export class RecordDraftsService
  implements RecordDraftCommandPort, RecordDraftQueryPort
{
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(ModuleReadPort) private readonly moduleRead: ModuleReadPort,
    @Inject(RecordDraftRepository)
    private readonly repository: RecordDraftRepository,
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(TimeCursorService) private readonly cursor: TimeCursorService,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}
  /**
   * 草稿列表分页（B-1 / C-006）：items / nextCursor / hasMore；签名游标绑定
   * actor、命名空间与项目，15 分钟过期，失效统一 422；草稿详情读取不变。
   */
  async read(
    actorId: number,
    projectId: number,
    recordId?: number,
    page: RecordDraftListCommand = {},
  ): Promise<RecordDraftItem | RecordDraftPage> {
    const authorized = await this.access.getAuthorizedSearchScope(actorId);
    if (!authorized.projectIds.includes(projectId)) throw missing();
    if (recordId !== undefined)
      return this.uow.run(async (tx) => {
        const item = await this.repository.find(tx, projectId, recordId);
        if (!item) throw missing();
        return (await this.withNames(tx, [item]))[0]!;
      });
    const limit = page.limit ?? RECORD_PAGE_LIMIT_DEFAULT;
    const filterKey = draftListFilterKey(page.authorId);
    const after = this.decodeListCursor(
      page.cursor,
      actorId,
      projectId,
      filterKey,
    );
    return this.uow.run(async (tx) => {
      const result = await this.repository.listPage(tx, {
        projectId,
        limit,
        after,
        ...(page.authorId === undefined ? {} : { authorId: page.authorId }),
      });
      return {
        items: await this.withNames(tx, result.items),
        hasMore: result.hasMore,
        nextCursor:
          result.last === null
            ? null
            : this.cursor.encode({
                actorUserId: actorId,
                namespace: RECORD_DRAFT_LIST_NAMESPACE,
                projectId,
                afterAt: result.last.at,
                afterId: result.last.id,
                filterKey,
              }),
      };
    });
  }
  private async withNames(
    tx: TransactionContext,
    items: readonly RecordDraftItem[],
  ) {
    const projectIds = [...new Set(items.map((item) => item.projectId))];
    const moduleNames = await this.moduleRead.listNames(tx, {
      projectIds,
      moduleIds: [...new Set(items.map((item) => item.moduleId))],
    });
    return items.map((item) => ({
      ...item,
      moduleName:
        moduleNames.find(
          (m) => m.projectId === item.projectId && m.moduleId === item.moduleId,
        )?.name ?? null,
    }));
  }

  private decodeListCursor(
    cursor: string | undefined,
    actorId: number,
    projectId: number,
    filterKey: string | null,
  ): TimeCursorValue | null {
    try {
      return this.cursor.decode(cursor, {
        actorUserId: actorId,
        namespace: RECORD_DRAFT_LIST_NAMESPACE,
        projectId,
        filterKey,
      });
    } catch (error) {
      if (error instanceof TimeCursorError)
        throw new RecordDraftError(
          422,
          "INVALID_CURSOR",
          "游标无效、已过期或与当前筛选条件不匹配",
        );
      throw error;
    }
  }
  async lockDraft(tx: TransactionContext, projectId: number, recordId: number) {
    // Re-read relationships in a separate READ COMMITTED statement after waiting for the row.
    const locked = await this.repository.find(tx, projectId, recordId, true);
    return locked ? this.repository.find(tx, projectId, recordId) : undefined;
  }
  async authorsForTask(
    tx: TransactionContext,
    projectId: number,
    taskId: number,
  ) {
    return this.repository.authorsForTask(tx, projectId, taskId);
  }
  async bindForCompletion(
    tx: TransactionContext,
    actorId: number,
    source: RecordSourceSnapshot,
    recordId: number,
    version: number,
    requestId: string,
  ) {
    const before = await this.lockDraft(tx, source.projectId, recordId);
    if (
      !before ||
      before.moduleId !== source.moduleId ||
      (before.taskId !== null && before.taskId !== source.taskId)
    )
      throw missing();
    if (before.rowVersion !== version)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本已变化，请重新选择最新草稿",
      );
    if (before.taskId === source.taskId) return before;
    const after = await this.repository.bindSource(tx, before, source.taskId);
    if (!after)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿关联或版本已变化",
      );
    await this.appendAudit(tx, actorId, before, after, requestId);
    return after;
  }
  async authorize(tx: TransactionContext, actorId: number, scope: DraftScope) {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId: scope.projectId,
    });
    if (project.kind === "not-found") throw missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId: scope.projectId,
      capabilities: ["recordWrite"],
    });
    if (!(await this.moduleRead.find(tx, scope.projectId, scope.moduleId)))
      throw missing();
    const module = await this.modules.checkModuleForWrite(tx, scope);
    if (module.kind === "not-found") throw missing();
  }
  async resolveExisting(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
  ) {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (project.kind === "not-found") throw missing();
    const before = await this.repository.find(tx, projectId, recordId);
    if (!before) throw missing();
    await this.authorize(tx, actorId, before);
    return before;
  }
  async create(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    moduleId: number,
    input: IndependentRecordDraftRequest,
    requestId: string,
  ) {
    const scope = { projectId, moduleId };
    await this.authorize(tx, actorId, scope);
    const after = await this.repository.create(
      tx,
      scope,
      actorId,
      this.content(input),
    );
    await this.appendAudit(tx, actorId, null, after, requestId);
    return after;
  }
  async update(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    version: number,
    content: RecordDraftContent,
    requestId: string,
  ) {
    const resource = await this.resolveExisting(
      tx,
      actorId,
      projectId,
      recordId,
    );
    if (resource.taskId !== null)
      throw new RecordDraftError(
        409,
        "RECORD_SOURCE_WORKFLOW_REQUIRED",
        "来源任务草稿必须通过关联流程编辑",
      );
    const before = await this.repository.find(tx, projectId, recordId, true);
    if (!before) throw missing();
    if (before.taskId !== null || before.moduleId !== resource.moduleId)
      throw new RecordDraftError(
        409,
        "RECORD_SCOPE_CONFLICT",
        "草稿关联已变化，请重新加载",
      );
    if (before.rowVersion !== version)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本已变化，请加载最新内容后合并",
      );
    const after = await this.repository.update(tx, before, content);
    if (!after)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本已变化，请加载最新内容后合并",
      );
    await this.appendAudit(tx, actorId, before, after, requestId);
    return after;
  }
  async replay(tx: TransactionContext, actorId: number, context: unknown) {
    const saved = recordDraftReplayContextSchema.parse(context);
    await this.resolveExisting(tx, actorId, saved.projectId, saved.recordId);
  }
  async findDraft(tx: TransactionContext, projectId: number, recordId: number) {
    // Business pre-reads must match lockDraft; display names belong to read/list responses.
    return this.repository.find(tx, projectId, recordId);
  }
  async listForTask(tx: TransactionContext, projectId: number, taskId: number) {
    return this.withNames(
      tx,
      await this.repository.listForTask(tx, projectId, taskId),
    );
  }
  async createFromTask(
    tx: TransactionContext,
    actorId: number,
    source: RecordSourceSnapshot,
    content: RecordDraftContent,
    requestId: string,
  ) {
    await this.authorize(tx, actorId, source);
    const after = await this.repository.create(
      tx,
      source,
      actorId,
      this.content(content),
      { taskId: source.taskId, handlerId: source.assigneeId },
    );
    await this.appendAudit(tx, actorId, null, after, requestId);
    return after;
  }
  async updateFromTask(
    tx: TransactionContext,
    actorId: number,
    source: RecordSourceSnapshot,
    recordId: number,
    version: number,
    content: RecordDraftContent,
    requestId: string,
  ) {
    const before = await this.repository.find(
      tx,
      source.projectId,
      recordId,
      true,
    );
    if (
      !before ||
      before.taskId !== source.taskId ||
      before.moduleId !== source.moduleId
    )
      throw missing();
    if (before.rowVersion !== version)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本或关联已变化，请加载最新内容后合并",
      );
    // Workflow prelocked this record version's parents/impact set before locking the task.
    await this.authorize(tx, actorId, before);
    const after = await this.repository.update(
      tx,
      before,
      this.content(content),
    );
    if (!after)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本已变化",
      );
    await this.appendAudit(tx, actorId, before, after, requestId);
    return after;
  }
  /**
   * 删除草稿：只处理 DRAFT，未发布过的草稿不属于业务历史。
   * 先按父到子取 FOR SHARE 再锁草稿行；版本不匹配、已发布（find 过滤 DRAFT）
   * 或遗留问题已转成任务都拒绝，成功与审计在同一事务内提交。
   */
  async remove(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    version: number,
    requestId: string,
  ): Promise<RecordDraftDeleteResult> {
    const pre = await this.repository.find(tx, projectId, recordId);
    if (!pre) throw missing();
    await this.authorize(tx, actorId, pre);
    const before = await this.repository.find(tx, projectId, recordId, true);
    if (!before) throw missing();
    if (before.rowVersion !== version)
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿版本已变化，请加载最新内容后再删除",
      );
    if (
      !(await this.repository.deleteDraft(
        tx,
        projectId,
        recordId,
        before.rowVersion,
      ))
    )
      throw new RecordDraftError(
        409,
        "RECORD_VERSION_CONFLICT",
        "草稿状态已变化，请刷新列表后重试",
      );
    await this.audit.append(tx, {
      projectId,
      actorType: "USER",
      actorId,
      action: "record.draft.delete",
      targetType: "CHANGE_RECORD",
      targetId: String(recordId),
      eventPayload: { before, after: null },
      requestId,
    });
    return {
      projectId,
      recordId,
      moduleId: before.moduleId,
      taskId: before.taskId,
    };
  }
  private content(input: RecordDraftContent): RecordDraftContent {
    const {
      title,
      contextProblem,
      changeSolution,
      resultVerification,
      remainingIssues,
    } = input;
    return {
      title,
      contextProblem,
      changeSolution,
      resultVerification,
      // 草稿里的遗留问题一律按新增保存：稳定遗留项只在发布或修订时分配。
      remainingIssues: remainingIssues.map((entry) => ({
        content: entry.content,
      })),
    };
  }
  private async appendAudit(
    tx: TransactionContext,
    actorId: number,
    before: RecordDraftItem | null,
    after: RecordDraftItem,
    requestId: string,
  ) {
    await this.audit.append(tx, {
      projectId: after.projectId,
      actorType: "USER",
      actorId,
      action: before ? "record.draft.update" : "record.draft.create",
      targetType: "CHANGE_RECORD",
      targetId: String(after.id),
      eventPayload: { before, after },
      requestId,
    });
  }
}

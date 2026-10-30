import {
  RecordPublicationRepository,
  type PublicationIdentity,
} from "./record-publication.repository.js";
import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "../../database/transaction-context.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { ModuleQueryPort } from "../modules/index.js";
import { TaskQueryPort, type TaskReadModel } from "../tasks/index.js";
import { RecordDraftError } from "./record-drafts.service.js";
@Injectable()
export class RecordPublicationAccess {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(RecordPublicationRepository)
    private readonly repository: RecordPublicationRepository,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}
  private missing() {
    return new RecordDraftError(
      404,
      "CHANGE_RECORD_NOT_FOUND",
      "记录不存在或无法访问",
    );
  }
  async authorizeProject(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
  ) {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (project.kind === "not-found") throw this.missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities: ["recordWrite"],
    });
  }
  async prepare(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    recordId: number,
    publish: boolean,
  ) {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (project.kind === "not-found") throw this.missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities: ["recordWrite"],
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await tx.sql`SAVEPOINT record_publication_locks`;
      const previous = await this.repository.identity(tx, projectId, recordId);
      if (!previous || previous.status === "VOID") throw this.missing();
      // ADR-044/ADR-109：模块无归档只读态，这里只保留归属校验与父级 FOR SHARE 取锁。
      const module = await this.modules.checkModuleForWrite(tx, previous);
      if (module.kind === "not-found") throw this.missing();
      let source: TaskReadModel | undefined;
      if (publish && previous.taskId !== null) {
        source = await this.tasks.find(tx, projectId, previous.taskId);
        if (!source || source.moduleId !== previous.moduleId)
          throw this.missing();
      }
      if (source) {
        const locked = await this.tasks.lock(tx, projectId, source.taskId);
        if (JSON.stringify(locked) !== JSON.stringify(source)) {
          await tx.sql`ROLLBACK TO SAVEPOINT record_publication_locks`;
          await tx.sql`RELEASE SAVEPOINT record_publication_locks`;
          continue;
        }
        source = locked;
      }
      const current = await this.repository.identity(
        tx,
        projectId,
        recordId,
        true,
      );
      if (!current || current.status === "VOID") throw this.missing();
      if (
        current.moduleId !== previous.moduleId ||
        current.taskId !== previous.taskId
      )
        throw new RecordDraftError(
          409,
          "RECORD_SCOPE_CONFLICT",
          "记录归属或来源已变化，请刷新后重试",
        );
      if (publish && current.status !== "DRAFT")
        throw new RecordDraftError(
          409,
          "RECORD_ALREADY_PUBLISHED",
          "记录已发布，请查看正式记录",
        );
      // ADR-047：迭代记录只描述本次迭代本身，发布不再以来源任务是否完成为门禁。
      // 来源任务仍按「任务 -> 记录」取锁并校验归属，任务状态保持原样。
      if (!publish && current.status !== "PUBLISHED")
        throw new RecordDraftError(409, "RECORD_NOT_PUBLISHED", "记录尚未发布");
      await tx.sql`RELEASE SAVEPOINT record_publication_locks`;
      return { record: current, source };
    }
    throw new RecordDraftError(
      409,
      "RECORD_SOURCE_CONFLICT",
      "来源任务变化频繁，请刷新后重试",
    );
  }
  async taskAssignee(tx: TransactionContext, record: PublicationIdentity) {
    if (record.taskId === null) return undefined;
    const source = await this.tasks.find(tx, record.projectId, record.taskId);
    if (!source || source.moduleId !== record.moduleId) throw this.missing();
    return source.assigneeId;
  }
}

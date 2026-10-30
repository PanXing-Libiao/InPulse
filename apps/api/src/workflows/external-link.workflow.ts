import { Inject, Injectable } from "@nestjs/common";
import {
  schemaRegistry,
  type ExternalLinkTargetType,
} from "@inpulse/api-contract";
import type { TransactionContext } from "../database/transaction-context.js";
import type {
  LinkTargetQueryPort,
  LinkTargetCommandPort,
} from "../modules/external-links/link-target.port.js";
import {
  ProjectLinkQueryPort,
  ProjectLinkCommandPort,
} from "../modules/projects/external-link-target.port.js";
import {
  TaskLinkQueryPort,
  TaskLinkCommandPort,
} from "../modules/tasks/external-link-target.port.js";
import {
  RecordLinkQueryPort,
  RecordLinkCommandPort,
} from "../modules/change-records/external-link-target.port.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectMemberPermissionPolicyService,
  type ProjectAccessQueryPort,
} from "../modules/projects/index.js";
import { ModuleQueryPort } from "../modules/modules/index.js";
import {
  ExternalLinksQueryPort,
  ExternalLinksCommandPort,
  commitUrlForRepository,
  externalLinkActivityApplies,
  externalLinkActivitySummary,
  parseCommitShaInput,
} from "../modules/external-links/index.js";
import { AuditWritePort } from "../audit/index.js";
import { ActivityWritePort } from "../modules/activity/index.js";
import { ExternalLinkSearchPort } from "../modules/search/external-link-search.port.js";
export class ExternalLinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missing = () =>
  new ExternalLinkError(
    404,
    "EXTERNAL_LINK_NOT_FOUND",
    "目标或关联不存在或无法访问",
  );
const conflict = () =>
  new ExternalLinkError(
    409,
    "EXTERNAL_LINK_VERSION_CONFLICT",
    "目标状态或版本已变化，请重新加载",
  );
@Injectable()
export class ExternalLinkWorkflow {
  private readonly queries: Record<ExternalLinkTargetType, LinkTargetQueryPort>;
  private readonly commands: Record<
    ExternalLinkTargetType,
    LinkTargetCommandPort
  >;
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(ProjectLinkQueryPort) project: ProjectLinkQueryPort,
    @Inject(TaskLinkQueryPort) task: TaskLinkQueryPort,
    @Inject(RecordLinkQueryPort) record: RecordLinkQueryPort,
    @Inject(ProjectLinkCommandPort) projectCommand: ProjectLinkCommandPort,
    @Inject(TaskLinkCommandPort) taskCommand: TaskLinkCommandPort,
    @Inject(RecordLinkCommandPort) recordCommand: RecordLinkCommandPort,
    @Inject(ExternalLinksQueryPort)
    private readonly links: ExternalLinksQueryPort,
    @Inject(ExternalLinksCommandPort)
    private readonly linkCommands: ExternalLinksCommandPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(ExternalLinkSearchPort)
    private readonly search: ExternalLinkSearchPort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {
    this.queries = {
      PROJECT: project,
      TASK: task,
      CHANGE_RECORD: record,
    };
    this.commands = {
      PROJECT: projectCommand,
      TASK: taskCommand,
      CHANGE_RECORD: recordCommand,
    };
  }
  async target(
    tx: TransactionContext,
    actor: number,
    type: ExternalLinkTargetType,
    id: number,
    write = false,
  ) {
    const query = this.queries[type];
    // PROJECT commands acquire UPDATE before the authorization SHARE lock: no shared-lock upgrade race.
    const before = await query.find(
      tx,
      id,
      write && type === "PROJECT" ? "update" : undefined,
    );
    if (!before) throw missing();
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actor,
      projectId: before.projectId,
    });
    if (project.kind === "not-found") throw missing();
    if (write) {
      await this.permissions.assertCapabilities(tx, {
        actorUserId: actor,
        projectId: before.projectId,
        capabilities: ["recordWrite"],
      });
    }
    let writable = true;
    if (before.moduleId !== null) {
      // ADR-044：模块已无归档只读态，这里只保留父级 FOR SHARE 取锁与归属校验。
      const module = await this.modules.checkModuleForWrite(tx, {
        projectId: before.projectId,
        moduleId: before.moduleId,
      });
      if (module.kind === "not-found") throw missing();
    }
    // Parent waits can invalidate the pre-read. Lock and re-read every target,
    // including GET/replay, then retain that lock through result authorization.
    const current = await query.find(tx, id, write ? "update" : "share");
    if (!current) throw missing();
    if (
      current.projectId !== before.projectId ||
      current.moduleId !== before.moduleId
    )
      throw conflict();
    if (
      type === "CHANGE_RECORD" &&
      current.status === "VOID" &&
      !project.resource.isSystemAdmin
    )
      throw missing();
    writable =
      writable &&
      (type === "CHANGE_RECORD"
        ? ["DRAFT", "PUBLISHED"].includes(current.status)
        : // ADR-054：任务只剩 ACTIVE/INVALID 两态，只有无效任务只读。
          current.status !== "INVALID");
    if (write && !writable)
      throw new ExternalLinkError(
        409,
        "EXTERNAL_LINK_READ_ONLY",
        "目标或所属父级只读，不能修改关联",
      );
    // Refresh membership after potentially waiting for a target lock.
    if (
      write &&
      (
        await this.access.checkProjectForWrite(tx, {
          actorUserId: actor,
          projectId: current.projectId,
        })
      ).kind === "not-found"
    )
      throw missing();
    return { target: current, writable };
  }
  async list(
    tx: TransactionContext,
    actor: number,
    type: ExternalLinkTargetType,
    id: number,
  ) {
    const { target, writable } = await this.target(tx, actor, type, id);
    return {
      projectId: target.projectId,
      rowVersion: target.rowVersion,
      writable,
      // 项目视图是聚合读：项目级关联 + 有效任务 / 已发布记录上的关联，并标注来源。
      items:
        type === "PROJECT"
          ? await this.links.listProjectLibrary(tx, target.projectId)
          : await this.links.list(tx, target.projectId, type, id),
    };
  }
  async replay(
    tx: TransactionContext,
    actor: number,
    type: ExternalLinkTargetType,
    id: number,
    context: unknown,
  ) {
    const value =
      schemaRegistry.ExternalLinkReplayContext.schema.parse(context);
    if (value.targetType !== type || value.targetId !== id) throw missing();
    const { target } = await this.target(tx, actor, type, id);
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actor,
      projectId: target.projectId,
      capabilities: ["recordWrite"],
    });
    if (
      target.projectId !== value.projectId ||
      !(await this.links.exists(tx, target.projectId, value.linkId))
    )
      throw missing();
  }
  /**
   * 允许直接粘贴裸 commit SHA：用项目根仓库补全为 commit 链接（2026-10-09 用户指示）。
   * 非 SHA 输入原样返回，继续走既有的 GitHub URL 规范化与校验；
   * 是 SHA 但项目没有可用根仓库时按 422 拒绝，不落库任何内容。
   */
  private async resolveSubmittedUrl(
    tx: TransactionContext,
    projectId: number,
    raw: string,
  ): Promise<string> {
    const sha = parseCommitShaInput(raw);
    if (sha === null) return raw;
    const url = commitUrlForRepository(
      await this.links.findRootRepository(tx, projectId),
      sha,
    );
    if (url === null)
      throw new ExternalLinkError(
        422,
        "EXTERNAL_LINK_SHA_REQUIRES_ROOT_REPOSITORY",
        "尚未设置项目根仓库，无法把 commit SHA 补全为链接",
      );
    return url;
  }
  async mutate(
    tx: TransactionContext,
    actor: number,
    type: ExternalLinkTargetType,
    id: number,
    version: number,
    input:
      | ReturnType<typeof schemaRegistry.ExternalLinkRequest.schema.parse>
      | { linkId: number },
    requestId: string,
    reauthorize: () => Promise<number>,
  ) {
    const { target } = await this.target(tx, actor, type, id, true);
    if (target.rowVersion !== version) throw conflict();
    if ((await reauthorize()) !== actor)
      throw new ExternalLinkError(401, "SESSION_REQUIRED", "登录状态已失效");
    const adding = "url" in input;
    const submittedUrl = adding
      ? await this.resolveSubmittedUrl(tx, target.projectId, input.url)
      : null;
    const previousRoot =
      type === "PROJECT"
        ? ((await this.links.list(tx, target.projectId, type, id)).find(
            (link) => link.isRootRepository,
          )?.id ?? null)
        : null;
    const result = adding
      ? await this.linkCommands.add(
          tx,
          target.projectId,
          type,
          id,
          actor,
          submittedUrl!,
          input.isRootRepository,
        )
      : await this.linkCommands.remove(
          tx,
          target.projectId,
          type,
          id,
          input.linkId,
        );
    if (!result) throw missing();
    if (!result.changed)
      throw new ExternalLinkError(
        409,
        "EXTERNAL_LINK_ALREADY_ASSOCIATED",
        "该链接已关联，请勿重复添加",
      );
    if (!(await this.commands[type].advance(tx, target))) throw conflict();
    const rowVersion = version + 1;
    const event = await this.audit.append(tx, {
      projectId: target.projectId,
      actorType: "USER",
      actorId: actor,
      action: adding ? "EXTERNAL_LINK_ADDED" : "EXTERNAL_LINK_REMOVED",
      targetType: type,
      targetId: String(id),
      eventPayload: {
        targetType: type,
        targetId: id,
        linkId: result.linkId,
        normalizedUrl: result.url,
        previousRootLinkId: previousRoot,
        rootLinkId:
          adding && input.isRootRepository
            ? result.linkId
            : !adding && result.linkId === previousRoot
              ? null
              : previousRoot,
        before: { associated: result.associatedBefore, rowVersion: version },
        after: { associated: adding, rowVersion },
      },
      requestId,
    });
    // 活动只写链接标签与目标身份快照（不写 URL 与正文）；F21 按同一来源身份迁移可见性。
    // ADR-048：未发布草稿不产生活动，链接事件同样跳过，避免草稿标题进入项目动态。
    if (externalLinkActivityApplies(type, target.status)) {
      await this.activity.append(tx, {
        projectId: target.projectId,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        sourceEntityType: type,
        sourceEntityId: id,
        activityType: adding ? "EXTERNAL_LINK_ADDED" : "EXTERNAL_LINK_REMOVED",
        actorId: actor,
        summary: externalLinkActivitySummary({
          adding,
          url: result.url,
          targetType: type,
          target,
        }),
        metadata: { linkId: result.linkId },
        visibilityScope: "MEMBER",
        sourceStatus: target.status,
        sourceRowVersion: rowVersion,
        occurredAt: new Date(),
      });
    }
    await this.search.refresh(tx, target.projectId, type, id, rowVersion);
    return {
      projectId: target.projectId,
      targetType: type,
      targetId: id,
      linkId: result.linkId,
      rowVersion,
    };
  }
}

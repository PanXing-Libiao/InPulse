import { Inject, Injectable } from "@nestjs/common";
import {
  taskGroupMergeReplayContextSchema,
  taskGroupUnmergeReplayContextSchema,
  taskGroupUnmergeResponseSchema,
  type TaskGroupItem,
  type TaskGroupMergeRequest,
  type TaskGroupUnmergeRequest,
  type TaskGroupUnmergeResponse,
} from "@inpulse/api-contract";

import { AuditWritePort } from "../../audit/index.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import { ActivityWritePort } from "../activity/index.js";
import { PROJECT_NOTIFICATION_TYPES } from "../notifications/index.js";
import { SearchProjectionWritePort } from "../search/index.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectCodePort,
  ProjectMemberPermissionPolicyService,
  ProjectNotificationDispatcher,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import { ModuleQueryPort } from "../modules/index.js";
import { TaskQueryPort, type TaskReadModel } from "../tasks/index.js";
import {
  TaskGroupRepository,
  type TaskGroupMemberRecord,
  type TaskGroupRecord,
} from "./task-group.repository.js";

/** 合并/解除合并事务内最大尝试次数；超过即终止，避免长事务内忙等（技术设计 6.4 / 6.5）。 */
const TASK_GROUP_LOCK_ATTEMPTS = 3;
const MERGE_ACTIVITY_TYPE = "task.merge";
const MERGE_NOTIFICATION_TYPE = PROJECT_NOTIFICATION_TYPES.taskMerge;
const UNMERGE_ACTIVITY_TYPE = "task.unmerge";
const UNMERGE_NOTIFICATION_TYPE = PROJECT_NOTIFICATION_TYPES.taskUnmerge;
/** 功能设计 18.14 把解除原因定义为「建议填写」；未填写时用固定文案满足数据库非空约束。 */
const DEFAULT_UNMERGE_REASON = "未填写解除原因";
const MAIN_UNMERGE_MESSAGE =
  "主任务不能直接解除合并；解除最后一个分支任务后系统会自动关闭聚合组";

/** 合并与解除合并共用的业务错误：状态码与错误码由调用点显式指定。 */
export class TaskGroupCommandError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskGroupCommandError";
  }
}

/** 供共享锁序代码复用的错误构造器；action 用于「不能{action}任务」提示语。 */
interface CommandErrors {
  readonly missing: () => Error;
}

const missing = () =>
  new TaskGroupCommandError(
    404,
    "TASK_MERGE_NOT_FOUND",
    "任务不存在或无法访问",
  );
const parentInvalid = (message: string) =>
  new TaskGroupCommandError(409, "TASK_MERGE_PARENT_ARCHIVED", message);
const alreadyMerged = (message: string) =>
  new TaskGroupCommandError(409, "TASK_ALREADY_MERGED", message);
const groupStateConflict = (message: string) =>
  new TaskGroupCommandError(409, "TASK_GROUP_STATE_CONFLICT", message);
const MERGE_ERRORS: CommandErrors = {
  missing,
};

const unmergeMissing = () =>
  new TaskGroupCommandError(
    404,
    "TASK_UNMERGE_NOT_FOUND",
    "任务不存在或无法访问",
  );
/** 任务当前没有活跃成员关系：未合并、已解除或所在聚合组已关闭。 */
const notMerged = () =>
  new TaskGroupCommandError(
    409,
    "TASK_NOT_MERGED",
    "任务当前不是活跃分支，无法解除合并",
  );
const unmergeConflict = (message: string) =>
  new TaskGroupCommandError(409, "TASK_GROUP_STATE_CONFLICT", message);
const UNMERGE_ERRORS: CommandErrors = {
  missing: unmergeMissing,
};

/** 空白原因按未填写处理，避免触发 detach_state_check 的 btrim 非空约束。 */
function effectiveUnmergeReason(value: string | null): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? DEFAULT_UNMERGE_REASON : trimmed;
}

interface TaskPair {
  readonly source: TaskReadModel;
  readonly main: TaskReadModel;
}

/**
 * F-23 任务合并与 F-24 解除合并（技术设计 6.4 / 6.5）。
 *
 * 两个命令共用同一锁序：项目 FOR SHARE -> 模块 FOR SHARE -> source/main 任务 ID
 * 升序 FOR UPDATE -> 聚合组 FOR UPDATE；获得任务锁后重新读取
 * 并比对预读结果，变化时回滚到保存点从头有限重试。
 * 合并只建立关系与来源快照；解除只把成员标记为 DETACHED。两者都不修改任何任务字段。
 */
@Injectable()
export class TaskGroupsService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ProjectCodePort) private readonly codes: ProjectCodePort,
    @Inject(ModuleQueryPort) private readonly modules: ModuleQueryPort,
    @Inject(TaskQueryPort) private readonly tasks: TaskQueryPort,
    @Inject(TaskGroupRepository) private readonly groups: TaskGroupRepository,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(ProjectNotificationDispatcher)
    private readonly notifications: ProjectNotificationDispatcher,
    @Inject(SearchProjectionWritePort)
    private readonly search: SearchProjectionWritePort,
    @Inject(ProjectMemberPermissionPolicyService)
    private readonly permissions: ProjectMemberPermissionPolicyService,
  ) {}

  /** 写前授权：实时成员关系与项目 ACTIVE；错误码与提示语由调用命令决定。 */
  private async authorizeProject(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    errors: CommandErrors,
  ): Promise<void> {
    const project = await this.access.checkProjectForWrite(tx, {
      actorUserId: actorId,
      projectId,
    });
    if (project.kind === "not-found") throw errors.missing();
    await this.permissions.assertCapabilities(tx, {
      actorUserId: actorId,
      projectId,
      capabilities: ["taskLifecycle"],
    });
  }

  /** 父级锁：模块按 ID 升序取 FOR SHARE；任务不再有功能级父级。 */
  private async lockParents(
    tx: TransactionContext,
    projectId: number,
    tasks: readonly TaskReadModel[],
    errors: CommandErrors,
  ): Promise<void> {
    const moduleIds = [...new Set(tasks.map((task) => task.moduleId))].sort(
      (a, b) => a - b,
    );
    for (const moduleId of moduleIds) {
      const module = await this.modules.checkModuleForWrite(tx, {
        projectId,
        moduleId,
      });
      if (module.kind === "not-found") throw errors.missing();
    }
  }

  private async readPair(
    tx: TransactionContext,
    projectId: number,
    sourceTaskId: number,
    mainTaskId: number,
  ): Promise<TaskPair | undefined> {
    const source = await this.tasks.find(tx, projectId, sourceTaskId);
    const main = await this.tasks.find(tx, projectId, mainTaskId);
    return source && main ? { source, main } : undefined;
  }

  /** 任务锁：source/main 按 ID 升序 FOR UPDATE，锁后各自重读。 */
  private async lockPair(
    tx: TransactionContext,
    projectId: number,
    sourceTaskId: number,
    mainTaskId: number,
  ): Promise<TaskPair | undefined> {
    const locked = new Map<number, TaskReadModel>();
    for (const taskId of [sourceTaskId, mainTaskId].sort((a, b) => a - b)) {
      const row = await this.tasks.lock(tx, projectId, taskId);
      if (row) locked.set(taskId, row);
    }
    const source = locked.get(sourceTaskId);
    const main = locked.get(mainTaskId);
    return source && main ? { source, main } : undefined;
  }

  /**
   * 合并命令：幂等事务内完成关系写入、审计、活动、通知与搜索投影。
   * 调用方（HTTP 层）已校验 Session/CSRF 并持有同一 `TransactionContext`。
   */
  async execute(
    tx: TransactionContext,
    actorId: number,
    input: TaskGroupMergeRequest,
    requestId: string,
  ): Promise<TaskGroupItem> {
    if (input.sourceTaskId === input.mainTaskId)
      throw new TaskGroupCommandError(
        422,
        "TASK_MERGE_SELF_REFERENCE",
        "不能把任务合并到自己",
      );
    const sourcePre = await this.tasks.findByTaskId(tx, input.sourceTaskId);
    const mainPre = await this.tasks.findByTaskId(tx, input.mainTaskId);
    if (!sourcePre || !mainPre) throw missing();
    // 跨项目合并按不存在处理，避免泄露其他项目任务的存在性。
    if (sourcePre.projectId !== mainPre.projectId) throw missing();
    const projectId = sourcePre.projectId;
    await this.authorizeProject(tx, actorId, projectId, MERGE_ERRORS);

    for (let attempt = 0; attempt < TASK_GROUP_LOCK_ATTEMPTS; attempt++) {
      await tx.sql`SAVEPOINT task_merge_attempt`;
      const previous = await this.readPair(
        tx,
        projectId,
        input.sourceTaskId,
        input.mainTaskId,
      );
      if (!previous) throw missing();
      await this.lockParents(
        tx,
        projectId,
        [previous.source, previous.main],
        MERGE_ERRORS,
      );
      const locked = await this.lockPair(
        tx,
        projectId,
        input.sourceTaskId,
        input.mainTaskId,
      );
      if (!locked) throw missing();
      if (JSON.stringify(locked) !== JSON.stringify(previous)) {
        await tx.sql`ROLLBACK TO SAVEPOINT task_merge_attempt`;
        await tx.sql`RELEASE SAVEPOINT task_merge_attempt`;
        continue;
      }
      const item = await this.mergeLockedPair(
        tx,
        actorId,
        projectId,
        locked,
        input,
        requestId,
      );
      await tx.sql`RELEASE SAVEPOINT task_merge_attempt`;
      return item;
    }
    throw groupStateConflict("任务正在被其他操作修改，请重新加载后再合并");
  }

  /** 已持有项目/模块/功能/任务锁后的合并写入；结果与来源快照同事务提交。 */
  private async mergeLockedPair(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    pair: TaskPair,
    input: TaskGroupMergeRequest,
    requestId: string,
  ): Promise<TaskGroupItem> {
    const { source, main } = pair;
    if (
      source.lifecycleStatus !== "ACTIVE" ||
      main.lifecycleStatus !== "ACTIVE"
    )
      throw parentInvalid("任务已无效，不能合并");
    const sourceActive = await this.groups.findActiveMember(
      tx,
      projectId,
      source.taskId,
    );
    if (sourceActive)
      throw alreadyMerged("分支任务已属于聚合组，请先解除原关系");

    const mainActive = await this.groups.findActiveMember(
      tx,
      projectId,
      main.taskId,
    );
    let group: TaskGroupRecord;
    let joinedExistingGroup = false;
    let before: Readonly<Record<string, unknown>> | null = null;
    if (mainActive === undefined) {
      const code = await this.codes.allocateTaskGroupCode(tx, projectId);
      group = await this.groups.createGroup(tx, {
        projectId,
        code,
        name: main.title.slice(0, 500),
        createdBy: actorId,
      });
      await this.groups.createMember(tx, {
        groupId: group.groupId,
        taskId: main.taskId,
        projectId,
        role: "MAIN",
        sourceKind: null,
        originalWorkStatus: null,
        originalAssigneeId: null,
      });
    } else {
      if (mainActive.role !== "MAIN")
        throw groupStateConflict(
          "主任务在该聚合组中不是主任务，请解除原关系后再合并",
        );
      const lockedGroup = await this.groups.lockGroup(
        tx,
        projectId,
        mainActive.groupId,
      );
      if (!lockedGroup) throw missing();
      if (lockedGroup.status !== "ACTIVE")
        throw groupStateConflict("聚合组已关闭，不能新增分支任务");
      const members = await this.groups.listMembers(
        tx,
        projectId,
        lockedGroup.groupId,
      );
      const activeMain = members.find(
        (member) => member.role === "MAIN" && member.status === "ACTIVE",
      );
      if (activeMain === undefined || activeMain.taskId !== main.taskId)
        throw groupStateConflict("聚合组主任务已变化，请重新加载后再合并");
      // 唯一约束禁止同组第二条历史成员，锁内提前给出稳定的业务错误。
      if (members.some((member) => member.taskId === source.taskId))
        throw alreadyMerged("分支任务与该聚合组已有历史关系，不能重复合并");
      before = {
        groupId: lockedGroup.groupId,
        rowVersion: lockedGroup.rowVersion,
        memberCount: members.length,
      };
      group = lockedGroup;
      joinedExistingGroup = true;
    }

    const sourceMember: TaskGroupMemberRecord = await this.groups.createMember(
      tx,
      {
        groupId: group.groupId,
        taskId: source.taskId,
        projectId,
        role: "SOURCE",
        sourceKind: input.sourceKind,
        originalWorkStatus: source.workStatus,
        originalAssigneeId: source.assigneeId,
      },
    );
    if (joinedExistingGroup) {
      const touched = await this.groups.touchGroup(
        tx,
        projectId,
        group.groupId,
        group.rowVersion,
      );
      if (!touched)
        throw groupStateConflict("聚合组已变化，请重新加载后再合并");
      const refreshed = await this.groups.findGroup(
        tx,
        projectId,
        group.groupId,
      );
      if (!refreshed) throw missing();
      group = refreshed;
    }

    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId,
      actorType: "USER",
      actorId,
      action: MERGE_ACTIVITY_TYPE,
      targetType: "TASK_GROUP",
      targetId: String(group.groupId),
      eventPayload: {
        before,
        after: {
          groupId: group.groupId,
          code: group.code,
          name: group.name,
          status: group.status,
          rowVersion: group.rowVersion,
          created: !joinedExistingGroup,
          mainTaskId: main.taskId,
          sourceTaskId: source.taskId,
          sourceMemberId: sourceMember.memberId,
          sourceKind: input.sourceKind,
        },
        source: {
          taskId: source.taskId,
          code: source.code,
          moduleId: source.moduleId,
          workStatus: source.workStatus,
          assigneeId: source.assigneeId,
          lifecycleStatus: source.lifecycleStatus,
        },
        main: {
          taskId: main.taskId,
          code: main.code,
          moduleId: main.moduleId,
          workStatus: main.workStatus,
          assigneeId: main.assigneeId,
          lifecycleStatus: main.lifecycleStatus,
        },
        mergeNote: input.mergeNote,
      },
      requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "TASK_GROUP",
      sourceEntityId: group.groupId,
      activityType: MERGE_ACTIVITY_TYPE,
      actorId,
      summary:
        `合并任务：${source.code} ${source.title} 并入 ${main.code} ${main.title}`.slice(
          0,
          1000,
        ),
      metadata: {
        groupId: group.groupId,
        code: group.code,
        mainTaskId: main.taskId,
        sourceTaskId: source.taskId,
        sourceKind: input.sourceKind,
      },
      visibilityScope: "MEMBER",
      sourceStatus: group.status,
      sourceRowVersion: group.rowVersion,
      occurredAt,
    });
    const targetPath = `/projects/${projectId}/modules/${main.moduleId}/tasks?taskId=${main.taskId}`;
    const recipients = [
      main.assigneeId,
      source.assigneeId,
      main.creatorId,
      source.creatorId,
    ];
    const notificationBody =
      input.mergeNote === null
        ? `${source.code} -> ${main.code}`
        : input.mergeNote.slice(0, 5000);
    await this.notifications.dispatch(
      tx,
      {
        projectId,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        notificationType: MERGE_NOTIFICATION_TYPE,
        title: `任务合并：${source.title} 并入 ${main.title}`.slice(0, 500),
        body: notificationBody,
        targetPath,
        createdAt: occurredAt,
      },
      recipients,
    );
    await this.search.upsert(tx, {
      projectId,
      entityType: "TASK_GROUP",
      entityId: group.groupId,
      moduleId: null,
      recordId: null,
      title: group.name,
      summary: input.mergeNote ?? "",
      rawText: `${group.code} ${group.name} ${source.code} ${source.title} ${main.code} ${main.title}`,
      visibilityScope: "MEMBER",
      sourceStatus: group.status,
      sourceRowVersion: group.rowVersion,
    });

    const item = await this.groups.findGroupItem(tx, projectId, group.groupId);
    if (!item || item.mainTaskId !== main.taskId) throw missing();
    return item;
  }

  /** 幂等重放前的当前权限复核：项目可写、聚合组可读且仍 ACTIVE、结果任务可读。 */
  async replay(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const saved = taskGroupMergeReplayContextSchema.safeParse(context);
    if (!saved.success) throw new Error("invalid task group replay context");
    const { projectId, groupId, taskIds } = saved.data;
    await this.authorizeProject(tx, actorId, projectId, MERGE_ERRORS);
    const group = await this.groups.findGroup(tx, projectId, groupId);
    if (!group || group.status !== "ACTIVE") throw missing();
    for (const taskId of taskIds)
      if (!(await this.tasks.find(tx, projectId, taskId))) throw missing();
  }

  /**
   * F-24 解除合并命令（技术设计 6.5）。
   *
   * 预读来源任务解析归属项目与所属聚合组，按 ID 升序 FOR UPDATE 锁定 SOURCE/MAIN
   * 任务，再 FOR UPDATE 锁定聚合组并重读成员；仅允许解除活跃 SOURCE。
   * 解除只写成员关系（DETACHED + 时间 + 原因），不修改任务工作状态、负责人和迭代记录；
   * 已无活跃 SOURCE 时同事务关闭聚合组并解除 MAIN。锁内任何结论都来自锁后重读。
   */
  async unmerge(
    tx: TransactionContext,
    actorId: number,
    input: TaskGroupUnmergeRequest,
    requestId: string,
  ): Promise<TaskGroupUnmergeResponse> {
    const sourcePre = await this.tasks.findByTaskId(tx, input.sourceTaskId);
    if (!sourcePre) throw unmergeMissing();
    const projectId = sourcePre.projectId;
    await this.authorizeProject(tx, actorId, projectId, UNMERGE_ERRORS);

    for (let attempt = 0; attempt < TASK_GROUP_LOCK_ATTEMPTS; attempt++) {
      await tx.sql`SAVEPOINT task_unmerge_attempt`;
      const memberPre = await this.groups.findActiveMember(
        tx,
        projectId,
        input.sourceTaskId,
      );
      if (!memberPre) throw notMerged();
      if (memberPre.role !== "SOURCE")
        throw unmergeConflict(MAIN_UNMERGE_MESSAGE);
      const groupPre = await this.groups.findGroup(
        tx,
        projectId,
        memberPre.groupId,
      );
      if (!groupPre) throw unmergeMissing();
      const membersPre = await this.groups.listMembers(
        tx,
        projectId,
        groupPre.groupId,
      );
      const mainMemberPre = membersPre.find(
        (entry) => entry.role === "MAIN" && entry.status === "ACTIVE",
      );
      if (!mainMemberPre) throw unmergeConflict("聚合组状态异常，请刷新后重试");
      const previous = await this.readPair(
        tx,
        projectId,
        input.sourceTaskId,
        mainMemberPre.taskId,
      );
      if (!previous) throw unmergeMissing();
      await this.lockParents(
        tx,
        projectId,
        [previous.source, previous.main],
        UNMERGE_ERRORS,
      );
      const locked = await this.lockPair(
        tx,
        projectId,
        input.sourceTaskId,
        mainMemberPre.taskId,
      );
      if (!locked) throw unmergeMissing();
      if (JSON.stringify(locked) !== JSON.stringify(previous)) {
        await tx.sql`ROLLBACK TO SAVEPOINT task_unmerge_attempt`;
        await tx.sql`RELEASE SAVEPOINT task_unmerge_attempt`;
        continue;
      }
      // 成员变更必须先持有聚合组行锁，因此锁后的成员读取是最终状态。
      const lockedGroup = await this.groups.lockGroup(
        tx,
        projectId,
        memberPre.groupId,
      );
      if (!lockedGroup) throw unmergeMissing();
      const members = await this.groups.listMembers(
        tx,
        projectId,
        lockedGroup.groupId,
      );
      const member = members.find(
        (entry) => entry.memberId === memberPre.memberId,
      );
      if (!member || member.status !== "ACTIVE") throw notMerged();
      if (member.role !== "SOURCE") throw unmergeConflict(MAIN_UNMERGE_MESSAGE);
      if (lockedGroup.status !== "ACTIVE")
        throw unmergeConflict("聚合组已关闭，不能解除合并");
      const mainMember = members.find(
        (entry) => entry.role === "MAIN" && entry.status === "ACTIVE",
      );
      if (!mainMember) throw unmergeConflict("聚合组状态异常，请刷新后重试");
      if (mainMember.taskId !== locked.main.taskId) {
        // 组内 MAIN 在等待锁期间变化：回滚到保存点按最新关系重新预读。
        await tx.sql`ROLLBACK TO SAVEPOINT task_unmerge_attempt`;
        await tx.sql`RELEASE SAVEPOINT task_unmerge_attempt`;
        continue;
      }
      const response = await this.unmergeLocked(
        tx,
        actorId,
        projectId,
        locked,
        lockedGroup,
        member,
        mainMember,
        members,
        input,
        requestId,
      );
      await tx.sql`RELEASE SAVEPOINT task_unmerge_attempt`;
      return response;
    }
    throw unmergeConflict("任务正在被其他操作修改，请重新加载后再解除合并");
  }

  /** 已持有任务与聚合组锁后的解除写入；关系、审计、通知、投影同事务提交。 */
  private async unmergeLocked(
    tx: TransactionContext,
    actorId: number,
    projectId: number,
    pair: TaskPair,
    group: TaskGroupRecord,
    member: TaskGroupMemberRecord,
    mainMember: TaskGroupMemberRecord,
    members: readonly TaskGroupMemberRecord[],
    input: TaskGroupUnmergeRequest,
    requestId: string,
  ): Promise<TaskGroupUnmergeResponse> {
    const { source, main } = pair;
    const reason = effectiveUnmergeReason(input.unmergeReason);
    const remainingSources = members.filter(
      (entry) =>
        entry.status === "ACTIVE" &&
        entry.role === "SOURCE" &&
        entry.memberId !== member.memberId,
    );
    const closesGroup = remainingSources.length === 0;

    const detachedSource = await this.groups.detachMember(tx, {
      projectId,
      memberId: member.memberId,
      detachedBy: actorId,
      reason,
    });
    if (!detachedSource)
      throw unmergeConflict("任务关系已变化，请重新加载后再解除合并");
    let detachedMain: TaskGroupMemberRecord | undefined;
    let updated: TaskGroupRecord;
    if (closesGroup) {
      detachedMain = await this.groups.detachMember(tx, {
        projectId,
        memberId: mainMember.memberId,
        detachedBy: actorId,
        reason,
      });
      if (!detachedMain)
        throw unmergeConflict("任务关系已变化，请重新加载后再解除合并");
      const closed = await this.groups.closeGroup(
        tx,
        projectId,
        group.groupId,
        group.rowVersion,
      );
      if (!closed)
        throw unmergeConflict("聚合组已变化，请重新加载后再解除合并");
      updated = closed;
    } else {
      const touched = await this.groups.touchGroup(
        tx,
        projectId,
        group.groupId,
        group.rowVersion,
      );
      if (!touched)
        throw unmergeConflict("聚合组已变化，请重新加载后再解除合并");
      const refreshed = await this.groups.findGroup(
        tx,
        projectId,
        group.groupId,
      );
      if (!refreshed) throw unmergeMissing();
      updated = refreshed;
    }

    const occurredAt = new Date();
    const event = await this.audit.append(tx, {
      projectId,
      actorType: "USER",
      actorId,
      action: UNMERGE_ACTIVITY_TYPE,
      targetType: "TASK_GROUP",
      targetId: String(group.groupId),
      eventPayload: {
        before: {
          groupId: group.groupId,
          code: group.code,
          name: group.name,
          status: group.status,
          rowVersion: group.rowVersion,
          memberId: member.memberId,
          memberRole: member.role,
          memberStatus: member.status,
          sourceKind: member.sourceKind,
          activeSourceCount: remainingSources.length + 1,
        },
        after: {
          groupId: updated.groupId,
          code: updated.code,
          name: updated.name,
          status: updated.status,
          rowVersion: updated.rowVersion,
          closedAt: updated.closedAt,
          groupClosed: closesGroup,
          activeSourceCount: remainingSources.length,
          detachedMemberIds: [
            member.memberId,
            ...(detachedMain ? [detachedMain.memberId] : []),
          ],
        },
        source: {
          taskId: source.taskId,
          code: source.code,
          moduleId: source.moduleId,
          workStatus: source.workStatus,
          assigneeId: source.assigneeId,
          lifecycleStatus: source.lifecycleStatus,
        },
        main: {
          taskId: main.taskId,
          code: main.code,
          moduleId: main.moduleId,
          workStatus: main.workStatus,
          assigneeId: main.assigneeId,
          lifecycleStatus: main.lifecycleStatus,
        },
        unmergeReason: reason,
      },
      requestId,
      occurredAt,
    });
    await this.activity.append(tx, {
      projectId,
      sourceChainId: event.chainId,
      sourceSequence: event.sequenceNo,
      sourceEntityType: "TASK_GROUP",
      sourceEntityId: updated.groupId,
      activityType: UNMERGE_ACTIVITY_TYPE,
      actorId,
      summary: (closesGroup
        ? `解除合并：${source.code} ${source.title} 恢复独立，聚合组 ${updated.code} 已关闭`
        : `解除合并：${source.code} ${source.title} 恢复独立`
      ).slice(0, 1000),
      metadata: {
        groupId: updated.groupId,
        code: updated.code,
        mainTaskId: main.taskId,
        sourceTaskId: source.taskId,
        groupClosed: closesGroup,
      },
      visibilityScope: "MEMBER",
      sourceStatus: updated.status,
      sourceRowVersion: updated.rowVersion,
      occurredAt,
    });
    // 解除后来源任务恢复独立展示，通知统一深链到来源任务。
    const targetPath = `/projects/${projectId}/modules/${source.moduleId}/tasks?taskId=${source.taskId}`;
    const recipients = [
      source.assigneeId,
      main.assigneeId,
      source.creatorId,
      main.creatorId,
    ];
    // 收件人由统一分发器去重、排序并过滤当前项目访问权。
    // 未填写或纯空白原因时通知正文回落到来源编号，避免出现空正文。
    const notificationBody =
      input.unmergeReason === null || input.unmergeReason.trim().length === 0
        ? `${source.code} 已恢复独立`
        : input.unmergeReason.slice(0, 5000);
    await this.notifications.dispatch(
      tx,
      {
        projectId,
        sourceChainId: event.chainId,
        sourceSequence: event.sequenceNo,
        notificationType: UNMERGE_NOTIFICATION_TYPE,
        title: `任务解除合并：${source.title} 恢复独立`.slice(0, 500),
        body: notificationBody,
        targetPath,
        createdAt: occurredAt,
      },
      recipients,
    );
    await this.search.upsert(tx, {
      projectId,
      entityType: "TASK_GROUP",
      entityId: updated.groupId,
      moduleId: null,
      recordId: null,
      title: updated.name,
      summary: input.unmergeReason ?? "",
      rawText: `${updated.code} ${updated.name} ${source.code} ${source.title} ${main.code} ${main.title}`,
      visibilityScope: "MEMBER",
      sourceStatus: updated.status,
      sourceRowVersion: updated.rowVersion,
    });

    const detachedMemberIds = new Set<number>([
      member.memberId,
      ...(detachedMain ? [detachedMain.memberId] : []),
    ]);
    const after = await this.groups.listMembers(tx, projectId, group.groupId);
    const detachedMembers = after
      .filter((entry) => detachedMemberIds.has(entry.memberId))
      .map((entry) => {
        if (entry.detachedAt === null || entry.detachReason === null)
          throw new Error("detached member is missing detach metadata");
        return {
          id: entry.memberId,
          taskId: entry.taskId,
          role: entry.role,
          sourceKind: entry.sourceKind,
          originalWorkStatus: entry.originalWorkStatus,
          originalAssigneeId: entry.originalAssigneeId,
          joinedAt: new Date(entry.joinedAt).toISOString(),
          detachedAt: new Date(entry.detachedAt).toISOString(),
          detachReason: entry.detachReason,
        };
      });
    return taskGroupUnmergeResponseSchema.parse({
      group: {
        id: updated.groupId,
        projectId: updated.projectId,
        code: updated.code,
        name: updated.name,
        status: updated.status,
        createdBy: updated.createdBy,
        rowVersion: updated.rowVersion,
        createdAt: new Date(updated.createdAt).toISOString(),
        updatedAt: new Date(updated.updatedAt).toISOString(),
        closedAt:
          updated.closedAt === null
            ? null
            : new Date(updated.closedAt).toISOString(),
        mainTaskId: mainMember.taskId,
      },
      detachedMembers,
    });
  }

  /**
   * 解除合并的幂等重放复核：项目可写、聚合组可读、全部结果任务可读。
   * 与合并不同，最后一个来源解除后聚合组合法变为 CLOSED，因此这里不限制组状态；
   * 关闭组的历史关系仍属于结果资源，仍按同一门禁复核。
   */
  async replayUnmerge(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const saved = taskGroupUnmergeReplayContextSchema.safeParse(context);
    if (!saved.success)
      throw new Error("invalid task group unmerge replay context");
    const { projectId, groupId, taskIds } = saved.data;
    await this.authorizeProject(tx, actorId, projectId, UNMERGE_ERRORS);
    const group = await this.groups.findGroup(tx, projectId, groupId);
    if (!group) throw unmergeMissing();
    for (const taskId of taskIds)
      if (!(await this.tasks.find(tx, projectId, taskId)))
        throw unmergeMissing();
  }
}

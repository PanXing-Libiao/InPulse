import { Inject, Injectable } from "@nestjs/common";
import {
  adminUserReplayContextSchema,
  type AdminUserCreateRequest,
  type AdminUserDisableRequest,
  type AdminUserItem,
  type AdminUserOffboardingProject,
  type AdminUserOffboardingResponse,
  type AdminUserUpdateRequest,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../database/transaction-context.js";
import type { HttpHeaderBag } from "../auth/csrf.http.js";
import { AdminHighRiskAuthService } from "../auth/admin-high-risk.service.js";
import { notAdmin } from "../auth/admin-high-risk.error.js";
import { PostgresUserSessionRepository } from "../auth/user-session.repository.js";
import { AuditWritePort } from "../audit/index.js";
import { ActivityWritePort } from "../modules/activity/index.js";
import { ProjectMembersQueryPort } from "../modules/projects/index.js";
import {
  ProjectMemberTaskCommandError,
  ProjectMemberTaskCommandPort,
} from "../modules/tasks/index.js";
import { TaskDeletionCommandPort } from "../modules/tasks/task-deletion.command-port.js";
import { TaskManagementError } from "../modules/tasks/tasks-management.service.js";
import { TaskDeletionWorkflow } from "../workflows/task-deletion.workflow.js";
import { AdminUserRepository } from "./admin-user.repository.js";
import { AdminUserOffboardingRepository } from "./admin-user-offboarding.repository.js";
import {
  adminUserActiveProjectMembership,
  adminUserNotFound,
  adminUserOffboardingConflict,
  adminUserOffboardingInvalid,
  adminUserOffboardingTaskNotFound,
  adminUserSelfMutation,
  adminUserStateConflict,
  adminUserVersionConflict,
  lastActiveAdmin,
} from "./admin-user.error.js";

export interface AdminUserMutationMeta {
  readonly actorId: number;
  readonly headers: HttpHeaderBag;
  readonly requestId: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** F-03 用户管理业务服务；每个写命令显式接收同一 TransactionContext。 */
@Injectable()
export class AdminUserService {
  constructor(
    private readonly repository: AdminUserRepository,
    private readonly offboardingRepository: AdminUserOffboardingRepository,
    private readonly sessions: PostgresUserSessionRepository,
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    private readonly projectMembers: ProjectMembersQueryPort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
    @Inject(ProjectMemberTaskCommandPort)
    private readonly projectMemberTasks: ProjectMemberTaskCommandPort,
    @Inject(TaskDeletionCommandPort)
    private readonly taskDeletionCommands: TaskDeletionCommandPort,
    @Inject(TaskDeletionWorkflow)
    private readonly taskDeletion: TaskDeletionWorkflow,
  ) {}

  async offboarding(
    tx: TransactionContext,
    userId: number,
  ): Promise<AdminUserOffboardingResponse> {
    const user = await this.repository.find(tx, userId);
    if (user === undefined) throw adminUserNotFound();
    return {
      user,
      projects: await this.offboardingRepository.load(tx, userId),
    };
  }

  async create(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    input: AdminUserCreateRequest,
    passwordHash: string,
  ): Promise<AdminUserItem> {
    await this.verifyBeforeLocks(tx, meta.headers);
    const actor = await this.lockActorSessionAndVerify(tx, meta.headers);
    this.assertActor(actor.userId, meta.actorId);
    const created = await this.repository.create(tx, input, passwordHash);
    await this.appendAudit(tx, meta, "admin.user.create", created.id, {
      loginName: created.loginName,
      name: created.name,
      isAdmin: created.isAdmin,
      status: created.status,
    });
    return created;
  }

  async update(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userId: number,
    input: AdminUserUpdateRequest,
    version: number,
  ): Promise<AdminUserItem> {
    await this.verifyBeforeLocks(tx, meta.headers);
    const candidate = await this.repository.find(tx, userId);
    if (candidate === undefined) throw adminUserNotFound();
    this.rejectSelfRoleRemoval(candidate, input, meta.actorId);
    const requiresAdminGuard =
      input.isAdmin !== undefined &&
      candidate.isAdmin &&
      candidate.status === "ACTIVE" &&
      input.isAdmin !== candidate.isAdmin;
    const current = await this.lockTarget(tx, userId, requiresAdminGuard);
    if (current.rowVersion !== version) throw adminUserVersionConflict();
    if (current.deletedAt !== null) throw adminUserStateConflict();
    this.rejectSelfRoleRemoval(current, input, meta.actorId);
    if (requiresAdminGuard) await this.ensureOtherActiveAdmin(tx, current);
    const actor = await this.lockActorSessionAndVerify(tx, meta.headers);
    this.assertActor(actor.userId, meta.actorId);
    const updated = await this.repository.update(tx, current, input);
    if (updated === undefined) throw adminUserVersionConflict();
    await this.appendAudit(tx, meta, "admin.user.update", updated.id, {
      before: this.summary(current),
      after: this.summary(updated),
    });
    return updated;
  }

  async disable(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userId: number,
    version: number,
    request: AdminUserDisableRequest = { tasks: [] },
  ): Promise<void> {
    await this.verifyBeforeLocks(tx, meta.headers);
    const candidate = await this.repository.find(tx, userId);
    if (candidate === undefined) throw adminUserNotFound();
    if (candidate.id === meta.actorId) throw adminUserSelfMutation();
    const requiresAdminGuard =
      candidate.isAdmin && candidate.status === "ACTIVE";
    const current = await this.lockTarget(tx, userId, requiresAdminGuard);
    if (current.rowVersion !== version) throw adminUserVersionConflict();
    if (current.status !== "ACTIVE") throw adminUserStateConflict();
    if (current.id === meta.actorId) throw adminUserSelfMutation();

    // 用户行先锁住，再读交接清单：此后新任务再尝试把该账号设为负责人时，
    // checkAssignableMember 会等待本事务并在停用提交后失败。
    const projects = await this.offboardingRepository.load(tx, userId);
    this.assertHandoverPlan(projects, userId, request);

    const actions = new Map(
      request.tasks.map((action) => [action.taskId, action] as const),
    );
    const tasks = projects
      .flatMap((project) => project.tasks)
      .sort((left, right) => left.taskId - right.taskId);
    const reassignedTaskIds: number[] = [];
    const deletedTaskIds: number[] = [];

    for (const task of tasks) {
      const action = actions.get(task.taskId);
      if (action?.delete === true) {
        await this.deleteHandoverTask(tx, meta, current.name, task);
        deletedTaskIds.push(task.taskId);
        continue;
      }
      await this.reassignHandoverTask(
        tx,
        meta,
        userId,
        task,
        action?.assigneeIds ?? [],
      );
      reassignedTaskIds.push(task.taskId);
    }

    const remaining = await this.offboardingRepository.load(tx, userId);
    if (remaining.length > 0) {
      const count = remaining.reduce(
        (total, project) => total + project.tasks.length,
        0,
      );
      throw adminUserOffboardingConflict(
        "ADMIN_USER_OFFBOARDING_INCOMPLETE",
        `交接期间仍有 ${count} 个未完成任务，请刷新后重试`,
      );
    }

    if (requiresAdminGuard) await this.ensureOtherActiveAdmin(tx, current);
    const actor = await this.lockActorSessionAndVerify(tx, meta.headers);
    this.assertActor(actor.userId, meta.actorId);
    const disabled = await this.repository.disable(tx, current);
    if (disabled === undefined) throw adminUserVersionConflict();
    const revoked = await this.sessions.revokeAllForUser(tx, userId);
    await this.appendAudit(tx, meta, "admin.user.disable", disabled.id, {
      before: this.summary(current),
      after: this.summary(disabled),
      revokedSessionCount: revoked,
      reassignedTaskIds,
      deletedTaskIds,
    });
  }

  private assertHandoverPlan(
    projects: readonly AdminUserOffboardingProject[],
    userId: number,
    request: AdminUserDisableRequest,
  ): void {
    const tasks = new Map(
      projects
        .flatMap((project) => project.tasks)
        .map((task) => [task.taskId, task] as const),
    );
    const seen = new Set<number>();
    for (const action of request.tasks) {
      if (seen.has(action.taskId)) {
        throw adminUserOffboardingInvalid(
          "ADMIN_USER_OFFBOARDING_DUPLICATE_TASK",
          "同一个任务不能重复提交",
        );
      }
      seen.add(action.taskId);
      const task = tasks.get(action.taskId);
      if (task === undefined) throw adminUserOffboardingTaskNotFound();
      if (
        task.projectId !== action.projectId ||
        task.moduleId !== action.moduleId ||
        task.featureId !== action.featureId
      ) {
        throw adminUserOffboardingInvalid(
          "ADMIN_USER_OFFBOARDING_TASK_SCOPE_MISMATCH",
          "任务归属与交接清单不一致，请刷新后重试",
        );
      }
      if (task.rowVersion !== action.rowVersion) {
        throw adminUserOffboardingConflict(
          "ADMIN_USER_OFFBOARDING_VERSION_CONFLICT",
          "任务已在其他窗口被修改，请刷新后重试",
        );
      }
      if (action.assigneeIds.includes(userId)) {
        throw adminUserOffboardingInvalid(
          "ADMIN_USER_OFFBOARDING_SELF_ASSIGNEE",
          "不能把待停用账号继续设为接手人",
        );
      }
      if (action.delete && !task.requiresHandover) {
        throw adminUserOffboardingInvalid(
          "ADMIN_USER_OFFBOARDING_DELETE_NOT_ALLOWED",
          "只有唯一负责人任务可以删除；多负责人任务请保留其他人继续负责",
        );
      }
    }
    for (const task of tasks.values()) {
      if (!task.requiresHandover) continue;
      const action = request.tasks.find(
        (candidate) => candidate.taskId === task.taskId,
      );
      if (
        action === undefined ||
        (!action.delete && action.assigneeIds.length === 0)
      ) {
        throw adminUserOffboardingInvalid(
          "ADMIN_USER_OFFBOARDING_TASK_REQUIRED",
          `任务 ${task.code} 只有该账号一个负责人，请指定接手人或删除任务`,
        );
      }
    }
  }

  private async reassignHandoverTask(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userId: number,
    task: AdminUserOffboardingProject["tasks"][number],
    assigneeIds: readonly number[],
  ): Promise<void> {
    try {
      await this.projectMemberTasks.reassign(tx, {
        actorId: meta.actorId,
        projectId: task.projectId,
        targetUserId: userId,
        assignments: [
          {
            taskId: task.taskId,
            moduleId: task.moduleId,
            featureId: task.featureId,
            rowVersion: task.rowVersion,
            assigneeIds,
          },
        ],
        requestId: meta.requestId,
      });
    } catch (error) {
      this.rethrowHandoverError(error);
    }
  }

  private async deleteHandoverTask(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userName: string,
    task: AdminUserOffboardingProject["tasks"][number],
  ): Promise<void> {
    const scope = {
      projectId: task.projectId,
      moduleId: task.moduleId,
      featureId: task.featureId,
    };
    try {
      await this.taskDeletionCommands.authorize(
        tx,
        meta.actorId,
        scope,
        task.taskId,
      );
      await this.taskDeletion.deleteWithinTransaction(tx, {
        projectId: task.projectId,
        taskId: task.taskId,
        rowVersion: task.rowVersion,
        actorId: meta.actorId,
        reason: `账号 ${userName} 停用前交接：删除无人接手任务`,
        requestId: meta.requestId,
      });
    } catch (error) {
      this.rethrowHandoverError(error);
    }
  }

  private rethrowHandoverError(error: unknown): never {
    if (
      error instanceof ProjectMemberTaskCommandError ||
      error instanceof TaskManagementError
    ) {
      if (error.status === 404) throw adminUserOffboardingTaskNotFound();
      if (error.status === 422)
        throw adminUserOffboardingInvalid(error.code, error.message);
      throw adminUserOffboardingConflict(error.code, error.message);
    }
    throw error;
  }

  async enable(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userId: number,
    version: number,
  ): Promise<void> {
    await this.verifyBeforeLocks(tx, meta.headers);
    const current = await this.lockTarget(tx, userId, false);
    if (current === undefined) throw adminUserNotFound();
    if (current.rowVersion !== version) throw adminUserVersionConflict();
    if (current.status !== "DISABLED" || current.deletedAt !== null) {
      throw adminUserStateConflict();
    }
    const actor = await this.lockActorSessionAndVerify(tx, meta.headers);
    this.assertActor(actor.userId, meta.actorId);
    const enabled = await this.repository.enable(tx, current);
    if (enabled === undefined) throw adminUserVersionConflict();
    await this.appendAudit(tx, meta, "admin.user.enable", enabled.id, {
      before: this.summary(current),
      after: this.summary(enabled),
    });
  }

  async delete(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userId: number,
    version: number,
  ): Promise<void> {
    await this.verifyBeforeLocks(tx, meta.headers);
    if (userId === meta.actorId) throw adminUserSelfMutation();
    const current = await this.lockTarget(tx, userId, false);
    if (current.rowVersion !== version) throw adminUserVersionConflict();
    if (current.status !== "DISABLED" || current.deletedAt !== null) {
      throw adminUserStateConflict();
    }
    const memberships = await this.projectMembers.listActiveMembershipsForUser(
      tx,
      { userId },
    );
    if (memberships.length > 0) throw adminUserActiveProjectMembership();
    const actor = await this.lockActorSessionAndVerify(tx, meta.headers);
    this.assertActor(actor.userId, meta.actorId);
    const deleted = await this.repository.delete(tx, current);
    if (deleted === undefined) throw adminUserVersionConflict();
    const revoked = await this.sessions.revokeAllForUser(tx, userId);
    const renamedActivityCount = await this.activity.renameUserReferences(tx, {
      userId,
      previousName: current.name,
      replacementName: "删除用户",
    });
    await this.appendAudit(tx, meta, "admin.user.delete", deleted.id, {
      before: this.summary(current),
      after: this.summary(deleted),
      revokedSessionCount: revoked,
      renamedActivityCount,
    });
  }

  async replay(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const parsed = adminUserReplayContextSchema.parse(context);
    if (parsed.actorUserId !== actorId) throw notAdmin();
    if ((await this.repository.find(tx, parsed.userId)) === undefined) {
      throw adminUserNotFound();
    }
  }

  private rejectSelfRoleRemoval(
    target: AdminUserItem,
    input: AdminUserUpdateRequest,
    actorId: number,
  ): void {
    if (
      target.id === actorId &&
      input.isAdmin !== undefined &&
      input.isAdmin === false &&
      target.isAdmin
    ) {
      throw adminUserSelfMutation();
    }
  }

  private async lockTarget(
    tx: TransactionContext,
    userId: number,
    requiresAdminGuard: boolean,
  ): Promise<AdminUserItem> {
    if (!requiresAdminGuard) {
      const target = await this.repository.find(tx, userId, true);
      if (target === undefined) throw adminUserNotFound();
      return target;
    }
    await this.repository.activeAdminIds(tx);
    const target = await this.repository.find(tx, userId, true);
    if (target === undefined) throw adminUserNotFound();
    return target;
  }

  private async ensureOtherActiveAdmin(
    tx: TransactionContext,
    target: AdminUserItem,
  ): Promise<void> {
    const ids = await this.repository.activeAdminIds(tx);
    if (ids.every((id) => id !== target.id)) {
      throw lastActiveAdmin();
    }
    if (ids.filter((id) => id !== target.id).length === 0) {
      throw lastActiveAdmin();
    }
  }

  private async verifyBeforeLocks(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<void> {
    await this.highRisk.verify(tx, headers);
  }

  private async lockActorSessionAndVerify(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<{ readonly userId: number }> {
    const actor = await this.highRisk.verify(tx, headers);
    await this.sessions.lockById(tx, actor.sessionId);
    return this.highRisk.verify(tx, headers);
  }

  private assertActor(actual: number, expected: number): void {
    if (actual !== expected) throw notAdmin();
  }

  private async appendAudit(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    action: string,
    targetId: number,
    eventPayload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: meta.actorId,
      action,
      targetType: "USER",
      targetId: String(targetId),
      eventPayload,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private summary(user: AdminUserItem): Readonly<Record<string, unknown>> {
    return {
      id: user.id,
      loginName: user.loginName,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
      organizationId: user.organizationId,
      status: user.status,
      openTaskCount: user.openTaskCount,
      deletedAt: user.deletedAt,
      rowVersion: user.rowVersion,
    };
  }
}

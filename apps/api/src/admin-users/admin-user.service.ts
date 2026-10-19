import { Inject, Injectable } from "@nestjs/common";
import {
  adminUserReplayContextSchema,
  type AdminUserCreateRequest,
  type AdminUserItem,
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
import { AdminUserRepository } from "./admin-user.repository.js";
import {
  adminUserActiveProjectMembership,
  adminUserNotFound,
  adminUserOpenTasks,
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
    private readonly sessions: PostgresUserSessionRepository,
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
    private readonly projectMembers: ProjectMembersQueryPort,
    @Inject(ActivityWritePort) private readonly activity: ActivityWritePort,
  ) {}

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
    if (current.openTaskCount > 0) {
      throw adminUserOpenTasks(current.openTaskCount);
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
    });
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

  async forceLogout(
    tx: TransactionContext,
    meta: AdminUserMutationMeta,
    userId: number,
    version: number,
  ): Promise<void> {
    await this.verifyBeforeLocks(tx, meta.headers);
    const candidate = await this.repository.find(tx, userId);
    if (candidate === undefined) throw adminUserNotFound();
    if (candidate.id === meta.actorId) throw adminUserSelfMutation();
    const current = await this.lockTarget(tx, userId, false);
    if (current.rowVersion !== version) throw adminUserVersionConflict();
    if (current.deletedAt !== null) throw adminUserStateConflict();
    if (current.id === meta.actorId) throw adminUserSelfMutation();
    const actor = await this.lockActorSessionAndVerify(tx, meta.headers);
    this.assertActor(actor.userId, meta.actorId);
    const loggedOut = await this.repository.forceLogout(tx, current);
    if (loggedOut === undefined) throw adminUserVersionConflict();
    const revoked = await this.sessions.revokeAllForUser(tx, userId);
    await this.appendAudit(tx, meta, "admin.user.force_logout", loggedOut.id, {
      before: this.summary(current),
      after: this.summary(loggedOut),
      revokedSessionCount: revoked,
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

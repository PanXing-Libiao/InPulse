import { Inject, Injectable } from "@nestjs/common";
import type {
  OrganizationAssignRequest,
  OrganizationCreateRequest,
  OrganizationItem,
  OrganizationUpdateRequest,
} from "@inpulse/api-contract";

import { AdminHighRiskAuthService } from "../auth/admin-high-risk.service.js";
import type { HttpHeaderBag } from "../auth/csrf.http.js";
import { AuditWritePort } from "../audit/index.js";
import type { TransactionContext } from "../database/transaction-context.js";
import {
  organizationNotFound,
  organizationSsoManaged,
  organizationVersionConflict,
} from "./organization.error.js";
import { OrganizationRepository } from "./organization.repository.js";

export interface OrganizationMutationMeta {
  readonly actorId: number;
  readonly headers: HttpHeaderBag;
  readonly requestId: string;
}

/** 去重并按用户 ID 升序规范化批量归属输入（幂等摘要按原始请求计算）。 */
export function normalizeOrganizationUserIds(
  userIds: readonly number[],
): number[] {
  return [...new Set(userIds)].sort((left, right) => left - right);
}

/**
 * ADR-081 组织业务服务；每个写命令显式接收同一 TransactionContext。
 * 管理员身份与 CSRF 由 AdminHighRiskAuthService 在同一事务内校验。
 */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
  ) {}

  async list(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<OrganizationItem[]> {
    await this.highRisk.verifyRead(tx, headers);
    return this.repository.list(tx);
  }

  async create(
    tx: TransactionContext,
    meta: OrganizationMutationMeta,
    input: OrganizationCreateRequest,
  ): Promise<OrganizationItem> {
    await this.highRisk.verify(tx, meta.headers);
    const created = await this.repository.createLocal(tx, input.name);
    await this.appendAudit(tx, meta, "admin.organization.create", created.id, {
      organizationId: created.id,
      name: created.name,
    });
    return created;
  }

  async update(
    tx: TransactionContext,
    meta: OrganizationMutationMeta,
    organizationId: number,
    input: OrganizationUpdateRequest,
    version: number,
  ): Promise<OrganizationItem> {
    await this.highRisk.verify(tx, meta.headers);
    const current = await this.repository.find(tx, organizationId, true);
    if (current === undefined) throw organizationNotFound();
    if (current.source === "CASDOOR") throw organizationSsoManaged();
    if (current.rowVersion !== version) throw organizationVersionConflict();
    const updated = await this.repository.updateName(tx, current, input.name);
    if (updated === undefined) throw organizationVersionConflict();
    await this.appendAudit(tx, meta, "admin.organization.update", updated.id, {
      before: { name: current.name, rowVersion: current.rowVersion },
      after: { name: updated.name, rowVersion: updated.rowVersion },
    });
    return updated;
  }

  async delete(
    tx: TransactionContext,
    meta: OrganizationMutationMeta,
    organizationId: number,
    version: number,
  ): Promise<void> {
    await this.highRisk.verify(tx, meta.headers);
    const current = await this.repository.find(tx, organizationId, true);
    if (current === undefined) throw organizationNotFound();
    if (current.source === "CASDOOR") throw organizationSsoManaged();
    if (current.rowVersion !== version) throw organizationVersionConflict();
    const memberCount = await this.repository.clearMembers(tx, organizationId);
    await this.repository.remove(tx, current);
    await this.appendAudit(
      tx,
      meta,
      "admin.organization.delete",
      organizationId,
      {
        organizationId,
        name: current.name,
        memberCount,
      },
    );
  }

  async assignUsers(
    tx: TransactionContext,
    meta: OrganizationMutationMeta,
    input: OrganizationAssignRequest,
  ): Promise<number> {
    await this.highRisk.verify(tx, meta.headers);
    const userIds = normalizeOrganizationUserIds(input.userIds);
    if (input.organizationId !== null) {
      const organization = await this.repository.find(
        tx,
        input.organizationId,
        true,
      );
      if (organization === undefined) throw organizationNotFound(422);
      if (organization.source === "CASDOOR") throw organizationSsoManaged();
    }
    const lockedUsers = await this.repository.lockUsers(tx, userIds);
    if (lockedUsers.some((user) => user.managedBySso)) {
      throw organizationSsoManaged();
    }
    const assignableUserIds = lockedUsers.map((user) => user.id);
    const updatedCount = await this.repository.assignUsers(
      tx,
      assignableUserIds,
      input.organizationId,
    );
    await this.appendAudit(
      tx,
      meta,
      "admin.user.organizations.assign",
      input.organizationId,
      {
        organizationId: input.organizationId,
        userIds: assignableUserIds,
        updatedCount,
      },
    );
    return updatedCount;
  }

  private async appendAudit(
    tx: TransactionContext,
    meta: OrganizationMutationMeta,
    action: string,
    targetId: number | null,
    eventPayload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: meta.actorId,
      action,
      targetType: "ORGANIZATION",
      targetId: targetId === null ? null : String(targetId),
      eventPayload,
      requestId: meta.requestId,
      ipAddress: null,
      userAgent: null,
    });
  }
}

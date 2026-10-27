import { Inject, Injectable } from "@nestjs/common";
import type {
  CasdoorImportPreviewResponse,
  CasdoorImportResult,
} from "@inpulse/api-contract";

import { AuditWritePort } from "../audit/audit.port.js";
import type { CasdoorImportPort } from "../auth/sso/casdoor-import.port.js";
import { CASDOOR_IMPORT_PORT } from "../auth/sso/casdoor-import.port.js";
import type { CasdoorDirectorySnapshot } from "../auth/sso/sso-casdoor-directory.client.js";
import type { TransactionContext } from "../database/transaction-context.js";

export interface CasdoorImportAuditMeta {
  readonly actorId: number;
  readonly requestId: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** ADR-100 管理员侧应用服务：预览映射、导入结果与单条批次审计。 */
@Injectable()
export class AdminCasdoorImportService {
  constructor(
    @Inject(CASDOOR_IMPORT_PORT)
    private readonly directory: CasdoorImportPort,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
  ) {}

  async preview(
    tx: TransactionContext,
    snapshot: CasdoorDirectorySnapshot,
  ): Promise<CasdoorImportPreviewResponse> {
    const entries = await this.directory.preview(tx, snapshot);
    const counts = { create: 0, link: 0, refresh: 0, unchanged: 0, skip: 0 };
    const items = entries.map((entry) => {
      counts[entry.action] += 1;
      return {
        casdoorId: entry.user.casdoorId,
        loginName: entry.user.loginName,
        displayName: entry.user.displayName,
        email: entry.user.email,
        groups: [...entry.user.groups],
        action: entry.action,
        reason: entry.reason,
      };
    });
    return {
      organization: snapshot.organization,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      scannedUserCount: snapshot.users.length,
      items,
      counts,
    };
  }

  async import(
    tx: TransactionContext,
    meta: CasdoorImportAuditMeta,
    snapshot: CasdoorDirectorySnapshot,
    selectedIds: readonly string[],
  ): Promise<CasdoorImportResult> {
    const result = await this.directory.importSelected(
      tx,
      snapshot,
      selectedIds,
    );
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: meta.actorId,
      action: "admin.user.casdoorImport",
      targetType: "CASDOOR_ORGANIZATION",
      targetId: snapshot.organization,
      eventPayload: {
        organization: snapshot.organization,
        ...result,
      },
      requestId: meta.requestId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return result;
  }
}

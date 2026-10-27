import type { TransactionContext } from "../../database/transaction-context.js";
import type {
  CasdoorDirectorySnapshot,
  CasdoorDirectoryUser,
} from "./sso-casdoor-directory.client.js";
import type {
  SsoIdentityPreview,
  SsoIdentityPreviewSkipReason,
} from "./sso-user.repository.js";

/** ADR-100：Admin Users 只通过该公开端口触发 Casdoor 目录读取与身份导入。 */
export const CASDOOR_IMPORT_PORT = Symbol("CASDOOR_IMPORT_PORT");

export type CasdoorImportPreviewSkipReason = SsoIdentityPreviewSkipReason;

export interface CasdoorImportPreviewEntry {
  readonly user: CasdoorDirectoryUser;
  readonly action: "create" | "link" | "refresh" | "unchanged" | "skip";
  readonly reason: CasdoorImportPreviewSkipReason | null;
}

export interface CasdoorImportExecutionResult {
  readonly scannedUserCount: number;
  readonly created: number;
  readonly linked: number;
  readonly refreshed: number;
  readonly skipped: number;
  readonly createdOrganizationCount: number;
  readonly membershipCount: number;
}

export interface CasdoorImportPort {
  /** 读取目录与群组元数据；必须在数据库事务外调用。 */
  loadDirectory(): Promise<CasdoorDirectorySnapshot>;

  /** 只读分类当前平台身份映射；必须在事务内调用，不写库。 */
  preview(
    tx: TransactionContext,
    snapshot: CasdoorDirectorySnapshot,
  ): Promise<readonly CasdoorImportPreviewEntry[]>;

  /** 在调用方单事务内创建/绑定/刷新账号并同步 Physical 组织。 */
  importSelected(
    tx: TransactionContext,
    snapshot: CasdoorDirectorySnapshot,
    selectedIds: readonly string[],
  ): Promise<CasdoorImportExecutionResult>;
}

export function selectDirectoryUsers(
  snapshot: CasdoorDirectorySnapshot,
  selectedIds: readonly string[],
): readonly CasdoorDirectoryUser[] {
  const byId = new Map(
    snapshot.users.map((user) => [user.casdoorId, user] as const),
  );
  const selected: CasdoorDirectoryUser[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) {
      throw new CasdoorDirectorySelectionError("duplicate-selection");
    }
    seen.add(id);
    const user = byId.get(id);
    if (user === undefined) {
      throw new CasdoorDirectorySelectionError("selection-stale");
    }
    selected.push(user);
  }
  return selected;
}

export class CasdoorDirectorySelectionError extends Error {
  constructor(readonly reason: "duplicate-selection" | "selection-stale") {
    super(`Casdoor directory selection invalid: ${reason}`);
    this.name = "CasdoorDirectorySelectionError";
  }
}

export function countPreview(preview: readonly SsoIdentityPreview[]): {
  create: number;
  link: number;
  refresh: number;
  unchanged: number;
  skip: number;
} {
  const counts = { create: 0, link: 0, refresh: 0, unchanged: 0, skip: 0 };
  for (const entry of preview) {
    if (entry.kind === "skip") counts.skip += 1;
    else counts[entry.action] += 1;
  }
  return counts;
}

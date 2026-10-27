import type { TransactionContext } from "../../database/transaction-context.js";
import {
  normalizeCasdoorGroupPaths,
  selectCasdoorEntityGroups,
} from "../../organizations/casdoor-group-path.js";
import type { OrganizationSyncPort } from "../../organizations/organization-sync.port.js";
import {
  CasdoorDirectorySelectionError,
  selectDirectoryUsers,
  type CasdoorImportExecutionResult,
  type CasdoorImportPort,
  type CasdoorImportPreviewEntry,
} from "./casdoor-import.port.js";
import {
  SsoCasdoorDirectoryError,
  type CasdoorDirectorySnapshot,
  type SsoCasdoorDirectoryClient,
} from "./sso-casdoor-directory.client.js";
import type { SsoCasdoorGroupClient } from "./sso-casdoor-group.client.js";
import type { SsoCasdoorPermissionClient } from "./sso-casdoor-permission.client.js";
import type {
  PostgresSsoUserRepository,
  SsoIdentityClaims,
} from "./sso-user.repository.js";

/** ADR-100：把脱敏目录快照、既有 SSO 身份映射和 Physical 组织同步串成单事务导入。 */
export class PostgresCasdoorImportService implements CasdoorImportPort {
  constructor(
    private readonly users: PostgresSsoUserRepository,
    private readonly organizationSync: OrganizationSyncPort,
    private readonly groupDirectory: SsoCasdoorGroupClient,
    private readonly directory: SsoCasdoorDirectoryClient,
    private readonly permission?: SsoCasdoorPermissionClient,
  ) {}

  async loadDirectory(): Promise<CasdoorDirectorySnapshot> {
    const loaded = await this.directory.load();
    const scope =
      this.permission === undefined
        ? undefined
        : await this.permission.resolveScope(loaded.organization);
    const scopedUsers =
      scope === undefined
        ? loaded.users
        : loaded.users
            .filter((user) => {
              const userResourceId = loaded.organization + "/" + user.loginName;
              return (
                user.groups.some((groupId) => scope.groupIds.has(groupId)) ||
                scope.userIds.has(userResourceId)
              );
            })
            .map((user) => ({
              ...user,
              groups: user.groups.filter((groupId) =>
                scope.groupIds.has(groupId),
              ),
            }));
    const snapshot = {
      ...loaded,
      users: scopedUsers,
    };
    const groupIds = [
      ...new Set(snapshot.users.flatMap((user) => user.groups)),
    ];
    const physicalGroupByDirectId =
      groupIds.length === 0
        ? new Map<string, string>()
        : await this.groupDirectory.resolvePhysicalImportGroups(
            snapshot.organization,
            groupIds,
          );

    return {
      ...snapshot,
      users: snapshot.users.map((user) => {
        const resolvedPaths = [
          ...new Set(
            user.groups.flatMap((groupId) => {
              const groupPath = physicalGroupByDirectId.get(groupId);
              return groupPath === undefined ? [] : [groupPath];
            }),
          ),
        ];
        const effectiveGroups = selectCasdoorEntityGroups(
          normalizeCasdoorGroupPaths(resolvedPaths),
        ).map((group) => group.path);
        return { ...user, groups: effectiveGroups };
      }),
    };
  }

  async preview(
    tx: TransactionContext,
    snapshot: CasdoorDirectorySnapshot,
  ): Promise<readonly CasdoorImportPreviewEntry[]> {
    const classifications = await this.users.previewIdentities(
      tx,
      snapshot.users.map(toClaims),
    );
    const entries: CasdoorImportPreviewEntry[] = [];
    for (const [index, user] of snapshot.users.entries()) {
      const classification = classifications[index];
      if (classification === undefined) {
        throw new Error("Casdoor preview classification is missing");
      }
      if (classification.kind === "skip") {
        entries.push({ user, action: "skip", reason: classification.reason });
        continue;
      }
      if (classification.action !== "refresh") {
        entries.push({ user, action: classification.action, reason: null });
        continue;
      }
      const organizationChanged =
        await this.organizationSync.hasSsoMembershipChanges({
          tx,
          userId: classification.userId,
          groups: user.groups,
        });
      entries.push({
        user,
        action:
          classification.profileChanged || organizationChanged
            ? "refresh"
            : "unchanged",
        reason: null,
      });
    }
    return entries;
  }

  async importSelected(
    tx: TransactionContext,
    snapshot: CasdoorDirectorySnapshot,
    selectedIds: readonly string[],
  ): Promise<CasdoorImportExecutionResult> {
    const selected = selectDirectoryUsers(snapshot, selectedIds);
    let created = 0;
    let linked = 0;
    let refreshed = 0;
    let skipped = 0;
    let createdOrganizationCount = 0;
    let membershipCount = 0;

    for (const user of selected) {
      const mapped = await this.users.mapIdentity(tx, toClaims(user), {
        allowFirstAdmin: false,
      });
      if (mapped.kind === "conflict") {
        skipped += 1;
        continue;
      }
      if (mapped.user.status !== "ACTIVE" || mapped.user.deletedAt !== null) {
        skipped += 1;
        continue;
      }
      const organizationResult = await this.organizationSync.syncSsoMemberships(
        {
          tx,
          userId: mapped.user.id,
          groups: user.groups,
        },
      );
      createdOrganizationCount += organizationResult.createdOrganizationCount;
      membershipCount += organizationResult.membershipCount;
      if (mapped.outcome === "provisioned") created += 1;
      else if (mapped.outcome === "linked") linked += 1;
      else refreshed += 1;
    }

    return {
      scannedUserCount: selected.length,
      created,
      linked,
      refreshed,
      skipped,
      createdOrganizationCount,
      membershipCount,
    };
  }
}

function toClaims(
  user: CasdoorDirectorySnapshot["users"][number],
): SsoIdentityClaims {
  return {
    subject: user.casdoorId,
    loginName: user.loginName,
    displayName: user.displayName,
    email: user.email,
  };
}

export { CasdoorDirectorySelectionError };
/** SSO 未启用或配置非法时保持路由存在但 fail closed，供管理员页显示明确错误。 */
export class DisabledCasdoorImportService implements CasdoorImportPort {
  async loadDirectory(): Promise<CasdoorDirectorySnapshot> {
    throw new SsoCasdoorDirectoryError("not-configured");
  }

  async preview(): Promise<readonly CasdoorImportPreviewEntry[]> {
    throw new SsoCasdoorDirectoryError("not-configured");
  }

  async importSelected(): Promise<CasdoorImportExecutionResult> {
    throw new SsoCasdoorDirectoryError("not-configured");
  }
}

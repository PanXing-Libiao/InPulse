import { Injectable } from "@nestjs/common";

import type { TransactionContext } from "../database/transaction-context.js";
import {
  expandCasdoorGroupAncestors,
  normalizeCasdoorGroupPaths,
  selectCasdoorEntityGroups,
} from "./casdoor-group-path.js";
import type {
  OrganizationSyncPort,
  SsoMembershipChangeInput,
  SsoOrganizationSyncInput,
  SsoOrganizationSyncResult,
} from "./organization-sync.port.js";

interface LockedSsoUser {
  readonly ssoSubject: string | null;
}

/**
 * ADR-097 / ADR-098：SSO 用户组织归属的全量对账。祖先路径只建立组织层级，
 * 用户直接归属收敛到 claim 中的最深实体群组。调用方必须传入已验签 claims
 * 所在的同一个 UnitOfWork；本服务不发网络请求，也不自行提交事务。
 */
@Injectable()
export class PostgresOrganizationSyncService implements OrganizationSyncPort {
  async syncSsoMemberships(
    input: SsoOrganizationSyncInput,
  ): Promise<SsoOrganizationSyncResult> {
    if (input.groups === null) {
      return {
        groupsClaimPresent: false,
        groupCount: 0,
        createdOrganizationCount: 0,
        membershipCount: 0,
      };
    }

    const groups = selectCasdoorEntityGroups(
      normalizeCasdoorGroupPaths(input.groups),
    );
    const user = await this.lockSsoUser(input.tx, input.userId);
    if (user === undefined || user.ssoSubject === null) {
      throw new Error("SSO organization sync requires an SSO-managed user");
    }

    if (groups.length === 0) {
      await this.clearMemberships(input.tx, input.userId);
      return {
        groupsClaimPresent: true,
        groupCount: 0,
        createdOrganizationCount: 0,
        membershipCount: 0,
      };
    }

    const organizationIds = new Map<string, number>();
    let createdOrganizationCount = 0;
    for (const group of expandCasdoorGroupAncestors(groups)) {
      const parentId =
        group.parentPath === null
          ? null
          : organizationIds.get(group.parentPath);
      if (group.parentPath !== null && parentId === undefined) {
        throw new Error("Casdoor organization ancestor was not created");
      }
      const inserted = (await input.tx.sql`
        INSERT INTO app.organizations (
          name,
          source,
          sso_owner,
          sso_group_path,
          sso_parent_path,
          parent_id
        )
        VALUES (
          ${group.name},
          'CASDOOR',
          ${group.owner},
          ${group.path},
          ${group.parentPath},
          ${parentId ?? null}
        )
        ON CONFLICT (sso_owner, sso_group_path)
          WHERE source = 'CASDOOR'
        DO NOTHING
        RETURNING id
      `) as unknown as readonly { readonly id: number }[];
      let organizationId = inserted[0]?.id;
      if (organizationId !== undefined) {
        createdOrganizationCount += 1;
      } else {
        const existing = (await input.tx.sql`
          SELECT id
            FROM app.organizations
           WHERE source = 'CASDOOR'
             AND sso_owner = ${group.owner}
             AND sso_group_path = ${group.path}
           LIMIT 1
        `) as unknown as readonly { readonly id: number }[];
        organizationId = existing[0]?.id;
      }
      if (organizationId === undefined) {
        throw new Error("Casdoor organization could not be loaded");
      }
      organizationIds.set(group.path, organizationId);
    }

    await this.clearMemberships(input.tx, input.userId);
    for (const group of groups) {
      const organizationId = organizationIds.get(group.path);
      if (organizationId === undefined) {
        throw new Error("Casdoor direct group organization is missing");
      }
      await input.tx.sql`
        INSERT INTO app.user_organizations (user_id, organization_id, source)
        VALUES (${input.userId}, ${organizationId}, 'CASDOOR')
      `;
    }

    return {
      groupsClaimPresent: true,
      groupCount: groups.length,
      createdOrganizationCount,
      membershipCount: groups.length,
    };
  }

  async hasSsoMembershipChanges(
    input: SsoMembershipChangeInput,
  ): Promise<boolean> {
    const desired = selectCasdoorEntityGroups(
      normalizeCasdoorGroupPaths(input.groups),
    ).map((group) => group.path);
    const rows = (await input.tx.sql`
      SELECT o.sso_group_path AS "groupPath"
        FROM app.user_organizations AS uo
        JOIN app.organizations AS o ON o.id = uo.organization_id
       WHERE uo.user_id = ${input.userId}
    `) as unknown as readonly { readonly groupPath: string | null }[];
    const current = new Set(rows.map((row) => row.groupPath));
    return (
      current.size !== desired.length ||
      desired.some((groupPath) => !current.has(groupPath))
    );
  }

  private async lockSsoUser(
    tx: TransactionContext,
    userId: number,
  ): Promise<LockedSsoUser | undefined> {
    const rows = (await tx.sql`
      SELECT sso_subject AS "ssoSubject"
        FROM app.users
       WHERE id = ${userId}
         AND deleted_at IS NULL
       FOR UPDATE
    `) as unknown as readonly LockedSsoUser[];
    return rows[0];
  }

  private async clearMemberships(
    tx: TransactionContext,
    userId: number,
  ): Promise<void> {
    await tx.sql`
      DELETE FROM app.user_organizations
       WHERE user_id = ${userId}
    `;
  }
}

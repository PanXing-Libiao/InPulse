import type { TransactionContext } from "../database/transaction-context.js";

/** ADR-097：Auth 只在同一事务内调用该公开端口，不接触组织内部 Repository。 */
export const ORGANIZATION_SYNC_PORT = Symbol("ORGANIZATION_SYNC_PORT");

export interface SsoOrganizationSyncInput {
  readonly tx: TransactionContext;
  readonly userId: number;
  readonly groups: readonly string[] | null;
}

export interface SsoOrganizationSyncResult {
  readonly groupsClaimPresent: boolean;
  readonly groupCount: number;
  readonly createdOrganizationCount: number;
  readonly membershipCount: number;
  readonly changed: boolean;
}

export interface SsoMembershipChangeInput {
  readonly tx: TransactionContext;
  readonly userId: number;
  readonly groups: readonly string[];
}

export interface OrganizationSyncPort {
  syncSsoMemberships(
    input: SsoOrganizationSyncInput,
  ): Promise<SsoOrganizationSyncResult>;

  hasSsoMembershipChanges(input: SsoMembershipChangeInput): Promise<boolean>;
}

import { describe, expect, test, vi } from "vitest";

import type { TransactionContext } from "../src/database/transaction-context.js";
import type { CasdoorDirectorySnapshot } from "../src/auth/sso/sso-casdoor-directory.client.js";
import {
  CasdoorDirectorySelectionError,
  PostgresCasdoorImportService,
} from "../src/auth/sso/casdoor-import.service.js";
import type { SsoUserRecord } from "../src/auth/sso/sso-user.repository.js";
import type { SsoCasdoorGroupClient } from "../src/auth/sso/sso-casdoor-group.client.js";
import type { SsoCasdoorPermissionClient } from "../src/auth/sso/sso-casdoor-permission.client.js";
import type { SsoCasdoorDirectoryClient } from "../src/auth/sso/sso-casdoor-directory.client.js";
import type { PostgresSsoUserRepository } from "../src/auth/sso/sso-user.repository.js";
import type { OrganizationSyncPort } from "../src/organizations/organization-sync.port.js";

const tx = {} as TransactionContext;
const ORGANIZATION = "libiaorobot.com";

function directoryUser(
  id: string,
  loginName: string,
  groups: readonly string[] = [],
) {
  return {
    casdoorId: id,
    loginName,
    displayName: "姓名 " + loginName,
    email: loginName + "@libiaorobot.com",
    groups,
  };
}

function snapshot(
  users: readonly ReturnType<typeof directoryUser>[],
): CasdoorDirectorySnapshot {
  return {
    organization: ORGANIZATION,
    fetchedAt: new Date("2026-10-27T00:00:00.000Z"),
    users,
  };
}

function userRecord(
  id: number,
  loginName: string,
  status: "ACTIVE" | "DISABLED" = "ACTIVE",
): SsoUserRecord {
  return {
    id,
    loginName,
    name: "姓名 " + loginName,
    email: loginName + "@libiaorobot.com",
    ssoSubject: "subject-" + loginName,
    status,
    isAdmin: false,
    authVersion: 1,
    disabledAt: status === "DISABLED" ? new Date("2026-10-01T00:00:00Z") : null,
    deletedAt: null,
  };
}

describe("PostgresCasdoorImportService", () => {
  test("目录读取只保留 Physical 实体组，并收敛父子路径到最深实体组", async () => {
    const loaded = snapshot([
      directoryUser("one", "one", [
        ORGANIZATION + "/总部",
        ORGANIZATION + "/测试部",
        ORGANIZATION + "/Virtual Group1",
      ]),
      directoryUser("two", "two", [ORGANIZATION + "/项目部"]),
      directoryUser("three", "three", []),
    ]);
    const directory = { load: vi.fn().mockResolvedValue(loaded) };
    const resolvePhysicalImportGroups = vi.fn().mockResolvedValue(
      new Map([
        [ORGANIZATION + "/总部", ORGANIZATION + "/总部"],
        [ORGANIZATION + "/测试部", ORGANIZATION + "/总部/测试部"],
        [ORGANIZATION + "/项目部", ORGANIZATION + "/项目部"],
      ]),
    );
    const service = new PostgresCasdoorImportService(
      {} as PostgresSsoUserRepository,
      {} as OrganizationSyncPort,
      {
        resolvePhysicalImportGroups,
      } as unknown as SsoCasdoorGroupClient,
      directory as unknown as SsoCasdoorDirectoryClient,
    );

    const result = await service.loadDirectory();

    expect(resolvePhysicalImportGroups).toHaveBeenCalledWith(ORGANIZATION, [
      ORGANIZATION + "/总部",
      ORGANIZATION + "/测试部",
      ORGANIZATION + "/Virtual Group1",
      ORGANIZATION + "/项目部",
    ]);
    expect(result.users.map((entry) => entry.groups)).toEqual([
      [ORGANIZATION + "/总部/测试部"],
      [ORGANIZATION + "/项目部"],
      [],
    ]);
  });

  test("导入按创建、绑定、刷新分类，冲突与停用账号跳过且不同步组织", async () => {
    const users = [
      directoryUser("create", "create"),
      directoryUser("link", "link"),
      directoryUser("refresh", "refresh"),
      directoryUser("conflict", "conflict"),
      directoryUser("disabled", "disabled"),
      directoryUser("nogroup", "nogroup", []),
    ];
    const directory = { load: vi.fn() };
    const mapIdentity = vi.fn(async (_tx, claims, options) => {
      if (claims.subject === "conflict") {
        return { kind: "conflict", reason: "email-mismatch" };
      }
      const status = claims.subject === "disabled" ? "DISABLED" : "ACTIVE";
      const outcome =
        claims.subject === "create"
          ? "provisioned"
          : claims.subject === "link"
            ? "linked"
            : "subject";
      void options;
      return {
        kind: "mapped",
        outcome,
        user: userRecord(
          users.findIndex((entry) => entry.casdoorId === claims.subject) + 1,
          claims.loginName,
          status,
        ),
      };
    });
    const syncSsoMemberships = vi.fn(async (input) => {
      if (input.userId === 1) {
        return {
          groupsClaimPresent: true,
          groupCount: 1,
          createdOrganizationCount: 1,
          membershipCount: 1,
          changed: true,
        };
      }
      if (input.userId === 2) {
        return {
          groupsClaimPresent: true,
          groupCount: 0,
          createdOrganizationCount: 0,
          membershipCount: 0,
          changed: true,
        };
      }
      return {
        groupsClaimPresent: true,
        groupCount: 0,
        createdOrganizationCount: 0,
        membershipCount: 0,
        changed: true,
      };
    });
    const service = new PostgresCasdoorImportService(
      { mapIdentity } as unknown as PostgresSsoUserRepository,
      { syncSsoMemberships } as unknown as OrganizationSyncPort,
      {
        resolvePhysicalImportGroups: vi.fn(),
      } as unknown as SsoCasdoorGroupClient,
      directory as unknown as SsoCasdoorDirectoryClient,
    );
    const directorySnapshot = snapshot(users);

    const result = await service.importSelected(
      tx,
      directorySnapshot,
      users.map((entry) => entry.casdoorId),
    );

    expect(result).toEqual({
      scannedUserCount: 6,
      created: 1,
      linked: 1,
      refreshed: 2,
      skipped: 2,
      createdOrganizationCount: 1,
      membershipCount: 1,
    });
    expect(mapIdentity).toHaveBeenCalledTimes(6);
    expect(
      mapIdentity.mock.calls.every(
        (call) => call[2]?.allowFirstAdmin === false,
      ),
    ).toBe(true);
    expect(syncSsoMemberships).toHaveBeenCalledTimes(4);
    expect(syncSsoMemberships).toHaveBeenCalledWith({
      tx,
      userId: 6,
      groups: [],
    });
  });

  test("重复选择或预览后缺失账号时拒绝整批导入", async () => {
    const users = [directoryUser("one", "one")];
    const service = new PostgresCasdoorImportService(
      { mapIdentity: vi.fn() } as unknown as PostgresSsoUserRepository,
      { syncSsoMemberships: vi.fn() } as unknown as OrganizationSyncPort,
      {} as SsoCasdoorGroupClient,
      {} as SsoCasdoorDirectoryClient,
    );
    const directorySnapshot = snapshot(users);

    await expect(
      service.importSelected(tx, directorySnapshot, ["one", "one"]),
    ).rejects.toMatchObject<Partial<CasdoorDirectorySelectionError>>({
      reason: "duplicate-selection",
    });
    await expect(
      service.importSelected(tx, directorySnapshot, ["missing"]),
    ).rejects.toMatchObject<Partial<CasdoorDirectorySelectionError>>({
      reason: "selection-stale",
    });
  });

  test("预览映射只读分类并保留契约允许的跳过原因", async () => {
    const users = [
      directoryUser("create", "create"),
      directoryUser("skip", "skip"),
    ];
    const previewIdentities = vi.fn().mockResolvedValue([
      { kind: "eligible", action: "create" },
      { kind: "skip", reason: "account-disabled" },
    ]);
    const service = new PostgresCasdoorImportService(
      { previewIdentities } as unknown as PostgresSsoUserRepository,
      {} as OrganizationSyncPort,
      {} as SsoCasdoorGroupClient,
      {} as SsoCasdoorDirectoryClient,
    );

    const result = await service.preview(tx, snapshot(users));

    expect(result[0]).toMatchObject({ action: "create", reason: null });
    expect(result[1]).toMatchObject({
      action: "skip",
      reason: "account-disabled",
    });
  });

  test("已绑定账号仅在资料或实体组变化时刷新", async () => {
    const users = [
      directoryUser("same", "same", [ORGANIZATION + "/测试部"]),
      directoryUser("profile", "profile", [ORGANIZATION + "/测试部"]),
      directoryUser("group", "group", [ORGANIZATION + "/测试部"]),
    ];
    const previewIdentities = vi.fn().mockResolvedValue([
      {
        kind: "eligible",
        action: "refresh",
        userId: 1,
        profileChanged: false,
      },
      {
        kind: "eligible",
        action: "refresh",
        userId: 2,
        profileChanged: true,
      },
      {
        kind: "eligible",
        action: "refresh",
        userId: 3,
        profileChanged: false,
      },
    ]);
    const hasSsoMembershipChanges = vi.fn(
      async (input: { readonly userId: number }) => input.userId === 3,
    );
    const service = new PostgresCasdoorImportService(
      { previewIdentities } as unknown as PostgresSsoUserRepository,
      { hasSsoMembershipChanges } as unknown as OrganizationSyncPort,
      {} as SsoCasdoorGroupClient,
      {} as SsoCasdoorDirectoryClient,
    );

    const result = await service.preview(tx, snapshot(users));

    expect(result.map((entry) => entry.action)).toEqual([
      "unchanged",
      "refresh",
      "refresh",
    ]);
    expect(hasSsoMembershipChanges).toHaveBeenCalledTimes(3);
  });

  test("配置 Casdoor Permission 时只收窄候选账号，并保留候选账号的实体组", async () => {
    const loaded = snapshot([
      directoryUser("allowed-group", "allowed-group", [
        ORGANIZATION + "/Software Project 1",
        ORGANIZATION + "/Domestic Sales Dept",
      ]),
      directoryUser("allowed-access", "allowed-access", [
        ORGANIZATION + "/Inpulse Group Access",
      ]),
      directoryUser("allowed-direct", "allowed-direct", [
        ORGANIZATION + "/Domestic Sales Dept",
      ]),
      directoryUser("denied", "denied", [
        ORGANIZATION + "/Domestic Sales Dept",
      ]),
    ]);
    const directory = { load: vi.fn().mockResolvedValue(loaded) };
    const resolvePhysicalImportGroups = vi.fn().mockResolvedValue(
      new Map([
        [
          ORGANIZATION + "/Software Project 1",
          ORGANIZATION + "/Software Project 1",
        ],
        [
          ORGANIZATION + "/Domestic Sales Dept",
          ORGANIZATION + "/Domestic Sales Dept",
        ],
      ]),
    );
    const permission = {
      resolveScope: vi.fn().mockResolvedValue({
        groupIds: new Set([
          ORGANIZATION + "/Inpulse Group Access",
          ORGANIZATION + "/Software Project 1",
        ]),
        userIds: new Set([ORGANIZATION + "/allowed-direct"]),
      }),
    };
    const service = new PostgresCasdoorImportService(
      {} as PostgresSsoUserRepository,
      {} as OrganizationSyncPort,
      {
        resolvePhysicalImportGroups,
      } as unknown as SsoCasdoorGroupClient,
      directory as unknown as SsoCasdoorDirectoryClient,
      permission as unknown as SsoCasdoorPermissionClient,
    );

    const result = await service.loadDirectory();

    expect(permission.resolveScope).toHaveBeenCalledWith(ORGANIZATION);
    expect(resolvePhysicalImportGroups).toHaveBeenCalledWith(ORGANIZATION, [
      ORGANIZATION + "/Software Project 1",
      ORGANIZATION + "/Domestic Sales Dept",
      ORGANIZATION + "/Inpulse Group Access",
    ]);
    expect(result.users.map((entry) => entry.casdoorId)).toEqual([
      "allowed-group",
      "allowed-access",
      "allowed-direct",
    ]);
    expect(result.users.map((entry) => entry.groups)).toEqual([
      [
        ORGANIZATION + "/Domestic Sales Dept",
        ORGANIZATION + "/Software Project 1",
      ],
      [],
      [ORGANIZATION + "/Domestic Sales Dept"],
    ]);
  });
});

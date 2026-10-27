import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";

import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresSsoUserRepository } from "../src/auth/sso/sso-user.repository.js";
import type { CasdoorDirectorySnapshot } from "../src/auth/sso/sso-casdoor-directory.client.js";
import type { SsoCasdoorDirectoryClient } from "../src/auth/sso/sso-casdoor-directory.client.js";
import type { SsoCasdoorGroupClient } from "../src/auth/sso/sso-casdoor-group.client.js";
import type { CasdoorImportPort } from "../src/auth/sso/casdoor-import.port.js";
import { PostgresCasdoorImportService } from "../src/auth/sso/casdoor-import.service.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { PostgresOrganizationSyncService } from "../src/organizations/organization-sync.service.js";
import { AdminCasdoorImportService } from "../src/admin-users/admin-casdoor-import.service.js";
import { createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient | undefined;
let auditReader: DatabaseClient | undefined;
let uow: PostgresUnitOfWork;
let service: AdminCasdoorImportService;
let rawSnapshot: CasdoorDirectorySnapshot;
let organization: string;
let groupPath: string;
let newLogin: string;
let linkLogin: string;
let conflictLogin: string;
let unclassifiedLogin: string;
let linkUserId: number;
let conflictUserId: number;
let adminUserId: number;

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function directoryUser(
  id: string,
  loginName: string,
  groups: readonly string[],
) {
  return {
    casdoorId: id,
    loginName,
    displayName: "姓名 " + loginName,
    email: loginName + "@libiaorobot.com",
    groups,
  };
}

function buildImportPort(): CasdoorImportPort {
  return new PostgresCasdoorImportService(
    new PostgresSsoUserRepository(),
    new PostgresOrganizationSyncService(),
    {
      resolvePhysicalImportGroups: async (
        _organization: string,
        groups: readonly string[],
      ) =>
        new Map(
          groups
            .filter((group) => !group.includes("Virtual"))
            .map((group) => [group, group] as const),
        ),
    } as unknown as SsoCasdoorGroupClient,
    {
      load: async () => rawSnapshot,
    } as unknown as SsoCasdoorDirectoryClient,
  );
}

async function previewAndImport() {
  const port = buildImportPort();
  const adminService = new AdminCasdoorImportService(
    port,
    new PostgresAuditWritePort({
      currentVersion: 1,
      keyFor: () => randomBytes(32),
    }),
  );
  service = adminService;
  const snapshot = await port.loadDirectory();
  const preview = await uow.run((tx) => adminService.preview(tx, snapshot));
  const actionableIds = preview.items
    .filter((item) => item.action !== "skip" && item.action !== "unchanged")
    .map((item) => item.casdoorId);
  const imported =
    actionableIds.length === 0
      ? null
      : await uow.run((tx) =>
          adminService.import(
            tx,
            { actorId: adminUserId, requestId: randomUUID() },
            snapshot,
            actionableIds,
          ),
        );
  return { preview, imported };
}

async function userByLogin(loginName: string) {
  const rows = (await client!.sql`
    SELECT id,
           login_name AS "loginName",
           email,
           sso_subject AS "ssoSubject",
           password_hash AS "passwordHash",
           is_admin AS "isAdmin",
           status
      FROM app.users
     WHERE login_name = ${loginName}
  `) as unknown as readonly {
    readonly id: number;
    readonly loginName: string;
    readonly email: string | null;
    readonly ssoSubject: string | null;
    readonly passwordHash: string | null;
    readonly isAdmin: boolean;
    readonly status: string;
  }[];
  return rows[0];
}

async function memberships(userId: number) {
  return (await client!.sql`
    SELECT o.name,
           o.source,
           o.sso_group_path AS "groupPath"
      FROM app.user_organizations AS uo
      JOIN app.organizations AS o ON o.id = uo.organization_id
     WHERE uo.user_id = ${userId}
     ORDER BY o.id
  `) as unknown as readonly {
    readonly name: string;
    readonly source: string;
    readonly groupPath: string | null;
  }[];
}

async function insertLocalUser(input: {
  readonly loginName: string;
  readonly email: string | null;
  readonly ssoSubject?: string | null;
  readonly passwordHash?: string | null;
}): Promise<number> {
  const rows = (await client!.sql`
    INSERT INTO app.users (
      login_name,
      name,
      email,
      sso_subject,
      password_hash,
      is_admin,
      status
    )
    VALUES (
      ${input.loginName},
      ${"本地 " + input.loginName},
      ${input.email},
      ${input.ssoSubject ?? null},
      ${input.passwordHash ?? "$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture-hash"},
      false,
      'ACTIVE'
    )
    RETURNING id
  `) as unknown as readonly { id: number }[];
  return rows[0]!.id;
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-casdoor-import-integration",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-casdoor-import-audit",
  });
  uow = new PostgresUnitOfWork(client);
  adminUserId = await createUser(client.sql, { admin: true });
  organization = "casdoor-import-" + suffix();
  groupPath = organization + "/测试部";
  newLogin = "casdoor_new_" + suffix();
  linkLogin = "casdoor_link_" + suffix();
  conflictLogin = "casdoor_conflict_" + suffix();
  unclassifiedLogin = "casdoor_unclassified_" + suffix();
  linkUserId = await insertLocalUser({
    loginName: linkLogin,
    email: linkLogin + "@libiaorobot.com",
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$link$preserved-link-password",
  });
  conflictUserId = await insertLocalUser({
    loginName: conflictLogin,
    email: "different-" + suffix() + "@libiaorobot.com",
  });
  rawSnapshot = {
    organization,
    fetchedAt: new Date(),
    users: [
      directoryUser("subject-new-" + suffix(), newLogin, [
        groupPath,
        organization + "/Virtual Group1",
      ]),
      directoryUser("subject-link-" + suffix(), linkLogin, [groupPath]),
      directoryUser("subject-conflict-" + suffix(), conflictLogin, [groupPath]),
      directoryUser("subject-unclassified-" + suffix(), unclassifiedLogin, [
        organization + "/Virtual Group2",
      ]),
    ],
  };
});

afterAll(async () => {
  await client?.close();
  await auditReader?.close();
});

describe("ADR-100 Casdoor 管理员批量导入真实 PostgreSQL", () => {
  test("预览零写入，导入创建无口令非管理员账号、绑定本地账号并同步 Physical 组织", async () => {
    const ids = rawSnapshot.users.map((user) => user.casdoorId);
    const port = buildImportPort();
    service = new AdminCasdoorImportService(
      port,
      new PostgresAuditWritePort({
        currentVersion: 1,
        keyFor: () => randomBytes(32),
      }),
    );
    const snapshot = await port.loadDirectory();
    const preview = await uow.run((tx) => service.preview(tx, snapshot));

    expect(preview.counts).toEqual({
      create: 2,
      link: 1,
      refresh: 0,
      unchanged: 0,
      skip: 1,
    });
    expect(
      preview.items.find((item) => item.loginName === newLogin)?.groups,
    ).toEqual([groupPath]);
    expect(
      preview.items.find((item) => item.loginName === conflictLogin),
    ).toMatchObject({ action: "skip", reason: "email-mismatch" });
    expect(await userByLogin(newLogin)).toBeUndefined();
    expect((await userByLogin(linkLogin))?.ssoSubject).toBeNull();

    const imported = await uow.run((tx) =>
      service.import(
        tx,
        { actorId: adminUserId, requestId: randomUUID() },
        snapshot,
        ids,
      ),
    );
    expect(imported).toEqual({
      scannedUserCount: 4,
      created: 2,
      linked: 1,
      refreshed: 0,
      skipped: 1,
      createdOrganizationCount: 1,
      membershipCount: 2,
    });

    const created = await userByLogin(newLogin);
    expect(created).toMatchObject({
      passwordHash: null,
      isAdmin: false,
      status: "ACTIVE",
    });
    expect(created?.ssoSubject).toMatch(/^subject-new-/);
    expect(await memberships(created!.id)).toEqual([
      { name: "测试部", source: "CASDOOR", groupPath },
    ]);

    const linked = await userByLogin(linkLogin);
    expect(linked).toMatchObject({
      passwordHash:
        "$argon2id$v=19$m=19456,t=2,p=1$link$preserved-link-password",
      isAdmin: false,
    });
    expect(linked?.ssoSubject).toMatch(/^subject-link-/);
    expect(await memberships(linkUserId)).toHaveLength(1);

    expect((await userByLogin(conflictLogin))?.ssoSubject).toBeNull();
    expect(await memberships(conflictUserId)).toEqual([]);
    expect(
      await memberships((await userByLogin(unclassifiedLogin))!.id),
    ).toEqual([]);

    const auditRows = (await auditReader!.sql`
      SELECT target_type AS "targetType",
             target_id AS "targetId",
             event_payload::text AS payload
        FROM app.audit_logs
       WHERE actor_id = ${adminUserId}
         AND action = 'admin.user.casdoorImport'
       ORDER BY sequence_no
    `) as unknown as readonly {
      readonly targetType: string;
      readonly targetId: string;
      readonly payload: string;
    }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      targetType: "CASDOOR_ORGANIZATION",
      targetId: organization,
    });
    expect(auditRows[0]?.payload).not.toContain(newLogin);
    expect(auditRows[0]?.payload).not.toContain("@libiaorobot.com");
    expect(auditRows[0]?.payload).not.toContain("$argon2id");
  });

  test("无差异账号无需刷新，目录移除实体组后只刷新有变化账号", async () => {
    const rerun = await previewAndImport();
    expect(rerun.preview.counts).toEqual({
      create: 0,
      link: 0,
      refresh: 0,
      unchanged: 3,
      skip: 1,
    });
    expect(rerun.imported).toBeNull();

    const created = await userByLogin(newLogin);
    expect(await memberships(created!.id)).toHaveLength(1);

    rawSnapshot = {
      ...rawSnapshot,
      fetchedAt: new Date(),
      users: rawSnapshot.users.map((user) =>
        user.loginName === newLogin ? { ...user, groups: [] } : user,
      ),
    };
    const cleared = await previewAndImport();
    expect(cleared.preview.counts).toEqual({
      create: 0,
      link: 0,
      refresh: 1,
      unchanged: 2,
      skip: 1,
    });
    expect(cleared.imported).toEqual({
      scannedUserCount: 1,
      created: 0,
      linked: 0,
      refreshed: 1,
      skipped: 0,
      createdOrganizationCount: 0,
      membershipCount: 0,
    });
    expect(await memberships(created!.id)).toEqual([]);

    const auditCount = (await auditReader!.sql`
      SELECT count(*)::int AS "count"
        FROM app.audit_logs
       WHERE actor_id = ${adminUserId}
         AND action = 'admin.user.casdoorImport'
         AND target_id = ${organization}
    `) as unknown as readonly { readonly count: number }[];
    expect(auditCount[0]?.count).toBe(2);
  });
});

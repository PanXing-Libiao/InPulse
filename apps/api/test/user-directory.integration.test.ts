import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { generateOpaqueToken } from "../src/auth/token.js";
import { PostgresUserDirectoryRepository } from "../src/auth/user-directory.repository.js";
import { UserDirectoryService } from "../src/auth/user-directory.service.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient | undefined;
let service: UserDirectoryService;

async function issueSessionCookie(userId: number): Promise<string> {
  const token = generateOpaqueToken();
  const tokenHash = tokenService.hash(token).hash;
  await client!.sql`
    INSERT INTO app.user_sessions (
      user_id,
      token_hash,
      token_hash_key_version,
      auth_version_at_issue,
      auth_state,
      recovery_rotation_generation,
      recovery_rotation_consumed_generation,
      created_at,
      last_seen_at,
      idle_expires_at,
      absolute_expires_at
    )
    VALUES (
      ${userId},
      ${tokenHash},
      1,
      1,
      'AUTHENTICATED',
      0,
      0,
      now(),
      now(),
      now() + interval '1 hour',
      now() + interval '1 day'
    )
  `;
  return `__Host-session=${token}`;
}

let tokenService: SessionTokenService;

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-user-directory-integration-test",
  });
  const unitOfWork = new PostgresUnitOfWork(client);
  const keyring = VersionedHmacKeyring.fromEntries(
    [{ version: 1, key: randomBytes(32) }],
    1,
  );
  tokenService = new SessionTokenService(keyring);
  const sessionAuth = new SessionAuthService(
    unitOfWork,
    new PostgresUserSessionRepository(),
    tokenService,
  );
  service = new UserDirectoryService(
    unitOfWork,
    sessionAuth,
    new PostgresUserDirectoryRepository(),
  );
});

afterAll(async () => {
  await client?.close();
});

describe("UserDirectoryService", () => {
  test("只返回 ACTIVE 用户且不暴露登录名、邮箱或状态", async () => {
    const adminId = await createUser(client!.sql, { admin: true });
    await client!.sql`
      UPDATE app.users
         SET avatar_url = 'https://example.test/admin.png',
             row_version = row_version + 1
       WHERE id = ${adminId}
    `;
    const memberId = await createUser(client!.sql);
    const disabledId = await createUser(client!.sql, { disabled: true });
    const cookie = await issueSessionCookie(memberId);

    const directory = await service.getDirectory(cookie);

    expect(directory).toBeDefined();
    const rows = directory!;
    expect(rows.some((item) => item.id === adminId)).toBe(true);
    expect(rows.some((item) => item.id === memberId)).toBe(true);
    expect(rows.some((item) => item.id === disabledId)).toBe(false);
    const admin = rows.find((item) => item.id === adminId);
    expect(admin).toMatchObject({
      avatarUrl: "https://example.test/admin.png",
      isAdmin: true,
    });
    for (const item of rows) {
      expect(Object.keys(item).sort()).toEqual([
        "avatarUrl",
        "id",
        "isAdmin",
        "name",
        "organizations",
      ]);
      expect(item).not.toHaveProperty("loginName");
      expect(item).not.toHaveProperty("email");
      expect(item).not.toHaveProperty("status");
    }
  });

  test("返回组织归属：已分配用户带 organizations，未分配为空数组", async () => {
    const organizationName = `F081 目录组织 ${randomBytes(4).toString("hex")}`;
    const orgRows = (await client!.sql`
      INSERT INTO app.organizations (name, source)
      VALUES (${organizationName}, 'LOCAL')
      RETURNING id
    `) as unknown as readonly { id: number }[];
    const organizationId = orgRows[0]!.id;
    const assignedId = await createUser(client!.sql);
    await client!.sql`
      INSERT INTO app.user_organizations (user_id, organization_id, source)
      VALUES (${assignedId}, ${organizationId}, 'MANUAL')
    `;
    const unassignedId = await createUser(client!.sql);
    const cookie = await issueSessionCookie(assignedId);

    const directory = await service.getDirectory(cookie);

    expect(directory).toBeDefined();
    const assigned = directory!.find((item) => item.id === assignedId);
    expect(assigned?.organizations).toEqual([
      {
        id: organizationId,
        name: organizationName,
        source: "LOCAL",
        groupPath: null,
      },
    ]);
    const unassigned = directory!.find((item) => item.id === unassignedId);
    expect(unassigned?.organizations).toEqual([]);
  });

  test("匿名或停用用户的 Session 不返回目录", async () => {
    await expect(service.getDirectory(undefined)).resolves.toBeUndefined();
    const disabledId = await createUser(client!.sql, { disabled: true });
    const cookie = await issueSessionCookie(disabledId);
    await expect(service.getDirectory(cookie)).resolves.toBeUndefined();
  });
});

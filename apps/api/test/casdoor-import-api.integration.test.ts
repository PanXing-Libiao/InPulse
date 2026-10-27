import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  casdoorImportPreviewResponseSchema,
  casdoorImportResultSchema,
} from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminCasdoorImportHttpService } from "../src/admin-users/admin-casdoor-import-http.service.js";
import { AdminCasdoorImportService } from "../src/admin-users/admin-casdoor-import.service.js";
import { AdminUserRepository } from "../src/admin-users/admin-user.repository.js";
import { AdminUsersHttpService } from "../src/admin-users/admin-user-http.service.js";
import { AdminUsersController } from "../src/admin-users/admin-user.controller.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import { AuthenticatedMutationService } from "../src/auth/authenticated-mutation.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import type { CasdoorDirectorySnapshot } from "../src/auth/sso/sso-casdoor-directory.client.js";
import type { SsoCasdoorDirectoryClient } from "../src/auth/sso/sso-casdoor-directory.client.js";
import type { SsoCasdoorGroupClient } from "../src/auth/sso/sso-casdoor-group.client.js";
import { PostgresCasdoorImportService } from "../src/auth/sso/casdoor-import.service.js";
import { PostgresSsoUserRepository } from "../src/auth/sso/sso-user.repository.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { PostgresOrganizationSyncService } from "../src/organizations/organization-sync.service.js";
import { createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let app: INestApplication | undefined;
let base: string;
let uow: PostgresUnitOfWork;
let sessions: PostgresUserSessionRepository;
let csrf: PostgresSessionCsrfTokenRepository;
let tokens: SessionTokenService;
let adminUserId: number;
let organization: string;
let groupPath: string;
let newLogin: string;
let secondLogin: string;
let adminCookie: string;
let adminCsrf: string;
let memberCookie: string;
let memberCsrf: string;

const key = randomBytes(32);
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const snapshotUsers = [
  {
    casdoorId: "casdoor-http-new-" + suffix,
    loginName: "casdoor_http_new_" + suffix,
    displayName: "批量导入成员",
    email: "casdoor_http_new_" + suffix + "@libiaorobot.com",
    groups: [] as string[],
  },
  {
    casdoorId: "casdoor-http-second-" + suffix,
    loginName: "casdoor_http_second_" + suffix,
    displayName: "未导入成员",
    email: "casdoor_http_second_" + suffix + "@libiaorobot.com",
    groups: [] as string[],
  },
];
let snapshot: CasdoorDirectorySnapshot;

interface Actor {
  readonly cookie: string;
  readonly csrf: string;
}

function secureHeaders(actor?: Actor, csrfValue?: string | null) {
  return {
    origin: base,
    "sec-fetch-site": "same-origin",
    ...(actor === undefined ? {} : { cookie: actor.cookie }),
    ...(csrfValue === null
      ? {}
      : { "x-csrf-token": csrfValue ?? actor?.csrf ?? "a".repeat(43) }),
  };
}

async function request(
  path: string,
  method: string,
  actor?: Actor,
  options: {
    readonly body?: unknown;
    readonly csrf?: string | null;
    readonly key?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {
    ...secureHeaders(actor, options.csrf),
    "content-type": "application/json",
  };
  if (options.key !== null) {
    headers["Idempotency-Key"] = options.key ?? randomUUID();
  }
  return fetch(base + "/api/v1" + path, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function createSession(
  userId: number,
): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const authVersionRows = (await client.sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { readonly authVersion: number }[];
  const authVersion = authVersionRows[0]!.authVersion;
  const cookieToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await uow.run(async (tx) => {
    const session = await sessions.create(tx, {
      userId,
      tokenHash: tokens.hash(cookieToken).hash,
      tokenHashKeyVersion: tokens.hash(cookieToken).keyVersion,
      authVersionAtIssue: authVersion,
      authState: "AUTHENTICATED",
      idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await csrf.issue(tx, {
      sessionId: session.id,
      tokenHash: tokens.hash(csrfToken).hash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
  });
  return {
    cookie: "__Host-session=" + cookieToken,
    csrf: csrfToken,
  };
}

async function platformUser(loginName: string) {
  const rows = (await client.sql`
    SELECT id,
           password_hash AS "passwordHash",
           is_admin AS "isAdmin",
           status
      FROM app.users
     WHERE login_name = ${loginName}
  `) as unknown as readonly {
    readonly id: number;
    readonly passwordHash: string | null;
    readonly isAdmin: boolean;
    readonly status: string;
  }[];
  return rows[0];
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-casdoor-import-http",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-casdoor-import-http-audit",
  });
  uow = new PostgresUnitOfWork(client);
  sessions = new PostgresUserSessionRepository();
  csrf = new PostgresSessionCsrfTokenRepository();
  tokens = new SessionTokenService(
    VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
  );

  adminUserId = await createUser(client.sql, { admin: true });
  const memberUserId = await createUser(client.sql, { admin: false });
  const adminSession = await createSession(adminUserId);
  const memberSession = await createSession(memberUserId);
  adminCookie = adminSession.cookie;
  adminCsrf = adminSession.csrf;
  memberCookie = memberSession.cookie;
  memberCsrf = memberSession.csrf;

  organization = "casdoor-http-org-" + suffix;
  groupPath = organization + "/测试部";
  newLogin = snapshotUsers[0]!.loginName;
  secondLogin = snapshotUsers[1]!.loginName;
  snapshot = {
    organization,
    fetchedAt: new Date(),
    users: snapshotUsers.map((user, index) => ({
      ...user,
      groups:
        index === 0
          ? [groupPath, organization + "/Virtual Group9"]
          : [organization + "/Virtual Group9"],
    })),
  };

  const audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key,
  });
  const directoryPort = new PostgresCasdoorImportService(
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
      load: async () => snapshot,
    } as unknown as SsoCasdoorDirectoryClient,
  );
  const casdoorImport = new AdminCasdoorImportService(directoryPort, audit);
  const sessionAuth = new SessionAuthService(uow, sessions, tokens);
  const http = new AdminCasdoorImportHttpService(
    sessionAuth,
    new AuthenticatedMutationService(sessionAuth, csrf, tokens),
    new AdminHighRiskAuthService(
      sessions,
      csrf,
      tokens,
      new PostgresUserCredentialRepository(),
    ),
    uow,
    new AdminUserRepository(),
    casdoorImport,
    directoryPort,
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
  );

  class TestModule {}
  Module({
    controllers: [AdminUsersController],
    providers: [
      { provide: AdminUsersHttpService, useValue: {} },
      { provide: AdminCasdoorImportHttpService, useValue: http },
    ],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ContractResponseInterceptor());
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  await client?.close();
  await auditReader?.close();
});

describe("ADR-100 Casdoor 批量导入真实 HTTP", () => {
  it("预览仅允许管理员，返回 no-store 且不写平台账号", async () => {
    const anonymous = await request(
      "/admin/users/casdoor-import/preview",
      "GET",
    );
    expect(anonymous.status).toBe(401);

    const member = await request("/admin/users/casdoor-import/preview", "GET", {
      cookie: memberCookie,
      csrf: memberCsrf,
    });
    expect(member.status).toBe(403);

    const previewResponse = await request(
      "/admin/users/casdoor-import/preview",
      "GET",
      { cookie: adminCookie, csrf: adminCsrf },
    );
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe("no-store");
    const preview = casdoorImportPreviewResponseSchema.parse(
      await previewResponse.json(),
    );
    expect(preview.organization).toBe(organization);
    expect(preview.counts).toEqual({
      create: 2,
      link: 0,
      refresh: 0,
      skip: 0,
    });
    expect(
      preview.items.find((item) => item.loginName === newLogin)?.groups,
    ).toEqual([groupPath]);
    expect(
      preview.items.find((item) => item.loginName === secondLogin)?.groups,
    ).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("Virtual Group9");
    expect(await platformUser(newLogin)).toBeUndefined();
  });

  it("CSRF 与幂等键门禁生效，同 Key 重放不重复建号或写审计", async () => {
    const actor = { cookie: adminCookie, csrf: adminCsrf };
    const body = { casdoorUserIds: [snapshotUsers[0]!.casdoorId] };

    const missingKey = await request(
      "/admin/users/casdoor-import",
      "POST",
      actor,
      { body, key: null },
    );
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });

    const invalidCsrf = await request(
      "/admin/users/casdoor-import",
      "POST",
      actor,
      { body, csrf: "b".repeat(43), key: randomUUID() },
    );
    expect(invalidCsrf.status).toBe(401);
    expect(await invalidCsrf.json()).toMatchObject({
      code: "ADMIN_USER_SESSION_REQUIRED",
    });

    const idempotencyKey = randomUUID();
    const importedResponse = await request(
      "/admin/users/casdoor-import",
      "POST",
      actor,
      { body, key: idempotencyKey },
    );
    expect(importedResponse.status).toBe(200);
    expect(importedResponse.headers.get("cache-control")).toBe("no-store");
    const imported = casdoorImportResultSchema.parse(
      await importedResponse.json(),
    );
    expect(imported).toEqual({
      scannedUserCount: 1,
      created: 1,
      linked: 0,
      refreshed: 0,
      skipped: 0,
      createdOrganizationCount: 1,
      membershipCount: 1,
    });

    const replayResponse = await request(
      "/admin/users/casdoor-import",
      "POST",
      actor,
      { body, key: idempotencyKey },
    );
    expect(replayResponse.status).toBe(200);
    expect(
      casdoorImportResultSchema.parse(await replayResponse.json()),
    ).toEqual(imported);

    const changed = await request(
      "/admin/users/casdoor-import",
      "POST",
      actor,
      {
        body: { casdoorUserIds: [snapshotUsers[1]!.casdoorId] },
        key: idempotencyKey,
      },
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "IDEMPOTENCY_REQUEST_MISMATCH",
    });

    const created = await platformUser(newLogin);
    expect(created).toMatchObject({
      passwordHash: null,
      isAdmin: false,
      status: "ACTIVE",
    });
    expect(await platformUser(secondLogin)).toBeUndefined();

    const memberships = (await client.sql`
      SELECT o.name,
             o.source,
             o.sso_group_path AS "groupPath"
        FROM app.user_organizations AS uo
        JOIN app.organizations AS o ON o.id = uo.organization_id
       WHERE uo.user_id = ${created!.id}
    `) as unknown as readonly {
      readonly name: string;
      readonly source: string;
      readonly groupPath: string | null;
    }[];
    expect(memberships).toEqual([
      { name: "测试部", source: "CASDOOR", groupPath },
    ]);

    const auditRows = (await auditReader.sql`
      SELECT count(*)::int AS "count"
        FROM app.audit_logs
       WHERE actor_id = ${adminUserId}
         AND action = 'admin.user.casdoorImport'
         AND target_id = ${organization}
    `) as unknown as readonly { readonly count: number }[];
    expect(auditRows[0]?.count).toBe(1);
  });
});

import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  myOrganizationMembersResponseSchema,
  organizationItemSchema,
  organizationListResponseSchema,
} from "@inpulse/api-contract";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@inpulse/database/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminHighRiskAuthService } from "../src/auth/admin-high-risk.service.js";
import { VersionedHmacKeyring } from "../src/auth/keyring.js";
import { PostgresSessionCsrfTokenRepository } from "../src/auth/session-csrf-token.repository.js";
import { SessionAuthService } from "../src/auth/session-auth.service.js";
import { SessionTokenService } from "../src/auth/session-token.service.js";
import { PostgresUserCredentialRepository } from "../src/auth/user-credential.repository.js";
import { PostgresUserSessionRepository } from "../src/auth/user-session.repository.js";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import { ApiExceptionFilter } from "../src/http/api-exception.filter.js";
import { ContractResponseInterceptor } from "../src/http/contract-response.interceptor.js";
import { IdempotencyHttpService } from "../src/idempotency/http-service.js";
import { IdempotencyRunner } from "../src/idempotency/runner.js";
import { resolveRegisteredRoute } from "../src/idempotency/route.js";
import { PostgresIdempotencyStore } from "../src/idempotency/store.js";
import { OrganizationMembersController } from "../src/organizations/organization-members.controller.js";
import { OrganizationMembersService } from "../src/organizations/organization-members.service.js";
import { OrganizationsController } from "../src/organizations/organization.controller.js";
import { OrganizationsHttpService } from "../src/organizations/organization-http.service.js";
import { OrganizationRepository } from "../src/organizations/organization.repository.js";
import { OrganizationService } from "../src/organizations/organization.service.js";
import { createUser, testUrls } from "./database.helpers.js";

let client: DatabaseClient;
let auditReader: DatabaseClient;
let app: INestApplication | undefined;
let base: string;
let uow: PostgresUnitOfWork;
let sessions: PostgresUserSessionRepository;
let csrf: PostgresSessionCsrfTokenRepository;
let tokens: SessionTokenService;
let auth: SessionAuthService;

const key = randomBytes(32);

interface Actor {
  readonly userId: number;
  readonly cookie: string;
  readonly csrf: string;
}

function secureHeaders(actor?: Actor) {
  return {
    origin: base,
    "sec-fetch-site": "same-origin",
    ...(actor
      ? { cookie: actor.cookie, "x-csrf-token": actor.csrf }
      : { cookie: "", "x-csrf-token": "a".repeat(43) }),
  };
}

async function request(
  path: string,
  method: string,
  actor?: Actor,
  options: {
    readonly body?: unknown;
    readonly version?: number;
    readonly key?: string;
    readonly csrf?: string;
  } = {},
) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...secureHeaders(actor),
      ...(options.csrf === undefined ? {} : { "x-csrf-token": options.csrf }),
      "content-type": "application/json",
      "Idempotency-Key": options.key ?? randomUUID(),
      ...(options.version === undefined
        ? {}
        : { "If-Match": `"${options.version}"` }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return response;
}

async function authVersionFor(userId: number): Promise<number> {
  const rows = (await client.sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { authVersion: number }[];
  return rows[0]!.authVersion;
}

async function seedUser(options: { readonly admin: boolean }): Promise<Actor> {
  const userId = await createUser(client.sql, { admin: options.admin });
  const authVersion = await authVersionFor(userId);
  const cookie = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await uow.run(async (tx) => {
    const session = await sessions.create(tx, {
      userId,
      tokenHash: tokens.hash(cookie).hash,
      tokenHashKeyVersion: tokens.hash(cookie).keyVersion,
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
    return session.id;
  });
  return {
    userId,
    cookie: `__Host-session=${cookie}`,
    csrf: csrfToken,
  };
}

async function markAsSso(userId: number): Promise<void> {
  await client.sql`
    UPDATE app.users
       SET sso_subject = ${"subject_" + randomUUID().replaceAll("-", "")},
           password_hash = NULL,
           row_version = row_version + 1,
           updated_at = now()
     WHERE id = ${userId}
  `;
}

async function createCasdoorOrganization(): Promise<{
  readonly id: number;
  readonly name: string;
  readonly groupPath: string;
  readonly rowVersion: number;
}> {
  const owner = "owner_" + randomUUID().replaceAll("-", "").slice(0, 10);
  const path = owner + "/测试部";
  const rows = (await client.sql`
    INSERT INTO app.organizations (
      name,
      source,
      sso_owner,
      sso_group_path,
      sso_parent_path,
      parent_id
    )
    VALUES (${"测试部"}, 'CASDOOR', ${owner}, ${path}, NULL, NULL)
    RETURNING id, name, row_version AS "rowVersion"
  `) as unknown as readonly {
    readonly id: number;
    readonly name: string;
    readonly rowVersion: number;
  }[];
  return { ...rows[0]!, groupPath: path };
}

async function organizationIdsFor(userId: number): Promise<number[]> {
  const rows = (await client.sql`
    SELECT array_agg(organization_id ORDER BY organization_id) AS "organizationIds"
      FROM app.user_organizations
     WHERE user_id = ${userId}
  `) as unknown as readonly { organizationIds: number[] | null }[];
  return rows[0]?.organizationIds ?? [];
}

async function createOrganization(actor: Actor, name: string) {
  const response = await request("/admin/organizations", "POST", actor, {
    body: { name },
    key: randomUUID(),
  });
  expect(response.status).toBe(200);
  return organizationItemSchema.parse(await response.json());
}

async function assignOrganization(
  actor: Actor,
  userIds: readonly number[],
  organizationId: number | null,
): Promise<number> {
  const response = await request("/admin/users/organization", "POST", actor, {
    body: { userIds, organizationId },
    key: randomUUID(),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { updatedCount: number };
  return body.updatedCount;
}

beforeAll(async () => {
  client = createDatabaseClient(testUrls().runtime, {
    applicationName: "inpulse-f081-organizations",
  });
  auditReader = createDatabaseClient(testUrls().auditReader, {
    applicationName: "inpulse-f081-organizations-audit",
  });
  uow = new PostgresUnitOfWork(client);
  sessions = new PostgresUserSessionRepository();
  csrf = new PostgresSessionCsrfTokenRepository();
  tokens = new SessionTokenService(
    VersionedHmacKeyring.fromEntries([{ version: 1, key }], 1),
  );
  auth = new SessionAuthService(uow, sessions, tokens);
  const credentials = new PostgresUserCredentialRepository();
  const highRisk = new AdminHighRiskAuthService(
    sessions,
    csrf,
    tokens,
    credentials,
  );
  const repository = new OrganizationRepository();
  const audit = new PostgresAuditWritePort({
    currentVersion: 1,
    keyFor: () => key,
  });
  const organizations = new OrganizationService(repository, highRisk, audit);
  const members = new OrganizationMembersService(uow, auth, repository);
  const http = new OrganizationsHttpService(
    uow,
    highRisk,
    organizations,
    new IdempotencyHttpService(
      new IdempotencyRunner(uow, new PostgresIdempotencyStore()),
      { currentVersion: 1, currentKey: () => key, keyFor: () => key },
      resolveRegisteredRoute,
    ),
  );
  class TestModule {}
  Module({
    controllers: [OrganizationsController, OrganizationMembersController],
    providers: [
      { provide: OrganizationsHttpService, useValue: http },
      { provide: OrganizationMembersService, useValue: members },
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

describe("ADR-081 组织管理与批量归属（真实 PostgreSQL + HTTP）", () => {
  it("管理员完成组织 CRUD、批量加入/移出、幂等重放与审计留痕", async () => {
    const actor = await seedUser({ admin: true });
    const memberA = await seedUser({ admin: false });
    const memberB = await seedUser({ admin: false });
    const name = `F081 组织 ${randomUUID().slice(0, 8)}`;

    const createKey = randomUUID();
    const createResponse = await request(
      "/admin/organizations",
      "POST",
      actor,
      {
        body: { name },
        key: createKey,
      },
    );
    expect(createResponse.status).toBe(200);
    const created = organizationItemSchema.parse(await createResponse.json());
    expect(created.rowVersion).toBe(1);

    const replay = await request("/admin/organizations", "POST", actor, {
      body: { name },
      key: createKey,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { id: number }).toMatchObject({
      id: created.id,
    });

    const conflict = await request("/admin/organizations", "POST", actor, {
      body: { name: `  ${name.toUpperCase()}  ` },
      key: randomUUID(),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe(
      "ORGANIZATION_NAME_CONFLICT",
    );

    const listResponse = await request("/admin/organizations", "GET", actor);
    expect(listResponse.status).toBe(200);
    const list = organizationListResponseSchema.parse(
      await listResponse.json(),
    );
    expect(list.items.some((item) => item.id === created.id)).toBe(true);

    const assignKey = randomUUID();
    const assignBody = {
      userIds: [memberB.userId, memberA.userId],
      organizationId: created.id,
    };
    const assignResponse = await request(
      "/admin/users/organization",
      "POST",
      actor,
      { body: assignBody, key: assignKey },
    );
    expect(assignResponse.status).toBe(200);
    expect(await assignResponse.json()).toEqual({ updatedCount: 2 });

    const assignReplay = await request(
      "/admin/users/organization",
      "POST",
      actor,
      { body: assignBody, key: assignKey },
    );
    expect(assignReplay.status).toBe(200);
    expect(await assignReplay.json()).toEqual({ updatedCount: 2 });
    expect(await organizationIdsFor(memberA.userId)).toEqual([created.id]);
    expect(await organizationIdsFor(memberB.userId)).toEqual([created.id]);

    const repeat = await request("/admin/users/organization", "POST", actor, {
      body: assignBody,
      key: randomUUID(),
    });
    expect(await repeat.json()).toEqual({ updatedCount: 0 });

    const updateResponse = await request(
      `/admin/organizations/${created.id}`,
      "PATCH",
      actor,
      {
        body: { name: `${name} v2` },
        version: created.rowVersion,
        key: randomUUID(),
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = organizationItemSchema.parse(await updateResponse.json());
    expect(updated.rowVersion).toBe(2);
    expect(updated.name).toBe(`${name} v2`);

    const stale = await request(
      `/admin/organizations/${created.id}`,
      "PATCH",
      actor,
      {
        body: { name: `${name} v3` },
        version: created.rowVersion,
        key: randomUUID(),
      },
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe(
      "ORGANIZATION_VERSION_CONFLICT",
    );

    expect(
      await assignOrganization(actor, [memberA.userId, memberB.userId], null),
    ).toBe(2);
    expect(await organizationIdsFor(memberA.userId)).toEqual([]);

    expect(await assignOrganization(actor, [memberA.userId], created.id)).toBe(
      1,
    );

    const deleteResponse = await request(
      `/admin/organizations/${created.id}`,
      "DELETE",
      actor,
      { version: updated.rowVersion, key: randomUUID() },
    );
    expect(deleteResponse.status).toBe(204);
    expect(await organizationIdsFor(memberA.userId)).toEqual([]);
    const listAfter = organizationListResponseSchema.parse(
      await (await request("/admin/organizations", "GET", actor)).json(),
    );
    expect(listAfter.items.some((item) => item.id === created.id)).toBe(false);

    const auditRows = (await auditReader.sql`
      SELECT action AS "action"
        FROM app.audit_logs
       WHERE target_id = ${String(created.id)}
         AND action IN (
           'admin.organization.create',
           'admin.organization.update',
           'admin.organization.delete',
           'admin.user.organizations.assign'
         )
    `) as unknown as readonly { action: string }[];
    expect(new Set(auditRows.map((row) => row.action))).toEqual(
      new Set([
        "admin.organization.create",
        "admin.organization.update",
        "admin.organization.delete",
        "admin.user.organizations.assign",
      ]),
    );
  });

  it("同组织成员互相可见、跨组织不可见，脱敏字段不含登录名与邮箱", async () => {
    const actor = await seedUser({ admin: true });
    const alice = await seedUser({ admin: false });
    const bob = await seedUser({ admin: false });
    const carol = await seedUser({ admin: false });
    const dave = await seedUser({ admin: false });

    const suffix = randomUUID().slice(0, 8);
    const orgA = await createOrganization(actor, `F081 A ${suffix}`);
    const orgB = await createOrganization(actor, `F081 B ${suffix}`);
    await assignOrganization(actor, [alice.userId, bob.userId], orgA.id);
    await assignOrganization(actor, [carol.userId], orgB.id);

    const aliceView = await request("/organizations/me/members", "GET", alice);
    expect(aliceView.status).toBe(200);
    const aliceParsed = myOrganizationMembersResponseSchema.parse(
      await aliceView.json(),
    );
    expect(aliceParsed.organizations).toEqual([
      {
        id: orgA.id,
        name: orgA.name,
        source: "LOCAL",
        groupPath: null,
      },
    ]);
    const aliceIds = aliceParsed.items.map((item) => item.id);
    expect(aliceIds).toContain(alice.userId);
    expect(aliceIds).toContain(bob.userId);
    expect(aliceIds).not.toContain(carol.userId);
    expect(aliceIds).not.toContain(dave.userId);
    for (const item of aliceParsed.items) {
      expect(Object.keys(item).sort()).toEqual([
        "avatarUrl",
        "id",
        "isAdmin",
        "name",
        "organizationIds",
      ]);
    }
    expect(JSON.stringify(aliceParsed)).not.toContain("@");

    const carolView = myOrganizationMembersResponseSchema.parse(
      await (await request("/organizations/me/members", "GET", carol)).json(),
    );
    expect(carolView.organizations[0]?.id).toBe(orgB.id);
    const carolIds = carolView.items.map((item) => item.id);
    expect(carolIds).toContain(carol.userId);
    expect(carolIds).not.toContain(alice.userId);

    const daveView = myOrganizationMembersResponseSchema.parse(
      await (await request("/organizations/me/members", "GET", dave)).json(),
    );
    expect(daveView.organizations).toEqual([]);
    expect(daveView.items).toEqual([]);

    expect((await request("/admin/organizations", "GET", alice)).status).toBe(
      403,
    );

    const anonymousMembers = await fetch(
      `${base}/api/v1/organizations/me/members`,
    );
    expect(anonymousMembers.status).toBe(401);
    const anonymousAdmin = await fetch(`${base}/api/v1/admin/organizations`);
    expect(anonymousAdmin.status).toBe(401);
  });

  it("CASDOOR 组织只读，SSO 用户与 CASDOOR 目标均拒绝手工组织调整", async () => {
    const actor = await seedUser({ admin: true });
    const ssoUser = await seedUser({ admin: false });
    await markAsSso(ssoUser.userId);
    const localUser = await seedUser({ admin: false });
    const localOrganization = await createOrganization(
      actor,
      `F097 local ${randomUUID().slice(0, 8)}`,
    );
    const casdoorOrganization = await createCasdoorOrganization();

    const list = organizationListResponseSchema.parse(
      await (await request("/admin/organizations", "GET", actor)).json(),
    );
    expect(
      list.items.find((item) => item.id === casdoorOrganization.id),
    ).toMatchObject({
      id: casdoorOrganization.id,
      name: casdoorOrganization.name,
      source: "CASDOOR",
      groupPath: casdoorOrganization.groupPath,
      parentId: null,
      rowVersion: casdoorOrganization.rowVersion,
    });

    const ssoToLocal = await request(
      "/admin/users/organization",
      "POST",
      actor,
      {
        body: {
          userIds: [ssoUser.userId],
          organizationId: localOrganization.id,
        },
        key: randomUUID(),
      },
    );
    expect(ssoToLocal.status).toBe(409);
    expect(((await ssoToLocal.json()) as { code: string }).code).toBe(
      "ORGANIZATION_SSO_MANAGED",
    );

    const localToCasdoor = await request(
      "/admin/users/organization",
      "POST",
      actor,
      {
        body: {
          userIds: [localUser.userId],
          organizationId: casdoorOrganization.id,
        },
        key: randomUUID(),
      },
    );
    expect(localToCasdoor.status).toBe(409);
    expect(((await localToCasdoor.json()) as { code: string }).code).toBe(
      "ORGANIZATION_SSO_MANAGED",
    );

    const rename = await request(
      `/admin/organizations/${casdoorOrganization.id}`,
      "PATCH",
      actor,
      {
        body: { name: `F097 renamed ${randomUUID().slice(0, 8)}` },
        version: casdoorOrganization.rowVersion,
        key: randomUUID(),
      },
    );
    expect(rename.status).toBe(409);
    expect(((await rename.json()) as { code: string }).code).toBe(
      "ORGANIZATION_SSO_MANAGED",
    );

    const remove = await request(
      `/admin/organizations/${casdoorOrganization.id}`,
      "DELETE",
      actor,
      { version: casdoorOrganization.rowVersion, key: randomUUID() },
    );
    expect(remove.status).toBe(409);
    expect(((await remove.json()) as { code: string }).code).toBe(
      "ORGANIZATION_SSO_MANAGED",
    );

    expect(await organizationIdsFor(ssoUser.userId)).toEqual([]);
    expect(await organizationIdsFor(localUser.userId)).toEqual([]);
  });

  it("拒绝越权、越界输入与不存在资源，不泄露数据库细节", async () => {
    const actor = await seedUser({ admin: true });
    const member = await seedUser({ admin: false });

    const denied = await request("/admin/organizations", "POST", member, {
      body: { name: `F081 deny ${randomUUID().slice(0, 8)}` },
      key: randomUUID(),
    });
    expect(denied.status).toBe(403);

    const anonymous = await request("/admin/organizations", "POST", undefined, {
      body: { name: `F081 anon ${randomUUID().slice(0, 8)}` },
      key: randomUUID(),
    });
    expect(anonymous.status).toBe(401);

    const noCsrf = await request("/admin/organizations", "POST", actor, {
      csrf: "a".repeat(43),
      body: { name: `F081 csrf ${randomUUID().slice(0, 8)}` },
      key: randomUUID(),
    });
    expect(noCsrf.status).toBe(401);

    const invalid = await request("/admin/organizations", "POST", actor, {
      body: { name: "   " },
      key: randomUUID(),
    });
    expect(invalid.status).toBe(422);

    const missingOrg = await request(
      "/admin/users/organization",
      "POST",
      actor,
      {
        body: { userIds: [member.userId], organizationId: 2147483647 },
        key: randomUUID(),
      },
    );
    expect(missingOrg.status).toBe(422);
    const missingPayload = (await missingOrg.json()) as { code: string };
    expect(missingPayload.code).toBe("ORGANIZATION_NOT_FOUND");
    expect(JSON.stringify(missingPayload)).not.toContain("SELECT");

    const missingUpdate = await request(
      "/admin/organizations/2147483647",
      "PATCH",
      actor,
      { body: { name: "F081 nowhere" }, version: 1, key: randomUUID() },
    );
    expect(missingUpdate.status).toBe(404);

    const org = await createOrganization(
      actor,
      `F081 dedupe ${randomUUID().slice(0, 8)}`,
    );
    const dedupe = await request("/admin/users/organization", "POST", actor, {
      body: { userIds: [member.userId, member.userId], organizationId: org.id },
      key: randomUUID(),
    });
    expect(dedupe.status).toBe(200);
    expect(await dedupe.json()).toEqual({ updatedCount: 1 });
  });
});

import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  schemaRegistry,
  type ProjectMemberPermissionsUpdateRequest,
} from "@inpulse/api-contract";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { hashOpaqueToken } from "../src/auth/token.js";
import {
  connect,
  createProject,
  createUser,
  testUrls,
  type TestUrls,
} from "./database.helpers.js";

const KEY_VERSION = 1;
const permissionsPath = "/project-member-permissions";

const defaults: ProjectMemberPermissionsUpdateRequest = {
  projectEdit: "ALL_MEMBERS",
  projectMemberManage: "ALL_MEMBERS",
  projectLeaderTransfer: "LEADERS_ONLY",
  projectDelete: "LEADERS_ONLY",
  projectDocumentImport: "ALL_MEMBERS",
  moduleFeatureEdit: "ALL_MEMBERS",
  moduleFeatureDelete: "LEADERS_ONLY",
  taskEdit: "ALL_MEMBERS",
  taskLifecycle: "ALL_MEMBERS",
  recordWrite: "ALL_MEMBERS",
  projectWecomGroup: "LEADERS_ONLY",
};

interface Actor {
  readonly userId: number;
  readonly name: string;
  readonly cookie: string;
  readonly csrf: string;
}

interface RequestOptions {
  readonly actor?: Actor;
  readonly body?: unknown;
  readonly key?: string;
  readonly version?: number;
  readonly contentType?: string;
}

let app: NestExpressApplication | undefined;
let baseUrl = "";
let urls: TestUrls;
let runtime: Sql | undefined;
let auditReader: Sql | undefined;
let keyringDirectory: string | undefined;
let sessionKey: Buffer;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};

function requireRuntime(): Sql {
  if (runtime === undefined) throw new Error("runtime is not initialised");
  return runtime;
}

function requireAuditReader(): Sql {
  if (auditReader === undefined) {
    throw new Error("audit reader is not initialised");
  }
  return auditReader;
}

async function resetSettings(): Promise<void> {
  await requireRuntime().unsafe(
    "UPDATE app.project_member_permission_settings SET project_edit = $1, project_member_manage = $2, project_leader_transfer = $3, project_delete = $4, project_document_import = $5, module_feature_edit = $6, module_feature_delete = $7, task_edit = $8, task_lifecycle = $9, record_write = $10, project_wecom_group = $11, updated_by = NULL, updated_at = now(), row_version = 1 WHERE id = 1",
    [
      defaults.projectEdit,
      defaults.projectMemberManage,
      defaults.projectLeaderTransfer,
      defaults.projectDelete,
      defaults.projectDocumentImport,
      defaults.moduleFeatureEdit,
      defaults.moduleFeatureDelete,
      defaults.taskEdit,
      defaults.taskLifecycle,
      defaults.recordWrite,
      defaults.projectWecomGroup,
    ],
  );
}

async function sessionActor(admin = false): Promise<Actor> {
  const sql = requireRuntime();
  const userId = await createUser(sql, { admin });
  const users = await sql.unsafe<
    Array<{ readonly name: string; readonly authVersion: number }>
  >('SELECT name, auth_version AS "authVersion" FROM app.users WHERE id = $1', [
    userId,
  ]);
  const user = users[0];
  if (user === undefined) throw new Error("user fixture is missing");

  const cookieToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const sessions = await sql.unsafe<Array<{ readonly id: number }>>(
    "INSERT INTO app.user_sessions (user_id, token_hash, token_hash_key_version, auth_version_at_issue, auth_state, idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, $4, 'AUTHENTICATED', now() + interval '1 hour', now() + interval '1 day') RETURNING id",
    [
      userId,
      hashOpaqueToken(cookieToken, sessionKey),
      KEY_VERSION,
      user.authVersion,
    ],
  );
  const session = sessions[0];
  if (session === undefined) throw new Error("session fixture is missing");
  await sql.unsafe(
    "INSERT INTO app.session_csrf_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [session.id, hashOpaqueToken(csrfToken, sessionKey)],
  );
  return {
    userId,
    name: user.name,
    cookie: "__Host-session=" + cookieToken,
    csrf: csrfToken,
  };
}

async function request(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const write = method !== "GET";
  const headers: Record<string, string> = {};
  if (write) {
    headers["origin"] = baseUrl;
    headers["sec-fetch-site"] = "same-origin";
    headers["x-csrf-token"] = options.actor?.csrf ?? "a".repeat(43);
    headers["content-type"] = options.contentType ?? "application/json";
    headers["Idempotency-Key"] = options.key ?? randomUUID();
  }
  if (options.actor !== undefined) headers["cookie"] = options.actor.cookie;
  if (options.version !== undefined) {
    headers["If-Match"] = '"' + options.version + '"';
  }
  return fetch(baseUrl + "/api/v1" + path, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = schemaRegistry.ErrorResponse.schema.parse(await response.json());
  expect(body.code).toBe(code);
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
}

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 20);
  auditReader = connect(urls.auditReader, 5);
  await migrate(urls.migrator);
  await resetSettings();

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-permission-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
  await writeFile(
    sessionFile,
    KEY_VERSION + ":" + sessionKey.toString("hex") + "\n",
    "utf8",
  );
  await writeFile(
    auditFile,
    KEY_VERSION + ":" + auditKey.toString("hex") + "\n",
    "utf8",
  );
  await writeFile(
    idempotencyFile,
    KEY_VERSION + ":" + idempotencyKey.toString("hex") + "\n",
    "utf8",
  );

  previousEnvironment = {
    AUDIT_DATABASE_URL: process.env["AUDIT_DATABASE_URL"],
    AUDIT_HMAC_KEYRING_FILE: process.env["AUDIT_HMAC_KEYRING_FILE"],
    AUDIT_HMAC_KEYRING_TEST_PATH: process.env["AUDIT_HMAC_KEYRING_TEST_PATH"],
    AUDIT_HMAC_KEY_VERSION: process.env["AUDIT_HMAC_KEY_VERSION"],
    DATABASE_URL: process.env["DATABASE_URL"],
    IDEMPOTENCY_FINGERPRINT_KEYRING_FILE:
      process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_FILE"],
    IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH:
      process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH"],
    IDEMPOTENCY_FINGERPRINT_KEY_VERSION:
      process.env["IDEMPOTENCY_FINGERPRINT_KEY_VERSION"],
    NODE_ENV: process.env["NODE_ENV"],
    SESSION_HASH_KEYRING_FILE: process.env["SESSION_HASH_KEYRING_FILE"],
    SESSION_HASH_KEYRING_TEST_PATH:
      process.env["SESSION_HASH_KEYRING_TEST_PATH"],
    SESSION_HASH_KEY_VERSION: process.env["SESSION_HASH_KEY_VERSION"],
  };
  process.env["NODE_ENV"] = "test";
  process.env["DATABASE_URL"] = urls.runtime;
  process.env["AUDIT_DATABASE_URL"] = urls.auditReader;
  process.env["SESSION_HASH_KEYRING_FILE"] = sessionFile;
  process.env["SESSION_HASH_KEYRING_TEST_PATH"] = "1";
  process.env["SESSION_HASH_KEY_VERSION"] = String(KEY_VERSION);
  process.env["AUDIT_HMAC_KEYRING_FILE"] = auditFile;
  process.env["AUDIT_HMAC_KEYRING_TEST_PATH"] = "1";
  process.env["AUDIT_HMAC_KEY_VERSION"] = String(KEY_VERSION);
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_FILE"] = idempotencyFile;
  process.env["IDEMPOTENCY_FINGERPRINT_KEYRING_TEST_PATH"] = "1";
  process.env["IDEMPOTENCY_FINGERPRINT_KEY_VERSION"] = String(KEY_VERSION);

  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = "http://127.0.0.1:" + address.port;
}, 120_000);

afterAll(async () => {
  if (runtime !== undefined) await resetSettings().catch(() => undefined);
  await app?.close();
  await auditReader?.end({ timeout: 5 });
  await runtime?.end({ timeout: 5 });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (keyringDirectory !== undefined) {
    await rm(keyringDirectory, { recursive: true, force: true });
  }
});

describe("ADR-104 全平台项目成员权限配置", () => {
  test("管理员保存后即时生效、写审计、幂等重放且版本冲突返回 409", async () => {
    const admin = await sessionActor(true);
    const leader = await sessionActor();
    const member = await sessionActor();
    const candidate = await sessionActor();
    const project = await createProject(requireRuntime(), leader.userId);
    await requireRuntime().unsafe(
      "INSERT INTO app.project_members (project_id, user_id, role) VALUES ($1, $2, 'MEMBER')",
      [project.projectId, member.userId],
    );

    await expectError(
      await request("GET", permissionsPath),
      401,
      "PROJECT_MEMBER_PERMISSION_SESSION_REQUIRED",
    );
    const initialResponse = await request("GET", permissionsPath, {
      actor: leader,
    });
    expect(initialResponse.status).toBe(200);
    const initial = schemaRegistry.ProjectMemberPermissions.schema.parse(
      await initialResponse.json(),
    );
    expect(initial).toMatchObject({ ...defaults, rowVersion: 1 });
    expect(initial.updatedByName).toBeNull();

    const updateValues: ProjectMemberPermissionsUpdateRequest = {
      ...defaults,
      projectEdit: "LEADERS_ONLY",
      projectMemberManage: "ADMINS_ONLY",
      projectLeaderTransfer: "ALL_MEMBERS",
    };
    await expectError(
      await request("PUT", permissionsPath, {
        actor: leader,
        body: updateValues,
        key: randomUUID(),
        version: 1,
      }),
      403,
      "ADMIN_REQUIRED",
    );
    await expectError(
      await request("PUT", permissionsPath, {
        actor: admin,
        body: updateValues,
        key: randomUUID(),
        version: 1,
        contentType: "text/plain",
      }),
      400,
      "PROJECT_MEMBER_PERMISSION_CONTENT_TYPE_INVALID",
    );

    const updateKey = randomUUID();
    const savedResponse = await request("PUT", permissionsPath, {
      actor: admin,
      body: updateValues,
      key: updateKey,
      version: 1,
    });
    expect(savedResponse.status).toBe(200);
    const saved = schemaRegistry.ProjectMemberPermissions.schema.parse(
      await savedResponse.json(),
    );
    expect(saved).toMatchObject({
      ...updateValues,
      rowVersion: 2,
      updatedByName: admin.name,
    });

    const auditRows = await requireAuditReader().unsafe<
      Array<{
        readonly actorId: number;
        readonly targetId: string;
        readonly payload: {
          readonly previousRowVersion: number;
          readonly rowVersion: number;
        };
      }>
    >(
      'SELECT actor_id AS "actorId", target_id AS "targetId", event_payload AS "payload" FROM app.audit_logs WHERE chain_id = \'SYSTEM\' AND action = $1 AND actor_id = $2 ORDER BY sequence_no DESC LIMIT 1',
      ["admin.projectMemberPermissions.update", admin.userId],
    );
    expect(auditRows[0]).toMatchObject({
      actorId: admin.userId,
      targetId: "1",
      payload: { previousRowVersion: 1, rowVersion: 2 },
    });

    await expectError(
      await request("POST", "/projects/" + project.projectId + "/members", {
        actor: leader,
        body: { userId: candidate.userId },
        key: randomUUID(),
      }),
      403,
      "PROJECT_CAPABILITY_FORBIDDEN",
    );
    await expectError(
      await request("PATCH", "/projects/" + project.projectId + "/status", {
        actor: member,
        body: { status: "ACTIVE" },
        key: randomUUID(),
        version: 1,
      }),
      403,
      "PROJECT_CAPABILITY_FORBIDDEN",
    );
    expect(
      (
        await request("POST", "/projects/" + project.projectId + "/members", {
          actor: admin,
          body: { userId: candidate.userId },
          key: randomUUID(),
        })
      ).status,
    ).toBe(200);

    const replay = await request("PUT", permissionsPath, {
      actor: admin,
      body: updateValues,
      key: updateKey,
      version: 1,
    });
    expect(replay.status).toBe(200);
    expect(
      schemaRegistry.ProjectMemberPermissions.schema.parse(await replay.json()),
    ).toEqual(saved);

    await expectError(
      await request("PUT", permissionsPath, {
        actor: admin,
        body: { ...updateValues, projectEdit: "ALL_MEMBERS" },
        key: randomUUID(),
        version: 1,
      }),
      409,
      "PROJECT_MEMBER_PERMISSION_VERSION_CONFLICT",
    );

    const currentResponse = await request("GET", permissionsPath, {
      actor: member,
    });
    expect(currentResponse.status).toBe(200);
    expect(
      schemaRegistry.ProjectMemberPermissions.schema.parse(
        await currentResponse.json(),
      ),
    ).toMatchObject({ ...updateValues, rowVersion: 2 });
  }, 120_000);
});

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { hashOpaqueToken } from "../src/auth/token.js";
import {
  decryptWecomWebhookUrl,
  loadWecomRobotEncryptionKeyring,
} from "../src/modules/wecom-robot/public/wecom-encryption.js";
import {
  connect,
  createProject,
  createUser,
  removeMember,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./database.helpers.js";

const SESSION_COOKIE_NAME = "__Host-session";
const KEY_VERSION = 1;

interface SessionActor {
  readonly userId: number;
  readonly loginName: string;
  readonly cookie: string;
  readonly csrf: string;
}

interface ActorContext {
  readonly actor: SessionActor;
  readonly project: ProjectFixture;
}

let app: NestExpressApplication | undefined;
let baseUrl = "";
let urls: TestUrls;
let runtime: Sql | undefined;
let auditReader: Sql | undefined;
let keyringDirectory: string | undefined;
let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
let sessionKey: Buffer;
let wecomCounter = 0;

function requireAuditReader(): Sql {
  if (auditReader === undefined) {
    throw new Error("audit reader connection is not initialised");
  }
  return auditReader;
}

function requireRuntime(): Sql {
  if (runtime === undefined) {
    throw new Error("runtime connection is not initialised");
  }
  return runtime;
}

function nextWecomId(prefix: string): string {
  wecomCounter += 1;
  return `wecom-group-${prefix}-${Date.now().toString(36)}${wecomCounter.toString(36)}`;
}

async function sessionActor(sql: Sql, userId: number): Promise<SessionActor> {
  const users = (await sql`
    SELECT login_name AS "loginName", auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { loginName: string; authVersion: number }[];
  const user = users[0];
  if (user === undefined) {
    throw new Error(`user fixture ${userId} does not exist`);
  }
  const cookieToken = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO app.user_sessions (
      user_id,
      token_hash,
      token_hash_key_version,
      auth_version_at_issue,
      auth_state,
      idle_expires_at,
      absolute_expires_at
    )
    VALUES (
      ${userId},
      ${hashOpaqueToken(cookieToken, sessionKey)},
      ${KEY_VERSION},
      ${user.authVersion},
      'AUTHENTICATED',
      now() + interval '1 hour',
      now() + interval '1 day'
    )
  `;
  const cookie = `${SESSION_COOKIE_NAME}=${cookieToken}`;
  const response = await fetch(`${baseUrl}/api/v1/auth/csrf`, {
    headers: { cookie },
  });
  if (response.status !== 200) {
    throw new Error(`csrf issuance failed with ${String(response.status)}`);
  }
  const body = (await response.json()) as { readonly csrfToken: string };
  return {
    userId,
    loginName: user.loginName,
    cookie,
    csrf: body.csrfToken,
  };
}

async function createActor(
  sql: Sql,
  options: { readonly admin?: boolean } = {},
): Promise<SessionActor> {
  const userId = await createUser(sql, options);
  return sessionActor(sql, userId);
}

/** 项目创建者：`createProject` 夹具把创建者写成 LEADER（ADR-033/ADR-053）。 */
async function leaderContext(sql: Sql): Promise<ActorContext> {
  const actor = await createActor(sql);
  const project = await createProject(sql, actor.userId);
  return { actor, project };
}

async function addMember(
  sql: Sql,
  projectId: number,
  userId: number,
): Promise<void> {
  await sql`
    INSERT INTO app.project_members (project_id, user_id)
    VALUES (${projectId}, ${userId})
  `;
}

function mutationHeaders(actor: SessionActor): Record<string, string> {
  return {
    cookie: actor.cookie,
    host: new URL(baseUrl).host,
    origin: new URL(baseUrl).origin,
    "x-csrf-token": actor.csrf,
  };
}

async function getGroup(
  projectId: number,
  cookie: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers["cookie"] = cookie;
  }
  return fetch(`${baseUrl}/api/v1/projects/${projectId}/wecom-group`, {
    headers,
  });
}

async function updateGroupNotificationOptions(
  projectId: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/v1/projects/${projectId}/wecom-group/notification-options`,
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function nextWebhookFixture(): {
  readonly key: string;
  readonly url: string;
} {
  const key = "test-" + randomBytes(24).toString("base64url");
  return {
    key,
    url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + key,
  };
}

function webhookPath(projectId: number): string {
  return `${baseUrl}/api/v1/projects/${projectId}/wecom-group/webhooks`;
}

async function createWebhook(
  projectId: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetch(webhookPath(projectId), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteWebhook(
  projectId: number,
  bindingId: number,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(webhookPath(projectId) + "/" + String(bindingId), {
    method: "DELETE",
    headers,
  });
}

async function expectSqlState(
  sql: Sql,
  statement: string,
  expectedCode: string,
): Promise<void> {
  try {
    await sql.unsafe(statement);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(expectedCode);
    return;
  }
  throw new Error(
    "statement unexpectedly succeeded: " +
      statement +
      " (expected " +
      expectedCode +
      ")",
  );
}

async function expectPrivilegeDenied(
  sql: Sql,
  statement: string,
): Promise<void> {
  try {
    await sql.unsafe(statement);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe("42501");
    return;
  }
  throw new Error(`statement unexpectedly allowed: ${statement}`);
}

beforeAll(async () => {
  urls = testUrls();
  runtime = connect(urls.runtime, 20);
  auditReader = connect(urls.auditReader, 5);
  await migrate(urls.migrator);

  sessionKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  const wecomRobotKey = randomBytes(32);
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-wecom-group-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
  const wecomRobotFile = join(keyringDirectory, "wecom-robot.keyring");
  await writeFile(
    sessionFile,
    `${KEY_VERSION}:${sessionKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    auditFile,
    `${KEY_VERSION}:${auditKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    idempotencyFile,
    `${KEY_VERSION}:${idempotencyKey.toString("hex")}\n`,
    "utf8",
  );
  await writeFile(
    wecomRobotFile,
    `${KEY_VERSION}:${wecomRobotKey.toString("hex")}\n`,
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
    WECOM_ROBOT_ENCRYPTION_KEY_FILE:
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"],
    WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH:
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH"],
    WECOM_ROBOT_ENCRYPTION_KEY_VERSION:
      process.env["WECOM_ROBOT_ENCRYPTION_KEY_VERSION"],
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
  process.env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"] = wecomRobotFile;
  process.env["WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH"] = "1";
  process.env["WECOM_ROBOT_ENCRYPTION_KEY_VERSION"] = String(KEY_VERSION);

  const { AppModule } = await import("../src/app.module.js");
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await auditReader?.end({ timeout: 5 });
  await runtime?.end({ timeout: 5 });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (keyringDirectory !== undefined) {
    await rm(keyringDirectory, { recursive: true, force: true });
  }
});

describe("项目企微群 Webhook（真实 PostgreSQL + 真实 HTTP，ADR-106）", () => {
  test("匿名读取 401；非成员与已移除成员 404；成员读取 Webhook-only 空状态", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    const outsider = await createActor(sql);
    const removed = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    await addMember(sql, project.projectId, removed.userId);
    await removeMember(sql, project.projectId, removed.userId);

    const anonymous = await getGroup(project.projectId, undefined);
    expect(anonymous.status).toBe(401);

    const outsiderResponse = await getGroup(project.projectId, outsider.cookie);
    expect(outsiderResponse.status).toBe(404);

    const removedResponse = await getGroup(project.projectId, removed.cookie);
    expect(removedResponse.status).toBe(404);

    const memberResponse = await getGroup(project.projectId, member.cookie);
    expect(memberResponse.status).toBe(200);
    expect(await memberResponse.json()).toEqual({
      state: "UNBOUND",
      webhookTargets: [],
      notificationOptions: { disabledCategories: [] },
    });

    const leaderResponse = await getGroup(project.projectId, actor.cookie);
    expect(leaderResponse.status).toBe(200);
  });

  test("旧智能机器人项目群入口已下线：绑定码签发与项目群解绑均 404", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const suffix = nextWecomId("legacy");

    const createCode = await fetch(
      baseUrl +
        "/api/v1/projects/" +
        String(project.projectId) +
        "/wecom-group/codes",
      {
        method: "POST",
        headers: {
          ...mutationHeaders(actor),
          "idempotency-key": "pwg-legacy-code-" + suffix,
        },
      },
    );
    expect(createCode.status).toBe(404);

    const unbind = await fetch(
      baseUrl +
        "/api/v1/projects/" +
        String(project.projectId) +
        "/wecom-group",
      {
        method: "DELETE",
        headers: {
          ...mutationHeaders(actor),
          "idempotency-key": "pwg-legacy-unbind-" + suffix,
        },
      },
    );
    expect(unbind.status).toBe(404);

    const statusResponse = await getGroup(project.projectId, actor.cookie);
    const statusBody = (await statusResponse.json()) as {
      readonly state: string;
      readonly webhookTargets: readonly unknown[];
    };
    expect(statusBody.state).toBe("UNBOUND");
    expect(statusBody.webhookTargets).toEqual([]);
  });

  test("项目群通知选项只在存在 ACTIVE Webhook 时可保存，删除后保存与重放均 409", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);

    const beforeBinding = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-options-before-" + nextWecomId("key"),
      },
      { disabledCategories: ["record"] },
    );
    expect(beforeBinding.status).toBe(409);
    expect(
      ((await beforeBinding.json()) as { readonly code: string }).code,
    ).toBe("PROJECT_WECOM_GROUP_NOT_BOUND");

    const fixture = nextWebhookFixture();
    const created = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-options-webhook-" + nextWecomId("key"),
      },
      { label: "通知目标", webhookUrl: fixture.url },
    );
    expect(created.status).toBe(201);

    const memberSave = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(member),
        "idempotency-key": "pwg-options-member-" + nextWecomId("key"),
      },
      { disabledCategories: ["record"] },
    );
    expect(memberSave.status).toBe(403);

    const saveKey = "pwg-options-" + nextWecomId("key");
    const saved = await updateGroupNotificationOptions(
      project.projectId,
      { ...mutationHeaders(actor), "idempotency-key": saveKey },
      { disabledCategories: ["record", "task.status"] },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      disabledCategories: ["record", "task.status"],
    });

    const readBack = await getGroup(project.projectId, member.cookie);
    const readBody = (await readBack.json()) as {
      readonly state: string;
      readonly notificationOptions: { readonly disabledCategories: string[] };
    };
    expect(readBody.state).toBe("BOUND");
    expect(readBody.notificationOptions.disabledCategories).toEqual([
      "record",
      "task.status",
    ]);

    const target = (await created.json()) as { readonly id: number };
    const deleted = await deleteWebhook(project.projectId, target.id, {
      ...mutationHeaders(actor),
      "idempotency-key": "pwg-options-delete-" + nextWecomId("key"),
    });
    expect(deleted.status).toBe(204);

    const afterDeleteSave = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-options-after-" + nextWecomId("key"),
      },
      { disabledCategories: ["scope.delete"] },
    );
    expect(afterDeleteSave.status).toBe(409);

    const replayAfterDelete = await updateGroupNotificationOptions(
      project.projectId,
      { ...mutationHeaders(actor), "idempotency-key": saveKey },
      { disabledCategories: ["record", "task.status"] },
    );
    expect(replayAfterDelete.status).toBe(409);
    expect(
      ((await replayAfterDelete.json()) as { readonly code: string }).code,
    ).toBe("PROJECT_WECOM_GROUP_NOT_BOUND");
  });

  test("Webhook 创建：权限、严格 URL 校验、加密落库、脱敏响应、去重与审计", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    const outsider = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const fixture = nextWebhookFixture();
    const payload = { label: "研发项目群", webhookUrl: fixture.url };

    const memberCreate = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(member),
        "idempotency-key": "pwg-webhook-" + nextWecomId("key"),
      },
      payload,
    );
    expect(memberCreate.status).toBe(403);

    const outsiderCreate = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(outsider),
        "idempotency-key": "pwg-webhook-" + nextWecomId("key"),
      },
      payload,
    );
    expect(outsiderCreate.status).toBe(404);

    const invalidUrl = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-webhook-" + nextWecomId("key"),
      },
      {
        label: "非法目标",
        webhookUrl: "https://example.com/webhook?key=" + fixture.key,
      },
    );
    expect(invalidUrl.status).toBe(422);
    const invalidRaw = await invalidUrl.text();
    expect(invalidRaw).not.toContain(fixture.key);
    expect((JSON.parse(invalidRaw) as { readonly code: string }).code).toBe(
      "PROJECT_WECOM_WEBHOOK_URL_INVALID",
    );

    const createKey = "pwg-webhook-" + nextWecomId("key");
    const created = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": createKey,
      },
      payload,
    );
    expect(created.status).toBe(201);
    const createdRaw = await created.text();
    expect(createdRaw).not.toContain(fixture.key);
    const target = JSON.parse(createdRaw) as {
      readonly id: number;
      readonly label: string;
      readonly urlHint: string;
      readonly boundAt: string;
      readonly boundByName: string;
      readonly lastDeliveryError: string | null;
      readonly webhookUrl?: string;
    };
    expect(target.label).toBe("研发项目群");
    expect(target.urlHint).toBe(fixture.key.slice(-4));
    expect(target.boundByName.length).toBeGreaterThan(0);
    expect(target.lastDeliveryError).toBeNull();
    expect(target.webhookUrl).toBeUndefined();

    const replay = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": createKey,
      },
      payload,
    );
    expect(replay.status).toBe(201);
    expect((await replay.json()) as unknown).toEqual(target);

    const read = await getGroup(project.projectId, member.cookie);
    expect(read.status).toBe(200);
    const readRaw = await read.text();
    expect(readRaw).not.toContain(fixture.key);
    const readBody = JSON.parse(readRaw) as {
      readonly state: string;
      readonly webhookTargets: readonly unknown[];
    };
    expect(readBody.state).toBe("BOUND");
    expect(readBody.webhookTargets).toHaveLength(1);
    expect(readBody.webhookTargets[0]).toEqual({
      id: target.id,
      label: target.label,
      urlHint: target.urlHint,
      boundAt: target.boundAt,
      boundByName: target.boundByName,
      lastDeliveryError: null,
    });

    const rows = (await sql`
      SELECT
        channel_type AS "channelType",
        wecom_chat_id AS "chatId",
        webhook_url_ciphertext AS "ciphertext",
        webhook_url_key_version AS "keyVersion",
        webhook_url_fingerprint AS "fingerprint",
        webhook_url_hint AS "hint",
        status
        FROM app.project_wecom_groups
       WHERE id = ${target.id}
    `) as unknown as readonly {
      channelType: string;
      chatId: string | null;
      ciphertext: Buffer;
      keyVersion: number;
      fingerprint: Buffer;
      hint: string;
      status: string;
    }[];
    const row = rows[0];
    expect(row?.channelType).toBe("WEBHOOK");
    expect(row?.chatId).toBeNull();
    expect(row?.hint).toBe(fixture.key.slice(-4));
    expect(row?.status).toBe("ACTIVE");
    expect(Buffer.from(row!.ciphertext).toString("utf8")).not.toContain(
      fixture.key,
    );
    expect(Buffer.from(row!.fingerprint).toString("hex")).toBe(
      createHash("sha256").update(fixture.url, "utf8").digest("hex"),
    );
    const keyring = loadWecomRobotEncryptionKeyring(process.env);
    expect(
      decryptWecomWebhookUrl(
        Buffer.from(row!.ciphertext),
        Number(row!.keyVersion),
        keyring,
      ),
    ).toBe(fixture.url);

    const duplicate = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-webhook-" + nextWecomId("key"),
      },
      { label: "重复目标", webhookUrl: fixture.url },
    );
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { readonly code: string }).code).toBe(
      "PROJECT_WECOM_WEBHOOK_ALREADY_BOUND",
    );

    const audits = (await requireAuditReader()`
      SELECT
        actor_id AS "actorId",
        target_type AS "targetType",
        event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE action = 'project.wecomGroup.webhook.create'
         AND target_id = ${String(target.id)}
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      actorId: number;
      targetType: string;
      eventPayload: unknown;
    }[];
    expect(audits[0]?.actorId).toBe(actor.userId);
    expect(audits[0]?.targetType).toBe("PROJECT_WECOM_GROUP");
    expect(JSON.stringify(audits[0]?.eventPayload)).not.toContain(fixture.key);
  });

  test("Webhook 多目标、删除隔离、仅 Webhook 通知选项、机器人更换隔离与审计", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const other = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const firstFixture = nextWebhookFixture();
    const secondFixture = nextWebhookFixture();

    const first = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-webhook-" + nextWecomId("key"),
      },
      { label: "目标一", webhookUrl: firstFixture.url },
    );
    expect(first.status).toBe(201);
    const firstTarget = (await first.json()) as { readonly id: number };

    const second = await createWebhook(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-webhook-" + nextWecomId("key"),
      },
      { label: "目标二", webhookUrl: secondFixture.url },
    );
    expect(second.status).toBe(201);
    const secondTarget = (await second.json()) as { readonly id: number };

    const multi = await getGroup(project.projectId, member.cookie);
    const multiBody = (await multi.json()) as {
      readonly webhookTargets: readonly { readonly id: number }[];
    };
    expect(multiBody.webhookTargets.map((item) => item.id).sort()).toEqual(
      [firstTarget.id, secondTarget.id].sort(),
    );

    const savedOptions = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": "pwg-options-" + nextWecomId("key"),
      },
      { disabledCategories: ["record"] },
    );
    expect(savedOptions.status).toBe(200);
    expect(await savedOptions.json()).toEqual({
      disabledCategories: ["record"],
    });

    const crossProjectDelete = await deleteWebhook(
      other.project.projectId,
      secondTarget.id,
      {
        ...mutationHeaders(other.actor),
        "idempotency-key": "pwg-webhook-delete-" + nextWecomId("key"),
      },
    );
    expect(crossProjectDelete.status).toBe(404);

    const deleteKey = "pwg-webhook-delete-" + nextWecomId("key");
    const deleted = await deleteWebhook(project.projectId, firstTarget.id, {
      ...mutationHeaders(actor),
      "idempotency-key": deleteKey,
    });
    expect(deleted.status).toBe(204);
    const deleteReplay = await deleteWebhook(
      project.projectId,
      firstTarget.id,
      {
        ...mutationHeaders(actor),
        "idempotency-key": deleteKey,
      },
    );
    expect(deleteReplay.status).toBe(204);

    const afterDelete = await getGroup(project.projectId, member.cookie);
    const afterDeleteBody = (await afterDelete.json()) as {
      readonly webhookTargets: readonly { readonly id: number }[];
    };
    expect(afterDeleteBody.webhookTargets.map((item) => item.id)).toEqual([
      secondTarget.id,
    ]);

    const revoked = (await sql.unsafe(
      "SELECT * FROM app.revoke_wecom_bindings_on_robot_change()",
    )) as unknown as readonly { revoked_project_groups: number }[];
    expect(revoked[0]?.revoked_project_groups).toBe(0);

    const quote = String.fromCharCode(39);
    await expectSqlState(
      sql,
      "INSERT INTO app.project_wecom_groups (project_id, channel_type, wecom_chat_id, bound_by_user_id) VALUES (" +
        String(project.projectId) +
        ", " +
        quote +
        "BOT" +
        quote +
        ", " +
        quote +
        nextWecomId("bot") +
        quote +
        ", " +
        String(actor.userId) +
        ")",
      "23514",
    );

    const afterRobotChange = await getGroup(project.projectId, member.cookie);
    const afterRobotChangeBody = (await afterRobotChange.json()) as {
      readonly state: string;
      readonly webhookTargets: readonly { readonly id: number }[];
    };
    expect(afterRobotChangeBody.state).toBe("BOUND");
    expect(afterRobotChangeBody.webhookTargets.map((item) => item.id)).toEqual([
      secondTarget.id,
    ]);

    const statuses = (await sql`
      SELECT id, channel_type AS "channelType", status
        FROM app.project_wecom_groups
       WHERE id IN (${firstTarget.id}, ${secondTarget.id})
       ORDER BY id
    `) as unknown as readonly {
      id: number;
      channelType: string;
      status: string;
    }[];
    expect(statuses.find((item) => item.id === firstTarget.id)?.status).toBe(
      "REVOKED",
    );
    expect(statuses.find((item) => item.id === secondTarget.id)?.status).toBe(
      "ACTIVE",
    );

    const deleteAudits = (await requireAuditReader()`
      SELECT
        actor_id AS "actorId",
        event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE action = 'project.wecomGroup.webhook.delete'
         AND target_id = ${String(firstTarget.id)}
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      actorId: number;
      eventPayload: unknown;
    }[];
    expect(deleteAudits[0]?.actorId).toBe(actor.userId);
    expect(JSON.stringify(deleteAudits[0]?.eventPayload)).not.toContain(
      firstFixture.key,
    );
  });

  test("最小授权探针：app_runtime 无 DELETE，项目群绑定码不可写且兑换函数不可执行，app_backup 只读", async () => {
    const sql = requireRuntime();
    await expectPrivilegeDenied(
      sql,
      "DELETE FROM app.project_wecom_binding_codes",
    );
    await expectPrivilegeDenied(sql, "DELETE FROM app.project_wecom_groups");
    await expectPrivilegeDenied(sql, "DELETE FROM app.wecom_group_deliveries");
    await expectPrivilegeDenied(
      sql,
      "DELETE FROM app.project_wecom_group_notification_options",
    );
    const quote = String.fromCharCode(39);
    await expectPrivilegeDenied(
      sql,
      "INSERT INTO app.project_wecom_binding_codes (project_id, code_hash, expires_at) VALUES (1, decode(repeat(" +
        quote +
        "00" +
        quote +
        ", 32), " +
        quote +
        "hex" +
        quote +
        "), now() + interval " +
        quote +
        "10 minutes" +
        quote +
        ")",
    );
    await expectPrivilegeDenied(
      sql,
      "UPDATE app.project_wecom_binding_codes SET expires_at = expires_at",
    );
    await expectPrivilegeDenied(
      sql,
      "SELECT app.redeem_project_wecom_binding_code(decode(repeat(" +
        quote +
        "00" +
        quote +
        ", 32), " +
        quote +
        "hex" +
        quote +
        "), " +
        quote +
        "chat" +
        quote +
        ", " +
        quote +
        "user" +
        quote +
        ")",
    );
    await expectPrivilegeDenied(sql, "SET ROLE app_owner");

    const backup = connect(urls.backup, 2);
    try {
      const readable = (await backup`
        SELECT count(*)::integer AS total FROM app.project_wecom_groups
      `) as unknown as readonly { total: number }[];
      expect(readable[0]?.total).toBeGreaterThanOrEqual(0);
      const optionCount = (await backup`
        SELECT count(*)::integer AS total
          FROM app.project_wecom_group_notification_options
      `) as unknown as readonly { total: number }[];
      expect(optionCount[0]?.total).toBeGreaterThanOrEqual(0);
      try {
        await backup.unsafe(
          "UPDATE app.project_wecom_groups SET last_delivery_error = 'x'",
        );
        throw new Error("backup update unexpectedly allowed");
      } catch (error) {
        expect((error as { readonly code?: string }).code).toBe("42501");
      }
    } finally {
      await backup.end({ timeout: 5 });
    }
  });
});

import { randomBytes } from "node:crypto";
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
import { hashWecomBindingCode } from "../src/modules/wecom-binding/index.js";
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

/** 直接写入个人绑定行：兑换只要求发送者存在 ACTIVE 的个人绑定。 */
async function bindPersonal(
  sql: Sql,
  userId: number,
  wecomUserid: string,
): Promise<void> {
  await sql`
    INSERT INTO app.user_wecom_bindings (user_id, wecom_userid, status)
    VALUES (${userId}, ${wecomUserid}, 'ACTIVE')
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

async function createGroupCode(
  projectId: number,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/projects/${projectId}/wecom-group/codes`, {
    method: "POST",
    headers,
  });
}

async function deleteGroup(
  projectId: number,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/projects/${projectId}/wecom-group`, {
    method: "DELETE",
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

async function redeemGroup(
  sql: Sql,
  code: string,
  chatId: string,
  wecomUserid: string,
): Promise<
  readonly { project_id: number; project_name: string; rebound: boolean }[]
> {
  return (await sql`
    SELECT * FROM app.redeem_project_wecom_binding_code(
      ${hashWecomBindingCode(code)},
      ${chatId},
      ${wecomUserid}
    )
  `) as unknown as readonly {
    project_id: number;
    project_name: string;
    rebound: boolean;
  }[];
}

async function redeemGroupErrorCode(
  sql: Sql,
  code: string,
  chatId: string,
  wecomUserid: string,
): Promise<string> {
  try {
    await redeemGroup(sql, code, chatId, wecomUserid);
  } catch (error) {
    return (error as { readonly code?: string }).code ?? "unknown";
  }
  throw new Error("redeem unexpectedly succeeded");
}

async function activeGroupRow(
  sql: Sql,
  projectId: number,
): Promise<{ id: number; chatId: string } | undefined> {
  const rows = (await sql`
    SELECT id, wecom_chat_id AS "chatId"
      FROM app.project_wecom_groups
     WHERE project_id = ${projectId}
       AND status = 'ACTIVE'
     LIMIT 1
  `) as unknown as readonly { id: number; chatId: string }[];
  return rows[0];
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
  keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-wecom-group-"));
  const sessionFile = join(keyringDirectory, "session.keyring");
  const auditFile = join(keyringDirectory, "audit.keyring");
  const idempotencyFile = join(keyringDirectory, "idempotency.keyring");
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

describe("项目企微群绑定（真实 PostgreSQL + 真实 HTTP，ADR-077）", () => {
  test("匿名读取 401；非成员与已移除成员 404", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const outsider = await createActor(sql);
    const removed = await createActor(sql);
    await addMember(sql, project.projectId, removed.userId);
    await removeMember(sql, project.projectId, removed.userId);

    const anonymous = await getGroup(project.projectId, undefined);
    expect(anonymous.status).toBe(401);

    const outsiderResponse = await getGroup(project.projectId, outsider.cookie);
    expect(outsiderResponse.status).toBe(404);

    const removedResponse = await getGroup(project.projectId, removed.cookie);
    expect(removedResponse.status).toBe(404);

    const leaderResponse = await getGroup(project.projectId, actor.cookie);
    expect(leaderResponse.status).toBe(200);
    expect(leaderResponse.headers.get("cache-control")).toBe("no-store");
  });

  test("成员可读三态；普通成员签发绑定码 403，非成员 404", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const outsider = await createActor(sql);

    const unbound = await getGroup(project.projectId, member.cookie);
    expect(unbound.status).toBe(200);
    const unboundBody = (await unbound.json()) as Record<string, unknown>;
    expect(unboundBody["state"]).toBe("UNBOUND");
    expect(unboundBody["boundAt"]).toBeNull();
    expect(unboundBody["codeExpiresAt"]).toBeNull();
    const botProfileUrl = unboundBody["botProfileUrl"];
    expect(botProfileUrl === null || typeof botProfileUrl === "string").toBe(
      true,
    );

    const memberCreate = await createGroupCode(
      project.projectId,
      mutationHeaders(member),
    );
    expect(memberCreate.status).toBe(403);
    expect(
      ((await memberCreate.json()) as { readonly code: string }).code,
    ).toBe("PROJECT_WECOM_GROUP_FORBIDDEN");

    const outsiderCreate = await createGroupCode(
      project.projectId,
      mutationHeaders(outsider),
    );
    expect(outsiderCreate.status).toBe(404);

    const leaderCreate = await createGroupCode(
      project.projectId,
      mutationHeaders(actor),
    );
    expect(leaderCreate.status).toBe(201);
  });

  test("组长签发一次性绑定码：格式合法、库内只存 Hash、GET 转 PENDING", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);

    const created = await createGroupCode(
      project.projectId,
      mutationHeaders(actor),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      readonly code: string;
      readonly expiresAt: string;
    };
    expect(body.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/,
    );
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);

    const rows = (await sql`
      SELECT code_hash, consumed_at
        FROM app.project_wecom_binding_codes
       WHERE project_id = ${project.projectId}
    `) as unknown as readonly {
      code_hash: Buffer;
      consumed_at: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumed_at).toBeNull();
    expect(
      Buffer.from(rows[0]!.code_hash).equals(hashWecomBindingCode(body.code)),
    ).toBe(true);

    const status = await getGroup(project.projectId, actor.cookie);
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(statusBody["state"]).toBe("PENDING");
    expect(statusBody["codeExpiresAt"]).toBe(body.expiresAt);
  });

  test("系统管理员可跨成员身份签发；重新签发立即作废旧码", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const admin = await createActor(sql, { admin: true });
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    await bindPersonal(sql, member.userId, nextWecomId("member"));

    const first = await createGroupCode(
      project.projectId,
      mutationHeaders(actor),
    );
    const firstCode = ((await first.json()) as { readonly code: string }).code;

    const second = await createGroupCode(
      project.projectId,
      mutationHeaders(admin),
    );
    expect(second.status).toBe(201);
    const secondCode = ((await second.json()) as { readonly code: string })
      .code;
    expect(secondCode).not.toBe(firstCode);

    const firstRedeem = await redeemGroupErrorCode(
      sql,
      firstCode,
      nextWecomId("chat"),
      nextWecomId("sender"),
    );
    expect(firstRedeem).toBe("PWG01");
  });

  test("兑换成功：成员发送者完成绑定，返回项目信息；同一群重复兑换幂等", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const wecomUserid = nextWecomId("member");
    await bindPersonal(sql, member.userId, wecomUserid);
    const chatId = nextWecomId("chat");

    const created = await createGroupCode(
      project.projectId,
      mutationHeaders(actor),
    );
    const code = ((await created.json()) as { readonly code: string }).code;

    const redeemed = await redeemGroup(sql, code, chatId, wecomUserid);
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toEqual({
      project_id: project.projectId,
      project_name: `Project ${project.code}`,
      rebound: false,
    });

    const bound = await getGroup(project.projectId, actor.cookie);
    const boundBody = (await bound.json()) as Record<string, unknown>;
    expect(boundBody["state"]).toBe("BOUND");
    expect(typeof boundBody["boundAt"]).toBe("string");
    expect(boundBody["boundByName"]).toBe(`Test ${member.loginName}`);
    expect(boundBody["codeExpiresAt"]).toBeNull();

    // 同码重复兑换：PWG02（码已消费）。
    const again = await redeemGroupErrorCode(sql, code, chatId, wecomUserid);
    expect(again).toBe("PWG02");

    // 组长重签后在同一群再次发送：幂等成功、不产生新绑定行。
    const reissued = await createGroupCode(
      project.projectId,
      mutationHeaders(actor),
    );
    const reissuedCode = ((await reissued.json()) as { readonly code: string })
      .code;
    const sameChat = await redeemGroup(sql, reissuedCode, chatId, wecomUserid);
    expect(sameChat[0]?.rebound).toBe(false);
    const active = await activeGroupRow(sql, project.projectId);
    expect(active?.chatId).toBe(chatId);
    const countRows = (await sql`
      SELECT count(*)::integer AS total
        FROM app.project_wecom_groups
       WHERE project_id = ${project.projectId}
    `) as unknown as readonly { total: number }[];
    expect(countRows[0]?.total).toBe(1);
  });

  test("换绑与群唯一性：同群绑第二个项目 PWG05，换绑后旧行 REVOKED、群可再次绑定", async () => {
    const sql = requireRuntime();
    const first = await leaderContext(sql);
    const second = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, first.project.projectId, member.userId);
    await addMember(sql, second.project.projectId, member.userId);
    const wecomUserid = nextWecomId("member");
    await bindPersonal(sql, member.userId, wecomUserid);
    const chatA = nextWecomId("chat");
    const chatB = nextWecomId("chat");

    const codeA = (
      (await (
        await createGroupCode(
          first.project.projectId,
          mutationHeaders(first.actor),
        )
      ).json()) as { readonly code: string }
    ).code;
    await redeemGroup(sql, codeA, chatA, wecomUserid);

    // 群 A 已绑项目 1：项目 2 的码在同一群发送 → PWG05。
    const codeSecond = (
      (await (
        await createGroupCode(
          second.project.projectId,
          mutationHeaders(second.actor),
        )
      ).json()) as { readonly code: string }
    ).code;
    const conflict = await redeemGroupErrorCode(
      sql,
      codeSecond,
      chatA,
      wecomUserid,
    );
    expect(conflict).toBe("PWG05");

    // 项目 1 换绑到群 B：旧行 REVOKED、新行 ACTIVE，返回 rebound = true。
    const codeRebind = (
      (await (
        await createGroupCode(
          first.project.projectId,
          mutationHeaders(first.actor),
        )
      ).json()) as { readonly code: string }
    ).code;
    const rebound = await redeemGroup(sql, codeRebind, chatB, wecomUserid);
    expect(rebound[0]?.rebound).toBe(true);
    expect((await activeGroupRow(sql, first.project.projectId))?.chatId).toBe(
      chatB,
    );
    const revokedRows = (await sql`
      SELECT count(*)::integer AS total
        FROM app.project_wecom_groups
       WHERE project_id = ${first.project.projectId}
         AND status = 'REVOKED'
    `) as unknown as readonly { total: number }[];
    expect(revokedRows[0]?.total).toBe(1);

    // 群 A 释放后可以被项目 2 绑定。
    const codeSecondRetry = (
      (await (
        await createGroupCode(
          second.project.projectId,
          mutationHeaders(second.actor),
        )
      ).json()) as { readonly code: string }
    ).code;
    const secondBound = await redeemGroup(
      sql,
      codeSecondRetry,
      chatA,
      wecomUserid,
    );
    expect(secondBound[0]?.project_id).toBe(second.project.projectId);
  });

  test("兑换边界：PWG03（无个人绑定 / 停用）、PWG04（非成员）、PWG06（过期）、PWG01（无效）、PWG07（参数非法）", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const outsider = await createActor(sql);

    const codeForOutsider = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;

    // 无个人绑定 → PWG03。
    expect(
      await redeemGroupErrorCode(
        sql,
        codeForOutsider,
        nextWecomId("chat"),
        nextWecomId("sender"),
      ),
    ).toBe("PWG03");

    // 非成员且已有个人绑定 → PWG04。
    const outsiderWecom = nextWecomId("outsider");
    await bindPersonal(sql, outsider.userId, outsiderWecom);
    expect(
      await redeemGroupErrorCode(
        sql,
        codeForOutsider,
        nextWecomId("chat"),
        outsiderWecom,
      ),
    ).toBe("PWG04");

    // 系统管理员豁免成员校验：非成员也可以完成绑定。
    const admin = await createActor(sql, { admin: true });
    const adminWecom = nextWecomId("admin");
    await bindPersonal(sql, admin.userId, adminWecom);
    const adminChat = nextWecomId("chat");
    const adminRedeem = await redeemGroup(
      sql,
      codeForOutsider,
      adminChat,
      adminWecom,
    );
    expect(adminRedeem[0]?.project_id).toBe(project.projectId);

    // 停用用户的个人绑定 → PWG03（用户状态由兑换函数实时读取）。
    const disabled = await createActor(sql);
    await addMember(sql, project.projectId, disabled.userId);
    const disabledWecom = nextWecomId("disabled");
    await bindPersonal(sql, disabled.userId, disabledWecom);
    await sql`
      UPDATE app.users
         SET status = 'DISABLED',
             disabled_at = now(),
             auth_version = auth_version + 1,
             row_version = row_version + 1
       WHERE id = ${disabled.userId}
    `;
    const codeForDisabled = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;
    expect(
      await redeemGroupErrorCode(
        sql,
        codeForDisabled,
        nextWecomId("chat"),
        disabledWecom,
      ),
    ).toBe("PWG03");

    // 过期码 → PWG06；无效码 → PWG01；非法 chat id → PWG07。
    const codeExpired = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;
    await sql`
      UPDATE app.project_wecom_binding_codes
         SET created_at = now() - interval '20 minutes',
             expires_at = now() - interval '10 minutes'
       WHERE project_id = ${project.projectId}
    `;
    expect(
      await redeemGroupErrorCode(
        sql,
        codeExpired,
        nextWecomId("chat"),
        adminWecom,
      ),
    ).toBe("PWG06");
    expect(
      await redeemGroupErrorCode(
        sql,
        "ZZZZ-ZZZZ-ZZZZ-ZZZZ",
        nextWecomId("chat"),
        adminWecom,
      ),
    ).toBe("PWG01");
    const freshCode = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;
    expect(await redeemGroupErrorCode(sql, freshCode, "", adminWecom)).toBe(
      "PWG07",
    );
  });

  test("解绑：204、绑定转 REVOKED、待用码作废、写审计；同 Key 重放 204", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const wecomUserid = nextWecomId("member");
    await bindPersonal(sql, member.userId, wecomUserid);
    const chatId = nextWecomId("chat");
    const code = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;
    await redeemGroup(sql, code, chatId, wecomUserid);

    const pending = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;

    const headers = {
      ...mutationHeaders(actor),
      "idempotency-key": `pwg-unbind-${nextWecomId("key")}`,
    };
    const first = await deleteGroup(project.projectId, headers);
    expect(first.status).toBe(204);

    const status = await getGroup(project.projectId, actor.cookie);
    expect(((await status.json()) as Record<string, unknown>)["state"]).toBe(
      "UNBOUND",
    );
    const rows = (await sql`
      SELECT id, status
        FROM app.project_wecom_groups
       WHERE project_id = ${project.projectId}
       ORDER BY id DESC
       LIMIT 1
    `) as unknown as readonly { id: number; status: string }[];
    expect(rows[0]?.status).toBe("REVOKED");

    // 待用码在解绑事务内作废：兑换返回 PWG02。
    expect(
      await redeemGroupErrorCode(
        sql,
        pending,
        nextWecomId("chat"),
        wecomUserid,
      ),
    ).toBe("PWG02");

    // 审计留痕（audit_logs 只对 audit_reader 角色可读）。
    const audits = (await requireAuditReader()`
      SELECT actor_id AS "actorId", action, target_type AS "targetType", target_id AS "targetId"
        FROM app.audit_logs
       WHERE action = 'project.wecomGroup.unbind'
         AND target_id = ${String(project.projectId)}
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      actorId: number;
      action: string;
      targetType: string;
      targetId: string;
    }[];
    expect(audits[0]?.actorId).toBe(actor.userId);
    expect(audits[0]?.targetType).toBe("PROJECT");

    // 同 Key 重放：204 且不再改变状态。
    const replay = await deleteGroup(project.projectId, headers);
    expect(replay.status).toBe(204);
  });

  test("解绑门禁与重放复核：普通成员 403、非成员 404、缺 CSRF 422、未知 Token 401、组长被降级后重放 403", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const outsider = await createActor(sql);

    const memberDelete = await deleteGroup(project.projectId, {
      ...mutationHeaders(member),
      "idempotency-key": `pwg-unbind-${nextWecomId("key")}`,
    });
    expect(memberDelete.status).toBe(403);

    const outsiderDelete = await deleteGroup(project.projectId, {
      ...mutationHeaders(outsider),
      "idempotency-key": `pwg-unbind-${nextWecomId("key")}`,
    });
    expect(outsiderDelete.status).toBe(404);

    const key = `pwg-unbind-${nextWecomId("key")}`;
    const missingCsrf = await deleteGroup(project.projectId, {
      cookie: actor.cookie,
      host: new URL(baseUrl).host,
      origin: new URL(baseUrl).origin,
      "idempotency-key": key,
    });
    expect(missingCsrf.status).toBe(422);

    const unknownToken = await deleteGroup(project.projectId, {
      ...mutationHeaders(actor),
      "x-csrf-token": randomBytes(32).toString("base64url"),
      "idempotency-key": key,
    });
    expect(unknownToken.status).toBe(401);

    const missingKey = await deleteGroup(
      project.projectId,
      mutationHeaders(actor),
    );
    expect(missingKey.status).toBe(400);

    const ok = await deleteGroup(project.projectId, {
      ...mutationHeaders(actor),
      "idempotency-key": key,
    });
    expect(ok.status).toBe(204);

    // 组长把身份转交给成员（先降级再升任，避开部分唯一索引瞬时冲突）。
    await sql.begin(async (tx) => {
      await tx`
        UPDATE app.project_members
           SET role = 'MEMBER'
         WHERE project_id = ${project.projectId}
           AND user_id = ${actor.userId}
           AND status = 'ACTIVE'
      `;
      await tx`
        UPDATE app.project_members
           SET role = 'LEADER'
         WHERE project_id = ${project.projectId}
           AND user_id = ${member.userId}
           AND status = 'ACTIVE'
      `;
    });

    const replay = await deleteGroup(project.projectId, {
      ...mutationHeaders(actor),
      "idempotency-key": key,
    });
    expect(replay.status).toBe(403);
  });

  test("项目群通知开关：默认全开、成员只读、组长/管理员保存、审计、幂等重放与解绑门禁", async () => {
    const sql = requireRuntime();
    const { actor, project } = await leaderContext(sql);
    const member = await createActor(sql);
    await addMember(sql, project.projectId, member.userId);
    const outsider = await createActor(sql);
    const admin = await createActor(sql, { admin: true });
    const wecomUserid = nextWecomId("member");
    await bindPersonal(sql, member.userId, wecomUserid);
    const chatId = nextWecomId("chat");

    const code = (
      (await (
        await createGroupCode(project.projectId, mutationHeaders(actor))
      ).json()) as { readonly code: string }
    ).code;
    await redeemGroup(sql, code, chatId, wecomUserid);

    const defaultStatus = await getGroup(project.projectId, member.cookie);
    expect(defaultStatus.status).toBe(200);
    expect(
      (
        (await defaultStatus.json()) as {
          readonly notificationOptions: unknown;
        }
      ).notificationOptions,
    ).toEqual({ disabledCategories: [] });

    const memberWrite = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(member),
        "idempotency-key": `pwg-options-${nextWecomId("key")}`,
      },
      { disabledCategories: ["task.assign"] },
    );
    expect(memberWrite.status).toBe(403);

    const outsiderWrite = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(outsider),
        "idempotency-key": `pwg-options-${nextWecomId("key")}`,
      },
      { disabledCategories: ["task.assign"] },
    );
    expect(outsiderWrite.status).toBe(404);

    const missingCsrf = await updateGroupNotificationOptions(
      project.projectId,
      {
        cookie: actor.cookie,
        host: new URL(baseUrl).host,
        origin: new URL(baseUrl).origin,
        "idempotency-key": `pwg-options-${nextWecomId("key")}`,
      },
      { disabledCategories: ["task.assign"] },
    );
    expect(missingCsrf.status).toBe(422);

    const invalidCategory = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": `pwg-options-${nextWecomId("key")}`,
      },
      { disabledCategories: ["unknown"] },
    );
    expect(invalidCategory.status).toBe(422);

    const adminSaved = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(admin),
        "idempotency-key": `pwg-options-${nextWecomId("key")}`,
      },
      { disabledCategories: ["record"] },
    );
    expect(adminSaved.status).toBe(200);

    const key = `pwg-options-${nextWecomId("key")}`;
    const payload = {
      disabledCategories: ["scope.delete", "task.assign", "task.assign"],
    };
    const saved = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": key,
      },
      payload,
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      disabledCategories: ["scope.delete", "task.assign"],
    });

    const readBack = await getGroup(project.projectId, member.cookie);
    expect(
      (
        (await readBack.json()) as {
          readonly notificationOptions: unknown;
        }
      ).notificationOptions,
    ).toEqual({ disabledCategories: ["scope.delete", "task.assign"] });

    const rows = (await sql`
      SELECT
        task_assign_enabled AS "taskAssignEnabled",
        task_status_enabled AS "taskStatusEnabled",
        record_enabled AS "recordEnabled",
        project_member_enabled AS "projectMemberEnabled",
        scope_delete_enabled AS "scopeDeleteEnabled",
        row_version AS "rowVersion"
        FROM app.project_wecom_group_notification_options
       WHERE project_id = ${project.projectId}
    `) as unknown as readonly {
      taskAssignEnabled: boolean;
      taskStatusEnabled: boolean;
      recordEnabled: boolean;
      projectMemberEnabled: boolean;
      scopeDeleteEnabled: boolean;
      rowVersion: number;
    }[];
    expect(rows[0]).toEqual({
      taskAssignEnabled: false,
      taskStatusEnabled: true,
      recordEnabled: true,
      projectMemberEnabled: true,
      scopeDeleteEnabled: false,
      rowVersion: 3,
    });

    const audits = (await requireAuditReader()`
      SELECT actor_id AS "actorId", event_payload AS "eventPayload"
        FROM app.audit_logs
       WHERE action = 'project.wecomGroup.notificationOptions.update'
         AND target_id = ${String(project.projectId)}
       ORDER BY sequence_no DESC
       LIMIT 1
    `) as unknown as readonly {
      actorId: number;
      eventPayload: {
        readonly before: unknown;
        readonly after: unknown;
      };
    }[];
    expect(audits[0]?.actorId).toBe(actor.userId);
    expect(audits[0]?.eventPayload.before).toEqual({
      disabledCategories: ["record"],
    });
    expect(audits[0]?.eventPayload.after).toEqual({
      disabledCategories: ["scope.delete", "task.assign"],
    });

    const replay = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": key,
      },
      payload,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      disabledCategories: ["scope.delete", "task.assign"],
    });
    const replayRows = (await sql`
      SELECT row_version AS "rowVersion"
        FROM app.project_wecom_group_notification_options
       WHERE project_id = ${project.projectId}
    `) as unknown as readonly { rowVersion: number }[];
    expect(replayRows[0]?.rowVersion).toBe(3);

    const differentBody = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": key,
      },
      { disabledCategories: ["record"] },
    );
    expect(differentBody.status).toBe(409);

    const unbound = await deleteGroup(project.projectId, {
      ...mutationHeaders(actor),
      "idempotency-key": `pwg-unbind-${nextWecomId("key")}`,
    });
    expect(unbound.status).toBe(204);

    const afterUnbind = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": `pwg-options-${nextWecomId("key")}`,
      },
      { disabledCategories: ["record"] },
    );
    expect(afterUnbind.status).toBe(409);
    expect(((await afterUnbind.json()) as { readonly code: string }).code).toBe(
      "PROJECT_WECOM_GROUP_NOT_BOUND",
    );

    const replayAfterUnbind = await updateGroupNotificationOptions(
      project.projectId,
      {
        ...mutationHeaders(actor),
        "idempotency-key": key,
      },
      payload,
    );
    expect(replayAfterUnbind.status).toBe(409);
    expect(
      ((await replayAfterUnbind.json()) as { readonly code: string }).code,
    ).toBe("PROJECT_WECOM_GROUP_NOT_BOUND");
  });
  test("最小授权探针：app_runtime 对三张表无 DELETE，app_backup 只读", async () => {
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

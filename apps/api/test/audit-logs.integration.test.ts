import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createDatabaseClient } from "@inpulse/database/client";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { auditLogPageSchema } from "../../../packages/api-contract/src/index.ts";
import { errorResponseSchema } from "../../../packages/api-contract/src/contracts/error.zod.ts";
import { PostgresAuditWritePort } from "../src/audit/postgres-audit-write-port.js";
import { VersionedHmacKeyring } from "../src/auth/keyring";
import { generateOpaqueToken, hashOpaqueToken } from "../src/auth/token";
import { PostgresUnitOfWork } from "../src/database/unit-of-work.js";
import {
  connect,
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./database.helpers";

const SESSION_COOKIE_NAME = "__Host-session";
const AUDIT_PATH = "/api/v1/audit-logs";
const HMAC_KEY_VERSION = 1;
// ADR-061 跨链夹具：两条链各两行共用同一 occurred_at，覆盖并列表排序与复合键集分页。
const TIE_OCCURRED_AT = new Date("2026-01-01T00:00:00.000Z");
const TIE_OCCURRED_AT_ISO = "2026-01-01T00:00:00.000000Z";

interface AuditLogPageDto {
  readonly items: readonly {
    readonly chainId: string;
    readonly sequenceNo: number;
    readonly actorType: string;
    readonly actorId: number | null;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string | null;
    readonly eventPayload: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
    readonly prevHash: string;
    readonly recordHash: string;
  }[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

interface ErrorResponseDto {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId: string;
}

interface AuditFixture {
  readonly adminCookie: string;
  readonly adminUserId: number;
  readonly memberCookie: string;
  readonly memberUserId: number;
  readonly project: ProjectFixture;
}

async function createSession(
  sql: Sql,
  keyring: VersionedHmacKeyring,
  userId: number,
): Promise<string> {
  const users = (await sql`
    SELECT auth_version AS "authVersion"
      FROM app.users
     WHERE id = ${userId}
  `) as unknown as readonly { authVersion: number }[];
  const user = users[0];
  if (user === undefined) {
    throw new Error(`user fixture ${userId} does not exist`);
  }
  const token = generateOpaqueToken();
  const tokenHash = hashOpaqueToken(token, keyring.currentKey());
  await sql`
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
      ${HMAC_KEY_VERSION},
      ${user.authVersion},
      'AUTHENTICATED',
      0,
      0,
      now(),
      now(),
      now() + interval '1 hour',
      now() + interval '1 day'
    )
  `;
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function auditUrl(
  baseUrl: string,
  query: Readonly<Record<string, string | number>>,
): string {
  const url = new URL(`${baseUrl}${AUDIT_PATH}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, String(value));
  }
  return url.toString();
}

async function requestAuditLogs(
  baseUrl: string,
  options: {
    readonly cookie?: string;
    readonly query?: Readonly<Record<string, string | number>>;
  } = {},
): Promise<Response> {
  const init: RequestInit = {};
  if (options.cookie !== undefined) {
    init.headers = { cookie: options.cookie };
  }
  return fetch(auditUrl(baseUrl, options.query ?? {}), init);
}

async function expectAuditPage(response: Response): Promise<AuditLogPageDto> {
  expect(response.status).toBe(200);
  const parsed = auditLogPageSchema.safeParse(await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("audit response does not satisfy AuditLogPageSchema");
  }
  return parsed.data;
}

async function expectError(
  response: Response,
  status: number,
): Promise<ErrorResponseDto> {
  expect(response.status).toBe(status);
  const parsed = errorResponseSchema.safeParse(await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("error response does not satisfy ErrorResponseSchema");
  }
  return parsed.data;
}

describe("GET /api/v1/audit-logs with HTTP and real PostgreSQL", () => {
  let app: INestApplication | undefined;
  let baseUrl: string;
  let fixture: AuditFixture;
  let runtime: Sql | undefined;
  let reader: Sql | undefined;
  let keyringDirectory: string | undefined;
  let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
  let urls: TestUrls;
  let seedAction: string;
  let actorFilterAction: string;
  let crossChainAction: string;

  beforeAll(async () => {
    urls = testUrls();
    runtime = connect(urls.runtime, 20);
    reader = connect(urls.auditReader, 10);
    await migrate(urls.migrator);

    seedAction = `AUDIT_SEED_${randomBytes(4).toString("hex").toUpperCase()}`;
    actorFilterAction = `AUDIT_ACTOR_${randomBytes(4).toString("hex").toUpperCase()}`;
    crossChainAction = `AUDIT_CROSS_${randomBytes(4).toString("hex").toUpperCase()}`;

    const adminUserId = await createUser(runtime, { admin: true });
    const memberUserId = await createUser(runtime);
    const project = await createProject(runtime, memberUserId);

    const writeClient = createDatabaseClient(urls.runtime, {
      applicationName: "inpulse-audit-logs-test-seed",
    });
    const uow = new PostgresUnitOfWork(writeClient);
    const auditKey = randomBytes(32);
    const port = new PostgresAuditWritePort({
      currentVersion: HMAC_KEY_VERSION,
      keyFor: () => auditKey,
    });
    for (const requestId of ["audit-seed-1", "audit-seed-2", "audit-seed-3"]) {
      await uow.run((tx) =>
        port.append(tx, {
          projectId: null,
          actorType: "SYSTEM",
          actorId: null,
          action: seedAction,
          targetType: "USER",
          targetId: String(memberUserId),
          eventPayload: { loginName: "seed-user" },
          requestId,
        }),
      );
    }
    await uow.run((tx) =>
      port.append(tx, {
        projectId: project.projectId,
        actorType: "USER",
        actorId: memberUserId,
        action: "PROJECT_CREATED",
        targetType: "PROJECT",
        targetId: String(project.projectId),
        eventPayload: { code: project.code },
        requestId: "audit-seed-project",
      }),
    );
    // 操作人筛选需要同一动作下的两个不同操作人，都落在 SYSTEM 链内。
    for (const [requestId, actorId] of [
      ["audit-actor-admin", adminUserId],
      ["audit-actor-member", memberUserId],
    ] as const) {
      await uow.run((tx) =>
        port.append(tx, {
          projectId: null,
          actorType: "USER",
          actorId,
          action: actorFilterAction,
          targetType: "USER",
          targetId: String(actorId),
          eventPayload: { note: requestId },
          requestId,
        }),
      );
    }
    // ADR-061 跨链读取：两条链各两行、occurred_at 完全相同，用来验证复合键集
    // 游标 (occurred_at, chain_id, sequence_no) 的并列分支与跨页不重不漏。
    for (const [requestId, projectId] of [
      ["audit-cross-system-1", null],
      ["audit-cross-system-2", null],
      ["audit-cross-project-1", project.projectId],
      ["audit-cross-project-2", project.projectId],
    ] as const) {
      await uow.run((tx) =>
        port.append(tx, {
          projectId,
          actorType: "SYSTEM",
          actorId: null,
          action: crossChainAction,
          targetType: "PROJECT",
          targetId: String(project.projectId),
          eventPayload: { tie: true },
          requestId,
          occurredAt: TIE_OCCURRED_AT,
        }),
      );
    }
    await writeClient.close();

    const keyringKey = randomBytes(32);
    const keyring = VersionedHmacKeyring.fromEntries(
      [{ version: HMAC_KEY_VERSION, key: keyringKey }],
      HMAC_KEY_VERSION,
    );
    keyringDirectory = await mkdtemp(join(tmpdir(), "inpulse-audit-logs-"));
    const keyringFile = join(keyringDirectory, "session.keyring");
    await writeFile(
      keyringFile,
      `${HMAC_KEY_VERSION}:${keyringKey.toString("hex")}\n`,
      "utf8",
    );
    const auditKeyringFile = join(keyringDirectory, "audit.keyring");
    await writeFile(
      auditKeyringFile,
      `1:${randomBytes(32).toString("hex")}\n`,
      "utf8",
    );

    const adminCookie = await createSession(runtime, keyring, adminUserId);
    const memberCookie = await createSession(runtime, keyring, memberUserId);
    fixture = {
      adminCookie,
      adminUserId,
      memberCookie,
      memberUserId,
      project,
    };

    previousEnvironment = {
      AUDIT_DATABASE_URL: process.env["AUDIT_DATABASE_URL"],
      AUDIT_HMAC_KEYRING_FILE: process.env["AUDIT_HMAC_KEYRING_FILE"],
      AUDIT_HMAC_KEYRING_TEST_PATH: process.env["AUDIT_HMAC_KEYRING_TEST_PATH"],
      AUDIT_HMAC_KEY_VERSION: process.env["AUDIT_HMAC_KEY_VERSION"],
      DATABASE_URL: process.env["DATABASE_URL"],
      NODE_ENV: process.env["NODE_ENV"],
      SESSION_HASH_KEYRING_FILE: process.env["SESSION_HASH_KEYRING_FILE"],
      SESSION_HASH_KEYRING_TEST_PATH:
        process.env["SESSION_HASH_KEYRING_TEST_PATH"],
      SESSION_HASH_KEY_VERSION: process.env["SESSION_HASH_KEY_VERSION"],
    };
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] = urls.runtime;
    process.env["AUDIT_DATABASE_URL"] = urls.auditReader;
    process.env["SESSION_HASH_KEYRING_FILE"] = keyringFile;
    process.env["SESSION_HASH_KEYRING_TEST_PATH"] = "1";
    process.env["SESSION_HASH_KEY_VERSION"] = String(HMAC_KEY_VERSION);
    process.env["AUDIT_HMAC_KEYRING_FILE"] = auditKeyringFile;
    process.env["AUDIT_HMAC_KEYRING_TEST_PATH"] = "1";
    process.env["AUDIT_HMAC_KEY_VERSION"] = String(HMAC_KEY_VERSION);

    const { AppModule } = await import("../src/app.module.js");
    app = await NestFactory.create(AppModule, {
      logger: false,
    });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.end({ timeout: 5 });
    await reader?.end({ timeout: 5 });
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

  /** ADR-060：读取不再写审计，历史上已有的 AUDIT_LOG_READ 行数必须保持不变。 */
  async function countReadTrailRows(): Promise<number> {
    const rows = (await reader!`
      SELECT count(*)::int AS "count"
        FROM app.audit_logs
       WHERE chain_id = 'SYSTEM'
         AND action = 'AUDIT_LOG_READ'
    `) as unknown as readonly { readonly count: number }[];
    return rows[0]?.count ?? -1;
  }

  test("匿名请求返回 401 与统一错误信封", async () => {
    const body = await expectError(await requestAuditLogs(baseUrl), 401);
    expect(body.code).toBe("ADMIN_SESSION_REQUIRED");
    expect(body.requestId).not.toBe("");
    expect(body.details).toHaveProperty("reason");
  });

  test("普通成员返回 403 且不暴露审计内容", async () => {
    const body = await expectError(
      await requestAuditLogs(baseUrl, { cookie: fixture.memberCookie }),
      403,
    );
    expect(body.code).toBe("ADMIN_REQUIRED");
    expect(JSON.stringify(body)).not.toContain(seedAction);
  });

  test("管理员完整认证 Session 无需额外重认证即可读取 SYSTEM 链，且读取不写审计（ADR-060）", async () => {
    const before = await countReadTrailRows();
    const page = await expectAuditPage(
      await requestAuditLogs(baseUrl, { cookie: fixture.adminCookie }),
    );
    expect(page.items.some((item) => item.action === seedAction)).toBe(true);
    const first = page.items[0]!;
    expect(first.chainId).toBe("SYSTEM");
    expect(first.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.occurredAt).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
    expect(await countReadTrailRows()).toBe(before);
  });

  test("初始读取、筛选与游标分页都不写审计（ADR-060）", async () => {
    const before = await countReadTrailRows();

    await expectAuditPage(
      await requestAuditLogs(baseUrl, { cookie: fixture.adminCookie }),
    );
    expect(await countReadTrailRows()).toBe(before);

    await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { action: seedAction },
      }),
    );
    expect(await countReadTrailRows()).toBe(before);

    const first = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { action: seedAction, limit: 1 },
      }),
    );
    expect(first.nextCursor).not.toBeNull();

    await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          action: seedAction,
          limit: 1,
          cursor: first.nextCursor as string,
        },
      }),
    );
    expect(await countReadTrailRows()).toBe(before);
  });

  test("action 过滤与签名游标分页不重叠", async () => {
    const first = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { action: seedAction, limit: 2 },
      }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items.every((item) => item.action === seedAction)).toBe(true);

    const second = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          action: seedAction,
          limit: 2,
          cursor: first.nextCursor as string,
        },
      }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const seen = new Set(
      [...first.items, ...second.items].map((item) => item.sequenceNo),
    );
    expect(seen.size).toBe(3);

    const mismatched = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          action: "PROJECT_CREATED",
          cursor: first.nextCursor as string,
        },
      }),
      422,
    );
    expect(mismatched.code).toBe("VALIDATION_FAILED");
  });

  test("actorIds 多操作人过滤与去重约束", async () => {
    const single = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          action: actorFilterAction,
          actorIds: String(fixture.adminUserId),
        },
      }),
    );
    expect(single.items).toHaveLength(1);
    expect(single.items[0]?.actorId).toBe(fixture.adminUserId);

    const both = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          action: actorFilterAction,
          actorIds: `${fixture.memberUserId},${fixture.adminUserId}`,
        },
      }),
    );
    expect(both.items).toHaveLength(2);
    expect(new Set(both.items.map((item) => item.actorId))).toEqual(
      new Set([fixture.adminUserId, fixture.memberUserId]),
    );

    const none = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          action: actorFilterAction,
          actorIds: "999999",
        },
      }),
    );
    expect(none.items).toHaveLength(0);
    expect(none.hasMore).toBe(false);

    const duplicated = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          actorIds: `${fixture.adminUserId},${fixture.adminUserId}`,
        },
      }),
      422,
    );
    expect(duplicated.code).toBe("VALIDATION_FAILED");
  });

  test("非法游标、时间范围与 limit 返回 422", async () => {
    const badCursor = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { cursor: "not-a-valid-cursor" },
      }),
      422,
    );
    expect(badCursor.code).toBe("VALIDATION_FAILED");
    expect(badCursor.details).toHaveProperty("reason");

    const badRange = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          from: "2026-09-12T00:00:00Z",
          to: "2026-09-11T00:00:00Z",
        },
      }),
      422,
    );
    expect(badRange.code).toBe("VALIDATION_FAILED");

    const badLimit = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { limit: 0 },
      }),
      422,
    );
    expect(badLimit.code).toBe("VALIDATION_FAILED");

    // readTrail 已随读取留痕一并移除（ADR-060）：未知查询参数按 strict 契约拒绝。
    const removedParam = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { readTrail: "false" },
      }),
      422,
    );
    expect(removedParam.code).toBe("VALIDATION_FAILED");
  });

  test("projectId 查询返回 PROJECT 链数据且不跨链", async () => {
    const page = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          projectId: fixture.project.projectId,
          action: "PROJECT_CREATED",
        },
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.chainId).toBe(`PROJECT:${fixture.project.projectId}`);
    expect(page.items[0]?.action).toBe("PROJECT_CREATED");
    expect(page.items[0]?.targetId).toBe(String(fixture.project.projectId));
    expect(page.hasMore).toBe(false);
  });

  test("项目物理删除后管理员仍可按 projectId 与 chain=all 读取保留的项目审计链", async () => {
    const project = await createProject(runtime!, fixture.memberUserId);
    const action = `PROJECT_DELETE_RETENTION_${randomBytes(4).toString("hex").toUpperCase()}`;
    const writerClient = createDatabaseClient(urls.runtime, {
      applicationName: "inpulse-audit-logs-retention-test",
    });
    try {
      const uow = new PostgresUnitOfWork(writerClient);
      const port = new PostgresAuditWritePort({
        currentVersion: HMAC_KEY_VERSION,
        keyFor: () => randomBytes(32),
      });
      await uow.run((tx) =>
        port.append(tx, {
          projectId: project.projectId,
          actorType: "USER",
          actorId: fixture.memberUserId,
          action,
          targetType: "PROJECT",
          targetId: String(project.projectId),
          eventPayload: { code: project.code, phase: "before-delete" },
          requestId: `audit-retention-${randomBytes(4).toString("hex")}`,
        }),
      );
    } finally {
      await writerClient.close();
    }

    await runtime!`SELECT * FROM app.purge_project(${project.projectId})`;

    const byProject = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { projectId: project.projectId, action },
      }),
    );
    expect(byProject.items).toHaveLength(1);
    expect(byProject.items[0]?.chainId).toBe(
      `PROJECT:${String(project.projectId)}`,
    );
    expect(byProject.items[0]?.action).toBe(action);
    expect(byProject.items[0]?.eventPayload["code"]).toBe(project.code);

    const allChains = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { chain: "all", action },
      }),
    );
    expect(allChains.items).toHaveLength(1);
    expect(allChains.items[0]?.chainId).toBe(
      `PROJECT:${String(project.projectId)}`,
    );
  });

  test("chain=all 跨链读取：并列时间排序稳定且分页不重不漏（ADR-061）", async () => {
    const all = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { chain: "all", action: crossChainAction },
      }),
    );
    expect(all.items).toHaveLength(4);
    expect(
      all.items.every((item) => item.occurredAt === TIE_OCCURRED_AT_ISO),
    ).toBe(true);
    // 同一 occurred_at 内先按 chain_id 倒序（SYSTEM > PROJECT:<id>），再按链序号倒序。
    expect(all.items.map((item) => item.chainId)).toEqual([
      "SYSTEM",
      "SYSTEM",
      `PROJECT:${fixture.project.projectId}`,
      `PROJECT:${fixture.project.projectId}`,
    ]);
    expect(all.items[0]!.sequenceNo).toBeGreaterThan(all.items[1]!.sequenceNo);
    expect(all.items[2]!.sequenceNo).toBeGreaterThan(all.items[3]!.sequenceNo);

    const keys = all.items.map((item) => `${item.chainId}#${item.sequenceNo}`);
    const paged: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (pages < 10) {
      pages += 1;
      const query: Record<string, string | number> = {
        chain: "all",
        action: crossChainAction,
        limit: 2,
      };
      if (cursor !== null) {
        query["cursor"] = cursor;
      }
      const page = await expectAuditPage(
        await requestAuditLogs(baseUrl, { cookie: fixture.adminCookie, query }),
      );
      paged.push(
        ...page.items.map((item) => `${item.chainId}#${item.sequenceNo}`),
      );
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      const next = page.nextCursor;
      expect(next).not.toBeNull();
      cursor = next;
    }
    expect(pages).toBe(2);
    expect(paged).toEqual(keys);
    expect(new Set(paged).size).toBe(paged.length);

    // 缺省（不带 chain）与 projectId 各自仍只读单链，不被跨链开关影响。
    const systemOnly = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { action: crossChainAction },
      }),
    );
    expect(systemOnly.items.map((item) => item.chainId)).toEqual([
      "SYSTEM",
      "SYSTEM",
    ]);
    const projectOnly = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          projectId: fixture.project.projectId,
          action: crossChainAction,
        },
      }),
    );
    expect(projectOnly.items).toHaveLength(2);
    expect(
      projectOnly.items.every(
        (item) => item.chainId === `PROJECT:${fixture.project.projectId}`,
      ),
    ).toBe(true);
  });

  test("chain 参数校验：与 projectId 互斥、未知取值拒绝、游标不跨读取模式复用（ADR-061）", async () => {
    const conflicting = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { chain: "all", projectId: fixture.project.projectId },
      }),
      422,
    );
    expect(conflicting.code).toBe("VALIDATION_FAILED");
    expect(conflicting.details).toHaveProperty("reason", "invalid-chain");

    const unknownValue = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { chain: "system" },
      }),
      422,
    );
    expect(unknownValue.code).toBe("VALIDATION_FAILED");

    const systemPage = await expectAuditPage(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: { action: crossChainAction, limit: 1 },
      }),
    );
    expect(systemPage.nextCursor).not.toBeNull();
    const reused = await expectError(
      await requestAuditLogs(baseUrl, {
        cookie: fixture.adminCookie,
        query: {
          chain: "all",
          action: crossChainAction,
          limit: 1,
          cursor: systemPage.nextCursor as string,
        },
      }),
      422,
    );
    expect(reused.code).toBe("VALIDATION_FAILED");
  });
});

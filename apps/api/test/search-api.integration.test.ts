import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { migrate } from "../../../database/src/migrate.ts";
import { searchPageSchema } from "../../../packages/api-contract/src/index.ts";
import { errorResponseSchema } from "../../../packages/api-contract/src/contracts/error.zod.ts";
import { VersionedHmacKeyring } from "../src/auth/keyring";
import { generateOpaqueToken, hashOpaqueToken } from "../src/auth/token";
import {
  connect,
  createProject,
  createUser,
  testUrls,
  type ProjectFixture,
  type TestUrls,
} from "./database.helpers";

const SESSION_COOKIE_NAME = "__Host-session";
const SEARCH_PATH = "/api/v1/search";
const HMAC_KEY_VERSION = 1;
const SEED_QUERY_PREFIX = `zzzz${randomBytes(4).toString("hex")}`;

interface SearchPageDto {
  readonly items: readonly {
    readonly projectId: number;
    readonly entityType: string;
    readonly entityId: number;
    readonly moduleId: number | null;
    readonly recordId: number | null;
    readonly title: string;
    readonly summary: string;
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

interface SearchFixture {
  readonly adminProject: ProjectFixture;
  readonly adminProjectEntityId: number;
  readonly adminOnlyEntityId: number;
  readonly adminUserId: number;
  readonly adminSessionCookie: string;
  readonly disabledSessionCookie: string;
  readonly disabledUserId: number;
  readonly hiddenEntityId: number;
  readonly leftoverEntityId: number;
  readonly memberProject: ProjectFixture;
  readonly memberSessionCookie: string;
  readonly memberUserId: number;
  readonly otherProject: ProjectFixture;
  readonly otherProjectEntityId: number;
  readonly otherSessionCookie: string;
  readonly otherUserId: number;
  readonly visibleEntityId1: number;
  readonly visibleEntityId2: number;
}

async function createAuthenticatedSession(
  sql: Sql,
  keyring: VersionedHmacKeyring,
  userId: number,
): Promise<{ readonly cookie: string; readonly token: string }> {
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
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, token };
}

async function insertProjection(
  sql: Sql,
  input: {
    readonly entityId: number;
    readonly entityType: string;
    readonly normalizedSearchText: string;
    readonly projectId: number;
    readonly sourceStatus: string;
    readonly summary: string;
    readonly title: string;
    readonly visibilityScope: string;
    readonly moduleId?: number;
    readonly recordId?: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO app.search_projection (
      project_id,
      entity_type,
      entity_id,
      module_id,
      record_id,
      title,
      summary,
      raw_text,
      normalized_search_text,
      visibility_scope,
      source_status,
      source_row_version
    )
    VALUES (
      ${input.projectId},
      ${input.entityType},
      ${input.entityId},
      ${input.moduleId ?? null},
      ${input.recordId ?? null},
      ${input.title},
      ${input.summary},
      ${input.title},
      ${input.normalizedSearchText},
      ${input.visibilityScope},
      ${input.sourceStatus},
      1
    )
  `;
}

function searchUrl(
  baseUrl: string,
  query: Readonly<Record<string, string | number | boolean>>,
): string {
  const url = new URL(`${baseUrl}${SEARCH_PATH}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, String(value));
  }
  return url.toString();
}

async function requestSearch(
  baseUrl: string,
  options: {
    readonly cookie?: string;
    readonly query?: Readonly<Record<string, string | number | boolean>>;
  } = {},
): Promise<Response> {
  const init: RequestInit = {};
  if (options.cookie !== undefined) {
    init.headers = { cookie: options.cookie };
  }
  return fetch(
    searchUrl(baseUrl, options.query ?? { q: SEED_QUERY_PREFIX }),
    init,
  );
}

async function expectSearchPage(response: Response): Promise<SearchPageDto> {
  expect(response.status).toBe(200);
  const parsed = searchPageSchema.safeParse(await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("search response does not satisfy SearchPageSchema");
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

describe("GET /api/v1/search with HTTP and real PostgreSQL", () => {
  let app: INestApplication | undefined;
  let baseUrl: string;
  let fixture: SearchFixture;
  let keyring: VersionedHmacKeyring;
  let keyringDirectory: string | undefined;
  let previousEnvironment: Readonly<Record<string, string | undefined>> = {};
  let runtime: Sql | undefined;
  let urls: TestUrls;

  beforeAll(async () => {
    urls = testUrls();
    runtime = connect(urls.runtime, 20);
    await migrate(urls.migrator);

    const memberUserId = await createUser(runtime);
    const otherUserId = await createUser(runtime);
    const adminUserId = await createUser(runtime, { admin: true });
    const disabledUserId = await createUser(runtime, { disabled: true });
    const memberProject = await createProject(runtime, memberUserId);
    const otherProject = await createProject(runtime, otherUserId);
    const adminProject = await createProject(runtime, adminUserId);

    const entityIdOffset = 900_000_000 + (Date.now() % 50_000_000);
    const visibleEntityId1 = entityIdOffset + 1;
    const visibleEntityId2 = entityIdOffset + 2;
    const adminOnlyEntityId = entityIdOffset + 3;
    const hiddenEntityId = entityIdOffset + 4;
    const otherProjectEntityId = entityIdOffset + 5;
    const adminProjectEntityId = entityIdOffset + 6;
    const leftoverEntityId = entityIdOffset + 7;

    await insertProjection(runtime, {
      projectId: memberProject.projectId,
      entityType: "TASK",
      entityId: visibleEntityId1,
      title: `${SEED_QUERY_PREFIX} one task`,
      summary: "member visible first",
      normalizedSearchText: `${SEED_QUERY_PREFIX} one task`,
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
    });
    await insertProjection(runtime, {
      projectId: memberProject.projectId,
      entityType: "PROJECT",
      entityId: visibleEntityId2,
      title: `${SEED_QUERY_PREFIX} two project`,
      summary: "member visible second",
      normalizedSearchText: `${SEED_QUERY_PREFIX} two project`,
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
    });
    await insertProjection(runtime, {
      projectId: memberProject.projectId,
      entityType: "CHANGE_RECORD",
      entityId: adminOnlyEntityId,
      title: `${SEED_QUERY_PREFIX} void record`,
      summary: "admin only void record",
      normalizedSearchText: `${SEED_QUERY_PREFIX} void record`,
      visibilityScope: "ADMIN_ONLY",
      sourceStatus: "VOID",
    });
    await insertProjection(runtime, {
      projectId: memberProject.projectId,
      entityType: "TASK",
      entityId: hiddenEntityId,
      title: `${SEED_QUERY_PREFIX} hidden task`,
      summary: "hidden projection",
      normalizedSearchText: `${SEED_QUERY_PREFIX} hidden task`,
      visibilityScope: "HIDDEN",
      sourceStatus: "VOID",
    });
    await insertProjection(runtime, {
      projectId: otherProject.projectId,
      entityType: "TASK",
      entityId: otherProjectEntityId,
      title: `${SEED_QUERY_PREFIX} cross project`,
      summary: "other member project",
      normalizedSearchText: `${SEED_QUERY_PREFIX} cross project`,
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
    });
    await insertProjection(runtime, {
      projectId: adminProject.projectId,
      entityType: "TASK",
      entityId: adminProjectEntityId,
      title: `${SEED_QUERY_PREFIX} admin project`,
      summary: "admin member project",
      normalizedSearchText: `${SEED_QUERY_PREFIX} admin project`,
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
    });
    await insertProjection(runtime, {
      projectId: memberProject.projectId,
      entityType: "LEFTOVER",
      entityId: leftoverEntityId,
      title: `${SEED_QUERY_PREFIX} leftover issue`,
      summary: "待处理 · CR-2048 登录页偶发闪白",
      normalizedSearchText: `${SEED_QUERY_PREFIX} leftover issue 待处理`,
      visibilityScope: "MEMBER",
      sourceStatus: "ACTIVE",
    });

    const keyringKey = randomBytes(32);
    keyring = VersionedHmacKeyring.fromEntries(
      [{ version: HMAC_KEY_VERSION, key: keyringKey }],
      HMAC_KEY_VERSION,
    );
    keyringDirectory = await mkdtemp(
      join(tmpdir(), "inpulse-search-api-keyring-"),
    );
    const keyringFile = join(keyringDirectory, "session.keyring");
    await writeFile(
      keyringFile,
      `${HMAC_KEY_VERSION}:${keyringKey.toString("hex")}\n`,
      "utf8",
    );

    const memberSession = await createAuthenticatedSession(
      runtime,
      keyring,
      memberUserId,
    );
    const otherSession = await createAuthenticatedSession(
      runtime,
      keyring,
      otherUserId,
    );
    const adminSession = await createAuthenticatedSession(
      runtime,
      keyring,
      adminUserId,
    );
    const disabledSession = await createAuthenticatedSession(
      runtime,
      keyring,
      disabledUserId,
    );

    fixture = {
      adminProject,
      adminProjectEntityId,
      adminOnlyEntityId,
      adminUserId,
      adminSessionCookie: adminSession.cookie,
      disabledSessionCookie: disabledSession.cookie,
      disabledUserId,
      hiddenEntityId,
      leftoverEntityId,
      memberProject,
      memberSessionCookie: memberSession.cookie,
      memberUserId,
      otherProject,
      otherProjectEntityId,
      otherSessionCookie: otherSession.cookie,
      otherUserId,
      visibleEntityId1,
      visibleEntityId2,
    };

    previousEnvironment = {
      DATABASE_URL: process.env["DATABASE_URL"],
      NODE_ENV: process.env["NODE_ENV"],
      SESSION_HASH_KEYRING_FILE: process.env["SESSION_HASH_KEYRING_FILE"],
      SESSION_HASH_KEYRING_TEST_PATH:
        process.env["SESSION_HASH_KEYRING_TEST_PATH"],
      SESSION_HASH_KEY_VERSION: process.env["SESSION_HASH_KEY_VERSION"],
    };
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] = urls.runtime;
    process.env["SESSION_HASH_KEYRING_FILE"] = keyringFile;
    process.env["SESSION_HASH_KEYRING_TEST_PATH"] = "1";
    process.env["SESSION_HASH_KEY_VERSION"] = String(HMAC_KEY_VERSION);

    const { AppModule } = await import("../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
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

  test("匿名请求返回 401 与统一错误信封", async () => {
    const body = await expectError(await requestSearch(baseUrl), 401);
    expect(body.code).toBe("SEARCH_UNAUTHENTICATED");
    expect(body.requestId).not.toBe("");
    expect(body.details).toEqual({});
  });

  test("有效成员只搜索本人活跃项目中的 MEMBER 投影", async () => {
    const page = await expectSearchPage(
      await requestSearch(baseUrl, { cookie: fixture.memberSessionCookie }),
    );

    expect(page.items).toHaveLength(3);
    expect(
      page.items.every(
        (item) => item.projectId === fixture.memberProject.projectId,
      ),
    ).toBe(true);
    expect(
      page.items
        .map((item) => item.entityId)
        .sort((left, right) => left - right),
    ).toEqual([
      fixture.visibleEntityId1,
      fixture.visibleEntityId2,
      fixture.leftoverEntityId,
    ]);
    expect(
      page.items.some((item) => item.entityId === fixture.adminOnlyEntityId),
    ).toBe(false);
    expect(
      page.items.some((item) => item.entityId === fixture.hiddenEntityId),
    ).toBe(false);
    expect(page.items.filter((item) => item.entityType === "LEFTOVER")).toEqual(
      [expect.objectContaining({ entityId: fixture.leftoverEntityId })],
    );
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      "entityId",
      "entityType",
      "moduleId",
      "projectId",
      "recordId",
      "summary",
      "title",
    ]);
  });

  test("遗留问题投影以独立 LEFTOVER 分类命中并携带处置状态", async () => {
    const page = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: `${SEED_QUERY_PREFIX} leftover issue` },
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        entityType: "LEFTOVER",
        entityId: fixture.leftoverEntityId,
        projectId: fixture.memberProject.projectId,
        title: `${SEED_QUERY_PREFIX} leftover issue`,
        summary: "待处理 · CR-2048 登录页偶发闪白",
      }),
    );
  });

  test("跨项目隔离由服务端 Scope 强制，普通成员默认 0 条", async () => {
    const memberCross = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: `${SEED_QUERY_PREFIX} cross project` },
      }),
    );
    expect(memberCross.items).toEqual([]);

    const otherCross = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.otherSessionCookie,
        query: { q: `${SEED_QUERY_PREFIX} cross project` },
      }),
    );
    expect(otherCross.items).toHaveLength(1);
    expect(otherCross.items[0]?.projectId).toBe(fixture.otherProject.projectId);
    expect(otherCross.items[0]?.entityId).toBe(fixture.otherProjectEntityId);
  });

  test("系统管理员默认不返回 ADMIN_ONLY，includeVoid=true 才显式开启", async () => {
    const adminDefault = await expectSearchPage(
      await requestSearch(baseUrl, { cookie: fixture.adminSessionCookie }),
    );
    expect(adminDefault.items).toHaveLength(5);
    expect(
      adminDefault.items.some(
        (item) => item.entityId === fixture.adminOnlyEntityId,
      ),
    ).toBe(false);

    const adminVoid = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.adminSessionCookie,
        query: { q: SEED_QUERY_PREFIX, includeVoid: true },
      }),
    );
    expect(adminVoid.items).toHaveLength(6);
    expect(
      adminVoid.items.some(
        (item) => item.entityId === fixture.adminOnlyEntityId,
      ),
    ).toBe(true);
    expect(
      adminVoid.items.some((item) => item.entityId === fixture.hiddenEntityId),
    ).toBe(false);
  });

  test("普通成员传 includeVoid=true 不会扩大范围", async () => {
    const page = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: SEED_QUERY_PREFIX, includeVoid: true },
      }),
    );
    expect(page.items).toHaveLength(3);
    expect(
      page.items.some((item) => item.entityId === fixture.adminOnlyEntityId),
    ).toBe(false);
  });

  test("签名游标在真实 HTTP 上支持无重叠分页", async () => {
    const first = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: SEED_QUERY_PREFIX, limit: 1 },
      }),
    );
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: {
          q: SEED_QUERY_PREFIX,
          limit: 1,
          cursor: first.nextCursor as string,
        },
      }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(true);
    expect(second.nextCursor).not.toBeNull();
    expect([second.items[0]?.projectId, second.items[0]?.entityId]).not.toEqual(
      [first.items[0]?.projectId, first.items[0]?.entityId],
    );

    const third = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: {
          q: SEED_QUERY_PREFIX,
          limit: 1,
          cursor: second.nextCursor as string,
        },
      }),
    );
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    const seen = new Set(
      [first, second, third].map(
        (page) => `${page.items[0]?.projectId}:${page.items[0]?.entityId}`,
      ),
    );
    expect(seen.size).toBe(3);
  });

  test("空查询与无效游标统一返回 422", async () => {
    const emptyBody = await expectError(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: "" },
      }),
      422,
    );
    expect(emptyBody.code).toBe("VALIDATION_FAILED");

    const cursorBody = await expectError(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: SEED_QUERY_PREFIX, cursor: "not-a-valid-cursor" },
      }),
      422,
    );
    expect(cursorBody.code).toBe("VALIDATION_FAILED");
    expect(cursorBody.details).toHaveProperty("reason");
  });

  test("单字查询不再被长度下限拦截且仍按授权范围过滤", async () => {
    const page = await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: "待", limit: 50 },
      }),
    );
    const entityIds = page.items.map((item) => item.entityId);

    // 用本轮可见数据中的中文单字命中，避免依赖测试库里的其他历史投影。
    expect(page.items.length).toBeGreaterThan(0);
    expect(entityIds).toContain(fixture.leftoverEntityId);
    expect(entityIds).not.toContain(fixture.adminOnlyEntityId);
    expect(entityIds).not.toContain(fixture.hiddenEntityId);
    expect(entityIds).not.toContain(fixture.otherProjectEntityId);
    expect(entityIds).not.toContain(fixture.adminProjectEntityId);

    // 中文单字同样不再被拦截（用户实际场景）。
    await expectSearchPage(
      await requestSearch(baseUrl, {
        cookie: fixture.memberSessionCookie,
        query: { q: "待" },
      }),
    );
  });

  test("停用用户与未知 Session Token 均返回 401", async () => {
    const disabledBody = await expectError(
      await requestSearch(baseUrl, {
        cookie: fixture.disabledSessionCookie,
      }),
      401,
    );
    expect(disabledBody.code).toBe("SEARCH_UNAUTHENTICATED");

    const unknownBody = await expectError(
      await requestSearch(baseUrl, {
        cookie: `${SESSION_COOKIE_NAME}=${"x".repeat(43)}`,
      }),
      401,
    );
    expect(unknownBody.code).toBe("SEARCH_UNAUTHENTICATED");
  });
});

import { describe, expect, test, vi } from "vitest";

import {
  SsoCasdoorDirectoryClient,
  SsoCasdoorDirectoryError,
} from "../src/auth/sso/sso-casdoor-directory.client.js";
import type { SsoConfig } from "../src/auth/sso/sso.config.js";

const ISSUER = "https://authtest.libiaorobot.com";
const ORGANIZATION = "libiaorobot.com";

const config: SsoConfig = {
  issuer: ISSUER,
  clientId: "inpulse-directory-test",
  clientSecret: "unit-test-directory-secret",
  redirectUrl: "http://127.0.0.1:5173/api/v1/auth/sso/callback",
  stateTtlSeconds: 600,
  discoveryTtlSeconds: 600,
  requestTimeoutMs: 2000,
};

const authorization =
  "Basic " +
  Buffer.from(config.clientId + ":" + config.clientSecret, "utf8").toString(
    "base64",
  );

interface RecordedRequest {
  readonly page: number;
  readonly owner: string;
  readonly authorization: string | undefined;
}

function user(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    displayName: "姓名 " + name,
    email: name + "@libiaorobot.com",
    password: ["unit", "test", "password"].join("-"),
    passwordSalt: ["unit", "test", "password", "salt"].join("-"),
    accessToken: ["unit", "test", "access", "token"].join("-"),
    totpSecret: ["unit", "test", "totp", "secret"].join("-"),
    isForbidden: false,
    isDeleted: false,
    deletedTime: "0001-01-01T00:00:00Z",
    groups: [ORGANIZATION + "/测试部"],
    ...overrides,
  };
}

function createPagesFetch(
  pages: Readonly<Record<number, readonly Record<string, unknown>[]>>,
): {
  readonly fetchImpl: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("p"));
    const headers = (init?.headers ?? {}) as Readonly<Record<string, string>>;
    requests.push({
      page,
      owner: url.searchParams.get("owner") ?? "",
      authorization: headers["authorization"],
    });
    return new Response(
      JSON.stringify({ status: "ok", data: pages[page] ?? [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("SsoCasdoorDirectoryClient", () => {
  test("使用 Basic 认证分页读取，只保留脱敏身份与配置组织下的组", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      user("id-" + index, "user-" + String(index).padStart(3, "0"), {
        groups: [
          ORGANIZATION + "/测试部",
          ORGANIZATION + "/Virtual Group1",
          "casbin/casbin_group",
        ],
      }),
    );
    const secondPage = [
      user("id-100", "user-100", {
        email: null,
        groups: [ORGANIZATION + "/项目部"],
      }),
    ];
    const fixture = createPagesFetch({ 1: firstPage, 2: secondPage });

    const snapshot = await new SsoCasdoorDirectoryClient(
      config,
      ORGANIZATION,
      fixture.fetchImpl,
    ).load();

    expect(snapshot.users).toHaveLength(101);
    expect(fixture.requests.map((request) => request.page)).toEqual([1, 2]);
    expect(
      fixture.requests.every(
        (request) =>
          request.owner === ORGANIZATION &&
          request.authorization === authorization,
      ),
    ).toBe(true);
    expect(snapshot.users[0]).toMatchObject({
      loginName: "user-000",
      groups: [ORGANIZATION + "/Virtual Group1", ORGANIZATION + "/测试部"],
    });
    expect(snapshot.users.at(-1)).toMatchObject({
      loginName: "user-100",
      email: null,
      groups: [ORGANIZATION + "/项目部"],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("unit-test-password");
    expect(serialized).not.toContain("unit-test-access-token");
    expect(serialized).not.toContain("unit-test-totp-secret");
  });

  test("过滤停用、删除与墓碑账号，并对重复组去重", async () => {
    const fixture = createPagesFetch({
      1: [
        user("active", "active", {
          groups: [
            ORGANIZATION + "/测试部",
            ORGANIZATION + "/测试部",
            ORGANIZATION + "/Virtual Group1",
            "casbin/casbin_group",
          ],
        }),
        user("forbidden", "forbidden", { isForbidden: true }),
        user("deleted", "deleted", { isDeleted: true }),
        user("tombstone", "tombstone", {
          deletedTime: "2026-10-01T00:00:00Z",
        }),
        user("zero-time-deleted", "zero-time-deleted", {
          deletedTime: "0001-01-01T00:00:00Z",
          groups: [],
        }),
      ],
    });

    const snapshot = await new SsoCasdoorDirectoryClient(
      config,
      ORGANIZATION,
      fixture.fetchImpl,
    ).load();

    expect(snapshot.users.map((entry) => entry.loginName)).toEqual([
      "active",
      "zero-time-deleted",
    ]);
    expect(snapshot.users[0]?.groups).toEqual([
      ORGANIZATION + "/Virtual Group1",
      ORGANIZATION + "/测试部",
    ]);
    expect(snapshot.users[1]?.groups).toEqual([]);
  });

  test("阻止重复 Casdoor 标识，避免分页漂移时静默覆盖", async () => {
    const fixture = createPagesFetch({
      1: [user("duplicate", "first"), user("duplicate", "second")],
    });
    await expect(
      new SsoCasdoorDirectoryClient(
        config,
        ORGANIZATION,
        fixture.fetchImpl,
      ).load(),
    ).rejects.toMatchObject({ reason: "duplicate-user-id" });
  });

  test("阻止大小写等价的重复登录名", async () => {
    const fixture = createPagesFetch({
      1: [user("one", "SameUser"), user("two", "sameuser")],
    });
    await expect(
      new SsoCasdoorDirectoryClient(
        config,
        ORGANIZATION,
        fixture.fetchImpl,
      ).load(),
    ).rejects.toMatchObject({ reason: "duplicate-login-name" });
  });

  test("限制单个账号的组数量并拒绝非法路径", async () => {
    const tooMany = Array.from(
      { length: 101 },
      (_, index) => ORGANIZATION + "/组" + index,
    );
    const overLimit = createPagesFetch({
      1: [user("many", "many", { groups: tooMany })],
    });
    await expect(
      new SsoCasdoorDirectoryClient(
        config,
        ORGANIZATION,
        overLimit.fetchImpl,
      ).load(),
    ).rejects.toMatchObject({ reason: "groups-too-many" });

    const invalid = createPagesFetch({
      1: [user("invalid", "invalid", { groups: [ORGANIZATION + "//测试部"] })],
    });
    await expect(
      new SsoCasdoorDirectoryClient(
        config,
        ORGANIZATION,
        invalid.fetchImpl,
      ).load(),
    ).rejects.toMatchObject({ reason: "groups-invalid" });
  });

  test("超过 1000 个账号时拒绝整批读取", async () => {
    const pages: Record<number, readonly Record<string, unknown>[]> = {};
    for (let page = 1; page <= 10; page += 1) {
      pages[page] = Array.from({ length: 100 }, (_, index) =>
        user("id-" + page + "-" + index, "user-" + page + "-" + index),
      );
    }
    pages[11] = [user("overflow", "overflow")];
    const fixture = createPagesFetch(pages);

    await expect(
      new SsoCasdoorDirectoryClient(
        config,
        ORGANIZATION,
        fixture.fetchImpl,
      ).load(),
    ).rejects.toMatchObject({ reason: "directory-too-large" });
  });

  test.each([
    ["HTTP 403", new Response("denied", { status: 403 })],
    ["非 JSON", new Response("bad", { status: 200 })],
    [
      "Casdoor status error",
      new Response(JSON.stringify({ status: "error", data: [] }), {
        status: 200,
      }),
    ],
    [
      "data 不是数组",
      new Response(JSON.stringify({ status: "ok", data: {} }), {
        status: 200,
      }),
    ],
    [
      "非法禁用状态",
      new Response(
        JSON.stringify({
          status: "ok",
          data: [user("invalid-state", "invalid-state", { isForbidden: "no" })],
        }),
        { status: 200 },
      ),
    ],
  ])("%s 时按目录失败拒绝", async (_label, response) => {
    const fetchImpl = vi.fn(async () =>
      response.clone(),
    ) as unknown as typeof fetch;
    await expect(
      new SsoCasdoorDirectoryClient(config, ORGANIZATION, fetchImpl).load(),
    ).rejects.toBeInstanceOf(SsoCasdoorDirectoryError);
  });

  test("未配置组织时 fail closed 且绝不发起请求", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      new SsoCasdoorDirectoryClient(config, undefined, fetchImpl).load(),
    ).rejects.toMatchObject({ reason: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

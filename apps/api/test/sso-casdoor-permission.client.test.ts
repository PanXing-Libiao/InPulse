import { describe, expect, test } from "vitest";

import {
  SsoCasdoorPermissionClient,
  SsoCasdoorPermissionError,
} from "../src/auth/sso/sso-casdoor-permission.client.js";
import type { SsoConfig } from "../src/auth/sso/sso.config.js";

const ISSUER = "https://authtest.libiaorobot.com";
const ORGANIZATION = "libiaorobot.com";
const PERMISSION = "permission_inpulse";

const config: SsoConfig = {
  issuer: ISSUER,
  clientId: "inpulse-test",
  clientSecret: "unit-test-secret",
  redirectUrl: "http://127.0.0.1:5173/api/v1/auth/sso/callback",
  stateTtlSeconds: 600,
  discoveryTtlSeconds: 600,
  requestTimeoutMs: 2000,
  importOrganization: ORGANIZATION,
  importPermission: PERMISSION,
};

const AUTHORIZATION =
  "Basic " +
  Buffer.from(config.clientId + ":" + config.clientSecret, "utf8").toString(
    "base64",
  );

interface RequestRecord {
  readonly path: string;
  readonly id: string;
  readonly authorization: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetch(records: Readonly<Record<string, unknown>>): {
  readonly fetchImpl: typeof fetch;
  readonly requests: RequestRecord[];
} {
  const requests: RequestRecord[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const id = url.searchParams.get("id") ?? "";
    requests.push({
      path: url.pathname,
      id,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const record = records[id];
    return record === undefined
      ? jsonResponse({ status: "error", msg: "not found" }, 404)
      : jsonResponse({ status: "ok", msg: "", data: record });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function permissionRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    owner: ORGANIZATION,
    name: PERMISSION,
    isEnabled: true,
    effect: "Allow",
    state: "Approved",
    roles: [ORGANIZATION + "/inpulse_role"],
    groups: [ORGANIZATION + "/Inpulse Group Access"],
    users: [ORGANIZATION + "/direct_user"],
    ...overrides,
  };
}

function roleRecord(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    owner: ORGANIZATION,
    name,
    isEnabled: true,
    roles: [],
    groups: [],
    users: [],
    ...overrides,
  };
}

describe("SsoCasdoorPermissionClient", () => {
  test("读取 Permission 与嵌套角色，返回允许的群组和直接用户", async () => {
    const source = createFetch({
      [ORGANIZATION + "/" + PERMISSION]: permissionRecord(),
      [ORGANIZATION + "/inpulse_role"]: roleRecord("inpulse_role", {
        groups: [
          ORGANIZATION + "/Software Project 1",
          ORGANIZATION + "/Basic RD",
        ],
        roles: [ORGANIZATION + "/nested_role"],
      }),
      [ORGANIZATION + "/nested_role"]: roleRecord("nested_role", {
        groups: [ORGANIZATION + "/Software Project 2"],
      }),
    });

    const scope = await new SsoCasdoorPermissionClient(
      config,
      PERMISSION,
      source.fetchImpl,
    ).resolveScope(ORGANIZATION);

    expect([...scope.groupIds].sort()).toEqual([
      ORGANIZATION + "/Basic RD",
      ORGANIZATION + "/Inpulse Group Access",
      ORGANIZATION + "/Software Project 1",
      ORGANIZATION + "/Software Project 2",
    ]);
    expect([...scope.userIds]).toEqual([ORGANIZATION + "/direct_user"]);
    expect(source.requests).toHaveLength(3);
    expect(
      source.requests.every(
        (request) => request.authorization === AUTHORIZATION,
      ),
    ).toBe(true);
    expect(source.requests.map((request) => request.path).sort()).toEqual([
      "/api/get-permission",
      "/api/get-role",
      "/api/get-role",
    ]);
  });

  test("Permission 禁用或非 Allow 时 fail closed", async () => {
    for (const overrides of [
      { isEnabled: false },
      { effect: "Deny" },
      { effect: undefined },
      { state: "Pending" },
      { state: undefined },
    ] as const) {
      const source = createFetch({
        [ORGANIZATION + "/" + PERMISSION]: permissionRecord(overrides),
      });
      await expect(
        new SsoCasdoorPermissionClient(
          config,
          PERMISSION,
          source.fetchImpl,
        ).resolveScope(ORGANIZATION),
      ).rejects.toBeInstanceOf(SsoCasdoorPermissionError);
    }
  });

  test("跨 owner 引用按权限配置异常拒绝", async () => {
    const source = createFetch({
      [ORGANIZATION + "/" + PERMISSION]: permissionRecord({
        groups: ["other-org/Software Project 1"],
      }),
    });

    await expect(
      new SsoCasdoorPermissionClient(
        config,
        PERMISSION,
        source.fetchImpl,
      ).resolveScope(ORGANIZATION),
    ).rejects.toMatchObject({
      reason: "resource-owner-mismatch",
    });
  });

  test("没有允许的用户或群组时拒绝，避免退化为全量导入", async () => {
    const source = createFetch({
      [ORGANIZATION + "/" + PERMISSION]: permissionRecord({
        roles: [],
        groups: [],
        users: [],
      }),
    });

    await expect(
      new SsoCasdoorPermissionClient(
        config,
        PERMISSION,
        source.fetchImpl,
      ).resolveScope(ORGANIZATION),
    ).rejects.toMatchObject({
      reason: "permission-empty",
    });
  });
});

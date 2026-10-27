import { describe, expect, test } from "vitest";

import {
  SsoCasdoorGroupClient,
  SsoGroupMetadataError,
} from "../src/auth/sso/sso-casdoor-group.client.js";
import type { SsoConfig } from "../src/auth/sso/sso.config.js";

const ISSUER = "https://authtest.libiaorobot.com";
const GROUP_ENDPOINT = ISSUER + "/api/get-group";

const config: SsoConfig = {
  issuer: ISSUER,
  clientId: "inpulse-test",
  clientSecret: "unit-test-secret",
  redirectUrl: "http://127.0.0.1:5173/api/v1/auth/sso/callback",
  stateTtlSeconds: 600,
  discoveryTtlSeconds: 600,
  requestTimeoutMs: 2000,
};

const GROUP_AUTHORIZATION =
  "Basic " +
  Buffer.from(config.clientId + ":" + config.clientSecret, "utf8").toString(
    "base64",
  );

interface GroupRecord {
  readonly owner: string;
  readonly name: string;
  readonly type?: string;
  readonly parentId?: string;
  readonly isTopGroup?: boolean;
  readonly isEnabled?: boolean;
}

interface RequestRecord {
  readonly id: string;
  readonly authorization: string | null;
}

function createGroupFetch(
  records: ReadonlyMap<string, GroupRecord | Response>,
): {
  readonly fetchImpl: typeof fetch;
  readonly requests: RequestRecord[];
} {
  const requests: RequestRecord[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(GROUP_ENDPOINT);
    const id = url.searchParams.get("id") ?? "";
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ id, authorization });
    const record = records.get(id);
    if (record instanceof Response) {
      return record;
    }
    if (record === undefined) {
      return jsonResponse({ status: "error", msg: "not found" }, 404);
    }
    return jsonResponse({ status: "ok", msg: "", data: record });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function physical(path: string): GroupRecord {
  const segments = path.split("/");
  return {
    owner: segments[0]!,
    name: segments.at(-1)!,
    type: "Physical",
    parentId:
      segments.length === 2 ? segments[0]! : segments[segments.length - 2]!,
    isTopGroup: segments.length === 2,
    isEnabled: true,
  };
}

function virtual(path: string): GroupRecord {
  return { ...physical(path), type: "Virtual" };
}

function withoutType(path: string): GroupRecord {
  const { type: _type, ...record } = physical(path);
  return record;
}

function withoutEnabled(path: string): GroupRecord {
  const { isEnabled: _isEnabled, ...record } = physical(path);
  return record;
}

describe("SsoCasdoorGroupClient", () => {
  test("只保留启用中的 Physical 组，并把 owner/name 作为 Casdoor 主键查询", async () => {
    const physicalPath = "libiaorobot.com/测试部";
    const virtualPath = "libiaorobot.com/Virtual Group3";
    const groupFetch = createGroupFetch(
      new Map([
        ["libiaorobot.com/测试部", physical(physicalPath)],
        ["libiaorobot.com/Virtual Group3", virtual(virtualPath)],
      ]),
    );

    const groups = await new SsoCasdoorGroupClient(
      config,
      groupFetch.fetchImpl,
    ).resolvePhysicalGroups([physicalPath, virtualPath]);

    expect(groups).toEqual([physicalPath]);
    expect(groupFetch.requests.map((request) => request.id)).toEqual([
      "libiaorobot.com/Virtual Group3",
      "libiaorobot.com/测试部",
    ]);
    expect(
      groupFetch.requests.every(
        (request) => request.authorization === GROUP_AUTHORIZATION,
      ),
    ).toBe(true);
  });

  test("只有 Virtual 组或 Physical 组停用时返回空数组", async () => {
    const virtualPath = "libiaorobot.com/Virtual Group3";
    const disabledPath = "libiaorobot.com/测试部";
    const groupFetch = createGroupFetch(
      new Map([
        ["libiaorobot.com/Virtual Group3", virtual(virtualPath)],
        [
          "libiaorobot.com/测试部",
          { ...physical(disabledPath), isEnabled: false },
        ],
      ]),
    );

    const groups = await new SsoCasdoorGroupClient(
      config,
      groupFetch.fetchImpl,
    ).resolvePhysicalGroups([virtualPath, disabledPath]);

    expect(groups).toEqual([]);
  });

  test("父级与子级 Physical 组均保留，祖先收敛仍由组织同步负责", async () => {
    const parentPath = "libiaorobot.com/总部";
    const childPath = "libiaorobot.com/总部/测试部";
    const groupFetch = createGroupFetch(
      new Map([
        ["libiaorobot.com/总部", physical(parentPath)],
        ["libiaorobot.com/测试部", physical(childPath)],
      ]),
    );

    const groups = await new SsoCasdoorGroupClient(
      config,
      groupFetch.fetchImpl,
    ).resolvePhysicalGroups([parentPath, childPath]);

    expect(groups).toEqual([parentPath, childPath]);
  });

  test.each([
    ["HTTP 403", jsonResponse({}, 403)],
    [
      "Casdoor status error",
      jsonResponse({ status: "error", msg: "denied", data: null }),
    ],
    ["非 JSON", new Response("bad", { status: 200 })],
  ])("%s 按元数据失败拒绝", async (_label, response) => {
    const path = "libiaorobot.com/测试部";
    const groupFetch = createGroupFetch(
      new Map([["libiaorobot.com/测试部", response]]),
    );

    await expect(
      new SsoCasdoorGroupClient(
        config,
        groupFetch.fetchImpl,
      ).resolvePhysicalGroups([path]),
    ).rejects.toBeInstanceOf(SsoGroupMetadataError);
  });

  test.each([
    [
      "未知类型",
      "libiaorobot.com/测试部",
      "libiaorobot.com/测试部",
      { ...physical("libiaorobot.com/测试部"), type: "Other" },
    ],
    [
      "缺少类型",
      "libiaorobot.com/测试部",
      "libiaorobot.com/测试部",
      withoutType("libiaorobot.com/测试部"),
    ],
    [
      "owner 不匹配",
      "libiaorobot.com/测试部",
      "libiaorobot.com/测试部",
      { ...physical("libiaorobot.com/测试部"), owner: "other.example" },
    ],
    [
      "name 不匹配",
      "libiaorobot.com/测试部",
      "libiaorobot.com/测试部",
      { ...physical("libiaorobot.com/测试部"), name: "研发部" },
    ],
    [
      "父级不匹配",
      "libiaorobot.com/总部/测试部",
      "libiaorobot.com/测试部",
      { ...physical("libiaorobot.com/总部/测试部"), parentId: "研发部" },
    ],
    [
      "顶层标记不匹配",
      "libiaorobot.com/总部/测试部",
      "libiaorobot.com/测试部",
      { ...physical("libiaorobot.com/总部/测试部"), isTopGroup: true },
    ],
    [
      "顶层父级不是组织 ID",
      "libiaorobot.com/测试部",
      "libiaorobot.com/测试部",
      { ...physical("libiaorobot.com/测试部"), parentId: "总部" },
    ],
    [
      "缺少启用状态",
      "libiaorobot.com/测试部",
      "libiaorobot.com/测试部",
      withoutEnabled("libiaorobot.com/测试部"),
    ],
  ])("%s 按元数据失败拒绝", async (_label, claimPath, id, record) => {
    const groupFetch = createGroupFetch(new Map([[id, record]]));

    await expect(
      new SsoCasdoorGroupClient(
        config,
        groupFetch.fetchImpl,
      ).resolvePhysicalGroups([claimPath]),
    ).rejects.toBeInstanceOf(SsoGroupMetadataError);
  });

  test("管理员导入按群组目录还原子组完整路径，并过滤 Virtual 与停用组", async () => {
    const organization = "libiaorobot.com";
    const requests: string[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(ISSUER + "/api/get-groups");
      expect(url.searchParams.get("owner")).toBe(organization);
      expect(url.searchParams.get("pageSize")).toBe("100");
      requests.push(url.searchParams.get("p") ?? "");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        GROUP_AUTHORIZATION,
      );
      return jsonResponse({
        status: "ok",
        msg: "",
        data: [
          {
            owner: organization,
            name: "总部",
            type: "Physical",
            parentId: organization,
            isTopGroup: true,
            isEnabled: true,
          },
          {
            owner: organization,
            name: "测试部",
            type: "Physical",
            parentId: "总部",
            isTopGroup: false,
            isEnabled: true,
          },
          {
            owner: organization,
            name: "Virtual Group3",
            type: "Virtual",
            parentId: organization,
            isTopGroup: true,
            isEnabled: true,
          },
          {
            owner: organization,
            name: "停用部",
            type: "Physical",
            parentId: organization,
            isTopGroup: true,
            isEnabled: false,
          },
        ],
      });
    }) as typeof fetch;

    const groups = await new SsoCasdoorGroupClient(
      config,
      fetchImpl,
    ).resolvePhysicalImportGroups(organization, [
      organization + "/总部",
      organization + "/测试部",
      organization + "/Virtual Group3",
      organization + "/停用部",
      organization + "/已消失群组",
    ]);

    expect([...groups.entries()]).toEqual([
      [organization + "/总部", organization + "/总部"],
      [organization + "/测试部", organization + "/总部/测试部"],
    ]);
    expect(requests).toEqual(["1"]);
  });

  test("管理员导入遇到缺失父组时 fail closed", async () => {
    const organization = "libiaorobot.com";
    const fetchImpl = (async (): Promise<Response> =>
      jsonResponse({
        status: "ok",
        msg: "",
        data: [
          {
            owner: organization,
            name: "测试部",
            type: "Physical",
            parentId: "不存在",
            isTopGroup: false,
            isEnabled: true,
          },
        ],
      })) as typeof fetch;

    await expect(
      new SsoCasdoorGroupClient(config, fetchImpl).resolvePhysicalImportGroups(
        organization,
        [organization + "/测试部"],
      ),
    ).rejects.toMatchObject({
      reason: "group-parent-missing",
    });
  });

  test("管理员导入目录读取失败时 fail closed", async () => {
    const organization = "libiaorobot.com";
    const fetchImpl = (async (): Promise<Response> =>
      new Response("bad", { status: 200 })) as typeof fetch;

    await expect(
      new SsoCasdoorGroupClient(config, fetchImpl).resolvePhysicalImportGroups(
        organization,
        [organization + "/测试部"],
      ),
    ).rejects.toMatchObject({
      reason: "malformed-response",
    });
  });

  test("网络失败时按元数据失败拒绝", async () => {
    const path = "libiaorobot.com/测试部";
    const failing = new SsoCasdoorGroupClient(config, (async () => {
      throw new Error("network down");
    }) as typeof fetch);

    await expect(failing.resolvePhysicalGroups([path])).rejects.toMatchObject({
      reason: "idp-unreachable",
    });
  });
});

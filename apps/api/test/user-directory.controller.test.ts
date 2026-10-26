import { describe, expect, test, vi } from "vitest";

import { UserDirectoryController } from "../src/auth/user-directory.controller.js";
import type { UserDirectoryItem } from "@inpulse/api-contract";

const directoryItems: readonly UserDirectoryItem[] = [
  {
    id: 2,
    name: "开发者 B",
    avatarUrl: null,
    isAdmin: false,
    organizations: [],
  },
  {
    id: 3,
    name: "管理员 A",
    avatarUrl: "https://example.test/a.png",
    isAdmin: true,
    organizations: [
      { id: 7, name: "研发一组", source: "LOCAL", groupPath: null },
    ],
  },
];

class FakeUserDirectoryService {
  items: readonly UserDirectoryItem[] | undefined = directoryItems;
  error: Error | undefined;
  calls = 0;

  async getDirectory(): Promise<readonly UserDirectoryItem[] | undefined> {
    this.calls += 1;
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.items;
  }
}

function responseFixture() {
  const headers: Record<string, string | readonly string[]> = {};
  return {
    status: vi.fn(() => undefined),
    setHeader(name: string, value: string | readonly string[]): void {
      headers[name] = value;
    },
    headers,
  };
}

function requestFixture(cookie: string | undefined) {
  return {
    headers: cookie === undefined ? {} : { cookie },
  };
}

describe("UserDirectoryController", () => {
  test("有效身份返回公开目录并禁用缓存", async () => {
    const service = new FakeUserDirectoryService();
    const controller = new UserDirectoryController(service as never);
    const response = responseFixture();

    const result = await controller.list(
      requestFixture("__Host-session=token") as never,
      response as never,
    );

    expect(service.calls).toBe(1);
    expect(result).toEqual({ items: directoryItems });
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  test("身份无效时返回统一 401 信封", async () => {
    const service = new FakeUserDirectoryService();
    service.items = undefined;
    const controller = new UserDirectoryController(service as never);
    const response = responseFixture();

    const result = await controller.list(
      requestFixture(undefined) as never,
      response as never,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(result).toMatchObject({ code: "USER_DIRECTORY_UNAUTHENTICATED" });
  });

  test("未预期错误返回统一 500 信封且不泄露内部细节", async () => {
    const service = new FakeUserDirectoryService();
    service.error = new Error("secret database details");
    const controller = new UserDirectoryController(service as never);
    const response = responseFixture();

    const result = await controller.list(
      requestFixture("__Host-session=token") as never,
      response as never,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(result).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toContain("secret database details");
  });
});

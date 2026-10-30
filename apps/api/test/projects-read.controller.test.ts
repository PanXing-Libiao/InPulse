import { describe, expect, it, vi } from "vitest";
import type { ProjectItem } from "@inpulse/api-contract";
import { ProjectsReadController } from "../src/modules/projects/projects-read.controller.js";
import { ProjectReadServiceError } from "../src/modules/projects/projects-read.service.js";

const project: ProjectItem = {
  id: 7,
  code: "SHOP",
  name: "商城系统",
  description: "项目描述",
  status: "ACTIVE",
  hasCompletedTask: true,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 2,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

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

function requestFixture(cookie?: string) {
  return { headers: cookie === undefined ? {} : { cookie } };
}

describe("ProjectsReadController", () => {
  it("returns list and detail with no-store and passes the session cookie", async () => {
    const list = vi.fn().mockResolvedValue({ items: [project] });
    const detail = vi.fn().mockResolvedValue({ project });
    const controller = new ProjectsReadController({
      list,
      detail,
    } as never);
    const listResponse = responseFixture();
    await controller.list(
      requestFixture("cookie") as never,
      listResponse as never,
    );
    expect(list).toHaveBeenCalledWith("cookie");
    expect(listResponse.headers["Cache-Control"]).toBe("no-store");

    const detailResponse = responseFixture();
    await controller.detail(
      requestFixture("cookie") as never,
      detailResponse as never,
      { projectId: 7 },
    );
    expect(detail).toHaveBeenCalledWith("cookie", 7);
    expect(detailResponse.headers["Cache-Control"]).toBe("no-store");
  });

  it("maps auth failure and unused member to 401/404 error envelopes", async () => {
    const controller = new ProjectsReadController({
      list: vi
        .fn()
        .mockRejectedValue(
          new ProjectReadServiceError(
            401,
            "PROJECT_SESSION_REQUIRED",
            "请先登录",
          ),
        ),
      detail: vi
        .fn()
        .mockRejectedValue(
          new ProjectReadServiceError(404, "PROJECT_NOT_FOUND", "无权访问"),
        ),
    } as never);
    const response = responseFixture();
    const result = await controller.list(
      requestFixture() as never,
      response as never,
    );
    expect(response.status).toHaveBeenCalledWith(401);
    expect(result).toMatchObject({
      code: "PROJECT_SESSION_REQUIRED",
      requestId: expect.any(String),
    });

    const detailResponse = responseFixture();
    const detailResult = await controller.detail(
      requestFixture("cookie") as never,
      detailResponse as never,
      { projectId: 7 },
    );
    expect(detailResponse.status).toHaveBeenCalledWith(404);
    expect(detailResult).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("never leaks unexpected database details", async () => {
    const controller = new ProjectsReadController({
      list: vi.fn().mockRejectedValue(new Error("SELECT secret FROM logs")),
      detail: vi.fn(),
    } as never);
    const response = responseFixture();
    const result = await controller.list(
      requestFixture("cookie") as never,
      response as never,
    );
    expect(response.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

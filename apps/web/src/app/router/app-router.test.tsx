import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { InpulseApiClient } from "@generated/api";
import { AppProviders } from "../providers/AppProviders";
import { AppErrorBoundary } from "../errors/AppErrorBoundary";
import { AppRouter } from "./AppRouter";

describe("AppRouter integration", () => {
  it("mounts AppRouter inside AppProviders and AppErrorBoundary", async () => {
    const authClient = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: 1,
        loginName: "developer",
        name: "开发者 C",
        email: null,
        avatarUrl: null,
        isAdmin: false,
        status: "ACTIVE",
      }),
    } as unknown as InpulseApiClient;

    render(
      <AppErrorBoundary>
        <AppProviders authClient={authClient}>
          <AppRouter />
        </AppProviders>
      </AppErrorBoundary>,
    );

    expect(
      screen.getByRole("img", { name: "Libiao Robotics | InPulse" }),
    ).toBeInTheDocument();
    // 默认路由的页面是懒加载 chunk：单文件跑时约 200ms 就能渲染，但在 `pnpm -r test:unit`
    // 并行起 85 个 jsdom worker 时曾超过 1s 默认窗口导致偶发红灯，这里只放宽等待窗口，断言不变。
    expect(
      await screen.findByRole(
        "heading",
        { name: "任务中心" },
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
  });

  it("redirects the merged project overview address to the project modules page", async () => {
    const authClient = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: 1,
        loginName: "developer",
        name: "开发者 C",
        email: null,
        avatarUrl: null,
        isAdmin: false,
        status: "ACTIVE",
      }),
    } as unknown as InpulseApiClient;

    // 项目概览已与「模块与功能」合并：旧地址不应再停留在 /overview。
    window.history.pushState({}, "", "/projects/7/overview");
    try {
      render(
        <AppErrorBoundary>
          <AppProviders authClient={authClient}>
            <AppRouter />
          </AppProviders>
        </AppErrorBoundary>,
      );

      await waitFor(() =>
        expect(window.location.pathname).toBe("/projects/7/modules"),
      );
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it.each([
    ["/projects/7/tasks", "/projects/7/task-board"],
    ["/projects/7/settings", "/projects/7/members"],
  ])("redirects the %s alias to %s", async (from: string, to: string) => {
    const authClient = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: 1,
        loginName: "developer",
        name: "开发者 C",
        email: null,
        avatarUrl: null,
        isAdmin: false,
        status: "ACTIVE",
      }),
    } as unknown as InpulseApiClient;

    // 手输 / 收藏里的旧地址此前直接 404（2026-10-16 实测），现在按分段重定向。
    window.history.pushState({}, "", from);
    try {
      render(
        <AppErrorBoundary>
          <AppProviders authClient={authClient}>
            <AppRouter />
          </AppProviders>
        </AppErrorBoundary>,
      );

      await waitFor(() => expect(window.location.pathname).toBe(to));
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("keeps the app shell and renders the branded 404 for unknown paths", async () => {
    const authClient = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: 1,
        loginName: "developer",
        name: "开发者 C",
        email: null,
        avatarUrl: null,
        isAdmin: false,
        status: "ACTIVE",
      }),
    } as unknown as InpulseApiClient;

    window.history.pushState({}, "", "/definitely-not-a-route");
    try {
      render(
        <AppErrorBoundary>
          <AppProviders authClient={authClient}>
            <AppRouter />
          </AppProviders>
        </AppErrorBoundary>,
      );

      expect(await screen.findByTestId("route-not-found")).toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "Libiao Robotics | InPulse" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Hey developer/u)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("lets a regular member open the settings page without the admin-only gate", async () => {
    const authClient = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: 9,
        loginName: "member",
        name: "林雨妍",
        email: null,
        avatarUrl: null,
        isAdmin: false,
        status: "ACTIVE",
      }),
    } as unknown as InpulseApiClient;

    // 页面内只读组织视图走生成客户端默认 fetch；这里只服务该请求。
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/organizations/me/members")) {
        return new Response(
          JSON.stringify({
            organizations: [
              {
                id: 7,
                name: "研发一组",
                source: "LOCAL",
                groupPath: null,
              },
            ],
            items: [
              {
                id: 9,
                name: "林雨妍",
                avatarUrl: null,
                isAdmin: false,
                organizationIds: [7],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          code: "NOT_FOUND",
          message: "Resource not found",
          details: {},
          requestId: "test",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    window.history.pushState({}, "", "/settings");
    try {
      render(
        <AppErrorBoundary>
          <AppProviders authClient={authClient}>
            <AppRouter />
          </AppProviders>
        </AppErrorBoundary>,
      );

      expect(
        await screen.findByRole(
          "heading",
          { name: "成员与角色", level: 3 },
          { timeout: 5_000 },
        ),
      ).toBeInTheDocument();
      expect((await screen.findAllByText(/研发一组/)).length).toBeGreaterThan(
        0,
      );
      expect(
        screen.queryByText("此区域仅限系统管理员访问。"),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
      vi.unstubAllGlobals();
    }
  });
});

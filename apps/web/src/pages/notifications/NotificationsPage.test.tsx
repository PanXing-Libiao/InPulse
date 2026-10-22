import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NotificationsPage from "./NotificationsPage";

vi.mock("@shared/routing/route-preload", () => ({
  preloadRoutePath: () => Promise.resolve(),
  routePreloadHandlers: () => ({}),
}));

vi.mock("@features/auth/auth-context", () => ({
  useAuth: () => ({ user: { id: 7, isAdmin: false } }),
}));

vi.mock("@features/notifications/NotificationsPageView", () => ({
  NotificationsPageView: (props: {
    readonly onOpenTarget?: (targetPath: string) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.onOpenTarget?.("/projects/1/modules/2/features/3?taskId=4")
        }
      >
        打开任务通知
      </button>
      <button
        type="button"
        onClick={() => props.onOpenTarget?.("/projects/1/activity")}
      >
        打开项目动态通知
      </button>
    </div>
  ),
}));

vi.mock("@features/project-overview/project-workspace-chunks", () => ({
  loadTaskDetailOverlay: () =>
    Promise.resolve({
      default: (props: {
        readonly target: { readonly taskId: number };
        readonly onClose: () => void;
      }) => (
        <div role="dialog" aria-label="任务详情">
          <span>{"任务 " + String(props.target.taskId)}</span>
          <button type="button" onClick={props.onClose}>
            关闭任务详情
          </button>
        </div>
      ),
    }),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
      {location.state === null ? "" : " · 有路由状态"}
    </span>
  );
}

function renderPage(
  entry:
    | string
    | {
        readonly pathname: string;
        readonly state?: unknown;
      } = "/notifications",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/notifications"
            element={
              <>
                <NotificationsPage />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/projects/1/activity"
            element={<div>项目动态内容</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationsPage", () => {
  it("任务通知就地打开详情，关闭后仍停留在通知汇总页", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "打开任务通知" }));

    expect(
      await screen.findByRole("dialog", { name: "任务详情" }),
    ).toBeInTheDocument();
    expect(screen.getByText("任务 4")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/notifications");
    expect(screen.getByTestId("location")).not.toHaveTextContent(
      "/projects/1/modules",
    );

    await user.click(screen.getByRole("button", { name: "关闭任务详情" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "任务详情" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/notifications");
  });

  it("非任务通知继续按原地址跳转", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "打开项目动态通知" }));

    expect(await screen.findByText("项目动态内容")).toBeInTheDocument();
  });

  it("消费铃铛带来的任务目标后清掉路由状态", async () => {
    renderPage({
      pathname: "/notifications",
      state: {
        notificationTaskPath: "/projects/1/modules/2/features/3?taskId=4",
      },
    });

    expect(
      await screen.findByRole("dialog", { name: "任务详情" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("location")).not.toHaveTextContent(
        "有路由状态",
      ),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/notifications");
  });
});

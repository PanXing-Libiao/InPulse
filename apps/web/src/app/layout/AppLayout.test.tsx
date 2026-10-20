import React from "react";
import { ConfigProvider } from "antd";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";
import {
  AuthStateProvider,
  type AuthContextValue,
  type AuthStatus,
} from "@features/auth/auth-context";
import { RequireAuth } from "../auth/auth-guard";
import {
  WECOM_BINDING_PROMPT_SESSION_KEY,
  WECOM_BINDING_PROMPT_STORAGE_KEY,
} from "@features/settings/wecom-binding-prompt";
import { AppLayout } from "./AppLayout";

function CurrentLocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
    </span>
  );
}

describe("AppLayout", () => {
  const notificationClient = {
    getNotificationUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 1 }),
    getNotifications: vi.fn().mockResolvedValue({
      items: [
        {
          id: "42",
          projectId: 7,
          notificationType: "PROJECT_JOINED",
          title: "你已加入成员项目",
          body: "成员项目通知",
          targetPath: "/projects/7/activity",
          createdAt: "2026-09-08T00:00:00.000Z",
          readAt: null,
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "csrf-1" }),
    readNotification: vi.fn().mockResolvedValue(undefined),
    getWecomBinding: vi.fn().mockResolvedValue({
      state: "BOUND",
      boundAt: "2026-10-13T02:00:00.000Z",
      codeExpiresAt: null,
      botProfileUrl: null,
      robotConfigured: true,
    }),
  } as unknown as InpulseApiClient;

  function renderLayout(
    ui: React.ReactElement,
    isAdmin = false,
    authValue: Partial<AuthContextValue> = {},
  ) {
    return render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <AuthStateProvider
            value={{
              status: "authenticated",
              user: {
                id: 1,
                loginName: "developer",
                name: "开发者 C",
                email: null,
                avatarUrl: null,
                isAdmin,
                status: "ACTIVE",
              },
              ...authValue,
            }}
          >
            {ui}
          </AuthStateProvider>
        </QueryClientProvider>
      </ConfigProvider>,
    );
  }

  it("renders the latest workspace navigation and sidebar search/notification shortcuts", async () => {
    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("img", { name: "Libiao Robotics | InPulse" }),
    ).toBeInTheDocument();
    // 首页与任务中心内容重复，已删除，侧栏不应再出现「首页」入口。
    expect(screen.queryByText("首页")).not.toBeInTheDocument();
    expect(screen.getByText("任务中心")).toBeInTheDocument();
    expect(screen.getByText("项目列表")).toBeInTheDocument();
    expect(screen.getByText("迭代记录")).toBeInTheDocument();
    expect(screen.getByText("遗留问题")).toBeInTheDocument();
    expect(screen.getByText("项目动态")).toBeInTheDocument();
    // 成员与设置对全体登录用户开放（普通成员只读），审计日志仍仅管理员可见。
    expect(screen.getByText("成员与设置")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开全局搜索" }),
    ).toBeInTheDocument();
    await screen.findByRole("button", { name: "通知" });
    expect(notificationClient.getNotificationUnreadCount).toHaveBeenCalled();
    // 通知与搜索已收敛到侧栏底部图标，导航列表不再重复入口。
    expect(screen.queryByText("站内通知")).not.toBeInTheDocument();
    expect(screen.queryByText("全局搜索")).not.toBeInTheDocument();
  });

  it("renders the administrator-only entries only for system administrators", async () => {
    const { unmount } = renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          />
        </Routes>
      </MemoryRouter>,
      true,
    );
    expect(screen.getByText("审计日志")).toBeInTheDocument();
    expect(screen.getByText("成员与设置")).toBeInTheDocument();
    unmount();

    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("审计日志")).not.toBeInTheDocument();
    expect(screen.getByText("成员与设置")).toBeInTheDocument();
  });

  it("renders the current project group and the task board entry on project routes", async () => {
    const projectClient = {
      listProjects: vi.fn().mockResolvedValue({
        items: [
          {
            id: 7,
            code: "AGV",
            name: "AGV 智能搬运平台",
            status: "ACTIVE",
          },
        ],
      }),
      getProject: vi.fn().mockResolvedValue({
        project: {
          id: 7,
          code: "AGV",
          name: "AGV 智能搬运平台",
          description: "面向工厂的智能搬运调度项目",
          status: "ACTIVE",
          rowVersion: 1,
          createdBy: 1,
          createdAt: "2026-09-08T00:00:00.000Z",
          updatedAt: "2026-09-08T00:00:00.000Z",
          memberCount: 4,
          stats: {
            activeModuleCount: 2,
            activeFeatureCount: 5,
            openTaskCount: 3,
            completedTaskCount: 1,
          },
        },
      }),
    } as unknown as InpulseApiClient;

    renderLayout(
      <MemoryRouter initialEntries={["/projects/7/task-board"]}>
        <Routes>
          <Route
            path="/"
            element={
              <AppLayout
                notificationClient={notificationClient}
                projectClient={projectClient}
              />
            }
          >
            <Route
              path="projects/:projectId/task-board"
              element={<div>任务看板内容</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "工作区导航" });
    expect(within(nav).getByText("当前项目")).toBeInTheDocument();
    // 项目子页收进目录树：任务看板是项目节点下的子页行。
    const board = await within(nav).findByRole("button", {
      name: "任务看板",
    });
    expect(board).toHaveClass("page-node");
    expect(board).toHaveAttribute("aria-current", "true");
    // 项目概览已与「模块与功能」合并：项目节点下不再有概览子页行。
    expect(within(nav).queryByRole("button", { name: "项目概览" })).toBeNull();
    expect(
      within(nav).getByRole("button", { name: "模块与功能" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("任务看板内容")).toBeInTheDocument();
  });

  it("expands the project list on the projects page and hides it outside project routes", async () => {
    const projectClient = {
      listProjects: vi.fn().mockResolvedValue({
        items: [
          { id: 7, code: "AGV", name: "AGV 智能搬运平台", status: "ACTIVE" },
          { id: 8, code: "K1235", name: "项目1", status: "ACTIVE" },
        ],
      }),
    } as unknown as InpulseApiClient;

    const { unmount } = renderLayout(
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route
            path="/"
            element={
              <AppLayout
                notificationClient={notificationClient}
                projectClient={projectClient}
              />
            }
          >
            <Route path="projects" element={<div>项目列表内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // 项目列表页直接展开项目树，不必先进某个项目才能切换。
    const nav = screen.getByRole("navigation", { name: "工作区导航" });
    expect(within(nav).getByText("项目")).toBeInTheDocument();
    expect(
      await within(nav).findByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toBeInTheDocument();
    unmount();

    // 项目路由之外（如任务中心）不渲染项目树。
    renderLayout(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          >
            <Route path="tasks" element={<div>任务中心内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("当前项目")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "任务看板" })).toBeNull();
  });

  it("navigates to a registered workspace route", async () => {
    const user = userEvent.setup();
    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          >
            <Route index element={<div>Home content</div>} />
            <Route path="projects" element={<div>Projects content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByText("项目列表"));
    expect(await screen.findByText("Projects content")).toBeInTheDocument();
  });

  it("opens the global command palette from the sidebar search button", async () => {
    const user = userEvent.setup();
    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          >
            <Route index element={<div>Home content</div>} />
            <Route
              path="notifications"
              element={<div>Notifications content</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "打开全局搜索" }));
    expect(
      screen.getByRole("dialog", { name: "全局搜索" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^打开通知中心/ }));
    expect(
      await screen.findByText("Notifications content"),
    ).toBeInTheDocument();
  });

  it("opens the notification popover and can open the full page", async () => {
    const user = userEvent.setup();
    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          >
            <Route index element={<div>Home content</div>} />
            <Route
              path="notifications"
              element={<div>Notifications content</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "通知" }));
    expect(await screen.findByText("你已加入成员项目")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看全部通知" }));
    expect(
      await screen.findByText("Notifications content"),
    ).toBeInTheDocument();
  });

  it("任务通知从铃铛进入通知汇总，不再直接跳进项目", async () => {
    const user = userEvent.setup();
    const taskNotificationClient = {
      ...notificationClient,
      getNotificationUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 1 }),
      getNotifications: vi.fn().mockResolvedValue({
        items: [
          {
            id: "91",
            projectId: 1,
            notificationType: "task.assigned",
            title: "任务指派：电池巡检",
            body: "T-91",
            targetPath: "/projects/1/modules/2/features/3?taskId=4",
            createdAt: "2026-10-20T00:00:00.000Z",
            readAt: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as InpulseApiClient;

    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={taskNotificationClient} />}
          >
            <Route index element={<div>Home content</div>} />
            <Route
              path="notifications"
              element={<div>Notifications content</div>}
            />
            <Route
              path="projects/1/modules/2/features/3"
              element={<div>Project content</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "通知" }));
    await user.click(
      await screen.findByRole("button", {
        name: "打开通知：任务指派：电池巡检",
      }),
    );

    expect(
      await screen.findByText("Notifications content"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Project content")).not.toBeInTheDocument();
  });

  it("renders sidebar counters from the read-only aggregate ports", async () => {
    const counterClient = {
      ...notificationClient,
      listMyTasks: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
        stats: {
          todayTodo: 0,
          todayTodoBreakdown: {
            overdue: 0,
            leftover: 0,
            urgent: 0,
            dueWithinDays: 0,
          },
          myOpen: 7,
          completed: 0,
          created: 0,
        },
      }),
      listLeftoverItems: vi.fn().mockResolvedValue({
        items: [{ id: 1 }, { id: 2 }, { id: 3 }],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as InpulseApiClient;

    renderLayout(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout projectClient={counterClient} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    // 计数用 aria-hidden 的 <em> 渲染，不参与导航按钮的可访问名。
    const tasks = await screen.findByRole("button", { name: "任务中心" });
    expect(await within(tasks).findByTitle("7 项待处理")).toHaveTextContent(
      "7",
    );
    const issues = screen.getByRole("button", { name: "遗留问题" });
    expect(within(issues).getByTitle("3 项待处理")).toHaveTextContent("3");
  });

  it("renders the system directory tree inside the projects navigation item", async () => {
    const catalogClient = {
      ...notificationClient,
      listProjects: vi.fn().mockResolvedValue({
        items: [
          {
            id: 7,
            code: "AGV",
            name: "AGV 智能搬运平台",
            status: "ACTIVE",
          },
        ],
      }),
      getProject: vi.fn().mockResolvedValue({
        project: {
          id: 7,
          code: "AGV",
          name: "AGV 智能搬运平台",
          description: "面向工厂的智能搬运调度项目",
          status: "ACTIVE",
          rowVersion: 1,
          createdBy: 1,
          createdAt: "2026-09-08T00:00:00.000Z",
          updatedAt: "2026-09-08T00:00:00.000Z",
          memberCount: 4,
          stats: {
            activeModuleCount: 1,
            activeFeatureCount: 1,
            openTaskCount: 1,
            completedTaskCount: 1,
          },
        },
      }),
      listModules: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 3, name: "调度模块" }] }),
      listFeatures: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 5, name: "车辆调度" }] }),
    } as unknown as InpulseApiClient;

    renderLayout(
      <MemoryRouter initialEntries={["/projects/7/modules"]}>
        <Routes>
          <Route
            path="/"
            element={
              <AppLayout
                notificationClient={notificationClient}
                projectClient={catalogClient}
              />
            }
          >
            <Route
              path="projects/:projectId/modules"
              element={<div>项目主页内容</div>}
            />
            <Route
              path="projects/:projectId/modules/:moduleId/features"
              element={<div>功能目录内容</div>}
            />
            <Route
              path="projects/:projectId/modules/:moduleId/features/:featureId"
              element={<div>功能档案内容</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // 系统目录嵌在「项目与功能」导航项下，不再单独成块；项目路由自动展开。
    const nav = screen.getByRole("navigation", { name: "工作区导航" });
    expect(within(nav).getByText("任务中心")).toBeInTheDocument();
    expect(within(nav).queryByText("系统目录", { selector: "p" })).toBeNull();
    expect(
      await within(nav).findByRole("button", { name: /AGV 智能搬运平台/ }),
    ).toBeInTheDocument();
    expect(
      await within(nav).findByRole("button", { name: /调度模块/ }),
    ).toBeInTheDocument();
    // 目录只是导航，项目主页本身仍然完整渲染。
    expect(screen.getByText("项目主页内容")).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole("button", { name: /调度模块/ }),
    );
    expect(await screen.findByText("功能目录内容")).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: /车辆调度/ }),
    );
    expect(await screen.findByText("功能档案内容")).toBeInTheDocument();
  });

  it("hides the project tree outside project pages", async () => {
    renderLayout(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route
            path="/"
            element={<AppLayout notificationClient={notificationClient} />}
          >
            <Route path="tasks" element={<div>任务中心内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("任务中心内容")).toBeInTheDocument();
    // 目录树只存在于「当前项目」分组：非项目路由不渲染项目上下文。
    expect(document.querySelector(".project-tree")).toBeNull();
    expect(screen.queryByText("当前项目")).not.toBeInTheDocument();
  });
  describe("企业微信绑定提醒（ADR-079）", () => {
    function unboundClient(): {
      readonly client: InpulseApiClient;
      readonly getWecomBinding: ReturnType<typeof vi.fn>;
    } {
      const getWecomBinding = vi.fn().mockResolvedValue({
        state: "UNBOUND",
        boundAt: null,
        codeExpiresAt: null,
        botProfileUrl: null,
        robotConfigured: true,
      });
      return {
        client: {
          ...notificationClient,
          getWecomBinding,
        } as unknown as InpulseApiClient,
        getWecomBinding,
      };
    }

    /** 断言提醒弹窗已关闭：antd 关闭后保留隐藏 DOM，按可见性判断。 */
    async function expectPromptClosed(): Promise<void> {
      await waitFor(() => {
        const title = screen.queryByText("绑定企业微信，及时收到任务提醒");
        if (title !== null) {
          expect(title).not.toBeVisible();
        }
      });
    }

    it("未绑定且机器人已配置时弹出提醒，点击「去绑定」打开绑定弹窗", async () => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      const user = userEvent.setup();
      const { client } = unboundClient();
      renderLayout(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={<AppLayout notificationClient={client} />}
            />
          </Routes>
        </MemoryRouter>,
      );

      expect(
        await screen.findByText("绑定企业微信，及时收到任务提醒"),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "去绑定" }));

      // 提醒弹窗关闭后打开账户菜单里的绑定弹窗（同一 WecomBindingModal）。
      await expectPromptClosed();
      expect(
        await screen.findByText("绑定后即可在手机上收到提醒"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "生成绑定码" }),
      ).toBeInTheDocument();
      expect(
        JSON.parse(
          window.sessionStorage.getItem(WECOM_BINDING_PROMPT_SESSION_KEY) ??
            "[]",
        ),
      ).toEqual([1]);
    });

    it("选择「不再提醒」后按账号持久记录，重新挂载不再弹也不请求", async () => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      const user = userEvent.setup();
      const { client } = unboundClient();
      const view = renderLayout(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={<AppLayout notificationClient={client} />}
            />
          </Routes>
        </MemoryRouter>,
      );

      await screen.findByText("绑定企业微信，及时收到任务提醒");
      await user.click(screen.getByRole("button", { name: "不再提醒" }));
      await expectPromptClosed();
      expect(
        JSON.parse(
          window.localStorage.getItem(WECOM_BINDING_PROMPT_STORAGE_KEY) ?? "[]",
        ),
      ).toEqual([1]);

      // 重新挂载（模拟刷新）：持久关闭后不再弹、也不再请求绑定状态。
      view.unmount();
      const { client: remountClient, getWecomBinding } = unboundClient();
      renderLayout(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={<AppLayout notificationClient={remountClient} />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getWecomBinding).not.toHaveBeenCalled();
      expect(
        screen.queryByText("绑定企业微信，及时收到任务提醒"),
      ).not.toBeInTheDocument();
    });
  });

  describe("退出登录", () => {
    it("退出登录后回到登录页而不是直接跳转统一身份认证", async () => {
      const user = userEvent.setup();
      const logout = vi.fn().mockResolvedValue(undefined);
      renderLayout(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={<AppLayout notificationClient={notificationClient} />}
            />
            <Route path="/login" element={<div>登录页占位</div>} />
          </Routes>
        </MemoryRouter>,
        false,
        { logout },
      );

      await user.click(screen.getByRole("button", { name: "账户菜单" }));
      await user.click(screen.getByRole("button", { name: /退出登录/ }));

      await waitFor(() => {
        expect(logout).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByText("登录页占位")).toBeInTheDocument();
    });

    it("退出登录先卸载受保护页面，登录地址不带 from，换号后回到默认入口", async () => {
      const user = userEvent.setup();
      let resolveLogout: () => void = () => {};
      const logout = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveLogout = resolve;
          }),
      );

      const Harness: React.FC = () => {
        const [status, setStatus] = React.useState<AuthStatus>("authenticated");
        const value = React.useMemo<AuthContextValue>(
          () => ({
            status,
            user: {
              id: 1,
              loginName: "developer",
              name: "开发者 C",
              email: null,
              avatarUrl: null,
              isAdmin: false,
              status: "ACTIVE",
            },
            errorMessage: null,
            login: async () => ({ kind: "cancelled" }),
            logout: async () => {
              await logout();
              setStatus("anonymous");
            },
            refresh: async () => {},
          }),
          [status],
        );
        return (
          <AuthStateProvider value={value}>
            <MemoryRouter initialEntries={["/projects/7"]}>
              <CurrentLocationProbe />
              <Routes>
                <Route
                  path="/"
                  element={
                    <AppLayout notificationClient={notificationClient} />
                  }
                >
                  <Route
                    path="projects/7"
                    element={
                      <RequireAuth>
                        <div>受保护页面内容</div>
                      </RequireAuth>
                    }
                  />
                  <Route path="login" element={<div>登录页占位</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </AuthStateProvider>
        );
      };

      render(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <Harness />
        </QueryClientProvider>,
      );

      expect(await screen.findByText("受保护页面内容")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "账户菜单" }));
      await user.click(screen.getByRole("button", { name: /退出登录/ }));

      // 退出请求挂起期间：受保护子树必须整体卸载，RequireAuth 不能在
      // 认证态收敛为匿名的瞬间把当前地址写进 /login?from=...
      await waitFor(() => {
        expect(screen.queryByText("受保护页面内容")).toBeNull();
      });
      expect(screen.getByTestId("logout-pending")).toBeInTheDocument();

      resolveLogout();

      expect(await screen.findByText("登录页占位")).toBeInTheDocument();
      expect(screen.getByTestId("location")).toHaveTextContent("/login");
      expect(screen.getByTestId("location")).not.toHaveTextContent("from=");
    });

    it("未登录时点击前往登录回到登录页", async () => {
      const user = userEvent.setup();
      renderLayout(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={<AppLayout notificationClient={notificationClient} />}
            />
            <Route path="/login" element={<div>登录页占位</div>} />
          </Routes>
        </MemoryRouter>,
        false,
        { status: "anonymous", user: null },
      );

      await user.click(screen.getByRole("button", { name: "账户菜单" }));
      await user.click(screen.getByRole("button", { name: /前往登录/ }));

      expect(await screen.findByText("登录页占位")).toBeInTheDocument();
    });

    it("非管理员账户菜单不显示成员与权限入口", async () => {
      const user = userEvent.setup();
      renderLayout(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={<AppLayout notificationClient={notificationClient} />}
            />
          </Routes>
        </MemoryRouter>,
      );

      await user.click(screen.getByRole("button", { name: "账户菜单" }));
      expect(
        screen.queryByRole("button", { name: /成员与权限/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /退出登录/ }),
      ).toBeInTheDocument();
    });
  });
});

import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { CreateProjectResponse, InpulseApiClient } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ProjectsPage } from "./ProjectsPage";

const createdProject: CreateProjectResponse = {
  project: {
    id: 7,
    code: "SHOP",
    name: "商城系统",
    description: "商城项目描述",
    status: "NOT_STARTED",
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  },
  members: [
    {
      userId: 1,
      status: "ACTIVE",
      role: "LEADER",
      joinedAt: "2026-09-09T00:00:00.000Z",
    },
  ],
};

function ModulesLandingProbe() {
  const location = useLocation();
  return (
    <div data-testid="modules-landing">{JSON.stringify(location.state)}</div>
  );
}

describe("ProjectsPage", () => {
  it("creates a project and navigates to its activity page", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false }],
    });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const listProjects = vi.fn().mockResolvedValue({
      items: [
        {
          ...createdProject.project,
          memberCount: 1,
          stats: {
            activeModuleCount: 2,
            openTaskCount: 3,
            completedTaskCount: 1,
          },
        },
      ],
    });
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
      listProjects,
    } as unknown as InpulseApiClient;

    render(
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
              isAdmin: true,
              status: "ACTIVE",
            },
          }}
        >
          <MemoryRouter initialEntries={["/projects"]}>
            <Routes>
              <Route
                path="/projects"
                element={<ProjectsPage client={client} />}
              />
              <Route
                path="/projects/:projectId/activity"
                element={<div>Activity content</div>}
              />
              <Route
                path="/projects/:projectId/members"
                element={<div>Member content</div>}
              />
              <Route path="/search" element={<div>Search content</div>} />
            </Routes>
          </MemoryRouter>
        </AuthStateProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
    const projectName = await screen.findByText("商城系统");
    expect(projectName).toBeInTheDocument();
    expect(projectName.closest(".project-card")).toHaveTextContent("1 位成员");
    // 卡片整块可点击进入模块，不再渲染「查看模块」入口（已按用户要求移除）。
    expect(projectName.closest(".project-card")).toHaveTextContent(
      "商城项目描述",
    );
    expect(projectName.closest(".project-card")).not.toHaveTextContent(
      "查看模块",
    );
    expect(screen.getByText("层级说明")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /管\s*理\s*成\s*员/ }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("create-project-button"));

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    fireEvent.change(within(dialog).getByLabelText("项目名称"), {
      target: { value: "商城系统" },
    });
    fireEvent.change(within(dialog).getByLabelText("项目编码"), {
      target: { value: "shop" },
    });
    fireEvent.change(within(dialog).getByLabelText("项目描述"), {
      target: { value: "商城项目描述" },
    });
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("项目创建成功")).toBeInTheDocument();
    await user.click(screen.getByTestId("open-created-project-activity"));
    expect(await screen.findByText("Activity content")).toBeInTheDocument();
  }, 15_000);

  it("clears the previous success card when the create form is reopened", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false }],
    });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const listProjects = vi.fn().mockResolvedValue({ items: [] });
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
      listProjects,
    } as unknown as InpulseApiClient;

    render(
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
              isAdmin: true,
              status: "ACTIVE",
            },
          }}
        >
          <MemoryRouter initialEntries={["/projects"]}>
            <Routes>
              <Route
                path="/projects"
                element={<ProjectsPage client={client} />}
              />
            </Routes>
          </MemoryRouter>
        </AuthStateProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    await user.click(screen.getByTestId("create-project-button"));
    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    fireEvent.change(within(dialog).getByLabelText("项目名称"), {
      target: { value: "商城系统" },
    });
    fireEvent.change(within(dialog).getByLabelText("项目编码"), {
      target: { value: "shop" },
    });
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("项目创建成功")).toBeInTheDocument();

    // 再次打开「新建项目」：上一次的成功卡片不应继续留在页面上。
    // 这里不显式点「取消」——AppModal 在 jsdom 里没有过渡帧，关闭后节点仍留在 DOM，
    // 断言「弹窗消失」会误报；直接断言用户真正看到的东西：旧成功卡片被清掉。
    await user.click(screen.getByTestId("create-project-button"));

    await waitFor(() =>
      expect(screen.queryByText("项目创建成功")).not.toBeInTheDocument(),
    );
  }, 15_000);

  it("opens the admin member management page from a project card", async () => {
    const listProjects = vi.fn().mockResolvedValue({
      items: [
        {
          ...createdProject.project,
          memberCount: 1,
          stats: {
            activeModuleCount: 2,
            openTaskCount: 3,
            completedTaskCount: 1,
          },
        },
      ],
    });
    const client = {
      getUserDirectory: vi.fn().mockResolvedValue({ items: [] }),
      listProjects,
    } as unknown as InpulseApiClient;

    render(
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
              isAdmin: true,
              status: "ACTIVE",
            },
          }}
        >
          <MemoryRouter initialEntries={["/projects"]}>
            <Routes>
              <Route
                path="/projects"
                element={<ProjectsPage client={client} />}
              />
              <Route
                path="/projects/:projectId/members"
                element={<div>Member content</div>}
              />
            </Routes>
          </MemoryRouter>
        </AuthStateProvider>
      </QueryClientProvider>,
    );

    const projectName = await screen.findByText("商城系统");
    const projectCard = projectName.closest(".project-card");
    expect(projectCard).not.toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /管\s*理\s*成\s*员/ }));
    expect(await screen.findByText("Member content")).toBeInTheDocument();
  });

  it("创建成功后「添加模块」带着一次性信号进入模块页", async () => {
    const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
    const getUserDirectory = vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "开发者 C", avatarUrl: null, isAdmin: false }],
    });
    const createProject = vi.fn().mockResolvedValue(createdProject);
    const listProjects = vi.fn().mockResolvedValue({ items: [] });
    const client = {
      issueCsrfToken,
      getUserDirectory,
      createProject,
      listProjects,
    } as unknown as InpulseApiClient;

    render(
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
              isAdmin: true,
              status: "ACTIVE",
            },
          }}
        >
          <MemoryRouter initialEntries={["/projects"]}>
            <Routes>
              <Route
                path="/projects"
                element={<ProjectsPage client={client} />}
              />
              <Route
                path="/projects/:projectId/modules"
                element={<ModulesLandingProbe />}
              />
            </Routes>
          </MemoryRouter>
        </AuthStateProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    await user.click(screen.getByTestId("create-project-button"));
    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    fireEvent.change(within(dialog).getByLabelText("项目名称"), {
      target: { value: "商城系统" },
    });
    fireEvent.change(within(dialog).getByLabelText("项目编码"), {
      target: { value: "shop" },
    });
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    await screen.findByText("项目创建成功");
    await user.click(screen.getByTestId("add-module-after-create"));
    const probe = await screen.findByTestId("modules-landing");
    expect(JSON.parse(probe.textContent ?? "null")).toEqual({
      createModule: true,
    });
  }, 15_000);
});

import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InpulseApiClient, ProjectListItem } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ProjectTierProvider } from "@features/common/project-tier-context";
import { ProjectTree } from "@features/project-tree/ProjectTree";
import { ProjectsPageView } from "./ProjectsPageView";

/**
 * 分档是**共享状态**：项目列表页的滑块切档后，侧栏项目树必须立刻换成本档项目
 * （2026-10-09 用户指示：点进项目列表默认看未完成项目，侧栏也只列未进入维护中
 * 的项目；切到维护中后侧栏改列维护中项目）。两处若各存一份 useState，这条
 * 同步关系就会断，因此这里把两个组件挂在同一个 Provider 下做端到端断言。
 */
const baseProject = {
  description: "",
  hasCompletedTask: false,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 1,
  stats: {
    activeModuleCount: 0,
    activeFeatureCount: 0,
    openTaskCount: 0,
    completedTaskCount: 0,
  },
  currentUserRole: "MEMBER" as const,
};

const openProject: ProjectListItem = {
  id: 2,
  code: "INPULSE",
  name: "进行中平台",
  status: "ACTIVE",
  ...baseProject,
};

const maintenanceProject: ProjectListItem = {
  id: 12,
  code: "OLD",
  name: "老平台维护",
  status: "MAINTENANCE",
  ...baseProject,
};

const secondOpenProject: ProjectListItem = {
  ...openProject,
  id: 22,
  code: "SECOND",
  name: "乙项目",
};

const thirdOpenProject: ProjectListItem = {
  ...openProject,
  id: 23,
  code: "THIRD",
  name: "丙项目",
};

describe("项目分档与侧栏项目树", () => {
  it("keeps the sidebar project tree on the same tier as the list slider", async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ items: [openProject, maintenanceProject] }),
      listModules: vi.fn().mockResolvedValue({ items: [] }),
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;

    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter>
            <AuthStateProvider>
              <ProjectTierProvider>
                <ProjectsPageView
                  creatorName="特哥"
                  projects={[openProject, maintenanceProject]}
                  client={client}
                />
                <ProjectTree
                  activeScope={null}
                  onNavigate={vi.fn()}
                  client={client}
                />
              </ProjectTierProvider>
            </AuthStateProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ConfigProvider>,
    );

    const tree = document.querySelector(".project-tree") as HTMLElement;
    expect(tree).toBeTruthy();
    // 默认档「未完成」：侧栏只列进行中项目，维护中项目不上树。
    expect(
      await within(tree).findByRole("button", { name: /进行中平台/ }),
    ).toBeTruthy();
    expect(
      within(tree).queryByRole("button", { name: /老平台维护/ }),
    ).toBeNull();

    // 点列表页滑块切到「维护中」：侧栏立刻改列维护中项目。
    fireEvent.click(
      within(screen.getByRole("group", { name: "项目生命周期分档" })).getByRole(
        "button",
        { name: /维护中/ },
      ),
    );
    expect(
      await within(tree).findByRole("button", { name: /老平台维护/ }),
    ).toBeTruthy();
    expect(
      within(tree).queryByRole("button", { name: /进行中平台/ }),
    ).toBeNull();
  });
});

describe("项目星标与侧栏项目树同步", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("星标置顶规则同时作用于项目卡片与侧栏，并在点星后立即同步", async () => {
    const projects = [openProject, secondOpenProject, thirdOpenProject];
    const client = {
      listProjects: vi.fn().mockResolvedValue({ items: projects }),
      listModules: vi.fn().mockResolvedValue({ items: [] }),
      listFeatures: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as InpulseApiClient;
    globalThis.localStorage.setItem("inpulse.projects.starred.7", "[23]");

    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter>
            <AuthStateProvider
              value={{
                status: "authenticated",
                user: {
                  id: 7,
                  loginName: "viewer",
                  name: "查看者",
                  email: null,
                  avatarUrl: null,
                  isAdmin: false,
                  status: "ACTIVE",
                },
              }}
            >
              <ProjectTierProvider>
                <ProjectsPageView
                  creatorName="特哥"
                  projects={projects}
                  client={client}
                />
                <ProjectTree
                  activeScope={null}
                  onNavigate={vi.fn()}
                  client={client}
                />
              </ProjectTierProvider>
            </AuthStateProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ConfigProvider>,
    );

    const tree = document.querySelector(".project-tree") as HTMLElement;
    await within(tree).findByRole("button", { name: /丙项目/ });
    const treeOrder = () =>
      Array.from(
        tree.querySelectorAll<HTMLButtonElement>("button.project-node"),
      ).map((button) => button.getAttribute("title"));
    const cardOrder = () =>
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent);

    expect(treeOrder()).toEqual(["丙项目", "进行中平台", "乙项目"]);
    expect(cardOrder()).toEqual(["丙项目", "进行中平台", "乙项目"]);

    fireEvent.click(screen.getByTestId("star-project-22"));
    expect(treeOrder()).toEqual(["乙项目", "丙项目", "进行中平台"]);
    expect(cardOrder()).toEqual(["乙项目", "丙项目", "进行中平台"]);

    fireEvent.click(screen.getByTestId("star-project-23"));
    expect(treeOrder()).toEqual(["乙项目", "进行中平台", "丙项目"]);
    expect(cardOrder()).toEqual(["乙项目", "进行中平台", "丙项目"]);
  });
});

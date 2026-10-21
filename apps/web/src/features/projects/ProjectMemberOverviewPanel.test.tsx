import React from "react";
import { ConfigProvider } from "antd";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type ActiveProjectMemberItem,
  type InpulseApiClient,
  type ProjectListItem,
  type TaskBoardResponse,
} from "@generated/api";
import { ProjectMemberOverviewPanel } from "./ProjectMemberOverviewPanel";

const projectA: ProjectListItem = {
  id: 7,
  code: "INPULSE",
  name: "InPulse 研发交付平台",
  description: "研发交付平台",
  status: "ACTIVE",
  hasCompletedTask: true,
  rowVersion: 3,
  createdBy: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 2,
    activeFeatureCount: 5,
    openTaskCount: 7,
    completedTaskCount: 4,
  },
  currentUserRole: "MEMBER",
};

const projectB: ProjectListItem = {
  ...projectA,
  id: 8,
  code: "WMS",
  name: "WMS 仓储管理",
  description: "仓储管理",
  status: "MAINTENANCE",
  memberCount: 1,
  stats: {
    activeModuleCount: 1,
    activeFeatureCount: 2,
    openTaskCount: 0,
    completedTaskCount: 8,
  },
};

const membersA: readonly ActiveProjectMemberItem[] = [
  {
    id: 2,
    name: "开发者 C",
    avatarUrl: null,
    role: "LEADER",
    joinedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: 5,
    name: "小邵",
    avatarUrl: null,
    role: "MEMBER",
    joinedAt: "2026-09-05T08:00:00.000Z",
  },
];

const membersB: readonly ActiveProjectMemberItem[] = [
  {
    id: 9,
    name: "仓储组长",
    avatarUrl: null,
    role: "LEADER",
    joinedAt: "2026-09-08T00:00:00.000Z",
  },
];

function taskBoard(
  projectId: number,
  name: string,
  taskCount: number,
): TaskBoardResponse {
  return {
    project: { projectId, name, status: "ACTIVE" },
    generatedAt: "2026-10-21T00:00:00.000Z",
    stats: {
      total: taskCount,
      done: 0,
      open: taskCount,
      canceled: 0,
      overdue: 0,
      dueToday: 0,
      completedThisWeek: 0,
      completionRate: 0,
      featureCount: 1,
      memberCount: 1,
    },
    modules: [
      {
        moduleId: 1,
        name: "默认模块",
        featureCount: 1,
        stats: {
          total: taskCount,
          done: 0,
          open: taskCount,
          canceled: 0,
          overdue: 0,
          completionRate: 0,
        },
        assignees: [],
        tasks: Array.from({ length: taskCount }, (_value, index) => ({
          taskId: projectId * 100 + index,
          code: name + "-" + String(index + 1),
          title: "待办任务 " + String(index + 1),
          moduleId: 1,
          featureId: 10,
          featureName: "默认功能",
          scopeType: "FEATURE",
          priority: "NORMAL",
          workStatus: "TODO",
          dueAt: null,
          completedAt: null,
          dueState: "NONE",
          assignees:
            projectId === 7
              ? [
                  { userId: 2, name: "开发者 C", avatarUrl: null },
                  { userId: 5, name: "小邵", avatarUrl: null },
                ]
              : [{ userId: 9, name: "仓储组长", avatarUrl: null }],
          publishedRecordCount: 0,
        })),
      },
    ],
    truncated: false,
  };
}

const wecomStatus = {
  state: "BOUND",
  codeExpiresAt: null,
  boundAt: "2026-10-01T00:00:00.000Z",
  boundByName: "开发者 C",
  lastDeliveryError: null,
  botProfileUrl: null,
  notificationOptions: { disabledCategories: [] },
} as const;

function createClient(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue({ items: [projectA, projectB] }),
    listActiveProjectMembers: vi
      .fn()
      .mockImplementation((projectId: number) =>
        Promise.resolve({ items: projectId === 7 ? membersA : membersB }),
      ),
    getProjectTaskBoard: vi
      .fn()
      .mockImplementation((projectId: number) =>
        Promise.resolve(
          projectId === 7 ? taskBoard(7, "INPULSE", 2) : taskBoard(8, "WMS", 1),
        ),
      ),
    getProjectWecomGroup: vi.fn().mockResolvedValue(wecomStatus),
    ...overrides,
  } as unknown as InpulseApiClient;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function mount(client: InpulseApiClient) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/settings"]}>
          <LocationProbe />
          <ProjectMemberOverviewPanel client={client} />
        </MemoryRouter>
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

async function waitForMember(name: string): Promise<void> {
  await waitFor(() => {
    const names = Array.from(
      document.querySelectorAll(".project-member-person strong"),
    ).map((element) => element.textContent);
    expect(names).toContain(name);
  });
}

function projectSummary(name: string): HTMLElement {
  const summary = screen.getByText(name).closest(".project-member-summary");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("project summary not found: " + name);
  }
  return summary;
}

describe("ProjectMemberOverviewPanel", () => {
  it("默认展开第一个项目，点击项目行不会离开设置页", async () => {
    mount(createClient());

    await waitForMember("开发者 C");
    expect(projectSummary(projectA.name)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
  });

  it("再次点击项目行会原地收起成员", async () => {
    mount(createClient());
    await waitForMember("开发者 C");

    fireEvent.click(projectSummary(projectA.name));

    expect(projectSummary(projectA.name)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("开发者 C")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
  });

  it("同时只展开一个项目", async () => {
    mount(createClient());
    await waitForMember("开发者 C");

    fireEvent.click(projectSummary(projectB.name));

    await waitForMember("仓储组长");
    expect(projectSummary(projectA.name)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(projectSummary(projectB.name)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("开发者 C")).not.toBeInTheDocument();
  });

  it("管理成员进入项目页，且不会触发项目展开或收起", async () => {
    mount(createClient());
    await waitForMember("开发者 C");

    const wms = projectSummary(projectB.name);
    fireEvent.click(
      within(wms).getByRole("button", { name: "管理成员：WMS 仓储管理" }),
    );

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/projects/8/members",
    );
    expect(projectSummary(projectB.name)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("成员区是只读的：没有成员搜索、添加或行内管理", async () => {
    mount(createClient());
    await waitForMember("开发者 C");
    const region = screen.getByRole("region", {
      name: "InPulse 研发交付平台 项目成员",
    });

    expect(within(region).queryByLabelText("搜索成员")).not.toBeInTheDocument();
    expect(
      within(region).queryByRole("button", { name: /添加成员/ }),
    ).not.toBeInTheDocument();
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
    expect(within(region).queryByText(/^管理$/)).not.toBeInTheDocument();
  });

  it("键盘 Enter 可以展开项目", async () => {
    mount(createClient());
    await waitForMember("开发者 C");
    fireEvent.click(projectSummary(projectA.name));

    fireEvent.keyDown(projectSummary(projectA.name), { key: "Enter" });

    expect(projectSummary(projectA.name)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitForMember("开发者 C");
  });

  it("支持按项目名称或代码搜索，并按状态筛选", async () => {
    mount(createClient());
    await waitForMember("开发者 C");

    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "WMS" },
    });
    expect(screen.queryByText(projectA.name)).not.toBeInTheDocument();
    expect(screen.getByText(projectB.name)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "" },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "项目状态筛选" })).getByRole(
        "button",
        { name: "维护中" },
      ),
    );
    expect(screen.queryByText(projectA.name)).not.toBeInTheDocument();
    expect(screen.getByText(projectB.name)).toBeInTheDocument();
  });

  it("没有可访问项目时显示空态", async () => {
    mount(
      createClient({
        listProjects: vi.fn().mockResolvedValue({ items: [] }),
      }),
    );

    expect(await screen.findByText("暂无可访问的项目")).toBeInTheDocument();
  });

  it("项目列表加载失败时提供重试", async () => {
    mount(
      createClient({
        listProjects: vi.fn().mockRejectedValue(
          new ApiError(500, {
            code: "UNEXPECTED_ERROR",
            details: {},
            requestId: "req-projects",
          }),
        ),
      }),
    );

    expect(await screen.findByText("项目列表加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重\s*试/ })).toBeInTheDocument();
  });

  it("成员加载失败时保留项目展开区并提供重试", async () => {
    mount(
      createClient({
        listActiveProjectMembers: vi.fn().mockRejectedValue(
          new ApiError(500, {
            code: "UNEXPECTED_ERROR",
            details: {},
            requestId: "req-members",
          }),
        ),
      }),
    );

    expect(await screen.findByText("项目成员加载失败")).toBeInTheDocument();
    expect(projectSummary(projectA.name)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: /重\s*试/ })).toBeInTheDocument();
  });
});

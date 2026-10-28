import { MemoryRouter } from "react-router-dom";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectItem } from "@generated/api";
import { ProjectOverviewPageView } from "./ProjectOverviewPageView";
import type {
  ProjectOverviewAdapter,
  ProjectOverviewResult,
} from "./project-overview-types";
import type { ProjectSetupGuideInput } from "./ProjectSetupGuide";

const project: ProjectItem = {
  id: 1,
  code: "INP",
  name: "InPulse 平台",
  description: "平台项目描述",
  status: "ACTIVE",
  hasCompletedTask: false,
  rowVersion: 2,
  createdBy: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  memberCount: 3,
  stats: {
    activeModuleCount: 4,
    activeFeatureCount: 11,
    openTaskCount: 6,
    completedTaskCount: 1,
  },
};

const overviewResult: ProjectOverviewResult = {
  stats: {
    activeModules: 4,
    activeFeatures: 11,
    openTasks: 6,
    publishedRecords: 9,
    openLeftovers: 1,
  },
  recentIterations: [
    {
      recordId: 301,
      code: "R-301",
      title: "迭代一",
      featureName: "任务中心",
      publishedAt: "2026-09-09T08:00:00.000Z",
    },
    {
      recordId: 302,
      code: "R-302",
      title: "迭代二",
      featureName: null,
      publishedAt: "2026-09-06T08:00:00.000Z",
    },
  ],
  leftovers: [
    {
      leftoverId: 21,
      summary: "遗留一",
      recordCode: "R-021",
      recordTitle: "登录安全复核",
    },
  ],
};

const createAdapter = (
  result: ProjectOverviewResult = overviewResult,
): ProjectOverviewAdapter & {
  fetchProjectOverview: ReturnType<typeof vi.fn>;
} => ({
  source: "mock",
  notice: "测试项目概览骨架",
  fetchProjectOverview: vi.fn().mockResolvedValue(result),
});

interface RenderOverrides {
  readonly adapter?: ProjectOverviewAdapter;
  readonly project?: ProjectItem | null;
  readonly projectError?: string;
  readonly setupGuide?: ProjectSetupGuideInput;
}

const renderView = (overrides: RenderOverrides = {}) => {
  const handlers = {
    onRetryProject: vi.fn(),
    onOpenModules: vi.fn(),
    onOpenMembers: vi.fn(),
    onOpenWecom: vi.fn(),
    onOpenRecords: vi.fn(),
    onOpenRecord: vi.fn(),
    onOpenIssues: vi.fn(),
  };
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <ProjectOverviewPageView
          projectId={1}
          project={
            overrides.project === undefined ? project : overrides.project
          }
          projectLoading={false}
          onRetryProject={handlers.onRetryProject}
          onOpenModules={handlers.onOpenModules}
          onOpenMembers={handlers.onOpenMembers}
          onOpenWecom={handlers.onOpenWecom}
          onOpenRecords={handlers.onOpenRecords}
          onOpenRecord={handlers.onOpenRecord}
          onOpenIssues={handlers.onOpenIssues}
          adapter={overrides.adapter ?? createAdapter()}
          {...(overrides.projectError === undefined
            ? {}
            : { projectError: overrides.projectError })}
          {...(overrides.setupGuide === undefined
            ? {}
            : { setupGuide: overrides.setupGuide })}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return handlers;
};

describe("ProjectOverviewPageView", () => {
  it("renders the project identity from the injected project port", async () => {
    renderView();

    expect(screen.getByText("InPulse 平台")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    await screen.findByTestId("overview-metric-members");
    expect(
      within(screen.getByTestId("overview-metric-members")).getByText("3"),
    ).toBeInTheDocument();
  });

  it("opens the WeCom project group workspace from the header icon", async () => {
    const handlers = renderView();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "消息通知" }));
    expect(handlers.onOpenWecom).toHaveBeenCalledTimes(1);
  });

  it("renders the overview metric cards from the adapter", async () => {
    renderView();

    expect(
      await within(screen.getByTestId("overview-metric-tasks")).findByText("6"),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByTestId("overview-metric-records")).findByText(
        "9",
      ),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByTestId("overview-metric-leftovers")).findByText(
        "1",
      ),
    ).toBeInTheDocument();
    // 活跃模块 / 活跃功能已从展示层取消：适配器仍返回服务端值，但页面不渲染。
    expect(screen.queryByTestId("overview-metric-modules")).toBeNull();
    expect(screen.queryByTestId("overview-metric-features")).toBeNull();
    expect(screen.queryByText("活跃模块")).toBeNull();
    expect(screen.queryByText("活跃功能")).toBeNull();
    expect(
      screen.getByTestId("project-overview-mock-notice"),
    ).toHaveTextContent("骨架数据");
  });

  it("opens the single record detail from a recent iteration row", async () => {
    const handlers = renderView();
    const user = userEvent.setup();

    const row = await screen.findByRole("button", { name: /迭代一/ });
    expect(row).toHaveTextContent("任务中心：迭代一");
    expect(row).toHaveTextContent("R-301");

    // 单行打开该条记录详情；「查看全部」才打开记录工作区弹窗。
    await user.click(row);
    expect(handlers.onOpenRecord).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 301, code: "R-301" }),
    );
    expect(handlers.onOpenRecords).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /查看全部/ }));
    expect(handlers.onOpenRecords).toHaveBeenCalledTimes(1);
  });

  it("routes the leftover entries to the issues page", async () => {
    const handlers = renderView();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: /进入遗留问题/ }),
    );
    expect(handlers.onOpenIssues).toHaveBeenCalledTimes(1);

    const row = await screen.findByRole("button", { name: /遗留一/ });
    expect(row).toHaveTextContent("来自 R-021 登录安全复核");
    await user.click(row);
    expect(handlers.onOpenIssues).toHaveBeenCalledTimes(2);
  });

  it("renders the full server source without the former gap placeholders", async () => {
    renderView({
      adapter: {
        source: "server",
        notice: "服务端适配器测试",
        fetchProjectOverview: () =>
          Promise.resolve({
            stats: {
              activeModules: 4,
              activeFeatures: 11,
              openTasks: 6,
              publishedRecords: 9,
              openLeftovers: 2,
            },
            recentIterations: [],
            leftovers: [
              {
                leftoverId: 21,
                summary: "遗留一",
                recordCode: "R-021",
                recordTitle: "登录安全复核",
              },
            ],
          }),
      },
    });

    expect(
      screen.queryByTestId("project-overview-mock-notice"),
    ).not.toBeInTheDocument();
    const leftovers = await screen.findByTestId("overview-metric-leftovers");
    expect(await within(leftovers).findByText("2")).toBeInTheDocument();
    // 设计师稿 catalog.tsx L238-245 的指标项只有标签与数值，没有第二行说明。
    expect(within(leftovers).getByText("遗留问题")).toBeInTheDocument();
    expect(within(leftovers).queryByText("等待闭环")).toBeNull();
    const row = await screen.findByRole("button", { name: /遗留一/ });
    expect(row).toHaveTextContent("来自 R-021 登录安全复核");
  });

  it("shows empty states when the adapter returns no rows", async () => {
    renderView({
      adapter: createAdapter({
        stats: {
          activeModules: 0,
          activeFeatures: 0,
          openTasks: 0,
          publishedRecords: 0,
          openLeftovers: 0,
        },
        recentIterations: [],
        leftovers: [],
      }),
    });
    expect(await screen.findByText("暂无已发布记录")).toBeInTheDocument();
    expect(screen.getByText("没有未处理的遗留问题")).toBeInTheDocument();
  });

  it("surfaces the adapter error message", async () => {
    renderView({
      adapter: {
        source: "mock",
        notice: "测试失败路径",
        fetchProjectOverview: () => Promise.reject(new Error("boom")),
      },
    });
    expect(
      await screen.findByText("项目信息暂时不可用，请稍后重试。"),
    ).toBeInTheDocument();
  });

  it("shows the project error with a retry action", async () => {
    const handlers = renderView({
      projectError: "项目不存在或已无权访问。",
    });
    const user = userEvent.setup();
    expect(
      await screen.findByText("项目不存在或已无权访问。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(handlers.onRetryProject).toHaveBeenCalledTimes(1);
  });

  it("渲染搭建引导并把第一步动作接到回调上", () => {
    const onCreateModule = vi.fn();
    const onAddFeature = vi.fn();
    renderView({
      setupGuide: {
        moduleCount: 0,
        featureCount: 0,
        taskCount: 0,
        featureTargetName: null,
        onCreateModule,
        onAddFeature,
      },
    });
    const guide = screen.getByTestId("project-setup-guide");
    expect(within(guide).getByText("开始搭建这个项目")).toBeInTheDocument();
    fireEvent.click(within(guide).getByRole("button", { name: "新增模块" }));
    expect(onCreateModule).toHaveBeenCalledTimes(1);
    expect(onAddFeature).not.toHaveBeenCalled();
  });

  it("没有搭建引导输入时不渲染引导", async () => {
    renderView();
    await screen.findByTestId("overview-metric-members");
    expect(screen.queryByTestId("project-setup-guide")).toBeNull();
  });
});

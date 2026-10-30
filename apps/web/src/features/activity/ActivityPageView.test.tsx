import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActivityPage, InpulseApiClient } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ActivityPageView } from "./ActivityPageView";

const PROJECT = {
  id: 7,
  code: "INPULSE",
  name: "InPulse 研发交付平台",
  description: null,
  status: "ACTIVE" as const,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  memberCount: 4,
  stats: {
    activeModuleCount: 2,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

const ACTIVITY: ActivityPage = {
  items: [
    {
      id: "1",
      projectId: 7,
      sourceEntityType: "TASK",
      sourceEntityId: 3,
      activityType: "task.complete",
      actorId: 1,
      actorName: "特哥",
      summary: "任务完成：F-01 用户登录与会话管理 交付",
      occurredAt: "2026-09-08T04:05:00.000Z",
    },
  ],
  nextCursor: null,
  hasMore: false,
  // 服务端全量统计：当天 4 条，但首页只加载了 1 条。
  dayTotals: [{ day: "2026-09-08", count: 4 }],
  dayTotalsTruncated: false,
};

const SECOND_PROJECT = {
  ...PROJECT,
  id: 9,
  code: "WMS",
  name: "WMS 仓储调度平台",
  memberCount: 2,
};

function createClient(
  projects: readonly (typeof PROJECT)[] = [PROJECT],
): InpulseApiClient {
  return {
    getProjectActivity: vi.fn().mockResolvedValue(ACTIVITY),
    listActivity: vi.fn().mockResolvedValue(ACTIVITY),
    listProjects: vi.fn().mockResolvedValue({ items: projects }),
    getUserDirectory: vi.fn().mockResolvedValue({
      items: [{ id: 1, name: "特哥", avatarUrl: null, isAdmin: true }],
    }),
  } as unknown as InpulseApiClient;
}

function mount(client: InpulseApiClient, isAdmin: boolean) {
  return render(
    <MemoryRouter>
      <AuthStateProvider
        value={{
          status: "authenticated",
          user: {
            id: 1,
            loginName: "tege",
            name: "特哥",
            email: null,
            avatarUrl: null,
            isAdmin,
            status: "ACTIVE",
          },
        }}
      >
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <ActivityPageView projectId={7} client={client} />
        </QueryClientProvider>
      </AuthStateProvider>
    </MemoryRouter>,
  );
}

/** 项目详情页按路由参数取数：这里把 pathname 打到页面上，用来断言下拉换页。 */
const RoutedActivity: React.FC<{ readonly client: InpulseApiClient }> = ({
  client,
}) => {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  return (
    <>
      <span data-testid="path">{location.pathname + location.search}</span>
      <ActivityPageView
        {...(projectId === undefined ? {} : { projectId: Number(projectId) })}
        client={client}
      />
    </>
  );
};

/** CalmSelect 交互：打开下拉并点选可见弹层里的目标项（弹层项带 title 属性）。 */
function pickSelectOption(label: string, optionTitle: string) {
  const field = screen.getByLabelText(label);
  const trigger = field.closest(".ant-select");
  if (!trigger) {
    throw new Error("select trigger not found for " + label);
  }
  fireEvent.mouseDown(trigger);
  const matches = Array.from(
    document.querySelectorAll(`[title="${optionTitle}"]`),
  ).filter((node) => node.closest(".ant-select-dropdown-hidden") === null);
  const option = matches[matches.length - 1];
  if (!option) {
    throw new Error("select option not found: " + optionTitle);
  }
  fireEvent.click(option);
}

function mountRouted(client: InpulseApiClient, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthStateProvider
        value={{
          status: "authenticated",
          user: {
            id: 1,
            loginName: "tege",
            name: "特哥",
            email: null,
            avatarUrl: null,
            isAdmin: true,
            status: "ACTIVE",
          },
        }}
      >
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <Routes>
            <Route
              path="/projects/:projectId/activity"
              element={<RoutedActivity client={client} />}
            />
            <Route
              path="/activity"
              element={<RoutedActivity client={client} />}
            />
          </Routes>
        </QueryClientProvider>
      </AuthStateProvider>
    </MemoryRouter>,
  );
}

describe("ActivityPageView", () => {
  it("renders the designer activity row with real actor names and admin snapshot actions", async () => {
    const client = createClient();
    mount(client, true);

    expect(await screen.findByTestId("activity-item-1")).toBeInTheDocument();
    expect(screen.getByText("特哥")).toBeInTheDocument();
    expect(screen.getByText("完成任务")).toBeInTheDocument();
    expect(
      screen.getByText("F-01 用户登录与会话管理 交付"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("InPulse 研发交付平台 · 任务 #3"),
    ).toBeInTheDocument();
    expect(screen.getByText("项目 #7")).toBeInTheDocument();
    expect(screen.getByText("管理员可查看原始快照")).toBeInTheDocument();
    // 2026-09-24：管理员操作默认勾选（取消勾选会重取第一页）。
    expect(screen.getByLabelText("包含管理员操作")).toBeChecked();
    // 日期旁的条数是服务端全量，不是已加载行数。
    expect(screen.getByText("4 条动态")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "原始快照 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看对象" }),
    ).toBeInTheDocument();

    expect(screen.getByText("审计规则")).toBeInTheDocument();
    expect(screen.getByText("BR-012 · 以下操作必须记录")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);

    const projectActivity = client.getProjectActivity as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(projectActivity).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ limit: 20 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("hides the snapshot action from non-admins", async () => {
    mount(createClient(), false);

    expect(await screen.findByTestId("activity-item-1")).toBeInTheDocument();
    expect(screen.getByText("仅管理员可查看原始快照")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "原始快照 1" })).toBeNull();
    expect(screen.queryByLabelText("包含管理员操作")).toBeNull();
  });
  it("锁定项目时同一个下拉可以换成其他项目，也可以切到全部项目", async () => {
    // 2026-10-09：项目详情页原先连下拉都不渲染，用户反馈没法换项目。
    mountRouted(
      createClient([PROJECT, SECOND_PROJECT]),
      "/projects/7/activity",
    );

    expect(await screen.findByTestId("activity-item-1")).toBeInTheDocument();
    expect(screen.getByTestId("path")).toHaveTextContent(
      "/projects/7/activity",
    );
    // 触发器显示当前项目名（rich 形态），不是裸 id。
    expect(screen.getByText("InPulse 研发交付平台")).toBeInTheDocument();

    pickSelectOption("项目", "WMS 仓储调度平台");
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent(
        "/projects/9/activity",
      ),
    );

    // 回到全局态后，下拉仍是同一份选项，且筛选写回 URL（可分享、刷新保留）。
    pickSelectOption("项目", "全部项目");
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/activity"),
    );
    pickSelectOption("项目", "WMS 仓储调度平台");
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent(
        "/activity?project=9",
      ),
    );
  });
});

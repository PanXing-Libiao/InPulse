import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { InpulseApiClient, ModuleTaskItem } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import {
  MY_TASKS_FULL_FILTER_SUPPORT,
  type MyTaskGroupsResult,
  type MyTaskListItem,
  type MyTaskListResult,
  type MyTasksAdapter,
  type MyTasksQueryInput,
} from "@features/my-tasks/my-tasks-types";
import { TasksPage } from "./TasksPage";

/** 任务中心地址探针：卡片点击只在当前页面弹出详情，pathname 与筛选参数都不变。 */
const LocationProbe: React.FC = () => {
  const location = useLocation();
  return (
    <div data-testid="location-probe">
      {location.pathname + location.search}
    </div>
  );
};

const emptyResult: MyTaskListResult = {
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
    myOpen: 0,
    completed: 0,
    created: 0,
  },
  scopeCounts: { mine: 0, created: 0, project: 0, all: 0 },
  leftoverCount: 0,
  leftoverSample: null,
  filterSupport: MY_TASKS_FULL_FILTER_SUPPORT,
};

const taskCenterTask: MyTaskListItem = {
  taskId: 320,
  code: "INP-320",
  title: "任务中心任务",
  projectId: 7,
  projectName: "注入项目名",
  moduleId: 71,
  moduleName: "未分类",
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  priority: "NORMAL",
  dueAt: null,
  updatedAt: "2026-09-12T00:00:00.000Z",
  completedAt: null,
  creatorId: 1,
  assignee: { userId: 1, name: "开发者 C", avatarUrl: null },
  assignees: [{ userId: 1, name: "开发者 C", avatarUrl: null }],
  hasPublishedRecord: false,
  publishedRecordCount: 0,
  groupRole: null,
  githubLinkCount: 0,
  groupId: null,
  hasLeftoverSource: false,
};

const moduleTask: MyTaskListItem = {
  ...taskCenterTask,
  taskId: 321,
  code: "INP-321",
  title: "模块级任务",
  moduleId: 72,
};

/** 详情弹窗读取的是模块任务页同款任务列表（listTasks / listModuleTasks 的条目）。 */
const taskCenterTaskDetail: ModuleTaskItem = {
  id: 320,
  projectId: 7,
  moduleId: 71,
  code: "INP-320",
  title: "任务中心任务",
  description: "任务说明",
  assigneeId: 1,
  assigneeIds: [1],
  creatorId: 1,
  priority: "NORMAL",
  dueAt: null,
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  rowVersion: 1,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

const moduleTaskDetail: ModuleTaskItem = {
  id: 321,
  projectId: 7,
  moduleId: 72,
  code: "INP-321",
  title: "模块级任务",
  description: "模块级任务说明",
  assigneeId: 1,
  assigneeIds: [1],
  creatorId: 1,
  priority: "NORMAL",
  dueAt: null,
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  rowVersion: 1,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

const moduleDetailItem = (id: number, name: string) => ({
  id,
  projectId: 7,
  code: "INP-M-" + String(id),
  name,
  description: "",
  kind: "NORMAL",
  status: "ACTIVE",
  sortOrder: id,
  rowVersion: 1,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  archivedAt: null,
  stats: { openTaskCount: 1, completedTaskCount: 0 },
});

/**
 * 就地详情弹窗的数据源 mock：点击卡片后 TasksPanel 以 detail 模式读取任务列表、
 * 成员、聚合标记、迭代记录、项目 / 模块与用户目录，这里返回最小可用数据。
 */
const createClient = () => {
  const listProjects = vi.fn().mockResolvedValue({ items: [] });
  const client = {
    listProjects,
    getProject: vi.fn().mockResolvedValue({
      project: {
        id: 7,
        code: "INP",
        name: "注入项目",
        description: "",
        status: "ACTIVE",
        rowVersion: 1,
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
        archivedAt: null,
      },
      currentUserRole: "MEMBER",
    }),
    listModules: vi.fn().mockResolvedValue({
      items: [moduleDetailItem(71, "未分类"), moduleDetailItem(72, "登录模块")],
    }),
    listModuleTasks: vi
      .fn()
      .mockResolvedValue({ items: [taskCenterTaskDetail, moduleTaskDetail] }),
    listTaskAssignees: vi.fn().mockResolvedValue({ items: [] }),
    listModuleTaskAssignees: vi.fn().mockResolvedValue({ items: [] }),
    listTaskGroupMemberships: vi.fn().mockResolvedValue({ items: [] }),
    listChangeRecords: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
    getTaskRecordDrafts: vi.fn().mockResolvedValue({ items: [] }),
    listActiveProjectMembers: vi.fn().mockResolvedValue({ items: [] }),
    getUserDirectory: vi.fn().mockResolvedValue({ items: [] }),
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 7,
      rowVersion: 1,
      writable: false,
      items: [],
    }),
    getLeftoverTaskSource: vi.fn().mockResolvedValue({ source: null }),
    getModuleTaskStatusHistory: vi.fn().mockResolvedValue({ items: [] }),
    listLeftoverItems: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
  } as unknown as InpulseApiClient;
  return { client, listProjects };
};

const createAdapter = (items: MyTaskListItem[] = []) => {
  const fetchMyTasks = vi.fn(
    async (_input: MyTasksQueryInput): Promise<MyTaskListResult> => ({
      ...emptyResult,
      items,
    }),
  );
  const fetchTaskGroups = vi.fn(async (): Promise<MyTaskGroupsResult> => ({
    items: [],
    nextCursor: null,
    hasMore: false,
  }));
  const adapter: MyTasksAdapter = {
    source: "mock",
    notice: "测试骨架数据",
    fetchMyTasks,
    fetchTaskGroups,
  };
  return { adapter, fetchMyTasks, fetchTaskGroups };
};

interface RenderOptions {
  readonly entries?: string;
  readonly isAdmin?: boolean;
  readonly items?: MyTaskListItem[];
}

const renderPage = (options: RenderOptions = {}) => {
  const { adapter, fetchMyTasks } = createAdapter(options.items ?? []);
  const { client, listProjects } = createClient();
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
            isAdmin: options.isAdmin === true,
            status: "ACTIVE",
          },
        }}
      >
        <MemoryRouter initialEntries={[options.entries ?? "/tasks"]}>
          <Routes>
            <Route
              path="/tasks"
              element={
                <>
                  <TasksPage client={client} adapter={adapter} />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthStateProvider>
    </QueryClientProvider>,
  );
  return { fetchMyTasks, listProjects };
};

describe("TasksPage", () => {
  it("reads the filter state from the URL", async () => {
    const { fetchMyTasks } = renderPage({
      entries: "/tasks?scope=created&status=done&q=登录&view=list",
    });
    await waitFor(() =>
      expect(fetchMyTasks).toHaveBeenCalledWith({
        filters: expect.objectContaining({
          scope: "created",
          status: "done",
          query: "登录",
          display: "list",
        }),
        viewerId: 1,
        cursor: null,
      }),
    );
  });

  it("writes filter changes back to the URL", async () => {
    const { fetchMyTasks } = renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(fetchMyTasks).toHaveBeenCalledTimes(1));

    // 工作状态由工具栏「未完成 / 已完成」筛选设定：切到「已完成」写入 URL 并重新查询。
    await user.click(
      within(screen.getByRole("group", { name: "工作状态" })).getByRole(
        "button",
        { name: "已完成" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        "status=done",
      ),
    );
    await waitFor(() =>
      expect(fetchMyTasks).toHaveBeenLastCalledWith({
        filters: expect.objectContaining({ status: "done" }),
        viewerId: 1,
        cursor: null,
      }),
    );
  });

  it("toggles the advanced panel through the more parameter", async () => {
    renderPage({ entries: "/tasks?more=1" });
    const user = userEvent.setup();
    expect(await screen.findByLabelText("合并关系")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /更多筛选/ }));
    await waitFor(() => expect(screen.queryByLabelText("合并关系")).toBeNull());
    expect(screen.getByTestId("location-probe")).not.toHaveTextContent(
      "more=1",
    );
  });

  it("opens the leftover issues modal in place without leaving the task center", async () => {
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toBeInTheDocument(),
    );
    const before = screen.getByTestId("location-probe").textContent;

    // 任务中心不再跳转 `/issues`：头部入口就地打开 F-20 遗留问题弹窗，
    // 关闭后仍停在任务中心，地址栏与筛选参数不变。
    await user.click(screen.getByRole("button", { name: /遗留问题/ }));
    const dialog = await screen.findByRole("dialog", { name: "遗留问题" });
    expect(dialog).toBeInTheDocument();
    // 弹窗内是 F-20 视图本体（懒加载 chunk 就绪前 Suspense 渲染为空）。
    expect(
      await within(dialog).findByTestId("issues-page"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location-probe")).toHaveTextContent(
      before ?? "",
    );
  });

  it("opens a task detail in place without leaving the task center", async () => {
    renderPage({ items: [taskCenterTask, moduleTask] });
    const user = userEvent.setup();

    // 任务中心不再跳转：点击卡片后由 TaskDetailOverlay 在当前页面打开模块任务页同款
    // 任务详情弹窗（写操作仍只有这一个入口），地址栏与筛选参数保持不变。
    await user.click(await screen.findByTestId("my-task-320"));
    await screen.findByRole("button", { name: "关闭任务详情" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "任务中心任务" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成任务" })).toBeEnabled();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/tasks");

    // 关闭弹窗后仍停留在任务中心，不产生任何导航。
    await user.click(screen.getByRole("button", { name: "关闭任务详情" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "关闭任务详情" })).toBeNull(),
    );
    expect(await screen.findByTestId("my-task-320")).toBeInTheDocument();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/tasks");
  });

  it("opens a module-level task row in place on the module scope", async () => {
    renderPage({ entries: "/tasks?view=list", items: [moduleTask] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /模块级任务/ }));

    await screen.findByRole("button", { name: "关闭任务详情" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "模块级任务" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/tasks");
  });

  it("demotes the admin-only scope for non-admins", async () => {
    const { fetchMyTasks } = renderPage({ entries: "/tasks?scope=all" });
    await waitFor(() =>
      expect(fetchMyTasks).toHaveBeenCalledWith({
        filters: expect.objectContaining({ scope: "mine" }),
        viewerId: 1,
        cursor: null,
      }),
    );
    // 范围分段行已整体移除：非管理员看不到管理员范围，页面上也不再有范围 tab。
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("keeps the admin scope for admins", async () => {
    const { fetchMyTasks } = renderPage({
      entries: "/tasks?scope=all",
      isAdmin: true,
    });
    await waitFor(() =>
      expect(fetchMyTasks).toHaveBeenCalledWith({
        filters: expect.objectContaining({ scope: "all" }),
        viewerId: 1,
        cursor: null,
      }),
    );
    // 管理员范围仍由 URL 承载并被服务端接受；页面不再提供范围 tab。
    expect(await screen.findByTestId("task-center")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

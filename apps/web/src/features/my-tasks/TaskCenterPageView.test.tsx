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
import type { InpulseApiClient, ProjectItem } from "@generated/api";
import { TaskCenterPageView } from "./TaskCenterPageView";
import { MY_TASKS_MOCK_ADAPTER } from "./my-tasks-mock";
import { MY_TASKS_V1_FILTER_SUPPORT } from "./my-tasks-v1-query";
import { DEFAULT_MY_TASK_FILTERS } from "./my-tasks-url";
import type { MyTaskFilters } from "./my-tasks-types";
import type { MyTaskPriority } from "./my-tasks-types";
import type { MyTaskGroupItem } from "./my-tasks-types";
import type { MyTaskListItem } from "./my-tasks-types";
import type { MyTasksAdapter } from "./my-tasks-types";
import type { TaskLocation } from "@features/tasks/task-links";

const projects: readonly ProjectItem[] = [
  {
    id: 1,
    code: "INP",
    name: "注入项目名",
    description: "项目说明",
    status: "ACTIVE",
    hasCompletedTask: false,
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    memberCount: 3,
    stats: {
      activeModuleCount: 2,
      openTaskCount: 4,
      completedTaskCount: 1,
    },
  },
  {
    id: 5,
    code: "ORD",
    name: "订单中台",
    description: "项目说明",
    status: "ACTIVE",
    hasCompletedTask: false,
    rowVersion: 1,
    createdBy: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    memberCount: 2,
    stats: {
      activeModuleCount: 1,
      openTaskCount: 2,
      completedTaskCount: 1,
    },
  },
];

interface ViewOverrides {
  readonly advancedOpen?: boolean;
  /** 覆盖注入的项目列表：用于「项目不在可见列表里」的降级断言。 */
  readonly projects?: readonly ProjectItem[];
  readonly adapter?: MyTasksAdapter;
  readonly filters?: Partial<MyTaskFilters>;
  readonly client?: InpulseApiClient;
  readonly onFiltersChange?: (next: unknown) => void;
  readonly onToggleAdvanced?: () => void;
  readonly onOpenIssues?: () => void;
  readonly onOpenTask?: (task: TaskLocation) => void;
  readonly leftoverCount?: number | null;
}

const renderView = (overrides: ViewOverrides = {}) => {
  const onFiltersChange = overrides.onFiltersChange ?? vi.fn();
  const onToggleAdvanced = overrides.onToggleAdvanced ?? vi.fn();
  const onOpenIssues = overrides.onOpenIssues ?? vi.fn();
  const onOpenTask = overrides.onOpenTask ?? vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <TaskCenterPageView
        filters={{ ...DEFAULT_MY_TASK_FILTERS, ...overrides.filters }}
        onFiltersChange={onFiltersChange}
        viewerId={1}
        projects={overrides.projects ?? projects}
        advancedOpen={overrides.advancedOpen === true}
        onToggleAdvanced={onToggleAdvanced}
        onOpenIssues={onOpenIssues}
        onOpenTask={onOpenTask}
        {...(overrides.leftoverCount !== undefined
          ? { leftoverCount: overrides.leftoverCount }
          : {})}
        {...(overrides.adapter ? { adapter: overrides.adapter } : {})}
        {...(overrides.client ? { client: overrides.client } : {})}
      />
    </QueryClientProvider>,
  );
  return { onFiltersChange, onToggleAdvanced, onOpenIssues, onOpenTask };
};

/** 只实现弹窗会读到的方法；其余方法不该被调用。 */
const stubClient = (projects: readonly ProjectItem[]): InpulseApiClient =>
  ({
    listProjects: async () => ({ items: [...projects] }),
    listModules: async () => ({ items: [] }),
  }) as unknown as InpulseApiClient;

/**
 * 模拟服务端适配器：沿用 mock 数据集，但把结果里的 filterSupport 换成 R-3 真实能力位，
 * 以覆盖 query / relation / github 由视图在已加载页上本地收窄的分支。
 */
const serverLikeAdapter = (): MyTasksAdapter => ({
  ...MY_TASKS_MOCK_ADAPTER,
  source: "server",
  fetchMyTasks: async (input) => ({
    ...(await MY_TASKS_MOCK_ADAPTER.fetchMyTasks(input)),
    filterSupport: MY_TASKS_V1_FILTER_SUPPORT,
  }),
});

/**
 * 固定任务集合的服务端适配器：用于断言「主列表跟随工作状态筛选」，
 * mock 数据集无法构造「0 个未完成 + 1 个已完成」这类边界。
 *
 * 聚合组默认清空：这些用例针对空态文案，必须同时没有任务与聚合组；需要组卡的用例
 * 自行覆盖 fetchTaskGroups。2026-09-22 起聚合组与任务同一口径跟随工作状态筛选，
 * 需要组卡可见的用例也要把 filters.status 调成组所在的那一档。
 */
const serverLikeAdapterWith = (
  items: readonly MyTaskListItem[],
  groups: readonly MyTaskGroupItem[] = [],
): MyTasksAdapter => ({
  ...MY_TASKS_MOCK_ADAPTER,
  source: "server",
  fetchMyTasks: async () => ({
    items: [...items],
    nextCursor: null,
    hasMore: false,
    stats: null,
    scopeCounts: null,
    leftoverCount: null,
    leftoverSample: null,
    filterSupport: MY_TASKS_V1_FILTER_SUPPORT,
  }),
  fetchTaskGroups: async () => ({
    items: [...groups],
    nextCursor: null,
    hasMore: false,
  }),
});

const doneTask: MyTaskListItem = {
  taskId: 901,
  code: "INP-901",
  title: "已完成任务-901",
  projectId: 1,
  projectName: "注入项目名",
  moduleId: 11,
  moduleName: "未分类",
  workStatus: "DONE",
  lifecycleStatus: "ACTIVE",
  priority: "NORMAL",
  dueAt: null,
  updatedAt: "2026-09-02T00:00:00.000Z",
  completedAt: "2026-09-03T00:00:00.000Z",
  creatorId: 1,
  assignee: { userId: 1, name: "特哥", avatarUrl: null },
  assignees: [{ userId: 1, name: "特哥", avatarUrl: null }],
  hasPublishedRecord: false,
  publishedRecordCount: 0,
  groupRole: null,
  githubLinkCount: 0,
  groupId: null,
  hasLeftoverSource: false,
};

/**
 * 由遗留问题转换而来、既不紧急也不逾期的普通优先级任务。
 * 2026-09-23 八次配色定案：整卡按自己的优先级取色（白底），来源只由「遗留问题」徽章表达。
 */
const leftoverTask: MyTaskListItem = {
  ...doneTask,
  taskId: 905,
  code: "INP-905",
  title: "遗留问题转来的跟进任务-905",
  workStatus: "TODO",
  priority: "NORMAL",
  completedAt: null,
  hasLeftoverSource: true,
};

describe("TaskCenterPageView", () => {
  it("renders the toolbar work-status filter with a mock-data notice only", async () => {
    renderView();

    // mock 适配器只在测试与降级演示中使用：此时必须显式标注骨架数据，且不再复述接口说明。
    const notice = await screen.findByTestId("task-center-mock-notice");
    expect(notice).toHaveTextContent("骨架数据：");
    expect(screen.queryByText(/接口说明/)).toBeNull();

    // 2026-09-21 定案：逾期风险条与四张统计卡整体删除，工作状态改由工具栏分段控件承担。
    expect(screen.queryByTestId("stat-my-open")).toBeNull();
    expect(document.querySelector(".stats-grid")).toBeNull();
    expect(document.querySelector(".risk-strip")).toBeNull();
    const statusFilter = screen.getByRole("group", { name: "工作状态" });
    expect(
      within(statusFilter).getByRole("button", { name: "未完成" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(statusFilter).getByRole("button", { name: "已完成" }),
    ).toHaveAttribute("aria-pressed", "false");

    // 范围分段行已整体移除：工作状态由工具栏承担，项目筛选同样在工具栏里。
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByLabelText("搜索任务")).toBeEnabled();
    const projectTrigger = screen.getByLabelText("项目").closest(".ant-select");
    expect(projectTrigger).toHaveTextContent("全部项目");
  });

  it("工作状态两档显示服务端统计的数量角标", async () => {
    const statsAdapter: MyTasksAdapter = {
      ...serverLikeAdapterWith([]),
      fetchMyTasks: async () => ({
        items: [],
        nextCursor: null,
        hasMore: false,
        stats: {
          todayTodo: 3,
          todayTodoBreakdown: {
            overdue: 1,
            leftover: 0,
            urgent: 1,
            dueWithinDays: 1,
          },
          myOpen: 7,
          completed: 23,
          created: 9,
        },
        scopeCounts: null,
        leftoverCount: 0,
        leftoverSample: null,
        filterSupport: MY_TASKS_V1_FILTER_SUPPORT,
      }),
    };
    renderView({ adapter: statsAdapter });

    const statusFilter = screen.getByRole("group", { name: "工作状态" });
    const open = within(statusFilter).getByRole("button", { name: "未完成" });
    const done = within(statusFilter).getByRole("button", { name: "已完成" });
    await waitFor(() =>
      expect(open.querySelector(".segmented-count")).toHaveTextContent("7"),
    );
    expect(done.querySelector(".segmented-count")).toHaveTextContent("23");
    // 角标对辅助技术隐藏（与侧栏 .nav-item em 同口径），档位名因此保持「未完成」；
    // 数量通过 title 说明，读屏听到的按钮名不受角标影响。
    expect(open.querySelector(".segmented-count")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(open.querySelector(".segmented-count")).toHaveAttribute(
      "title",
      "未完成 7 项",
    );
    expect(open).toHaveAccessibleName("未完成");
  });

  it("统计不可知（stats: null）时不渲染数量角标，不把未知显示成 0", async () => {
    renderView({ adapter: serverLikeAdapterWith([]) });

    // 空态出现即代表 R-3 结果已进入视图，此时才断言角标确实没有渲染。
    await screen.findByText("没有匹配的未完成任务");
    const statusFilter = screen.getByRole("group", { name: "工作状态" });
    expect(statusFilter.querySelectorAll(".segmented-count")).toHaveLength(0);
    expect(
      within(statusFilter).getByRole("button", { name: "未完成" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("遗留问题入口优先显示页面注入的外壳计数（与侧栏同源）", async () => {
    const { onOpenIssues } = renderView({ leftoverCount: 6 });
    const button = await screen.findByRole("button", { name: /遗留问题 6/ });
    expect(button.querySelector(".header-count")).toHaveTextContent("6");
    await userEvent.setup().click(button);
    expect(onOpenIssues).toHaveBeenCalledTimes(1);
  });

  it("外壳计数尚未加载（null）时不显示角标，也不回退适配器字段", async () => {
    const adapter: MyTasksAdapter = {
      ...serverLikeAdapterWith([]),
      fetchMyTasks: async () => ({
        items: [],
        nextCursor: null,
        hasMore: false,
        stats: null,
        scopeCounts: null,
        leftoverCount: 3,
        leftoverSample: null,
        filterSupport: MY_TASKS_V1_FILTER_SUPPORT,
      }),
    };
    renderView({ leftoverCount: null, adapter });
    await screen.findByText("没有匹配的未完成任务");
    const button = screen.getByRole("button", { name: "遗留问题" });
    expect(button.querySelector(".header-count")).toBeNull();
  });

  it("shows open tasks only by default and hides done and canceled", async () => {
    renderView();

    // 卡片按程度铺色：这张紧急任务同时已逾期，2026-09-22 三次定案后逾期不再覆盖底色，
    // 仍按任务自己的优先级取紧急红（逾期只影响排序与列表截止列的文字色）。
    expect(await screen.findByTestId("my-task-101")).toHaveClass(
      "calm-task-card",
      "tone-prio-urgent",
    );
    expect(screen.queryByTestId("my-task-104")).toBeNull();
    expect(screen.queryByTestId("my-task-107")).toBeNull();
    expect(screen.queryByText(/已完成 .* 项/)).toBeNull();
  });

  it("标签落到左下角、负责人贴在分隔线上方右侧", async () => {
    renderView();

    const card = await screen.findByTestId("my-task-101");
    // 编号与「未完成」都不再占位：卡片顶部那一行整行消失。
    expect(card.querySelector(".calm-card-top")).toBeNull();
    expect(card.querySelector(".task-id")).toBeNull();
    expect(within(card).queryByText("T-101")).toBeNull();
    expect(within(card).queryByText("未完成")).toBeNull();
    // 标签（含优先级）落到分隔线以下的左下角，由底部那一排承载。
    const bottom = card.querySelector(".calm-card-bottom") as HTMLElement;
    const badges = card.querySelector(
      ".calm-card-bottom > .task-card-badges",
    ) as HTMLElement;
    expect(badges).not.toBeNull();
    expect(badges.parentElement).toBe(bottom);
    expect(within(badges).getByText("紧急")).toBeInTheDocument();
    // 2026-09-22 定案：「遗留问题」用固定深锈红徽章，不再与优先级标签同款。
    expect(within(badges).getByText("遗留问题")).toHaveClass("badge-leftover");
    // 负责人单独一行贴在分隔线上方并右对齐：它是底部那一排的前一个兄弟节点。
    const assignee = card.querySelector(".calm-card-assignee") as HTMLElement;
    expect(assignee).not.toBeNull();
    expect(assignee.nextElementSibling).toBe(bottom);
    expect(assignee.firstElementChild?.getAttribute("title")).toMatch(
      /^负责人：/,
    );
    // 页脚恒渲染、只按有无记录决定是否放计数（2026-10-08 「已完成和未完成任务卡片的
    // 布局也要一样大」）：无记录时是空占位盒（高度由 CSS 的 min-height 给），整卡与
    // 有记录的卡片等高；不能再断言 `.task-card-footer` 整块不渲染。
    expect(card.querySelector(".task-card-footer")).not.toBeNull();
    expect(within(card).queryByText(/记录 \d+ 条/)).toBeNull();
  });

  it("遗留问题来源的任务按自己的优先级取色，徽章保留深锈红实底", async () => {
    renderView({ adapter: serverLikeAdapterWith([leftoverTask]) });

    const card = await screen.findByTestId("my-task-905");
    expect(card).toHaveClass("calm-task-card", "tone-prio-normal");
    expect(within(card).getByText("遗留问题")).toHaveClass("badge-leftover");
  });

  it("列表视图的遗留问题行与卡片同源取色（只按优先级，不按来源）", async () => {
    renderView({
      filters: { display: "list" },
      adapter: serverLikeAdapterWith([leftoverTask]),
    });

    const row = await screen.findByText(leftoverTask.title);
    expect(row.closest("tr")).toHaveClass("tone-prio-normal");
  });

  /**
   * ADR-040：负责人是平权集合，服务端返回 assignees（assignee 只是它的派生标量），
   * 卡片与列表行都必须列出全部负责人，而不是只显示第一个。
   */
  const multiAssigneeTask: MyTaskListItem = {
    ...doneTask,
    taskId: 902,
    code: "INP-902",
    title: "多负责人任务-902",
    assignees: [
      { userId: 1, name: "特哥", avatarUrl: null },
      { userId: 2, name: "林雨妍", avatarUrl: null },
    ],
    assignee: { userId: 1, name: "特哥", avatarUrl: null },
  };

  it("卡片列出全部负责人而不是只显示第一位", async () => {
    renderView({
      filters: { status: "all", todayTodo: false },
      adapter: serverLikeAdapterWith([multiAssigneeTask]),
    });

    const card = await screen.findByTestId("my-task-902");
    const assignee = card.querySelector(".calm-card-assignee") as HTMLElement;
    expect(assignee.textContent).toContain("特哥、林雨妍");
    expect(assignee.firstElementChild?.getAttribute("title")).toBe(
      "负责人：特哥、林雨妍",
    );
  });

  it("列表行的负责人列同样列出全部负责人", async () => {
    renderView({
      filters: { status: "all", todayTodo: false, display: "list" },
      adapter: serverLikeAdapterWith([multiAssigneeTask]),
    });

    const table = await screen.findByRole("table", { name: "跨项目任务列表" });
    const row = table.querySelector("tbody tr");
    expect(row?.children[3]?.textContent).toBe("特哥、林雨妍");
  });

  it("drops the list title and count now that the toolbar filter carries the state", async () => {
    renderView({
      filters: { status: "all", todayTodo: false },
      adapter: serverLikeAdapterWith([doneTask]),
    });

    // 2026-09-20 定案：列表区块不再重复「全部任务 / 1 项 · 服务端按任务编号倒序」两行文字，
    // 工作状态只由工具栏「未完成 / 已完成」筛选表达；status=all 不属于任何档位，因此不高亮。
    // 已完成任务取绿色完成态（状态覆盖优先级）。
    const doneCard = await screen.findByTestId("my-task-901");
    expect(doneCard).toHaveClass("calm-task-card", "tone-prio-done");
    // 已办结状态有信息量：徽章留在右上角标签组里。
    expect(within(doneCard).getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("1 项 · 服务端按任务编号倒序")).toBeNull();
    expect(screen.queryByRole("heading", { name: "全部任务" })).toBeNull();
    expect(screen.queryByText(/没有匹配/)).toBeNull();
    expect(screen.queryByText(/已完成 1 项/)).toBeNull();
  });
  it("列表视图：标题领衔、编号并入标题下方小字", async () => {
    renderView({
      filters: { status: "done", todayTodo: false, display: "list" },
      adapter: serverLikeAdapterWith([doneTask]),
    });

    const table = await screen.findByRole("table", { name: "跨项目任务列表" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((node) => node.textContent),
    ).toEqual([
      "任务",
      "项目",
      "归属",
      "负责人",
      "优先级",
      "截止",
      "迭代",
      "状态",
    ]);

    // 编号不再是独立列：跟在标题下面，和归属类型拼成一行；
    // 整行沿用卡片同款程度配色，已完成覆盖为绿色。
    const row = table.querySelector("tbody tr");
    expect(row).toHaveClass("tone-prio-done");
    const subtitle = row?.querySelector<HTMLElement>(".feature-list-open span");
    expect(subtitle?.textContent).toBe("INP-901 · 独立任务");
    expect(subtitle?.closest("td")).toBe(row?.children[0]);
  });

  it("names the empty state after the active status segment", async () => {
    renderView({
      filters: { status: "done", todayTodo: false },
      adapter: serverLikeAdapterWith([]),
    });

    expect(await screen.findByText("没有匹配的已完成任务")).toBeInTheDocument();
    // 标题行已删除，工作状态由工具栏「已完成」档的选中态表达。
    expect(screen.queryByRole("heading", { name: "已完成" })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "工作状态" })).getByRole(
        "button",
        { name: "已完成" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("expands the done disclosure instead of hiding it behind the open empty state", async () => {
    renderView({
      filters: { status: "open", todayTodo: false },
      adapter: serverLikeAdapterWith([doneTask]),
    });

    expect(await screen.findByText("没有匹配的未完成任务")).toBeInTheDocument();
    const disclosure = screen.getByText(/已完成 1 项/).closest("details");
    expect(disclosure).not.toBeNull();
    expect((disclosure as HTMLDetailsElement).open).toBe(true);
    // 折叠面板用明细表渲染，只能按任务标题断言；未完成任务为空时它是唯一命中。
    expect(screen.getByText("已完成任务-901")).toBeInTheDocument();
  });

  it("explains the project-wide empty state", async () => {
    renderView({
      filters: { scope: "project", projectId: 5, status: "all" },
      adapter: serverLikeAdapterWith([]),
    });

    expect(
      await screen.findByText(/当前项目没有符合条件的任务/),
    ).toBeInTheDocument();
  });

  it("resolves project names from the injected project port", async () => {
    renderView();
    const card = await screen.findByTestId("my-task-101");
    expect(card).toHaveTextContent("注入项目名");
  });

  it("fills the card with a project watermark and a bolder name on the belonging line", async () => {
    renderView();
    // 2026-10-10 产品定案：项目标识从归属行搬到卡片右下角，摊成一枚浅色字母水印
    // （取项目编码前两位，与项目列表页同一个 ProjectLogo）；归属行只留加大加粗的项目名。
    const card = await screen.findByTestId("my-task-101");
    const watermark = card.querySelector(":scope > .project-logo.watermark");
    expect(watermark?.textContent).toBe("IN");
    expect(watermark?.getAttribute("title")).toBe("INP");
    const belonging = card.querySelector(".task-belonging") as HTMLElement;
    expect(belonging).not.toBeNull();
    expect(belonging.querySelector(".project-logo")).toBeNull();
    expect(
      belonging.querySelector("strong.belonging-project")?.textContent,
    ).toBe("注入项目名");
    expect(belonging.textContent).toBe("注入项目名 · 访问控制");
  });

  it("falls back to the plain project name when the project is not in the port", async () => {
    // 契约不给任务项项目编码，页面靠注入的项目列表映射；项目不在列表里时只渲染项目名，
    // 不能凭空造水印（水印字母取编码前两位）。
    renderView({ projects: projects.filter((project) => project.id !== 1) });
    const card = await screen.findByTestId("my-task-101");
    expect(card.querySelector(":scope > .project-logo")).toBeNull();
    const belonging = card.querySelector(".task-belonging") as HTMLElement;
    expect(belonging.querySelector(".project-logo")).toBeNull();
    expect(
      belonging.querySelector("strong.belonging-project")?.textContent,
    ).toBe("InPulse 平台");
  });

  it("reports the project filter through onFiltersChange", async () => {
    const { onFiltersChange } = renderView();

    // 默认「全部项目」= 不加项目条件，保持跨项目视图（与遗留问题页同口径）。
    const trigger = screen.getByLabelText("项目").closest(".ant-select");
    if (!trigger) {
      throw new Error("select trigger not found for 项目");
    }
    expect(trigger).toHaveTextContent("全部项目");

    fireEvent.mouseDown(trigger);
    fireEvent.click(await screen.findByTitle("订单中台"));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 5 }),
    );
  });

  it("opens no read-only detail dialog and reports the location for a module task card", async () => {
    const { onOpenTask } = renderView();
    const card = await screen.findByTestId("my-task-101");
    await userEvent.click(card);

    // 任务中心不再弹出只读详情：写操作只在模块任务页中，点击卡片即交由页面定位。
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(onOpenTask).toHaveBeenCalledWith({
      projectId: 1,
      moduleId: 11,
      taskId: 101,
    });
  });

  it("reports the module task location for a task row", async () => {
    const { onOpenTask } = renderView({
      adapter: serverLikeAdapterWith([doneTask]),
      filters: { status: "done" },
    });
    await userEvent.click(await screen.findByTestId("my-task-901"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenTask).toHaveBeenCalledWith({
      projectId: 1,
      moduleId: 11,
      taskId: 901,
    });
  });

  it("reports the work-status change from the toolbar filter", async () => {
    const { onFiltersChange } = renderView();
    const user = userEvent.setup();

    const statusFilter = screen.getByRole("group", { name: "工作状态" });
    // 切到「已完成」：工作状态写入 URL，与工作状态无关的逾期 / 今日待办口径一并清除。
    await user.click(
      within(statusFilter).getByRole("button", { name: "已完成" }),
    );
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "done",
        overdue: false,
        todayTodo: false,
      }),
    );
    await user.click(
      within(statusFilter).getByRole("button", { name: "未完成" }),
    );
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "open" }),
    );
  });

  it("uses the plain open wording for the default view now that today-todo has no entry", async () => {
    renderView({ adapter: serverLikeAdapterWith([]) });

    // 缺省口径是「全部未完成任务」：空态就是未完成的措辞，不再出现「今天没有待办任务」。
    expect(await screen.findByText("没有匹配的未完成任务")).toBeInTheDocument();
    expect(screen.queryByText("今天没有待办任务")).toBeNull();
  });

  it("explains the today-todo empty state instead of reusing the open wording", async () => {
    renderView({
      adapter: serverLikeAdapterWith([]),
      filters: { todayTodo: true },
    });

    // 今日待办是「未完成」的子集，空态必须点明它更窄，否则看起来像漏了任务。
    expect(await screen.findByText("今天没有待办任务")).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的未完成任务")).toBeNull();
  });

  it("reports the query and the advanced toggle", async () => {
    const { onFiltersChange, onToggleAdvanced } = renderView();
    const user = userEvent.setup();

    const search = screen.getByLabelText("搜索任务");
    await user.type(search, "登");
    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenCalledWith(
        expect.objectContaining({ query: "登" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: /更多筛选/ }));
    expect(onToggleAdvanced).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid query edits into one URL update", async () => {
    const { onFiltersChange } = renderView();
    const search = screen.getByLabelText("搜索任务");

    fireEvent.change(search, { target: { value: "a" } });
    fireEvent.change(search, { target: { value: "ab" } });
    fireEvent.change(search, { target: { value: "abc" } });

    await waitFor(() => expect(onFiltersChange).toHaveBeenCalledTimes(1));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ query: "abc" }),
    );
  });

  it("waits for IME composition to end before syncing the query", async () => {
    const { onFiltersChange } = renderView();
    const search = screen.getByLabelText("搜索任务");

    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: "cece'shi" } });
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(onFiltersChange).not.toHaveBeenCalled();
    expect(search).toHaveValue("cece'shi");

    fireEvent.compositionEnd(search, { target: { value: "cece'shi" } });
    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenCalledWith(
        expect.objectContaining({ query: "cece'shi" }),
      ),
    );
  });

  it("routes the leftover entry through onOpenIssues", async () => {
    const { onOpenIssues } = renderView();
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: /遗留问题 3/ });
    // 2026-09-22（方案 A）：数量由裸文字改为数量签；签对辅助技术隐藏（与侧栏计数同口径），
    // 按钮名仍带数量，由 aria-label 显式给出，读屏与既有断言口径不变。
    expect(button.querySelector(".header-count")).toHaveTextContent("3");
    expect(button.querySelector(".header-count")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await user.click(button);
    expect(onOpenIssues).toHaveBeenCalledTimes(1);
  });

  it("renders an error alert when the adapter rejects", async () => {
    renderView({
      adapter: {
        source: "mock",
        notice: "测试失败路径",
        fetchMyTasks: () => Promise.reject(new Error("boom")),
        fetchTaskGroups: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
      },
    });
    expect(
      await screen.findByText("任务列表暂时不可用，请稍后重试。"),
    ).toBeInTheDocument();
  });

  it("renders task groups as cards inside the task grid", async () => {
    renderView();

    const card = await screen.findByTestId("my-task-group-501");
    // 2026-09-22 产品要求「组卡的布局要和 P2 一样」：组卡与任务卡同一套纵向排版，
    // 顶部「编号 + 徽章」行整行不再渲染，编号只留在列表视图与弹窗里。
    expect(card.querySelector(".calm-card-top")).toBeNull();
    expect(card.querySelector(".task-id")).toBeNull();
    expect(within(card).queryByText("TG-001")).toBeNull();
    expect(
      within(card).getByText("任务合并后来源分支历史保留"),
    ).toBeInTheDocument();
    expect(within(card).getByText("注入项目名")).toBeInTheDocument();
    // 2026-10-10：组卡与任务卡片同口径，右下角也有一枚项目水印。
    expect(
      card.querySelector(":scope > .project-logo.watermark")?.textContent,
    ).toBe("IN");
    expect(card.querySelector(".task-belonging .project-logo")).toBeNull();
    // 标签组（优先级 + 聚合组 + 状态）落到分隔线以下的左下角，与任务卡同款。
    const badges = card.querySelector(
      ".calm-card-bottom > .task-card-badges",
    ) as HTMLElement;
    expect(badges).not.toBeNull();
    // 底部那一排只留三枚徽章（2026-09-22 三次调整）：四个标签在 272px 卡片里必然折成
    // 三行，把底部那一排顶高；分支数改成「聚合组」徽章的 title，列表视图仍逐字给出。
    expect(within(badges).getByText("聚合组")).toBeInTheDocument();
    expect(
      within(badges).getByTitle(
        "聚合组：包含 4 条分支（主分支与全部来源分支）",
      ),
    ).toBeInTheDocument();
    expect(within(badges).getByText("进行中")).toBeInTheDocument();
    // 负责人单独一行贴在分隔线上方并右对齐：它是底部那一排的前一个兄弟节点。
    const assignee = card.querySelector(".calm-card-assignee") as HTMLElement;
    expect(assignee).not.toBeNull();
    expect(assignee.nextElementSibling).toBe(
      card.querySelector(".calm-card-bottom"),
    );
    // 分支明细不再复制到卡片上：卡片只给负责人、分支数与状态徽章。
    // mock 组 501 的四条分支都是同一人负责，去重后只有一个名字。
    expect(within(card).getByText("陈晓")).toBeInTheDocument();
    // 2026-09-22 三次调整（产品要求「组合任务的排版和单个任务排版对齐统一」）：分支完成
    // 计数不再单占右上角一行，改由状态徽章表达（任意分支完成 → 进行中），明细计数只留在
    // 徽章的 title 里；卡片首行回到标题，与任务卡片逐行同构。
    expect(card.querySelector(".task-group-card-top")).toBeNull();
    // 2026-10-10：卡片首个子元素变成右下角的项目水印（流外绝对定位），标题仍是首个内容行。
    expect(card.firstElementChild?.classList.contains("project-logo")).toBe(
      true,
    );
    expect(card.querySelector(":scope > h3")).not.toBeNull();
    const stateBadge = within(badges).getByText("进行中");
    expect(stateBadge).toHaveAttribute("title", "1 / 4 条分支任务已完成");
    // 右下角让给与任务卡片同款的截止（未完成分支中最早的一条：T-101 已逾期）。
    const cardDeadline = card.querySelector(
      ".calm-card-bottom > span:last-child",
    ) as HTMLElement;
    expect(cardDeadline).not.toBeNull();
    expect(cardDeadline).toHaveTextContent(/^已逾期 \d+月\d+日$/);
    expect(cardDeadline).toHaveAttribute(
      "title",
      expect.stringContaining("未完成分支中最早的截止"),
    );
    // 组优先级按未完成分支里的最高一档派生（分支 T-101 为紧急）：卡片显示
    // 优先级徽章并注明来源；该分支完成后自动落到第二高，见下一条用例。
    expect(within(card).getByText("紧急")).toBeInTheDocument();
    expect(
      within(card).getByTitle("优先级：紧急（未完成分支中最高）"),
    ).toBeInTheDocument();
    // 组卡配色跟随派生优先级（复用任务卡片的 .tone-prio-*）。2026-09-22 三次定案后逾期
    // 不再覆盖底色，组卡按未完成分支里的最高一档取色（T-101 为紧急），因此是紧急红；
    // 最早一条已逾期只体现在右下角日期文案（上一段已断言）。
    expect(card).toHaveClass("tone-prio-urgent");
    // 「查看详情 / 解除合并」提示已删除：整卡本身就是弹窗入口。
    expect(card.querySelector(".task-group-card-open")).toBeNull();
    expect(within(card).queryByText("查看详情 / 解除合并")).toBeNull();
    // 2026-10-08 产品要求「已完成和未完成任务卡片的布局也要一样大」：任务卡片的页脚改为
    // 恒渲染（空页脚由 CSS 的 min-height 占位），组卡也要补一个空页脚占位才能逐像素同高，
    // 因此这里不再断言 `.task-card-footer` 为 null，改成断言「存在且是空的」。
    const groupFooter = card.querySelector(".task-card-footer");
    expect(groupFooter).not.toBeNull();
    expect(groupFooter).toBeEmptyDOMElement();
    // 独立聚合组区块已删除：组卡与任务卡在同一网格里。
    expect(card.closest(".calm-task-grid")).not.toBeNull();
    expect(document.querySelector(".group-panel")).toBeNull();
  });

  it("lists aggregate groups in the same table when the list display mode is active", async () => {
    const { onOpenTask } = renderView({
      filters: { display: "list" },
      client: stubClient(projects),
    });
    const user = userEvent.setup();

    const table = await screen.findByRole("table", { name: "跨项目任务列表" });
    // 2026-09-22 产品要求：聚合组跟随「卡片 / 列表」切换，组行与任务行同表，
    // 不再以卡片网格追加在表格之后。
    const row = await screen.findByTestId("my-task-group-501");
    expect(row.tagName).toBe("TR");
    expect(row.closest("table")).toBe(table);
    expect(document.querySelector(".task-group-grid")).toBeNull();

    // 列语义与任务行对齐，归属 / 截止 / 迭代三列读真实派生值（2026-09-22 产品口径）：
    // 归属跟随主任务，截止取未完成分支中最早的一条，迭代汇总全部分支的 PUBLISHED 记录数。
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("任务合并后来源分支历史保留");
    expect(cells[0]).toHaveTextContent("TG-001 · 聚合组 · 4 条分支");
    expect(cells[1]).toHaveTextContent("注入项目名");
    expect(cells[2]).toHaveTextContent("任务与聚合");
    expect(cells[2]).toHaveAttribute("title", "归属跟随主任务：任务与聚合");
    expect(cells[3]).toHaveTextContent("陈晓");
    expect(within(cells[4]!).getByText("紧急")).toBeInTheDocument();
    // T-101 已逾期两天、T-102 今天到期：取更早的 T-101，文字色落到逾期的红档。
    expect(cells[5]).toHaveTextContent(/^已逾期 \d+月\d+日$/);
    expect(cells[5]).toHaveClass("due-overdue");
    expect(cells[5]).toHaveAttribute(
      "title",
      expect.stringContaining("未完成分支中最早的截止"),
    );
    // 迭代含已完成的 T-104（2 条）与主任务 T-102（3 条）：合计 5，不只算主任务。
    expect(cells[6]).toHaveTextContent("5");
    expect(within(cells[7]!).getByText("进行中")).toBeInTheDocument();
    // 组行与卡片同源（只吃浅色变量）：逾期不再改底色，整行落到派生优先级的紧急档浅底。
    expect(row).toHaveClass("tone-prio-urgent");

    // 组行是弹窗入口，与卡片一致：点击不回调 onOpenTask。
    await user.click(within(row).getByRole("button"));
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: /聚合组/ }),
    ).toBeInTheDocument();
  });

  it("lists every branch owner on the group card when members differ", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            // 第 2 条来源分支换人、第 4 条置回主任务负责人：卡片应去重后列出全部负责人。
            branches: group.branches.map((branch, index) =>
              index === 1
                ? {
                    ...branch,
                    assignee: { userId: 2, name: "王敏", avatarUrl: null },
                  }
                : branch,
            ),
          })),
        }),
      },
    });

    const card = await screen.findByTestId("my-task-group-501");
    // 主任务负责人在最前，其余负责人依次追加；同一人不重复出现。
    expect(within(card).getByText("陈晓、王敏")).toBeInTheDocument();
  });

  it("moves the group deadline to the next unfinished branch once the earliest one is done", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      filters: { display: "list" },
      client: stubClient(projects),
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            // 截止最早的 T-101 完成后，组截止自动顺延到下一个最近的未完成分支：T-102 今天到期。
            branches: group.branches.map((branch) =>
              branch.taskId === 101
                ? { ...branch, workStatus: "DONE" }
                : branch,
            ),
          })),
        }),
      },
    });

    const row = await screen.findByTestId("my-task-group-501");
    const cells = within(row).getAllByRole("cell");
    expect(cells[5]).toHaveTextContent("今天截止");
    expect(cells[5]).toHaveClass("due-soon");
    // 收尾分支的记录仍计入迭代合计；已取消的 T-107 没设截止，不参与截止取数。
    expect(cells[6]).toHaveTextContent("5");
  });

  it("labels the group deadline as unset when no unfinished branch has a due date", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      // 未完成分支全部收尾 → 组归「已完成」档，列表视图也要切到该档才看得到组行。
      filters: { display: "list", status: "done" },
      client: stubClient(projects),
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            // 两个未完成分支（T-101、T-102）都收尾后组里不再有未完成截止：
            // 与任务行同文案「未设置截止」，而不是列表里的占位符「—」。
            // 组因此落到「已完成」档，必须显式切到该档才能看到这一行（2026-09-22）。
            branches: group.branches.map((branch) =>
              branch.workStatus === "TODO"
                ? { ...branch, workStatus: "DONE" }
                : branch,
            ),
          })),
        }),
      },
    });

    const row = await screen.findByTestId("my-task-group-501");
    const cells = within(row).getAllByRole("cell");
    expect(cells[5]).toHaveTextContent("未设置截止");
    expect(cells[5]).toHaveAttribute(
      "title",
      "未完成分支都没有设置截止时间（分支截止见详情）",
    );
    // 无紧迫度就不加红档文字色，也不把历史上已完成分支的截止抬上来。
    expect(cells[5]).not.toHaveClass("due-overdue");
    expect(cells[5]).not.toHaveClass("due-soon");
    expect(cells[6]).toHaveTextContent("5");
  });

  it("falls back to the next highest branch priority after the urgent branch is done", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            // 紧急分支（T-101）完成后，组优先级落到剩下的最高一档：高（T-102）。
            branches: group.branches.map((branch) =>
              branch.taskId === 101
                ? { ...branch, workStatus: "DONE" }
                : branch,
            ),
          })),
        }),
      },
    });

    const card = await screen.findByTestId("my-task-group-501");
    expect(within(card).getByText("高")).toBeInTheDocument();
    expect(within(card).queryByText("紧急")).toBeNull();
    // 还有未完成分支，组仍是进行中；整卡底色落到剩下的最高一档「高」（浅底深字），
    // 与页脚徽章的优先级同源。
    expect(within(card).getByText("进行中")).toBeInTheDocument();
    expect(
      within(card).getByTitle("2 / 4 条分支任务已完成"),
    ).toBeInTheDocument();
    // 紧急分支 T-101 收尾后，最高一档变成「高」；今天到期的 T-102 不再覆盖底色
    // （2026-09-22 三次定案：逾期 / 今天到期不参与配色），整卡就是「高」那档明黄底，
    // 优先级徽章同为「高」。
    expect(card).toHaveClass("tone-prio-high");
  });

  it("marks the group complete when every branch is wound up", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      // 全部分支收尾的组归「已完成」那一档（工具栏筛选项），未完成档位下不再出现。
      filters: { status: "done" },
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            // 未完成分支全部收尾后，整卡按「已完成」呈现并隐藏优先级徽章；
            // 组本身仍未关闭，卡片保留解除合并入口。组同时从「未完成」档移出，
            // 所以这一档在「已完成」下断言（2026-09-22 产品口径）。
            branches: group.branches.map((branch) =>
              branch.workStatus === "TODO"
                ? { ...branch, workStatus: "DONE" }
                : branch,
            ),
          })),
        }),
      },
    });

    const card = await screen.findByTestId("my-task-group-501");
    expect(within(card).getByText("已完成")).toBeInTheDocument();
    expect(within(card).queryByText("进行中")).toBeNull();
    expect(within(card).queryByText("紧急")).toBeNull();
    expect(within(card).queryByText("高")).toBeNull();
    // 页脚只计 DONE：已取消的分支算收尾（不压着组优先级）、但不计入完成数。
    expect(
      within(card).getByTitle("3 / 4 条分支任务已完成"),
    ).toBeInTheDocument();
    // 组卡转「已完成」，与任务卡片共用同一套完成青碧（tone-prio-done）。
    expect(card).toHaveClass("tone-prio-done");
  });

  it("labels a group with no finished branch as 未开始 and keeps it in the open view", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            // 已完成 / 已取消的分支都置回未完成：组内没有任何分支完成 →「未开始」。
            branches: group.branches.map((branch) => ({
              ...branch,
              workStatus: "TODO",
            })),
          })),
        }),
      },
    });

    const card = await screen.findByTestId("my-task-group-501");
    expect(within(card).getByText("未开始")).toBeInTheDocument();
    expect(within(card).queryByText("进行中")).toBeNull();
    expect(
      within(card).getByTitle("0 / 4 条分支任务已完成"),
    ).toBeInTheDocument();
    // 所有分支置回未完成后，组内最高一档仍是紧急的 T-101，整卡取紧急红；已逾期的 T-101
    // 不再让底色变成日期档（2026-09-22 三次定案：逾期不参与配色）。
    expect(card).toHaveClass("tone-prio-urgent");
  });

  it("moves a fully wound up group out of the open view", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          items: groups.items.map((group) => ({
            ...group,
            branches: group.branches.map((branch) =>
              branch.workStatus === "TODO"
                ? { ...branch, workStatus: "DONE" }
                : branch,
            ),
          })),
        }),
      },
    });

    // 未完成档位下组卡不再出现：组内分支全部收尾后，组的入口只留在「已完成」档；
    // 未入组的 T-103 照常出卡片，说明只是组卡被移走，列表没有整体变空。
    expect(await screen.findByTestId("my-task-103")).toBeInTheDocument();
    expect(screen.queryByTestId("my-task-group-501")).toBeNull();
  });

  it("sorts open groups by the highest unfinished branch priority", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    const base = groups.items[0]!;
    const variant = (
      groupId: number,
      name: string,
      priority: MyTaskPriority,
    ) => ({
      ...base,
      groupId,
      name,
      // 全部置回未完成并清掉截止：底色只由派生优先级决定，排序断言不被截止档干扰。
      branches: base.branches.map((branch) => ({
        ...branch,
        workStatus: "TODO" as const,
        priority,
        dueAt: null,
      })),
    });
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          ...groups,
          // R-7 按 id 倒序返回：普通 → 紧急 → 高；排序必须由前端按派生优先级收敛。
          items: [
            variant(903, "普通优先级的组", "NORMAL"),
            variant(902, "紧急优先级的组", "URGENT"),
            variant(901, "高优先级的组", "HIGH"),
          ],
        }),
      },
    });

    const cards = await screen.findAllByTestId(/^my-task-group-/);
    expect(cards.map((card) => card.getAttribute("data-testid"))).toEqual([
      "my-task-group-902",
      "my-task-group-901",
      "my-task-group-903",
    ]);
    // 没有未完成截止时不触发截止档，底色就是各组的派生优先级那一档。
    expect(cards[0]).toHaveClass("tone-prio-urgent");
    expect(cards[1]).toHaveClass("tone-prio-high");
    expect(cards[2]).toHaveClass("tone-prio-normal");
  });

  it("组卡与任务卡同一顺序：同优先级按截止日期从近到远", async () => {
    const now = new Date();
    const dayOffset = (offsetDays: number) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + offsetDays,
        18,
        0,
        0,
      ).toISOString();
    const mockGroups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    const baseGroup = mockGroups.items[0]!;
    const openItem = (over: Partial<MyTaskListItem>): MyTaskListItem => ({
      ...doneTask,
      workStatus: "TODO",
      completedAt: null,
      dueAt: null,
      ...over,
    });
    renderView({
      adapter: serverLikeAdapterWith(
        [
          openItem({
            taskId: 921,
            code: "INP-921",
            priority: "HIGH",
            dueAt: dayOffset(23),
          }),
          openItem({ taskId: 922, code: "INP-922", dueAt: null }),
        ],
        [
          {
            ...baseGroup,
            groupId: 930,
            branches: baseGroup.branches.map((branch) => ({
              ...branch,
              workStatus: "TODO" as const,
              priority: "NORMAL" as const,
              dueAt: dayOffset(-6),
            })),
          },
        ],
      ),
    });

    await screen.findByTestId("my-task-group-930");
    // 2026-09-22 产品口径「（它们）同样是一个优先级的，按照截止日期从近到远排序」：组卡不再
    // 固定追加在网格尾部，而与任务卡共用同一把尺子（状态分组 → 紧急桶 → 优先级 →
    // 遗留问题来源 → 截止时间）。组卡取未完成分支里最早的一条作为自己的截止，本例已逾期 →
    // 紧急桶 1，与逾期任务卡同口径：
    // 排在所有未逾期任务（含高优先级）之前；同为普通优先级时，也排在未设截止的任务卡之前。
    expect(
      screen
        .getAllByTestId(/^my-task-(92[12]|group-930)$/)
        .map((node) => node.getAttribute("data-testid")),
    ).toEqual(["my-task-group-930", "my-task-921", "my-task-922"]);
  });

  it("同优先级内按截止日期从近到远，未设截止排最后", async () => {
    const now = new Date();
    const dayOffset = (offsetDays: number) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + offsetDays,
        18,
        0,
        0,
      ).toISOString();
    const openItem = (over: Partial<MyTaskListItem>): MyTaskListItem => ({
      ...doneTask,
      workStatus: "TODO",
      completedAt: null,
      ...over,
    });
    // 造数刻意打乱：三张同为普通优先级，期望按 8 天后 → 3 天后 → 未设截止 收敛。
    renderView({
      adapter: serverLikeAdapterWith([
        openItem({ taskId: 931, code: "INP-931", dueAt: null }),
        openItem({ taskId: 932, code: "INP-932", dueAt: dayOffset(8) }),
        openItem({ taskId: 933, code: "INP-933", dueAt: dayOffset(3) }),
      ]),
    });

    await screen.findByTestId("my-task-931");
    expect(
      screen
        .getAllByTestId(/^my-task-93[123]$/)
        .map((node) => node.getAttribute("data-testid")),
    ).toEqual(["my-task-933", "my-task-932", "my-task-931"]);
  });

  it("遗留问题来源只在同优先级内提前，不越过更高优先级", async () => {
    const now = new Date();
    const overdueAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 2,
      18,
      0,
      0,
    ).toISOString();
    const openItem = (over: Partial<MyTaskListItem>): MyTaskListItem => ({
      ...doneTask,
      workStatus: "TODO",
      completedAt: null,
      dueAt: null,
      ...over,
    });
    // 造数刻意打乱：遗留问题来源卡最后传入，且优先级低于 HIGH 任务。
    // 2026-09-24 产品定案「遗留问题只会在同优先级里面高一点……以后不管是别人拉取还是，
    // 都要以这个为准」：紧急桶只有 标记紧急(0) → 已逾期(1) → 今/明日截止(2) → 其余(3)，
    // 遗留问题来源是优先级之后的独立一级——952 因此在同为普通优先级的 953 之前提前，
    // 但排在更高优先级的 951 之后；优先级更高的任务永远不被遗留问题来源越过。
    renderView({
      adapter: serverLikeAdapterWith([
        openItem({ taskId: 951, code: "INP-951", priority: "HIGH" }),
        openItem({ taskId: 953, code: "INP-953" }),
        openItem({ taskId: 952, code: "INP-952", hasLeftoverSource: true }),
        openItem({ taskId: 954, code: "INP-954", dueAt: overdueAt }),
      ]),
    });

    await screen.findByTestId("my-task-951");
    expect(
      screen
        .getAllByTestId(/^my-task-95[1234]$/)
        .map((node) => node.getAttribute("data-testid")),
    ).toEqual(["my-task-954", "my-task-951", "my-task-952", "my-task-953"]);
  });

  it("已完成按完成时间从晚到早排序，优先级不参与", async () => {
    const completedItem = (over: Partial<MyTaskListItem>): MyTaskListItem => ({
      ...doneTask,
      dueAt: null,
      ...over,
    });
    // 造数刻意让优先级与完成时间相反：只按完成时间收敛才可能得到 942 → 943 → 941。
    renderView({
      adapter: serverLikeAdapterWith([
        completedItem({
          taskId: 941,
          code: "INP-941",
          priority: "URGENT",
          completedAt: "2026-09-01T00:00:00.000Z",
        }),
        completedItem({
          taskId: 942,
          code: "INP-942",
          priority: "HIGH",
          completedAt: "2026-09-12T00:00:00.000Z",
        }),
        completedItem({
          taskId: 943,
          code: "INP-943",
          priority: "NORMAL",
          completedAt: "2026-09-06T00:00:00.000Z",
        }),
      ]),
      filters: { status: "done" },
    });

    await screen.findByTestId("my-task-941");
    // 2026-09-22 产品口径「这个排序按照完成时间，越晚越排前面」：服务端 task-list-order.ts
    // 在状态分组之后新增「完成时间倒序」一级，前端按同一把尺子复现（时间戳取负参与升序），
    // 因此已完成卡片不再按优先级 / 截止排，越晚完成越靠前。
    expect(
      screen
        .getAllByTestId(/^my-task-94[123]$/)
        .map((node) => node.getAttribute("data-testid")),
    ).toEqual(["my-task-942", "my-task-943", "my-task-941"]);
  });

  it("keeps a fully wound-up task group out of the unfinished view", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      filters: { status: "open" },
      adapter: serverLikeAdapterWith(
        [],
        groups.items.map((group) => ({
          ...group,
          // 全部分支收尾的组属于「已完成」：未完成档不再留着它（2026-09-22 产品口径）。
          branches: group.branches.map((branch) => ({
            ...branch,
            workStatus: "DONE",
          })),
        })),
      ),
    });

    expect(await screen.findByText("没有匹配的未完成任务")).toBeInTheDocument();
    expect(screen.queryByTestId("my-task-group-501")).toBeNull();
  });

  it("keeps a group with unfinished branches out of the finished view", async () => {
    const groups = await MY_TASKS_MOCK_ADAPTER.fetchTaskGroups({
      projectId: null,
      cursor: null,
    });
    renderView({
      filters: { status: "done" },
      // mock 组 501 仍有未完成分支（进行中）：已完成档只收全部分支收尾的组。
      adapter: serverLikeAdapterWith([], groups.items),
    });

    expect(await screen.findByText("没有匹配的已完成任务")).toBeInTheDocument();
    expect(screen.queryByTestId("my-task-group-501")).toBeNull();
  });

  it("opens the task group detail dialog from the group card", async () => {
    const { onOpenTask } = renderView({ client: stubClient(projects) });
    const user = userEvent.setup();
    const card = await screen.findByTestId("my-task-group-501");

    await user.click(card);

    // 组卡是弹窗入口：分支任务与主任务入口都在弹窗里，卡片点击不再回调 onOpenTask。
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: /聚合组/ }),
    ).toBeInTheDocument();
  });

  it("keeps task cards visible without a group empty state when there are no groups", async () => {
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
      },
    });
    // 空聚合组不再单列空态区块：任务卡片照常呈现，页面上没有组卡。
    expect(await screen.findByTestId("my-task-101")).toBeInTheDocument();
    expect(screen.queryByTestId("my-task-group-501")).toBeNull();
    expect(screen.queryByText("还没有聚合组")).toBeNull();
  });

  it("keeps the task list visible with an error alert when groups fail", async () => {
    renderView({
      adapter: {
        ...MY_TASKS_MOCK_ADAPTER,
        fetchTaskGroups: () => Promise.reject(new Error("boom")),
      },
    });
    // 聚合组读取失败不隐藏任务卡片：错误就地提示在列表下方。
    expect(await screen.findByTestId("my-task-101")).toBeInTheDocument();
    expect(
      await screen.findByText("任务列表暂时不可用，请稍后重试。"),
    ).toBeInTheDocument();
  });

  it("hides the card of a task that is already merged into a group", async () => {
    renderView();

    // T-102 是聚合组 501 的主任务（groupRole=MAIN）：卡片不再单独渲染，入口收敛到
    // 聚合组卡片；未入组的 T-103 照常出卡片。
    expect(await screen.findByTestId("my-task-103")).toBeInTheDocument();
    expect(await screen.findByTestId("my-task-group-501")).toBeInTheDocument();
    expect(screen.queryByTestId("my-task-102")).toBeNull();
  });

  it("marks merge role, priority and record count on member cards opened by the merge filter", async () => {
    // 合并关系筛选是查看已合并任务本身的唯一入口，这条路径下卡片保留且徽章完整。
    renderView({ filters: { relation: "MAIN" } });

    const merged = await screen.findByTestId("my-task-102");
    expect(within(merged).getByText("主任务")).toBeInTheDocument();
    expect(within(merged).getByText("高")).toBeInTheDocument();
    expect(within(merged).getByTitle("优先级：高")).toBeInTheDocument();
    expect(within(merged).getByText("记录 3 条")).toBeInTheDocument();
  });

  it("marks priority and omits the record badge on a standalone card", async () => {
    renderView();

    const plain = await screen.findByTestId("my-task-103");
    expect(within(plain).getByText("普通")).toBeInTheDocument();
    expect(within(plain).getByTitle("优先级：普通")).toBeInTheDocument();
    expect(within(plain).queryByText(/记录/)).toBeNull();
  });

  it("names the priority dimension on the empty option and keeps tier labels short", async () => {
    renderView();

    const field = await screen.findByLabelText("优先级");
    const trigger = field.closest(".ant-select");
    if (!trigger) {
      throw new Error("select trigger not found for 优先级");
    }
    fireEvent.mouseDown(trigger);
    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent?.trim() ?? "");
    // 空值项必须写明这是优先级筛选：工具栏里没有重复的文字标签（产品已删除），
    // 只显示「全部」时看不出维度。口径与任务看板 TaskBoardToolbar 的同名选项一致。
    expect(labels).toEqual(["全部优先级", "紧急", "高", "普通"]);
    // 具体档位仍是两个字，保持工具栏紧凑；只有空值项带维度名。
    for (const label of labels.slice(1)) {
      expect([...label].length).toBeLessThanOrEqual(2);
    }
  });

  it("offers an enabled create action that opens the cross-project form", async () => {
    renderView({ client: stubClient(projects) });
    const user = userEvent.setup();

    const create = screen.getByRole("button", { name: /新建任务/ });
    expect(create).toBeEnabled();
    expect(create).not.toHaveAttribute("title");

    await user.click(create);

    expect(
      await screen.findByRole("heading", { name: "新建任务" }),
    ).toBeInTheDocument();
    const projectField = screen.getByLabelText("所属项目");
    expect(projectField).toBeInTheDocument();
    expect(screen.getByLabelText("所属模块")).toBeInTheDocument();
    expect(screen.getByLabelText("指派给")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建任务" })).toBeDisabled();
    const projectTrigger = projectField.closest(".ant-select");
    if (!projectTrigger) {
      throw new Error("select trigger not found for 所属项目");
    }
    fireEvent.mouseDown(projectTrigger);
    expect(await screen.findByTitle("注入项目名")).toBeInTheDocument();
  });

  it("prefills the project when the view is scoped to a single project", async () => {
    renderView({
      client: stubClient(projects),
      filters: { scope: "project", projectId: 5 },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /新建任务/ }));

    const projectField = await screen.findByLabelText("所属项目");
    await waitFor(() =>
      expect(projectField.closest(".ant-select")).toHaveTextContent("订单中台"),
    );
    expect(screen.getByLabelText("所属模块")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "创建任务" })).toBeDisabled();
  });

  it("narrows loaded tasks locally and says so when the server has no parameter", async () => {
    renderView({
      adapter: serverLikeAdapter(),
      filters: { query: "登录" },
    });

    expect(await screen.findByTestId("my-task-101")).toBeInTheDocument();
    expect(screen.queryByTestId("my-task-102")).toBeNull();
    expect(screen.queryByTestId("my-task-106")).toBeNull();
    expect(
      await screen.findByTestId("task-center-local-note"),
    ).toHaveTextContent("关键词搜索");
  });

  it("keeps the locally computable filters usable instead of disabling them", async () => {
    renderView({
      adapter: serverLikeAdapter(),
      advancedOpen: true,
      filters: { relation: "MAIN" },
    });

    expect(screen.getByLabelText("搜索任务")).toBeEnabled();
    expect(screen.getByLabelText("合并关系")).toBeEnabled();
    expect(screen.getByLabelText("是否有 GitHub")).toBeEnabled();
    expect(screen.queryByTestId("my-task-101")).toBeNull();
    expect(await screen.findByTestId("my-task-102")).toBeInTheDocument();
  });

  it("keeps the project filter and the locally computable filters usable", async () => {
    renderView({ adapter: serverLikeAdapter() });

    expect(await screen.findByTestId("my-task-101")).toBeInTheDocument();
    expect(screen.getByLabelText("项目")).toBeEnabled();
    expect(screen.getByLabelText("搜索任务")).toBeEnabled();
    expect(screen.queryByTestId("task-center-local-note")).toBeNull();
    // 服务端适配器下不出现骨架数据提示（设计师稿 task-center.tsx 无此元素）。
    expect(screen.queryByTestId("task-center-mock-notice")).toBeNull();
    expect(screen.queryByText(/骨架数据/)).toBeNull();
  });

  it("renders a server-provided scope without scope tabs or stat cards", async () => {
    renderView({
      adapter: serverLikeAdapter(),
      filters: { scope: "created", status: "all" },
    });

    // URL 里仍可携带 scope=created（任务中心不删除该参数），页面按工具栏工作状态渲染
    // 列表：不再有任何范围 tab，也不再有统计卡。
    expect(await screen.findByTestId("my-task-101")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "全部任务" })).toBeNull();
    expect(screen.queryByTestId("stat-created")).toBeNull();
    expect(document.querySelector(".stats-grid")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: /全部任务/ })).toBeNull();
    // status=all 不属于「未完成 / 已完成」任何一档：两个档位都不高亮。
    const statusFilter = screen.getByRole("group", { name: "工作状态" });
    expect(
      within(statusFilter).getByRole("button", { name: "未完成" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(statusFilter).getByRole("button", { name: "已完成" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("整卡按优先级铺色：逾期与今天到期都不再改色，已完成仍是完成青碧", async () => {
    const now = new Date();
    const dayOffset = (offsetDays: number) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + offsetDays,
        18,
        0,
        0,
      ).toISOString();
    const openItem = (over: Partial<MyTaskListItem>): MyTaskListItem => ({
      ...doneTask,
      workStatus: "TODO",
      completedAt: null,
      dueAt: null,
      ...over,
    });
    renderView({
      adapter: serverLikeAdapterWith([
        openItem({ taskId: 801, code: "INP-801", dueAt: dayOffset(-3) }),
        openItem({ taskId: 802, code: "INP-802", dueAt: dayOffset(0) }),
        openItem({
          taskId: 803,
          code: "INP-803",
          workStatus: "DONE",
          completedAt: "2026-09-03T00:00:00.000Z",
          dueAt: dayOffset(-3),
        }),
      ]),
      filters: { status: "all" },
    });
    const cardOf = (taskId: number): HTMLElement =>
      screen.getByTestId("my-task-" + taskId);
    await screen.findByTestId("my-task-801");
    // 2026-09-22 三次定案：卡片按任务自己的优先级铺色（这三张都是普通优先级），
    // 已逾期 / 今天到期不换整卡底色；2026-09-23 十一次定案起右下角那行文案本身按
    // 紧迫度染色（类名与列表截止列同源），已完成不提示逾期所以类名缺席。
    expect(cardOf(801)).toHaveClass("calm-task-card", "tone-prio-normal");
    expect(cardOf(802)).toHaveClass("calm-task-card", "tone-prio-normal");
    expect(cardOf(801)).toHaveTextContent(/已逾期/);
    expect(cardOf(802)).toHaveTextContent("今天截止");
    const dueSpanOf = (card: HTMLElement): HTMLElement =>
      card.querySelector(".calm-card-bottom > span:last-child") as HTMLElement;
    expect(dueSpanOf(cardOf(801))).toHaveClass("due-overdue");
    expect(dueSpanOf(cardOf(802))).toHaveClass("due-soon");
    // 已完成走状态色，卡上也不再挂红色日期签。
    expect(cardOf(803)).toHaveClass("calm-task-card", "tone-prio-done");
    expect(within(cardOf(803)).getByTitle(/^截止：/).className).toBe("");
  });

  it("列表视图是白底表面：整卡不铺红，只把截止列染成深红 / 橙红", async () => {
    const now = new Date();
    const dayOffset = (offsetDays: number) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + offsetDays,
        18,
        0,
        0,
      ).toISOString();
    const openItem = (over: Partial<MyTaskListItem>): MyTaskListItem => ({
      ...doneTask,
      workStatus: "TODO",
      completedAt: null,
      dueAt: null,
      ...over,
    });
    renderView({
      adapter: serverLikeAdapterWith([
        openItem({ taskId: 811, code: "INP-811", dueAt: dayOffset(-3) }),
        openItem({ taskId: 812, code: "INP-812", dueAt: dayOffset(0) }),
        openItem({
          taskId: 813,
          code: "INP-813",
          workStatus: "DONE",
          completedAt: "2026-09-03T00:00:00.000Z",
          dueAt: dayOffset(-3),
        }),
      ]),
      filters: { status: "all", display: "list" },
    });
    const table = await screen.findByRole("table", { name: "跨项目任务列表" });
    const dueIndex = within(table)
      .getAllByRole("columnheader")
      .findIndex((node) => node.textContent === "截止");
    const dueCellOf = (code: string): HTMLElement => {
      const row = screen
        .getByText(new RegExp("^" + code))
        .closest("tr") as HTMLElement;
      return within(row).getAllByRole("cell")[dueIndex] as HTMLElement;
    };
    expect(dueCellOf("INP-811")).toHaveClass("due-overdue");
    expect(dueCellOf("INP-812")).toHaveClass("due-soon");
    // 已完成不参与红档，截止列回到默认字色。
    expect(dueCellOf("INP-813").className).toBe("");
  });

  it("列表模式整行可点：点非标题列也能打开任务，标题按钮不会触发两次", async () => {
    const item: MyTaskListItem = {
      ...doneTask,
      taskId: 821,
      code: "INP-821",
      title: "整行可点-821",
      workStatus: "TODO",
      completedAt: null,
    };
    const { onOpenTask } = renderView({
      adapter: serverLikeAdapterWith([item]),
      filters: { status: "all", display: "list" },
    });
    const user = userEvent.setup();

    await screen.findByRole("table", { name: "跨项目任务列表" });
    const row = screen.getByText(/^INP-821/).closest("tr") as HTMLElement;
    const cells = within(row).getAllByRole("cell");
    // 2026-09-23 十二次定案：热区从「任务」列标题扩到整行的横向区域。点最后一列（状态）
    // 这种跟标题无关的位置同样要打开任务，且只开一次。
    await user.click(cells[cells.length - 1]!);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith({
      projectId: 1,
      moduleId: 11,
      taskId: 821,
    });

    // 标题按钮仍是唯一键盘入口；行级热区命中按钮时让位给按钮自己，不会各开一次。
    await user.click(within(row).getByRole("button"));
    expect(onOpenTask).toHaveBeenCalledTimes(2);
  });

  it("列表模式整行可点：点聚合组行的非标题列也能打开组弹窗", async () => {
    const { onOpenTask } = renderView({
      filters: { display: "list" },
      client: stubClient(projects),
    });
    const user = userEvent.setup();

    const row = await screen.findByTestId("my-task-group-501");
    // 项目列与组名无关，改口径前点它不会打开任何弹窗。
    await user.click(within(row).getAllByRole("cell")[1]!);
    expect(
      await screen.findByRole("dialog", { name: /聚合组/ }),
    ).toBeInTheDocument();
    // 组行是弹窗入口：不开任务，也不回调 onOpenTask。
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("列表模式整行可点：行内已有拖选时不打开任务", async () => {
    const { onOpenTask } = renderView({
      adapter: serverLikeAdapterWith([
        {
          ...doneTask,
          taskId: 831,
          code: "INP-831",
          title: "拖选保护-831",
          workStatus: "TODO",
          completedAt: null,
        },
      ]),
      filters: { status: "all", display: "list" },
    });

    await screen.findByRole("table", { name: "跨项目任务列表" });
    const row = screen.getByText(/^INP-831/).closest("tr") as HTMLElement;
    // 用户想复制标题 / 编号时会先拖选，此时点行不该弹详情。
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(row);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(row);
    expect(onOpenTask).not.toHaveBeenCalled();
    selection?.removeAllRanges();

    // 选区清空后同一位置恢复可点（确认上一步是被选区挡下，不是热区失效）。
    fireEvent.click(row);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });
});

it("clears overdue when opening completed tasks", async () => {
  const { onFiltersChange } = renderView({ filters: { overdue: true } });
  await userEvent.click(
    within(screen.getByRole("group", { name: "工作状态" })).getByRole(
      "button",
      { name: "已完成" },
    ),
  );
  expect(onFiltersChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "done", overdue: false }),
  );
});

it("loads the next page and keeps previously loaded tasks", async () => {
  const fetchMyTasks = vi.fn(
    async (input: Parameters<MyTasksAdapter["fetchMyTasks"]>[0]) => ({
      ...(await MY_TASKS_MOCK_ADAPTER.fetchMyTasks(input)),
      items: [
        {
          ...doneTask,
          taskId: input.cursor ? 902 : 901,
          title: input.cursor ? "第二页任务" : "第一页任务",
          workStatus: "TODO" as const,
        },
      ],
      nextCursor: input.cursor ? null : "next-page",
      hasMore: !input.cursor,
    }),
  );
  renderView({ adapter: { ...MY_TASKS_MOCK_ADAPTER, fetchMyTasks } });
  await userEvent.click(
    await screen.findByRole("button", { name: "加载更多任务" }),
  );
  expect(await screen.findByText("第二页任务")).toBeVisible();
  expect(screen.getByText("第一页任务")).toBeVisible();
  expect(fetchMyTasks).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "next-page" }),
  );
  expect(screen.queryByRole("button", { name: "加载更多任务" })).toBeNull();
});

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  InpulseApiClient,
  TaskBoardCard,
  TaskBoardResponse,
  TaskGroupMembershipItem,
  UserRef,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";

import { TaskBoardPageView } from "./TaskBoardPageView";
import { DEFAULT_TASK_BOARD_FILTERS } from "./task-board-filters";
import type { TaskBoardAdapter, TaskBoardFilters } from "./task-board-types";

function cardOf(overrides: Partial<TaskBoardCard> = {}): TaskBoardCard {
  return {
    taskId: 1,
    code: "T-1001",
    title: "实现任务看板",
    moduleId: 3,
    priority: "NORMAL",
    workStatus: "TODO",
    dueAt: "2026-09-17T18:30:00.000Z",
    completedAt: null,
    dueState: "TODAY",
    assignees: [{ userId: 9, name: "张启明", avatarUrl: null }],
    publishedRecordCount: 0,
    ...overrides,
  };
}

const response: TaskBoardResponse = {
  project: { projectId: 7, name: "支付中心", status: "ACTIVE" },
  generatedAt: "2026-09-17T06:20:00.000Z",
  stats: {
    total: 42,
    done: 27,
    open: 12,
    canceled: 3,
    overdue: 3,
    dueToday: 2,
    completedThisWeek: 5,
    completionRate: 69,
    memberCount: 4,
  },
  modules: [
    {
      moduleId: 3,
      name: "调度模块",
      stats: {
        total: 30,
        done: 25,
        open: 4,
        canceled: 1,
        overdue: 1,
        completionRate: 86,
      },
      assignees: [{ userId: 9, name: "张启明", avatarUrl: null }],
      tasks: [
        cardOf({
          assignees: [
            { userId: 9, name: "张启明", avatarUrl: null },
            { userId: 4, name: "林沐", avatarUrl: null },
          ],
        }),
        cardOf({
          taskId: 2,
          code: "T-1002",
          title: "补齐看板筛选",
          workStatus: "DONE",
          dueState: "NONE",
          completedAt: "2026-09-17T18:30:00.000Z",
          publishedRecordCount: 2,
        }),
      ],
    },
    {
      moduleId: 4,
      name: "结算模块",
      stats: {
        total: 12,
        done: 2,
        open: 8,
        canceled: 2,
        overdue: 2,
        completionRate: 20,
      },
      assignees: [],
      tasks: [
        cardOf({
          taskId: 3,
          code: "T-1003",
          title: "结算对账",
          moduleId: 4,
          workStatus: "CANCELED",
          dueState: "NONE",
          dueAt: null,
        }),
      ],
    },
  ],
  truncated: false,
};

const emptyResponse: TaskBoardResponse = {
  project: response.project,
  generatedAt: response.generatedAt,
  stats: {
    total: 0,
    done: 0,
    open: 0,
    canceled: 0,
    overdue: 0,
    dueToday: 0,
    completedThisWeek: 0,
    completionRate: 0,
    memberCount: 0,
  },
  modules: [],
  truncated: false,
};

interface RenderOptions {
  readonly response?: TaskBoardResponse;
  readonly filters?: TaskBoardFilters;
  readonly marks?: readonly TaskGroupMembershipItem[];
  /** 项目活跃成员名单：用来验证负责人被移出项目后的标记。 */
  readonly activeMembers?: { items: readonly UserRef[] };
  readonly onFiltersChange?: (next: TaskBoardFilters) => void;
  readonly onOpenModules?: () => void;
}

/** 裁决修订 D-2：R-5 条目，未入组以 null 返回，只关心遗留问题来源标记。 */
function membershipOf(
  taskId: number,
  hasLeftoverSource: boolean,
): TaskGroupMembershipItem {
  return {
    taskId,
    groupId: null,
    groupRole: null,
    publishedRecordCount: 0,
    hasLeftoverSource,
  };
}

function renderView(options: RenderOptions = {}) {
  const fetchTaskBoard = vi
    .fn()
    .mockResolvedValue(options.response ?? response);
  const listTaskGroupMemberships = vi
    .fn()
    .mockResolvedValue({ items: options.marks ?? [] });
  // 负责人脱钩判定要读项目活跃成员：默认让夹具里的负责人（9 号张启明、4 号林沐）
  // 都还在成员名单里，只有用例显式传 activeMembers 时才构造「已移出项目」。
  const listActiveProjectMembers = vi.fn().mockResolvedValue(
    options.activeMembers ?? {
      items: [
        { id: 9, name: "张启明", avatarUrl: null },
        { id: 4, name: "林沐", avatarUrl: null },
      ],
    },
  );
  const adapter: TaskBoardAdapter = {
    source: "test",
    notice: "测试看板骨架",
    fetchTaskBoard,
  };
  const onFiltersChange = options.onFiltersChange ?? vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
            isAdmin: false,
            status: "ACTIVE",
          },
        }}
      >
        <TaskBoardPageView
          projectId={7}
          filters={options.filters ?? DEFAULT_TASK_BOARD_FILTERS}
          onFiltersChange={onFiltersChange}
          adapter={adapter}
          client={
            {
              listTaskGroupMemberships,
              listActiveProjectMembers,
            } as unknown as InpulseApiClient
          }
          onOpenModules={options.onOpenModules ?? vi.fn()}
        />
      </AuthStateProvider>
    </QueryClientProvider>,
  );
  return {
    fetchTaskBoard,
    listTaskGroupMemberships,
    listActiveProjectMembers,
    onFiltersChange,
  };
}

describe("TaskBoardPageView", () => {
  it("按模块泳道渲染看板，顶部统计为项目全量口径", async () => {
    const { fetchTaskBoard } = renderView();

    expect(
      await screen.findByRole("img", { name: "项目完成率 69%" }),
    ).toBeInTheDocument();
    expect(fetchTaskBoard).toHaveBeenCalledWith({ projectId: 7 });
    expect(screen.getByText("已完成 27 / 42")).toBeInTheDocument();
    expect(
      screen.getByText("未完成 12 · 逾期 3 · 今日到期 2"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /支付中心 · 数据截至 2026-09-17 14:20/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "模块 调度模块" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "模块 结算模块" }),
    ).toBeInTheDocument();
    // 卡片配色与列表行同源：优先级决定底色，已完成 / 已取消覆盖状态色。2026-09-22
    // 三次定案后已逾期 / 今天到期不再覆盖底色，这张卡服务端口径虽是今天到期，
    // 整卡仍按自己的普通优先级取普通蓝（逾期只在日期文案上提示）。
    expect(
      screen.getByRole("button", { name: "打开任务 T-1001 实现任务看板" }),
    ).toHaveClass("tb-card", "tone-prio-normal");
    expect(
      screen.getByRole("button", { name: "打开任务 T-1002 补齐看板筛选" }),
    ).toHaveClass("tb-card", "tone-prio-done");
    expect(
      screen.getByRole("button", { name: "打开任务 T-1003 结算对账" }),
    ).toHaveClass("tb-card", "tone-prio-canceled");
    expect(screen.getByText("完成 09-18 · 迭代 2")).toBeInTheDocument();
    // ADR-040 平权集合：卡片列出全部负责人，不再只显示 min(user_id)。
    expect(screen.getByText("张启明、林沐")).toBeInTheDocument();
  });

  it("筛选只影响卡片与泳道，顶部完成率仍为全量口径", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderView({
      filters: { ...DEFAULT_TASK_BOARD_FILTERS, status: "done" },
      onFiltersChange,
    });

    expect(
      await screen.findByRole("img", { name: "项目完成率 69%" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/筛选结果 1 \/ 42/)).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "模块 调度模块" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "模块 结算模块" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_TASK_BOARD_FILTERS);
  });

  it("点列表切换时把视图写回筛选状态", async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderView();
    await screen.findByRole("img", { name: "项目完成率 69%" });

    await user.click(screen.getByRole("button", { name: "列表" }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_TASK_BOARD_FILTERS,
      view: "list",
    });
  });

  it("列表视图渲染分组表格行", async () => {
    renderView({ filters: { ...DEFAULT_TASK_BOARD_FILTERS, view: "list" } });

    const row = await screen.findByRole("button", {
      name: "打开任务 T-1003 结算对账",
    });
    expect(within(row).getByText("已取消")).toBeInTheDocument();
    // 行配色：优先级决定底色（tone 类），已取消覆盖状态色。
    // 这两行都是「普通」任务：「普通」是白底卡，列表行取同族的近白中性一套，2026-09-23 起
    // 由原「低」的 tone-gray 承担（此前「普通」是蓝卡，这里断言的是 tone-blue）。
    expect(row).toHaveClass("tb-row", "tb-row--tone-gray", "tb-row--canceled");

    const doneRow = screen.getByRole("button", {
      name: "打开任务 T-1002 补齐看板筛选",
    });
    expect(doneRow).toHaveClass("tb-row", "tb-row--tone-gray", "tb-row--done");

    // ADR-040 平权集合：列表行同样列出全部负责人。
    const multiOwnerRow = screen.getByRole("button", {
      name: "打开任务 T-1001 实现任务看板",
    });
    expect(within(multiOwnerRow).getByText("张启明、林沐")).toBeInTheDocument();
  });

  it("检索无命中时提示调整筛选并保留清除入口", async () => {
    renderView({
      filters: { ...DEFAULT_TASK_BOARD_FILTERS, query: "不存在的任务" },
    });

    expect(
      await screen.findByText("没有匹配筛选条件的任务"),
    ).toBeInTheDocument();
    const empty = document.querySelector(".tb-empty");
    expect(empty).not.toBeNull();
    expect(
      within(empty as HTMLElement).getByRole("button", { name: "清除筛选" }),
    ).toBeInTheDocument();
  });

  it("空项目引导前往模块创建第一个任务", async () => {
    const user = userEvent.setup();
    const onOpenModules = vi.fn();
    renderView({ response: emptyResponse, onOpenModules });

    expect(await screen.findByText("项目还没有任务")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "前往模块" }));
    expect(onOpenModules).toHaveBeenCalledTimes(1);
  });

  it("截断时提示列表已按排序截断且统计仍为全量口径", async () => {
    renderView({ response: { ...response, truncated: true } });

    // 骨架屏也带 role="status"（首屏等待会被读屏播报），所以这里按文案定位，
    // 再回查截断提示自身确实带 role="status"，断言强度不变。
    const notice = await screen.findByText(/任务超过 1000 条/);
    expect(notice.closest(".tb-notice")).toHaveAttribute("role", "status");
  });

  it("遗留问题来源任务在卡片上显示徽章", async () => {
    const { listTaskGroupMemberships } = renderView({
      marks: [membershipOf(1, true), membershipOf(2, false)],
    });

    const sourceCard = await screen.findByRole("button", {
      name: "打开任务 T-1001 实现任务看板",
    });
    // 裁决修订 D-2：由遗留问题转换而来的任务自带「遗留问题」徽章。
    expect(await within(sourceCard).findByText("遗留问题")).toBeInTheDocument();
    const plainCard = screen.getByRole("button", {
      name: "打开任务 T-1002 补齐看板筛选",
    });
    expect(within(plainCard).queryByText("遗留问题")).toBeNull();
    // 页面级一次批量：整页任务 ID 一次请求，不按任务逐个请求。
    expect(listTaskGroupMemberships).toHaveBeenCalledTimes(1);
    expect(listTaskGroupMemberships.mock.calls[0]![0]).toEqual({
      taskIds: [1, 2, 3],
    });
  });

  it("列表视图在标题前显示遗留问题徽章", async () => {
    renderView({
      filters: { ...DEFAULT_TASK_BOARD_FILTERS, view: "list" },
      marks: [membershipOf(3, true)],
    });

    const row = await screen.findByRole("button", {
      name: "打开任务 T-1003 结算对账",
    });
    expect(await within(row).findByText("遗留问题")).toBeInTheDocument();
    const plainRow = screen.getByRole("button", {
      name: "打开任务 T-1001 实现任务看板",
    });
    expect(within(plainRow).queryByText("遗留问题")).toBeNull();
  });
});

describe("负责人已被移出项目", () => {
  it("泳道卡片在姓名后标出「已移出项目」", async () => {
    // 9 号（张启明）已经不在项目活跃成员里，但任务仍挂着他。
    renderView({ activeMembers: { items: [] } });

    const card = await screen.findByRole("button", {
      name: /打开任务 T-1001/,
    });
    await waitFor(() =>
      expect(card.textContent).toContain("张启明（已移出项目）"),
    );
  });

  it("列表行用同一口径标出「已移出项目」", async () => {
    renderView({
      activeMembers: { items: [] },
      filters: { ...DEFAULT_TASK_BOARD_FILTERS, view: "list" },
    });

    const row = await screen.findByRole("button", { name: /打开任务 T-1001/ });
    await waitFor(() =>
      expect(row.textContent).toContain("张启明（已移出项目）"),
    );
  });

  it("人还在项目成员里时不加标记（避免误报）", async () => {
    renderView();

    const card = await screen.findByRole("button", {
      name: /打开任务 T-1001/,
    });
    expect(card.textContent).toContain("张启明");
    expect(card.textContent).not.toContain("已移出项目");
  });
});

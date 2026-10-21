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
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ApiError, type InpulseApiClient, type TaskItem } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { TasksPanel } from "./TasksPanel";
import { mergeTask, taskEdit } from "./task-query";

const item: TaskItem = {
  id: 1,
  projectId: 2,
  moduleId: 3,
  featureId: 4,
  scopeType: "FEATURE",
  code: "PR-T-1",
  title: "退款任务",
  description: "原说明",
  assigneeId: 5,
  assigneeIds: [5],
  creatorId: 5,
  priority: "NORMAL",
  dueAt: null,
  workStatus: "TODO",
  lifecycleStatus: "ACTIVE",
  rowVersion: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};
function client(overrides: object = {}) {
  return {
    getTaskStatusHistory: vi.fn().mockResolvedValue({ items: [] }),
    getModuleTaskStatusHistory: vi.fn().mockResolvedValue({ items: [] }),
    listTasks: vi.fn().mockResolvedValue({ items: [item] }),
    listTaskGroupMemberships: vi.fn().mockResolvedValue({ items: [] }),
    getTaskGroup: vi.fn().mockResolvedValue({
      group: {
        groupId: 501,
        projectId: 2,
        code: "TG-501",
        name: "退款聚合组",
        status: "ACTIVE",
        createdAt: "2026-09-01T12:00:00.000Z",
        closedAt: null,
        rowVersion: 1,
      },
      members: [
        {
          taskId: 3,
          taskCode: "PR-T-3",
          title: "主任务丙",
          role: "MAIN",
          sourceKind: null,
          memberStatus: "ACTIVE",
          workStatus: "TODO",
          lifecycleStatus: "ACTIVE",
          moduleId: 3,
          featureId: 4,
          assignee: { userId: 5, name: "项目成员", avatarUrl: null },
          joinedAt: "2026-09-01T12:00:00.000Z",
          detachedAt: null,
          detachReason: null,
          publishedRecordCount: 0,
        },
      ],
    }),
    listTaskGroupRecords: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
    listTaskAssignees: vi.fn().mockResolvedValue({
      items: [{ id: 5, name: "项目成员", avatarUrl: null }],
    }),
    issueCsrfToken: vi.fn().mockResolvedValue({ csrfToken: "a".repeat(43) }),
    getFeature: vi.fn().mockResolvedValue({ status: "ACTIVE" }),
    listActiveProjectMembers: vi.fn().mockResolvedValue({
      items: [{ id: 5, name: "项目成员", avatarUrl: null }],
    }),
    listChangeRecords: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
    getTaskRecordDrafts: vi.fn().mockResolvedValue({
      source: {
        taskId: 1,
        projectId: 2,
        moduleId: 3,
        featureId: 4,
        scopeType: "FEATURE",
        title: item.title,
        assigneeId: 5,
        workStatus: "TODO",
        lifecycleStatus: "ACTIVE",
        rowVersion: 1,
        impactFeatureIds: [],
      },
      items: [],
    }),
    /** 「记录一次迭代」里的链接小节会读来源任务上的链接；默认没有，用例按需覆盖。 */
    listExternalLinks: vi.fn().mockResolvedValue({
      projectId: 2,
      rowVersion: 1,
      writable: true,
      items: [],
    }),
    ...overrides,
  } as unknown as InpulseApiClient;
}
/** CalmSelect 交互：打开下拉并点选目标项（弹层项带 title 属性）。 */
function pickSelectOption(label: string, optionTitle: string) {
  const field = screen.getByLabelText(label);
  const trigger = field.closest(".ant-select");
  if (!trigger) {
    throw new Error("select trigger not found for " + label);
  }
  fireEvent.mouseDown(trigger);
  fireEvent.click(screen.getByTitle(optionTitle));
}

function mount(api: InpulseApiClient, writable = true) {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          {/* 记录详情弹窗按 isAdmin 判断作废记录正文可读性，需要认证上下文。 */}
          <AuthStateProvider>
            <TasksPanel
              projectId={2}
              moduleId={3}
              featureId={4}
              writable={writable}
              client={api}
            />
          </AuthStateProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ConfigProvider>,
  );
}
describe("F-14 功能级任务入口", () => {
  it("保存成功用浮层气泡提示，不再插入整行成功横幅", async () => {
    const createTask = vi
      .fn()
      .mockResolvedValue({ ...item, id: 2, title: "新任务" });
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [] }),
        createTask,
      }),
    );
    await screen.findByText("暂无任务");
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("任务标题"), {
      target: { value: "新任务" },
    });
    pickSelectOption("负责人", "项目成员");
    fireEvent.click(screen.getByRole("button", { name: /创建任务/ }));

    const toast = await screen.findByTestId("task-save-success");
    expect(toast).toHaveTextContent("任务已保存");
    expect(toast).toHaveClass("success-toast");
    expect(toast.closest(".ant-alert")).toBeNull();
  });

  it("功能面板只保留固定归属的「新建任务」，没有自定义归属入口", async () => {
    mount(client());
    // 任务保存在当前功能下，不需要让用户再选一次归属。
    expect(
      await screen.findByRole("button", { name: "新建任务" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "自定义归属新建任务" }),
    ).toBeNull();
  });
});

describe("F-14 task editing", () => {
  it("keeps actual changes TODO and preserves completion input across a version conflict", async () => {
    const completeTask = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: "TASK_VERSION_CONFLICT",
          message: "版本变化",
          details: {},
          requestId: "test",
        }),
      )
      .mockResolvedValue({
        task: { ...item, workStatus: "DONE", rowVersion: 3 },
        record: null,
      });
    mount(
      client({
        completeTask,
        getTask: vi.fn().mockResolvedValue({ ...item, rowVersion: 2 }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "完成任务" }));
    // Ant Design assigns the same aria title ID to nested dialogs in NODE_ENV=test.
    // Locate this dialog through its labeled field; real-browser E2E verifies its name.
    const modal = within(
      (
        await screen.findByRole("button", {
          name: /有，填写迭代记录/,
        })
      ).closest('[role="dialog"]') as HTMLElement,
    );
    // 设计稿 completion-flow 的骨架：返回任务 + 步骤标题 + 任务副标题 + 双卡片。
    expect(modal.getByRole("button", { name: /返回任务/ })).toBeTruthy();
    expect(
      modal.getByRole("heading", {
        name: "本次工作是否产生了实际功能变化？",
      }),
    ).toBeTruthy();
    expect(modal.getByText(`${item.code} · ${item.title}`)).toBeTruthy();
    fireEvent.click(modal.getByRole("button", { name: /有，填写迭代记录/ }));
    expect(
      modal.getByRole("button", { name: "发布并完成任务" }),
    ).toBeDisabled();
    expect(completeTask).not.toHaveBeenCalled();
    fireEvent.click(modal.getByRole("button", { name: /上一步/ }));
    fireEvent.click(modal.getByRole("button", { name: /没有，仅完成任务/ }));
    pickSelectOption("完成原因", "技术调研");
    fireEvent.change(modal.getByLabelText("完成补充说明"), {
      target: { value: "保留我的说明" },
    });
    fireEvent.click(modal.getByRole("button", { name: "确认完成任务" }));
    fireEvent.click(
      await modal.findByRole("button", { name: "加载最新任务状态" }),
    );
    await waitFor(() =>
      expect(modal.getByRole("button", { name: "确认完成任务" })).toBeEnabled(),
    );
    expect(modal.getByLabelText("完成补充说明")).toHaveValue("保留我的说明");
    fireEvent.click(modal.getByRole("button", { name: "确认完成任务" }));
    await waitFor(() => expect(completeTask).toHaveBeenCalledTimes(2));
    expect(completeTask.mock.calls[1]![1]).toEqual({
      expectedRowVersion: 2,
      mode: "WITHOUT_RECORD",
      completionReason: "技术调研",
      note: "保留我的说明",
    });
    expect(completeTask.mock.calls[1]![2].headers["If-Match"]).toBe('"2"');
    expect(completeTask.mock.calls[1]![2].headers["Idempotency-Key"]).not.toBe(
      completeTask.mock.calls[0]![2].headers["Idempotency-Key"],
    );
  });
  it("defaults to every status and retains all history without displaying an incomplete completion rate", async () => {
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({
          items: [
            item,
            { ...item, id: 2, title: "历史完成", workStatus: "DONE" },
            { ...item, id: 3, title: "历史取消", workStatus: "CANCELED" },
            {
              ...item,
              id: 4,
              title: "无效历史",
              workStatus: "DONE",
              lifecycleStatus: "INVALID",
            },
          ],
        }),
      }),
    );
    // 默认「全部状态」：四种状态的任务一次列出，历史与无效行都不隐藏。
    await screen.findByText(item.title);
    // 默认「全部状态」：CalmSelect 触发器直接显示当前选项文案。
    expect(
      screen.getByLabelText("任务状态筛选").closest(".ant-select"),
    ).toHaveTextContent("全部状态");
    for (const title of [item.title, "历史完成", "历史取消", "无效历史"])
      expect(screen.getByText(title)).toBeVisible();
    expect(screen.queryByText(/完成率/)).not.toBeInTheDocument();
    pickSelectOption("任务状态筛选", "已取消");
    expect(screen.getByText("历史取消")).toBeVisible();
    pickSelectOption("任务状态筛选", "已完成");
    expect(screen.getByText("历史完成")).toBeVisible();
    expect(screen.getByText("无效历史")).toBeVisible();
    pickSelectOption("任务状态筛选", "全部状态");
    for (const title of [item.title, "历史完成", "历史取消", "无效历史"])
      expect(screen.getByText(title)).toBeVisible();
    expect(screen.queryByText(/完成率/)).not.toBeInTheDocument();
  });
  it("compares impact sets semantically and requires a three-way choice", () => {
    const base = { ...taskEdit(item), impactFeatureIds: [2] };
    expect(
      mergeTask(
        base,
        { ...base, impactFeatureIds: [2, 3] },
        { ...base, impactFeatureIds: [2, 4] },
      ).conflicts,
    ).toEqual(["impactFeatureIds"]);
    expect(
      mergeTask(
        base,
        { ...base, impactFeatureIds: [2] },
        { ...base, title: "新标题" },
      ).conflicts,
    ).toEqual([]);
  });
  it("shows a MODULE reference only once and without a module-task jump link", async () => {
    const module = {
      ...item,
      featureId: null,
      scopeType: "MODULE",
      impactFeatureIds: [4],
    };
    mount(
      client({ listTasks: vi.fn().mockResolvedValue({ items: [module] }) }),
    );
    // 卡片正文是任务介绍，模块级引用由「模块级」徽标表达（不再重复功能名）。
    await screen.findByText("模块级");
    expect(screen.getByText("原说明")).toBeVisible();
    expect(screen.getByText("1 个任务")).toBeVisible();
    fireEvent.click(screen.getByRole("article", { name: /^查看任务详情/ }));
    // 2026-09-24 产品要求删除正文里的「打开模块任务」跳转（任务中心详情动作行
    // 的「在项目中打开」与功能页头部的「模块级任务」标签已是同一去向）。
    await screen.findByRole("button", { name: "编辑任务" });
    expect(
      screen.queryByRole("link", { name: "打开模块任务" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑任务" })).toBeDisabled();
  });
  it("merges untouched fields and requires choice for conflicting assignee/due date", () => {
    const base = taskEdit(item);
    const draft = {
      ...base,
      title: "我的标题",
      assigneeIds: [6],
      dueAt: "2026-09-10T00:00:00Z",
    };
    const latest = {
      ...base,
      description: "他人说明",
      assigneeIds: [7],
      dueAt: "2026-09-11T00:00:00Z",
    };
    expect(mergeTask(base, draft, latest)).toEqual({
      values: { ...draft, description: "他人说明" },
      conflicts: ["assigneeIds", "dueAt"],
    });
  });
  it("retains identical retry key after uncertain failure and changes key with semantics", async () => {
    const createTask = vi.fn().mockRejectedValue(new Error("lost response"));
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [] }),
        createTask,
      }),
    );
    await screen.findByText("暂无任务");
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("任务标题"), {
      target: { value: "新任务" },
    });
    pickSelectOption("负责人", "项目成员");
    const save = screen.getByRole("button", { name: /创建任务/ });
    fireEvent.click(save);
    await screen.findByText("任务服务暂时不可用，输入已保留，可重试。");
    fireEvent.click(save);
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    expect(createTask.mock.calls[0]![4].headers["Idempotency-Key"]).toBe(
      createTask.mock.calls[1]![4].headers["Idempotency-Key"],
    );
    await waitFor(() => expect(save).not.toHaveClass("ant-btn-loading"));
    fireEvent.change(screen.getByLabelText("任务标题"), {
      target: { value: "改了标题" },
    });
    fireEvent.click(save);
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(3));
    expect(createTask.mock.calls[2]![4].headers["Idempotency-Key"]).not.toBe(
      createTask.mock.calls[1]![4].headers["Idempotency-Key"],
    );
  });
  it("requires selecting the conflicting title before submitting latest If-Match", async () => {
    const latest = {
      ...item,
      title: "他人标题",
      description: "他人说明",
      rowVersion: 2,
    };
    const updateTask = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: "TASK_VERSION_CONFLICT",
          message: "版本变化",
          details: {},
          requestId: "r",
        }),
      )
      .mockResolvedValue({ ...latest, title: "我的标题", rowVersion: 3 });
    mount(client({ getTask: vi.fn().mockResolvedValue(latest), updateTask }));
    await screen.findByText("退款任务");
    fireEvent.click(screen.getByRole("article", { name: /^查看任务详情/ }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑任务" }));
    const modal = within(screen.getByRole("dialog", { name: "编辑任务" }));
    fireEvent.change(modal.getByLabelText("任务标题"), {
      target: { value: "我的标题" },
    });
    fireEvent.click(modal.getByRole("button", { name: /保\s*存/ }));
    fireEvent.click(
      await modal.findByRole("button", { name: "加载最新版本后继续编辑" }),
    );
    await modal.findByText("任务标题存在冲突");
    expect(modal.getByRole("button", { name: /保\s*存/ })).toBeDisabled();
    fireEvent.click(modal.getByRole("button", { name: "保留我的任务标题" }));
    fireEvent.click(modal.getByRole("button", { name: "应用合并结果" }));
    expect(modal.getByLabelText("任务说明")).toHaveValue("他人说明");
    fireEvent.click(modal.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(2));
    expect(updateTask.mock.calls[1]![5].headers["If-Match"]).toBe('"2"');
  });
  it("shows read failure/retry and disables creation in archived feature", async () => {
    mount(
      client({ listTasks: vi.fn().mockRejectedValue(new Error("offline")) }),
      false,
    );
    await screen.findByRole("button", { name: "重试任务列表" });
    expect(screen.getByRole("button", { name: "新建任务" })).toBeDisabled();
  });
  it("does not invent selectable global users or default assignee", async () => {
    mount(client());
    await screen.findByText("退款任务");
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("任务标题"), {
      target: { value: "新任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创建任务/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "请至少选择一名负责人",
    );
  });
});

/*
 * 聚合组入口不再整页跳转 `/task-groups/{id}`（该页面已按方案 A 删除），而是
 * 就地打开 TaskGroupDetailModal；断言改用弹窗角色与头部眉标。
 */
function mountWithGroupModal(api: InpulseApiClient, writable = true) {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/features/4"]}>
          {/* 聚合组弹窗里的记录详情按 isAdmin 判断正文可读性，需要认证上下文。 */}
          <AuthStateProvider>
            <TasksPanel
              projectId={2}
              moduleId={3}
              featureId={4}
              writable={writable}
              client={api}
            />
          </AuthStateProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ConfigProvider>,
  );
}
describe("F-23 merge entry", () => {
  it("opens the merge modal from the edit-task footer", async () => {
    mount(client());
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    // 2026-10-09 改版（定稿方案 D）：合并入口从详情动作行搬进「编辑任务」页脚。
    // 点它先收起编辑弹窗、由详情弹窗接管，不出现弹窗套弹窗。
    fireEvent.click(await screen.findByRole("button", { name: "编辑任务" }));
    const editor = within(screen.getByRole("dialog", { name: "编辑任务" }));
    fireEvent.click(editor.getByRole("button", { name: "合并到主任务" }));
    expect(await screen.findByLabelText(/^主任务$/)).toBeInTheDocument();
  });
});
describe("ADR-058 删除任务", () => {
  it("requires a second confirmation before calling deleteTask with CSRF, idempotency key and If-Match", async () => {
    const deleteTask = vi.fn().mockResolvedValue({
      id: 1,
      projectId: 2,
      moduleId: 3,
      featureId: 4,
      code: "PR-T-1",
      title: "退款任务",
      workStatus: "TODO",
      deletedAt: "2026-10-09T00:00:00.000Z",
      deletedBy: 5,
      voidedRecordCount: 0,
      removedLinkCount: 1,
      detachedGroupRole: null,
    });
    mount(client({ deleteTask }));
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "编辑任务" }));
    const editor = within(screen.getByRole("dialog", { name: "编辑任务" }));
    // 「取消任务」已由「删除任务」取代：取消只是软删除的一种结果，没有恢复入口。
    expect(editor.queryByRole("button", { name: "取消任务" })).toBeNull();
    const deleteButton = editor.getByRole("button", { name: "删除任务" });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);
    const confirm = await screen.findByRole("dialog", { name: "确认删除任务" });
    expect(within(confirm).getByText(/不能恢复/)).toBeInTheDocument();
    // 二次确认前不发请求。
    expect(deleteTask).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByTestId("confirm-delete-task"));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1));
    const [projectId, moduleId, featureId, taskId, body, init] = deleteTask.mock
      .calls[0] as [
      number,
      number,
      number,
      number,
      { reason: string | null },
      { headers: Record<string, string> },
    ];
    expect([projectId, moduleId, featureId, taskId]).toEqual([2, 3, 4, 1]);
    expect(body).toEqual({ reason: null });
    expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
    expect(init.headers["If-Match"]).toBe('"1"');
    expect(init.headers["Idempotency-Key"]).toBeTruthy();
  });
});
describe("C-1 任务聚合标记（R-5 页面级一次批量）", () => {
  const source: TaskItem = { ...item, id: 1, title: "来源任务甲" };
  const ungrouped: TaskItem = { ...item, id: 2, title: "未入组任务乙" };
  const main: TaskItem = { ...item, id: 3, title: "主任务丙" };
  const marks = {
    items: [
      {
        taskId: 1,
        groupId: 501,
        groupRole: "SOURCE",
        publishedRecordCount: 2,
        hasLeftoverSource: true,
      },
      {
        taskId: 2,
        groupId: null,
        groupRole: null,
        publishedRecordCount: 0,
        hasLeftoverSource: false,
      },
    ],
  } as const;
  it("marks every card from one batch call and hides the entry for ungrouped tasks", async () => {
    const listTaskGroupMemberships = vi.fn().mockResolvedValue(marks);
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [source, ungrouped] }),
        listTaskGroupMemberships,
      }),
    );
    const sourceCard = (await screen.findByText("来源任务甲")).closest(
      ".calm-task-card",
    ) as HTMLElement;
    expect(await within(sourceCard).findByText("分支任务")).toBeInTheDocument();
    expect(
      await within(sourceCard).findByText("记录 2 条"),
    ).toBeInTheDocument();
    // 裁决修订 D-2：遗留问题转化而来的任务在卡片上自带「遗留问题」徽章。
    const leftoverBadge = await within(sourceCard).findByText("遗留问题");
    expect(leftoverBadge).toBeInTheDocument();
    // 2026-09-22 定案：「遗留问题」用固定深锈红徽章（badge-leftover），不与优先级标签同款。
    expect(leftoverBadge).toHaveClass("badge-leftover");
    const ungroupedCard = screen
      .getByText("未入组任务乙")
      .closest(".calm-task-card") as HTMLElement;
    // 2026-09-23 八次配色定案：遗留问题来源不再改整卡配色，这张普通优先级卡与同优先级的
    // 非遗留卡取同一档 tone 类，来源只由上面那枚徽章表达。
    expect(sourceCard).toHaveClass("calm-task-card", "tone-prio-normal");
    expect(within(ungroupedCard).queryByText("分支任务")).toBeNull();
    expect(within(ungroupedCard).queryByText("主任务")).toBeNull();
    expect(within(ungroupedCard).queryByText("遗留问题")).toBeNull();
    // 不是遗留项来源的卡片同样是普通优先级白卡，与上面那张只差一枚「遗留问题」徽章。
    expect(ungroupedCard).toHaveClass("calm-task-card", "tone-prio-normal");
    expect(within(ungroupedCard).queryByText(/迭代记录/)).toBeNull();
    await waitFor(() =>
      expect(listTaskGroupMemberships).toHaveBeenCalledTimes(1),
    );
    expect(listTaskGroupMemberships.mock.calls[0]![0]).toEqual({
      taskIds: [1, 2],
    });
  });
  it("列表视图沿用同一套程度配色：优先级铺色，已完成转青碧、已取消转灰", async () => {
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({
          items: [
            item,
            {
              ...item,
              id: 11,
              code: "PR-T-11",
              title: "已完成任务",
              priority: "URGENT",
              workStatus: "DONE",
            },
            {
              ...item,
              id: 12,
              code: "PR-T-12",
              title: "已取消任务",
              workStatus: "CANCELED",
            },
          ],
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "列表" }));

    const plainRow = (await screen.findByText("退款任务")).closest(
      "tr",
    ) as HTMLElement;
    expect(plainRow).toHaveClass("tone-prio-normal");
    // 状态覆盖优先级：紧急的已完成任务整行转青碧，已取消整行转灰。
    expect(screen.getByText("已完成任务").closest("tr")).toHaveClass(
      "tone-prio-done",
    );
    expect(screen.getByText("已取消任务").closest("tr")).toHaveClass(
      "tone-prio-canceled",
    );
  });
  it("列表视图的截止列只在逾期与马上到期时上色", async () => {
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
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({
          items: [
            {
              ...item,
              id: 21,
              code: "PR-T-21",
              title: "逾期任务",
              dueAt: dayOffset(-3),
            },
            {
              ...item,
              id: 22,
              code: "PR-T-22",
              title: "今天到期任务",
              dueAt: dayOffset(0),
            },
            {
              ...item,
              id: 23,
              code: "PR-T-23",
              title: "更远任务",
              dueAt: dayOffset(5),
            },
            {
              ...item,
              id: 24,
              code: "PR-T-24",
              title: "已完成逾期任务",
              workStatus: "DONE",
              dueAt: dayOffset(-3),
            },
          ],
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "列表" }));

    const dueCellOf = (title: string): HTMLElement => {
      const row = screen.getByText(title).closest("tr") as HTMLElement;
      const cells = within(row).getAllByRole("cell");
      return cells[cells.length - 2] as HTMLElement;
    };
    expect(dueCellOf("逾期任务")).toHaveClass("due-overdue");
    expect(dueCellOf("今天到期任务")).toHaveClass("due-soon");
    expect(dueCellOf("更远任务")).not.toHaveClass("due-overdue");
    expect(dueCellOf("已完成逾期任务")).not.toHaveClass("due-overdue");
  });
  it("标签落到左下角、负责人贴在分隔线上方右侧", async () => {
    mount(client({ listTasks: vi.fn().mockResolvedValue({ items: [item] }) }));

    const card = (await screen.findByText("退款任务")).closest(
      ".calm-task-card",
    ) as HTMLElement;
    expect(card.querySelector(".calm-card-top")).toBeNull();
    expect(card.querySelector(".task-id")).toBeNull();
    expect(within(card).queryByText("PR-T-1")).toBeNull();
    expect(within(card).queryByText("未完成")).toBeNull();
    const bottom = card.querySelector(".calm-card-bottom") as HTMLElement;
    const badges = card.querySelector(
      ".calm-card-bottom > .task-card-badges",
    ) as HTMLElement;
    expect(badges).not.toBeNull();
    expect(badges.parentElement).toBe(bottom);
    expect(within(badges).getByText("普通")).toBeInTheDocument();
    const assignee = card.querySelector(".calm-card-assignee") as HTMLElement;
    expect(assignee).not.toBeNull();
    expect(assignee.nextElementSibling).toBe(bottom);
    expect(assignee.firstElementChild?.getAttribute("title")).toMatch(
      /^负责人：/,
    );
  });
  it("卡片视图按优先级铺色：逾期与今天到期都不再改色", async () => {
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
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({
          items: [
            {
              ...item,
              id: 31,
              code: "PR-T-31",
              title: "逾期卡片",
              dueAt: dayOffset(-3),
            },
            {
              ...item,
              id: 32,
              code: "PR-T-32",
              title: "今天卡片",
              dueAt: dayOffset(0),
            },
            {
              ...item,
              id: 33,
              code: "PR-T-33",
              title: "明天卡片",
              dueAt: dayOffset(1),
            },
            {
              ...item,
              id: 34,
              code: "PR-T-34",
              title: "已完成卡片",
              workStatus: "DONE",
              dueAt: dayOffset(-3),
            },
          ],
        }),
      }),
    );

    const cardOf = async (title: string): Promise<HTMLElement> =>
      (await screen.findByText(title)).closest(
        ".calm-task-card",
      ) as HTMLElement;
    // 2026-09-22 三次定案「逾期的不搞特殊了，原本的优先级是什么就呈现什么颜色」：
    // 逾期与今天到期不影响整卡底色，卡片一律按任务自己的优先级铺色
    // （这四张都是普通优先级，因此都是普通蓝）。
    // 2026-09-23 十一次定案（产品要求「这个已经逾期可不可以加点颜色」）：卡片右下角
    // 那行截止文案本身按紧迫度染色，类名与列表截止列同源；已完成不提示逾期，类名缺席。
    const dueSpanOf = async (title: string): Promise<HTMLElement> =>
      (await cardOf(title)).querySelector(
        ".calm-card-bottom > span:last-child",
      ) as HTMLElement;
    expect(await cardOf("逾期卡片")).toHaveClass(
      "calm-task-card",
      "tone-prio-normal",
    );
    expect(await cardOf("今天卡片")).toHaveClass(
      "calm-task-card",
      "tone-prio-normal",
    );
    expect(await cardOf("明天卡片")).toHaveClass(
      "calm-task-card",
      "tone-prio-normal",
    );
    expect(await cardOf("已完成卡片")).toHaveClass(
      "calm-task-card",
      "tone-prio-done",
    );
    expect(await dueSpanOf("逾期卡片")).toHaveClass("due-overdue");
    expect(await dueSpanOf("今天卡片")).toHaveClass("due-soon");
    // 本面板的 dueInfo 把「明天截止」也算 amber 档（与列表截止列同源），所以明天也带
    // due-soon；更远的日期两档都不带。
    expect(await dueSpanOf("明天卡片")).toHaveClass("due-soon");
    expect(await dueSpanOf("已完成卡片")).not.toHaveClass("due-overdue");
    expect(await dueSpanOf("已完成卡片")).not.toHaveClass("due-soon");
  });
  it("shows badge, record count and the main-task entry in the detail dialog, then opens the group dialog in place", async () => {
    mountWithGroupModal(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [source] }),
        listTaskGroupMemberships: vi.fn().mockResolvedValue(marks),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(await within(dialog).findByText("分支任务")).toBeInTheDocument();
    expect(within(dialog).getByText("迭代记录 2 条")).toBeInTheDocument();
    expect(await within(dialog).findByText("遗留问题")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /查看主任务/ }));
    const group = await screen.findByRole("dialog", { name: "退款聚合组" });
    expect(within(group).getByText("TG-501 / TASK GROUP")).toBeInTheDocument();
    expect(await within(group).findByText("主任务丙")).toBeInTheDocument();
  });
  it("keeps the main task badge but hides the main-task entry on the MAIN task itself", async () => {
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [main] }),
        listTaskGroupMemberships: vi.fn().mockResolvedValue({
          items: [
            {
              taskId: 3,
              groupId: 501,
              groupRole: "MAIN",
              publishedRecordCount: 0,
              hasLeftoverSource: false,
            },
          ],
        }),
      }),
    );
    const mainCard = (await screen.findByText("主任务丙")).closest(
      ".calm-task-card",
    ) as HTMLElement;
    expect(await within(mainCard).findByText("主任务")).toBeInTheDocument();
    expect(within(mainCard).queryByText("遗留问题")).toBeNull();
    fireEvent.click(screen.getByRole("article", { name: /^查看任务详情/ }));
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(await within(dialog).findByText("主任务")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /查看主任务/ }),
    ).toBeNull();
    expect(within(dialog).queryByText(/迭代记录 \d+ 条/)).toBeNull();
  });
});

describe("C-3 任务详情弹窗标签页", () => {
  const source: TaskItem = { ...item, id: 1, title: "来源任务甲" };
  const main: TaskItem = { ...item, id: 3, title: "主任务丙" };
  const marks = (role: "MAIN" | "SOURCE") => ({
    items: [
      {
        taskId: role === "MAIN" ? 3 : 1,
        groupId: 501,
        groupRole: role,
        publishedRecordCount: 2,
        hasLeftoverSource: false,
      },
    ],
  });
  it("renders the info tab first and switches to the records tab with the drafts entry", async () => {
    mount(client());
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    const tabs = within(dialog).getByRole("tablist", { name: "任务内容" });
    // 默认停在任务信息：描述与「打开迭代记录」入口首屏可见。
    expect(within(tabs).getByRole("tab", { name: "任务信息" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByText("原说明")).toBeInTheDocument();
    // 标签页内容区是 .calm-tabs 的紧邻兄弟节点：样式靠这个关系固定内容区高度，
    // 保证切换标签页时弹窗大小不变（见 design-system.css 的固定高度规则）。
    const tabStrip = within(dialog).getByRole("tablist", { name: "任务内容" });
    expect(tabStrip.nextElementSibling).toHaveClass("task-modal-grid");
    // jsdom 下弹窗首帧动画 opacity 为 0，仓库统一用 toBeInTheDocument 断言弹窗内容。
    expect(
      within(dialog).getByRole("link", { name: "打开迭代记录" }),
    ).toHaveAttribute("href", "/records?projectId=2&moduleId=3&taskId=1");
    fireEvent.click(within(tabs).getByRole("tab", { name: "迭代记录" }));
    // 迭代记录标签页按设计师稿列出本任务已发布记录与草稿；两者皆空时给空态与草稿入口。
    expect(within(tabs).getByRole("tab", { name: "迭代记录" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(dialog).getByText("该任务还没有迭代记录"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("link", { name: "打开迭代记录" }),
    ).toBeNull();
    // 记录一次迭代不再跳转记录页，而是与记录页共用草稿弹窗就地打开。
    const draftEntry = within(dialog).getByRole("button", {
      name: "记录一次迭代",
    });
    expect(draftEntry).toBeInTheDocument();
    fireEvent.click(draftEntry);
    const modal = within(
      await screen.findByRole("dialog", { name: "新建任务迭代" }),
    );
    // ADR-047：任务侧的记录弹窗与迭代记录页同一套排版——归属按来源快照只读呈现，
    // 页脚直接给发布入口，来源任务未完成也能发布。
    expect(modal.getByLabelText("迭代标题")).toHaveValue("退款任务");
    expect(
      modal.getByText("所属功能").closest(".record-scope-facts"),
    ).not.toBeNull();
    // 页脚与迭代记录页同一顺序：淡蓝「保存草稿」在左、主按钮「发布迭代记录」在右。
    // 是否可提交取决于项目状态是否已知，由 RecordDraftsView 的单测与浏览器用例覆盖。
    expect(
      modal.getByRole("button", { name: "发布迭代记录" }).className,
    ).toContain("primary-button");
    expect(modal.getByRole("button", { name: "保存草稿" }).className).toContain(
      "soft-blue-button",
    );
    // 任务侧的新建任务迭代与记录页同一套 GitHub 链接区：可直接暂存仓库/PR 链接。
    expect(modal.getByLabelText("GitHub 链接地址")).toBeInTheDocument();
  });
  it("lands the freshly published record inside the task detail", async () => {
    const saved = {
      id: 41,
      projectId: 2,
      moduleId: 3,
      featureId: 4,
      scopeType: "FEATURE",
      taskId: 1,
      impactFeatureIds: [],
      handlerId: 5,
      authorId: 5,
      status: "DRAFT",
      code: null,
      currentVersion: 0,
      publishedAt: null,
      rowVersion: 2,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      title: item.title,
      contextProblem: "a",
      changeSolution: "b",
      resultVerification: "c",
      remainingIssues: [],
    };
    const published = {
      ...saved,
      status: "PUBLISHED",
      code: "PR-CR-9",
      currentVersion: 1,
      publishedAt: "2026-09-20T01:00:00.000Z",
      rowVersion: 3,
      leftovers: [],
    };
    const createTaskRecordDraft = vi.fn().mockResolvedValue(saved);
    const publishChangeRecord = vi.fn().mockResolvedValue(published);
    mount(
      client({
        listProjects: vi.fn().mockResolvedValue({
          items: [{ id: 2, name: "退款项目", status: "ACTIVE" }],
        }),
        createTaskRecordDraft,
        publishChangeRecord,
        getChangeRecord: vi.fn().mockResolvedValue(published),
        listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [] }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    // 「记录一次迭代」只存在于迭代记录标签页。
    fireEvent.click(within(dialog).getByRole("tab", { name: "迭代记录" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "记录一次迭代" }),
    );
    const modal = within(
      await screen.findByRole("dialog", { name: "新建任务迭代" }),
    );
    const publish = modal.getByRole("button", { name: "发布迭代记录" });
    await waitFor(() => expect(publish).toBeEnabled());
    for (const [label, value] of [
      ["改动原因", "a"],
      ["具体改动", "b"],
      ["改动效果", "c"],
    ])
      fireEvent.change(modal.getByLabelText(label!), { target: { value } });
    fireEvent.click(publish);
    await waitFor(() => expect(publishChangeRecord).toHaveBeenCalledOnce());
    // 发布后不强制跳转：停在任务详情，但给出一条直达正式记录的入口。
    const notice = await within(dialog).findByText(/迭代记录已发布/);
    expect(notice.textContent).toContain("PR-CR-9");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "查看正式记录" }),
    );
    // 任务详情里的正式记录列表是另一条查询，刷新落地前也要能打开详情。
    const record = await screen.findByRole("dialog", { name: item.title });
    expect(within(record).getByText("PR-CR-9")).toBeInTheDocument();
  });
  it("carries the task's checked GitHub links into the draft it creates", async () => {
    const saved = {
      id: 41,
      projectId: 2,
      moduleId: 3,
      featureId: 4,
      scopeType: "FEATURE",
      taskId: 1,
      impactFeatureIds: [],
      handlerId: 5,
      authorId: 5,
      status: "DRAFT",
      code: null,
      currentVersion: 0,
      publishedAt: null,
      rowVersion: 2,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      title: item.title,
      contextProblem: "a",
      changeSolution: "b",
      resultVerification: "c",
      remainingIssues: [],
    };
    const createTaskRecordDraft = vi.fn().mockResolvedValue(saved);
    const addExternalLink = vi.fn().mockResolvedValue({ rowVersion: 5 });
    mount(
      client({
        listProjects: vi.fn().mockResolvedValue({
          items: [{ id: 2, name: "退款项目", status: "ACTIVE" }],
        }),
        createTaskRecordDraft,
        addExternalLink,
        listExternalLinks: vi.fn().mockResolvedValue({
          projectId: 2,
          rowVersion: 1,
          writable: true,
          items: [
            {
              id: 11,
              kind: "PULL_REQUEST",
              displayUrl: "PR #22311",
              normalizedUrl: "https://github.com/inpulse/core/pull/22311",
            },
            {
              id: 12,
              kind: "ISSUE",
              displayUrl: "Issue #22312",
              normalizedUrl: "https://github.com/inpulse/core/issues/22312",
            },
          ],
        }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "迭代记录" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "记录一次迭代" }),
    );
    const modal = within(
      await screen.findByRole("dialog", { name: "新建任务迭代" }),
    );
    // 任务上已有的链接收在下拉框里且默认全部勾选，取消勾选的那条不跟着走。
    fireEvent.click(
      await modal.findByRole("button", { name: /已选 2 \/ 2 条任务链接/ }),
    );
    const pull = await modal.findByRole("checkbox", { name: /pull\/22311/ });
    expect(pull).toBeChecked();
    const issue = modal.getByRole("checkbox", { name: /issues\/22312/ });
    expect(issue).toBeChecked();
    fireEvent.click(issue);
    expect(issue).not.toBeChecked();
    expect(
      modal.getByRole("button", { name: /已选 1 \/ 2 条任务链接/ }),
    ).toBeInTheDocument();
    // 自己添加的链接与勾选项合并写入。
    fireEvent.change(modal.getByLabelText("GitHub 链接地址"), {
      target: { value: "https://github.com/inpulse/core/commit/22313" },
    });
    fireEvent.click(modal.getByRole("button", { name: "添加链接" }));
    expect(
      await modal.findByText("https://github.com/inpulse/core/commit/22313"),
    ).toBeInTheDocument();
    for (const [label, value] of [
      ["改动原因", "a"],
      ["具体改动", "b"],
      ["改动效果", "c"],
    ])
      fireEvent.change(modal.getByLabelText(label!), { target: { value } });
    const save = modal.getByRole("button", { name: "保存草稿" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(createTaskRecordDraft).toHaveBeenCalledOnce());
    await waitFor(() => expect(addExternalLink).toHaveBeenCalledTimes(3));
    // 记录侧写勾选沿用的两条；自己添加的那条另在任务上补一条（存进项目链接库）。
    expect(
      addExternalLink.mock.calls
        .filter((call) => call[0] === "CHANGE_RECORD")
        .map((call) => (call[2] as { url: string }).url),
    ).toEqual([
      "https://github.com/inpulse/core/pull/22311",
      "https://github.com/inpulse/core/commit/22313",
    ]);
    const taskCalls = addExternalLink.mock.calls.filter(
      (call) => call[0] === "TASK",
    );
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0]![1]).toBe(1);
    expect(taskCalls[0]![2]).toEqual({
      url: "https://github.com/inpulse/core/commit/22313",
    });
  });
  it("lists the task's published records and drafts on the records tab", async () => {
    const record = {
      id: 11,
      projectId: 2,
      moduleId: 3,
      featureId: 4,
      scopeType: "FEATURE",
      taskId: 1,
      impactFeatureIds: [],
      handlerId: 5,
      authorId: 5,
      status: "PUBLISHED",
      code: "PR-CR-1",
      currentVersion: 1,
      publishedAt: "2026-09-01T00:00:00.000Z",
      rowVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      title: "已发布记录甲",
      contextProblem: "a",
      changeSolution: "b",
      resultVerification: "c",
      remainingIssues: [],
      leftovers: [],
    };
    mount(
      client({
        listChangeRecords: vi.fn().mockResolvedValue({
          items: [
            record,
            { ...record, id: 12, taskId: 999, title: "他人任务记录" },
          ],
          nextCursor: null,
          hasMore: false,
        }),
        getTaskRecordDrafts: vi.fn().mockResolvedValue({
          source: {
            taskId: 1,
            projectId: 2,
            moduleId: 3,
            featureId: 4,
            scopeType: "FEATURE",
            title: item.title,
            assigneeId: 5,
            workStatus: "TODO",
            lifecycleStatus: "ACTIVE",
            rowVersion: 1,
            impactFeatureIds: [],
          },
          items: [
            {
              id: 21,
              projectId: 2,
              moduleId: 3,
              featureId: 4,
              scopeType: "FEATURE",
              taskId: 1,
              impactFeatureIds: [],
              handlerId: 5,
              authorId: 5,
              status: "DRAFT",
              code: null,
              currentVersion: 0,
              publishedAt: null,
              rowVersion: 1,
              createdAt: "2026-09-02T00:00:00.000Z",
              updatedAt: "2026-09-02T00:00:00.000Z",
              title: "草稿乙",
              contextProblem: "a",
              changeSolution: "b",
              resultVerification: "c",
              remainingIssues: [],
            },
          ],
        }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    const tabs = within(dialog).getByRole("tablist", { name: "任务内容" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "迭代记录" }));
    // 迭代记录行整行是按钮：点开记录详情弹窗，不再跳记录页；草稿行仍为链接。
    const publishedRow = await within(dialog).findByRole("button", {
      name: /已发布记录甲/,
    });
    expect(publishedRow).toHaveAttribute("aria-haspopup", "dialog");
    expect(within(dialog).getByText("已发布")).toBeInTheDocument();
    fireEvent.click(publishedRow);
    const recordDialog = await screen.findByRole("dialog", {
      name: "已发布记录甲",
    });
    expect(within(recordDialog).getByText("PR-CR-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭迭代记录详情" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "已发布记录甲" })).toBeNull(),
    );
    const draftLink = within(dialog).getByRole("link", { name: /草稿乙/ });
    expect(draftLink).toHaveAttribute(
      "href",
      "/records?projectId=2&moduleId=3&taskId=1&recordId=21",
    );
    expect(within(dialog).getByText("草稿")).toBeInTheDocument();
    // 同项目其他任务的记录不得混入本任务列表。
    expect(within(dialog).queryByText("他人任务记录")).toBeNull();
    fireEvent.click(within(tabs).getByRole("tab", { name: "任务信息" }));
    expect(within(dialog).getByText("原说明")).toBeInTheDocument();
  });
  it("shows creator and history operator names instead of raw ids", async () => {
    mount(
      client({
        getTaskStatusHistory: vi.fn().mockResolvedValue({
          items: [
            {
              id: "1",
              fromWorkStatus: null,
              toWorkStatus: "TODO",
              completedAtSnapshot: null,
              completionNoteSnapshot: null,
              reason: null,
              changedBy: 5,
              changedByName: "项目成员",
              changedAt: "2026-09-10T03:00:00.000Z",
            },
          ],
        }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    // 创建人与状态历史操作人都解析为姓名，不再显示裸编号。
    expect(within(dialog).queryByText("#5")).toBeNull();
    expect(
      await within(dialog).findByText(/操作人\s*项目成员/),
    ).toBeInTheDocument();
  });
  it("shows the source branch panel and opens the group dialog from the branches tab", async () => {
    mountWithGroupModal(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [source] }),
        listTaskGroupMemberships: vi.fn().mockResolvedValue(marks("SOURCE")),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    const tabs = within(dialog).getByRole("tablist", { name: "任务内容" });
    fireEvent.click(
      within(tabs).getByRole("tab", { name: "合并与分支 · #501" }),
    );
    expect(
      within(dialog).getByRole("heading", { name: "分支任务 · 聚合组 #501" }),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /查看主任务/ }));
    const group = await screen.findByRole("dialog", { name: "退款聚合组" });
    expect(within(group).getByText("TG-501 / TASK GROUP")).toBeInTheDocument();
  });
  it("keeps the group marker but hides the main-task entry on the MAIN task", async () => {
    mount(
      client({
        listTasks: vi.fn().mockResolvedValue({ items: [main] }),
        listTaskGroupMemberships: vi.fn().mockResolvedValue(marks("MAIN")),
      }),
    );
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    const tabs = within(dialog).getByRole("tablist", { name: "任务内容" });
    fireEvent.click(
      within(tabs).getByRole("tab", { name: "合并与分支 · #501" }),
    );
    expect(
      within(dialog).getByRole("heading", { name: "主任务 · 聚合组 #501" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /查看主任务/ }),
    ).toBeNull();
  });
  it("shows the standalone empty state without a main-task entry for ungrouped tasks", async () => {
    mount(client());
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    const tabs = within(dialog).getByRole("tablist", { name: "任务内容" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "合并与分支" }));
    expect(within(dialog).getByText("当前是独立任务")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /查看主任务/ }),
    ).toBeNull();
  });
});

describe("负责人已被移出项目", () => {
  const detachedClient = () =>
    client({
      // 人被移出项目：任务指派人候选与项目活跃成员里都没有 5 号。
      listTaskAssignees: vi.fn().mockResolvedValue({ items: [] }),
      listActiveProjectMembers: vi.fn().mockResolvedValue({ items: [] }),
      // 全站用户目录仍能解析出姓名：必须显示「小潘（已移出项目）」，不是「用户 #5」。
      getUserDirectory: vi.fn().mockResolvedValue({
        items: [{ id: 5, name: "小潘", avatarUrl: null, isAdmin: false }],
      }),
    });

  it("卡片与详情写出「已移出项目」，不再回退成内部编号", async () => {
    mount(detachedClient());
    const card = await screen.findByRole("article", {
      name: /^查看任务详情/,
    });
    await waitFor(() =>
      expect(screen.getByText("小潘（已移出项目）")).toBeTruthy(),
    );
    expect(screen.queryByText(/用户 #5/)).toBeNull();

    fireEvent.click(card);
    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(within(dialog).getByText("小潘（已移出项目）")).toBeTruthy();
    expect(
      within(dialog).queryByText("已不在项目成员中，请重新分配"),
    ).toBeNull();
  });

  it("编辑任务的负责人下拉把离职的人标出来并说明要重新分配", async () => {
    mount(detachedClient());
    fireEvent.click(
      await screen.findByRole("article", { name: /^查看任务详情/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "编辑任务" }));
    const editor = within(screen.getByRole("dialog", { name: "编辑任务" }));
    expect(editor.getByText("小潘（已移出项目）")).toBeTruthy();
  });
});

/**
 * F-20 遗留问题页组件测试：未处理/已处理与已作废分桶、来源与跟进任务入口、
 * 转为任务入口（转换弹窗以桩替换，避免在列表测试中加载真实预览）。
 */
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
import { MemoryRouter } from "react-router-dom";
import {
  ApiError,
  type InpulseApiClient,
  type LeftoverListItem,
  type LeftoverItemPage,
  type PublishedRecord,
  type PublishedRecordContent,
} from "@generated/api";
import type { TaskLocation } from "@features/tasks/task-links";
import { IssuesPageView } from "./IssuesPageView";

vi.mock(
  "@features/published-records/RecordDetailModal",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@features/published-records/RecordDetailModal")
      >();
    return {
      ...actual,
      // 弹窗正文（版本、遗留项、GitHub 关联）不在本文件覆盖范围：只桩掉组件本身，
      // 保留 recordDetailTarget 映射，用来验证点击后确实带上了那条来源记录。
      RecordDetailModal: (props: {
        readonly record: {
          readonly recordId: number;
          readonly title: string;
        } | null;
        readonly onOpenTask?: (task: TaskLocation) => void;
      }) =>
        props.record === null ? null : (
          <div data-testid="record-detail-modal">
            {"来源记录 " +
              String(props.record.recordId) +
              " · " +
              props.record.title}
            {/* 页面把就地打开任务的回调交给了记录弹窗（2026-10-10：不再跳项目页）。 */}
            <button
              type="button"
              onClick={() =>
                props.onOpenTask?.({
                  projectId: 1,
                  moduleId: 2,
                  taskId: 105,
                })
              }
            >
              就地打开来源任务
            </button>
          </div>
        ),
    };
  },
);

vi.mock("@features/published-records/ConvertLeftoverTask", () => ({
  LeftoverTaskConvertModal: (props: {
    readonly target: { readonly recordId: number };
  }) => <div data-testid="convert-modal">转换 {props.target.recordId}</div>,
}));

const openItem: LeftoverListItem = {
  leftoverItemId: 8,
  recordId: 7,
  recordCode: "CR-201",
  recordTitle: "充电策略支持参数配置",
  projectId: 1,
  projectName: "AGV 智能搬运平台",
  moduleId: 2,
  moduleName: "任务调度",
  author: { userId: 3, name: "陈晓", avatarUrl: null },
  publishedAt: "2026-08-18T03:00:00.000Z",
  content: "高峰期多车同时等待充电的调度策略仍需优化。",
  status: "ACTIVE",
  sourceTask: {
    taskId: 105,
    code: "T-105",
    projectId: 1,
    moduleId: 2,
  },
  followupTask: null,
};

const followupItem: LeftoverListItem = {
  ...openItem,
  leftoverItemId: 9,
  content: "低密度场景下的提前量仍需单独标定。",
  followupTask: {
    taskId: 140,
    code: "T-140",
    projectId: 1,
    moduleId: 2,
  },
};

const convertPage: LeftoverItemPage = {
  items: [openItem, followupItem],
  nextCursor: "cursor-1",
  hasMore: true,
};

const resolvedItem: LeftoverListItem = {
  ...openItem,
  leftoverItemId: 4,
  recordCode: "CR-224",
  content: "高密度场景下的动态阈值仍由 T-135 跟进。",
  status: "RESOLVED",
  followupTask: null,
};

const closedItem: LeftoverListItem = {
  ...openItem,
  leftoverItemId: 3,
  recordCode: "CR-212",
  content: "密集场景提前量已转为任务。",
  status: "CONVERTED",
  followupTask: {
    taskId: 141,
    code: "T-141",
    projectId: 1,
    moduleId: 2,
  },
};

const voidedItem: LeftoverListItem = {
  ...openItem,
  leftoverItemId: 2,
  recordCode: "CR-190",
  content: "来源迭代记录已作废，这条遗留问题随之作废。",
  status: "VOIDED",
  followupTask: null,
};

const closedPage: LeftoverItemPage = {
  items: [closedItem, resolvedItem, voidedItem],
  nextCursor: null,
  hasMore: false,
};

const publishedRecord: PublishedRecord = {
  title: "充电策略支持参数配置",
  contextProblem: "高峰期车辆等待充电时间过长。",
  changeSolution: "增加参数配置入口。",
  resultVerification: "调度等待时间下降。",
  remainingIssues: [
    { id: 8, content: openItem.content },
    { id: 9, content: followupItem.content },
  ],
  id: 7,
  projectId: 1,
  moduleId: 2,
  taskId: 105,
  handlerId: 3,
  authorId: 3,
  status: "PUBLISHED",
  code: "CR-201",
  currentVersion: 3,
  publishedAt: "2026-08-18T03:00:00.000Z",
  rowVersion: 12,
  createdAt: "2026-08-18T03:00:00.000Z",
  updatedAt: "2026-08-18T03:00:00.000Z",
  leftovers: [
    {
      id: 8,
      content: openItem.content,
      status: "ACTIVE",
      rowVersion: 2,
      linkedTaskId: null,
    },
    {
      id: 9,
      content: followupItem.content,
      status: "ACTIVE",
      rowVersion: 1,
      linkedTaskId: null,
    },
  ],
};

interface ClientOptions {
  readonly open?: LeftoverItemPage;
  readonly closed?: LeftoverItemPage;
  readonly openError?: Error;
  readonly onOpen?: (query: unknown) => void;
  readonly record?: PublishedRecord;
  readonly recordError?: Error;
}

const createClient = (options: ClientOptions = {}) => {
  const listLeftoverItems = vi.fn(
    (query: { readonly bucket?: string; readonly cursor?: string }) => {
      options.onOpen?.(query);
      if (query.bucket === "CLOSED") {
        return Promise.resolve(options.closed ?? closedPage);
      }
      if (options.openError) return Promise.reject(options.openError);
      if (query.cursor === "cursor-1") {
        return Promise.resolve({
          items: [{ ...resolvedItem, leftoverItemId: 10 }],
          nextCursor: null,
          hasMore: false,
        } satisfies LeftoverItemPage);
      }
      return Promise.resolve(options.open ?? convertPage);
    },
  );
  const listProjects = vi.fn().mockResolvedValue({
    items: [
      { id: 1, code: "AGV", name: "AGV 智能搬运平台", status: "ACTIVE" },
      { id: 2, code: "WMS", name: "WMS 仓储调度平台", status: "ACTIVE" },
    ],
  });
  /** 「来源迭代」弹窗与删除流程都会按 recordId 二次读取完整记录。 */
  const getChangeRecord = vi.fn(() =>
    options.recordError === undefined
      ? Promise.resolve(options.record ?? publishedRecord)
      : Promise.reject(options.recordError),
  );
  const issueCsrfToken = vi.fn().mockResolvedValue({
    csrfToken: "csrf-token",
  });
  type VersionCall = [
    projectId: number,
    recordId: number,
    body: PublishedRecordContent,
    init: { headers: Record<string, string> },
  ];
  const createChangeRecordVersion = vi.fn<
    (...args: VersionCall) => Promise<PublishedRecord>
  >(() => Promise.resolve(publishedRecord));
  return {
    client: {
      listLeftoverItems,
      listProjects,
      getChangeRecord,
      issueCsrfToken,
      createChangeRecordVersion,
    } as unknown as InpulseApiClient,
    listLeftoverItems,
    listProjects,
    getChangeRecord,
    issueCsrfToken,
    createChangeRecordVersion,
  };
};

interface RenderOptions extends ClientOptions {
  readonly onBackToRecords?: () => void;
  readonly onOpenTask?: (task: TaskLocation) => void;
}

const renderView = (options: RenderOptions = {}) => {
  const { client, ...mocks } = createClient(options);
  const onBackToRecords = options.onBackToRecords ?? vi.fn();
  const onOpenTask = options.onOpenTask ?? vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/issues"]}>
        <IssuesPageView
          client={client}
          onBackToRecords={onBackToRecords}
          onOpenTask={onOpenTask}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onBackToRecords, onOpenTask, ...mocks };
};

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

describe("IssuesPageView", () => {
  it("renders open leftovers with badge, record code, content and origin", async () => {
    renderView();
    const row = await screen.findByTestId("leftover-item-8");
    expect(within(row).getByText("未处理")).toBeInTheDocument();
    expect(within(row).getByText("CR-201")).toBeInTheDocument();
    expect(
      within(row).getByText("高峰期多车同时等待充电的调度策略仍需优化。"),
    ).toBeInTheDocument();
    // 2026-10-10：来源行改为「[项目标识] 项目名 · 记录「…」 · 模块 · 作者 · 日期」，
    // 标识取项目编码前两位（listProjects 返回 code "AGV" → "AG"）。
    const origin = row.querySelector(".issue-origin");
    expect(origin).toHaveTextContent(
      "AGV 智能搬运平台 · 记录「充电策略支持参数配置」 · 任务调度 · 陈晓 · 2026-08-18",
    );
    expect(origin?.querySelector(".project-logo")?.textContent).toBe("AG");
    expect(
      within(row).getByRole("button", { name: "来源迭代" }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: /转为任务/ }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "删除遗留问题" }),
    ).toBeInTheDocument();
  });
  it("opens the source record modal and the follow-up task", async () => {
    const { onOpenTask } = renderView();
    const user = userEvent.setup();
    // 2026-10-10 用户指示：「来源任务 <编号>」按钮改为「来源迭代」，点击就地打开来源记录
    // 详情弹窗（不再跳来源任务），因此这里断言弹窗带上的是该行的记录而不是任务。
    const sourceRow = await screen.findByTestId("leftover-item-8");
    await user.click(
      within(sourceRow).getByRole("button", { name: "来源迭代" }),
    );
    expect(await screen.findByTestId("record-detail-modal")).toHaveTextContent(
      "来源记录 7 · 充电策略支持参数配置",
    );
    expect(onOpenTask).not.toHaveBeenCalled();

    // 记录详情弹窗拿到宿主的就地打开回调：点里面的来源任务入口交回页面开弹窗。
    await user.click(screen.getByRole("button", { name: "就地打开来源任务" }));
    expect(onOpenTask).toHaveBeenLastCalledWith({
      projectId: 1,
      moduleId: 2,
      taskId: 105,
    });

    const followupRow = await screen.findByTestId("leftover-item-9");
    await user.click(
      within(followupRow).getByRole("button", { name: /查看跟进任务 T-140/ }),
    );
    expect(onOpenTask).toHaveBeenLastCalledWith({
      projectId: 1,
      moduleId: 2,
      taskId: 140,
    });
  });

  it("opens the convert modal only for open items without a follow-up task", async () => {
    renderView();
    const user = userEvent.setup();
    const row = await screen.findByTestId("leftover-item-8");
    await user.click(within(row).getByRole("button", { name: /转为任务/ }));
    expect(await screen.findByTestId("convert-modal")).toHaveTextContent(
      "转换 7",
    );
  });

  it("renders closed leftovers inside a collapsible history block", async () => {
    renderView();
    expect(await screen.findByText("已处理或已作废 3 条")).toBeInTheDocument();
    const converted = await screen.findByTestId("leftover-item-3");
    expect(within(converted).getByText("已处理")).toBeInTheDocument();
    expect(
      within(converted).getByRole("button", { name: /查看跟进任务 T-141/ }),
    ).toBeInTheDocument();
    expect(
      within(converted).queryByRole("button", { name: /转为任务/ }),
    ).toBeNull();
    expect(
      within(converted).queryByRole("button", { name: "删除遗留问题" }),
    ).toBeNull();
    const resolved = await screen.findByTestId("leftover-item-4");
    expect(within(resolved).getByText("已处理")).toBeInTheDocument();
    expect(
      within(resolved).queryByRole("button", { name: /转为任务|查看跟进任务/ }),
    ).toBeNull();
    expect(
      within(resolved).queryByRole("button", { name: "删除遗留问题" }),
    ).toBeNull();

    const voided = await screen.findByTestId("leftover-item-2");
    expect(within(voided).getByText("已作废")).toBeInTheDocument();
    expect(
      within(voided).getByRole("button", { name: "来源迭代" }),
    ).toBeInTheDocument();
    expect(
      within(voided).queryByRole("button", { name: /转为任务|查看跟进任务/ }),
    ).toBeNull();
    expect(
      within(voided).queryByRole("button", { name: "删除遗留问题" }),
    ).toBeNull();
  });

  it("renders the empty state when nothing is open", async () => {
    renderView({
      open: { items: [], nextCursor: null, hasMore: false },
      closed: { items: [], nextCursor: null, hasMore: false },
    });
    expect(await screen.findByText("没有未处理的遗留问题")).toBeInTheDocument();
    expect(screen.queryByText(/已处理或已作废 .* 条/)).toBeNull();
  });

  it("renders an error alert when the open bucket fails", async () => {
    renderView({ openError: new Error("boom") });
    expect(
      await screen.findByText("遗留问题服务暂时不可用，请稍后重试。"),
    ).toBeInTheDocument();
  });

  it("loads the next signed-cursor page on demand", async () => {
    const seen: unknown[] = [];
    renderView({ onOpen: (query) => seen.push(query) });
    const user = userEvent.setup();
    await screen.findByTestId("leftover-item-8");
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByTestId("leftover-item-10")).toBeInTheDocument();
    await waitFor(() =>
      expect(seen).toContainEqual({
        bucket: "OPEN",
        limit: 20,
        cursor: "cursor-1",
      }),
    );
  });

  it("filters both buckets by the selected project", async () => {
    const seen: unknown[] = [];
    renderView({ onOpen: (query) => seen.push(query) });
    await screen.findByTestId("leftover-item-8");

    pickSelectOption("项目", "WMS 仓储调度平台");

    await waitFor(() => {
      expect(seen).toContainEqual({
        bucket: "OPEN",
        limit: 20,
        projectId: 2,
      });
      expect(seen).toContainEqual({
        bucket: "CLOSED",
        limit: 20,
        projectId: 2,
      });
    });

    // 回到全部项目：请求不再携带 projectId（分桶查询与缓存键都回到全局）。
    pickSelectOption("项目", "全部项目");
    await waitFor(() =>
      expect(seen).toContainEqual({ bucket: "OPEN", limit: 20 }),
    );
  });

  it("deletes an active leftover by saving a version without it", async () => {
    const { createChangeRecordVersion, issueCsrfToken } = renderView();
    const user = userEvent.setup();
    const row = await screen.findByTestId("leftover-item-8");
    await user.click(within(row).getByRole("button", { name: "删除遗留问题" }));

    expect(
      await screen.findByRole("dialog", { name: "确认删除遗留问题" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/来源迭代记录、历史版本与审计记录都会保留/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "删除后这条问题会移入「已处理」，并从待处理列表和未处理计数中移除。",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(createChangeRecordVersion).toHaveBeenCalledTimes(1),
    );
    const [projectId, recordId, body, init] =
      createChangeRecordVersion.mock.calls[0]!;
    expect(projectId).toBe(1);
    expect(recordId).toBe(7);
    expect(body.remainingIssues).toEqual([
      { id: 9, content: followupItem.content },
    ]);
    expect(body.confirmLeftoverResolved).toBe(true);
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(init.headers).toMatchObject({
      "x-csrf-token": "csrf-token",
      "If-Match": '"12"',
      "X-Record-Version": "3",
    });
    expect(init.headers["Idempotency-Key"]).toMatch(/^leftover-delete-/);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "确认删除遗留问题" }),
      ).toBeNull(),
    );
  });

  it("keeps the confirmation open on a 409 and reuses the idempotency key", async () => {
    const { createChangeRecordVersion } = renderView();
    createChangeRecordVersion.mockRejectedValueOnce(
      new ApiError(409, {
        code: "RECORD_VERSION_CONFLICT",
        message: "记录版本冲突",
        details: {},
        requestId: "req-1",
      }),
    );
    const user = userEvent.setup();
    const row = await screen.findByTestId("leftover-item-8");
    await user.click(within(row).getByRole("button", { name: "删除遗留问题" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(
      await screen.findByText("记录已被他人更新，请刷新页面后重试。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "确认删除遗留问题" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /确认删除/ }));
    await waitFor(() =>
      expect(createChangeRecordVersion).toHaveBeenCalledTimes(2),
    );
    const [first, second] = createChangeRecordVersion.mock.calls;
    expect(first![3].headers["Idempotency-Key"]).toBe(
      second![3].headers["Idempotency-Key"],
    );
  });
});

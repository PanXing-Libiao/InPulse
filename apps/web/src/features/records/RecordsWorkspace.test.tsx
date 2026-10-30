import React from "react";
import { ConfigProvider } from "antd";
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CurrentUserResponse,
  InpulseApiClient,
  ReadableRecord,
  RecordFeedItem,
} from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { RecordsWorkspace } from "./RecordsWorkspace";

vi.mock("@features/record-drafts/RecordDraftsView", () => ({
  RecordDraftsView: (props: {
    readonly createToken?: number;
    readonly currentUserId?: number;
    readonly onCanCreateChange?: (value: boolean) => void;
  }) => {
    React.useEffect(() => {
      props.onCanCreateChange?.(true);
    }, [props.onCanCreateChange]);
    return (
      <p data-testid="drafts-block">
        草稿令牌 {props.createToken} · 当前用户 {props.currentUserId}
      </p>
    );
  },
}));

const member: CurrentUserResponse = {
  id: 3,
  loginName: "dev-c",
  name: "开发者 C",
  email: null,
  avatarUrl: null,
  isAdmin: false,
  status: "ACTIVE",
};
const admin: CurrentUserResponse = { ...member, id: 1, isAdmin: true };
const first: ReadableRecord = {
  id: 7,
  projectId: 1,
  moduleId: 2,
  taskId: null,
  handlerId: 3,
  authorId: 3,
  status: "PUBLISHED",
  code: "SHOP-CR-1",
  currentVersion: 2,
  publishedAt: "2026-09-10T02:00:00.000Z",
  rowVersion: 3,
  createdAt: "2026-09-10T02:00:00.000Z",
  updatedAt: "2026-09-10T02:00:00.000Z",
  title: "支付修正",
  contextProblem: "重复请求",
  changeSolution: "增加幂等",
  resultVerification: "并发通过",
  remainingIssues: [],
  leftovers: [],
};
const second: ReadableRecord = {
  ...first,
  id: 8,
  projectId: 2,
  code: "RISK-CR-2",
  taskId: 9,
  title: "风控修正",
  changeSolution: "补充风控规则",
  publishedAt: "2026-09-11T02:00:00.000Z",
  createdAt: "2026-09-11T02:00:00.000Z",
  updatedAt: "2026-09-11T02:00:00.000Z",
};

function feedItem(
  record: ReadableRecord,
  overrides: Partial<RecordFeedItem> = {},
): RecordFeedItem {
  return {
    record,
    projectName: record.projectId === 1 ? "支付项目" : "风控项目",
    moduleName: record.projectId === 1 ? "支付模块" : "风控模块",
    author: { userId: record.authorId, name: "开发者 C", avatarUrl: null },
    ...overrides,
  };
}

function baseClient() {
  return {
    listProjects: vi.fn().mockResolvedValue({
      items: [
        { id: 1, name: "支付项目", status: "ACTIVE" },
        { id: 2, name: "风控项目", status: "ACTIVE" },
      ],
    }),
    listRecordFeed: vi.fn().mockResolvedValue({
      items: [feedItem(first), feedItem(second)],
      nextCursor: null,
      hasMore: false,
    }),
    listMyRecordDrafts: vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, hasMore: false }),
    getChangeRecord: vi.fn().mockResolvedValue(first),
    listChangeRecordVersions: vi.fn().mockResolvedValue({ items: [] }),
  };
}

function mount(
  client: InpulseApiClient,
  path: string,
  user: CurrentUserResponse = member,
) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AuthStateProvider value={{ status: "authenticated", user }}>
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider
            client={
              new QueryClient({ defaultOptions: { queries: { retry: false } } })
            }
          >
            <RecordsWorkspace client={client} />
          </QueryClientProvider>
        </MemoryRouter>
      </AuthStateProvider>
    </ConfigProvider>,
  );
}

const signalInit = expect.objectContaining({ signal: expect.any(AbortSignal) });

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

describe("RecordsWorkspace", () => {
  it(
    "loads the cross-project feed by default and keeps the create action" +
      " available for the dialog-side project choice",
    async () => {
      const client = baseClient();
      mount(client as unknown as InpulseApiClient, "/records");
      expect(
        screen.getByRole("heading", { name: "迭代记录" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("项目")).toHaveValue("");
      expect(
        screen.getByLabelText("项目").closest(".ant-select"),
      ).toHaveTextContent("全部项目");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "新建迭代记录" }),
        ).toBeEnabled(),
      );
      expect(client.listRecordFeed).toHaveBeenCalledWith(
        { status: "PUBLISHED", source: "ALL", limit: 20 },
        signalInit,
      );
    },
  );

  it("groups cross-project records by date and backfills the owner names", async () => {
    const client = baseClient();
    const { container } = mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=1&publishedId=7",
    );
    expect(
      await screen.findByText("支付修正", { selector: "summary strong" }),
    ).toBeVisible();
    expect(
      screen.getByText("风控修正", { selector: "summary strong" }),
    ).toBeVisible();
    expect(container.querySelectorAll(".timeline-block")).toHaveLength(2);
    expect(screen.getByText("归属 支付项目 / 支付模块")).toBeVisible();
    expect(screen.getByText("归属 风控项目 / 风控模块")).toBeVisible();
    expect(
      await screen.findByRole("region", { name: "正式记录详情" }),
    ).toBeVisible();
    expect(client.listRecordFeed).toHaveBeenCalledWith(
      { projectId: 1, status: "PUBLISHED", source: "ALL", limit: 20 },
      signalInit,
    );
    expect(client.getChangeRecord).toHaveBeenCalledWith(1, 7, signalInit);
  });

  it("falls back to a standalone detail above the list when the feed cannot reach the record", async () => {
    const client = baseClient();
    const { container } = mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=1&publishedId=99",
    );
    await screen.findByText("支付修正", { selector: "summary strong" });
    expect(
      await screen.findByRole("region", { name: "正式记录详情" }),
    ).toBeVisible();
    expect(client.getChangeRecord).toHaveBeenCalledWith(1, 99, signalInit);
    // 没有后续页时不应反复请求
    expect(client.listRecordFeed).toHaveBeenCalledTimes(1);
    // 兜底详情必须排在时间线上方：它曾放在列表之后，用户只能滚到最底部才看得到。
    const standalone = container.querySelector(".record-standalone-detail");
    const timeline = container.querySelector(".record-timeline");
    expect(standalone).not.toBeNull();
    expect(timeline).not.toBeNull();
    expect(
      standalone!.compareDocumentPosition(timeline!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps loading pages until the deep-linked record lands in the timeline", async () => {
    const client = baseClient();
    client.listRecordFeed
      .mockResolvedValueOnce({
        items: [feedItem(first)],
        nextCursor: "cursor-1",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [feedItem(second)],
        nextCursor: null,
        hasMore: false,
      });
    const { container } = mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=1&publishedId=8",
    );
    expect(
      await screen.findByText("风控修正", { selector: "summary strong" }),
    ).toBeVisible();
    // 未手动点「加载更多」也要续拉：目标记录在后续页里
    expect(client.listRecordFeed).toHaveBeenLastCalledWith(
      {
        projectId: 1,
        status: "PUBLISHED",
        source: "ALL",
        limit: 20,
        cursor: "cursor-1",
      },
      signalInit,
    );
    // 目标记录在时间线里原地展开，不再另起一块兜底详情。
    expect(
      await screen.findByRole("region", { name: "正式记录详情" }),
    ).toBeVisible();
    expect(container.querySelector(".record-standalone-detail")).toBeNull();
  });

  it("stops paging and falls back once the locate limit is reached", async () => {
    const client = baseClient();
    client.listRecordFeed.mockResolvedValue({
      items: [feedItem(first)],
      nextCursor: "cursor-next",
      hasMore: true,
    });
    const { container } = mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=1&publishedId=999",
    );
    await screen.findByText("支付修正", { selector: "summary strong" });
    // 定位上限 5 页：找不到就停手，不能为了一个 ID 把整个记录库拉完。
    await waitFor(() => expect(client.listRecordFeed).toHaveBeenCalledTimes(5));
    expect(container.querySelector(".record-standalone-detail")).not.toBeNull();
    expect(client.getChangeRecord).toHaveBeenCalledWith(1, 999, signalInit);
  });

  it("sends the source filter and the debounced keyword to the server", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient, "/records?projectId=1");
    await screen.findByText("支付修正", { selector: "summary strong" });
    pickSelectOption("归属", "主任务");
    await waitFor(() =>
      expect(client.listRecordFeed).toHaveBeenLastCalledWith(
        {
          projectId: 1,
          status: "PUBLISHED",
          source: "MAIN",
          limit: 20,
        },
        signalInit,
      ),
    );
    fireEvent.change(screen.getByLabelText("搜索迭代记录"), {
      target: { value: "支付" },
    });
    await waitFor(
      () =>
        expect(client.listRecordFeed).toHaveBeenLastCalledWith(
          {
            projectId: 1,
            status: "PUBLISHED",
            source: "MAIN",
            q: "支付",
            limit: 20,
          },
          signalInit,
        ),
      { timeout: 2000 },
    );
    expect(
      screen.queryByText(/列表筛选只在当前已加载/),
    ).not.toBeInTheDocument();
  });

  it("narrows to one project in the toolbar and drops the expanded record", async () => {
    const client = baseClient();
    mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=1&publishedId=7",
    );
    await screen.findByRole("region", { name: "正式记录详情" });
    pickSelectOption("项目", "风控项目");
    await waitFor(() =>
      expect(client.listRecordFeed).toHaveBeenLastCalledWith(
        { projectId: 2, status: "PUBLISHED", source: "ALL", limit: 20 },
        signalInit,
      ),
    );
    expect(
      screen.queryByRole("region", { name: "正式记录详情" }),
    ).not.toBeInTheDocument();
  });

  it("offers the voided and full status filters to administrators only", async () => {
    const client = baseClient();
    const view = mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=1",
    );
    // 非管理员只剩「已发布」一档，单选控件没有可选项，整块不渲染。
    expect(
      screen.queryByRole("group", { name: "记录状态" }),
    ).not.toBeInTheDocument();
    view.unmount();
    const adminClient = baseClient();
    mount(
      adminClient as unknown as InpulseApiClient,
      "/records?projectId=1",
      admin,
    );
    const adminGroup = screen.getByRole("group", { name: "记录状态" });
    fireEvent.click(within(adminGroup).getByRole("button", { name: "已作废" }));
    await waitFor(() =>
      expect(adminClient.listRecordFeed).toHaveBeenLastCalledWith(
        { projectId: 1, status: "VOID", source: "ALL", limit: 20 },
        signalInit,
      ),
    );
    fireEvent.click(within(adminGroup).getByRole("button", { name: "全部" }));
    await waitFor(() =>
      expect(adminClient.listRecordFeed).toHaveBeenLastCalledWith(
        { projectId: 1, status: "ALL", source: "ALL", limit: 20 },
        signalInit,
      ),
    );
  });

  it("loads the next record page with the server cursor", async () => {
    const client = baseClient();
    client.listRecordFeed
      .mockResolvedValueOnce({
        items: [feedItem(first)],
        nextCursor: "cursor-1",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [feedItem(second)],
        nextCursor: null,
        hasMore: false,
      });
    mount(client as unknown as InpulseApiClient, "/records?projectId=1");
    expect(
      await screen.findByText("支付修正", { selector: "summary strong" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(
      await screen.findByText("风控修正", { selector: "summary strong" }),
    ).toBeVisible();
    expect(client.listRecordFeed).toHaveBeenLastCalledWith(
      {
        projectId: 1,
        status: "PUBLISHED",
        source: "ALL",
        limit: 20,
        cursor: "cursor-1",
      },
      signalInit,
    );
  });

  it("keeps the draft block below the filter toolbar", async () => {
    mount(baseClient() as unknown as InpulseApiClient, "/records");
    const drafts = await screen.findByTestId("drafts-block");
    const toolbar = document.querySelector(".records-toolbar");
    expect(toolbar).not.toBeNull();
    expect(
      toolbar!.compareDocumentPosition(drafts) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("passes the current user and an increasing create token to the draft block", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient, "/records?projectId=1");
    expect(await screen.findByTestId("drafts-block")).toHaveTextContent(
      "草稿令牌 0 · 当前用户 3",
    );
    const cta = screen.getByRole("button", { name: "新建迭代记录" });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);
    expect(screen.getByTestId("drafts-block")).toHaveTextContent(
      "草稿令牌 1 · 当前用户 3",
    );
  });

  it("replaces the workspace with one notice when the linked project is out of scope", async () => {
    const client = baseClient();
    mount(
      client as unknown as InpulseApiClient,
      "/records?projectId=9&publishedId=8",
    );
    // 项目 9 不在可读项目里：不能再出现「草稿箱红条 + 记录红条 + 空态」三条并存。
    expect(await screen.findByText("项目不存在或你已无权访问")).toBeVisible();
    expect(screen.queryByText(/输入已保留/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试草稿列表" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试记录" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("drafts-block")).not.toBeInTheDocument();
    // 读不到的项目不再追问那条记录，也不渲染空态。
    expect(client.getChangeRecord).not.toHaveBeenCalled();
    expect(screen.queryByText("暂无已发布记录")).not.toBeInTheDocument();
  });

  it("returns to the cross-project view from the out-of-scope notice", async () => {
    const client = baseClient();
    mount(client as unknown as InpulseApiClient, "/records?projectId=9");
    fireEvent.click(
      await screen.findByRole("button", { name: "查看全部迭代记录" }),
    );
    await waitFor(() =>
      expect(client.listRecordFeed).toHaveBeenLastCalledWith(
        { status: "PUBLISHED", source: "ALL", limit: 20 },
        signalInit,
      ),
    );
    expect(screen.getByRole("button", { name: "新建迭代记录" })).toBeVisible();
  });
});

import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ActivityItem,
  ActivityPage,
  InpulseApiClient,
} from "@generated/api";
import {
  activityDayTotals,
  flattenActivityPages,
  useActivityFeedQuery,
  type ActivityFeedPage,
} from "./activity-query";

function createQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { readonly children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

function activityItem(patch: Partial<ActivityItem>): ActivityItem {
  return {
    id: "1",
    projectId: 7,
    sourceEntityType: "TASK",
    sourceEntityId: 3,
    activityType: "task.complete",
    actorId: 1,
    actorName: "Alice",
    summary: "任务完成：完成任务",
    occurredAt: "2026-09-08T00:00:00.000Z",
    ...patch,
  };
}

function activityPage(patch: Partial<ActivityPage>): ActivityPage {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    dayTotals: [],
    dayTotalsTruncated: false,
    ...patch,
  };
}

function feedPage(
  items: readonly ActivityItem[],
  patch: Partial<ActivityFeedPage> = {},
): ActivityFeedPage {
  return {
    items,
    nextCursor: null,
    hasMore: false,
    dayTotals: [],
    dayTotalsTruncated: false,
    ...patch,
  };
}

/** 首屏 2 条 + 第二条游标；下一页是更早的两条条目。 */
const FIRST_PAGE = activityPage({
  items: [
    activityItem({ id: "4", occurredAt: "2026-09-08T04:00:00.000Z" }),
    activityItem({ id: "3", occurredAt: "2026-09-08T03:00:00.000Z" }),
  ],
  nextCursor: "cursor-1",
  hasMore: true,
  // 服务端全量：当天 3 条，但首屏只加载了 2 条。
  dayTotals: [
    { day: "2026-09-08", count: 3 },
    { day: "2026-09-07", count: 1 },
  ],
});
const SECOND_PAGE = activityPage({
  items: [
    activityItem({ id: "2", occurredAt: "2026-09-07T03:00:00.000Z" }),
    activityItem({ id: "1", occurredAt: "2026-09-07T02:00:00.000Z" }),
  ],
});

function createActivityClient() {
  const listActivity = vi.fn(
    (query: { readonly cursor?: string | undefined }) =>
      Promise.resolve(query.cursor === "cursor-1" ? SECOND_PAGE : FIRST_PAGE),
  );
  const getProjectActivity = vi.fn(() => Promise.resolve(FIRST_PAGE));
  return {
    listActivity,
    getProjectActivity,
    client: { listActivity, getProjectActivity } as unknown as InpulseApiClient,
  };
}

interface FeedProbeProps {
  readonly client: InpulseApiClient;
  readonly projectIds?: readonly number[];
}

function FeedProbe({ client, projectIds }: FeedProbeProps) {
  const query = useActivityFeedQuery({
    scopeKey: "test",
    ...(projectIds === undefined ? {} : { projectIds }),
    client,
    category: "task",
    includeAdminOnly: true,
  });
  return (
    <div>
      <span data-testid="page-count">{query.data?.pages.length ?? 0}</span>
      <span data-testid="has-next">{String(query.hasNextPage)}</span>
      <span data-testid="item-ids">
        {flattenActivityPages(query.data?.pages ?? [])
          .map((item) => item.id)
          .join(",")}
      </span>
      <span data-testid="first-day-total">
        {activityDayTotals(query.data?.pages ?? []).totals.get("2026-09-08") ??
          "-"}
      </span>
      <button type="button" onClick={() => void query.fetchNextPage()}>
        加载更多
      </button>
    </div>
  );
}

describe("flattenActivityPages", () => {
  it("服务端已是全局倒序，拼接只按分页顺序追加，不再重排日期", () => {
    const pages = [
      feedPage([activityItem({ id: "4" }), activityItem({ id: "3" })]),
      feedPage([activityItem({ id: "2" }), activityItem({ id: "1" })]),
    ];

    expect(flattenActivityPages(pages).map((item) => item.id)).toEqual([
      "4",
      "3",
      "2",
      "1",
    ]);
  });
});

describe("activityDayTotals", () => {
  it("只取首页下发的按日总数与截断标记", () => {
    const first = feedPage([], {
      dayTotals: [{ day: "2026-09-08", count: 5 }],
      dayTotalsTruncated: true,
    });
    const totals = activityDayTotals([first, feedPage([])]);

    expect(totals.totals.get("2026-09-08")).toBe(5);
    expect(totals.truncated).toBe(true);
  });

  it("还没有数据时返回空统计且不截断", () => {
    const totals = activityDayTotals([]);

    expect(totals.totals.size).toBe(0);
    expect(totals.truncated).toBe(false);
  });
});

describe("useActivityFeedQuery", () => {
  it("「全部项目」不枚举项目，单请求按游标只追加更早的条目", async () => {
    const { listActivity, client } = createActivityClient();
    const { queryClient } = createQueryWrapper();

    render(
      <QueryClientProvider client={queryClient}>
        <FeedProbe client={client} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("page-count").textContent).toBe("1"),
    );
    // 缺省范围由服务端决定（当前授权范围），因此不传 projectIds。
    expect(listActivity).toHaveBeenCalledWith(
      { category: "task", includeAdminOnly: true, limit: 20 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByTestId("item-ids").textContent).toBe("4,3");
    expect(screen.getByTestId("has-next").textContent).toBe("true");
    expect(screen.getByTestId("first-day-total").textContent).toBe("3");

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));

    await waitFor(() =>
      expect(screen.getByTestId("page-count").textContent).toBe("2"),
    );
    expect(listActivity).toHaveBeenLastCalledWith(
      {
        category: "task",
        cursor: "cursor-1",
        includeAdminOnly: true,
        limit: 20,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // 第二页是更早的条目，追加在尾部，不会插到 4/3 之间。
    expect(screen.getByTestId("item-ids").textContent).toBe("4,3,2,1");
    // 按日数量是服务端下发的全量，不随翻页变化。
    expect(screen.getByTestId("first-day-total").textContent).toBe("3");
    expect(screen.getByTestId("has-next").textContent).toBe("false");
  });

  it("显式收窄范围时把项目 ID 交给服务端", async () => {
    const { listActivity, client } = createActivityClient();
    const { wrapper } = createQueryWrapper();

    renderHook(
      () =>
        useActivityFeedQuery({
          scopeKey: "narrow",
          projectIds: [9, 7],
          client,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(listActivity).toHaveBeenCalledWith(
        { projectIds: [9, 7], limit: 20 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("空范围不发请求", async () => {
    const { listActivity, client } = createActivityClient();
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(
      () => useActivityFeedQuery({ scopeKey: "empty", projectIds: [], client }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(listActivity).not.toHaveBeenCalled();
  });

  it("锁定项目时仍走项目级路由", async () => {
    const { getProjectActivity, listActivity, client } = createActivityClient();
    const { wrapper } = createQueryWrapper();

    renderHook(
      () =>
        useActivityFeedQuery({
          scopeKey: "project:7",
          lockedProjectId: 7,
          includeAdminOnly: true,
          client,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(getProjectActivity).toHaveBeenCalledWith(
        7,
        { includeAdminOnly: true, limit: 20 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(listActivity).not.toHaveBeenCalled();
  });
});

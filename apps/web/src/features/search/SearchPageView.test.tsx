import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type SearchItem,
} from "@generated/api";
import { SearchPageView } from "./SearchPageView";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("SearchPageView", () => {
  it("renders search results and loads the next page", async () => {
    const user = userEvent.setup();
    const getSearch = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            projectId: 1,
            entityType: "PROJECT",
            entityId: 1,
            moduleId: null,
            featureId: null,
            recordId: null,
            title: "InPulse 项目",
            summary: "项目摘要",
          } satisfies SearchItem,
        ],
        nextCursor: "cursor-1",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [
          {
            projectId: 1,
            entityType: "TASK",
            entityId: 2,
            moduleId: 3,
            featureId: 4,
            recordId: null,
            title: "InPulse 任务",
            summary: "任务摘要",
          } satisfies SearchItem,
        ],
        nextCursor: null,
        hasMore: false,
      });
    const client = { getSearch } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <SearchPageView initialQuery="inpulse" client={client} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("InPulse 项目")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("InPulse 任务")).toBeInTheDocument();
    expect(getSearch).toHaveBeenLastCalledWith({
      q: "inpulse",
      cursor: "cursor-1",
      limit: 20,
    });
  });

  it("renders the leftover classification label", async () => {
    const getSearch = vi.fn().mockResolvedValue({
      items: [
        {
          projectId: 1,
          entityType: "LEFTOVER",
          entityId: 9,
          moduleId: null,
          featureId: null,
          recordId: 2048,
          title: "登录页偶发闪白",
          summary: "待处理 · CR-2048 登录页偶发闪白",
        } satisfies SearchItem,
      ],
      nextCursor: null,
      hasMore: false,
    });
    const client = { getSearch } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <SearchPageView initialQuery="闪白" client={client} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("遗留问题")).toBeInTheDocument();
    expect(await screen.findByText("登录页偶发闪白")).toBeInTheDocument();
  });

  it("opens each result's own page and only hints at types without one", async () => {
    const user = userEvent.setup();
    const getSearch = vi.fn().mockResolvedValue({
      items: [
        {
          projectId: 5,
          entityType: "TASK",
          entityId: 42,
          moduleId: 3,
          featureId: null,
          recordId: null,
          title: "模块级任务",
          summary: "任务摘要",
        } satisfies SearchItem,
        {
          projectId: 5,
          entityType: "LEFTOVER",
          entityId: 9,
          moduleId: null,
          featureId: null,
          recordId: 2048,
          title: "登录页偶发闪白",
          summary: "待处理",
        } satisfies SearchItem,
        {
          projectId: 5,
          entityType: "EXTERNAL_LINK",
          entityId: 77,
          moduleId: null,
          featureId: null,
          recordId: null,
          title: "PR #12 修复登录",
          summary: "已合并 Pull Request",
        } satisfies SearchItem,
      ],
      nextCursor: null,
      hasMore: false,
    });
    const onOpenResult = vi.fn();

    render(
      <QueryClientProvider client={createQueryClient()}>
        <SearchPageView
          initialQuery="登录"
          onOpenResult={onOpenResult}
          client={{ getSearch } as unknown as InpulseApiClient}
        />
      </QueryClientProvider>,
    );

    // 模块级任务：功能为空也必须落到所属模块的任务列表并带上任务深链
    await user.click(await screen.findByRole("link", { name: /模块级任务/ }));
    expect(onOpenResult).toHaveBeenCalledWith(
      "/projects/5/modules/3/tasks?taskId=42",
    );

    // 遗留问题：落到所属记录（记录作废/恢复状态与入口无关，由记录页自己判定）
    await user.click(
      await screen.findByRole("link", { name: /登录页偶发闪白/ }),
    );
    expect(onOpenResult).toHaveBeenCalledWith(
      "/records?view=published&projectId=5&publishedId=2048",
    );

    // 外部链接没有独立页面：不给点击入口，也不冒充链接
    expect(
      screen.queryByRole("link", { name: /PR #12 修复登录/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("该类型没有独立页面，可在所属对象的页面上查看"),
    ).toBeInTheDocument();
  });

  it("shows a validation hint without calling the API for an over-long query", async () => {
    const getSearch = vi.fn();
    const client = { getSearch } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <SearchPageView initialQuery={"a".repeat(201)} client={client} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("搜索词最多 200 个字符"),
    ).toBeInTheDocument();
    expect(getSearch).not.toHaveBeenCalled();
  });

  it("shows a generic login message for a 401 response", async () => {
    const getSearch = vi.fn().mockRejectedValue(
      new ApiError(401, {
        code: "UNAUTHORIZED",
        message: "server-internal-message",
        details: {},
        requestId: "request-1",
      }),
    );
    const client = { getSearch } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider client={createQueryClient()}>
        <SearchPageView initialQuery="inpulse" client={client} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("登录状态已失效，请重新登录。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("server-internal-message"),
    ).not.toBeInTheDocument();
  });
});

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InpulseApiClient, SearchItem } from "@generated/api";
import { CommandPalette } from "./CommandPalette";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/** Enter / 方向键语义用例共用的搜索结果夹具（项目 + 遗留问题各一条）。 */
const searchItems: SearchItem[] = [
  {
    projectId: 7,
    entityType: "PROJECT",
    entityId: 7,
    moduleId: null,
    recordId: null,
    title: "商城系统",
    summary: "SHOP · 商城项目描述",
  },
  {
    projectId: 7,
    entityType: "LEFTOVER",
    entityId: 9,
    moduleId: null,
    recordId: 2048,
    title: "登录页偶发闪白",
    summary: "待处理 · CR-2048 登录页偶发闪白",
  },
];

const searchClient = {
  getSearch: vi.fn().mockResolvedValue({
    items: searchItems,
    nextCursor: null,
    hasMore: false,
  }),
} as unknown as InpulseApiClient;

describe("CommandPalette", () => {
  it("searches through the generated client and opens the search page for a result", async () => {
    const user = userEvent.setup();
    const getSearch = vi.fn().mockResolvedValue({
      items: [
        {
          projectId: 7,
          entityType: "PROJECT",
          entityId: 7,
          moduleId: null,
          recordId: null,
          title: "商城系统",
          summary: "SHOP · 商城项目描述",
        } satisfies SearchItem,
        {
          projectId: 7,
          entityType: "LEFTOVER",
          entityId: 9,
          moduleId: null,
          recordId: 2048,
          title: "登录页偶发闪白",
          summary: "待处理 · CR-2048 登录页偶发闪白",
        } satisfies SearchItem,
        {
          projectId: 7,
          entityType: "EXTERNAL_LINK",
          entityId: 77,
          moduleId: null,
          recordId: null,
          title: "PR #12 修复登录",
          summary: "已合并 Pull Request",
        } satisfies SearchItem,
      ],
      nextCursor: null,
      hasMore: false,
    });
    const client = { getSearch } as unknown as InpulseApiClient;
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onOpenSearch = vi.fn();

    render(
      <QueryClientProvider client={createQueryClient()}>
        <CommandPalette
          open
          client={client}
          onClose={onClose}
          onNavigate={onNavigate}
          onOpenSearch={onOpenSearch}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: "全局搜索" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^打开任务中心/ }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("全局搜索关键词"), "inpulse");

    expect(getSearch).toHaveBeenCalledWith(
      expect.objectContaining({ q: "inpulse", limit: 20 }),
    );
    expect(await screen.findByText("遗留问题")).toBeInTheDocument();

    // 结果行直接打开对象自己的页面（回归：旧行为是把用户送回去搜索页）
    await user.click(await screen.findByRole("button", { name: /^商城系统/ }));
    expect(onNavigate).toHaveBeenCalledWith("/projects/7/modules");
    expect(onClose).toHaveBeenCalled();

    // 没有独立页面的类型不列进启动器，避免选中后无处可去
    expect(
      screen.queryByRole("button", { name: /^PR #12 修复登录/ }),
    ).not.toBeInTheDocument();

    // 完整列表入口保留：需要看全部受权限过滤的结果时仍从搜索页走
    await user.click(
      await screen.findByRole("button", { name: /^搜索“inpulse”/ }),
    );
    expect(onOpenSearch).toHaveBeenCalledWith("inpulse");
  });

  it("直接按 Enter 进入全局搜索页，而不是打开第一行结果", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onOpenSearch = vi.fn();

    render(
      <QueryClientProvider client={createQueryClient()}>
        <CommandPalette
          open
          client={searchClient}
          onClose={onClose}
          onNavigate={onNavigate}
          onOpenSearch={onOpenSearch}
        />
      </QueryClientProvider>,
    );

    await user.type(screen.getByLabelText("全局搜索关键词"), "inpulse");
    expect(
      await screen.findByRole("button", { name: /^商城系统/ }),
    ).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(onOpenSearch).toHaveBeenCalledWith("inpulse");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("用方向键选中具体结果后 Enter 才打开该结果", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onOpenSearch = vi.fn();

    render(
      <QueryClientProvider client={createQueryClient()}>
        <CommandPalette
          open
          client={searchClient}
          onClose={onClose}
          onNavigate={onNavigate}
          onOpenSearch={onOpenSearch}
        />
      </QueryClientProvider>,
    );

    await user.type(screen.getByLabelText("全局搜索关键词"), "inpulse");
    expect(
      await screen.findByRole("button", { name: /^商城系统/ }),
    ).toBeInTheDocument();

    // 扁平顺序与分组显示顺序一致：↓ 选中的是屏幕上第一行结果
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onNavigate).toHaveBeenCalledWith("/projects/7/modules");
    expect(onOpenSearch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes with Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <CommandPalette
          open
          onClose={onClose}
          onNavigate={vi.fn()}
          onOpenSearch={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
  it("只对系统管理员显示成员与设置快捷命令", async () => {
    const renderPalette = (isAdmin: boolean) =>
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <CommandPalette
            open
            isAdmin={isAdmin}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
            onOpenSearch={vi.fn()}
          />
        </QueryClientProvider>,
      );

    const { unmount } = renderPalette(false);
    expect(
      screen.queryByRole("button", { name: /^打开成员与设置/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^打开任务中心/ }),
    ).toBeInTheDocument();
    unmount();

    renderPalette(true);
    expect(
      screen.getByRole("button", { name: /^打开成员与设置/ }),
    ).toBeInTheDocument();
  });
});

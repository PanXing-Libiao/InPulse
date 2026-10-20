import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type InpulseApiClient } from "@generated/api";
import { ActiveProjectMembers } from "./ActiveProjectMembers";

const project = {
  id: 7,
  code: "INPULSE",
  name: "InPulse 研发交付平台",
  description: "示例项目",
  status: "ACTIVE" as const,
  hasCompletedTask: false,
  rowVersion: 2,
  createdBy: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  memberCount: 2,
  stats: {
    activeModuleCount: 2,
    activeFeatureCount: 5,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

const activeMembers = [
  {
    id: 2,
    name: "开发者 C",
    avatarUrl: null,
    role: "LEADER" as const,
    joinedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: 5,
    name: "小邵",
    avatarUrl: null,
    role: "MEMBER" as const,
    joinedAt: "2026-09-05T08:00:00.000Z",
  },
];

function mount(client: InpulseApiClient) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ActiveProjectMembers
          projectId={7}
          projectDetail={project}
          client={client}
        />
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

function baseClient(overrides: Record<string, unknown> = {}) {
  return {
    listActiveProjectMembers: vi
      .fn()
      .mockResolvedValue({ items: activeMembers }),
    ...overrides,
  } as unknown as InpulseApiClient;
}

describe("ActiveProjectMembers（普通成员只读视图）", () => {
  it("renders the active members reusing the admin visual language", async () => {
    mount(baseClient());

    await screen.findByText("开发者 C（创建者）");
    expect(screen.getByText("小邵")).toBeInTheDocument();
    // 与管理员视图一致的页头、面板与成员卡片结构。
    expect(
      screen.getByRole("heading", {
        name: "InPulse 研发交付平台",
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(document.querySelector(".panel.settings-panel")).not.toBeNull();
    expect(document.querySelectorAll(".calm-member-card")).toHaveLength(
      activeMembers.length,
    );
  });

  it("is read-only: no add/remove/reassign/archive affordances", async () => {
    mount(baseClient());
    await screen.findByText("开发者 C（创建者）");

    // 管理员视图里存在的写操作入口在只读视图必须缺席。
    expect(
      screen.queryByRole("button", { name: /添加成员/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^移\s*除$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /归档项目/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 「刷新成员」是唯一的非破坏性动作。
    expect(
      screen.getByRole("button", { name: /刷新成员/ }),
    ).toBeInTheDocument();
  });

  it("marks the creator and lists only active members", async () => {
    mount(baseClient());
    await screen.findByText("开发者 C（创建者）");

    const cards = document.querySelectorAll(".calm-member-card");
    const creatorCard = Array.from(cards).find((card) =>
      card.textContent?.includes("开发者 C"),
    );
    expect(creatorCard?.textContent).toContain("（创建者）");
    // 只读接口只返回活跃成员，不出现「已移除」历史态。
    expect(screen.queryByText("已移除")).not.toBeInTheDocument();
    for (const card of cards) {
      expect(within(card as HTMLElement).getByText("活跃成员")).toBeTruthy();
    }
  });

  it("shows joined time and role badges without role management", async () => {
    mount(baseClient());
    await screen.findByText("开发者 C（创建者）");

    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(".calm-member-card"),
    );
    const leaderCard = cards.find((card) =>
      card.textContent?.includes("开发者 C"),
    );
    const memberCard = cards.find((card) => card.textContent?.includes("小邵"));
    expect(leaderCard).toBeTruthy();
    expect(memberCard).toBeTruthy();

    // 与管理员视图一致：显示加入时间，非默认角色显示身份徽标。
    expect(leaderCard?.textContent).toContain("加入时间：");
    expect(within(leaderCard!).getByText("组长")).toBeTruthy();
    // MEMBER 不渲染角色徽标，也不出现已移除历史。
    expect(within(memberCard!).queryByText("成员")).toBeNull();
    expect(screen.queryByText("移除时间：")).not.toBeInTheDocument();
    // 角色管理仍属管理员视图。
    expect(
      screen.queryByRole("button", { name: /设为组长|转移组长/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when the project has no active members", async () => {
    mount(
      baseClient({
        listActiveProjectMembers: vi.fn().mockResolvedValue({ items: [] }),
      }),
    );

    expect(await screen.findByText("暂无项目成员")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /添加成员/ }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a retry action when the member list fails to load", async () => {
    const client = baseClient({
      listActiveProjectMembers: vi.fn().mockRejectedValue(
        new ApiError(500, {
          code: "UNEXPECTED_ERROR",
          details: {},
          requestId: "req-1",
        }),
      ),
    });
    mount(client);

    expect(await screen.findByText("项目成员加载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重\s*试/ })).toBeInTheDocument();
  });
});

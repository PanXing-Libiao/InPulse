import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActivityItem, InpulseApiClient } from "@generated/api";
import { AuthStateProvider } from "@features/auth/auth-context";
import { ActivityPageView } from "./ActivityPageView";

const PROJECT = {
  id: 7,
  code: "INPULSE",
  name: "InPulse 研发交付平台",
  description: null,
  status: "ACTIVE" as const,
  rowVersion: 1,
  createdBy: 1,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
  memberCount: 4,
  stats: {
    activeModuleCount: 2,
    activeFeatureCount: 5,
    openTaskCount: 3,
    completedTaskCount: 1,
  },
};

/** 覆盖主要视觉类别的代表性动态（2026-10-09 方案 B 的 DOM 约定）。 */
const ROWS: readonly ActivityItem[] = [
  {
    id: "v1",
    projectId: 7,
    sourceEntityType: "MODULE",
    sourceEntityId: 10,
    activityType: "module.create",
    actorId: 812,
    actorName: "邵晨宇",
    summary: "创建模块：登录",
    occurredAt: "2026-10-09T07:10:00.000000Z",
  },
  {
    id: "v2",
    projectId: 7,
    sourceEntityType: "TASK",
    sourceEntityId: 20,
    activityType: "TASK_DELETED",
    actorId: 812,
    actorName: "邵晨宇",
    summary: "删除了任务 登录接口",
    occurredAt: "2026-10-09T07:00:00.000000Z",
  },
  {
    id: "v3",
    projectId: 7,
    sourceEntityType: "TASK",
    sourceEntityId: 21,
    activityType: "task.complete",
    actorId: 812,
    actorName: "邵晨宇",
    summary: "任务完成：登录接口 交付",
    occurredAt: "2026-10-09T06:50:00.000000Z",
  },
  {
    id: "v4",
    projectId: 7,
    sourceEntityType: "TASK",
    sourceEntityId: 22,
    activityType: "EXTERNAL_LINK_ADDED",
    actorId: 812,
    actorName: "邵晨宇",
    summary: "添加 GitHub 关联：PR #245（任务 LIINK-T-90）",
    occurredAt: "2026-10-09T06:40:00.000000Z",
  },
  {
    id: "v5",
    projectId: 7,
    sourceEntityType: "PROJECT",
    sourceEntityId: 7,
    activityType: "PROJECT_MEMBER_ADDED",
    actorId: 812,
    actorName: "邵晨宇",
    summary: "添加成员：李雷",
    occurredAt: "2026-10-09T06:30:00.000000Z",
  },
];

function createClient(): InpulseApiClient {
  return {
    listActivity: vi.fn().mockResolvedValue({
      items: [...ROWS],
      nextCursor: null,
      hasMore: false,
      dayTotals: [],
      dayTotalsTruncated: false,
    }),
    listProjects: vi.fn().mockResolvedValue({ items: [PROJECT] }),
    getUserDirectory: vi.fn().mockResolvedValue({
      items: [{ id: 812, name: "邵晨宇", avatarUrl: null, isAdmin: true }],
    }),
  } as unknown as InpulseApiClient;
}

function mount(client: InpulseApiClient) {
  return render(
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <MemoryRouter>
        <AuthStateProvider
          value={{
            status: "authenticated",
            user: {
              id: 812,
              loginName: "shaochenyu",
              name: "邵晨宇",
              avatarUrl: null,
              email: null,
              isAdmin: true,
              status: "ACTIVE",
            },
          }}
        >
          <QueryClientProvider
            client={
              new QueryClient({ defaultOptions: { queries: { retry: false } } })
            }
          >
            <ActivityPageView client={client} />
          </QueryClientProvider>
        </AuthStateProvider>
      </MemoryRouter>
    </ConfigProvider>,
  );
}

describe("项目动态行视觉编码（2026-10-09 方案 B）", () => {
  it("按动作类别写入 data-kind 与 data-entity，供样式着色", async () => {
    mount(createClient());

    const createRow = await screen.findByTestId("activity-item-v1");
    expect(createRow).toHaveAttribute("data-kind", "create");
    expect(createRow).toHaveAttribute("data-entity", "MODULE");
    expect(screen.getByTestId("activity-item-v2")).toHaveAttribute(
      "data-kind",
      "delete",
    );
    expect(screen.getByTestId("activity-item-v3")).toHaveAttribute(
      "data-kind",
      "status",
    );
    expect(screen.getByTestId("activity-item-v4")).toHaveAttribute(
      "data-kind",
      "create",
    );
    expect(screen.getByTestId("activity-item-v5")).toHaveAttribute(
      "data-kind",
      "create",
    );
  });

  it("对象图标徽章渲染在时间单元格里，含 svg 图标且不替换时刻文本", async () => {
    mount(createClient());

    const row = await screen.findByTestId("activity-item-v1");
    const timeCell = row.querySelector(".audit-time");
    expect(timeCell).not.toBeNull();
    const badge = timeCell?.querySelector(".activity-kind-badge");
    expect(badge).not.toBeNull();
    expect(badge?.querySelector("svg")).not.toBeNull();
    // 07:10Z = 北京时间 15:10；徽章是追加项，不替换时间。
    expect(timeCell).toHaveTextContent("15:10");
  });

  it("动作词带 activity-action 类，由行类别变量驱动着色", async () => {
    mount(createClient());

    const row = await screen.findByTestId("activity-item-v1");
    expect(within(row).getByText("创建模块")).toHaveClass("activity-action");
    const deleteRow = screen.getByTestId("activity-item-v2");
    expect(within(deleteRow).getByText("删除任务")).toHaveClass(
      "activity-action",
    );
  });
});

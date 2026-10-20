import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InpulseApiClient } from "@generated/api";
import { NotificationsPageView } from "./NotificationsPageView";

function createClient() {
  const getNotifications = vi.fn().mockResolvedValue({
    items: [
      {
        id: "42",
        projectId: 1,
        notificationType: "PROJECT_JOINED",
        title: "你已加入成员项目",
        body: "成员项目通知",
        targetPath: "/projects/1/activity",
        createdAt: "2026-09-08T00:00:00.000Z",
        readAt: null,
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  const getNotificationUnreadCount = vi
    .fn()
    .mockResolvedValue({ unreadCount: 1 });
  const issueCsrfToken = vi.fn().mockResolvedValue({ csrfToken: "csrf-1" });
  const readNotification = vi.fn().mockResolvedValue(undefined);
  const client = {
    getNotifications,
    getNotificationUnreadCount,
    issueCsrfToken,
    readNotification,
  } as unknown as InpulseApiClient;
  return {
    client,
    getNotificationUnreadCount,
    issueCsrfToken,
    readNotification,
  };
}

describe("NotificationsPageView", () => {
  it("renders notifications and marks one as read with CSRF", async () => {
    const user = userEvent.setup();
    const { client, readNotification } = createClient();

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <NotificationsPageView client={client} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("你已加入成员项目")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "标记已读" }));

    await waitFor(() => expect(readNotification).toHaveBeenCalledTimes(1));
    expect(readNotification).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-csrf-token": "csrf-1" }),
      }),
    );
  });

  it("opens the target path and marks an unread notification when clicked", async () => {
    const user = userEvent.setup();
    const { client, readNotification } = createClient();
    const onOpenTarget = vi.fn();

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <NotificationsPageView client={client} onOpenTarget={onOpenTarget} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("你已加入成员项目")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "打开通知：你已加入成员项目" }),
    );

    await waitFor(() =>
      expect(onOpenTarget).toHaveBeenCalledWith("/projects/1/activity"),
    );
    expect(readNotification).toHaveBeenCalledTimes(1);
  });

  it("把 dot.case 通知类型也显示成中文标签", async () => {
    const getNotifications = vi.fn().mockResolvedValue({
      items: [
        {
          id: "81",
          projectId: 1,
          notificationType: "record.publish",
          title: "迭代记录已发布",
          body: "INPULSE-R-12",
          targetPath: "/projects/1/activity",
          createdAt: "2026-09-20T00:00:00.000Z",
          readAt: null,
        },
        {
          id: "82",
          projectId: 1,
          notificationType: "task.complete",
          title: "任务完成：单点登录",
          body: "INPULSE-T-59",
          targetPath: "/projects/1/activity",
          createdAt: "2026-09-20T01:00:00.000Z",
          readAt: null,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const client = {
      getNotifications,
      getNotificationUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 2 }),
    } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <NotificationsPageView client={client} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("发布记录")).toBeInTheDocument();
    expect(screen.getByText("任务完成")).toBeInTheDocument();
    expect(screen.queryByText("record.publish")).not.toBeInTheDocument();
    expect(screen.queryByText("task.complete")).not.toBeInTheDocument();
  });

  it("只为未读通知显示红点", async () => {
    const getNotifications = vi.fn().mockResolvedValue({
      items: [
        {
          id: "101",
          projectId: 1,
          notificationType: "PROJECT_JOINED",
          title: "未读通知",
          body: "应显示红点",
          targetPath: null,
          createdAt: "2026-09-20T01:00:00.000Z",
          readAt: null,
        },
        {
          id: "102",
          projectId: 1,
          notificationType: "PROJECT_JOINED",
          title: "已读通知",
          body: "不应显示红点",
          targetPath: null,
          createdAt: "2026-09-20T00:00:00.000Z",
          readAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const client = {
      getNotifications,
      getNotificationUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 1 }),
    } as unknown as InpulseApiClient;

    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <NotificationsPageView client={client} />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("notification-dot-101")).toHaveAttribute(
      "data-unread",
      "true",
    );
    expect(screen.getByTestId("notification-dot-102")).toHaveAttribute(
      "data-unread",
      "false",
    );
  });
});

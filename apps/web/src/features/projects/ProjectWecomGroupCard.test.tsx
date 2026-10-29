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
import type { InpulseApiClient, ProjectWecomGroupStatus } from "@generated/api";
import { ProjectWecomGroupCard } from "./ProjectWecomGroupCard";

const unbound: ProjectWecomGroupStatus = {
  state: "UNBOUND",
  webhookTargets: [],
  notificationOptions: { disabledCategories: [] },
};

const webhookTarget = {
  id: 19,
  label: "研发项目群",
  urlHint: "WXYZ",
  boundAt: "2026-10-28T02:00:00.000Z",
  boundByName: "开发者 B",
  lastDeliveryError: null,
} as const;

const bound: ProjectWecomGroupStatus = {
  state: "BOUND",
  webhookTargets: [webhookTarget],
  notificationOptions: { disabledCategories: [] },
};

function mount(options: {
  readonly statuses: readonly ProjectWecomGroupStatus[];
  readonly canManage: boolean;
}) {
  let call = 0;
  const getProjectWecomGroup = vi.fn().mockImplementation(async () => {
    const status =
      options.statuses[Math.min(call, options.statuses.length - 1)];
    call += 1;
    return status;
  });
  const updateProjectWecomGroupNotificationOptions = vi
    .fn()
    .mockImplementation(async (_projectId: number, body) => body);
  const createProjectWecomWebhook = vi.fn().mockResolvedValue(webhookTarget);
  const deleteProjectWecomWebhook = vi.fn().mockResolvedValue(undefined);
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  const client = {
    getProjectWecomGroup,
    updateProjectWecomGroupNotificationOptions,
    createProjectWecomWebhook,
    deleteProjectWecomWebhook,
    issueCsrfToken,
  } as unknown as InpulseApiClient;
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProjectWecomGroupCard
          projectId={7}
          canManage={options.canManage}
          client={client}
        />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return {
    getProjectWecomGroup,
    updateProjectWecomGroupNotificationOptions,
    createProjectWecomWebhook,
    deleteProjectWecomWebhook,
    issueCsrfToken,
  };
}

describe("ProjectWecomGroupCard（ADR-106 Webhook-only）", () => {
  it("未配置且普通成员：展示 Webhook 引导与只读提示，不出现 BOT 操作", async () => {
    mount({ statuses: [unbound], canManage: false });
    await screen.findByText(/添加 Webhook 后群聊即可收到项目消息/);
    expect(
      screen.getByText(
        /默认推送任务派发、任务状态、记录、项目成员与删除类动态/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/只有项目组长或系统管理员可以添加或删除 Webhook 目标/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/聊天信息 → 消息推送 → 添加机器人/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/群机器人 → 添加机器人/)).toBeNull();
    expect(screen.queryByText(/绑定码/)).toBeNull();
    expect(screen.queryByText(/解绑智能机器人/)).toBeNull();
    expect(screen.queryByRole("button", { name: "添加 Webhook" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通知选项" })).toBeNull();
  });

  it("组长在空态可以打开添加 Webhook 表单", async () => {
    mount({ statuses: [unbound], canManage: true });
    await screen.findByText(/添加 Webhook 后群聊即可收到项目消息/);
    fireEvent.click(screen.getByRole("button", { name: "添加 Webhook" }));
    expect(screen.getByLabelText("Webhook 目标群标签")).toBeInTheDocument();
    expect(screen.getByLabelText("企业微信 Webhook 地址")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "保存 Webhook" }),
    ).toBeInTheDocument();
  });

  it("添加 Webhook：携带 CSRF 与一次性幂等 Key，成功后刷新目标列表", async () => {
    const { createProjectWecomWebhook, issueCsrfToken } = mount({
      statuses: [unbound, bound],
      canManage: true,
    });
    await screen.findByText(/添加 Webhook 后群聊即可收到项目消息/);
    fireEvent.click(screen.getByRole("button", { name: "添加 Webhook" }));

    fireEvent.change(screen.getByLabelText("Webhook 目标群标签"), {
      target: { value: "研发项目群" },
    });
    fireEvent.change(screen.getByLabelText("企业微信 Webhook 地址"), {
      target: {
        value:
          "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key-WXYZ",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 Webhook" }));

    await waitFor(() =>
      expect(createProjectWecomWebhook).toHaveBeenCalledTimes(1),
    );
    const [projectId, body, init] = createProjectWecomWebhook.mock.calls[0] as [
      number,
      { readonly label: string; readonly webhookUrl: string },
      { readonly headers: Record<string, string> },
    ];
    expect(projectId).toBe(7);
    expect(body).toEqual({
      label: "研发项目群",
      webhookUrl:
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key-WXYZ",
    });
    expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
    expect(init.headers["Idempotency-Key"]).toMatch(/^pwg-webhook-create-/);
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("研发项目群")).toBeInTheDocument();
  });

  it("普通成员可查看 Webhook 列表但不能添加、删除或修改通知选项", async () => {
    mount({ statuses: [bound], canManage: false });
    await screen.findByText("研发项目群");
    expect(screen.queryByRole("button", { name: "添加 Webhook" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通知选项" })).toBeNull();
  });

  it("删除 Webhook 逐项调用服务端并携带幂等 Key", async () => {
    const { deleteProjectWecomWebhook } = mount({
      statuses: [bound, unbound],
      canManage: true,
    });
    await screen.findByText("研发项目群");
    fireEvent.click(screen.getByRole("button", { name: /删 *除/ }));
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "确认删除" })).at(-1)!,
    );

    await waitFor(() =>
      expect(deleteProjectWecomWebhook).toHaveBeenCalledTimes(1),
    );
    const [projectId, bindingId, init] = deleteProjectWecomWebhook.mock
      .calls[0] as [
      number,
      number,
      { readonly headers: Record<string, string> },
    ];
    expect(projectId).toBe(7);
    expect(bindingId).toBe(19);
    expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
    expect(init.headers["Idempotency-Key"]).toMatch(/^pwg-webhook-delete-/);
    await waitFor(() => expect(screen.queryByText("研发项目群")).toBeNull());
  });

  it("已配置且管理员：通知选项切换后通过服务端接口保存", async () => {
    const { updateProjectWecomGroupNotificationOptions } = mount({
      statuses: [bound],
      canManage: true,
    });
    await screen.findByText("已添加 Webhook 群通知目标");

    fireEvent.click(screen.getByRole("button", { name: "通知选项" }));

    const dialog = await screen.findByRole("dialog", { name: "通知选项" });
    const switchButton = within(dialog).getByRole("switch", {
      name: "项目群推送任务派发",
    });
    expect(switchButton).toBeChecked();
    fireEvent.click(switchButton);

    await waitFor(() =>
      expect(updateProjectWecomGroupNotificationOptions).toHaveBeenCalledTimes(
        1,
      ),
    );
    const [projectId, body, init] = updateProjectWecomGroupNotificationOptions
      .mock.calls[0] as [
      number,
      { readonly disabledCategories: readonly string[] },
      { readonly headers: Record<string, string> },
    ];
    expect(projectId).toBe(7);
    expect(body).toEqual({ disabledCategories: ["task.assign"] });
    expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
    expect(init.headers["Idempotency-Key"]).toMatch(
      /^pwg-notification-options-/,
    );
  });

  it("Webhook 目标展示脱敏信息与最近投递错误，不渲染完整地址", async () => {
    mount({
      statuses: [
        {
          ...bound,
          webhookTargets: [
            {
              ...webhookTarget,
              lastDeliveryError: "Webhook 返回 errcode=45009",
            },
          ],
        },
      ],
      canManage: true,
    });
    await screen.findByText("已添加 Webhook 群通知目标");
    expect(screen.getByText("研发项目群")).toBeInTheDocument();
    expect(screen.getByText("Key 尾号 WXYZ")).toBeInTheDocument();
    expect(screen.getByText(/操作人：开发者 B/)).toBeInTheDocument();
    expect(
      screen.getByText(/最近一次投递失败：Webhook 返回/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/qyapi.weixin.qq.com/)).toBeNull();
    expect(screen.queryByRole("button", { name: "解绑智能机器人" })).toBeNull();
  });
});

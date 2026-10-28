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
  codeExpiresAt: null,
  boundAt: null,
  boundByName: null,
  lastDeliveryError: null,
  botProfileUrl: null,
  webhookTargets: [],
  notificationOptions: { disabledCategories: [] },
};

const bound: ProjectWecomGroupStatus = {
  state: "BOUND",
  codeExpiresAt: null,
  boundAt: "2026-10-15T02:00:00.000Z",
  boundByName: "开发者 A",
  lastDeliveryError: null,
  botProfileUrl:
    "https://work.weixin.qq.com/wework_admin/common/openBotProfile/test-only",
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

const webhookOnlyBound: ProjectWecomGroupStatus = {
  state: "BOUND",
  codeExpiresAt: null,
  boundAt: null,
  boundByName: null,
  lastDeliveryError: null,
  botProfileUrl: null,
  webhookTargets: [webhookTarget],
  notificationOptions: { disabledCategories: [] },
};

const issuedCode = {
  code: "ABCD-EFGH-JKMN-PQRS",
  expiresAt: "2099-01-01T00:00:00.000Z",
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
  const createProjectWecomGroupCode = vi.fn().mockResolvedValue(issuedCode);
  const updateProjectWecomGroupNotificationOptions = vi
    .fn()
    .mockImplementation(async (_projectId: number, body) => body);
  const deleteProjectWecomGroup = vi.fn().mockResolvedValue(undefined);
  const createProjectWecomWebhook = vi.fn().mockResolvedValue(webhookTarget);
  const deleteProjectWecomWebhook = vi.fn().mockResolvedValue(undefined);
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  const client = {
    getProjectWecomGroup,
    createProjectWecomGroupCode,
    updateProjectWecomGroupNotificationOptions,
    deleteProjectWecomGroup,
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
    createProjectWecomGroupCode,
    updateProjectWecomGroupNotificationOptions,
    deleteProjectWecomGroup,
    createProjectWecomWebhook,
    deleteProjectWecomWebhook,
    issueCsrfToken,
  };
}

describe("ProjectWecomGroupCard（ADR-077 / ADR-105）", () => {
  it("未绑定且普通成员：展示引导与只读提示，无生成或 Webhook 写操作", async () => {
    mount({ statuses: [unbound], canManage: false });
    await screen.findByText(/绑定后群聊即可收到项目消息/);
    expect(
      screen.getByText(
        /默认推送任务派发、任务状态、记录、项目成员与删除类动态/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/只有项目组长或系统管理员可以生成绑定码或解绑/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/只有项目组长或系统管理员可以添加或删除 Webhook 目标/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成绑定码" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加 Webhook" })).toBeNull();
    expect(
      screen.getByText(/聊天信息 → 消息推送 → 添加机器人/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/群机器人 → 添加机器人/)).toBeNull();
  });

  it("组长生成绑定码：只签发 CSRF 并展示一次性明文码与倒计时", async () => {
    const { createProjectWecomGroupCode, issueCsrfToken } = mount({
      statuses: [unbound],
      canManage: true,
    });
    await screen.findByText(/绑定后群聊即可收到项目消息/);

    fireEvent.click(screen.getByRole("button", { name: "生成绑定码" }));
    expect(await screen.findByLabelText("项目群绑定码")).toHaveTextContent(
      "ABCD-EFGH-JKMN-PQRS",
    );
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(createProjectWecomGroupCode).toHaveBeenCalledWith(7, {
      headers: { "x-csrf-token": "a".repeat(43) },
    });
    expect(screen.getByText(/剩余有效时间：/)).toBeInTheDocument();
    expect(
      screen.getByText(/先让群里任意成员 @机器人 发一条消息/),
    ).toBeInTheDocument();
  });

  it("智能机器人已绑定：展示绑定信息与异常；解绑只撤销机器人目标", async () => {
    const { deleteProjectWecomGroup } = mount({
      statuses: [
        {
          ...bound,
          lastDeliveryError: "aibot_send_msg 返回 45009：接口调用超过限制",
        },
        unbound,
      ],
      canManage: true,
    });
    await screen.findByText("已绑定企业微信群");
    expect(screen.getByText(/绑定时间：/)).toBeInTheDocument();
    expect(screen.getByText(/操作人：开发者 A/)).toBeInTheDocument();
    expect(screen.getByText(/最近一次群消息投递失败/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "解绑智能机器人" }));
    const confirmButtons = await screen.findAllByRole("button", {
      name: "确认解绑",
    });
    expect(
      document.querySelector(".ant-popover.wecom-unbind-popconfirm"),
    ).not.toBeNull();
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() =>
      expect(deleteProjectWecomGroup).toHaveBeenCalledTimes(1),
    );
    const [projectId, init] = deleteProjectWecomGroup.mock.calls[0] as [
      number,
      { headers: Record<string, string> },
    ];
    expect(projectId).toBe(7);
    expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
    expect(init.headers["Idempotency-Key"]).toMatch(/^pwg-unbind-/);
    expect(
      await screen.findByText("已解绑智能机器人目标。"),
    ).toBeInTheDocument();
  });

  it("普通成员在已绑定状态看不到任何写操作", async () => {
    mount({ statuses: [bound], canManage: false });
    await screen.findByText("已绑定企业微信群");
    expect(screen.queryByRole("button", { name: "解绑智能机器人" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新生成绑定码" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通知选项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加 Webhook" })).toBeNull();
  });

  it("待用码但客户端无明文：展示有效期并允许重新生成", async () => {
    mount({
      statuses: [
        {
          ...unbound,
          state: "PENDING",
          codeExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
      canManage: true,
    });
    await screen.findByText(/已有一个待用绑定码/);
    expect(
      screen.getByRole("button", { name: "重新生成绑定码" }),
    ).toBeInTheDocument();
  });

  it("复制绑定码与机器人链接写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mount({ statuses: [bound], canManage: true });
    await screen.findByText("已绑定企业微信群");

    expect(screen.getByLabelText("机器人链接")).toHaveTextContent(
      "openBotProfile/test-only",
    );
    fireEvent.click(screen.getByRole("button", { name: "复制机器人链接" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "重新生成绑定码" }));
    await screen.findByLabelText("项目群绑定码");
    fireEvent.click(screen.getByRole("button", { name: "复制绑定码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("ABCD-EFGH-JKMN-PQRS");
  });

  it("已绑定且管理员：通知选项切换后通过服务端接口保存", async () => {
    const { updateProjectWecomGroupNotificationOptions } = mount({
      statuses: [bound],
      canManage: true,
    });
    await screen.findByText("已绑定企业微信群");

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

  it("仅 Webhook 绑定：不冒充智能机器人，显示脱敏目标并保留通知选项", async () => {
    mount({ statuses: [webhookOnlyBound], canManage: true });
    await screen.findByText("已添加 Webhook 群通知目标");
    expect(screen.queryByText("已绑定企业微信群")).toBeNull();
    expect(screen.getByText("研发项目群")).toBeInTheDocument();
    expect(screen.getByText("Key 尾号 WXYZ")).toBeInTheDocument();
    expect(screen.getByText(/操作人：开发者 B/)).toBeInTheDocument();
    expect(screen.queryByText(/qyapi.weixin.qq.com/)).toBeNull();
    expect(screen.queryByRole("button", { name: "解绑智能机器人" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "通知选项" }),
    ).toBeInTheDocument();
  });

  it("添加 Webhook：携带 CSRF 与一次性幂等 Key，成功后刷新目标列表", async () => {
    const { createProjectWecomWebhook, issueCsrfToken } = mount({
      statuses: [unbound, webhookOnlyBound],
      canManage: true,
    });
    await screen.findByText(/绑定后群聊即可收到项目消息/);
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

  it("普通成员可查看 Webhook 列表但不能添加或删除", async () => {
    mount({ statuses: [webhookOnlyBound], canManage: false });
    await screen.findByText("研发项目群");
    expect(screen.queryByRole("button", { name: "添加 Webhook" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("删除 Webhook 逐项调用服务端并携带幂等 Key", async () => {
    const { deleteProjectWecomWebhook } = mount({
      statuses: [webhookOnlyBound, unbound],
      canManage: true,
    });
    await screen.findByText("研发项目群");
    fireEvent.click(screen.getByRole("button", { name: /删\s*除/ }));
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

  it("智能机器人与 Webhook 并存时提示同群重复投递风险", async () => {
    mount({
      statuses: [
        {
          ...bound,
          webhookTargets: [webhookTarget],
        },
      ],
      canManage: true,
    });
    await screen.findByText("已绑定企业微信群");
    expect(
      screen.getByText(/如果两种通道指向同一个企业微信群/),
    ).toBeInTheDocument();
  });
});

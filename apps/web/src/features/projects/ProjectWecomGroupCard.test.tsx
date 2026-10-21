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
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  const client = {
    getProjectWecomGroup,
    createProjectWecomGroupCode,
    updateProjectWecomGroupNotificationOptions,
    deleteProjectWecomGroup,
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
    issueCsrfToken,
  };
}

describe("ProjectWecomGroupCard（ADR-077）", () => {
  it("未绑定且普通成员：展示引导与只读提示，无生成按钮", async () => {
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
    expect(screen.queryByRole("button", { name: "生成绑定码" })).toBeNull();
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

  it("已绑定展示绑定时间与操作人、投递异常提示；解绑先签发 CSRF 再带一次性幂等 Key", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "解绑企业微信群" }));
    const confirmButtons = await screen.findAllByRole("button", {
      name: "确认解绑",
    });
    // 气泡挂载类名是布局修复的挂点：antd-adapter.css 会把所有 .ant-popover 容器压成
    // 1×1 透明盒，只有带上这个类才有把它还原成正常卡片的高特异性规则。
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
    expect(await screen.findByText("已解除绑定。")).toBeInTheDocument();
  });

  it("普通成员在已绑定状态看不到解绑按钮", async () => {
    mount({ statuses: [bound], canManage: false });
    await screen.findByText("已绑定企业微信群");
    expect(screen.queryByRole("button", { name: "解绑企业微信群" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新生成绑定码" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通知选项" })).toBeNull();
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
});

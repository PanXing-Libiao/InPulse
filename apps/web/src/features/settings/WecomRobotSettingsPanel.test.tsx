import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type InpulseApiClient,
  type WecomRobotConfig,
} from "@generated/api";
import { WecomRobotSettingsPanel } from "./WecomRobotSettingsPanel";

const testSecret = "test-secret-value-1234";

const unconfigured: WecomRobotConfig = {
  configured: false,
  ready: false,
  disabledReason: "NOT_CONFIGURED",
  botId: null,
  secretHint: null,
  secretKeyVersion: null,
  rowVersion: null,
  botProfileUrl: null,
  updatedAt: null,
  updatedByName: null,
  revokedUserBindings: null,
  revokedProjectGroups: null,
};

const configured: WecomRobotConfig = {
  configured: true,
  ready: true,
  disabledReason: null,
  botId: "aibde5jXbgE_0Gz4O3ozl32C0H4BLhWZAzH",
  secretHint: "yH0l",
  secretKeyVersion: 1,
  rowVersion: 3,
  botProfileUrl:
    "https://work.weixin.qq.com/wework_admin/common/openBotProfile/test-only",
  updatedAt: "2026-10-13T06:00:00.000Z",
  updatedByName: "邵晨宇",
  revokedUserBindings: null,
  revokedProjectGroups: null,
};

function mount(options: {
  readonly configs: readonly WecomRobotConfig[];
  readonly configError?: ApiError | undefined;
  readonly updateResult?: WecomRobotConfig | undefined;
}) {
  let call = 0;
  const getWecomRobotConfig = vi.fn().mockImplementation(async () => {
    if (options.configError !== undefined) throw options.configError;
    const config = options.configs[Math.min(call, options.configs.length - 1)];
    call += 1;
    return config;
  });
  const updateWecomRobotConfig = vi
    .fn()
    .mockResolvedValue(options.updateResult ?? configured);
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  const client = {
    getWecomRobotConfig,
    updateWecomRobotConfig,
    issueCsrfToken,
  } as unknown as InpulseApiClient;
  render(
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      theme={{ token: { motion: false } }}
    >
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <WecomRobotSettingsPanel client={client} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return { getWecomRobotConfig, updateWecomRobotConfig, issueCsrfToken };
}

describe("WecomRobotSettingsPanel（ADR-070）", () => {
  it("未配置时提示尚未配置；缺 Secret 提交被本地校验拦截", async () => {
    const { updateWecomRobotConfig } = mount({ configs: [unconfigured] });
    await screen.findByText(/尚未配置机器人/);

    fireEvent.change(screen.getByLabelText("机器人 botId"), {
      target: { value: "aib-new-bot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(
      await screen.findByText("首次配置必须提供机器人 Secret"),
    ).toBeInTheDocument();
    expect(updateWecomRobotConfig).not.toHaveBeenCalled();
  });

  it("首次保存先签发 CSRF 再携带一次性幂等 Key 提交 botId 与 Secret", async () => {
    const { updateWecomRobotConfig, issueCsrfToken, getWecomRobotConfig } =
      mount({ configs: [unconfigured, configured] });
    await screen.findByText(/尚未配置机器人/);

    fireEvent.change(screen.getByLabelText("机器人 botId"), {
      target: { value: "aib-new-bot" },
    });
    fireEvent.change(screen.getByLabelText("机器人 Secret"), {
      target: { value: testSecret },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(updateWecomRobotConfig).toHaveBeenCalledTimes(1),
    );
    const [body, init] = updateWecomRobotConfig.mock.calls[0] as [
      { readonly botId: string; readonly secret: string | null },
      { readonly headers: Readonly<Record<string, string>> },
    ];
    expect(body).toEqual({
      botId: "aib-new-bot",
      secret: testSecret,
      botProfileUrl: null,
    });
    expect(init.headers["x-csrf-token"]).toBe("a".repeat(43));
    expect(init.headers["Idempotency-Key"]).toMatch(/^wecom-robot-/);
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/配置已保存/)).toBeInTheDocument();
    expect(getWecomRobotConfig).toHaveBeenCalledTimes(2);
  });

  it("已配置时回填 botId 与尾号；Secret 留空提交为 null（保持原密钥）", async () => {
    const { updateWecomRobotConfig } = mount({ configs: [configured] });
    await screen.findByText(/已配置，桥接可用/);
    expect(
      screen.getByText(/aibde5jXbgE_0Gz4O3ozl32C0H4BLhWZAzH/),
    ).toBeInTheDocument();
    expect(screen.getByText(/yH0l/)).toBeInTheDocument();
    expect(
      (screen.getByLabelText("机器人 botId") as HTMLInputElement).value,
    ).toBe("aibde5jXbgE_0Gz4O3ozl32C0H4BLhWZAzH");

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(updateWecomRobotConfig).toHaveBeenCalledTimes(1),
    );
    const [body] = updateWecomRobotConfig.mock.calls[0] as [
      { readonly botId: string; readonly secret: string | null },
    ];
    expect(body).toEqual({
      botId: "aibde5jXbgE_0Gz4O3ozl32C0H4BLhWZAzH",
      secret: null,
      botProfileUrl:
        "https://work.weixin.qq.com/wework_admin/common/openBotProfile/test-only",
    });
  });

  it("机器人链接回显；清空后提交 null", async () => {
    const { updateWecomRobotConfig } = mount({ configs: [configured] });
    await screen.findByText(/已配置，桥接可用/);
    expect(
      (screen.getByLabelText("机器人链接（可选）") as HTMLInputElement).value,
    ).toBe(
      "https://work.weixin.qq.com/wework_admin/common/openBotProfile/test-only",
    );

    fireEvent.change(screen.getByLabelText("机器人链接（可选）"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(updateWecomRobotConfig).toHaveBeenCalledTimes(1),
    );
    const [body] = updateWecomRobotConfig.mock.calls[0] as [
      { readonly botProfileUrl: string | null },
    ];
    expect(body.botProfileUrl).toBeNull();
  });

  it("机器人链接非 https 时本地校验拦截提交", async () => {
    const { updateWecomRobotConfig } = mount({ configs: [configured] });
    await screen.findByText(/已配置，桥接可用/);

    fireEvent.change(screen.getByLabelText("机器人链接（可选）"), {
      target: { value: "http://work.weixin.qq.com/openBotProfile/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(
      await screen.findByText("机器人链接必须是 https 开头的合法网址"),
    ).toBeInTheDocument();
    expect(updateWecomRobotConfig).not.toHaveBeenCalled();
  });

  it("主密钥不可用时展示 fail-closed 状态文案", async () => {
    mount({
      configs: [
        {
          ...configured,
          ready: false,
          disabledReason: "ENCRYPTION_KEY_UNAVAILABLE",
        },
      ],
    });
    expect(
      await screen.findByText(/服务器缺少密钥加密主密钥，Secret 不可读取/),
    ).toBeInTheDocument();
  });

  it("读取失败展示错误与重试按钮", async () => {
    mount({ configs: [], configError: new ApiError(500, {}) });
    expect(await screen.findByText(/无法读取配置/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("更换机器人后展示解绑计数提示（ADR-078）", async () => {
    const { updateWecomRobotConfig } = mount({
      configs: [configured],
      updateResult: {
        ...configured,
        botId: "aib-new-bot",
        revokedUserBindings: 2,
        revokedProjectGroups: 0,
      },
    });
    await screen.findByText(/已配置，桥接可用/);

    fireEvent.change(screen.getByLabelText("机器人 botId"), {
      target: { value: "aib-new-bot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(updateWecomRobotConfig).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByText(
        /已更换机器人：解除了 2 个成员企业微信绑定；项目群 Webhook 不受影响/,
      ),
    ).toBeInTheDocument();
  });
});

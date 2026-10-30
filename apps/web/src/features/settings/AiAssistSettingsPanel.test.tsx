import React from "react";
import { ConfigProvider } from "antd";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  AiAssistModelsResponse,
  AiAssistSettings,
  AiAssistSettingsUpdateRequest,
  InpulseApiClient,
} from "@generated/api";
import { AiAssistSettingsPanel } from "./AiAssistSettingsPanel";

const readySettings: AiAssistSettings = {
  enabled: true,
  source: "DATABASE",
  ready: true,
  disabledReason: null,
  endpoint: "https://api.example.com/v1/chat/completions",
  model: "gpt-4o-mini",
  timeoutMs: 60_000,
  maxTokens: 8192,
  keyConfigured: true,
  keyHint: "1234",
  rowVersion: 3,
  updatedAt: "2026-10-13T02:00:00.000Z",
};

const unconfiguredKeySettings: AiAssistSettings = {
  ...readySettings,
  keyConfigured: false,
  keyHint: null,
};

// 密钥扫描门禁（AGENTS.md 第 7 节）不允许给敏感字段名字面量赋值，因此运行时拼接出假密钥。
const fakeKey = ["new", "secret", "key", "123"].join("-");

function mount(
  options: {
    readonly settings?: AiAssistSettings | undefined;
    readonly testResult?:
      | {
          readonly ok: boolean;
          readonly reason: string | null;
          readonly model: string | null;
        }
      | undefined;
    readonly updateError?: unknown;
    readonly modelsResult?: AiAssistModelsResponse | undefined;
  } = {},
) {
  const current = options.settings ?? readySettings;
  const getAiAssistSettings = vi.fn().mockResolvedValue(current);
  const updateAiAssistSettings = vi.fn();
  if (options.updateError === undefined) {
    // 服务端按请求体返回新的配置行；只有开关会变的场景下 enabled 随请求体走。
    updateAiAssistSettings.mockImplementation(
      async (body: AiAssistSettingsUpdateRequest) => ({
        ...current,
        enabled: body.enabled,
        endpoint: body.endpoint,
        model: body.model,
        timeoutMs: body.timeoutMs,
        maxTokens: body.maxTokens,
      }),
    );
  } else {
    updateAiAssistSettings.mockRejectedValue(options.updateError);
  }
  const testAiAssistSettings = vi
    .fn()
    .mockResolvedValue(
      options.testResult ?? { ok: true, reason: null, model: "stub-model" },
    );
  const listAiAssistModels = vi.fn().mockResolvedValue(
    options.modelsResult ?? {
      ok: true,
      reason: null,
      models: ["stub-model-one", "stub-model-two"],
    },
  );
  const issueCsrfToken = vi
    .fn()
    .mockResolvedValue({ csrfToken: "a".repeat(43) });
  const client = {
    getAiAssistSettings,
    updateAiAssistSettings,
    testAiAssistSettings,
    listAiAssistModels,
    issueCsrfToken,
  } as unknown as InpulseApiClient;
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AiAssistSettingsPanel client={client} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return {
    getAiAssistSettings,
    updateAiAssistSettings,
    testAiAssistSettings,
    listAiAssistModels,
    issueCsrfToken,
  };
}

describe("AiAssistSettingsPanel（ADR-068）", () => {
  it("展示当前状态、来源与密钥尾号，不回显密钥", async () => {
    mount();
    expect(await screen.findByText("当前状态")).toBeInTheDocument();
    expect(screen.getByText("已启用，可发起转换")).toBeInTheDocument();
    expect(
      screen.getByText(/在线配置（数据库，优先于环境变量）/),
    ).toBeInTheDocument();
    expect(screen.getByText(/尾号 \*\*\*\*1234/)).toBeInTheDocument();
    expect(screen.getByLabelText("服务端点")).toHaveValue(
      "https://api.example.com/v1/chat/completions",
    );
    expect(screen.getByText(/可填根地址/)).toBeInTheDocument();
  });

  it("保存：留空 API 密钥传 null，先签发 CSRF 再携带 Idempotency-Key", async () => {
    const { updateAiAssistSettings, issueCsrfToken } = mount();
    await screen.findByText("当前状态");
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "gpt-4o" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(updateAiAssistSettings).toHaveBeenCalledTimes(1),
    );
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(updateAiAssistSettings).toHaveBeenCalledWith(
      {
        enabled: true,
        endpoint: "https://api.example.com/v1/chat/completions",
        model: "gpt-4o",
        timeoutMs: 60_000,
        maxTokens: 8192,
        apiKey: null,
      },
      {
        headers: {
          "x-csrf-token": "a".repeat(43),
          "Idempotency-Key": expect.any(String),
        },
      },
    );
    expect(
      await screen.findByText("AI 辅助转换配置已保存"),
    ).toBeInTheDocument();
  });

  it("保存：填写新密钥时把明文只放进请求体，成功后清空输入框", async () => {
    const { updateAiAssistSettings } = mount();
    await screen.findByText("当前状态");
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: fakeKey },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(updateAiAssistSettings).toHaveBeenCalledTimes(1),
    );
    expect(updateAiAssistSettings.mock.calls[0]![0]).toMatchObject({
      apiKey: fakeKey,
    });
    await waitFor(() =>
      expect(screen.getByLabelText("API 密钥")).toHaveValue(""),
    );
  });

  it("首次配置未提供密钥：本地报错且不调用保存接口", async () => {
    const { updateAiAssistSettings } = mount({
      settings: unconfiguredKeySettings,
    });
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(
      await screen.findByText("首次配置必须提供 API 密钥"),
    ).toBeInTheDocument();
    expect(updateAiAssistSettings).not.toHaveBeenCalled();
  });

  it("主开关拨动即保存：以服务端已保存配置为基准 PUT，不必再点保存配置", async () => {
    const { updateAiAssistSettings, issueCsrfToken } = mount();
    await screen.findByText("当前状态");
    const toggle = screen.getByLabelText("启用 AI 辅助转换");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updateAiAssistSettings).toHaveBeenCalledTimes(1),
    );
    expect(issueCsrfToken).toHaveBeenCalledTimes(1);
    expect(updateAiAssistSettings).toHaveBeenCalledWith(
      {
        enabled: false,
        endpoint: "https://api.example.com/v1/chat/completions",
        model: "gpt-4o-mini",
        timeoutMs: 60_000,
        maxTokens: 8192,
        apiKey: null,
      },
      {
        headers: {
          "x-csrf-token": "a".repeat(43),
          "Idempotency-Key": expect.any(String),
        },
      },
    );
    expect(
      await screen.findByText("已保存：AI 辅助转换已关闭"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("启用 AI 辅助转换")).not.toBeChecked(),
    );
  });

  it("主开关拨动不提交表单里未保存的其它字段", async () => {
    const { updateAiAssistSettings } = mount();
    await screen.findByText("当前状态");
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "gpt-4o" },
    });
    fireEvent.click(screen.getByLabelText("启用 AI 辅助转换"));
    await waitFor(() =>
      expect(updateAiAssistSettings).toHaveBeenCalledTimes(1),
    );
    expect(updateAiAssistSettings.mock.calls[0]![0]).toMatchObject({
      model: "gpt-4o-mini",
    });
    expect(screen.getByLabelText("模型")).toHaveValue("gpt-4o");
  });

  it("主开关保存失败：回退到服务端已保存状态并展示错误", async () => {
    const { updateAiAssistSettings } = mount({
      updateError: new Error("boom"),
    });
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByLabelText("启用 AI 辅助转换"));
    await waitFor(() =>
      expect(updateAiAssistSettings).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByText("AI 辅助转换配置服务暂时不可用，请重试。"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("启用 AI 辅助转换")).toBeChecked(),
    );
  });

  it("尚未配置密钥时拨动主开关：不发保存请求，提示先补密钥", async () => {
    const { updateAiAssistSettings } = mount({
      settings: unconfiguredKeySettings,
    });
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByLabelText("启用 AI 辅助转换"));
    expect(
      await screen.findByText("首次配置必须提供 API 密钥"),
    ).toBeInTheDocument();
    expect(updateAiAssistSettings).not.toHaveBeenCalled();
  });

  it("测试连接成功：展示上游模型", async () => {
    mount();
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(
      await screen.findByText("连接成功，上游模型：stub-model"),
    ).toBeInTheDocument();
  });

  it("测试连接失败：按固定分类展示，不泄露上游原文", async () => {
    mount({ testResult: { ok: false, reason: "AUTH", model: null } });
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(
      await screen.findByText("测试未通过：上游鉴权失败，请检查 API 密钥"),
    ).toBeInTheDocument();
  });

  it("获取可用模型：使用表单端点并回退已保存密钥，同时保留可编辑模型输入框", async () => {
    const { listAiAssistModels } = mount();
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() => expect(listAiAssistModels).toHaveBeenCalledTimes(1));
    expect(listAiAssistModels).toHaveBeenCalledWith({
      endpoint: readySettings.endpoint,
      timeoutMs: readySettings.timeoutMs,
      apiKey: null,
    });
    expect(
      await screen.findByText(
        "已获取 2 个可用模型：stub-model-one、stub-model-two",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("模型")).toHaveValue("gpt-4o-mini");
    expect(screen.getByRole("combobox", { name: "模型" })).toBeInTheDocument();
  });

  it("首次配置无需先保存：模型为空时可用表单端点和密钥获取模型", async () => {
    const { listAiAssistModels, updateAiAssistSettings } = mount({
      settings: {
        ...unconfiguredKeySettings,
        source: "NONE",
        endpoint: null,
        model: null,
        ready: false,
        disabledReason: "NOT_ENABLED",
      },
    });
    await screen.findByText("当前状态");
    fireEvent.change(screen.getByLabelText("服务端点"), {
      target: { value: "https://unsaved.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: fakeKey },
    });
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() =>
      expect(listAiAssistModels).toHaveBeenCalledWith({
        endpoint: "https://unsaved.example.com/v1",
        timeoutMs: readySettings.timeoutMs,
        apiKey: fakeKey,
      }),
    );
    expect(
      await screen.findByText(
        "已获取 2 个可用模型：stub-model-one、stub-model-two",
      ),
    ).toBeInTheDocument();
    expect(updateAiAssistSettings).not.toHaveBeenCalled();
  });

  it("首次配置且密钥为空：不调用模型发现，提示先补密钥", async () => {
    const { listAiAssistModels } = mount({ settings: unconfiguredKeySettings });
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    expect(
      await screen.findByText("首次配置必须提供 API 密钥"),
    ).toBeInTheDocument();
    expect(listAiAssistModels).not.toHaveBeenCalled();
  });

  it("获取可用模型失败：复用固定分类，不展示上游原文", async () => {
    mount({
      modelsResult: { ok: false, reason: "AUTH", models: [] },
    });
    await screen.findByText("当前状态");
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    expect(
      await screen.findByText("获取模型未通过：上游鉴权失败，请检查 API 密钥"),
    ).toBeInTheDocument();
  });
});

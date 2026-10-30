import React, { useEffect, useRef, useState } from "react";
import { formatBeijingMinute } from "@features/common/beijing-time";
import { AutoComplete, Button, Input, InputNumber, Switch } from "antd";
import { Controller, useForm } from "react-hook-form";
import type {
  AiAssistModelsResponse,
  AiAssistSettings,
  InpulseApiClient,
} from "@generated/api";
import { CalmBadge, CalmSectionTitle } from "@features/common/components/Calm";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import {
  aiAssistDisabledReasonText,
  aiAssistModelsErrorMessage,
  aiAssistSettingsErrorMessage,
  aiAssistTestFailureText,
  useAiAssistSettings,
} from "./ai-assist-query";

export interface AiAssistSettingsPanelProps {
  readonly client?: InpulseApiClient | undefined;
}

interface FormValues {
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly apiKey: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 8192;

function discoveredModelsText(result: AiAssistModelsResponse): string {
  if (!result.ok) {
    return "获取模型未通过：" + aiAssistTestFailureText(result.reason ?? "");
  }
  if (result.models.length === 0) {
    return "获取成功，但上游没有返回可用模型。";
  }
  const names = result.models.slice(0, 20).join("、");
  const suffix =
    result.models.length > 20 ? ` 等 ${result.models.length} 个` : "";
  return `已获取 ${result.models.length} 个可用模型：${names}${suffix}`;
}

function sourceText(source: AiAssistSettings["source"]): string {
  if (source === "DATABASE") return "在线配置（数据库，优先于环境变量）";
  if (source === "ENVIRONMENT")
    return "环境变量（遗留模式；保存一次后即转为在线配置）";
  return "尚未配置";
}

function editableValues(settings: AiAssistSettings): FormValues {
  return {
    endpoint: settings.endpoint ?? "",
    model: settings.model ?? "",
    timeoutMs: settings.timeoutMs,
    maxTokens: settings.maxTokens,
    apiKey: "",
  };
}

/**
 * ADR-068 「成员与设置 → AI 辅助转换」面板：状态卡 + 表单 +
 * 测试连接 + 上游可用模型发现。
 * 密钥永不回显；留空表示保持已保存的密钥。权限判断全部在服务端完成。
 */
export const AiAssistSettingsPanel: React.FC<AiAssistSettingsPanelProps> = ({
  client,
}) => {
  const { query, save, test, discoverModels } = useAiAssistSettings(client);
  const [success, setSuccess] = useState<string | null>(null);
  // 主开关的即时草稿：null 表示跟随服务端已保存状态。
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const {
    clearErrors,
    control,
    getValues,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      endpoint: "",
      model: "",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      apiKey: "",
    },
  });

  const settings = query.data;
  const savedSignature =
    settings === undefined ? "" : JSON.stringify(editableValues(settings));
  const appliedSignature = useRef<string | null>(null);
  useEffect(() => {
    // 只在已保存的端点 / 模型 / 超时 / tokens 变化时回填，避免开关即时保存冲掉正在编辑的字段。
    if (settings === undefined || appliedSignature.current === savedSignature)
      return;
    appliedSignature.current = savedSignature;
    reset(editableValues(settings));
  }, [settings, savedSignature, reset]);

  const submit = handleSubmit(async (values) => {
    if (settings === undefined) return;
    setSuccess(null);
    save.reset();
    const apiKey = values.apiKey.trim();
    if (!settings.keyConfigured && apiKey.length === 0) {
      setError("apiKey", { message: "首次配置必须提供 API 密钥" });
      return;
    }
    try {
      await save.mutateAsync({
        enabled: enabledDraft ?? settings.enabled,
        endpoint: values.endpoint.trim(),
        model: values.model.trim(),
        timeoutMs: values.timeoutMs,
        maxTokens: values.maxTokens,
        apiKey: apiKey.length === 0 ? null : apiKey,
      });
      setValue("apiKey", "");
      setEnabledDraft(null);
      setSuccess("AI 辅助转换配置已保存");
    } catch {
      // 失败详情由 save 状态统一渲染。
    }
  });

  // 开关立即生效：PUT 是整体替换语义，因此带上服务端已保存的其它字段，apiKey 传 null 表示不改密钥。
  const toggleEnabled = async (next: boolean) => {
    if (settings === undefined || save.isPending) return;
    setSuccess(null);
    save.reset();
    setEnabledDraft(next);
    if (!settings.keyConfigured) {
      setError("apiKey", { message: "首次配置必须提供 API 密钥" });
      return;
    }
    try {
      await save.mutateAsync({
        enabled: next,
        endpoint: settings.endpoint ?? "",
        model: settings.model ?? "",
        timeoutMs: settings.timeoutMs,
        maxTokens: settings.maxTokens,
        apiKey: null,
      });
      setSuccess(
        next ? "已保存：AI 辅助转换已启用" : "已保存：AI 辅助转换已关闭",
      );
    } catch {
      // 失败详情由 save 状态渲染，开关回落到服务端已保存状态。
    } finally {
      setEnabledDraft(null);
    }
  };

  const discover = () => {
    if (settings === undefined) return;
    const values = getValues();
    const endpoint = values.endpoint.trim();
    const apiKey = values.apiKey.trim();
    discoverModels.reset();
    clearErrors(["endpoint", "apiKey"]);
    if (endpoint.length === 0) {
      setError("endpoint", { message: "请填写 AI 服务端点" });
      return;
    }
    if (!settings.keyConfigured && apiKey.length === 0) {
      setError("apiKey", { message: "首次配置必须提供 API 密钥" });
      return;
    }
    void discoverModels
      .mutateAsync({
        endpoint,
        timeoutMs: values.timeoutMs,
        apiKey: apiKey.length === 0 ? null : apiKey,
      })
      .catch(() => undefined);
  };

  if (query.isPending) {
    return (
      <section className="panel settings-panel" aria-label="AI 辅助转换">
        <CalmSectionTitle title="AI 辅助转换" />
        <div className="ai-assist-body">
          <CalmSkeleton
            variant="list"
            rows={4}
            compact
            label="正在加载 AI 辅助转换配置"
          />
        </div>
      </section>
    );
  }

  if (query.isError || settings === undefined) {
    return (
      <section className="panel settings-panel" aria-label="AI 辅助转换">
        <CalmSectionTitle title="AI 辅助转换" />
        <div className="ai-assist-body">
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={17} />
            <span>
              <strong>无法读取配置</strong>
              {aiAssistSettingsErrorMessage(query.error)}
            </span>
          </div>
          <div className="ai-assist-actions">
            <Button size="small" onClick={() => void query.refetch()}>
              重试
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const enabled = enabledDraft ?? settings.enabled;
  const statusTone = settings.ready
    ? "green"
    : settings.disabledReason === "ENCRYPTION_KEY_UNAVAILABLE" ||
        settings.disabledReason === "CONFIG_INVALID"
      ? "red"
      : "amber";

  return (
    <section className="panel settings-panel" aria-label="AI 辅助转换">
      <CalmSectionTitle title="AI 辅助转换">
        <span className="ai-assist-master">
          <Switch
            aria-label="启用 AI 辅助转换"
            checked={enabled}
            loading={save.isPending}
            onChange={(value) => void toggleEnabled(value)}
          />
        </span>
      </CalmSectionTitle>

      <div className="ai-assist-body">
        <div
          className={
            "permission-note ai-assist-status" +
            (settings.ready ? " note-success" : "")
          }
        >
          <InpulseIcon name="zap" size={17} />
          <div className="ai-assist-status-body">
            <span className="ai-assist-status-head">
              <strong>当前状态</strong>
              <CalmBadge tone={statusTone}>
                {settings.ready
                  ? "已启用，可发起转换"
                  : aiAssistDisabledReasonText(settings.disabledReason)}
              </CalmBadge>
            </span>
            <span className="ai-assist-status-meta">
              <span>来源：{sourceText(settings.source)}</span>
              <span>
                {settings.keyConfigured
                  ? "密钥已配置（尾号 ****" + (settings.keyHint ?? "") + "）"
                  : "尚未配置密钥"}
              </span>
              {settings.updatedAt === null ? null : (
                <span>
                  {"最近保存 "}
                  {formatBeijingMinute(settings.updatedAt)}
                </span>
              )}
            </span>
          </div>
        </div>

        {success ? (
          <div className="permission-note note-success" role="status">
            <InpulseIcon name="check" size={16} />
            <span>{success}</span>
          </div>
        ) : null}
        {save.isError ? (
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={16} />
            <span>{aiAssistSettingsErrorMessage(save.error)}</span>
          </div>
        ) : null}

        <form
          className="ai-assist-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="ai-assist-field">
            <label htmlFor="ai-assist-endpoint">服务端点</label>
            <Controller
              name="endpoint"
              control={control}
              rules={{ required: "请填写 AI 服务端点" }}
              render={({ field }) => (
                <Input
                  id="ai-assist-endpoint"
                  {...field}
                  placeholder="https://api.example.com/v1"
                />
              )}
            />
            {errors.endpoint ? (
              <small role="alert">{errors.endpoint.message}</small>
            ) : (
              <small className="form-hint">
                可填根地址（例如 https://xxx/v1），保存或测试连接时自动补全
                /chat/completions；也可直接填写完整地址。
              </small>
            )}
          </div>

          <div className="ai-assist-field">
            <label htmlFor="ai-assist-model">模型</label>
            <Controller
              name="model"
              control={control}
              rules={{ required: "请填写模型名称" }}
              render={({ field }) => (
                <AutoComplete
                  id="ai-assist-model"
                  value={field.value}
                  onChange={(value) => field.onChange(value)}
                  options={
                    discoverModels.data?.ok
                      ? discoverModels.data.models.map((model) => ({
                          value: model,
                        }))
                      : []
                  }
                  filterOption={(inputValue, option) =>
                    String(option?.value ?? "")
                      .toLowerCase()
                      .includes(inputValue.toLowerCase())
                  }
                  placeholder="gpt-4o-mini"
                />
              )}
            />
            {errors.model ? (
              <small role="alert">{errors.model.message}</small>
            ) : (
              <small className="form-hint">
                可直接输入；「获取可用模型」使用当前填写的端点、超时与密钥，密钥留空时使用已保存密钥。
              </small>
            )}
          </div>

          <div className="ai-assist-field-pair">
            <div className="ai-assist-field">
              <label htmlFor="ai-assist-timeout">超时（毫秒）</label>
              <Controller
                name="timeoutMs"
                control={control}
                render={({ field }) => (
                  <InputNumber
                    id="ai-assist-timeout"
                    min={1000}
                    max={600000}
                    step={1000}
                    value={field.value}
                    onChange={(value) =>
                      field.onChange(value ?? DEFAULT_TIMEOUT_MS)
                    }
                  />
                )}
              />
            </div>
            <div className="ai-assist-field">
              <label htmlFor="ai-assist-max-tokens">最大输出 tokens</label>
              <Controller
                name="maxTokens"
                control={control}
                render={({ field }) => (
                  <InputNumber
                    id="ai-assist-max-tokens"
                    min={1}
                    max={200000}
                    value={field.value}
                    onChange={(value) =>
                      field.onChange(value ?? DEFAULT_MAX_TOKENS)
                    }
                  />
                )}
              />
            </div>
          </div>

          <div className="ai-assist-field">
            <label htmlFor="ai-assist-api-key">API 密钥</label>
            <Controller
              name="apiKey"
              control={control}
              render={({ field }) => (
                <Input.Password
                  id="ai-assist-api-key"
                  {...field}
                  autoComplete="new-password"
                  placeholder="留空表示保持已保存的密钥（不回显）"
                />
              )}
            />
            {errors.apiKey ? (
              <small role="alert">{errors.apiKey.message}</small>
            ) : null}
          </div>

          <div className="ai-assist-actions">
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              保存配置
            </Button>
            <Button onClick={discover} loading={discoverModels.isPending}>
              获取可用模型
            </Button>
            <Button
              onClick={() => {
                test.reset();
                void test.mutateAsync().catch(() => undefined);
              }}
              loading={test.isPending}
            >
              测试连接
            </Button>
          </div>
        </form>

        {discoverModels.isSuccess ? (
          <div
            className={
              discoverModels.data.ok
                ? "permission-note note-success"
                : "permission-note"
            }
            role="status"
          >
            <InpulseIcon
              name={discoverModels.data.ok ? "check" : "alert"}
              size={16}
            />
            <span>{discoveredModelsText(discoverModels.data)}</span>
          </div>
        ) : null}
        {discoverModels.isError ? (
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={16} />
            <span>{aiAssistModelsErrorMessage(discoverModels.error)}</span>
          </div>
        ) : null}
        {test.isSuccess ? (
          <div
            className={
              test.data.ok ? "permission-note note-success" : "permission-note"
            }
            role="status"
          >
            <InpulseIcon name={test.data.ok ? "check" : "alert"} size={16} />
            <span>
              {test.data.ok
                ? "连接成功，上游模型：" + (test.data.model ?? "")
                : "测试未通过：" +
                  aiAssistTestFailureText(test.data.reason ?? "")}
            </span>
          </div>
        ) : null}
        {test.isError ? (
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={16} />
            <span>{aiAssistSettingsErrorMessage(test.error)}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

export default AiAssistSettingsPanel;

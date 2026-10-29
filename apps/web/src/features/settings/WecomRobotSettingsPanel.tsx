import React, { useEffect, useState } from "react";
import { formatBeijingMinute } from "@features/common/beijing-time";
import { Button, Input } from "antd";
import { Controller, useForm } from "react-hook-form";
import type { InpulseApiClient } from "@generated/api";
import { CalmBadge, CalmSectionTitle } from "@features/common/components/Calm";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import {
  useWecomRobotConfig,
  wecomRobotDisabledReasonText,
  wecomRobotErrorMessage,
} from "./wecom-robot-query";

export interface WecomRobotSettingsPanelProps {
  readonly client?: InpulseApiClient | undefined;
}

interface FormValues {
  readonly botId: string;
  readonly secret: string;
  readonly botProfileUrl: string;
}

/**
 * ADR-070 「成员与设置 → 企业微信机器人」面板：状态卡 + 配置表单。
 * Secret 永不回显；留空表示保持已保存的密钥。权限判断全部在服务端完成。
 */
export const WecomRobotSettingsPanel: React.FC<
  WecomRobotSettingsPanelProps
> = ({ client }) => {
  const { query, save } = useWecomRobotConfig(client);
  const [success, setSuccess] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { botId: "", secret: "", botProfileUrl: "" },
  });

  const config = query.data;
  useEffect(() => {
    if (config === undefined) return;
    reset({
      botId: config.botId ?? "",
      secret: "",
      botProfileUrl: config.botProfileUrl ?? "",
    });
  }, [config, reset]);

  const submit = handleSubmit(async (values) => {
    setSuccess(null);
    save.reset();
    const secret = values.secret.trim();
    if (!(config?.configured ?? false) && secret.length === 0) {
      setError("secret", { message: "首次配置必须提供机器人 Secret" });
      return;
    }
    try {
      const botProfileUrl = values.botProfileUrl.trim();
      const result = await save.mutateAsync({
        botId: values.botId.trim(),
        secret: secret.length === 0 ? null : secret,
        botProfileUrl: botProfileUrl.length === 0 ? null : botProfileUrl,
      });
      setValue("secret", "");
      if (
        result.revokedUserBindings !== null ||
        result.revokedProjectGroups !== null
      ) {
        setSuccess(
          "已更换机器人：解除了 " +
            (result.revokedUserBindings ?? 0) +
            " 个成员企业微信绑定；项目群 Webhook 不受影响，相关成员需要重新绑定（新机器人需要先在企业微信里对话一次激活）。",
        );
      } else {
        setSuccess(
          "企业微信机器人配置已保存；桥接进程会在下一次轮询时自动重连新机器人。",
        );
      }
    } catch {
      // 失败详情由 save 状态统一渲染。
    }
  });

  const title = (
    <CalmSectionTitle
      title="企业微信机器人"
      hint="任务指派等站内通知通过它推送到成员的企业微信"
    />
  );

  if (query.isPending) {
    return (
      <section className="panel settings-panel" aria-label="企业微信机器人">
        {title}
        <div className="wecom-robot-body">
          <CalmSkeleton
            variant="list"
            rows={4}
            compact
            label="正在加载企业微信机器人配置"
          />
        </div>
      </section>
    );
  }

  if (query.isError || config === undefined) {
    return (
      <section className="panel settings-panel" aria-label="企业微信机器人">
        {title}
        <div className="wecom-robot-body">
          <div className="permission-note" role="alert">
            <InpulseIcon name="alert" size={17} />
            <span>
              <strong>无法读取配置</strong>
              {wecomRobotErrorMessage(query.error)}
            </span>
          </div>
          <div className="wecom-robot-actions">
            <Button size="small" onClick={() => void query.refetch()}>
              重试
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const statusTone = config.ready
    ? "green"
    : config.disabledReason === "NOT_CONFIGURED"
      ? "amber"
      : "red";

  return (
    <section className="panel settings-panel" aria-label="企业微信机器人">
      {title}
      <div className="wecom-robot-body">
        <div className="permission-note">
          <InpulseIcon name="settings" size={17} />
          <span>
            <strong>当前状态</strong>
            <CalmBadge tone={statusTone}>
              {wecomRobotDisabledReasonText(config.disabledReason)}
            </CalmBadge>
            {config.configured
              ? "；botId：" +
                (config.botId ?? "") +
                "；Secret 已配置（尾号 ****" +
                (config.secretHint ?? "") +
                "）" +
                (config.botProfileUrl !== null
                  ? "；机器人链接已配置"
                  : "；未配置机器人链接") +
                (config.updatedAt !== null
                  ? "；最近保存 " +
                    (config.updatedByName ?? "") +
                    " " +
                    formatBeijingMinute(config.updatedAt)
                  : "")
              : "；成员可在「账户菜单 → 绑定企业微信」生成绑定码，发送给机器人后完成绑定"}
          </span>
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
            <span>{wecomRobotErrorMessage(save.error)}</span>
          </div>
        ) : null}

        <form
          className="wecom-robot-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="wecom-robot-field">
            <label htmlFor="wecom-robot-bot-id">机器人 botId</label>
            <Controller
              name="botId"
              control={control}
              rules={{ required: "请填写机器人 botId" }}
              render={({ field }) => (
                <Input
                  id="wecom-robot-bot-id"
                  {...field}
                  placeholder="例如 aibxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
              )}
            />
            {errors.botId ? (
              <small role="alert">{errors.botId.message}</small>
            ) : (
              <small className="form-hint">
                在企业微信管理后台的机器人详情页复制；更换机器人（填写新机器人的值）保存时只会解除个人成员绑定，项目群
                Webhook 不受影响，相关成员需重新绑定。
              </small>
            )}
          </div>
          <div className="wecom-robot-field">
            <label htmlFor="wecom-robot-secret">机器人 Secret</label>
            <Controller
              name="secret"
              control={control}
              rules={{
                validate: (value) =>
                  value.trim().length <= 256 || "Secret 不能超过 256 个字符",
              }}
              render={({ field }) => (
                <Input.Password
                  id="wecom-robot-secret"
                  {...field}
                  autoComplete="new-password"
                  placeholder={
                    config.configured
                      ? "留空表示保持已保存的 Secret 不变"
                      : "首次配置必填"
                  }
                />
              )}
            />
            {errors.secret ? (
              <small role="alert">{errors.secret.message}</small>
            ) : (
              <small className="form-hint">
                Secret
                只会在保存时提交一次，服务端加密存储、永不回显；更换机器人时连同新
                Secret 一起填写。
              </small>
            )}
          </div>
          <div className="wecom-robot-field">
            <label htmlFor="wecom-robot-bot-profile-url">
              机器人链接（可选）
            </label>
            <Controller
              name="botProfileUrl"
              control={control}
              rules={{
                validate: (value) => {
                  const trimmed = value.trim();
                  if (trimmed.length === 0) return true;
                  try {
                    return (
                      new URL(trimmed).protocol === "https:" ||
                      "机器人链接必须是 https 开头的合法网址"
                    );
                  } catch {
                    return "机器人链接必须是 https 开头的合法网址";
                  }
                },
              }}
              render={({ field }) => (
                <Input
                  id="wecom-robot-bot-profile-url"
                  {...field}
                  placeholder="https://work.weixin.qq.com/wework_admin/common/openBotProfile/..."
                />
              )}
            />
            {errors.botProfileUrl ? (
              <small role="alert">{errors.botProfileUrl.message}</small>
            ) : (
              <small className="form-hint">
                粘贴企业微信机器人资料页链接；将展示在成员的「绑定企业微信」弹窗，
                指引他们在企业微信中打开机器人；留空表示不展示。
              </small>
            )}
          </div>
          <div className="wecom-robot-actions">
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              保存配置
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
};

import React from "react";
import { Alert, Switch } from "antd";
import type { InpulseApiClient } from "@generated/api";
import type { PersonalNotificationSetting } from "@shared/notifications/personal-notification-settings";
import { CalmSectionTitle } from "@features/common/components/Calm";
import { notificationScenarios } from "./settings-content";
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from "./notification-preferences-query";

export interface NotificationPolicyPanelProps {
  readonly client?: InpulseApiClient | undefined;
}

/**
 * 通知策略：仅列出会提醒到个人的事件，每个类型后提供个人开关。
 * 开关保存到服务端，关闭后通知写入端口不再生成该类型通知，列表与未读数
 * 只阻止后续新通知，历史通知保持原状；每次切换立即提交完整关闭列表，没有保存按钮。
 */
export const NotificationPolicyPanel: React.FC<
  NotificationPolicyPanelProps
> = ({ client }) => {
  const preferences = useNotificationPreferences({ client });
  const update = useUpdateNotificationPreferences({ client });
  const savedDisabled = preferences.data?.disabledSettings ?? [];
  const disabled = new Set<PersonalNotificationSetting>(
    update.isPending && update.variables !== undefined
      ? update.variables
      : savedDisabled,
  );

  const setEnabled = (
    key: PersonalNotificationSetting,
    enabled: boolean,
  ): void => {
    const next = new Set(disabled);
    if (enabled) {
      next.delete(key);
    } else {
      next.add(key);
    }
    update.mutate([...next]);
  };

  return (
    <section
      className="panel settings-panel table-panel notification-policy-panel"
      aria-label="通知策略"
    >
      <CalmSectionTitle title="通知策略" />

      {preferences.isError ? (
        <Alert
          type="error"
          showIcon
          message="通知策略加载失败，请刷新后重试。"
        />
      ) : null}
      {update.isError ? (
        <Alert type="error" showIcon message="通知策略保存失败，请重试。" />
      ) : null}

      <div className="table-wrap">
        <table className="settings-table notification-policy-table">
          <caption className="sr-only">通知场景</caption>
          <tbody>
            {notificationScenarios.map((row) => (
              <tr key={row.key}>
                <td>
                  <strong>{row.event}</strong>
                </td>
                <td>{row.audience}</td>
                <td className="switch-cell">
                  <Switch
                    size="small"
                    checked={!disabled.has(row.key)}
                    loading={preferences.isPending || update.isPending}
                    disabled={preferences.isError}
                    aria-label={"接收" + row.event + "提醒"}
                    onChange={(checked) => setEnabled(row.key, checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default NotificationPolicyPanel;

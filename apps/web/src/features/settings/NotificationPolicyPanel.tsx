import React, { useEffect, useState } from "react";
import { Switch } from "antd";
import { CalmSectionTitle } from "@features/common/components/Calm";
import { notificationScenarios } from "./settings-content";
import {
  readDisabledNotificationTypes,
  writeDisabledNotificationTypes,
} from "./notification-policy-storage";

export interface NotificationPolicyPanelProps {
  /**
   * 当前登录账号；用于按账号保存开关。为空时只在本次渲染内生效
   * （测试或未登录兜底，不做持久化）。
   */
  readonly userId?: number | null | undefined;
}

/**
 * 通知策略：仅列出会提醒到个人的事件，每个类型后提供个人开关。
 * 每次切换立即写入浏览器本地存储，刷新、切换页签后保持；没有单独的保存按钮。
 */
export const NotificationPolicyPanel: React.FC<
  NotificationPolicyPanelProps
> = ({ userId = null }) => {
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(() =>
    readDisabledNotificationTypes(userId),
  );

  useEffect(() => {
    setDisabled(readDisabledNotificationTypes(userId));
  }, [userId]);

  const setEnabled = (key: string, enabled: boolean): void => {
    setDisabled((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(key);
      } else {
        next.add(key);
      }
      writeDisabledNotificationTypes(userId, next);
      return next;
    });
  };

  return (
    <section
      className="panel settings-panel table-panel notification-policy-panel"
      aria-label="通知策略"
    >
      <CalmSectionTitle title="通知策略" />

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

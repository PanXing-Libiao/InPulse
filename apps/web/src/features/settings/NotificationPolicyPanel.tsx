import React, { useState } from "react";
import { Switch } from "antd";
import { CalmSectionTitle } from "@features/common/components/Calm";
import { notificationScenarios } from "./settings-content";

/**
 * 通知策略：仅列出会提醒到个人的事件，每个类型后提供个人开关。
 */
export const NotificationPolicyPanel: React.FC = () => {
  const [enabledByType, setEnabledByType] = useState<
    Readonly<Record<string, boolean>>
  >(() =>
    Object.fromEntries(notificationScenarios.map((row) => [row.key, true])),
  );

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
                    checked={enabledByType[row.key] ?? true}
                    aria-label={"接收" + row.event + "提醒"}
                    onChange={(checked) =>
                      setEnabledByType((current) => ({
                        ...current,
                        [row.key]: checked,
                      }))
                    }
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

import React, { useEffect, useState } from "react";
import { Button, Switch } from "antd";

import { AppModal as Modal } from "@features/common/components/AppModal";
import { projectNotificationOptions } from "./project-notification-options";
import {
  readDisabledProjectNotificationTypes,
  writeDisabledProjectNotificationTypes,
  type ProjectNotificationCategory,
} from "@shared/notifications/project-notification-policy";

export type { ProjectNotificationOption } from "./project-notification-options";
export { projectNotificationOptions } from "./project-notification-options";

export interface ProjectNotificationOptionsModalProps {
  readonly open: boolean;
  /** 群通知选项按项目保存；为空时只在本次渲染内生效。 */
  readonly projectId: number | null | undefined;
  /** 头部眉标显示当前项目名称；缺省时退回「企业微信项目群」。 */
  readonly projectName?: string | null | undefined;
  readonly onClose: () => void;
}

/**
 * 企业微信项目群绑定成功后的「通知选项」弹窗：管理员选择群聊接收哪些消息。
 * 每次切换立即写入浏览器本地存储，关闭弹窗、刷新页面后保持；没有单独的保存按钮。
 * 同一开关同时过滤当前浏览器的站内通知列表与未读数，历史通知仍保留。
 */
export const ProjectNotificationOptionsModal: React.FC<
  ProjectNotificationOptionsModalProps
> = ({ open, projectId, projectName = null, onClose }) => {
  const [disabled, setDisabled] = useState<
    ReadonlySet<ProjectNotificationCategory>
  >(() => readDisabledProjectNotificationTypes(projectId));

  useEffect(() => {
    setDisabled(readDisabledProjectNotificationTypes(projectId));
  }, [projectId]);

  const setEnabled = (
    key: ProjectNotificationCategory,
    enabled: boolean,
  ): void => {
    setDisabled((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(key);
      } else {
        next.add(key);
      }
      writeDisabledProjectNotificationTypes(projectId, next);
      return next;
    });
  };

  return (
    <Modal
      className="project-notification-modal"
      open={open}
      eyebrow={projectName ?? "企业微信项目群"}
      title="通知选项"
      body
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="table-wrap">
        <table className="settings-table project-notification-table">
          <caption className="sr-only">项目群通知选项</caption>
          <tbody>
            {projectNotificationOptions.map((option) => (
              <tr key={option.key}>
                <td>
                  <strong>{option.event}</strong>
                  <small>{option.description}</small>
                </td>
                <td className="switch-cell">
                  <Switch
                    size="small"
                    checked={!disabled.has(option.key)}
                    aria-label={"项目群推送" + option.event}
                    onChange={(checked) => setEnabled(option.key, checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="form-hint" style={{ marginTop: 12, fontSize: 12 }}>
        关闭后，该类别不再出现在站内通知列表和未读计数中；历史通知仍会保留。
      </p>
    </Modal>
  );
};

export default ProjectNotificationOptionsModal;

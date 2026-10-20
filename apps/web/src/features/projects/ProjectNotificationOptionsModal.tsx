import React, { useState } from "react";
import { Button, Switch } from "antd";

import { AppModal as Modal } from "@features/common/components/AppModal";

export interface ProjectNotificationOption {
  readonly key: string;
  readonly event: string;
  readonly description: string;
}

/** 企业微信项目群可推送的消息口径；默认全开。 */
export const projectNotificationOptions: readonly ProjectNotificationOption[] =
  [
    {
      key: "task.assign",
      event: "任务派发",
      description: "新任务指派、负责人变更（含新增负责人）",
    },
    {
      key: "task.status",
      event: "任务状态变化",
      description: "完成、重新打开、合并、解除合并",
    },
    {
      key: "record",
      event: "迭代记录发布与修订",
      description: "含追加遗留问题、作废与恢复",
    },
    {
      key: "project.member",
      event: "项目与成员变化",
      description: "开工、状态变更、成员加入 / 移出 / 角色调整",
    },
    {
      key: "scope.delete",
      event: "范围与删除",
      description: "模块 / 功能 / 任务的删除等成员可见动态",
    },
  ];

export interface ProjectNotificationOptionsModalProps {
  readonly open: boolean;
  /** 头部眉标显示当前项目名称；缺省时退回「企业微信项目群」。 */
  readonly projectName?: string | null | undefined;
  readonly onClose: () => void;
}

/**
 * 企业微信项目群绑定成功后的「通知选项」弹窗：管理员选择群聊接收哪些消息。
 * 个人单聊提醒由「成员与设置 → 通知策略」单独控制，本弹窗只影响群聊。
 */
export const ProjectNotificationOptionsModal: React.FC<
  ProjectNotificationOptionsModalProps
> = ({ open, projectName = null, onClose }) => {
  const [enabledByType, setEnabledByType] = useState<
    Readonly<Record<string, boolean>>
  >(() =>
    Object.fromEntries(
      projectNotificationOptions.map((item) => [item.key, true]),
    ),
  );

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
                    checked={enabledByType[option.key] ?? true}
                    aria-label={"项目群推送" + option.event}
                    onChange={(checked) =>
                      setEnabledByType((current) => ({
                        ...current,
                        [option.key]: checked,
                      }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
};

export default ProjectNotificationOptionsModal;

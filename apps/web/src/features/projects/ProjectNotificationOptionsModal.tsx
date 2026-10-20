import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Switch } from "antd";

import type { ProjectWecomGroupNotificationOptions } from "@generated/api";
import { AppModal as Modal } from "@features/common/components/AppModal";
import {
  writeDisabledProjectNotificationTypes,
  type ProjectNotificationCategory,
} from "@shared/notifications/project-notification-policy";
import { projectNotificationOptions } from "./project-notification-options";

export type { ProjectNotificationOption } from "./project-notification-options";
export { projectNotificationOptions } from "./project-notification-options";

export interface ProjectNotificationOptionsModalProps {
  readonly open: boolean;
  readonly projectId: number;
  readonly projectName?: string | null | undefined;
  readonly options: ProjectWecomGroupNotificationOptions;
  readonly onSave: (
    options: ProjectWecomGroupNotificationOptions,
  ) => Promise<void>;
  readonly saveErrorMessage: (error: unknown) => string;
  readonly onClose: () => void;
}

/**
 * 企业微信项目群通知选项：由项目组长 / 系统管理员保存到服务端，桥接物化群投递
 * 前按这些开关过滤。切换后立即保存；保存失败时回滚当前视图并展示错误。
 * 保存成功后同时同步当前浏览器的站内筛选；其他成员的站内通知由各自的个人
 * 通知设置管理，服务端群开关不替成员修改个人偏好。
 */
export const ProjectNotificationOptionsModal: React.FC<
  ProjectNotificationOptionsModalProps
> = ({
  open,
  projectId,
  projectName = null,
  options,
  onSave,
  saveErrorMessage,
  onClose,
}) => {
  const [disabled, setDisabled] = useState<
    ReadonlySet<ProjectNotificationCategory>
  >(() => new Set(options.disabledCategories));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDisabled(new Set(options.disabledCategories));
      setSaveError(null);
      setSaved(false);
    }
    wasOpen.current = open;
  }, [open, options]);

  const setEnabled = async (
    key: ProjectNotificationCategory,
    enabled: boolean,
  ): Promise<void> => {
    if (saving) return;
    const previous = disabled;
    const next = new Set(previous);
    if (enabled) {
      next.delete(key);
    } else {
      next.add(key);
    }
    const sorted = [...next].sort() as ProjectNotificationCategory[];
    setDisabled(next);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await onSave({ disabledCategories: sorted });
      writeDisabledProjectNotificationTypes(projectId, next);
      setSaved(true);
    } catch (error) {
      setDisabled(previous);
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  const close = (): void => {
    if (!saving) onClose();
  };

  return (
    <Modal
      className="project-notification-modal"
      open={open}
      eyebrow={projectName ?? "企业微信项目群"}
      title="通知选项"
      body
      onCancel={close}
      footer={
        <Button type="primary" loading={saving} onClick={close}>
          {saving ? "正在保存" : "完成"}
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
                    disabled={saving}
                    checked={!disabled.has(option.key)}
                    aria-label={"项目群推送" + option.event}
                    onChange={(checked) => void setEnabled(option.key, checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="form-hint" style={{ marginTop: 12, fontSize: 12 }}>
        这些开关保存到项目并只控制企业微信群消息，同时用于当前浏览器的站内通知
        筛选；个人单聊提醒和其他成员的站内通知仍由各自的个人通知设置管理。保存只
        影响之后产生并进入群发送队列的消息，历史和已排队消息不会回溯。
      </p>
      <div aria-live="polite">
        {saved ? (
          <p className="form-hint" style={{ fontSize: 12 }}>
            已保存，机器人会按新规则处理后续群消息。
          </p>
        ) : null}
      </div>
      {saveError === null ? null : (
        <Alert type="error" showIcon title={saveErrorMessage(saveError)} />
      )}
    </Modal>
  );
};

export default ProjectNotificationOptionsModal;

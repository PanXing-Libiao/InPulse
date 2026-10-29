import React, { useState } from "react";
import { formatBeijingSecond } from "@features/common/beijing-time";
import { Alert, Button, Input, Popconfirm } from "antd";

import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { CalmSectionTitle } from "@features/common/components/Calm";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import type {
  InpulseApiClient,
  ProjectWecomGroupNotificationOptions,
  ProjectWecomWebhookTarget,
} from "@generated/api";

import {
  projectWecomGroupErrorMessage,
  useProjectWecomGroup,
} from "./project-wecom-group-query";
import { ProjectNotificationOptionsModal } from "./ProjectNotificationOptionsModal";

export interface ProjectWecomGroupCardProps {
  readonly projectId: number;
  /** 通知选项弹窗的眉标：当前项目名称；项目尚未加载时退回「企业微信项目群」。 */
  readonly projectName?: string | null | undefined;
  /** 卡片内标题；在项目主页专用弹窗中可改用更具体的分区名，避免与弹层标题重复。 */
  readonly heading?: string | undefined;
  /** ADR-106：组长 / 系统管理员可管理 Webhook；普通成员只读。 */
  readonly canManage: boolean;
  readonly client?: InpulseApiClient | undefined;
}

const EMPTY_NOTIFICATION_OPTIONS: ProjectWecomGroupNotificationOptions = {
  disabledCategories: [],
};

function formatTimestamp(value: string): string {
  return formatBeijingSecond(value);
}

/**
 * ADR-106 项目企微群通知卡片（Webhook-only）：
 * - 群机器人 Webhook 的脱敏列表、添加与逐项删除；
 * - 项目级通知开关只影响之后物化的群消息；
 * - 项目群不再提供智能机器人绑定码、机器人链接或解绑入口。
 * 服务端门禁是 projectWecomGroup 能力（默认组长 / 系统管理员），普通成员只读。
 */
export const ProjectWecomGroupCard: React.FC<ProjectWecomGroupCardProps> = ({
  projectId,
  projectName = null,
  heading = "企业微信项目群",
  canManage,
  client,
}) => {
  const { query, updateNotificationOptions, createWebhook, deleteWebhook } =
    useProjectWecomGroup(projectId, client);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [webhookFormOpen, setWebhookFormOpen] = useState(false);
  const [webhookLabel, setWebhookLabel] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookFormError, setWebhookFormError] = useState<string | null>(null);

  const status = query.data;
  const webhookTargets = status?.webhookTargets ?? [];
  const bound = status?.state === "BOUND";

  const resetWebhookForm = (): void => {
    setWebhookLabel("");
    setWebhookUrl("");
    setWebhookFormError(null);
  };

  const toggleWebhookForm = (): void => {
    if (webhookFormOpen) resetWebhookForm();
    setWebhookFormOpen(!webhookFormOpen);
  };

  const submitWebhook = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const label = webhookLabel.trim();
    const url = webhookUrl.trim();
    if (label.length === 0) {
      setWebhookFormError("请填写目标群标签，例如「研发项目群」。");
      return;
    }
    if (url.length === 0) {
      setWebhookFormError("请填写企业微信群机器人的 Webhook 地址。");
      return;
    }
    setWebhookFormError(null);
    try {
      await createWebhook.mutateAsync({ label, webhookUrl: url });
      resetWebhookForm();
      setWebhookFormOpen(false);
    } catch (error) {
      setWebhookFormError(projectWecomGroupErrorMessage(error));
    }
  };

  const webhookTargetRow = (target: ProjectWecomWebhookTarget) => (
    <li key={target.id} className="wecom-webhook-target">
      <div className="wecom-webhook-target-head">
        <div className="wecom-webhook-target-title">
          <InpulseIcon name="bell" size={15} />
          <strong>{target.label}</strong>
        </div>
        <span className="wecom-webhook-key">Key 尾号 {target.urlHint}</span>
        {canManage ? (
          <Popconfirm
            title="删除这个 Webhook 目标？"
            description="删除后该项目不再向这个群机器人 Webhook 发送消息；已有投递历史会保留。"
            okText="确认删除"
            cancelText="取消"
            placement="topRight"
            onConfirm={() => deleteWebhook.mutate(target.id)}
          >
            <Button size="small" danger loading={deleteWebhook.isPending}>
              删除
            </Button>
          </Popconfirm>
        ) : null}
      </div>
      <p className="wecom-webhook-meta">
        绑定时间：{formatTimestamp(target.boundAt)}；操作人：
        {target.boundByName}
      </p>
      {target.lastDeliveryError !== null ? (
        <div className="wecom-binding-alert">
          <Alert
            type="warning"
            showIcon
            title={"最近一次投递失败：" + target.lastDeliveryError}
          />
        </div>
      ) : null}
    </li>
  );

  const webhookSection = (
    <div className="wecom-webhook-section" aria-label="企业微信 Webhook 群目标">
      <div className="wecom-webhook-head">
        <div>
          <h3>群机器人 Webhook</h3>
          <p>
            在目标企业微信群右上角打开「聊天信息 → 消息推送 → 添加机器人」，
            创建群机器人并复制 Webhook
            地址后粘贴到这里。完整地址只在保存时使用， 页面之后只显示 Key 尾号。
          </p>
        </div>
        {canManage ? (
          <Button size="small" onClick={toggleWebhookForm}>
            {webhookFormOpen ? "取消" : "添加 Webhook"}
          </Button>
        ) : null}
      </div>

      {webhookFormOpen && canManage ? (
        <form
          className="wecom-webhook-form"
          onSubmit={(event) => void submitWebhook(event)}
        >
          <label>
            <span>目标群标签</span>
            <Input
              aria-label="Webhook 目标群标签"
              value={webhookLabel}
              maxLength={80}
              placeholder="例如：研发项目群"
              onChange={(event) => setWebhookLabel(event.target.value)}
            />
          </label>
          <label>
            <span>企业微信 Webhook 地址</span>
            <Input.Password
              aria-label="企业微信 Webhook 地址"
              value={webhookUrl}
              maxLength={2048}
              autoComplete="off"
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
              onChange={(event) => setWebhookUrl(event.target.value)}
            />
          </label>
          {webhookFormError !== null ? (
            <p className="wecom-webhook-form-error" role="alert">
              {webhookFormError}
            </p>
          ) : null}
          <div className="wecom-webhook-form-actions">
            <Button
              type="primary"
              htmlType="submit"
              size="small"
              loading={createWebhook.isPending}
            >
              保存 Webhook
            </Button>
          </div>
        </form>
      ) : null}

      {webhookTargets.length === 0 ? (
        <div className="wecom-webhook-empty">
          尚未添加 Webhook。添加后，项目动态可以直接发送到对应的企业微信群。
        </div>
      ) : (
        <ul className="wecom-webhook-targets">
          {webhookTargets.map(webhookTargetRow)}
        </ul>
      )}

      {!canManage ? (
        <p className="wecom-binding-meta">
          只有项目组长或系统管理员可以添加或删除 Webhook 目标。
        </p>
      ) : null}
    </div>
  );

  return (
    <section
      className="panel settings-panel project-wecom-card"
      aria-label="企业微信项目群"
    >
      <div className="settings-panel-head">
        <CalmSectionTitle title={heading}>
          {canManage && bound ? (
            <div className="calm-section-actions">
              <Button size="small" onClick={() => setNotificationOpen(true)}>
                通知选项
              </Button>
            </div>
          ) : null}
        </CalmSectionTitle>
      </div>

      {query.isPending ? (
        <CalmSkeleton
          variant="lines"
          rows={3}
          compact
          label="正在读取企业微信项目群状态"
        />
      ) : query.isError || status === undefined ? (
        <div className="wecom-binding-note is-alert" role="alert">
          <InpulseIcon name="alert" size={17} />
          <span>
            <strong>无法读取项目群通知状态</strong>
            {projectWecomGroupErrorMessage(query.error)}
          </span>
        </div>
      ) : (
        <>
          <div
            className={
              bound ? "wecom-binding-note is-ready" : "wecom-binding-note"
            }
          >
            <InpulseIcon name={bound ? "check" : "bell"} size={17} />
            <span>
              <strong>
                {bound
                  ? "已添加 Webhook 群通知目标"
                  : "添加 Webhook 后群聊即可收到项目消息"}
              </strong>
              {bound
                ? "项目消息会发送到下方列出的企业微信群机器人 Webhook；无需智能机器人激活，也不依赖长连接。个人单聊提醒继续独立生效。"
                : "默认推送任务派发、任务状态、记录、项目成员与删除类动态；普通任务编辑不推送。添加后可在「通知选项」调整，个人单聊提醒继续并存。"}
            </span>
          </div>
          {!bound ? (
            <ol className="wecom-binding-steps">
              <li>
                在企业微信目标群右上角打开「聊天信息 → 消息推送 → 添加机器人」；
              </li>
              <li>创建群机器人并复制 Webhook 地址；</li>
              <li>
                {canManage
                  ? "点下方「添加 Webhook」，填写标签和地址；"
                  : "请项目组长或系统管理员添加 Webhook；"}
              </li>
            </ol>
          ) : null}
        </>
      )}

      {webhookSection}

      {deleteWebhook.isError ? (
        <div className="wecom-binding-alert">
          <Alert
            type="error"
            showIcon
            title={projectWecomGroupErrorMessage(deleteWebhook.error)}
          />
        </div>
      ) : null}

      <ProjectNotificationOptionsModal
        open={notificationOpen}
        projectId={projectId}
        projectName={projectName}
        options={status?.notificationOptions ?? EMPTY_NOTIFICATION_OPTIONS}
        onSave={(options) =>
          updateNotificationOptions.mutateAsync(options).then(() => undefined)
        }
        saveErrorMessage={projectWecomGroupErrorMessage}
        onClose={() => setNotificationOpen(false)}
      />
    </section>
  );
};

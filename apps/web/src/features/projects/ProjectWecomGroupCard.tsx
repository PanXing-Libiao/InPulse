import React, { useEffect, useState } from "react";
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
  /** ADR-077 / ADR-105：组长 / 系统管理员可管理机器人绑定与 Webhook；普通成员只读。 */
  readonly canManage: boolean;
  readonly client?: InpulseApiClient | undefined;
}

const EMPTY_NOTIFICATION_OPTIONS: ProjectWecomGroupNotificationOptions = {
  disabledCategories: [],
};

function formatTimestamp(value: string): string {
  return formatBeijingSecond(value);
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds.toString().padStart(2, "0")} 秒`;
}

/**
 * ADR-077 / ADR-105 项目企微群通知卡片（项目主页企微入口弹窗）：
 * - 智能机器人三态、一次性绑定码、机器人资料链接与解绑；
 * - 群机器人 Webhook 的脱敏列表、添加与逐项删除；
 * - 两种通道共用项目级通知选项，并明确提示同群重复投递风险。
 * 服务端门禁是 projectWecomGroup 能力（默认组长 / 系统管理员），普通成员只读。
 */
export const ProjectWecomGroupCard: React.FC<ProjectWecomGroupCardProps> = ({
  projectId,
  projectName = null,
  heading = "企业微信项目群",
  canManage,
  client,
}) => {
  const {
    query,
    issueCode,
    updateNotificationOptions,
    unbind,
    createWebhook,
    deleteWebhook,
  } = useProjectWecomGroup(projectId, client);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [robotCopyState, setRobotCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [now, setNow] = useState(() => Date.now());
  const [webhookFormOpen, setWebhookFormOpen] = useState(false);
  const [webhookLabel, setWebhookLabel] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookFormError, setWebhookFormError] = useState<string | null>(null);

  // 绑定码有效期倒计时：只在卡片挂载期间走秒。
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const status = query.data;
  const robotUrl = status?.botProfileUrl ?? null;
  const code = issueCode.data?.code ?? null;
  const codeExpiresAt =
    issueCode.data?.expiresAt ?? status?.codeExpiresAt ?? null;
  const remainingMs =
    codeExpiresAt === null ? 0 : Date.parse(codeExpiresAt) - now;
  const codeUsable = code !== null && remainingMs > 0;
  const pendingWithoutCode =
    !codeUsable && status?.state === "PENDING" && codeExpiresAt !== null;
  const bound = status?.state === "BOUND";
  const botBound = status !== undefined && status.boundAt !== null;
  const webhookTargets = status?.webhookTargets ?? [];

  async function handleCopyCode(): Promise<void> {
    if (code === null) return;
    if (navigator.clipboard === undefined) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  async function handleCopyRobotUrl(): Promise<void> {
    if (robotUrl === null) return;
    if (navigator.clipboard === undefined) {
      setRobotCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(robotUrl);
      setRobotCopyState("copied");
    } catch {
      setRobotCopyState("failed");
    }
  }

  const generate = (): void => {
    setCopyState("idle");
    issueCode.mutate();
  };

  const issueButton = (
    <Button
      size="small"
      className="soft-blue-button"
      onClick={generate}
      loading={issueCode.isPending}
    >
      {botBound || pendingWithoutCode ? "重新生成绑定码" : "生成绑定码"}
    </Button>
  );

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

  const robotLinkNote =
    robotUrl === null ? null : (
      <div className="wecom-binding-robot-link">
        <div className="wecom-binding-robot-link-head">
          <InpulseIcon name="externalLink" size={15} />
          <span>先在「企业微信」中打开机器人</span>
        </div>
        <code aria-label="机器人链接">{robotUrl}</code>
        <div className="wecom-binding-code-actions">
          <Button size="small" onClick={() => void handleCopyRobotUrl()}>
            复制机器人链接
          </Button>
          {robotCopyState === "copied" ? (
            <span role="status">已复制；发到企业微信任意会话中点击打开</span>
          ) : robotCopyState === "failed" ? (
            <span role="alert">复制失败，请手动选中链接复制</span>
          ) : null}
        </div>
      </div>
    );

  const codeBlock = codeUsable ? (
    <>
      <div className="wecom-binding-note" role="status">
        <InpulseIcon name="clock" size={17} />
        <span>
          <strong>绑定码已生成</strong>
          先让群里任意成员 @机器人 发一条消息（让机器人获得这个群），
          再把绑定码发到群里；绑定成功后本卡片会自动刷新。
        </span>
      </div>
      <div className="wecom-binding-code">
        <code aria-label="项目群绑定码">{code}</code>
        <div className="wecom-binding-code-foot">
          <small>剩余有效时间：{formatRemaining(remainingMs)}</small>
          <div className="wecom-binding-code-actions">
            <Button size="small" onClick={() => void handleCopyCode()}>
              复制绑定码
            </Button>
            {copyState === "copied" ? (
              <span role="status">已复制，去企业微信群里发给机器人</span>
            ) : copyState === "failed" ? (
              <span role="alert">复制失败，请手动选中绑定码复制</span>
            ) : null}
          </div>
        </div>
      </div>
    </>
  ) : pendingWithoutCode ? (
    <div className="wecom-binding-note" role="status">
      <InpulseIcon name="clock" size={17} />
      <span>
        <strong>已有一个待用绑定码</strong>
        有效期至 {formatTimestamp(codeExpiresAt)}
        ；如果它已经丢失，请点「重新生成绑定码」。
      </span>
    </div>
  ) : null;

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
            复制 Webhook
            地址后粘贴到这里。完整地址只在保存时使用，页面之后只显示 Key 尾号。
          </p>
        </div>
        {canManage ? (
          <Button size="small" onClick={toggleWebhookForm}>
            {webhookFormOpen ? "取消" : "添加 Webhook"}
          </Button>
        ) : null}
      </div>

      {botBound && webhookTargets.length > 0 ? (
        <div className="wecom-binding-alert">
          <Alert
            type="warning"
            showIcon
            title="同一项目同时配置了智能机器人和 Webhook"
          />
          <p className="wecom-webhook-duplicate-note">
            如果两种通道指向同一个企业微信群，该群会收到重复消息；请确认它们覆盖的是不同群，或只保留一种通道。
          </p>
        </div>
      ) : null}

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
          {canManage ? (
            <div className="calm-section-actions">
              {bound ? (
                <Button size="small" onClick={() => setNotificationOpen(true)}>
                  通知选项
                </Button>
              ) : null}
              {issueButton}
              {botBound ? (
                <Popconfirm
                  title="解除项目与智能机器人的绑定？"
                  description="解绑后该智能机器人目标不再收到项目消息；Webhook 目标、已有通知与投递历史都会保留。"
                  okText="确认解绑"
                  cancelText="取消"
                  classNames={{ root: "wecom-unbind-popconfirm" }}
                  placement="topRight"
                  onConfirm={() => unbind.mutate()}
                >
                  <Button size="small" danger loading={unbind.isPending}>
                    解绑智能机器人
                  </Button>
                </Popconfirm>
              ) : null}
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
            <strong>无法读取项目群绑定状态</strong>
            {projectWecomGroupErrorMessage(query.error)}
          </span>
        </div>
      ) : bound ? (
        <>
          <div className="wecom-binding-note is-ready" role="status">
            <InpulseIcon name="check" size={17} />
            <span>
              <strong>
                {botBound ? "已绑定企业微信群" : "已添加 Webhook 群通知目标"}
              </strong>
              {botBound
                ? "群消息按「通知选项」中的开关推送；普通任务编辑不会推送到群。个人单聊提醒不受这些群开关影响，两者并存。"
                : "项目消息会发送到下方列出的企业微信群机器人 Webhook；无需先与智能机器人对话，也不依赖长连接订阅。"}
            </span>
          </div>
          {botBound ? (
            <p className="wecom-binding-meta">
              绑定时间：
              {status.boundAt === null
                ? "未知"
                : formatTimestamp(status.boundAt)}
              ；操作人：{status.boundByName ?? "未知"}
            </p>
          ) : null}
          {status.lastDeliveryError !== null ? (
            <div className="wecom-binding-alert">
              <Alert
                type="warning"
                showIcon
                title={"最近一次群消息投递失败：" + status.lastDeliveryError}
              />
            </div>
          ) : null}
          {codeBlock}
          {robotLinkNote}
          {codeExpiresAt !== null && !codeUsable ? (
            <div className="wecom-binding-alert">
              <Alert
                type="warning"
                showIcon
                title={
                  "换绑码有效期至 " +
                  formatTimestamp(codeExpiresAt) +
                  "，如已丢失请重新生成。"
                }
              />
            </div>
          ) : null}
          {unbind.isSuccess ? (
            <div className="wecom-binding-alert">
              <Alert type="success" showIcon title="已解绑智能机器人目标。" />
            </div>
          ) : null}
        </>
      ) : (
        <>
          {codeBlock !== null ? (
            codeBlock
          ) : (
            <>
              <div className="wecom-binding-note">
                <InpulseIcon name="bell" size={17} />
                <span>
                  <strong>绑定后群聊即可收到项目消息</strong>
                  默认推送任务派发、任务状态、记录、项目成员与删除类动态；普通任务编辑不推送。绑定后可在「通知选项」调整，个人单聊提醒继续并存。
                </span>
              </div>
              <ol className="wecom-binding-steps">
                <li>把 InPulse 机器人拉进目标企业微信群；</li>
                <li>在群里 @机器人 发一条消息，让机器人获得这个群；</li>
                <li>
                  {canManage
                    ? "点右上角「生成绑定码」；"
                    : "请项目组长或系统管理员生成绑定码；"}
                </li>
                <li>把绑定码发到群里，机器人确认后即完成绑定。</li>
              </ol>
              <div className="wecom-binding-placeholder">
                也可以直接使用下方 Webhook，无需智能机器人激活与长连接。
              </div>
            </>
          )}
          {robotLinkNote}
          {unbind.isSuccess ? (
            <div className="wecom-binding-alert">
              <Alert type="success" showIcon title="已解绑智能机器人目标。" />
            </div>
          ) : null}
          {!canManage ? (
            <p className="wecom-binding-meta">
              只有项目组长或系统管理员可以生成绑定码或解绑。
            </p>
          ) : null}
        </>
      )}

      {webhookSection}

      {issueCode.isError ? (
        <div className="wecom-binding-alert">
          <Alert
            type="error"
            showIcon
            title={projectWecomGroupErrorMessage(issueCode.error)}
          />
        </div>
      ) : null}
      {unbind.isError ? (
        <div className="wecom-binding-alert">
          <Alert
            type="error"
            showIcon
            title={projectWecomGroupErrorMessage(unbind.error)}
          />
        </div>
      ) : null}
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

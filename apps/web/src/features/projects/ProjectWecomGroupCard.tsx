import React, { useEffect, useState } from "react";
import { formatBeijingSecond } from "@features/common/beijing-time";
import { Alert, Button, Popconfirm } from "antd";

import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { CalmSectionTitle } from "@features/common/components/Calm";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import type { InpulseApiClient } from "@generated/api";

import {
  projectWecomGroupErrorMessage,
  useProjectWecomGroup,
} from "./project-wecom-group-query";
import { ProjectNotificationOptionsModal } from "./ProjectNotificationOptionsModal";

export interface ProjectWecomGroupCardProps {
  readonly projectId: number;
  /** 通知选项弹窗的眉标：当前项目名称；项目尚未加载时退回「企业微信项目群」。 */
  readonly projectName?: string | null | undefined;
  /** ADR-077：组长 / 系统管理员可见「生成绑定码」与「解绑」；普通成员只读。 */
  readonly canManage: boolean;
  readonly client?: InpulseApiClient | undefined;
}

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
 * ADR-077 项目企微群绑定卡片（项目成员页）：三态展示（UNBOUND / PENDING /
 * BOUND）、一次性绑定码（明文只展示一次、10 分钟有效、倒计时）、解绑二次确认、
 * 桥接侧最近投递错误与机器人资料链接提示。签发与解绑的服务端门禁是组长 /
 * 系统管理员，普通成员只读；有待用码时每 5 秒轮询，群里发送后自动刷新。
 */
export const ProjectWecomGroupCard: React.FC<ProjectWecomGroupCardProps> = ({
  projectId,
  projectName = null,
  canManage,
  client,
}) => {
  const { query, issueCode, unbind } = useProjectWecomGroup(projectId, client);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [robotCopyState, setRobotCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [now, setNow] = useState(() => Date.now());

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
      {bound || pendingWithoutCode ? "重新生成绑定码" : "生成绑定码"}
    </Button>
  );

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

  return (
    <section
      className="panel settings-panel project-wecom-card"
      aria-label="企业微信项目群"
    >
      <div className="settings-panel-head">
        <CalmSectionTitle title="企业微信项目群">
          {canManage ? (
            <div className="calm-section-actions">
              {bound ? (
                <Button size="small" onClick={() => setNotificationOpen(true)}>
                  通知选项
                </Button>
              ) : null}
              {issueButton}
              {bound ? (
                <Popconfirm
                  title="解除项目与企业微信群的绑定？"
                  description="解绑后该群不再收到项目消息；已有通知与投递历史都会保留。"
                  okText="确认解绑"
                  cancelText="取消"
                  classNames={{ root: "wecom-unbind-popconfirm" }}
                  placement="topRight"
                  onConfirm={() => unbind.mutate()}
                >
                  <Button size="small" danger loading={unbind.isPending}>
                    解绑企业微信群
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
              <strong>已绑定企业微信群</strong>
              本项目的任务派发与全部成员可见动态都会推送到该群；
              个人单聊提醒不受影响，两者并存。
            </span>
          </div>
          <p className="wecom-binding-meta">
            绑定时间：
            {status.boundAt === null ? "未知" : formatTimestamp(status.boundAt)}
            ；操作人：{status.boundByName ?? "未知"}
          </p>
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
              <Alert type="success" showIcon title="已解除绑定。" />
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
                  默认推送任务派发与全部成员可见的项目动态；个人单聊提醒继续并存。
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
                生成后，绑定码会显示在这里（10 分钟内有效、只能使用一次）
              </div>
            </>
          )}
          {robotLinkNote}
          {unbind.isSuccess ? (
            <div className="wecom-binding-alert">
              <Alert type="success" showIcon title="已解除绑定。" />
            </div>
          ) : null}
          {!canManage ? (
            <p className="wecom-binding-meta">
              只有项目组长或系统管理员可以生成绑定码或解绑。
            </p>
          ) : null}
        </>
      )}

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

      <ProjectNotificationOptionsModal
        open={notificationOpen}
        projectId={projectId}
        projectName={projectName}
        onClose={() => setNotificationOpen(false)}
      />
    </section>
  );
};

import { Alert, Button } from "antd";
import { ApiError } from "@generated/api";

import { AppModal as Modal } from "./AppModal";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * ADR-059：删除模块 / 功能专用错误文案。`moduleErrorMessage` / `featureErrorMessage`
 * 是编辑场景的通用映射（「输入已保留，请加载最新版本后继续编辑」），删除弹窗没有
 * 输入也没有重载按钮，因此 409 直接透出服务端原因（如未分类模块的
 * `MODULE_UNCLASSIFIED_PROTECTED`、并发删除的版本冲突），不追加编辑话术。
 */
export function catalogDeletionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "权限或安全校验未通过，请重新登录后重试。";
    if (error.status === 404) return "模块或功能不存在，或你已无权访问。";
    if (error.status === 409 || error.status === 422)
      return `${error.message}。`;
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "服务暂时不可用，请稍后重试。";
}

/**
 * ADR-059：模块 / 功能删除的二次确认，与「删除任务」同一形态——页面色条的
 * 危险弹层 + 影响面提示 + 不可恢复声明，确认后由服务端在同一事务内级联删除
 * 下级功能与任务。
 *
 * 两个调用方的差异只有名词与 `impact`（服务端下发的 `stats` 计数拼出的影响面），
 * 因此共用一份实现，避免两处文案与结构漂移。
 *
 * 调用方必须把它渲染在编辑弹窗**之外**（与其平级）：rc-dialog 会 memo 化弹窗的
 * children，挂在编辑弹窗子树内的确认弹层拿不到 `open` / `pending` 更新，删除成功后
 * 会卡在打开态一直转圈、遮罩不撤（ADR-058 已用两个变体实测对照确认）。
 */
export function CatalogItemDeletionConfirm({
  noun,
  open,
  name,
  code,
  impact,
  pending,
  error,
  testId,
  onCancel,
  onConfirm,
}: {
  /** 「模块」或「功能」：参与标题、提示文案与无障碍名称。 */
  noun: string;
  open: boolean;
  name: string | undefined;
  code: string | undefined;
  /** 影响面提示（下级功能 / 任务计数与级联范围），由调用方按 `stats` 拼出。 */
  impact: string;
  pending: boolean;
  error: unknown;
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      className="catalog-modal"
      open={open && name !== undefined}
      eyebrow={code === undefined ? `删除${noun}` : `${code} / 删除${noun}`}
      title={`确认删除${noun}`}
      tone="danger"
      icon="alert"
      onCancel={onCancel}
      mask={{ closable: true }}
      footer={
        <>
          <Button className="secondary-button" onClick={onCancel}>
            取消
          </Button>
          <Button
            className="primary-button danger-button"
            data-testid={testId}
            loading={pending}
            onClick={onConfirm}
          >
            确认删除
          </Button>
        </>
      }
    >
      <div className="catalog-form">
        <div className="dialog-form">
          <Alert
            showIcon
            type="warning"
            title={`确认删除${noun}「${name ?? ""}」？`}
            description={
              <>
                <p>
                  删除后该{noun}
                  会从项目、任务中心、看板、搜索与动态中消失，且不能恢复。删除动作会记入审计日志与项目动态。
                </p>
                <p>{impact}</p>
              </>
            }
          />
          {error ? (
            <Alert showIcon type="error" title={catalogDeletionError(error)} />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

import { Alert, Button } from "antd";
import { ApiError } from "@generated/api";

import { AppModal as Modal } from "./AppModal";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/** ADR-096 / ADR-109：模块删除错误文案。删除弹窗没有输入，不透出编辑冲突话术。 */
export function catalogDeletionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "权限或安全校验未通过，请重新登录后重试。";
    if (error.status === 404) return "模块不存在，或你已无权访问。";
    if (error.status === 409 || error.status === 422)
      return error.message + "。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "服务暂时不可用，请稍后重试。";
}

/** ADR-096 / ADR-109：模块物理删除的二次确认。 */
export function ModuleDeletionConfirm({
  open,
  name,
  code,
  impact,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string | undefined;
  code: string | undefined;
  impact: string;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      className="catalog-modal"
      open={open && name !== undefined}
      eyebrow={code === undefined ? "删除模块" : code + " / 删除模块"}
      title="确认删除模块"
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
            data-testid="confirm-delete-module"
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
            title={"确认删除模块「" + (name ?? "") + "」？"}
            description={
              <>
                <p>
                  删除后不可恢复；该模块及其下全部任务、这些实体的全部迭代记录、版本、遗留项与
                  GitHub 链接关联会被永久删除。仅保留审计日志与项目动态。
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

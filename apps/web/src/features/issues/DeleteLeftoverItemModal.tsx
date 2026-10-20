import React, { useRef, useState } from "react";
import { Alert, Button } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type InpulseApiClient } from "@generated/api";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";

/**
 * F-20 遗留问题删除：遗留项被版本快照与任务链接引用，仓库规则也不允许物理删除
 * 业务历史。因此这里的「删除」复用正式记录的修订命令：把目标 ACTIVE 项从当前
 * 版本的提交列表移除，服务端将它标记为 RESOLVED，并保留来源记录、全部历史版本
 * 与审计记录。
 */

export interface DeleteLeftoverTarget {
  readonly projectId: number;
  readonly recordId: number;
  readonly recordCode: string;
  readonly leftoverItemId: number;
  readonly content: string;
}

/** 删除确认框的错误文案：与表单编辑不同，这里没有输入需要保留。 */
export function leftoverDeletionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录后再试。";
    if (error.status === 403) return "请求未通过安全校验，请刷新页面后重试。";
    if (error.status === 404) return "来源迭代记录不存在，或你已无权访问。";
    if (error.status === 409) return "记录已被他人更新，请刷新页面后重试。";
    if (error.status === 422) {
      const message = error.message.trim();
      return message === "" ? "删除参数未通过校验，请刷新后重试。" : message;
    }
    if (error.status === 429) return "操作过于频繁，请稍后重试。";
  }
  return "暂时无法删除这条遗留问题，请稍后重试。";
}

function contentPreview(content: string): string {
  return content.length > 80 ? content.slice(0, 80) + "…" : content;
}

export const DeleteLeftoverItemModal: React.FC<{
  readonly target: DeleteLeftoverTarget;
  readonly api: InpulseApiClient;
  readonly onClose: () => void;
}> = ({ target, api, onClose }) => {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);

  const invalidate = () => {
    for (const key of [
      "leftover-items",
      "published-record",
      "record-feed",
      "record-versions",
      "activity",
      "search",
      "notifications",
      "notifications-unread-count",
    ]) {
      void cache.invalidateQueries({ queryKey: [key] });
    }
    void invalidateShellCounters(cache);
  };

  const remove = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const record = await api.getChangeRecord(
        target.projectId,
        target.recordId,
      );
      if (record.status !== "PUBLISHED") {
        setError("来源迭代记录已作废，无法删除该遗留问题。请刷新列表后重试。");
        return;
      }
      const leftover = record.leftovers.find(
        (entry) => entry.id === target.leftoverItemId,
      );
      if (leftover === undefined || leftover.status !== "ACTIVE") {
        invalidate();
        setError("这条遗留问题已被处理，列表已刷新。");
        return;
      }
      const remainingIssues: { id: number; content: string }[] = [];
      for (const entry of record.remainingIssues) {
        if (entry.id === undefined) {
          setError("来源迭代记录内容不完整，请刷新后重试。");
          return;
        }
        if (entry.id === target.leftoverItemId) continue;
        remainingIssues.push({ id: entry.id, content: entry.content });
      }
      const body = {
        title: record.title,
        contextProblem: record.contextProblem,
        changeSolution: record.changeSolution,
        resultVerification: record.resultVerification,
        remainingIssues,
        confirmLeftoverResolved: true,
      };
      const signature = JSON.stringify([
        target.projectId,
        target.recordId,
        target.leftoverItemId,
        record.rowVersion,
        record.currentVersion,
        body,
      ]);
      const previous = retry.current;
      const key =
        previous?.signature === signature
          ? previous.key
          : createIdempotencyKey("leftover-delete");
      retry.current = { signature, key };
      const csrf = await api.issueCsrfToken();
      await api.createChangeRecordVersion(
        target.projectId,
        target.recordId,
        body,
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "If-Match": '"' + record.rowVersion + '"',
            "X-Record-Version": String(record.currentVersion),
            "Idempotency-Key": key,
          },
        },
      );
      onClose();
      invalidate();
    } catch (cause) {
      setError(leftoverDeletionErrorMessage(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      className="catalog-modal"
      eyebrow={target.recordCode + " / 删除遗留问题"}
      title="确认删除遗留问题"
      tone="danger"
      icon="alert"
      open={true}
      onCancel={() => {
        if (!busy) onClose();
      }}
      mask={{ closable: !busy }}
      closable={!busy}
      footer={
        <>
          <Button
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            className="primary-button danger-button"
            loading={busy}
            onClick={() => void remove()}
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
            title={"确认删除「" + contentPreview(target.content) + "」？"}
            description={
              <>
                <p>
                  删除后这条问题会移入「已处理」，并从待处理列表和未处理计数中移除。
                </p>
                <p>
                  来源迭代记录、历史版本与审计记录都会保留，不会物理删除；需要继续跟进时仍可从来源记录中查看。
                </p>
              </>
            }
          />
          {error === null ? null : (
            <Alert showIcon type="error" title={error} />
          )}
        </div>
      </div>
    </Modal>
  );
};

import React, { useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type ReadableRecord,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";
export function RecordLifecycleButton({
  item,
  api,
  onChanged,
}: {
  item: ReadableRecord;
  api: InpulseApiClient;
  onChanged: () => void;
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [baseline, setBaseline] = useState(item);
  const retry = useRef<{ signature: string; key: string } | null>(null),
    saving = useRef(false);
  const restore = baseline.status === "VOID",
    label = restore ? "恢复记录" : "作废记录";
  async function reload() {
    setBusy(true);
    try {
      const latest = await api.getChangeRecord(item.projectId, item.id);
      setBaseline(latest);
      setNeedsRefresh(false);
      setError(null);
      retry.current = null;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (saving.current || !reason.trim() || needsRefresh) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = { reason: reason.trim() },
        signature = JSON.stringify([
          baseline.id,
          baseline.status,
          baseline.rowVersion,
          body,
        ]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("record-lifecycle"),
        };
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "If-Match": `"${baseline.rowVersion}"`,
          "Idempotency-Key": retry.current.key,
        },
      };
      if (restore)
        await api.restoreChangeRecord(item.projectId, item.id, body, init);
      else await api.voidChangeRecord(item.projectId, item.id, body, init);
      await Promise.all(
        [
          ["record-feed"],
          ["published-record", item.projectId, item.id],
          ["record-versions", item.projectId, item.id],
          ["search"],
          ["activity"],
          ["activity-center"],
        ].map((queryKey) => cache.invalidateQueries({ queryKey })),
      );
      // 作废 / 恢复会隐藏或恢复记录下的遗留项，侧栏计数随即变化。
      await invalidateShellCounters(cache);
      setOpen(false);
      setReason("");
      retry.current = null;
      onChanged();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.status === 409) setNeedsRefresh(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const errorText =
    error instanceof ApiError
      ? error.status === 401
        ? SESSION_EXPIRED_MESSAGE
        : error.status === 403
          ? "只有系统管理员可以作废或恢复记录。"
          : error.status === 404
            ? "记录不存在或当前无法访问。"
            : error.status === 409
              ? "记录或父级状态已变化。请加载最新状态，核对后重新确认。"
              : error.status === 422
                ? "请检查原因和记录版本。"
                : error.status === 429
                  ? "操作频繁，请稍后重试。"
                  : "暂时无法操作，原因已保留，可重试。"
      : "暂时无法操作，原因已保留，可重试。";
  return (
    <>
      <Button
        danger={item.status === "PUBLISHED"}
        onClick={() => {
          setBaseline(item);
          setOpen(true);
          setError(null);
        }}
      >
        {item.status === "VOID" ? "恢复记录" : "作废记录"}
      </Button>
      <Modal
        className="catalog-modal"
        eyebrow={item.code + " · " + item.title}
        title={label}
        // 作废是破坏性动作（红顶条），恢复是挽回（绿顶条）。
        tone={restore ? "success" : "danger"}
        icon={restore ? "rotateCcw" : "alert"}
        open={open}
        body
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        closable={!busy}
        mask={{ closable: !busy }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              danger={!restore}
              type="primary"
              loading={busy}
              disabled={!reason.trim() || needsRefresh}
              aria-label={`确认${label}`}
              onClick={() => void submit()}
            >
              确认{label}
            </Button>
          </>
        }
      >
        <p>
          {restore
            ? "恢复后成员可以再次查看正文及历史版本。最近作废快照与审计历史仍保留。"
            : "作废后仅管理员可查看该记录及历史版本；既有跟进任务和遗留项保持原状态。"}
        </p>
        <p>
          当前状态：{baseline.status === "VOID" ? "已作废" : "已发布"} · 版本{" "}
          {baseline.rowVersion}
        </p>
        <label htmlFor="record-lifecycle-reason">
          {restore ? "恢复原因" : "作废原因"}
        </label>
        <Input.TextArea
          id="record-lifecycle-reason"
          value={reason}
          maxLength={10000}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
        {(error !== null || needsRefresh) && (
          <Alert
            type="error"
            title={
              error === null && needsRefresh
                ? "记录或父级状态已变化。请加载最新状态，核对后重新确认。"
                : errorText
            }
            action={
              needsRefresh ? (
                <Button disabled={busy} onClick={() => void reload()}>
                  加载最新状态
                </Button>
              ) : undefined
            }
          />
        )}
      </Modal>
    </>
  );
}

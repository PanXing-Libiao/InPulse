import React, { useRef, useState } from "react";
import { Alert, Button } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type RecordDraftItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import { navigatePrepared } from "@shared/routing/navigate-prepared";
import { prefetchRecordPath } from "@features/records/records-route-prefetch";
export function PublishRecordButton({
  item,
  api,
  writable,
}: {
  item: RecordDraftItem;
  api: InpulseApiClient;
  writable: boolean;
}) {
  const cache = useQueryClient(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const retry = useRef<{ signature: string; key: string } | null>(null),
    saving = useRef(false);
  const target = `/records?view=published&projectId=${item.projectId}&publishedId=${item.id}`;
  async function publish() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const signature = `${item.id}:${item.rowVersion}`;
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("record-publish"),
        };
      const csrf = await api.issueCsrfToken();
      const value = await api.publishChangeRecord(
        item.projectId,
        item.id,
        {},
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "If-Match": `"${item.rowVersion}"`,
            "Idempotency-Key": retry.current.key,
          },
        },
      );
      cache.setQueryData(["published-record", item.projectId, item.id], value);
      await cache.invalidateQueries({
        queryKey: ["record-drafts", item.projectId],
      });
      await cache.invalidateQueries({
        queryKey: ["task-record-drafts", item.projectId],
      });
      // 刚发布的记录要立刻出现在时间线里：与弹窗主按钮那条发布路径保持一致
      //（RecordDraftEditorModal 发布会同时失效 record-feed 与 task-marks）；
      // 任务卡片与任务详情的「迭代记录 N 条」来自 R-5 任务标记，也必须一起失效。
      await cache.invalidateQueries({ queryKey: ["record-feed"] });
      await cache.invalidateQueries({ queryKey: ["task-marks"] });
      // 发布会把正文里的剩余问题变成待处理遗留项，侧栏计数随即变化。
      await invalidateShellCounters(cache);
      setOpen(false);
      void navigatePrepared(navigate, target, {
        prepare: () => prefetchRecordPath(cache, target, api) ?? undefined,
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }
  async function reload() {
    setBusy(true);
    try {
      const latest = await api.getRecordDraft(item.projectId, item.id);
      cache.setQueryData(["record-draft", item.projectId, item.id], latest);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        type="primary"
        disabled={!writable}
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
      >
        发布记录
      </Button>
      <Modal
        className="catalog-modal"
        open={open}
        eyebrow={item.code + " · " + item.title}
        title="发布迭代记录"
        tone="info"
        icon="fileText"
        body
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        mask={{ closable: !busy }}
        footer={
          <Button
            type="primary"
            loading={busy}
            disabled={
              !writable || (error instanceof ApiError && error.status === 409)
            }
            onClick={() => void publish()}
          >
            确认发布
          </Button>
        }
      >
        <p>
          发布“{item.title}”并生成正式编号与 v1。之后的内容修订会保留为新版本。
        </p>
        <p>
          发布时遗留问题最多10000字符，完整正文需满足发布容量；超限会保留草稿并提示调整。
        </p>
        {!!error && (
          <Alert
            type="error"
            title={
              error instanceof ApiError
                ? error.message
                : "服务暂时不可用，草稿已保留，可重试。"
            }
          />
        )}
        {error instanceof ApiError &&
        error.code === "RECORD_ALREADY_PUBLISHED" ? (
          <a href={target}>打开已发布记录</a>
        ) : (
          error instanceof ApiError &&
          error.code === "RECORD_VERSION_CONFLICT" && (
            <Button disabled={busy} onClick={() => void reload()}>
              加载最新草稿
            </Button>
          )
        )}
      </Modal>
    </>
  );
}

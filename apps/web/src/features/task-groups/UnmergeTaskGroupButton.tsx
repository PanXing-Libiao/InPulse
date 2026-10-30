import React, { useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type InpulseApiClient } from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * F-24 解除合并（前端）：二次确认 + 解除原因（建议填写，契约允许为空）。
 * 写路径按 Route Registry 要求携带 CSRF 与 Idempotency-Key；409 时保留输入，
 * 提供「加载最新状态」重新核对后再提交（功能设计 §18.14 与 AGENTS.md §5/§6）。
 */

export interface UnmergeTaskGroupButtonProps {
  readonly groupId: number;
  readonly member: {
    readonly taskId: number;
    readonly taskCode: string;
    readonly title: string;
  };
  /** 当前是否为组内最后一个活跃分支（解除后聚合组将关闭）。 */
  readonly closesGroup: boolean;
  readonly api: InpulseApiClient;
  readonly onReload: () => Promise<void>;
  readonly onChanged: () => void;
}

export function UnmergeTaskGroupButton({
  groupId,
  member,
  closesGroup,
  api,
  onReload,
  onChanged,
}: UnmergeTaskGroupButtonProps) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const saving = useRef(false);

  async function reload() {
    setBusy(true);
    try {
      await onReload();
      setNeedsRefresh(false);
      setError(null);
      retry.current = null;
    } catch (reloadError) {
      setError(reloadError);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (saving.current || needsRefresh) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const trimmed = reason.trim();
      const body = {
        sourceTaskId: member.taskId,
        unmergeReason: trimmed.length === 0 ? null : trimmed,
      };
      const signature = JSON.stringify([groupId, body]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("task-group-unmerge"),
        };
      const csrf = await api.issueCsrfToken();
      await api.unmergeTaskGroup(body, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retry.current.key,
        },
      });
      // 解除合并会把来源分支放回有效任务，需同时失效任务、模块和概览查询。
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["task-group"] }),
        cache.invalidateQueries({ queryKey: ["task-group-records"] }),
        cache.invalidateQueries({ queryKey: ["tasks"] }),
        cache.invalidateQueries({ queryKey: ["task-board"] }),
        cache.invalidateQueries({ queryKey: ["my-tasks"] }),
        cache.invalidateQueries({ queryKey: ["modules"] }),
        cache.invalidateQueries({ queryKey: ["project-overview"] }),
      ]);
      setOpen(false);
      setReason("");
      retry.current = null;
      onChanged();
    } catch (submitError) {
      setError(submitError);
      if (submitError instanceof ApiError && submitError.status === 409)
        setNeedsRefresh(true);
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
          ? "当前账号没有解除合并的权限。"
          : error.status === 404
            ? "任务或聚合组不存在，或当前无法访问。"
            : error.status === 409
              ? "关系或任务状态已变化。请加载最新状态，核对后重新确认。"
              : error.status === 422
                ? "仅活跃分支可以解除合并；请检查所选任务。"
                : error.status === 429
                  ? "操作频繁，请稍后重试。"
                  : "暂时无法解除合并，输入已保留，可重试。"
      : "暂时无法解除合并，输入已保留，可重试。";

  return (
    <>
      <Button
        danger
        className="secondary-button"
        onClick={() => {
          setOpen(true);
          setError(null);
          setNeedsRefresh(false);
        }}
      >
        解除合并
      </Button>
      <Modal
        className="catalog-modal"
        eyebrow={member.taskCode + " · " + member.title}
        title="解除合并"
        tone="warning"
        icon="gitMerge"
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
              danger
              type="primary"
              loading={busy}
              disabled={needsRefresh}
              onClick={() => void submit()}
            >
              确认解除合并
            </Button>
          </>
        }
      >
        <p>
          {member.taskCode} {member.title} 将恢复为独立任务；工作状态、负责人、
          迭代记录与 GitHub 链接全部保留。合并关系标记为已解除，历史不会被删除。
        </p>
        {closesGroup ? (
          <Alert
            type="warning"
            title="这是组内最后一个活跃分支：解除后聚合组将关闭，主任务恢复独立。"
          />
        ) : null}
        <label htmlFor="task-group-unmerge-reason">解除原因（选填）</label>
        <Input.TextArea
          id="task-group-unmerge-reason"
          value={reason}
          maxLength={10000}
          disabled={busy}
          placeholder="例如：两个任务实际不重复，恢复并行推进。"
          onChange={(event) => setReason(event.target.value)}
        />
        {(error !== null || needsRefresh) && (
          <Alert
            type="error"
            title={
              error === null && needsRefresh
                ? "关系或任务状态已变化。请加载最新状态，核对后重新确认。"
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

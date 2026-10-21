import "./leftover-convert.css";
import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type PublishedRecord,
  type LeftoverTaskPreview,
  type LeftoverTaskRequest,
  type LeftoverTaskResponse,
} from "@generated/api";

/** 正式记录里的一条遗留问题：状态与跟进任务都按条目自身判定。 */
export type RecordLeftover = PublishedRecord["leftovers"][number];
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import { taskDetailPath } from "@features/tasks/task-links";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { CalmDateTimeInput } from "@features/common/components/CalmDateTimeInput";
import { priorityDotColor } from "@features/common/priority-select-option";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";
/** Match the task form's browser-local input and UTC API value, guarding invalid dates. */
export function parseFollowupDueAt(value: string): string | null | undefined {
  if (value === "") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) return undefined;
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== Number(parts[1]) ||
    date.getMonth() + 1 !== Number(parts[2]) ||
    date.getDate() !== Number(parts[3]) ||
    date.getHours() !== Number(parts[4]) ||
    date.getMinutes() !== Number(parts[5])
  )
    return undefined;
  return date.toISOString();
}
function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "LEFTOVER_TASK_DESCRIPTION_TOO_LONG")
      return "任务说明加上来源记录与遗留原文后超过 50000 字，请缩短说明。";
    if (error.status === 409)
      return "记录、遗留项或影响功能已变化，请刷新预览并确认后重试。";
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return "记录或任务不存在，或当前无法访问。";
    if (error.status === 403) return "请求未通过安全校验，请刷新后重试。";
    if (error.status === 422) return "请检查任务信息及负责人当前成员资格。";
    if (error.status === 429) return "操作过于频繁，请稍后使用相同请求重试。";
  }
  return "暂时无法转换，输入已保留，请重试。";
}
/**
 * 来源行（2026-09-30 版 1 排版）：记录、版本、稳定遗留项编号、遗留原文与继承的
 * 影响功能压成标题下一行灰字，不再占独立分区；原文过长时在行内滚动，不截断内容。
 * 继承影响仍按 F-20 口径展示，「影响集合确认」的语义不变；没有任何继承影响时
 * 只留「记录 · 版本 · 编号 · 原文」，不再多出一句「影响功能：无」（2026-09-30 与版 1 对照稿对齐）。
 */
function SourceLine({
  value,
  recordTitle,
}: {
  value: LeftoverTaskPreview;
  recordTitle?: string | undefined;
}) {
  const impacts = value.inheritedImpacts.map((f) => f.name).join("、");
  return (
    <div className="leftover-convert-source">
      <p>
        {`来自「${recordTitle === undefined ? "" : `${recordTitle} · `}v${value.recordVersion}」的遗留问题 #${value.leftoverItemId}`}
        <span className="leftover-convert-sep">·</span>
        <span className="leftover-convert-quote">
          {value.content || "当前版本没有遗留问题"}
        </span>
        {impacts === "" ? null : (
          <>
            <span className="leftover-convert-sep">·</span>
            影响功能：{impacts}
          </>
        )}
      </p>
      {value.linkedTask && (
        <a href={taskDetailPath(value.linkedTask)}>查看已有跟进任务</a>
      )}
    </div>
  );
}

/**
 * 遗留转换的目标记录：只依赖转换所需字段，供已发布记录页与遗留问题页共用，
 * 不再要求调用方传入完整 PublishedRecord（也避免跨页面复制记录实体）。
 */
export interface LeftoverConvertTarget {
  readonly projectId: number;
  readonly moduleId: number;
  readonly featureId: number | null;
  readonly recordId: number;
  readonly recordTitle: string;
  /** 目标遗留项：一条记录可以有多条遗留问题，预览与转换必须锁定其中一条。 */
  readonly leftoverItemId: number;
}

export interface LeftoverTaskConvertModalProps {
  readonly target: LeftoverConvertTarget;
  readonly api: InpulseApiClient;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConverted: (result: LeftoverTaskResponse) => void;
}

/**
 * 转换弹窗：预览、归属范围与冲突处理完全沿用原实现；打开时重新加载预览并
 * 重置输入。所有写请求仍携带 CSRF、If-Match 与幂等键。
 */
export function LeftoverTaskConvertModal({
  target,
  api,
  open,
  onClose,
  onConverted,
}: LeftoverTaskConvertModalProps) {
  const cache = useQueryClient(),
    saving = useRef(false),
    retry = useRef<{ signature: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<LeftoverTaskPreview | null>(null),
    [latest, setLatest] = useState<LeftoverTaskPreview | null>(null),
    [error, setError] = useState<unknown>(null),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [assigneeIds, setAssignees] = useState<number[]>([]),
    [dueInput, setDueInput] = useState(""),
    [dueBadInput, setDueBadInput] = useState(false),
    [priority, setPriority] =
      useState<LeftoverTaskRequest["priority"]>("NORMAL");
  const members = useQuery({
    queryKey: [
      "leftover-assignees",
      target.projectId,
      target.moduleId,
      target.featureId,
    ],
    queryFn: () =>
      target.featureId === null
        ? api.listModuleTaskAssignees(target.projectId, target.moduleId)
        : api.listTaskAssignees(
            target.projectId,
            target.moduleId,
            target.featureId,
          ),
    enabled: open,
    retry: false,
  });
  const [conflict, setConflict] = useState(false);
  const dueAt = parseFollowupDueAt(dueInput);
  const dueInvalid = dueBadInput || dueAt === undefined;
  async function load(initial: boolean) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const next = await api.previewLeftoverTask(
        target.projectId,
        target.recordId,
        { leftoverItemId: target.leftoverItemId },
      );
      if (initial) {
        setPreview(next);
        setError(null);
      } else setLatest(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }
  /**
   * 打开弹窗时重置输入并重新读取预览；关闭时保留输入，与转换前的行为一致。
   * 调用方在转换成功后关闭或卸载弹窗，由 onConverted 决定后续展示。
   */
  useEffect(() => {
    if (!open) return;
    setConflict(false);
    setPreview(null);
    setLatest(null);
    setError(null);
    setTitle((target.recordTitle + " · 遗留跟进").slice(0, 500));
    setAssignees([]);
    setDueInput("");
    setDueBadInput(false);
    setPriority("NORMAL");
    setDescription("");
    retry.current = null;
    void load(true);
  }, [open, target.recordId]);
  async function submit() {
    if (
      saving.current ||
      !preview ||
      preview.status !== "ACTIVE" ||
      !preview.content ||
      !title.trim() ||
      assigneeIds.length === 0 ||
      latest ||
      dueBadInput ||
      dueAt === undefined ||
      conflict
    )
      return;
    const note = description.trim(),
      body: LeftoverTaskRequest = {
        leftoverItemId: preview.leftoverItemId,
        recordVersion: preview.recordVersion,
        expectedRowVersion: preview.rowVersion,
        leftoverExpectedRowVersion: preview.leftoverRowVersion,
        expectedImpactFeatureIds: preview.inheritedImpacts.map((f) => f.id),
        title: title.trim(),
        assigneeIds,
        priority,
        dueAt,
        ...(note === "" ? {} : { description: note }),
      },
      signature = JSON.stringify(body);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: createIdempotencyKey("leftover-task") };
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const csrf = await api.issueCsrfToken(),
        created = await api.convertLeftoverToTask(
          target.projectId,
          target.recordId,
          body,
          {
            headers: {
              "x-csrf-token": csrf.csrfToken,
              "If-Match": `"${body.expectedRowVersion}"`,
              "Idempotency-Key": retry.current.key,
            },
          },
        );
      onConverted(created);
      for (const key of [
        "leftover-items",
        "published-record",
        "record-feed",
        "record-versions",
        "tasks",
        "task-history",
        "activity",
        "search",
        "notifications",
        "notifications-unread-count",
      ])
        void cache.invalidateQueries({ queryKey: [key] });
      // 转任务会把遗留项移出 OPEN 桶并新增一条属于我的待办，两个侧栏计数都变。
      void invalidateShellCounters(cache);
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.status === 409) setConflict(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      className="catalog-modal leftover-convert-modal"
      open={open}
      title="遗留问题转为新任务"
      onCancel={() => {
        if (!saving.current) onClose();
      }}
      mask={{ closable: !busy }}
      closable={!busy}
      footer={
        <Button
          type="primary"
          loading={busy}
          disabled={
            !preview ||
            !preview.content ||
            preview.status !== "ACTIVE" ||
            !title.trim() ||
            assigneeIds.length === 0 ||
            dueInvalid ||
            !!latest ||
            conflict ||
            members.isError
          }
          onClick={() => void submit()}
        >
          创建跟进任务
        </Button>
      }
    >
      <div className="catalog-form">
        <div className="leftover-convert-form">
          {error !== null && <Alert type="error" title={message(error)} />}
          {busy && !preview && (
            /* 占位按真来源行收成一条：compact 骨架是 82px，真来源行只有一行 21px，
               数据到达时弹层会整体缩一截、闪一下。 */
            <div className="leftover-convert-source">
              <p aria-hidden="true">
                <span className="calm-sk leftover-convert-source-sk" />
              </p>
              <span className="sr-only" role="status">
                正在转换遗留问题
              </span>
            </div>
          )}
          {preview && (
            <SourceLine value={preview} recordTitle={target.recordTitle} />
          )}
          {latest && (
            <section
              className="leftover-convert-latest"
              aria-label="最新转换预览"
            >
              <h3>请确认最新遗留内容与影响功能</h3>
              <SourceLine value={latest} recordTitle={target.recordTitle} />
              <Button
                disabled={busy}
                onClick={() => {
                  setPreview(latest);
                  setLatest(null);
                  setError(null);
                  setConflict(false);
                  retry.current = null;
                }}
              >
                确认使用最新预览
              </Button>
            </section>
          )}
          {conflict && !latest && (
            <Button disabled={busy} onClick={() => void load(false)}>
              刷新转换预览
            </Button>
          )}
          {!preview && !busy && error !== null && (
            <Button onClick={() => void load(true)}>重试加载预览</Button>
          )}
          <div className="leftover-convert-row">
            <label htmlFor="leftover-task-title">标题</label>
            <Input
              id="leftover-task-title"
              value={title}
              maxLength={500}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="leftover-convert-row">
            <label htmlFor="leftover-task-assignee">负责人</label>
            <CalmSelect
              id="leftover-task-assignee"
              ariaLabel="负责人"
              value={assigneeIds}
              disabled={busy}
              appearance="member"
              multiple
              maxTagCount={2}
              placeholder="选择成员"
              onChange={(next) => setAssignees(next.map(Number))}
              options={(members.data?.items ?? []).map((m) => ({
                value: m.id,
                label: m.name,
                avatarUrl: m.avatarUrl ?? null,
              }))}
              animated
            />
          </div>
          {members.isError && (
            <Alert
              type="error"
              title="成员列表加载失败"
              action={
                <Button onClick={() => void members.refetch()}>
                  重试成员列表
                </Button>
              }
            />
          )}
          <div className="leftover-convert-row leftover-convert-row--pair">
            <label htmlFor="leftover-task-priority">优先级</label>
            <CalmSelect
              id="leftover-task-priority"
              ariaLabel="优先级"
              value={priority}
              disabled={busy}
              appearance="menu"
              onChange={(next) =>
                setPriority(next as LeftoverTaskRequest["priority"])
              }
              options={[
                {
                  value: "NORMAL",
                  label: "普通",
                  dotColor: priorityDotColor("NORMAL"),
                },
                {
                  value: "HIGH",
                  label: "高",
                  dotColor: priorityDotColor("HIGH"),
                },
                {
                  value: "URGENT",
                  label: "紧急",
                  dotColor: priorityDotColor("URGENT"),
                },
              ]}
              animated
            />
            <label htmlFor="leftover-task-due">截止时间</label>
            <CalmDateTimeInput
              id="leftover-task-due"
              placeholder="选填"
              value={dueInput}
              disabled={busy}
              ariaInvalid={dueInvalid}
              ariaDescribedBy={
                dueInvalid ? "leftover-task-due-error" : undefined
              }
              onChange={setDueInput}
              onBadInput={setDueBadInput}
            />
          </div>
          {dueInvalid && (
            <p id="leftover-task-due-error" role="alert">
              请输入有效的截止时间，或清空以不设置。
            </p>
          )}
          <div className="leftover-convert-row leftover-convert-row--top">
            <label htmlFor="leftover-task-description">任务说明</label>
            <Input.TextArea
              id="leftover-task-description"
              value={description}
              maxLength={50000}
              rows={3}
              disabled={busy}
              placeholder="补充背景、复现步骤或验收标准（选填）"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 已发布记录页的单条遗留项入口：已转任务的行只在列表里展示链接，未转换的行
 * 提供「转为新任务」按钮，逻辑全部复用转换弹窗。
 */
export function ConvertLeftoverTask({
  item,
  leftover,
  api,
  writable,
  onConverted,
}: {
  item: PublishedRecord;
  leftover: RecordLeftover;
  api: InpulseApiClient;
  writable: boolean;
  onConverted?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (leftover.status !== "ACTIVE") return null;
  return (
    <>
      <Button disabled={!writable} onClick={() => setOpen(true)}>
        转为新任务
      </Button>
      <LeftoverTaskConvertModal
        target={{
          projectId: item.projectId,
          moduleId: item.moduleId,
          featureId: item.featureId,
          recordId: item.id,
          recordTitle: item.title,
          leftoverItemId: leftover.id,
        }}
        api={api}
        open={open}
        onClose={() => setOpen(false)}
        onConverted={() => {
          setOpen(false);
          onConverted?.();
        }}
      />
    </>
  );
}

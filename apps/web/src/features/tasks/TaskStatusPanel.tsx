import React, { useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type TaskStatusRequest,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { taskError, type TaskViewItem } from "./task-query";
import { CompleteWithRecord } from "./CompleteWithRecord";
import { TaskOriginCrumb } from "./task-origin";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { formatBeijingMinute } from "@features/common/beijing-time";

const labels = {
  COMPLETE: "完成任务",
  REOPEN: "重新打开",
  // ADR-096：取消任务已改为在“编辑任务”里确认后物理删除，CANCEL / RESTORE 已无调用点。
  CANCEL: "取消任务",
  RESTORE: "恢复任务",
};
const statuses = { TODO: "未完成", DONE: "已完成", CANCELED: "已取消" };
// ADR-096：CANCEL / RESTORE 已无调用点，保留分支只为兼容历史深链。
const requiredStatus = {
  COMPLETE: "TODO",
  REOPEN: "DONE",
  CANCEL: "TODO",
  RESTORE: "CANCELED",
};
const reasons = [
  "测试验证",
  "技术调研",
  "文档补充",
  "环境配置",
  "沟通协调",
  "其他",
] as const;
const time = (value: string) => formatBeijingMinute(value);

/**
 * C-3：任务状态操作弹窗（完成任务 / 重新打开）与状态历史。
 * ADR-096 起取消任务改为在「编辑任务」里二次确认后物理删除，不再经过本弹窗。
 * 与设计师稿 task-modal 一致，触发按钮由父级动作行渲染；本组件只保留弹窗、
 * 提交流程和「状态历史」区块。父级在每次打开时更换 key，输入、冲突状态与
 * 幂等重试键随重新挂载回到初始状态，取消后再次打开不会沿用上一次的内容。
 */
export function TaskStatusPanel({
  item,
  api,
  writable,
  action,
  onClose,
}: {
  item: TaskViewItem;
  api: InpulseApiClient;
  writable: boolean;
  action: TaskStatusRequest["action"] | null;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [base, setBase] = useState(item);
  const [publishedId, setPublishedId] = useState<number | null>(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [actualChange, setActualChange] = useState<"" | "yes" | "no">("");
  const [reason, setReason] = useState<(typeof reasons)[number]>("测试验证");
  const [note, setNote] = useState("");
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const formId = React.useId();
  const saving = useRef(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const history = useQuery({
    queryKey: ["task-history", item.projectId, item.id, item.rowVersion],
    queryFn: ({ signal }) =>
      item.featureId === null
        ? api.getModuleTaskStatusHistory(
            item.projectId,
            item.moduleId,
            item.id,
            { signal },
          )
        : api.getTaskStatusHistory(
            item.projectId,
            item.moduleId,
            item.featureId,
            item.id,
            { signal },
          ),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (command: TaskStatusRequest) => {
      const signature = JSON.stringify([base.id, base.rowVersion, command]);
      if (retry.current?.signature !== signature)
        retry.current = { signature, key: createIdempotencyKey("task-status") };
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retry.current.key,
          "If-Match": `"${base.rowVersion}"`,
        },
      };
      if (command.action === "COMPLETE") {
        const { action: _action, ...input } = command;
        return (
          await api.completeTask(
            base.id,
            { ...input, expectedRowVersion: base.rowVersion },
            init,
          )
        ).task;
      }
      return base.featureId === null
        ? api.transitionModuleTask(
            base.projectId,
            base.moduleId,
            base.id,
            command,
            init,
          )
        : api.transitionTask(
            base.projectId,
            base.moduleId,
            base.featureId,
            base.id,
            command,
            init,
          );
    },
    retry: false,
    onSuccess: async () => {
      retry.current = null;
      onClose();
      await Promise.all(
        // task-group / task-group-records：状态推进改变聚合组详情里的工作状态、
        // 已完成计数与记录可见性，同批失效才不用手动刷新（2026-09-22 修）。
        // modules / features / project-overview：已完成任务数驱动功能与模块卡的
        // 「进行中 / 未开始」档位，不失效会一直停留旧标签（2026-09-24 修）。
        // projects：重新打开或恢复任务会把维护中项目带回进行中（ADR-057），
        // 项目卡片与项目详情不失效会一直停留「维护中」。
        [
          "tasks",
          "task-board",
          "task-history",
          "modules",
          "features",
          "project-overview",
          "projects",
          "activity",
          "search",
          "notifications",
          "my-tasks",
          "my-task-groups",
          "task-marks",
          "task-group",
          "task-group-records",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
    },
  });
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const reload = async () => {
    setReloading(true);
    try {
      const latest =
        base.featureId === null
          ? await api.getModuleTask(base.projectId, base.moduleId, base.id)
          : await api.getTask(
              base.projectId,
              base.moduleId,
              base.featureId,
              base.id,
            );
      setBase(latest);
      setReloadError(null);
      mutation.reset();
    } catch (error) {
      setReloadError(taskError(error));
    } finally {
      setReloading(false);
    }
  };
  const invalidState =
    action !== null &&
    (base.lifecycleStatus !== "ACTIVE" ||
      requiredStatus[action] !== base.workStatus);
  const blocked =
    !writable ||
    mutation.isPending ||
    reloading ||
    conflict ||
    !!reloadError ||
    invalidState;
  const disabled = blocked || (action === "COMPLETE" && actualChange !== "no");
  // 设计稿 completion-flow 的三个步骤各有一个引导标题；弹层头部只保留来源面包屑，
  // 标题统一由正文承担，避免同一条文案在头部与正文各出现一次。
  const completionStepTitle =
    action !== "COMPLETE"
      ? null
      : actualChange === ""
        ? "本次工作是否产生了实际功能变化？"
        : actualChange === "yes"
          ? "记录这次变化"
          : labels.COMPLETE;
  // 设计稿 task-modal.tsx 的取消流程复用同一骨架：返回按钮 + `h2` 标题 + 任务副标题。
  const stepTitle =
    action === "COMPLETE"
      ? completionStepTitle
      : action
        ? labels[action]
        : null;
  // `actualChange !== ""` 表示已经离开选择步骤，返回按钮应沿流程回退而非关闭弹层。
  const inFlowSubStep = action === "COMPLETE" && actualChange !== "";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!action || disabled || saving.current) return;
    saving.current = true;
    try {
      await mutation.mutateAsync(
        action === "COMPLETE"
          ? {
              action,
              mode: "WITHOUT_RECORD",
              completionReason: reason,
              note: note.trim(),
            }
          : { action, reason: note.trim() || null },
      );
    } catch {
      /* Preserve the user's input and retry key. */
    } finally {
      saving.current = false;
    }
  };
  return (
    <section className="task-status-section" aria-label="任务状态历史">
      {publishedId !== null && (
        <p className="task-status-published">
          <a
            href={`/records?view=published&projectId=${item.projectId}&publishedId=${publishedId}`}
          >
            查看已发布记录
          </a>
        </p>
      )}
      <h3>状态历史</h3>
      {history.isPending ? (
        <CalmSkeleton
          variant="timeline"
          rows={3}
          compact
          label="正在加载状态历史"
        />
      ) : history.isError ? (
        <Alert
          type="error"
          title={taskError(history.error)}
          action={
            <Button onClick={() => void history.refetch()}>重试状态历史</Button>
          }
        />
      ) : (
        <ol className="task-status-history">
          {history.data.items.map((entry) => (
            <li key={entry.id}>
              <strong>
                {entry.fromWorkStatus === null
                  ? "创建"
                  : statuses[entry.fromWorkStatus]}{" "}
                → {statuses[entry.toWorkStatus]}
              </strong>
              <p>
                {time(entry.changedAt)} · 操作人 {entry.changedByName}
              </p>
              {entry.completedAtSnapshot && (
                <p>完成时间快照：{time(entry.completedAtSnapshot)}</p>
              )}
              {entry.completionNoteSnapshot && (
                <p>完成说明：{entry.completionNoteSnapshot}</p>
              )}
              {entry.reason && <p>原因：{entry.reason}</p>}
            </li>
          ))}
        </ol>
      )}
      <Modal
        className="catalog-modal"
        size="xl"
        open={action !== null}
        eyebrow={
          <TaskOriginCrumb
            projectId={item.projectId}
            moduleId={item.moduleId}
            featureId={item.featureId}
            client={api}
          />
        }
        label={action ? labels[action] : "任务状态"}
        onCancel={() => {
          if (!saving.current && !reloading && !recordBusy) onClose();
        }}
        mask={{ closable: !mutation.isPending && !reloading && !recordBusy }}
        footer={
          action === "COMPLETE" && actualChange !== "no" ? undefined : (
            <Button
              htmlType="submit"
              form={formId}
              className="primary-button"
              loading={mutation.isPending}
              disabled={disabled}
            >
              确认{action ? labels[action] : "操作"}
            </Button>
          )
        }
      >
        <form
          id={formId}
          className="catalog-form calm-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="completion-flow">
            {mutation.isError && (
              <Alert type="error" title={taskError(mutation.error)} />
            )}
            {reloadError && <Alert type="warning" title={reloadError} />}
            {conflict && (
              <Button loading={reloading} onClick={() => void reload()}>
                加载最新任务状态
              </Button>
            )}
            {invalidState && (
              <Alert
                type="warning"
                title={`最新状态为${statuses[base.workStatus]}，无法继续此操作。说明已保留。`}
              />
            )}
            <button
              type="button"
              className="back-button"
              onClick={() => {
                if (saving.current || reloading || recordBusy) return;
                if (inFlowSubStep) setActualChange("");
                else onClose();
              }}
            >
              <InpulseIcon name="arrowLeft" size={15} />
              {inFlowSubStep ? "上一步" : "返回任务"}
            </button>
            {stepTitle === null ? null : (
              <h2 className="completion-step-title">{stepTitle}</h2>
            )}
            <p className="calm-subtitle">
              {item.code} · {item.title}
            </p>
            <div className="dialog-form">
              {action === "COMPLETE" && actualChange === "" && (
                <div className="completion-choices">
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => setActualChange("yes")}
                  >
                    <InpulseIcon name="gitBranch" size={22} />
                    <strong>有，填写迭代记录</strong>
                    <span>记录变化后发布，任务同时标记为已完成</span>
                    <InpulseIcon name="chevronRight" size={17} />
                  </button>
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => setActualChange("no")}
                  >
                    <InpulseIcon name="check" size={22} />
                    <strong>没有，仅完成任务</strong>
                    <span>测试、调研、文档等不改变功能的工作</span>
                    <InpulseIcon name="chevronRight" size={17} />
                  </button>
                </div>
              )}
              {action === "COMPLETE" && actualChange === "yes" && (
                <CompleteWithRecord
                  item={base}
                  api={api}
                  writable={writable}
                  onBusyChange={setRecordBusy}
                  onSuccess={(record) => {
                    setPublishedId(record.id);
                    onClose();
                  }}
                />
              )}
              {action === "COMPLETE" && actualChange === "no" && (
                <>
                  <label>
                    完成原因
                    <CalmSelect
                      ariaLabel="完成原因"
                      value={reason}
                      appearance="menu"
                      onChange={(next) => setReason(next as typeof reason)}
                      options={reasons.map((value) => ({
                        value,
                        label: value,
                      }))}
                      animated
                    />
                  </label>
                  <p className="permission-hint">
                    该任务不会生成迭代记录，但会保留完成说明、完成时间与全部状态历史。
                  </p>
                </>
              )}
              {actualChange !== "yes" && (
                <label>
                  {action === "COMPLETE" ? "完成补充说明" : "操作原因（选填）"}
                  <Input.TextArea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={action === "COMPLETE" ? 9800 : 10000}
                    rows={3}
                  />
                </label>
              )}
            </div>
          </div>
        </form>
      </Modal>
    </section>
  );
}

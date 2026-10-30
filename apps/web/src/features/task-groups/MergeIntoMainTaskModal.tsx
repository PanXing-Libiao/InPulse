import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type SearchItem,
} from "@generated/api";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { SEARCH_MIN_LENGTH } from "@features/search/search-query";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/**
 * F-23 合并到主任务（前端弹窗）。主任务候选来自全局搜索的 TASK 结果
 * （与全局搜索共用 F-26 的下限常量），客户端只做同项目过滤与自身排除；
 * 跨项目、已在组内、状态冲突等业务规则由服务端合并命令校验（409/422）。
 * 提交按 Route Registry 携带 CSRF 与 Idempotency-Key；成功后回传 groupId
 * 供调用方提供「查看聚合组」入口（合并响应 TaskGroupItem.id）。
 */

export interface MergeIntoMainTaskModalProps {
  readonly open: boolean;
  readonly task: {
    readonly id: number;
    readonly code: string;
    readonly title: string;
    readonly projectId: number;
  };
  readonly api: InpulseApiClient;
  readonly onClose: () => void;
  readonly onMerged: (groupId: number) => void;
}

const NO_MATCH_TEXT = "当前项目内没有匹配的任务。";

export function MergeIntoMainTaskModal({
  open,
  task,
  api,
  onClose,
  onMerged,
}: MergeIntoMainTaskModalProps) {
  const cache = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [mainTask, setMainTask] = useState<SearchItem | null>(null);
  const [sourceKind, setSourceKind] = useState<"ACTIVE" | "HISTORICAL">(
    "ACTIVE",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    const value = keyword.trim();
    if (value.length < SEARCH_MIN_LENGTH) {
      setSearchTerm("");
      return;
    }
    const timer = window.setTimeout(() => setSearchTerm(value), 350);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setSearchTerm("");
    setMainTask(null);
    setSourceKind("ACTIVE");
    setNote("");
    setError(null);
    setFormError(null);
    setNeedsRefresh(false);
    retry.current = null;
  }, [open]);

  const searchQuery = useQuery({
    queryKey: ["task-merge-candidates", searchTerm],
    queryFn: () => api.getSearch({ q: searchTerm, limit: 20 }),
    enabled: open && searchTerm.length >= SEARCH_MIN_LENGTH,
    retry: false,
  });

  const candidates =
    searchQuery.data?.items.filter(
      (item) =>
        item.entityType === "TASK" &&
        item.projectId === task.projectId &&
        item.entityId !== task.id,
    ) ?? [];

  // 选中项必须留在 options 里：远端结果换一批后若它不在其中，
  // CalmSelect 查不到 label，触发器会退化成裸 id。
  const candidateItems =
    mainTask !== null &&
    !candidates.some((item) => item.entityId === mainTask.entityId)
      ? [mainTask, ...candidates]
      : candidates;

  const searchFailed = searchQuery.isError;
  // 关键词已达最小长度但防抖尚未落地（searchTerm 还是空）也按「检索中」处理：
  // 否则这 350ms 会先显示「没有匹配」，像是搜过且确实无结果。
  const searching =
    keyword.trim().length >= SEARCH_MIN_LENGTH &&
    (searchTerm.length < SEARCH_MIN_LENGTH || searchQuery.isFetching);
  // 下限为 1 时不再回显「至少 1 个字符」，只有下限大于 1 才需要把门槛写进提示。
  const minLengthHint =
    SEARCH_MIN_LENGTH > 1 ? `（至少 ${SEARCH_MIN_LENGTH} 个字符）` : "";
  // 弹层空态：搜索不可用、检索中、未达最小长度、确实无匹配。
  const notFoundText = searchFailed
    ? "搜索暂时不可用，请稍后重试。"
    : searching
      ? "正在搜索任务…"
      : keyword.trim().length < SEARCH_MIN_LENGTH
        ? `输入任务编号或标题${minLengthHint}，仅搜索当前项目。`
        : NO_MATCH_TEXT;
  // 已选主任务会保留在 options 里（触发器要显示标题），所以远端无匹配时弹层非空、
  // notFoundContent 不会渲染；此时在下方补同一句无匹配提示，免得像「命中」了。
  const showNoMatchHint =
    mainTask !== null &&
    !searchFailed &&
    !searching &&
    keyword.trim().length >= SEARCH_MIN_LENGTH &&
    candidates.length === 0;

  async function rescan() {
    setBusy(true);
    try {
      setMainTask(null);
      setNeedsRefresh(false);
      setError(null);
      retry.current = null;
      await searchQuery.refetch();
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (saving.current || needsRefresh) return;
    if (mainTask === null) {
      setFormError("请先搜索并选择主任务。");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    setFormError(null);
    try {
      const trimmed = note.trim();
      const body = {
        sourceTaskId: task.id,
        mainTaskId: mainTask.entityId,
        sourceKind,
        mergeNote: trimmed.length === 0 ? null : trimmed,
      };
      const signature = JSON.stringify([task.projectId, body]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("task-group-merge"),
        };
      const csrf = await api.issueCsrfToken();
      const result = await api.mergeTaskGroup(body, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retry.current.key,
        },
      });
      // 来源任务并入活跃聚合组后会改变模块卡与项目概览的有效任务统计，
      // 需同时失效任务、模块和概览查询。
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["tasks"] }),
        cache.invalidateQueries({ queryKey: ["task-board"] }),
        cache.invalidateQueries({ queryKey: ["my-tasks"] }),
        cache.invalidateQueries({ queryKey: ["modules"] }),
        cache.invalidateQueries({ queryKey: ["project-overview"] }),
        cache.invalidateQueries({ queryKey: ["task-group"] }),
        cache.invalidateQueries({ queryKey: ["task-group-records"] }),
      ]);
      retry.current = null;
      onMerged(result.id);
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
          ? "当前账号没有执行合并的权限。"
          : error.status === 404
            ? "任务不存在，或当前无法访问（跨项目任务不能直接合并）。"
            : error.status === 409
              ? "分支任务已属于其他聚合组，或任务状态已变化。请重新选择主任务后再试。"
              : error.status === 422
                ? "请求未被接受：不能把任务合并到自己，或字段不合法。"
                : error.status === 429
                  ? "操作频繁，请稍后重试。"
                  : "暂时无法合并，输入已保留，可重试。"
      : "暂时无法合并，输入已保留，可重试。";

  return (
    <Modal
      className="catalog-modal"
      title="合并到主任务"
      open={open}
      body
      onCancel={() => {
        if (!busy) onClose();
      }}
      closable={!busy}
      mask={{ closable: !busy }}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={needsRefresh}
            onClick={() => void submit()}
          >
            确认合并
          </Button>
        </>
      }
    >
      {/* 2026-09-28 产品反馈：正文太啰嗦、当前任务不醒目，改为聚焦卡片 + 短标签
          （原先的散文句与弹层眉标重复了同一段「编号 + 标题」）。 */}
      <div className="merge-source-task">
        <div className="merge-source-task-head">
          <span className="merge-source-task-label">当前任务</span>
          <span className="merge-source-task-code">{task.code}</span>
        </div>
        <p className="merge-source-task-title">{task.title}</p>
      </div>
      <label htmlFor="merge-main-search">主任务</label>
      {/* 2026-09-28 产品反馈：候选区从「输入框 + 结果列表」改成可搜索下拉；检索仍在
          服务端（F-26 最小长度 2），所以关闭本地过滤，选项就是远端返回的候选。 */}
      <CalmSelect
        id="merge-main-search"
        ariaLabel="主任务"
        appearance="rich"
        searchable
        width="100%"
        value={mainTask?.entityId ?? null}
        disabled={busy}
        loading={searching}
        notFoundContent={
          <span className="merge-select-empty">{notFoundText}</span>
        }
        placeholder="例如：T-101 或 修复重复退款"
        onSearch={(next) => {
          setKeyword(next);
          setFormError(null);
        }}
        onChange={(next) => {
          setMainTask(
            candidateItems.find(
              (item) => String(item.entityId) === String(next),
            ) ?? null,
          );
          setFormError(null);
        }}
        options={candidateItems.map((item) => ({
          value: item.entityId,
          label: item.title,
          description: item.summary === "" ? "任务" : item.summary,
        }))}
        animated
      />
      {searchFailed ? (
        <Alert
          type="error"
          title="搜索暂时不可用，请稍后重试。"
          action={
            <Button disabled={busy} onClick={() => void searchQuery.refetch()}>
              重试搜索
            </Button>
          }
        />
      ) : null}
      {showNoMatchHint ? (
        <p className="merge-select-empty merge-select-empty-inline">
          {NO_MATCH_TEXT}
        </p>
      ) : null}
      <fieldset className="merge-branch-choice">
        <legend>合并后处理方式</legend>
        <label>
          <input
            type="radio"
            name="merge-source-kind"
            checked={sourceKind === "ACTIVE"}
            disabled={busy}
            onChange={() => setSourceKind("ACTIVE")}
          />
          活动分支（合并后仍继续推进）
        </label>
        <label>
          <input
            type="radio"
            name="merge-source-kind"
            checked={sourceKind === "HISTORICAL"}
            disabled={busy}
            onChange={() => setSourceKind("HISTORICAL")}
          />
          历史分支（仅保留历史，不再推进）
        </label>
      </fieldset>
      <label htmlFor="merge-note">合并说明（选填）</label>
      <Input.TextArea
        id="merge-note"
        value={note}
        maxLength={5000}
        disabled={busy}
        placeholder="例如：两个任务均处理退款重复回调问题。"
        onChange={(event) => setNote(event.target.value)}
      />
      {formError !== null ? <Alert type="warning" title={formError} /> : null}
      {(error !== null || needsRefresh) && (
        <Alert
          type="error"
          title={
            error === null && needsRefresh
              ? "分支任务已属于其他聚合组，或任务状态已变化。请重新选择主任务后再试。"
              : errorText
          }
          action={
            needsRefresh ? (
              <Button disabled={busy} onClick={() => void rescan()}>
                重新搜索
              </Button>
            ) : undefined
          }
        />
      )}
    </Modal>
  );
}

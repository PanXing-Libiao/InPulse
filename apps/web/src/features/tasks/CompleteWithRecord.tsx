import React, { useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useRecordDraftsQuery } from "@features/record-drafts/record-drafts-query";
import { TaskLinksPicker } from "@features/external-links/TaskLinksPicker";
import type { TaskLinksSelection } from "@features/external-links/TaskLinksPicker";
import { associateLinks } from "@features/external-links/associate-links";
import {
  ApiError,
  type InpulseApiClient,
  type RecordDraftItem,
  type RecordDraftContent,
  type TaskCompletionRequest,
  type PublishedRecord,
} from "@generated/api";
import {
  fieldText,
  fields,
  labels,
} from "@features/record-drafts/record-content";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { LeftoverEntriesField } from "@features/common/components/LeftoverEntriesField";
import { RecordMarkdown } from "@features/common/components/RecordMarkdown";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
import type { TaskViewItem } from "./task-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
export function CompleteWithRecord({
  item,
  api,
  writable,
  onSuccess,
  onBusyChange,
}: {
  item: TaskViewItem;
  api: InpulseApiClient;
  writable: boolean;
  onSuccess: (record: PublishedRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const cache = useQueryClient(),
    [base, setBase] = useState(item),
    [mode, setMode] = useState<"inline" | "draft">("inline"),
    [selected, setSelected] = useState<RecordDraftItem | null>(null),
    [latest, setLatest] = useState<RecordDraftItem | null>(null),
    [content, setContent] = useState<RecordDraftContent>({
      title: item.title,
      contextProblem: "",
      changeSolution: "",
      resultVerification: "",
      remainingIssues: [],
    }),
    [error, setError] = useState<unknown>(null),
    [busy, setBusyState] = useState(false);
  // 任务上已有的链接由 TaskLinksPicker 默认全选；勾选结果与自己添加的链接一起上报到
  // selectedLinks，发布成功后逐条关联到新记录。
  const [selectedLinks, setSelectedLinks] = useState<string[]>([]);
  // 其中「自己添加」的那几条：任务上原本没有，发布成功后除记录外还要存进项目链接库
  // 并关联到来源任务，否则只有这条记录看得到它们（2026-10-09 用户指示）。
  const [addedLinks, setAddedLinks] = useState<string[]>([]);
  const [attachIssue, setAttachIssue] = useState<{
    record: PublishedRecord;
    urls: string[];
    taskUrls: string[];
  } | null>(null);
  const handleLinksChange = (selection: TaskLinksSelection) => {
    setSelectedLinks(selection.urls);
    setAddedLinks(selection.addedUrls);
  };
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusyChange?.(value);
  };
  const retry = useRef<{ signature: string; key: string } | null>(null),
    saving = useRef(false);

  const drafts = useRecordDraftsQuery({
    client: api,
    projectId: item.projectId,
    enabled: mode === "draft",
  });
  const draftItems =
    drafts.data?.pages.flatMap((page) => [...page.items]) ?? [];
  const choices = draftItems.filter(
    (record) =>
      record.moduleId === item.moduleId &&
      (record.taskId === null || record.taskId === item.id),
  );
  const conflict = error instanceof ApiError && error.status === 409;
  // 没能贴上的链接按去重后的并集提示：同一条可能在记录与任务两侧都失败。
  const pendingUrls =
    attachIssue === null
      ? []
      : Array.from(new Set([...attachIssue.urls, ...attachIssue.taskUrls]));
  const textFields = fields.filter((field) => field !== "remainingIssues");
  const textReady = textFields.every((field) =>
    field === "title"
      ? content.title.trim().length > 0 && content.title.length <= 500
      : content[field].trim().length > 0 && content[field].length <= 50000,
  );
  const leftoversReady =
    content.remainingIssues.length <= 50 &&
    content.remainingIssues.every(
      (entry) =>
        entry.content.trim().length > 0 && entry.content.length <= 10000,
    );
  const disabled =
    !writable ||
    busy ||
    conflict ||
    // 记录已发布只是链接没贴上：此时只能重试关联或查看记录，不能再提交一次。
    attachIssue !== null ||
    base.workStatus !== "TODO" ||
    base.lifecycleStatus !== "ACTIVE" ||
    (mode === "draft" ? !selected : !textReady || !leftoversReady);
  async function reload() {
    setBusy(true);
    try {
      const task = await api.getModuleTask(
        base.projectId,
        base.moduleId,
        base.id,
      );
      setBase(task);
      if (selected) {
        const record = await api.getRecordDraft(base.projectId, selected.id);
        setLatest(record);
      } else setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  /** 记录发布后的收尾：写入缓存、失效相关列表并关闭弹窗。 */
  async function finish(record: PublishedRecord) {
    setAttachIssue(null);
    cache.setQueryData(["published-record", base.projectId, record.id], record);
    await Promise.all(
      // task-group / task-group-records：完成并发布记录会同时改变聚合组详情
      // 的分支状态与「已发布记录」计数，以及组内记录列表（2026-09-22 修）。
      // modules / project-overview：完成会改变模块卡的任务统计，
      // 不失效会停留旧数据（2026-09-24 修）。
      [
        "tasks",
        "task-board",
        "task-history",
        "modules",
        "project-overview",
        "record-drafts",
        "task-record-drafts",
        "record-feed",
        "activity",
        "search",
        "notifications",
        "my-tasks",
        "my-task-groups",
        "task-marks",
        "task-group",
        "task-group-records",
        // 自己添加的链接发布后会关联到任务，任务链接面板要换掉旧清单（2026-10-09）。
        "task-external-links",
      ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
    );
    onSuccess(record);
  }
  /**
   * 把选中的链接逐条关联到刚落库的记录上：链接是独立资源，服务端不搬运它们，
   * 与草稿编辑器同一做法（先取记录当前版本，逐条 If-Match，409「已关联」视为成功）。
   * 任一失败都不回滚已完成的任务与记录，而是返回失败清单交给重试入口；
   * 其中自己添加的几条另由 attachAddedLinks 关联到来源任务。
   */
  async function attachLinks(
    record: PublishedRecord,
    urls: readonly string[],
  ): Promise<{ failed: string[]; rowVersion: number }> {
    let rowVersion: number, csrfToken: string;
    try {
      rowVersion = (await api.listExternalLinks("CHANGE_RECORD", record.id))
        .rowVersion;
      csrfToken = (await api.issueCsrfToken()).csrfToken;
    } catch {
      return { failed: [...urls], rowVersion: record.rowVersion };
    }
    const failed: string[] = [];
    for (const url of urls) {
      try {
        const added = await api.addExternalLink(
          "CHANGE_RECORD",
          record.id,
          { url },
          {
            headers: {
              "x-csrf-token": csrfToken,
              "If-Match": `"${rowVersion}"`,
              "Idempotency-Key": createIdempotencyKey("external-link"),
            },
          },
        );
        rowVersion = added.rowVersion;
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.code === "EXTERNAL_LINK_ALREADY_ASSOCIATED"
        )
          continue;
        failed.push(url);
      }
    }
    return { failed, rowVersion };
  }
  /**
   * 自己添加的链接在发布成功后补进项目链接库，并跟着关联到来源任务（任务详情
   * 的「GitHub 链接」面板里能看到）；失败只回清单，不回滚已发布的任务与记录。
   */
  async function attachAddedLinks(
    taskId: number,
    urls: readonly string[],
  ): Promise<string[]> {
    if (urls.length === 0) return [];
    let csrfToken: string;
    try {
      csrfToken = (await api.issueCsrfToken()).csrfToken;
    } catch {
      return [...urls];
    }
    const failures = await associateLinks(api, "TASK", taskId, urls, csrfToken);
    return failures.map((failure) => failure.url);
  }
  /** 记录已发布但链接没贴全时的重试：只重试失败的那几条（记录与任务各一份）。 */
  async function retryAttach() {
    if (attachIssue === null || busy) return;
    setBusy(true);
    try {
      const { failed, rowVersion } = await attachLinks(
        attachIssue.record,
        attachIssue.urls,
      );
      const record = { ...attachIssue.record, rowVersion };
      const taskFailed = await attachAddedLinks(base.id, attachIssue.taskUrls);
      if (failed.length > 0 || taskFailed.length > 0)
        setAttachIssue({ record, urls: failed, taskUrls: taskFailed });
      else await finish(record);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (disabled || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: TaskCompletionRequest =
        mode === "draft"
          ? {
              mode: "WITH_RECORD",
              expectedRowVersion: base.rowVersion,
              recordDraftId: selected!.id,
              recordExpectedRowVersion: selected!.rowVersion,
            }
          : {
              mode: "WITH_RECORD",
              expectedRowVersion: base.rowVersion,
              record: {
                title: content.title.trim(),
                contextProblem: content.contextProblem.trim(),
                changeSolution: content.changeSolution.trim(),
                resultVerification: content.resultVerification.trim(),
                remainingIssues: content.remainingIssues.map((entry) => ({
                  content: entry.content.trim(),
                })),
              },
            };
      const signature = JSON.stringify([base.id, body]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("task-completion"),
        };
      const csrf = await api.issueCsrfToken();
      const result = await api.completeTask(base.id, body, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "If-Match": `"${base.rowVersion}"`,
          "Idempotency-Key": retry.current.key,
        },
      });
      if (result.record) {
        const urls = selectedLinks;
        if (urls.length === 0) await finish(result.record);
        else {
          const { failed, rowVersion } = await attachLinks(result.record, urls);
          const record = { ...result.record, rowVersion };
          const taskFailed = await attachAddedLinks(base.id, addedLinks);
          if (failed.length > 0 || taskFailed.length > 0)
            setAttachIssue({ record, urls: failed, taskUrls: taskFailed });
          else await finish(record);
        }
      }
      // 完成任务会减少我的未完成数；带记录时正文里的剩余问题同时变成待处理遗留项。
      await invalidateShellCounters(cache);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }
  return (
    <section aria-label="发布并完成">
      <p>任务完成与记录发布会一起保存；任何一步失败均保留原状态。</p>
      <a
        href={`/records?projectId=${base.projectId}&moduleId=${base.moduleId}&taskId=${base.id}`}
      >
        选择或新建草稿
      </a>
      <label>
        记录来源
        <CalmSelect
          ariaLabel="记录来源"
          value={mode}
          disabled={busy}
          appearance="menu"
          onChange={(next) => {
            setMode(next as typeof mode);
            setError(null);
            setLatest(null);
          }}
          options={[
            { value: "inline", label: "填写新记录" },
            { value: "draft", label: "选择已有草稿" },
          ]}
          animated
        />
      </label>
      {!!error && (
        <Alert
          type="error"
          title={
            error instanceof ApiError
              ? `${error.message} 输入和选择已保留。`
              : "服务暂时不可用，输入和选择已保留，可重试。"
          }
        />
      )}
      {conflict && (
        <Button disabled={busy} onClick={() => void reload()}>
          加载最新任务和草稿
        </Button>
      )}
      {base.workStatus !== "TODO" && (
        <Alert
          type="warning"
          title="任务已不再是待办状态，不能再次完成；输入已保留。"
        />
      )}
      {latest && (
        <section aria-label="最新草稿预览">
          <h4>
            最新草稿：{latest.title}（版本 {latest.rowVersion}）
          </h4>
          {fields
            .filter((field) => field !== "title")
            .map((field) => (
              <div className="record-field" key={field}>
                <span className="record-field-label">{labels[field]}</span>
                <RecordMarkdown
                  content={fieldText(latest, field) || "（空）"}
                />
              </div>
            ))}
          <Button
            disabled={busy}
            onClick={() => {
              setSelected(latest);
              setLatest(null);
              setError(null);
            }}
          >
            确认使用最新草稿
          </Button>
        </section>
      )}
      {mode === "inline" ? (
        <>
          {textFields.map((field) => (
            <label key={field}>
              {labels[field]}
              {field === "title" ? (
                <Input
                  disabled={busy}
                  aria-label={labels[field]}
                  value={content[field]}
                  maxLength={500}
                  onChange={(e) =>
                    setContent({ ...content, [field]: e.target.value })
                  }
                />
              ) : (
                <Input.TextArea
                  disabled={busy}
                  aria-label={labels[field]}
                  rows={3}
                  value={content[field]}
                  maxLength={50000}
                  onChange={(e) =>
                    setContent({ ...content, [field]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          <label>
            <LeftoverEntriesField
              value={content.remainingIssues}
              onChange={(remainingIssues) =>
                setContent({ ...content, remainingIssues })
              }
              disabled={busy}
              label={labels.remainingIssues}
            />
          </label>
        </>
      ) : (
        <>
          {drafts.isPending ? (
            <CalmSkeleton
              variant="list"
              rows={2}
              compact
              label="正在加载草稿"
            />
          ) : drafts.isError ? (
            <Alert
              type="error"
              title="暂时无法读取草稿"
              action={
                <Button onClick={() => void drafts.refetch()}>重试草稿</Button>
              }
            />
          ) : (
            <label>
              待发布草稿
              <CalmSelect
                ariaLabel="待发布草稿"
                value={selected?.id ?? ""}
                disabled={busy}
                appearance="menu"
                onChange={(next) => {
                  setSelected(
                    choices.find((record) => record.id === Number(next)) ??
                      null,
                  );
                  setLatest(null);
                }}
                options={[
                  { value: "", label: "请选择一条草稿" },
                  ...choices.map((record) => ({
                    value: record.id,
                    label:
                      record.title +
                      " · 草稿 #" +
                      record.id +
                      " · 版本 " +
                      record.rowVersion,
                  })),
                ]}
                animated
              />
              {drafts.hasNextPage && (
                <div className="record-load-more">
                  <Button
                    disabled={drafts.isFetchingNextPage}
                    onClick={() => void drafts.fetchNextPage()}
                  >
                    {drafts.isFetchingNextPage ? "正在加载…" : "加载更多"}
                  </Button>
                </div>
              )}
            </label>
          )}
          {selected && (
            <section aria-label="所选草稿内容">
              {fields.map((field) => (
                <div className="record-field" key={field}>
                  <span className="record-field-label">{labels[field]}</span>
                  <RecordMarkdown
                    content={fieldText(selected, field) || "（空）"}
                  />
                </div>
              ))}
              <a
                href={`/records?projectId=${base.projectId}&recordId=${selected.id}${selected.taskId === null ? "" : `&moduleId=${base.moduleId}&taskId=${base.id}`}`}
              >
                打开草稿继续编辑
              </a>
            </section>
          )}
        </>
      )}
      {attachIssue === null ? (
        <TaskLinksPicker
          api={api}
          taskId={base.id}
          disabled={busy}
          inputId="completion-github-link-input"
          hint="任务上已有的链接默认带上，展开后可以取消勾选；自己添加的链接发布后会存进项目链接库并关联到这条任务。"
          onSelectionChange={handleLinksChange}
        />
      ) : (
        <section
          aria-label="链接关联未完成"
          className="completion-links-recovery"
        >
          <Alert
            type="warning"
            title={`记录 ${attachIssue.record.code} 已发布，下列链接尚未关联：${pendingUrls.join("、")}。可以重试，或先查看记录稍后在记录详情页 / 任务链接面板补充。`}
          />
          <div className="completion-links-recovery-actions">
            <Button disabled={busy} onClick={() => void retryAttach()}>
              重试关联
            </Button>
            <Button
              type="primary"
              disabled={busy}
              onClick={() => void finish(attachIssue.record)}
            >
              先查看记录
            </Button>
          </div>
        </section>
      )}
      <p>遗留问题最多10000字符，完整正文超出发布容量时保留输入并提示调整。</p>
      <div className="completion-flow-submit-bar">
        <Button
          type="primary"
          loading={busy}
          disabled={disabled}
          onClick={() => void submit()}
        >
          发布并完成任务
        </Button>
      </div>
    </section>
  );
}

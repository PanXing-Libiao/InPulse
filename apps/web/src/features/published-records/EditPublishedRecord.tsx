import React, { useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type InpulseApiClient,
  type PublishedRecord,
  type RecordDraftContent,
} from "@generated/api";
import {
  fieldText,
  fields,
  labels,
  mergeRecordDraft,
  recordContent,
  type Field,
} from "@features/record-drafts/record-content";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { LeftoverEntriesField } from "@features/common/components/LeftoverEntriesField";
import { RecordMarkdown } from "@features/common/components/RecordMarkdown";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import { invalidateShellCounters } from "@shared/api/shell-counters";
type Merge = ReturnType<typeof mergeRecordDraft> & {
  latest: PublishedRecord;
  choices: Partial<Record<Field, "mine" | "latest">>;
};
export function EditPublishedRecord({
  item,
  api,
  writable,
}: {
  item: PublishedRecord;
  api: InpulseApiClient;
  writable: boolean;
}) {
  const cache = useQueryClient();
  const [baseline, setBaseline] = useState<PublishedRecord | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [confirmed, setConfirmed] = useState(false),
    [merge, setMerge] = useState<Merge | null>(null);
  const formId = React.useId();
  const retry = useRef<{ signature: string; key: string } | null>(null),
    saving = useRef(false);
  const {
    control,
    handleSubmit,
    reset,
    getValues,
    formState: { errors },
  } = useForm<RecordDraftContent>({ defaultValues: recordContent(item) });
  const remaining = useWatch({ control, name: "remainingIssues" }) ?? [];
  const submittedIds = new Set(
    remaining.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])),
  );
  // 移除（或清空）当前版本里未处理的遗留项会被标记为已处理，必须显式确认。
  const removedActive = (baseline ?? item).leftovers.filter(
    (leftover) =>
      leftover.status === "ACTIVE" && !submittedIds.has(leftover.id),
  );
  const needsConfirmation = removedActive.length > 0;
  const convertedIds = item.leftovers
    .filter((leftover) => leftover.status === "CONVERTED")
    .map((leftover) => leftover.id);
  const conflict = error instanceof ApiError && error.status === 409;
  function open() {
    setBaseline(item);
    reset(recordContent(item));
    setConfirmed(false);
    setMerge(null);
    setError(null);
  }
  async function reload() {
    if (!baseline) return;
    setBusy(true);
    try {
      const latest = await api.getChangeRecord(item.projectId, item.id);
      if (latest.status !== "PUBLISHED")
        throw new ApiError(409, {
          code: "RECORD_STATE_CONFLICT",
          message: "记录已作废，请关闭编辑并刷新",
          details: {},
          requestId: "",
        });
      const result = mergeRecordDraft(
        recordContent(baseline),
        getValues(),
        recordContent(latest),
      );
      setConfirmed(false);
      if (result.conflicts.length) setMerge({ ...result, latest, choices: {} });
      else {
        setBaseline(latest);
        reset(result.values);
        setError(null);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function apply() {
    if (!merge || merge.conflicts.some((f) => !merge.choices[f])) return;
    const values = { ...merge.values };
    for (const field of merge.conflicts)
      if (merge.choices[field] === "latest")
        (values as Record<Field, unknown>)[field] = merge.latest[field];
    setBaseline(merge.latest);
    reset(values);
    setMerge(null);
    setError(null);
  }
  const save = handleSubmit(async (values) => {
    if (
      !baseline ||
      saving.current ||
      conflict ||
      merge ||
      !writable ||
      (needsConfirmation && !confirmed)
    )
      return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: values.title.trim(),
        contextProblem: values.contextProblem.trim(),
        changeSolution: values.changeSolution.trim(),
        resultVerification: values.resultVerification.trim(),
        remainingIssues: values.remainingIssues.map((entry) =>
          entry.id === undefined
            ? { content: entry.content.trim() }
            : { id: entry.id, content: entry.content.trim() },
        ),
        confirmLeftoverResolved: confirmed,
      };
      const signature = JSON.stringify([
        baseline.id,
        baseline.rowVersion,
        baseline.currentVersion,
        body,
      ]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("record-version"),
        };
      const csrf = await api.issueCsrfToken();
      const result = await api.createChangeRecordVersion(
        item.projectId,
        item.id,
        body,
        {
          headers: {
            "x-csrf-token": csrf.csrfToken,
            "If-Match": `"${baseline.rowVersion}"`,
            "X-Record-Version": String(baseline.currentVersion),
            "Idempotency-Key": retry.current.key,
          },
        },
      );
      cache.setQueryData(["published-record", item.projectId, item.id], result);
      await cache.invalidateQueries({
        queryKey: ["record-versions", item.projectId, item.id],
      });
      await cache.invalidateQueries({
        // 正文修订会改变时间线卡片上的摘要与遗留项，正式记录清单必须一起失效。
        queryKey: ["record-feed"],
      });
      // 修订会增删正文里的剩余问题，侧栏遗留项计数随即变化。
      await invalidateShellCounters(cache);
      setBaseline(null);
      retry.current = null;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  });
  return (
    <>
      <Button disabled={!writable} onClick={open}>
        修订内容
      </Button>
      <Modal
        open={baseline !== null}
        eyebrow={
          baseline === null
            ? undefined
            : item.code +
              " · 保存为 v" +
              ((baseline.currentVersion ?? item.currentVersion) + 1)
        }
        title="修订迭代记录"
        className="catalog-modal"
        size="lg"
        onCancel={() => {
          if (!busy) setBaseline(null);
        }}
        mask={{ closable: !busy }}
        footer={
          <Button
            htmlType="submit"
            form={formId}
            type="primary"
            loading={busy}
            disabled={
              !writable ||
              conflict ||
              !!merge ||
              (needsConfirmation && !confirmed)
            }
          >
            保存新版本
          </Button>
        }
      >
        <form
          id={formId}
          className="catalog-form calm-form"
          onSubmit={(e) => void save(e)}
        >
          <div className="dialog-form">
            <p>
              保存为 v{(baseline?.currentVersion ?? item.currentVersion) + 1}
              ，旧版本保持不变。新的变更内容请新建记录。
            </p>
            {!!error && (
              <Alert
                type="error"
                title={
                  error instanceof ApiError
                    ? `${error.message} 输入已保留。`
                    : "服务暂时不可用，输入已保留，可重试。"
                }
              />
            )}
            {conflict &&
              error instanceof ApiError &&
              error.code === "RECORD_VERSION_CONFLICT" && (
                <Button disabled={busy} onClick={() => void reload()}>
                  加载最新版本并合并
                </Button>
              )}
            {merge && (
              <section aria-label="版本冲突">
                <p>双方都修改了以下内容，请逐项选择。</p>
                {merge.conflicts.map((field) => (
                  <label key={field}>
                    {labels[field]}冲突
                    <CalmSelect
                      ariaLabel={labels[field] + "冲突"}
                      value={merge.choices[field] ?? ""}
                      appearance="menu"
                      onChange={(next) =>
                        setMerge({
                          ...merge,
                          choices: {
                            ...merge.choices,
                            [field]: next as "mine" | "latest",
                          },
                        })
                      }
                      options={[
                        { value: "", label: "请选择" },
                        { value: "mine", label: "保留我的输入" },
                        { value: "latest", label: "采用最新内容" },
                      ]}
                      animated
                    />
                    <div className="record-field">
                      <span className="record-field-label">最新内容</span>
                      <RecordMarkdown
                        content={fieldText(merge.latest, field) || "（空）"}
                      />
                    </div>
                  </label>
                ))}
                <Button
                  disabled={merge.conflicts.some((f) => !merge.choices[f])}
                  onClick={apply}
                >
                  应用合并
                </Button>
              </section>
            )}
            {fields
              .filter((field) => field !== "remainingIssues")
              .map((field) => (
                <label key={field}>
                  {labels[field]}
                  <Controller
                    name={field}
                    control={control}
                    rules={{
                      validate: (v) => v.trim().length > 0 || "请填写此项",
                      maxLength: field === "title" ? 500 : 50000,
                    }}
                    render={({ field: input }) =>
                      field === "title" ? (
                        <Input
                          {...input}
                          aria-label={labels[field]}
                          maxLength={500}
                        />
                      ) : (
                        <Input.TextArea
                          {...input}
                          aria-label={labels[field]}
                          rows={4}
                          maxLength={50000}
                        />
                      )
                    }
                  />
                  {errors[field] && (
                    <span role="alert">
                      {errors[field]?.message || "内容超过长度限制"}
                    </span>
                  )}
                </label>
              ))}
            <label>
              <Controller
                name="remainingIssues"
                control={control}
                rules={{
                  validate: (entries) =>
                    entries.every((entry) => entry.content.trim().length > 0) ||
                    "每条遗留问题都不能为空，可移除不需要的条目",
                }}
                render={({ field: input }) => (
                  <LeftoverEntriesField
                    value={input.value}
                    onChange={input.onChange}
                    lockedIds={convertedIds}
                    label={labels.remainingIssues}
                  />
                )}
              />
              {errors.remainingIssues && (
                <span role="alert">
                  {errors.remainingIssues?.message || "内容超过长度限制"}
                </span>
              )}
            </label>
            {needsConfirmation && (
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                确认移除的遗留问题已处理（不会删除历史；
                {removedActive.length} 条）
              </label>
            )}
            {convertedIds.length > 0 && (
              <p>
                已转任务的遗留问题保持原任务关联，修订文字不会创建第二个任务。新的独立问题请新建记录。
              </p>
            )}
            <p>
              每条遗留问题最多10000字符、最多50条。超出完整正文的发布容量时会保留输入并提示调整。
            </p>
          </div>
        </form>
      </Modal>
    </>
  );
}

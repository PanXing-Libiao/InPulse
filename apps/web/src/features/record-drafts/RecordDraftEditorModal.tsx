import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { Controller, useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { projectSelectOption } from "@features/common/project-select-option";
import { LeftoverEntriesField } from "@features/common/components/LeftoverEntriesField";
import { ExternalLinksPanel } from "@features/external-links/ExternalLinksPanel";
import { TaskLinksPicker } from "@features/external-links/TaskLinksPicker";
import type { TaskLinksSelection } from "@features/external-links/TaskLinksPicker";
import { associateLinks } from "@features/external-links/associate-links";
import { RecordMarkdown } from "@features/common/components/RecordMarkdown";
import { createIdempotencyKey } from "@shared/api/idempotency-key";
import {
  ApiError,
  type InpulseApiClient,
  type PublishedRecord,
  type RecordDraftContent,
  type RecordDraftItem,
  type TaskRecordDraftsResponse,
} from "@generated/api";
import {
  fieldText,
  fields,
  labels,
  mergeRecordDraft,
  type Field,
} from "./record-content";
import { MY_RECORD_DRAFTS_QUERY_KEY } from "./record-drafts-query";
import {
  recordDraftDeleteErrorMessage,
  recordDraftErrorMessage,
} from "./record-draft-errors";
import "./record-drafts.css";

/**
 * 弹窗要处理的目标：编辑已有草稿 / 从任务创建来源草稿 / 新建迭代记录（独立草稿）。
 * 每次传入新对象都视为一次「打开」，弹窗据此重置表单与冲突状态。
 */
export type RecordDraftEditorTarget =
  | { readonly kind: "item"; readonly item: RecordDraftItem }
  | {
      readonly kind: "source";
      readonly source: TaskRecordDraftsResponse["source"];
    }
  | { readonly kind: "independent" };

const empty: RecordDraftContent = {
  title: "",
  contextProblem: "",
  changeSolution: "",
  resultVerification: "",
  remainingIssues: [],
};
const content = (item: RecordDraftContent): RecordDraftContent => ({
  title: item.title,
  contextProblem: item.contextProblem,
  changeSolution: item.changeSolution,
  resultVerification: item.resultVerification,
  remainingIssues: item.remainingIssues,
});
type Merge = ReturnType<typeof mergeRecordDraft> & {
  latest: RecordDraftItem;
  choices: Partial<Record<Field, "mine" | "latest">>;
};

/**
 * 迭代记录草稿的创建/编辑弹窗（B-3a 起为记录页页头 CTA 与草稿卡片共用；
 * 任务详情弹窗的「记录一次迭代」也复用它，不再跳转记录页）。
 * 保存只写草稿，不完成任务也不发布记录；发布仍由草稿详情的 PublishRecordButton 完成。
 */
export function RecordDraftEditorModal({
  api,
  target,
  projectId,
  defaultModuleId = 0,
  writable,
  onClose,
  onSaved,
  onDeleted,
}: {
  api: InpulseApiClient;
  /** 非 null 即打开；每次传入新对象视为一次打开并初始化表单。 */
  target: RecordDraftEditorTarget | null;
  /** 页面锁定的项目；0 表示独立草稿在弹窗内选择目标项目。 */
  projectId: number;
  /** 打开独立草稿时的预选模块（来自 URL 上下文）。 */
  defaultModuleId?: number | undefined;
  /** 调用方附加的可写条件（如来源任务已归档）；弹窗内部再叠加目标项目状态。 */
  writable: boolean;
  onClose: () => void;
  /**
   * 保存成功回调：调用方决定关闭、刷新或导航；缓存失效已由弹窗完成。
   * published 非空表示这次保存顺带发布成了正式迭代记录。
   */
  onSaved: (
    draft: RecordDraftItem,
    published?: PublishedRecord | null | undefined,
  ) => void;
  /**
   * 删除成功回调：调用方据此收起仍在展示这条草稿的详情弹层（弹窗已自行关闭）。
   */
  onDeleted?: (() => void) | undefined;
}) {
  const cache = useQueryClient();
  // 409 后重新加载会拿到更新的来源或草稿版本：用内部覆盖保存最新目标，
  // 不要求调用方改写自己持有的 target。
  const [override, setOverride] = useState<RecordDraftEditorTarget | null>(
    null,
  );
  const editor = override ?? target;
  const item = editor?.kind === "item" ? editor.item : undefined;
  const source = editor?.kind === "source" ? editor.source : undefined;
  const independent = editor?.kind === "independent";
  const [moduleId, setModuleId] = useState(defaultModuleId);
  /**
   * 「全部项目」视图（projectId 为 0）下，在弹窗里选择的目标项目；
   * 页面已锁定项目时以页面为准，该状态不参与。
   */
  const [createProjectId, setCreateProjectId] = useState(0);
  const [merge, setMerge] = useState<Merge | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  /** 新建迭代时要一起关联的 GitHub 链接（来源任务链接的勾选 ∪ 自己添加），由链接小节上报。 */
  const [selectedLinks, setSelectedLinks] = useState<string[]>([]);
  /** 其中自己添加的那几条：任务上原本没有，保存后还要存进项目链接库并关联来源任务。 */
  const [addedLinks, setAddedLinks] = useState<string[]>([]);
  const handleLinksChange = (selection: TaskLinksSelection) => {
    setSelectedLinks(selection.urls);
    setAddedLinks(selection.addedUrls);
  };
  const [linksPending, setLinksPending] = useState(false);
  /** 每次打开换一个 key：重置链接小节的勾选与自己添加的内容。 */
  const [linksSession, setLinksSession] = useState(0);
  /** 创建草稿的目标项目：草稿按项目创建，服务端不接受「全部项目」。 */
  const formProjectId = projectId > 0 ? projectId : createProjectId;
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const publishRetry = useRef<{ signature: string; key: string } | null>(null);
  const saving = useRef(false);
  /** 当前正在跑的动作：两个页脚按钮各自显示自己的 loading。 */
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  /**
   * 离开确认弹层：未保存的内容不会写库、也不做本地暂存，只请用户确认一次，
   * 避免按 Esc / 点遮罩误触后静默丢掉刚输入的内容。
   */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** 删除确认弹层：草稿删除不可恢复，必须先确认再打接口。 */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const deleteRetry = useRef<{ signature: string; key: string } | null>(null);
  const lastTarget = useRef<RecordDraftEditorTarget | null>(null);
  const {
    control,
    handleSubmit,
    reset,
    getValues,
    formState: { errors, isDirty },
  } = useForm<RecordDraftContent>({ defaultValues: empty });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => api.listProjects({ signal }),
    retry: false,
  });
  const modules = useQuery({
    queryKey: ["modules", formProjectId],
    queryFn: ({ signal }) => api.listModules(formProjectId, { signal }),
    enabled: formProjectId > 0,
    retry: false,
  });
  /** 保存后的后续步骤失败时切到这条草稿的编辑态：重试走更新，不会再建一条。 */
  const switchToSaved = async (saved: RecordDraftItem) => {
    setOverride({ kind: "item", item: saved });
    // 草稿已经落库：把表单基线对齐到服务端保存的内容，
    // 之后关闭弹窗不会因为「表单被改过」而误报有未保存内容。
    reset(content(saved));
    await cache.invalidateQueries({
      queryKey: ["record-drafts", saved.projectId],
    });
    await cache.invalidateQueries({ queryKey: MY_RECORD_DRAFTS_QUERY_KEY });
    await cache.invalidateQueries({
      queryKey: ["task-record-drafts", projectId],
    });
  };
  /**
   * 删除当前草稿：未发布过的草稿不属于业务历史，删掉后不能再恢复。
   * 成功后清掉草稿相关缓存并关闭弹窗；失败保留弹窗与草稿，只提示原因。
   */
  const removeDraft = async () => {
    if (!item || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const signature = JSON.stringify([item.id, item.rowVersion]);
      if (deleteRetry.current?.signature !== signature)
        deleteRetry.current = {
          signature,
          key: createIdempotencyKey("record-draft-delete"),
        };
      const csrf = await api.issueCsrfToken();
      await api.deleteRecordDraft(item.projectId, item.id, {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "If-Match": `"${item.rowVersion}"`,
          "Idempotency-Key": deleteRetry.current.key,
        },
      });
      deleteRetry.current = null;
      await cache.invalidateQueries({
        queryKey: ["record-drafts", item.projectId],
      });
      await cache.invalidateQueries({ queryKey: MY_RECORD_DRAFTS_QUERY_KEY });
      await cache.invalidateQueries({
        queryKey: ["task-record-drafts", projectId],
      });
      cache.removeQueries({
        queryKey: ["record-draft", item.projectId, item.id],
      });
      setConfirmDelete(false);
      onDeleted?.();
      onClose();
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleting(false);
    }
  };
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      readonly edit: RecordDraftContent;
      /** 保存后立即发布成正式迭代记录（页脚主按钮「发布迭代记录」）。 */
      readonly publish: boolean;
    }) => {
      const edit = input.edit;
      const normalized: RecordDraftContent = {
        title: edit.title.trim(),
        contextProblem: edit.contextProblem.trim(),
        changeSolution: edit.changeSolution.trim(),
        resultVerification: edit.resultVerification.trim(),
        remainingIssues: edit.remainingIssues.map((entry) => ({
          content: entry.content.trim(),
        })),
      };
      const body = source
        ? {
            ...normalized,
            title: normalized.title === source.title ? null : normalized.title,
          }
        : item
          ? normalized
          : normalized;
      const signature = JSON.stringify([
        formProjectId,
        moduleId,
        item?.id,
        item?.rowVersion,
        source?.taskId,
        source?.rowVersion,
        body,
      ]);
      if (retry.current?.signature !== signature)
        retry.current = {
          signature,
          key: createIdempotencyKey("record-draft"),
        };
      const csrf = await api.issueCsrfToken();
      const init = {
        headers: {
          "x-csrf-token": csrf.csrfToken,
          "Idempotency-Key": retry.current.key,
          ...(item
            ? { "If-Match": `"${item.rowVersion}"` }
            : source
              ? { "If-Match": `"${source.rowVersion}"` }
              : {}),
        },
      };
      let saved: RecordDraftItem =
        item && item.taskId !== null
          ? await api.updateTaskRecordDraft(
              projectId,
              item.moduleId,
              item.taskId,
              item.id,
              normalized,
              init,
            )
          : source
            ? await api.createTaskRecordDraft(
                projectId,
                source.moduleId,
                source.taskId,
                body as Parameters<
                  InpulseApiClient["createTaskRecordDraft"]
                >[3],
                init,
              )
            : item
              ? await api.updateIndependentRecordDraft(
                  projectId,
                  item.id,
                  normalized,
                  init,
                )
              : await api.createIndependentRecordDraft(
                  formProjectId,
                  moduleId,
                  body as Parameters<
                    InpulseApiClient["createIndependentRecordDraft"]
                  >[2],
                  init,
                );
      // 新建时选中的 GitHub 链接在草稿落库后写入；失败时草稿已在，切到编辑态重试。
      // 关联链接会让记录的 rowVersion 前进，因此写完必须把本地版本刷新到最新，
      // 否则紧随其后的发布会被 If-Match 版本冲突挡下。
      let taskLinked = false;
      if (selectedLinks.length > 0) {
        let linkRowVersion = (
          await api.listExternalLinks("CHANGE_RECORD", saved.id)
        ).rowVersion;
        for (const url of selectedLinks) {
          const linkCsrf = await api.issueCsrfToken();
          try {
            const added = await api.addExternalLink(
              "CHANGE_RECORD",
              saved.id,
              { url },
              {
                headers: {
                  "x-csrf-token": linkCsrf.csrfToken,
                  "If-Match": `"${linkRowVersion}"`,
                  "Idempotency-Key": createIdempotencyKey("external-link"),
                },
              },
            );
            linkRowVersion = added.rowVersion;
          } catch (error) {
            // 重试时已经关联上的那条按成功处理，不再卡在 409。
            if (
              error instanceof ApiError &&
              error.status === 409 &&
              error.code === "EXTERNAL_LINK_ALREADY_ASSOCIATED"
            )
              continue;
            await switchToSaved(saved);
            throw error;
          }
        }
        saved = { ...saved, rowVersion: linkRowVersion };
        // 自己添加的链接任务上原本没有：除记录外还要写进项目链接库并关联到来源
        // 任务（任务详情的「GitHub 链接」面板可见）。失败切到编辑态重试，重试时
        // 已写好的记录侧会被服务端判为「已关联」而跳过，不会重复。
        if (source && addedLinks.length > 0) {
          const linkCsrf = await api.issueCsrfToken();
          const firstFailure = (
            await associateLinks(
              api,
              "TASK",
              source.taskId,
              addedLinks,
              linkCsrf.csrfToken,
            )
          )[0];
          if (firstFailure !== undefined) {
            await switchToSaved(saved);
            throw firstFailure.error;
          }
          taskLinked = true;
        }
      }
      if (!input.publish) return { draft: saved, published: null, taskLinked };
      const publishSignature = saved.id + ":" + saved.rowVersion;
      if (publishRetry.current?.signature !== publishSignature)
        publishRetry.current = {
          signature: publishSignature,
          key: createIdempotencyKey("record-publish"),
        };
      try {
        const publishCsrf = await api.issueCsrfToken();
        const published = await api.publishChangeRecord(
          saved.projectId,
          saved.id,
          {},
          {
            headers: {
              "x-csrf-token": publishCsrf.csrfToken,
              "If-Match": JSON.stringify(String(saved.rowVersion)),
              "Idempotency-Key": publishRetry.current.key,
            },
          },
        );
        publishRetry.current = null;
        return { draft: saved, published, taskLinked };
      } catch (error) {
        // 发布失败时草稿已经落库：切到编辑态，重试就是更新同一条，不会建重复草稿。
        await switchToSaved(saved);
        throw error;
      }
    },
    onSuccess: async ({ draft, published, taskLinked }) => {
      retry.current = null;
      onSaved(draft, published);
      cache.setQueryData(["record-draft", formProjectId, draft.id], draft);
      if (published)
        cache.setQueryData(
          ["published-record", published.projectId, published.id],
          published,
        );
      await cache.invalidateQueries({
        queryKey: ["record-draft", formProjectId, draft.id],
      });
      await cache.invalidateQueries({
        queryKey: ["record-drafts", formProjectId],
      });
      await cache.invalidateQueries({ queryKey: MY_RECORD_DRAFTS_QUERY_KEY });
      await cache.invalidateQueries({
        queryKey: ["task-record-drafts", projectId],
      });
      // 刚发布的记录要立刻出现在时间线里，草稿箱则少一条；任务卡片与任务详情的
      //「迭代记录 N 条」来自 R-5 任务标记，也必须一起失效。
      if (published) {
        await cache.invalidateQueries({ queryKey: ["task-marks"] });
        await cache.invalidateQueries({ queryKey: ["record-feed"] });
      }
      // 自己添加的链接关联到任务后，任务链接清单与任务版本都变了，两者都要失效。
      if (taskLinked) {
        await cache.invalidateQueries({ queryKey: ["task-external-links"] });
        await cache.invalidateQueries({ queryKey: ["tasks"] });
      }
    },
  });
  // 每次传入新 target 视为一次打开：同步表单与范围选择器，清空冲突与错误态。
  useEffect(() => {
    if (target === null) {
      lastTarget.current = null;
      return;
    }
    if (lastTarget.current === target) return;
    lastTarget.current = target;
    setOverride(null);
    setMerge(null);
    setReloadError(null);
    setSelectedLinks([]);
    setAddedLinks([]);
    setLinksPending(false);
    setLinksSession((value) => value + 1);
    setConfirmDiscard(false);
    mutation.reset();
    if (target.kind === "item") {
      reset(content(target.item));
      setModuleId(target.item.moduleId);
      return;
    }
    if (target.kind === "source") {
      // 来源快照同时驱动归属行的只读展示：模块名称按它的 moduleId 走既有只读契约。
      reset({ ...empty, title: target.source.title });
      setModuleId(target.source.moduleId);
      return;
    }
    reset(empty);
    setModuleId(defaultModuleId);
  }, [target, reset, mutation, defaultModuleId]);
  // ADR-043：项目只有未开始 / 进行中 / 维护中且都可写；目标项目状态未知时不可写。
  const formProjectStatus = projects.data?.items.find(
    (p) => p.id === formProjectId,
  )?.status;
  const canWrite =
    writable && formProjectId > 0 && formProjectStatus !== undefined;
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const reload = async () => {
    if (!editor) return;
    if (
      mutation.error instanceof ApiError &&
      mutation.error.code === "RECORD_PARENT_ARCHIVED"
    ) {
      setReloadError("来源任务已归档，草稿只读，输入已保留。");
      return;
    }
    setReloading(true);
    try {
      if (source) {
        const latest = await api.getTaskRecordDrafts(
          projectId,
          source.moduleId,
          source.taskId,
        );
        setOverride({ kind: "source", source: latest.source });
        cache.setQueryData(
          [
            "task-record-drafts",
            projectId,
            latest.source.moduleId,
            latest.source.taskId,
          ],
          latest,
        );
        mutation.reset();
        setReloadError(null);
        return;
      }
      if (!item) return;
      const latest = await api.getRecordDraft(projectId, item.id);
      const merged = mergeRecordDraft(
        content(item),
        getValues(),
        content(latest),
      );
      if (merged.conflicts.length) setMerge({ ...merged, latest, choices: {} });
      else {
        setOverride({ kind: "item", item: latest });
        reset(merged.values);
        mutation.reset();
        setReloadError(null);
      }
    } catch (error) {
      setReloadError(recordDraftErrorMessage(error));
    } finally {
      setReloading(false);
    }
  };
  const applyMerge = () => {
    if (!merge || merge.conflicts.some((field) => !merge.choices[field]))
      return;
    const values = { ...merge.values };
    for (const field of merge.conflicts)
      if (merge.choices[field] === "latest")
        (values as Record<Field, unknown>)[field] = merge.latest[field];
    reset(values);
    setOverride({ kind: "item", item: merge.latest });
    setMerge(null);
    mutation.reset();
    setReloadError(null);
  };
  const run = async (edit: RecordDraftContent, publish: boolean) => {
    if (
      saving.current ||
      !editor ||
      conflict ||
      merge ||
      reloading ||
      reloadError ||
      !canWrite
    )
      return;
    saving.current = true;
    setPending(publish ? "publish" : "save");
    try {
      await mutation.mutateAsync({ edit, publish });
    } catch {
      /* Preserve input and key. */
    } finally {
      setPending(null);
      saving.current = false;
    }
  };
  const save = handleSubmit((edit) => run(edit, false));
  const saveAndPublish = handleSubmit((edit) => run(edit, true));
  /**
   * 页脚主按钮：ADR-047 起迭代记录只描述本次迭代，发布与任务完成解耦——来源任务未完成
   * （含已取消）也能就地发布，且发布不改变任务状态，三种目标于是共用同一个发布入口。
   * 三态共用「发布迭代记录」：独立新建时旧文案「新建迭代」看不出会播出去，容易被当成建草稿。
   */
  const publishLabel = "发布迭代记录";
  /** 来源快照的只读归属行：名称走既有只读契约，数据未到时回退编号。 */
  const nameOf = {
    project: (id: number) =>
      projects.data?.items.find((entry) => entry.id === id)?.name ??
      `项目 #${id}`,
    module: (id: number) =>
      modules.data?.items.find((entry) => entry.id === id)?.name ??
      `模块 #${id}`,
  };
  /** 两个页脚动作共用同一套禁用条件：不可写、有冲突或范围没选全都不能提交。 */
  const submitBlocked =
    mutation.isPending ||
    !canWrite ||
    conflict ||
    !!merge ||
    reloading ||
    !!reloadError ||
    (!item && !source && (!formProjectId || !moduleId));
  /**
   * 未保存内容：表单被改过、链接小节里还有没落库的内容、冲突合并未选完，
   * 这些一律算作「离开会丢」。
   */
  const unsaved = isDirty || linksPending || merge !== null;
  /** Esc / 点遮罩 / 头部 ✕ 三条路径共用：有未保存内容就先确认一次。 */
  const requestClose = () => {
    if (saving.current || reloading || deleting || confirmDelete) return;
    if (unsaved) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };
  return (
    <Modal
      open={target !== null}
      eyebrow={
        item
          ? "草稿 · " + item.title
          : source
            ? "任务 · " + source.title
            : "项目与模块 / 迭代记录"
      }
      title={item ? "编辑草稿" : source ? "新建任务迭代" : "新建迭代记录"}
      className="catalog-modal"
      size="lg"
      onCancel={requestClose}
      mask={{ closable: !mutation.isPending && !reloading }}
    >
      <form
        className="catalog-form calm-form"
        onSubmit={(event) => void save(event)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey))
            return;
          // Ctrl/Cmd + 回车只提交「保存草稿」：发布要把记录公开给项目成员，
          // 必须是一次显式点击；从多行字段里保存则不该逼用户先退出输入框。
          if (confirmDiscard || confirmDelete || submitBlocked) return;
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-form">
          {mutation.isError && (
            <Alert
              type="error"
              title={recordDraftErrorMessage(mutation.error)}
            />
          )}
          {reloadError && <Alert type="warning" title={reloadError} />}
          {conflict && (item || source) && (
            <Button loading={reloading} onClick={() => void reload()}>
              {source ? "加载最新来源任务" : "加载最新草稿并合并"}
            </Button>
          )}
          {merge && (
            <section aria-label="草稿冲突">
              <p>以下字段双方都有修改，请逐项选择。</p>
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
                onClick={applyMerge}
                disabled={merge.conflicts.some(
                  (field) => !merge.choices[field],
                )}
              >
                应用合并
              </Button>
            </section>
          )}
          {source && (
            <section
              className="record-source-panel"
              aria-label="来源任务与归属"
            >
              <p className="record-source-line">
                来源任务 <strong>{source.title}</strong>
                {" · "}
                处理人 <strong>{source.assigneeName ?? "名称暂不可用"}</strong>
              </p>
              {/* 与迭代记录页同一套归属行，只是按保存时的来源快照预填并只读。 */}
              <dl className="record-scope-facts">
                <div className="record-scope-fact">
                  <dt>所属项目</dt>
                  <dd>{nameOf.project(formProjectId)}</dd>
                </div>
                <div className="record-scope-fact">
                  <dt>所属模块</dt>
                  <dd>{nameOf.module(moduleId)}</dd>
                </div>
              </dl>
            </section>
          )}
          {independent && (
            <>
              {projectId === 0 && (
                <label>
                  所属项目
                  <CalmSelect
                    ariaLabel="所属项目"
                    value={createProjectId || ""}
                    appearance="rich"
                    placeholder="请选择项目"
                    onChange={(next) => {
                      setCreateProjectId(Number(next));
                      setModuleId(0);
                    }}
                    options={(projects.data?.items ?? []).map((p) => ({
                      ...projectSelectOption(p),
                      disabled: p.status !== "ACTIVE",
                    }))}
                    animated
                  />
                </label>
              )}
              <label>
                所属模块
                <CalmSelect
                  ariaLabel="所属模块"
                  value={moduleId || ""}
                  appearance="rich"
                  searchable
                  width="100%"
                  placeholder={
                    formProjectId > 0 ? "输入模块名称搜索" : "请先选择项目"
                  }
                  onChange={(next) => {
                    setModuleId(Number(next));
                  }}
                  // ADR-044：模块已无归档只读态，模块选项全部可选。
                  options={(modules.data?.items ?? []).map((m) => ({
                    value: m.id,
                    label: m.name,
                  }))}
                  animated
                />
              </label>
              {modules.isError && (
                <Alert
                  type="error"
                  title="所属模块加载失败，请重新选择或刷新。"
                />
              )}
            </>
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
                    validate: (value) =>
                      value.trim().length > 0 || "请填写此项",
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
                    {errors[field]?.message || "内容过长"}
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
                  label={labels.remainingIssues}
                />
              )}
            />
            {errors.remainingIssues && (
              <span role="alert">
                {errors.remainingIssues?.message || "内容过长"}
              </span>
            )}
          </label>
          {item ? (
            <section aria-label="GitHub 链接" className="record-github-links">
              <div className="record-github-head">
                <h4 className="record-github-title">GitHub 链接</h4>
                <span className="record-github-hint">
                  关联本次迭代的仓库、PR、Issue 或提交。
                </span>
              </div>
              <ExternalLinksPanel
                key={item.id}
                variant="inline"
                targetType="CHANGE_RECORD"
                targetId={item.id}
                client={api}
              />
            </section>
          ) : (
            <TaskLinksPicker
              key={linksSession}
              api={api}
              taskId={source?.taskId ?? 0}
              disabled={!canWrite}
              inputId="record-github-link-input"
              hint={
                source
                  ? "来源任务上的链接默认带上，展开后可以取消勾选；自己添加的新链接会一起关联到这条记录和来源任务。"
                  : "保存后自动关联到这条记录。"
              }
              onSelectionChange={handleLinksChange}
              onPendingChange={setLinksPending}
            />
          )}
          <p className="record-publish-hint">
            发布后项目成员可见；先「保存草稿」只自己能看到，检查好再发布。
          </p>
        </div>
        <div className="calm-action-footer">
          {item ? (
            <Button
              className="footer-leading"
              danger
              type="primary"
              disabled={submitBlocked || deleting}
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            >
              删除草稿
            </Button>
          ) : null}
          <Button
            htmlType="submit"
            className="soft-blue-button"
            loading={pending === "save"}
            disabled={submitBlocked}
          >
            保存草稿
          </Button>
          <Button
            className="primary-button"
            loading={pending === "publish"}
            disabled={submitBlocked}
            onClick={() => void saveAndPublish()}
          >
            {publishLabel}
          </Button>
        </div>
      </form>
      <Modal
        className="catalog-modal"
        eyebrow={item ? "草稿 · " + item.title : "迭代记录草稿"}
        title="放弃未保存的内容"
        tone="warning"
        icon="alert"
        open={confirmDiscard}
        body
        onCancel={() => setConfirmDiscard(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDiscard(false)}>继续编辑</Button>
            <Button
              type="primary"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              放弃修改
            </Button>
          </>
        }
      >
        <p>这次输入不会保存，草稿仍是上次保存的内容。</p>
      </Modal>
      <Modal
        className="catalog-modal"
        eyebrow={item ? "草稿 · " + item.title : "迭代记录草稿"}
        title="删除草稿"
        tone="danger"
        icon="alert"
        open={confirmDelete}
        body
        closable={!deleting}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false);
        }}
        mask={{ closable: !deleting }}
        footer={
          <>
            <Button disabled={deleting} onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button
              danger
              type="primary"
              loading={deleting}
              onClick={() => void removeDraft()}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          删除后这条草稿、草稿里的遗留问题条目和 GitHub
          链接关联都会移除，且不能恢复。
        </p>
        <p>已经发布的迭代记录不受影响，只能在记录详情里作废。</p>
        {deleteError !== null && (
          <Alert
            type="error"
            title={recordDraftDeleteErrorMessage(deleteError)}
          />
        )}
      </Modal>
    </Modal>
  );
}

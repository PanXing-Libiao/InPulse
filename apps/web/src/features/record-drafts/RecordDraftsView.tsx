import { ExternalLinksPanel } from "@features/external-links/ExternalLinksPanel";
import { fieldText, fields, labels } from "./record-content.js";
export { mergeRecordDraft } from "./record-content.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { formatBeijingShortDateTime } from "@features/common/beijing-time";
import { PublishRecordButton } from "@features/published-records/PublishRecordButton";
import {
  RECORD_DRAFTS_PAGE_LIMIT,
  useMyRecordDraftsQuery,
  useRecordDraftsQuery,
} from "./record-drafts-query";
import {
  RecordDraftEditorModal,
  type RecordDraftEditorTarget,
} from "./RecordDraftEditorModal";
import {
  recordDraftErrorMessage,
  recordDraftListErrorMessage,
} from "./record-draft-errors";
import "./record-drafts.css";
import { Alert, Button } from "antd";
import { AppModal as Modal } from "@features/common/components/AppModal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type InpulseApiClient,
  type RecordDraftItem,
} from "@generated/api";
import { useScopedSearchParams } from "@features/common/search-params-scope";
import { CalmBadge, CalmSectionTitle } from "@features/common/components/Calm";
import { RecordMarkdown } from "@features/common/components/RecordMarkdown";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
/**
 * 归一后的草稿卡片。名称回填只由服务端跨项目列表（全部项目视图）提供；项目内视图
 * 与来源任务视图沿用草稿自身携带的 moduleName。
 */
interface DraftCardItem {
  readonly draft: RecordDraftItem;
  readonly projectName: string | null;
  readonly moduleName: string | null;
  readonly authorName: string | null;
}

function toDraftCard(
  draft: RecordDraftItem,
  names?: {
    readonly projectName: string;
    readonly moduleName: string;
  },
  authorFallback?: string | undefined,
): DraftCardItem {
  return {
    draft,
    projectName: names?.projectName ?? null,
    moduleName: names?.moduleName ?? draft.moduleName ?? null,
    // 全部项目视图的草稿恒为当前用户创建，服务端不回填作者名时用登录用户名兜底。
    authorName: draft.authorName ?? authorFallback ?? null,
  };
}

export function RecordDraftsView({
  client,
  createToken = 0,
  currentUserId,
  currentUserName,
  onCanCreateChange,
}: {
  client?: InpulseApiClient | undefined;
  /** 页头 CTA 的递增令牌：变化时打开对应模式的草稿弹窗（B-3a 单页）。 */
  createToken?: number;
  /** 当前登录用户 id：草稿列表只列自己创建的，未传则列出项目全部草稿。 */
  currentUserId?: number | undefined;
  /** 当前登录用户名：全部项目视图的草稿作者名兜底（服务端不回填作者名）。 */
  currentUserName?: string | undefined;
  /** 向调用方上报能否创建草稿，供页头 CTA 的禁用态使用。 */
  onCanCreateChange?: ((canCreate: boolean) => void) | undefined;
}) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const cache = useQueryClient();
  const [params, setParams] = useScopedSearchParams();
  const projectId = Number(params.get("projectId")) || 0;
  const recordId = Number(params.get("recordId")) || 0;
  const taskId = Number(params.get("taskId")) || 0;
  const sourceModuleId = Number(params.get("moduleId")) || 0;
  /** 编辑/新建草稿的弹窗目标：与记录页页头 CTA、任务详情弹窗共用同一组件。 */
  const [editorTarget, setEditorTarget] =
    useState<RecordDraftEditorTarget | null>(null);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => api.listProjects({ signal }),
    retry: false,
  });
  /** 全部项目视图（URL 不带 projectId）：草稿跨项目汇总，卡片回填项目名。 */
  const isAllProjects = projectId === 0;
  const projectDrafts = useRecordDraftsQuery({
    client,
    projectId,
    enabled: !taskId && !isAllProjects,
    authorId: currentUserId,
  });
  const myDrafts = useMyRecordDraftsQuery({
    client,
    enabled: !taskId && isAllProjects,
  });
  const sourceQuery = useQuery({
    queryKey: ["task-record-drafts", projectId, sourceModuleId, taskId],
    queryFn: ({ signal }) =>
      api.getTaskRecordDrafts(projectId, sourceModuleId, taskId, { signal }),
    enabled: projectId > 0 && sourceModuleId > 0 && taskId > 0,
    retry: false,
  });
  /**
   * 三种来源（来源任务 / 项目草稿 / 全部项目下的我的草稿）归一成同一种卡片模型，
   * 卡片渲染与打开逻辑只认 draftCards。
   */
  const draftCards: readonly DraftCardItem[] =
    taskId > 0
      ? (sourceQuery.data?.items ?? []).map((item) => toDraftCard(item))
      : isAllProjects
        ? (myDrafts.data?.pages.flatMap((page) => [...page.items]) ?? []).map(
            (item) => toDraftCard(item.draft, item, currentUserName),
          )
        : (
            projectDrafts.data?.pages.flatMap((page) => [...page.items]) ?? []
          ).map((item) => toDraftCard(item));
  const listPending =
    taskId > 0
      ? sourceQuery.isPending
      : isAllProjects
        ? myDrafts.isPending
        : projectDrafts.isPending;
  const listError =
    taskId > 0
      ? sourceQuery.error
      : isAllProjects
        ? myDrafts.error
        : projectDrafts.error;
  const listFailed =
    taskId > 0
      ? sourceQuery.isError
      : isAllProjects
        ? myDrafts.isError
        : projectDrafts.isError;
  /**
   * 项目级草稿读取对非成员项目按资源语义返回 404（跨项目清单则静默排除）：重试不会变好，
   * 页面级守卫也会给出说明，这里不再重复渲染红条与「重试草稿列表」。
   */
  const projectListUnreadable =
    !taskId &&
    !isAllProjects &&
    listFailed &&
    listError instanceof ApiError &&
    (listError.status === 403 || listError.status === 404);
  /**
   * 内容区只在有东西可展示时占位：有草稿卡片，或读取失败需要给出重试入口。
   * （首次加载中不占位，空结果也不占位。）
   */
  const hasDraftContent =
    (listFailed && !projectListUnreadable) || draftCards.length > 0;
  /**
   * 草稿箱（我的草稿 / 项目草稿）整块渲染的条件：解析完仍是空的时候，标题、
   * 折叠按钮与列表一律不渲染，页面上不留任何与草稿箱有关的字样。
   * 两个例外：读取失败必须给出重试入口；来源任务视图的标题行带着「新建来源草稿」，
   * 那是那一屏唯一不随草稿数量消失的创建入口，因此照旧保留标题行。
   */
  const showDraftBox = taskId > 0 || (!listPending && hasDraftContent);
  /**
   * 有草稿时草稿箱默认展开，标题右侧紧贴的小按钮可以把内容区折叠起来；切换项目或进出
   * 来源任务语境时回到默认展开，换语境后先让人看见草稿，而不是继承上一个语境的收起态。
   */
  const [draftsCollapsed, setDraftsCollapsed] = useState(false);
  useEffect(() => {
    setDraftsCollapsed(false);
  }, [projectId, taskId]);
  const showDraftList = hasDraftContent && !draftsCollapsed;
  const reloadList = () =>
    void (taskId > 0
      ? sourceQuery.refetch()
      : isAllProjects
        ? myDrafts.refetch()
        : projectDrafts.refetch());
  /** 分页只存在于草稿列表：来源任务草稿是单页读取，没有下一页。 */
  const listHasMore =
    taskId > 0
      ? false
      : isAllProjects
        ? myDrafts.hasNextPage
        : projectDrafts.hasNextPage;
  const listFetchingMore =
    taskId > 0
      ? false
      : isAllProjects
        ? myDrafts.isFetchingNextPage
        : projectDrafts.isFetchingNextPage;
  const loadMore = () =>
    void (isAllProjects
      ? myDrafts.fetchNextPage()
      : projectDrafts.fetchNextPage());
  const detail = useQuery({
    queryKey: ["record-draft", projectId, recordId],
    queryFn: ({ signal }) =>
      api.getRecordDraft(projectId, recordId, { signal }),
    enabled: projectId > 0 && recordId > 0,
    retry: false,
  });
  // ADR-043：项目只有未开始 / 进行中 / 维护中且都可写；列表里还没有该项目时按只读处理。
  const pageProjectStatus = projects.data?.items.find(
    (p) => p.id === projectId,
  )?.status;
  /** 来源任务（URL 带 taskId 时）：弹窗目标、可写性与列表都以它为准。 */
  const source = taskId ? sourceQuery.data?.source : undefined;
  /** 来源任务已归档时草稿只读；目标项目状态由弹窗内部再叠加。 */
  const sourceWritable = !taskId || source?.lifecycleStatus === "ACTIVE";
  const writable =
    projectId > 0 && pageProjectStatus !== undefined && sourceWritable;
  /** 全部项目视图下只要存在可写项目即可发起创建，具体项目在弹窗内选定。 */
  const anyWritableProject = (projects.data?.items ?? []).length > 0;
  const canCreate =
    projectId > 0
      ? !!writable && (taskId === 0 || !!sourceQuery.data?.source)
      : taskId === 0 && anyWritableProject;
  useEffect(() => {
    onCanCreateChange?.(canCreate);
  }, [canCreate, onCanCreateChange]);
  // B-3a：项目选择器上移到页面 toolbar 后，切换项目时关闭弹窗；
  // 弹窗内的范围选择与冲突状态由组件按新项目重新初始化。
  const lastProjectId = useRef(projectId);
  useEffect(() => {
    if (lastProjectId.current === projectId) return;
    lastProjectId.current = projectId;
    setEditorTarget(null);
  }, [projectId]);
  // B-3a：页头 CTA（记录一次迭代 / 新建来源草稿）通过递增令牌打开同一个弹窗。
  const lastCreateToken = useRef(createToken);
  useEffect(() => {
    if (lastCreateToken.current === createToken) return;
    lastCreateToken.current = createToken;
    if (!canCreate) return;
    if (taskId && !source) return;
    setEditorTarget(
      source ? { kind: "source", source } : { kind: "independent" },
    );
  }, [createToken, canCreate, taskId, source]);
  /**
   * 打开某条草稿：URL 带上 recordId，交给既有的草稿详情弹层加载；taskId 语境
   * 下同时带上 moduleId / taskId，写入路径才会落在来源任务上。
   */
  const prefetchDraft = (item: DraftCardItem) => {
    const targetProjectId = item.draft.projectId;
    void cache.prefetchQuery({
      queryKey: ["record-draft", targetProjectId, item.draft.id],
      queryFn: ({ signal }) =>
        api.getRecordDraft(targetProjectId, item.draft.id, { signal }),
    });
    // 这里必须用 prefetchInfiniteQuery：列表钩子同 key 读取的是 { pages, pageParams }。
    // 若用 prefetchQuery 写入单页响应，切换到项目草稿时 getNextPageParam 会拿到
    // undefined 并触发错误边界，表现为整页瞬间消失。
    void cache.prefetchInfiniteQuery({
      queryKey: [
        "record-drafts",
        targetProjectId,
        RECORD_DRAFTS_PAGE_LIMIT,
        currentUserId ?? 0,
      ],
      queryFn: ({ pageParam, signal }) =>
        api.listRecordDrafts(
          targetProjectId,
          {
            limit: RECORD_DRAFTS_PAGE_LIMIT,
            ...(currentUserId === undefined ? {} : { authorId: currentUserId }),
            ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
          },
          signal ? { signal } : undefined,
        ),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage: {
        readonly hasMore: boolean;
        readonly nextCursor: string | null;
      }) => (lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined),
    });
  };
  const openDraft = (item: DraftCardItem) => {
    // 全部项目视图下草稿可能不属于 URL 里的项目：先切到它自己的项目再打开详情。
    setParams({
      projectId: String(item.draft.projectId),
      recordId: String(item.draft.id),
      ...(taskId
        ? { taskId: String(taskId), moduleId: String(sourceModuleId) }
        : {}),
    });
  };
  return (
    <section className="record-drafts-page" aria-label="迭代记录">
      {projects.isError && (
        <Alert
          type="error"
          title={recordDraftListErrorMessage(projects.error)}
          action={
            <Button onClick={() => void projects.refetch()}>重试项目</Button>
          }
        />
      )}
      {taskId > 0 && sourceQuery.data && (
        <div className="draft-source-head">
          <section aria-label="来源任务">
            <h2>{sourceQuery.data.source.title}</h2>
            <a
              href={`/projects/${projectId}/modules/${sourceModuleId}/tasks?taskId=${taskId}`}
            >
              返回来源任务
            </a>
            {" · "}
            <a href={`/records?projectId=${projectId}`}>项目全部草稿</a>
          </section>
        </div>
      )}
      {showDraftBox && (
        <CalmSectionTitle
          title={
            taskId > 0 ? "来源草稿" : isAllProjects ? "我的草稿" : "项目草稿"
          }
          titleSuffix={
            /**
             * 展开/收起只属于草稿箱（C 版，2026-10-09 定案）：箭头紧贴标题，
             * 覆盖整组的透明按钮负责命中，因此点标题或箭头都能折叠，收起时箭头转 -90°。
             */
            taskId === 0 ? (
              <>
                <InpulseIcon
                  name="chevronDown"
                  size={14}
                  className="draft-box-caret"
                />
                <button
                  type="button"
                  className="draft-box-hit"
                  aria-expanded={!draftsCollapsed}
                  {...(draftsCollapsed
                    ? { title: "展开草稿箱", "aria-label": "展开草稿箱" }
                    : {
                        title: "收起草稿箱",
                        "aria-label": "收起草稿箱",
                        "aria-controls": "record-draft-list",
                      })}
                  onClick={() => setDraftsCollapsed((value) => !value)}
                />
              </>
            ) : null
          }
        >
          {/* 来源任务视图的「新建来源草稿」仍留在标题行右侧。 */}
          {taskId > 0 ? (
            <div className="draft-box-actions">
              <Button
                className="primary-button"
                disabled={!writable}
                onClick={() =>
                  setEditorTarget(
                    source
                      ? { kind: "source", source }
                      : { kind: "independent" },
                  )
                }
              >
                新建来源草稿
              </Button>
            </div>
          ) : null}
        </CalmSectionTitle>
      )}
      {showDraftList && (
        <div id="record-draft-list">
          {listPending ? (
            <CalmSkeleton variant="list" rows={3} label="正在加载草稿" />
          ) : listFailed ? (
            <Alert
              type="error"
              title={recordDraftListErrorMessage(listError)}
              action={<Button onClick={reloadList}>重试草稿列表</Button>}
            />
          ) : (
            <div className="draft-card-grid">
              {draftCards.map((item) => (
                <button
                  type="button"
                  className="draft-card"
                  key={item.draft.id}
                  aria-label={`继续编辑草稿：${item.draft.title}`}
                  onPointerEnter={() => prefetchDraft(item)}
                  onPointerDown={() => prefetchDraft(item)}
                  onFocus={() => prefetchDraft(item)}
                  onClick={() => openDraft(item)}
                >
                  <span className="draft-card-top">
                    <CalmBadge tone="amber">草稿</CalmBadge>
                  </span>
                  <strong className="draft-card-title">
                    {item.draft.title}
                  </strong>
                  <span className="draft-card-meta">
                    <span className="draft-card-scope">
                      {item.projectName === null
                        ? ""
                        : item.projectName + " / "}
                      {item.moduleName ?? "名称暂不可用"}
                    </span>
                    <span className="draft-card-author">
                      <span className="draft-card-avatar" aria-hidden="true">
                        {(item.authorName ?? "?").slice(0, 1)}
                      </span>
                      {item.authorName ?? "名称暂不可用"}
                    </span>
                    <span className="draft-card-time">
                      更新 {formatBeijingShortDateTime(item.draft.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {listHasMore && (
            <div className="record-load-more">
              <Button disabled={listFetchingMore} onClick={loadMore}>
                {listFetchingMore ? "正在加载…" : "加载更多"}
              </Button>
            </div>
          )}
        </div>
      )}
      <Modal
        className={
          detail.isPending
            ? "draft-detail-modal is-loading"
            : "draft-detail-modal"
        }
        open={recordId > 0 && editorTarget === null}
        label="草稿详情"
        eyebrow="草稿"
        /* 加载态先用占位标题顶住头部高度，数据到达时头部不再长高一截；
           失败态没有标题可显示，仍按原来的「无标题」处理。 */
        title={
          detail.data !== undefined ? (
            detail.data.title
          ) : detail.isPending ? (
            <span
              className="calm-sk draft-detail-sk-title"
              aria-hidden="true"
            />
          ) : undefined
        }
        body
        size="lg"
        onCancel={() => {
          const next = new URLSearchParams(params);
          next.delete("recordId");
          setParams(next);
        }}
        footer={
          detail.data === undefined ? null : (
            <>
              <p className="draft-detail-note">
                草稿尚未发布，不计入正式迭代统计。
              </p>
              <Button
                disabled={!writable}
                onClick={() => {
                  if (detail.data) {
                    setEditorTarget({ kind: "item", item: detail.data });
                  }
                }}
              >
                继续编辑
              </Button>
              <PublishRecordButton
                item={detail.data}
                api={api}
                writable={!!writable}
              />
            </>
          )
        }
      >
        {recordId > 0 &&
          (detail.isPending ? (
            <CalmSkeleton variant="lines" rows={4} label="正在加载草稿详情" />
          ) : detail.isError ? (
            <Alert type="error" title={recordDraftErrorMessage(detail.error)} />
          ) : (
            detail.data && (
              <section className="draft-detail" aria-label="草稿详情">
                <dl className="record-facts draft-detail-facts">
                  <dt>归属</dt>
                  <dd>
                    {projects.data?.items.find(
                      (p) => p.id === detail.data.projectId,
                    )?.name ?? "名称暂不可用"}
                    {" / "}
                    {detail.data.moduleName ?? "名称暂不可用"}
                  </dd>
                  <dt>人员</dt>
                  <dd>
                    处理人 {detail.data.handlerName ?? "名称暂不可用"} ·
                    记录作者 {detail.data.authorName ?? "名称暂不可用"}
                  </dd>
                </dl>
                {fields
                  .filter((field) => field !== "title")
                  .map((field) => (
                    <section key={field}>
                      <h3>{labels[field]}</h3>
                      <RecordMarkdown
                        content={
                          fieldText(detail.data, field) || "暂无已知遗留问题"
                        }
                      />
                    </section>
                  ))}
                <div className="draft-detail-links">
                  <ExternalLinksPanel
                    key={detail.data.id}
                    targetType="CHANGE_RECORD"
                    targetId={detail.data.id}
                    client={api}
                  />
                  {detail.data.taskId !== null && (
                    <a
                      className="secondary-button"
                      href={`/records?projectId=${projectId}&moduleId=${detail.data.moduleId}&taskId=${detail.data.taskId}`}
                    >
                      <InpulseIcon name="cornerDown" size={14} />
                      查看此任务的全部草稿
                    </a>
                  )}
                </div>
              </section>
            )
          ))}
      </Modal>
      <RecordDraftEditorModal
        api={api}
        target={editorTarget}
        projectId={projectId}
        defaultModuleId={Number(params.get("moduleId")) || 0}
        writable={sourceWritable}
        onClose={() => setEditorTarget(null)}
        // 删除草稿后详情弹层仍在按 URL 的 recordId 取值：一并清掉，避免展示已删草稿。
        onDeleted={() => {
          const next = new URLSearchParams(params);
          next.delete("recordId");
          setParams(next);
        }}
        onSaved={(draft, published) => {
          setEditorTarget(null);
          // 「新建迭代」发布成功后直接落到正式记录，不再打开草稿详情。
          setParams(
            published
              ? {
                  projectId: String(published.projectId),
                  publishedId: String(published.id),
                  ...(taskId
                    ? {
                        taskId: String(taskId),
                        moduleId: String(sourceModuleId),
                      }
                    : {}),
                }
              : {
                  projectId: String(draft.projectId),
                  recordId: String(draft.id),
                  ...(taskId
                    ? {
                        taskId: String(taskId),
                        moduleId: String(sourceModuleId),
                      }
                    : {}),
                },
          );
        }}
      />
    </section>
  );
}

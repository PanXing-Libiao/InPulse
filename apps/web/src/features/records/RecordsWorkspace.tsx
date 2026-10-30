import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button } from "antd";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { createApiClient, type InpulseApiClient } from "@generated/api";
import {
  CalmEmptyState,
  CalmSegmented,
} from "@features/common/components/Calm";
import { BackToTop } from "@features/common/components/BackToTop";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { projectSelectOption } from "@features/common/project-select-option";
import { useAuth } from "@features/auth/auth-context";
import { useScopedSearchParams } from "@features/common/search-params-scope";
import { useStickyBandOffset } from "@features/common/use-sticky-band-offset";
import { RecordDraftsView } from "@features/record-drafts/RecordDraftsView";
import {
  useRecordFeedQuery,
  type RecordFeedStatus,
} from "@features/published-records/published-records-query";
import {
  PublishedRecordDetail,
  publishedRecordErrorMessage,
} from "@features/published-records/PublishedRecordDetail";
import { PublishedRecordCard } from "./PublishedRecordCard";
import { RecordSummaryModal } from "./RecordSummaryModal";
import {
  groupRecordsByDate,
  RECORD_SEARCH_PLACEHOLDER,
  RECORD_SOURCE_FILTERS,
  timelineDayLabel,
  timelineTimeLabel,
  type RecordSourceFilter,
} from "./record-timeline";
import "./records-timeline.css";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

/** 关键词下发前的防抖窗口（毫秒），与既有搜索交互保持同一节奏。 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * 深链定位记录时最多自动加载的页数（含首页）。
 * 记录可能排在「加载更多」之后的页里，只渲染已加载页会让用户看到列表顶部、
 * 目标记录孤零零挂在最下面；自动续拉到上限后仍找不到才退回独立详情。
 */
const RECORD_DEEP_LINK_MAX_PAGES = 5;

/**
 * B-3a：`/records` 单页工作区（设计师稿 views/records.tsx 的结构）。
 * B-3b：项目下拉增加「全部项目」并作为默认视图（跨项目记录清单 + 名称回填），
 * 来源五档与关键词 `q` 改为服务端筛选，我的草稿条带改为全局 `listMyRecordDrafts`；
 * 页头 CTA → 我的草稿条带 → 项目草稿与草稿详情 → 筛选 toolbar → 按发布日分组。
 * 「全部项目」下 CTA 仍可用：草稿按项目 + 模块创建，目标项目在弹窗内选定；
 * URL 已选项目时弹窗直接沿用该项目。
 */
export function RecordsWorkspace({
  client,
  embedded = false,
}: {
  readonly client?: InpulseApiClient | undefined;
  /** 嵌在项目主页弹窗内：标题由弹层头部承担，页头只保留 CTA。 */
  readonly embedded?: boolean | undefined;
}) {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const { user } = useAuth();
  // 整页用路由搜索参数；装进项目主页弹窗时用作用域内的本地状态。
  const [params, setParams] = useScopedSearchParams();
  const projectId = Number(params.get("projectId")) || 0;
  const publishedId = Number(params.get("publishedId")) || 0;
  const requestedStatus = params.get("status");
  const status: RecordFeedStatus =
    user?.isAdmin && (requestedStatus === "VOID" || requestedStatus === "ALL")
      ? requestedStatus
      : "PUBLISHED";
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [source, setSource] = useState<RecordSourceFilter>("ALL");
  const [createToken, setCreateToken] = useState(0);
  /** F-33 迭代总结弹窗；只在打开时取数，不影响列表与草稿的任何请求。 */
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  /** 时间线按天折叠：记录日期键集合，默认全部展开。 */
  const [collapsedDays, setCollapsedDays] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** 发布后独立详情会切到时间线卡片，关联区展开状态必须由页面持有，避免重建时折叠。 */
  const [githubOpenRecordId, setGithubOpenRecordId] = useState(0);
  const toggleDay = (key: string) =>
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  useEffect(() => {
    const timer = window.setTimeout(
      () => setTerm(query.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [query]);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => api.listProjects({ signal }),
    retry: false,
  });
  const list = useRecordFeedQuery({
    client,
    projectId,
    status,
    source,
    query: term,
  });
  const items = list.data?.pages.flatMap((page) => [...page.items]) ?? [];
  const groups = groupRecordsByDate(items);
  /** 深链目标已经在已加载页里时由时间线卡片原地展开，不需要额外定位。 */
  const recordInItems = items.some((item) => item.record.id === publishedId);
  const pagesLoaded = list.data?.pages.length ?? 0;
  /** 目标记录还没出现且可能还在后续页：自动续拉（有上限，不为一条记录拉完整库）。 */
  const locatingRecord =
    publishedId > 0 &&
    projectId > 0 &&
    !list.isPending &&
    !list.isError &&
    !recordInItems &&
    list.hasNextPage &&
    !list.isFetchNextPageError &&
    pagesLoaded < RECORD_DEEP_LINK_MAX_PAGES;
  useEffect(() => {
    // 只由状态驱动续拉：isFetchingNextPage 同时挡住重复请求，
    // pagesLoaded 保证每拿到一页都能继续推进（并发批次里仅在 in-flight 标志上自旋会卡死）。
    if (!locatingRecord || list.isFetchingNextPage) return;
    void list.fetchNextPage();
  }, [
    locatingRecord,
    list.isFetchingNextPage,
    list.fetchNextPage,
    pagesLoaded,
  ]);
  const projectStatus = useMemo(
    () =>
      new Map(
        (projects.data?.items ?? []).map(
          (item) => [item.id, item.status] as const,
        ),
      ),
    [projects.data],
  );
  /** 跨项目视图下每条记录按自身项目的状态判定可写，避免误用当前所选项目。 */
  const canWrite = (recordProjectId: number) => {
    // ADR-043：项目只有未开始 / 进行中 / 维护中且都可写；列表里没有该项目时按只读处理。
    return projectStatus.has(recordProjectId);
  };
  const reportCanCreate = useCallback((next: boolean) => {
    setCanCreate((prev) => (prev === next ? prev : next));
  }, []);
  /**
   * 记录状态筛选：非管理员只有「已发布」这一档，单选控件没有可选项，整块不渲染。
   * 「已作废 / 全部」是管理员的回溯入口，仍然保留。
   */
  const statusOptions = useMemo<
    ReadonlyArray<{ readonly value: RecordFeedStatus; readonly label: string }>
  >(
    () =>
      user?.isAdmin
        ? [
            { value: "PUBLISHED", label: "已发布" },
            { value: "VOID", label: "已作废" },
            { value: "ALL", label: "全部" },
          ]
        : [{ value: "PUBLISHED", label: "已发布" }],
    [user?.isAdmin],
  );
  const filtered = term.length > 0 || source !== "ALL";
  /** 记录不在筛选范围内（例如已作废记录落在「已发布」筛选）或超出续拉上限时的兜底详情。 */
  const standaloneDetail =
    projectId > 0 &&
    publishedId > 0 &&
    !list.isPending &&
    !recordInItems &&
    !locatingRecord;
  const selectProject = (value: string) => {
    const next = new URLSearchParams(params);
    if (Number(value) > 0) next.set("projectId", value);
    else next.delete("projectId");
    next.delete("publishedId");
    next.delete("recordId");
    setParams(next);
  };
  const selectStatus = (next: RecordFeedStatus) => {
    const nextParams = new URLSearchParams(params);
    if (next === "PUBLISHED") nextParams.delete("status");
    else nextParams.set("status", next);
    nextParams.delete("publishedId");
    setParams(nextParams);
  };
  const toggleRecord = (id: number, open: boolean) => {
    if (!open && githubOpenRecordId === id) setGithubOpenRecordId(0);
    const nextParams = new URLSearchParams(params);
    if (open && Number(nextParams.get("publishedId")) !== id)
      nextParams.set("publishedId", String(id));
    else if (!open && Number(nextParams.get("publishedId")) === id)
      nextParams.delete("publishedId");
    else return;
    setParams(nextParams, { replace: true });
  };
  // 从搜索等入口深链打开记录时把它滚进视野：目标可能是列表下方独立详情，
  // 也可能是列表里很靠后的一张卡，不滚动的话用户只看到列表顶部，
  // 会以为「没跳到对应记录」。每个 publishedId 只滚一次，已在视野内不动页面。
  const scrolledRecord = useRef(0);
  useEffect(() => {
    if (publishedId <= 0 || scrolledRecord.current === publishedId) return;
    const anchor = document.querySelector(
      `[data-record-anchor="${publishedId}"]`,
    );
    if (!anchor) return;
    scrolledRecord.current = publishedId;
    const rect = anchor.getBoundingClientRect();
    if (rect.top >= 0 && rect.top < window.innerHeight) return;
    anchor.scrollIntoView({ block: "start" });
  }, [publishedId, standaloneDetail, items]);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  // 量出的吸顶块高度写进页面根的 CSS 变量，供 `.timeline-day-head` 的 top 使用。
  // 弹窗（embedded）里正文是弹层自己的滚动区，吸顶同样成立，也要量。
  useStickyBandOffset(pageRef, bandRef);

  /**
   * 链接里的 projectId 不在当前账号可读的项目列表里（旧链接、项目已删除、已被移出成员）：
   * 跨项目记录清单会静默排掉非成员项目，项目级草稿读取却按资源语义返回 404，
   * 照常渲染会同时出现「草稿箱红条 + 记录红条 + 空态」三条互相矛盾的内容。
   * 这里整页只留一条说明，草稿箱整块不挂载，不再下发项目级请求。
   */
  const projectOutOfScope =
    !embedded &&
    projectId > 0 &&
    projects.isSuccess &&
    !(projects.data?.items ?? []).some((item) => item.id === projectId);
  if (projectOutOfScope) {
    return (
      <div className="records-workspace" ref={pageRef}>
        <div className="page-header">
          <div>
            <h1>迭代记录</h1>
            <p>
              只记录已经发生或已确认的变化。人员、时间、归属与版本全部自动生成。
            </p>
          </div>
        </div>
        <CalmEmptyState
          icon="gitBranch"
          title="项目不存在或你已无权访问"
          description="链接里的项目可能已被删除，或你已不在成员名单中。"
        >
          <Button onClick={() => setParams(new URLSearchParams())}>
            查看全部迭代记录
          </Button>
        </CalmEmptyState>
      </div>
    );
  }

  return (
    <div
      className={
        embedded ? "records-workspace is-embedded" : "records-workspace"
      }
      ref={pageRef}
    >
      {/* 2026-10-08 用户要求：页面滚动只滚动红线以下的区域——标题与筛选条吸顶，
          草稿与时间线在其下方滚动（样式见 inpulse-design.css 的 .sticky-page-band）。
          项目主页弹窗里是弹层内部滚动，吸顶与回到顶部按钮都锚在这个滚动区上。 */}
      <div
        className={
          embedded ? "sticky-page-band is-embedded" : "sticky-page-band"
        }
        ref={bandRef}
      >
        {/* 2026-10-08 产品要求：新建入口与搜索、筛选用同一行，页头只剩标题。
            弹层（embedded）里标题由弹层头部承担，页头整块不再渲染。 */}
        {embedded ? null : (
          <div className="page-header">
            <div>
              <h1>迭代记录</h1>
              <p>
                只记录已经发生或已确认的变化。人员、时间、归属与版本全部自动生成。
              </p>
            </div>
          </div>
        )}
        <div className="toolbar task-toolbar records-toolbar">
          <div className="task-search">
            <InpulseIcon name="search" size={16} />
            <input
              value={query}
              placeholder={RECORD_SEARCH_PLACEHOLDER}
              aria-label="搜索迭代记录"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {/* 2026-10-09 用户指示：去掉筛选框前面的灰色「项目」「归属」文字，
              可访问名仍由 CalmSelect 的 ariaLabel 提供，外层 label 与
              .records-toolbar-field 一并删除。 */}
          {embedded ? null : (
            <CalmSelect
              ariaLabel="项目"
              value={projectId > 0 ? String(projectId) : ""}
              onChange={(next) => selectProject(String(next))}
              appearance="rich"
              options={[
                { value: "", label: "全部项目" },
                ...(projects.data?.items ?? []).map(projectSelectOption),
              ]}
              animated
            />
          )}
          <CalmSelect
            ariaLabel="归属"
            value={source}
            appearance="menu"
            onChange={(next) => setSource(next as RecordSourceFilter)}
            options={RECORD_SOURCE_FILTERS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            animated
          />
          {statusOptions.length > 1 ? (
            <CalmSegmented
              label="记录状态"
              value={status}
              options={statusOptions}
              onChange={selectStatus}
            />
          ) : null}
          {/* F-33：生成总结与筛选同一行并靠右顶格；包一层 div 避免命中
            `.task-toolbar > .secondary-button { display: none }` 的全局隐藏规则。
            2026-10-08 产品要求「新建迭代记录」也进这一行，主操作放最右端。 */}
          <div className="records-toolbar-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSummaryOpen(true)}
            >
              <InpulseIcon name="fileText" size={15} />
              生成总结
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!canCreate}
              title={
                canCreate
                  ? undefined
                  : projectId === 0
                    ? "当前没有可写入的项目"
                    : "请先选择项目"
              }
              onClick={() => setCreateToken((token) => token + 1)}
            >
              <InpulseIcon name="plus" size={16} />
              新建迭代记录
            </button>
          </div>
        </div>
      </div>
      <div className="record-drafts-block">
        <RecordDraftsView
          client={client}
          createToken={createToken}
          currentUserId={user?.id}
          currentUserName={user?.name}
          onCanCreateChange={reportCanCreate}
        />
      </div>
      {projects.isError && (
        <Alert
          type="error"
          title="项目列表加载失败，请重试。"
          action={
            <Button onClick={() => void projects.refetch()}>重试项目</Button>
          }
        />
      )}
      {standaloneDetail && (
        <section
          className="record-standalone-detail"
          data-record-anchor={publishedId}
        >
          <PublishedRecordDetail
            projectId={projectId}
            recordId={publishedId}
            client={client}
            writable={canWrite(projectId)}
            standalone
            onListChanged={() => void list.refetch()}
            githubOpen={githubOpenRecordId === publishedId}
            onGithubOpenChange={(open) =>
              setGithubOpenRecordId(open ? publishedId : 0)
            }
          />
        </section>
      )}
      {list.isPending ? (
        <CalmSkeleton variant="list" rows={3} label="正在加载记录" />
      ) : list.isError ? (
        <Alert
          type="error"
          title={publishedRecordErrorMessage(list.error)}
          action={
            <Button onClick={() => void list.refetch()}>重试记录列表</Button>
          }
        />
      ) : !items.length ? (
        <CalmEmptyState
          icon="gitBranch"
          title={
            filtered
              ? "没有匹配的迭代记录"
              : status === "VOID"
                ? "暂无已作废记录"
                : "暂无已发布记录"
          }
          description={
            filtered
              ? "调整筛选条件，或从模块任务中记录一次已经发生的变化。"
              : "草稿发布后会出现在这里。"
          }
        />
      ) : (
        <div className="record-timeline">
          {groups.map((group) => {
            const collapsed =
              collapsedDays.has(group.key) &&
              !group.records.some((item) => item.record.id === publishedId);
            return (
              <section className="timeline-block" key={group.key}>
                <span aria-hidden="true" className="timeline-day">
                  {timelineDayLabel(group.key)}
                </span>
                {/* 2026-10-08 用户要求「日期先不被滚走，等当天的内容滚完了再收起来」：
                    折叠按钮包成一行分组头并吸顶（样式见 records-timeline.css）。 */}
                <div className="timeline-day-head">
                  <button
                    type="button"
                    className="timeline-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => toggleDay(group.key)}
                  >
                    <InpulseIcon
                      name="chevron"
                      size={14}
                      {...(collapsed ? {} : { className: "expanded" })}
                    />
                    <strong>{group.label}</strong>
                    <small>{group.records.length} 条</small>
                  </button>
                </div>
                {!collapsed && (
                  <div className="record-card-list">
                    {group.records.map((item) => (
                      <div
                        className="timeline-item"
                        data-record-anchor={item.record.id}
                        key={item.record.id}
                      >
                        <span aria-hidden="true" className="timeline-time">
                          {timelineTimeLabel(item.record.publishedAt)}
                        </span>
                        <PublishedRecordCard
                          item={item}
                          client={client}
                          writable={canWrite(item.record.projectId)}
                          open={publishedId === item.record.id}
                          onToggle={(open) =>
                            toggleRecord(item.record.id, open)
                          }
                          onListChanged={() => void list.refetch()}
                          githubOpen={githubOpenRecordId === item.record.id}
                          onGithubOpenChange={(open) =>
                            setGithubOpenRecordId(open ? item.record.id : 0)
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <RecordSummaryModal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        client={client}
        defaultProjectId={projectId}
        projects={projects.data?.items ?? []}
      />
      {list.hasNextPage && (
        <div className="record-load-more">
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? "正在加载…" : "加载更多"}
          </Button>
        </div>
      )}
      {/* 弹层里正文是弹层自己的滚动区，按钮要锚在它上面（见 BackToTop 的 inset）。 */}
      <BackToTop inset={embedded} />
    </div>
  );
}

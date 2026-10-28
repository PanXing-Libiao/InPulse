import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "antd";
import {
  createApiClient,
  type InpulseApiClient,
  type LeftoverListItem,
} from "@generated/api";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { ProjectLogo } from "@features/common/components/ProjectLogo";
import { useScopedSearchParams } from "@features/common/search-params-scope";
import { CalmBadge, CalmEmptyState } from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { projectSelectOption } from "@features/common/project-select-option";
import {
  LeftoverTaskConvertModal,
  type LeftoverConvertTarget,
} from "@features/published-records/ConvertLeftoverTask";
import {
  RecordDetailModal,
  recordDetailTarget,
} from "@features/published-records/RecordDetailModal";
import { useProjects } from "@features/projects/project-query";
import type { TaskLocation } from "@features/tasks/task-links";
import {
  isLeftoverClosed,
  issueOriginParts,
  leftoverStatusText,
  leftoverStatusTone,
} from "./issues-format";
import { describeIssuesError, useLeftoverItemsQuery } from "./issues-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import {
  DeleteLeftoverItemModal,
  type DeleteLeftoverTarget,
} from "./DeleteLeftoverItemModal";

/**
 * F-20 遗留问题页（R-6）：未处理与已处理 / 已作废两个分桶各自按服务端签名游标
 * 分页，行内保留来源记录与来源 / 跟进任务引用，未处理项可直接转为跟进任务（复用
 * 已发布记录页的转换弹窗：CSRF、If-Match 与幂等键语义完全一致）。
 * 项目筛选与迭代记录页同口径：projectId 进 URL（服务端参数），0 表示全部项目。
 *
 * CLOSED 桶按服务端口径同时包含 CONVERTED / RESOLVED（已处理）与父记录 VOID
 * 派生的 VOIDED（已作废），因此「转为任务」入口只出现在未处理项；已处理或
 * 已作废且无跟进任务的行不再提供无法完成的入口。
 *
 * 未处理且没有跟进任务的 ACTIVE 项可「删除」：确认后创建新的正式记录版本并把该项
 * 标记为 RESOLVED，历史版本、来源记录与审计全部保留，不做物理删除。
 */

/**
 * 遗留问题正文：默认截 2 行，只有真正溢出时才出现「展开 / 收起」。
 * 卡片正文区固定 2 行高度，让 1 行与 2 行的条目保持同一卡片高度；
 * 展开按钮所在行始终占位，避免出现按钮时把来源行往下顶。
 */
const IssueContentBlock: React.FC<{
  readonly content: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}> = ({ content, expanded, onToggle }) => {
  const ref = useRef<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    // 展开状态下 clamp 已移除，量不出溢出；保留上一次的判断才能继续「收起」。
    if (expanded) return;
    const element = ref.current;
    if (element === null) return;
    const measure = () =>
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    // 窗口变窄或侧栏展开时正文会重新换行，溢出判断要跟着更新。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, expanded]);
  return (
    <>
      <strong
        ref={ref}
        className={"issue-content" + (expanded ? " is-expanded" : "")}
      >
        {content}
      </strong>
      <div className="issue-expand-row">
        {overflowing ? (
          <button
            type="button"
            className="issue-expand"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
      </div>
    </>
  );
};

export interface IssuesPageViewProps {
  readonly client?: InpulseApiClient;
  readonly onBackToRecords?: () => void;
  readonly onOpenTask?: (task: TaskLocation) => void;
  /** 嵌在项目主页弹窗内：标题由弹层头部承担，不渲染整页页头。 */
  readonly embedded?: boolean | undefined;
}

export const IssuesPageView: React.FC<IssuesPageViewProps> = ({
  client,
  onBackToRecords,
  onOpenTask,
  embedded = false,
}) => {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const [params, setParams] = useScopedSearchParams();
  /** 项目筛选：projectId 进 URL，非正整数一律回落为全部项目。 */
  const projectId = Number(params.get("projectId")) || 0;
  const projects = useProjects({ client });
  const [convertTarget, setConvertTarget] =
    useState<LeftoverConvertTarget | null>(null);
  /** 删除 = 从当前记录版本移除并标记已解决；确认框负责说明历史保留。 */
  const [deleteTarget, setDeleteTarget] = useState<DeleteLeftoverTarget | null>(
    null,
  );

  /** 正文超过 2 行的条目才出现「展开」；按遗留项 id 记录展开状态。 */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  const toggleExpanded = (leftoverItemId: number) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(leftoverItemId)) next.delete(leftoverItemId);
      else next.add(leftoverItemId);
      return next;
    });
  };
  const openQuery = useLeftoverItemsQuery({
    client,
    bucket: "OPEN",
    projectId,
  });
  const closedQuery = useLeftoverItemsQuery({
    client,
    bucket: "CLOSED",
    projectId,
  });
  /**
   * 「来源迭代」入口：点击就地打开这条来源记录的详情弹窗（与任务详情的「查看来源记录」
   * 同一实现），不再跳到来源任务；来源任务仍可从记录详情里的「查看来源任务」进入。
   * 列表项契约只给记录编号 / 标题 / 发布时间，不含记录状态（PUBLISHED / VOID），而弹窗的
   * 作废回退依赖状态，因此点开时按 recordId 二次读取记录；读取完成前不渲染弹层，避免先弹
   * 出上一个记录的旧数据。
   */
  const [sourceRecord, setSourceRecord] = useState<{
    readonly projectId: number;
    readonly recordId: number;
  } | null>(null);
  const sourceRecordProjectId = sourceRecord?.projectId ?? 0;
  const sourceRecordId = sourceRecord?.recordId ?? 0;
  const sourceRecordQuery = useQuery({
    queryKey: ["leftover-source-record", sourceRecordProjectId, sourceRecordId],
    queryFn: ({ signal }) =>
      api.getChangeRecord(sourceRecordProjectId, sourceRecordId, { signal }),
    enabled: sourceRecord !== null,
    retry: false,
  });
  const sourceRecordData = sourceRecordQuery.data;
  const sourceRecordTarget =
    sourceRecord === null ||
    sourceRecordData === undefined ||
    sourceRecordData.id !== sourceRecord.recordId
      ? null
      : recordDetailTarget(sourceRecordData);
  /**
   * 来源行行首的项目标识取项目编码前两位，色系由编码派生（与项目列表页同一个
   * ProjectLogo）。本页已用 useProjects 取过项目列表给筛选器，这里直接复用同一份
   * 数据做 projectId → code 映射，不再多发请求；契约上 LeftoverListItem 不带项目
   * 编码，若项目不在可见列表中则降级为只渲染项目名。
   */
  const projectCodeById = useMemo(() => {
    const map = new Map<number, string>();
    for (const project of projects.data?.items ?? []) {
      if (typeof project.code === "string" && project.code.length > 0) {
        map.set(project.id, project.code);
      }
    }
    return map;
  }, [projects.data]);

  const openItems =
    openQuery.data?.pages.flatMap((page) => [...page.items]) ?? [];
  const closedItems =
    closedQuery.data?.pages.flatMap((page) => [...page.items]) ?? [];

  const selectProject = (value: string) => {
    const next = new URLSearchParams(params);
    if (Number(value) > 0) next.set("projectId", value);
    else next.delete("projectId");
    setParams(next, { replace: true });
  };

  const renderRow = (item: LeftoverListItem) => {
    const closed = isLeftoverClosed(item);
    const followupTask = item.followupTask;
    const origin = issueOriginParts(item);
    const projectCode = projectCodeById.get(item.projectId);
    return (
      <article
        className="issue-row"
        key={item.leftoverItemId}
        data-testid={"leftover-item-" + item.leftoverItemId}
      >
        <div className="issue-main">
          <div className="issue-head">
            <CalmBadge tone={leftoverStatusTone(item.status)}>
              {leftoverStatusText(item.status)}
            </CalmBadge>
            <span className="task-id">{item.recordCode}</span>
          </div>
          <IssueContentBlock
            content={item.content}
            expanded={expandedIds.has(item.leftoverItemId)}
            onToggle={() => toggleExpanded(item.leftoverItemId)}
          />
          {/* 来源行：项目标识 + 项目名 + 记录 / 位置 / 作者 / 日期（2026-10-10 用户指示）。 */}
          <p className="issue-origin">
            {projectCode === undefined ? null : (
              <ProjectLogo code={projectCode} className="tiny" />
            )}
            <strong className="origin-project">{origin.projectName}</strong>
            {" · " + origin.detail}
          </p>
        </div>
        <div className="issue-actions">
          {/* 来源迭代（2026-10-10 用户指示）：原「来源任务 <编号>」按钮改为「来源迭代」，
              点击就地打开这条来源记录的详情弹窗，不再跳来源任务。 */}
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              setSourceRecord({
                projectId: item.projectId,
                recordId: item.recordId,
              })
            }
          >
            <InpulseIcon name="fileText" size={14} />
            来源迭代
          </button>
          {followupTask === null ? (
            closed ? null : (
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  setConvertTarget({
                    projectId: item.projectId,
                    moduleId: item.moduleId,
                    featureId: item.featureId,
                    recordId: item.recordId,
                    recordTitle: item.recordTitle,
                    leftoverItemId: item.leftoverItemId,
                  })
                }
              >
                <InpulseIcon name="zap" size={14} />
                转为任务
              </button>
            )
          ) : (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                onOpenTask?.({
                  projectId: followupTask.projectId,
                  moduleId: followupTask.moduleId,
                  featureId: followupTask.featureId,
                  taskId: followupTask.taskId,
                })
              }
            >
              查看跟进任务 {followupTask.code}
              <InpulseIcon name="chevronRight" size={14} />
            </button>
          )}
        </div>
        {closed || followupTask !== null ? null : (
          <button
            type="button"
            className="issue-delete-button"
            aria-label="删除遗留问题"
            title="删除遗留问题"
            onClick={() =>
              setDeleteTarget({
                projectId: item.projectId,
                recordId: item.recordId,
                recordCode: item.recordCode,
                leftoverItemId: item.leftoverItemId,
                content: item.content,
              })
            }
          >
            <InpulseIcon name="trash" size={15} />
          </button>
        )}
      </article>
    );
  };

  return (
    <section
      className="issues-page"
      aria-label="遗留问题"
      data-testid="issues-page"
    >
      {embedded ? null : (
        <div className="sticky-page-band">
          <div className="page-header">
            <div>
              <h1>遗留问题</h1>
              <p>
                迭代记录中「遗留问题」一栏写下的内容会汇总到这里，确认影响范围后转为可执行任务。
              </p>
            </div>
          </div>
          {/* 2026-10-28 用户要求与迭代记录页统一布局：页头只保留标题，项目筛选
              与「回到迭代记录」移到下方工具栏，返回操作靠右。 */}
          <div className="toolbar issues-toolbar">
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
            {onBackToRecords === undefined ? null : (
              <div className="issues-toolbar-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onBackToRecords}
                >
                  <InpulseIcon name="gitBranch" size={15} />
                  回到迭代记录
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 未处理分档标题（含条数与排序说明）2026-10-10 按用户指示整条删除：这一
          档的卡片本来就都带「未处理」徽章，标题属于重复信息，条数与排序说明用户
          确认不重要。已处理 / 已作废那档的标题是折叠区开关，仍然保留。 */}
      {openQuery.isPending ? (
        <CalmSkeleton variant="list" rows={4} label="正在加载遗留问题…" />
      ) : openQuery.isError ? (
        <Alert type="error" title={describeIssuesError(openQuery.error)} />
      ) : openItems.length === 0 ? (
        <CalmEmptyState
          icon="check"
          title="没有未处理的遗留问题"
          description={
            projectId > 0
              ? "该项目记录的遗留事项都已处理或作废。"
              : "所有记录的遗留事项都已处理或作废。"
          }
        />
      ) : (
        <>
          <div className="issue-list">{openItems.map(renderRow)}</div>
          {openQuery.hasNextPage ? (
            <div className="issue-load-more">
              <button
                type="button"
                className="secondary-button"
                disabled={openQuery.isFetchingNextPage}
                onClick={() => void openQuery.fetchNextPage()}
              >
                {openQuery.isFetchingNextPage ? "正在加载…" : "加载更多"}
              </button>
            </div>
          ) : null}
        </>
      )}

      {closedItems.length > 0 || closedQuery.isError ? (
        <details className="calm-disclosure history-block">
          <summary>
            {"已处理或已作废 " + String(closedItems.length) + " 条"}
          </summary>
          {closedQuery.isError ? (
            <Alert
              type="error"
              title={describeIssuesError(closedQuery.error)}
            />
          ) : (
            <>
              <div className="issue-list">{closedItems.map(renderRow)}</div>
              {closedQuery.hasNextPage ? (
                <div className="issue-load-more">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={closedQuery.isFetchingNextPage}
                    onClick={() => void closedQuery.fetchNextPage()}
                  >
                    {closedQuery.isFetchingNextPage ? "正在加载…" : "加载更多"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </details>
      ) : null}

      {/* 「问题不是任务」说明：2026-09-24 按产品要求从页面顶部移到底部。 */}
      <div className="callout issues-callout">
        <InpulseIcon name="alert" size={18} />
        <div>
          <strong>问题不是任务</strong>
          <p>
            转为任务时系统会自动带入来源项目、模块、功能与遗留问题描述，并把来源问题标记为已处理；原记录内容不会被修改。删除只会把问题移入已处理，来源记录与历史版本同样保留。
          </p>
        </div>
      </div>

      {sourceRecordTarget === null ? null : (
        <RecordDetailModal
          projectId={sourceRecordProjectId}
          record={sourceRecordTarget}
          api={api}
          onClose={() => setSourceRecord(null)}
          onChanged={() => void sourceRecordQuery.refetch()}
          onOpenTask={onOpenTask}
        />
      )}

      {convertTarget === null ? null : (
        <LeftoverTaskConvertModal
          target={convertTarget}
          api={api}
          open={true}
          onClose={() => setConvertTarget(null)}
          onConverted={(created) => {
            setConvertTarget(null);
            onOpenTask?.({
              projectId: created.projectId,
              moduleId: created.moduleId,
              featureId: created.featureId,
              taskId: created.taskId,
            });
          }}
        />
      )}

      {deleteTarget === null ? null : (
        <DeleteLeftoverItemModal
          target={deleteTarget}
          api={api}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
};

export default IssuesPageView;

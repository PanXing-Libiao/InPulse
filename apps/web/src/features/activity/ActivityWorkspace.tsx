import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  ActivityItem,
  AuditLogItem,
  InpulseApiClient,
} from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSectionTitle,
} from "@features/common/components/Calm";
import { BackToTop } from "@features/common/components/BackToTop";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { projectSelectOption } from "@features/common/project-select-option";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { useStickyBandOffset } from "@features/common/use-sticky-band-offset";
import { useProjects } from "@features/projects/project-query";
import { prefetchTaskCenterRoute } from "@features/my-tasks/my-tasks-query";
import { prefetchRecordsRoute } from "@features/records/records-route-prefetch";
import { prefetchModulesRoute } from "@features/modules/module-query";
import { prefetchProjectMembersRoute } from "@features/projects/project-member-query";
import { preloadRoutePath } from "@shared/routing/route-preload";
import { useQueryClient } from "@tanstack/react-query";
import { useUserDirectoryQuery } from "@features/users/user-directory-query";
import { ActivitySnapshotModal } from "./ActivitySnapshotModal";
import { activityTimeLabel, groupActivitiesByDay } from "./activity-day-groups";
import {
  ACTIVITY_CHIP_CATEGORY,
  ACTIVITY_CHIPS,
  activityActionLabel,
  activityDescription,
  activityEntityLabel,
  activityTargetLabel,
  activityTargetPath,
  type ActivityChip,
} from "./activity-labels";
import {
  activityDayTotals,
  describeActivityError,
  flattenActivityPages,
  useActivityFeedQuery,
} from "./activity-query";
import { activityEntityIcon, activityVisualKind } from "./activity-visuals";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

const ALL_PROJECTS = "all";

/** 设计稿 `activity.tsx` 的「审计规则」列表，BR-012 要求必须留痕的操作。 */
const AUDIT_RULES: readonly string[] = [
  "创建、编辑、指派与改派",
  "完成、重新打开、取消与恢复",
  "合并与解除合并",
  "迭代记录发布与版本修改",
  "项目成员变更与组长调整",
  "GitHub 链接添加与删除",
  "管理员作废或恢复历史数据",
];

export interface ActivityWorkspaceProps {
  readonly client?: InpulseApiClient | undefined;
  /** 项目详情页锁定单个项目；不传表示按「全部项目」聚合。 */
  readonly lockedProjectId?: number | undefined;
}
export const ActivityWorkspace: React.FC<ActivityWorkspaceProps> = ({
  client,
  lockedProjectId,
}) => {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<ActivityChip>("全部");
  /**
   * 项目筛选进 URL（`/activity?project=…`）：全局态可分享、刷新后保留，也让项目
   * 详情页能把筛选带过去。锁定态的取值直接来自路由参数本身。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProject = searchParams.get("project");
  const projectFilter =
    lockedProjectId !== undefined
      ? String(lockedProjectId)
      : urlProject === null || urlProject === ""
        ? ALL_PROJECTS
        : urlProject;
  // 2026-09-24：管理员操作默认勾选——取消勾选会重取第一页，默认打开才不会让
  // 用户以为「勾上以后动态变少了」。
  const [includeAdminOnly, setIncludeAdminOnly] = useState(true);
  const [snapshotItem, setSnapshotItem] = useState<ActivityItem | null>(null);
  /** 动态按天折叠：日期键集合，默认全部展开。 */
  const [collapsedDays, setCollapsedDays] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleDay = (key: string) =>
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /**
   * 项目详情页（/projects/:id/activity）的取数范围由路由决定，下拉不是「就地过滤」
   * 而是「换页」：选其他项目 → 该项目动态，选「全部项目」→ 全局动态。
   */
  const switchActivityScope = useCallback(
    (next: string) => {
      if (next === ALL_PROJECTS) {
        navigate("/activity");
        return;
      }
      const picked = Number(next);
      if (
        !Number.isSafeInteger(picked) ||
        picked <= 0 ||
        picked === lockedProjectId
      ) {
        return;
      }
      navigate(`/projects/${picked}/activity`);
    },
    [lockedProjectId, navigate],
  );

  /**
   * 「查看对象」按落点预取目标页首屏：任务中心要带上 project 参数，记录页要
   * 先取列表与草稿，项目内页面先取项目目录与成员。点击后等数据就绪再切页，
   * 旧页面保留到新内容可渲染，避免中间冒出一帧骨架。
   */
  const prepareTarget = useCallback(
    (path: string): Promise<void> => {
      const url = new URL(path, "http://inpulse.local");
      let data: Promise<void> = Promise.resolve();
      if (url.pathname === "/tasks") {
        data = prefetchTaskCenterRoute(cache, {
          viewerId: user?.id ?? null,
          isAdmin,
          params: url.searchParams,
          ...(client === undefined ? {} : { client }),
        });
      } else if (url.pathname === "/records") {
        data = prefetchRecordsRoute(cache, client);
      } else {
        const match = /^\/projects\/(\d+)\/(modules|members)\/?$/.exec(
          url.pathname,
        );
        if (match !== null) {
          const projectId = Number(match[1]);
          if (match[2] === "modules") {
            prefetchModulesRoute(cache, projectId, client);
          } else {
            prefetchProjectMembersRoute(cache, projectId, client);
          }
        }
      }
      return Promise.all([preloadRoutePath(path), data]).then(() => undefined);
    },
    [cache, client, isAdmin, user?.id],
  );

  /** 全局态：项目筛选写回 URL（replace，避免每次点选都压一条历史）。 */
  const changeProjectFilter = useCallback(
    (next: string) => {
      if (lockedProjectId !== undefined) {
        switchActivityScope(next);
        return;
      }
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === ALL_PROJECTS) {
            params.delete("project");
          } else {
            params.set("project", next);
          }
          return params;
        },
        { replace: true },
      );
    },
    [lockedProjectId, setSearchParams, switchActivityScope],
  );

  const pageRef = React.useRef<HTMLDivElement | null>(null);
  const bandRef = React.useRef<HTMLDivElement | null>(null);
  useStickyBandOffset(pageRef, bandRef);

  const projectsQuery = useProjects(client ? { client } : {});
  const directoryQuery = useUserDirectoryQuery(client ? { client } : {});

  const projects = useMemo(
    () => projectsQuery.data?.items ?? [],
    [projectsQuery.data],
  );
  const lockedScope = lockedProjectId !== undefined;

  const projectNames = useMemo(
    () =>
      new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const actorNames = useMemo(
    () =>
      new Map(
        (directoryQuery.data ?? []).map((member) => [member.id, member.name]),
      ),
    [directoryQuery.data],
  );

  /**
   * 取数范围：
   * - 锁定单项目 → 项目级路由（保留 404 语义）；
   * - 选定单项目 → 只传它；
   * - 「全部项目」→ 不传 projectIds，由服务端用实时授权范围直接取数，界面不需要
   *   先知道有哪些项目，也就不必等项目的读请求。
   */
  const feedScope = useMemo((): {
    readonly projectIds?: readonly number[];
    readonly scopeKey: string;
  } => {
    if (lockedProjectId !== undefined) {
      return { scopeKey: `project:${lockedProjectId}` };
    }
    if (projectFilter !== ALL_PROJECTS) {
      const picked = Number(projectFilter);
      if (!Number.isSafeInteger(picked) || picked <= 0) {
        return { projectIds: [], scopeKey: "invalid" };
      }
      return { projectIds: [picked], scopeKey: `project:${picked}` };
    }
    return { scopeKey: "all" };
  }, [lockedProjectId, projectFilter]);

  const activityQuery = useActivityFeedQuery({
    ...(lockedProjectId === undefined ? {} : { lockedProjectId }),
    ...(feedScope.projectIds === undefined
      ? {}
      : { projectIds: feedScope.projectIds }),
    scopeKey: feedScope.scopeKey,
    category: ACTIVITY_CHIP_CATEGORY[chip],
    includeAdminOnly: isAdmin && includeAdminOnly,
    ...(client ? { client } : {}),
  });

  const actorNameOf = useCallback(
    (item: ActivityItem): string => {
      if (item.actorId === null) {
        return "系统";
      }
      return (
        item.actorName ??
        actorNames.get(item.actorId) ??
        `用户 #${item.actorId}`
      );
    },
    [actorNames],
  );

  /** 原始快照弹窗按审计记录解析操作人；措辞与审计页「原始审计快照」一致。 */
  const auditActorNameOf = useCallback(
    (record: AuditLogItem): string => {
      if (record.actorType === "SYSTEM") {
        return "系统";
      }
      if (record.actorId === null) {
        return "未知用户";
      }
      if (
        snapshotItem !== null &&
        snapshotItem.actorId === record.actorId &&
        snapshotItem.actorName !== null
      ) {
        return snapshotItem.actorName;
      }
      return actorNames.get(record.actorId) ?? `用户 #${record.actorId}`;
    },
    [actorNames, snapshotItem],
  );

  const items = useMemo(
    () =>
      activityQuery.data ? flattenActivityPages(activityQuery.data.pages) : [],
    [activityQuery.data],
  );

  // 日期旁的数量取服务端按日总数（当前过滤条件下的全量），不随加载更多增长。
  const { totals: dayTotals, truncated: dayTotalsTruncated } = useMemo(
    () => activityDayTotals(activityQuery.data?.pages ?? []),
    [activityQuery.data],
  );

  const term = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (term.length === 0) {
      return items;
    }
    // 分类过滤由服务端完成，这里只剩关键词匹配（只作用于已加载的页）。
    return items.filter((item) =>
      [
        activityDescription(item),
        activityActionLabel(item.activityType),
        activityEntityLabel(item.sourceEntityType),
        actorNameOf(item),
        activityTargetLabel(item),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [items, term, actorNameOf]);

  const dayGroups = useMemo(
    () => groupActivitiesByDay(filteredItems),
    [filteredItems],
  );

  /**
   * 分类已交给服务端；关键词仍在前端匹配已加载的页，命中不到时继续翻页，
   * 直到找到匹配或数据穷尽，期间不给误导性的空态。
   */
  const isSearching = term.length > 0;
  const awaitingFilteredMatch = isSearching && filteredItems.length === 0;
  useEffect(() => {
    if (
      !awaitingFilteredMatch ||
      !activityQuery.hasNextPage ||
      activityQuery.isFetchingNextPage ||
      activityQuery.isError
    ) {
      return;
    }
    void activityQuery.fetchNextPage();
  }, [
    awaitingFilteredMatch,
    activityQuery.hasNextPage,
    activityQuery.isFetchingNextPage,
    activityQuery.isError,
    activityQuery.fetchNextPage,
  ]);

  const snapshotProjectName =
    snapshotItem === null
      ? ""
      : (projectNames.get(snapshotItem.projectId) ??
        `项目 #${snapshotItem.projectId}`);

  let content: React.ReactNode;
  if (!lockedScope && projectsQuery.isSuccess && projects.length === 0) {
    content = (
      <CalmEmptyState
        icon="boxes"
        title="还没有可访问的项目"
        description="加入项目后，这里会汇总你可见的全部动态。"
      />
    );
  } else if (activityQuery.isPending) {
    content = (
      <CalmSkeleton variant="timeline" rows={4} label="正在加载项目动态..." />
    );
  } else if (activityQuery.isError) {
    content = (
      <div className="activity-state activity-state-error">
        {describeActivityError(activityQuery.error)}
      </div>
    );
  } else if (awaitingFilteredMatch && activityQuery.hasNextPage) {
    content = (
      <div className="activity-state">
        <span className="activity-spinner" />
        正在查找匹配的动态...
      </div>
    );
  } else if (filteredItems.length === 0) {
    content = (
      <CalmEmptyState
        icon="search"
        title="没有匹配的动态"
        description={
          items.length === 0
            ? "当前范围内还没有可展示的活动投影。"
            : "已加载该范围内的全部动态，没有符合条件的记录。"
        }
      />
    );
  } else {
    content = (
      <>
        {dayTotalsTruncated ? (
          <p className="activity-totals-hint">
            按日数量只统计最近 400 个自然日内的动态。
          </p>
        ) : null}
        <div className="audit-list">
          {dayGroups.map((group) => {
            const collapsed = collapsedDays.has(group.key);
            // 服务端按日总数；超出统计窗口的旧日期退回已加载条数。
            const dayTotal = dayTotals.get(group.key) ?? group.items.length;
            return (
              <section className="activity-day" key={group.key}>
                <div className="activity-day-head">
                  <span aria-hidden="true" className="activity-day-date">
                    {group.shortLabel}
                  </span>
                  <div className="audit-line">
                    <span />
                  </div>
                  <button
                    type="button"
                    className="activity-day-toggle"
                    aria-expanded={!collapsed}
                    title={collapsed ? "展开当天动态" : "收起当天动态"}
                    onClick={() => toggleDay(group.key)}
                  >
                    <InpulseIcon
                      name="chevron"
                      size={14}
                      {...(collapsed ? {} : { className: "expanded" })}
                    />
                    <strong>{group.label}</strong>
                    <small>{dayTotal} 条动态</small>
                  </button>
                </div>
                {collapsed
                  ? null
                  : group.items.map((item) => {
                      const actorName = actorNameOf(item);
                      return (
                        <div
                          className="audit-row"
                          data-kind={activityVisualKind(item.activityType)}
                          data-entity={item.sourceEntityType}
                          key={item.id}
                          data-testid={`activity-item-${item.id}`}
                        >
                          <div className="audit-time">
                            <span className="activity-time-text">
                              {activityTimeLabel(item.occurredAt)}
                            </span>
                            <span
                              className="activity-kind-badge"
                              aria-hidden="true"
                            >
                              <InpulseIcon
                                name={activityEntityIcon(item.sourceEntityType)}
                                size={14}
                              />
                            </span>
                          </div>
                          <div className="audit-line">
                            <span />
                          </div>
                          <div className="audit-content">
                            <div className="activity-avatar">
                              {actorName.slice(0, 1)}
                            </div>
                            <div>
                              <strong>
                                {actorName}
                                <span className="activity-action">
                                  {activityActionLabel(item.activityType)}
                                </span>
                              </strong>
                              <p>{activityDescription(item)}</p>
                              <small>
                                {(projectNames.get(item.projectId) ??
                                  `项目 #${item.projectId}`) +
                                  " · " +
                                  activityTargetLabel(item)}
                              </small>
                            </div>
                          </div>
                          <div className="audit-actions">
                            {isAdmin ? (
                              <button
                                type="button"
                                className="small-button"
                                aria-label={`原始快照 ${item.id}`}
                                onClick={() => setSnapshotItem(item)}
                              >
                                <InpulseIcon name="shield" size={13} />
                                原始快照
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="查看对象"
                              title={activityTargetLabel(item)}
                              onPointerEnter={() => {
                                void prepareTarget(
                                  activityTargetPath(item, { isAdmin }),
                                );
                              }}
                              onPointerDown={() => {
                                void prepareTarget(
                                  activityTargetPath(item, { isAdmin }),
                                );
                              }}
                              onClick={() => {
                                const path = activityTargetPath(item, {
                                  isAdmin,
                                });
                                void prepareTarget(path).finally(() =>
                                  navigate(path),
                                );
                              }}
                            >
                              <InpulseIcon name="chevronRight" size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
              </section>
            );
          })}
        </div>
        {activityQuery.hasNextPage ? (
          <button
            type="button"
            className="secondary-button activity-load-more"
            disabled={activityQuery.isFetchingNextPage}
            onClick={() => void activityQuery.fetchNextPage()}
          >
            {activityQuery.isFetchingNextPage ? "正在加载..." : "加载更多"}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <div className="activity-page" ref={pageRef}>
      {/* 2026-10-08 用户要求：页面滚动只滚动红线以下的区域——标题与筛选条吸顶，
          列表与审计规则在其下方滚动（样式见 inpulse-design.css 的 .sticky-page-band）。 */}
      <div className="sticky-page-band" ref={bandRef}>
        <div className="page-header activity-page-header">
          <div>
            <h1>项目动态</h1>
            <p>
              创建、指派、完成、合并、记录发布与版本修改全部留痕；审计日志不允许删除。
            </p>
          </div>
          <div className="catalog-actions activity-header-actions">
            {lockedProjectId !== undefined ? (
              <span className="activity-scope-badge">
                项目 #{lockedProjectId}
              </span>
            ) : null}
            <CalmBadge tone={isAdmin ? "blue" : "gray"}>
              {isAdmin ? "管理员可查看原始快照" : "仅管理员可查看原始快照"}
            </CalmBadge>
          </div>
        </div>

        <div className="toolbar task-toolbar activity-toolbar">
          <div className="task-search">
            <InpulseIcon name="search" size={16} />
            <input
              value={query}
              placeholder="搜索操作、对象或执行人"
              aria-label="搜索动态"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div className="chip-row" role="group" aria-label="动态类型筛选">
            {ACTIVITY_CHIPS.map((option) => (
              <button
                type="button"
                key={option}
                className={`chip${chip === option ? " chip-active" : ""}`}
                aria-pressed={chip === option}
                onClick={() => setChip(option)}
              >
                {option}
              </button>
            ))}
          </div>
          {/* 2026-10-09：项目详情页原先锁死项目、连下拉都不渲染，用户反馈没法换成
              其他项目。现在两种状态共用同一份选项，只把「就地过滤」换成「换页」：
              全局态写回 ?project=，锁定态跳转到目标项目 / 全局动态。 */}
          <CalmSelect
            ariaLabel="项目"
            value={projectFilter}
            appearance="rich"
            onChange={(next) => changeProjectFilter(String(next))}
            options={[
              { value: ALL_PROJECTS, label: "全部项目" },
              ...projects.map(projectSelectOption),
            ]}
            animated
          />
          {isAdmin ? (
            <label className="check-line activity-admin-toggle">
              <input
                type="checkbox"
                checked={includeAdminOnly}
                onChange={(event) =>
                  setIncludeAdminOnly(event.currentTarget.checked)
                }
              />
              包含管理员操作
            </label>
          ) : null}
        </div>
      </div>

      {content}

      <section className="activity-rules">
        <CalmSectionTitle title="审计规则" hint="BR-012 · 以下操作必须记录" />
        <ul className="rule-list">
          {AUDIT_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>

      <ActivitySnapshotModal
        item={snapshotItem}
        projectName={snapshotProjectName}
        actorNameOf={auditActorNameOf}
        {...(client ? { client } : {})}
        onClose={() => setSnapshotItem(null)}
      />
      <BackToTop />
    </div>
  );
};

export default ActivityWorkspace;

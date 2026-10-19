import React, { useCallback, useMemo, useState } from "react";
import { AppModal as Modal } from "@features/common/components/AppModal";
import type { AuditLogItem, InpulseApiClient } from "@generated/api";
import {
  CalmEmptyState,
  CalmSectionTitle,
} from "@features/common/components/Calm";
import { BackToTop } from "@features/common/components/BackToTop";
import {
  CalmSelect,
  type CalmSelectOption,
} from "@features/common/components/CalmSelect";
import { projectSelectOption } from "@features/common/project-select-option";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { useStickyBandOffset } from "@features/common/use-sticky-band-offset";
import {
  beijingDateTime,
  beijingDayKey,
  formatBeijingSecond,
  formatDayKeyCn,
  formatDayKeySlash,
} from "@features/common/beijing-time";
import { useProjects } from "@features/projects/project-query";
import { useUserDirectoryQuery } from "@features/users/user-directory-query";
import {
  auditActionLabel,
  auditActionWithCode,
  auditTargetTypeLabel,
  auditTargetTypeWithCode,
} from "./audit-labels";
import { AuditActionFilter } from "./AuditActionFilter";
import {
  AUDIT_PAGE_LIMIT,
  EMPTY_AUDIT_FILTERS,
  describeAuditError,
  useAuditLogsInfiniteQuery,
  validateAuditFilters,
  type AuditChain,
  type AuditFilters,
} from "./audit-query";

export interface AuditLogPageViewProps {
  readonly client?: InpulseApiClient | undefined;
}

const padAudit = (value: number): string => String(value).padStart(2, "0");

function formatAuditTime(value: string): { date: string; time: string } {
  const at = beijingDateTime(value);
  if (at === null) {
    return { date: value, time: "" };
  }
  return {
    date: padAudit(at.month) + "-" + padAudit(at.day),
    time:
      padAudit(at.hour) + ":" + padAudit(at.minute) + ":" + padAudit(at.second),
  };
}

/** 快照里的完整北京时间（`2026-09-21 16:24:20`），原始 UTC 值由调用方放进 title。 */
function formatAuditDateTime(value: string): string {
  return formatBeijingSecond(value);
}

/**
 * 2026-10-08 用户要求「时间先不会被滚走，等里面的内容滚完了再收起来」：审计列表与项目动态
 * 一样按自然日分组、组头吸顶。分组与行内时刻一律按北京时间（Asia/Shanghai），
 * 与上方 from / to 的解析口径一致。
 */
function auditDayKey(value: string): string {
  return beijingDayKey(value);
}

function auditDayLabel(key: string): string {
  return formatDayKeyCn(key);
}

/** 时间线竖线左侧的短日期（如 9/24），完整日期由组头承担。 */
function auditDayShortLabel(key: string): string {
  return formatDayKeySlash(key);
}

/** 服务端已按 occurred_at DESC 分页；这里只把当前已加载页按自然日分组。 */
function groupAuditItemsByDay(items: readonly AuditLogItem[]) {
  const groups = new Map<string, AuditLogItem[]>();
  for (const item of items) {
    const key = auditDayKey(item.occurredAt);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, grouped]) => ({
      key,
      label: auditDayLabel(key),
      shortLabel: auditDayShortLabel(key),
      items: grouped,
    }));
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 事件载荷里的实体编号与名称：默认优先 after、其次 before；删除用户时需要
 * 保留删除前的姓名，因此改为优先 before。最后读平铺载荷（演示种子数据是
 * 平铺结构）。读不到时由调用方回退到「类型 #id」。
 */
function payloadIdentity(
  item: AuditLogItem,
  preferBefore = false,
): {
  readonly code: string | null;
  readonly name: string | null;
} {
  const candidates = preferBefore
    ? [
        item.eventPayload["before"],
        item.eventPayload["after"],
        item.eventPayload,
      ]
    : [
        item.eventPayload["after"],
        item.eventPayload["before"],
        item.eventPayload,
      ];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const source = candidate as Record<string, unknown>;
    const code = readText(source["code"]);
    const name = readText(source["name"]) ?? readText(source["title"]);
    if (code !== null || name !== null) {
      return { code, name };
    }
  }
  return { code: null, name: null };
}

/** 组合实体文案：`任务 INPULSE-T-64「单点登录」`，缺哪段就省哪段。 */
function entityLabel(
  typeLabel: string,
  identity: {
    readonly code: string | null;
    readonly name: string | null;
  },
): string {
  const head =
    identity.code === null ? typeLabel : typeLabel + " " + identity.code;
  return identity.name === null ? head : head + "「" + identity.name + "」";
}

function snapshotPayloadText(item: AuditLogItem): string {
  try {
    return JSON.stringify(item.eventPayload, null, 2);
  } catch {
    return "事件载荷无法序列化";
  }
}

export const AuditLogPageView: React.FC<AuditLogPageViewProps> = ({
  client,
}) => {
  // 默认读取「全部记录（所有链）」（ADR-061）；可切回 SYSTEM 或单个项目链。
  const [chain, setChain] = useState<AuditChain>({ kind: "all" });
  const [draftFilters, setDraftFilters] =
    useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AuditLogItem | null>(null);
  /**
   * 2026-10-10：快照里有三类长文本（请求 ID、链上哈希、事件载荷）以前只能手选，
   * 这里给它们加一键复制；复制成功后按钮自己显示「已复制」1.6 秒再复位。
   */
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copySnapshotField = useCallback(async (field: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
    } catch {
      setCopiedField(null);
    }
    window.setTimeout(
      () => setCopiedField((current) => (current === field ? null : current)),
      1600,
    );
  }, []);

  const projectsQuery = useProjects(client ? { client } : {});
  const directoryQuery = useUserDirectoryQuery(client ? { client } : {});
  const auditQuery = useAuditLogsInfiniteQuery({
    chain,
    filters,
    ...(client ? { client } : {}),
  });

  const items = useMemo(
    () => auditQuery.data?.pages.flatMap((page) => [...page.items]) ?? [],
    [auditQuery.data],
  );
  const projects = projectsQuery.data?.items ?? [];
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  /** 历史行与链标签用的项目名，避免回退成「项目 #id」。 */
  const projectNameOf = useCallback(
    (projectId: number): string | null => projectNames.get(projectId) ?? null,
    [projectNames],
  );

  const projectChainOptions = useMemo(() => {
    const options: CalmSelectOption[] = [
      { value: "all", label: "全部记录（所有链）", iconText: "全" },
      { value: "system", label: "SYSTEM 链（系统级）", iconText: "SY" },
      ...projects.map((project) => ({
        ...projectSelectOption(project),
        label: "PROJECT:" + project.id + " · " + project.name,
      })),
    ];
    return options;
  }, [projects]);
  // 审计展示只使用启用账号目录与事件载荷里的历史姓名。墓碑化不会让旧审计行
  // 突然改名，也不会把本不属于事件当时的信息回写到界面上。
  const directoryNames = useMemo(
    () =>
      new Map(
        (directoryQuery.data ?? []).map((entry) => [entry.id, entry.name]),
      ),
    [directoryQuery.data],
  );

  const dayGroups = useMemo(() => groupAuditItemsByDay(items), [items]);
  const [collapsedDays, setCollapsedDays] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleDay = useCallback((key: string) => {
    setCollapsedDays((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const pageRef = React.useRef<HTMLDivElement | null>(null);
  const bandRef = React.useRef<HTMLDivElement | null>(null);
  // 吸顶块高度量出来写进页面根的 CSS 变量，供 `.activity-day-head` 的 top 使用。
  useStickyBandOffset(pageRef, bandRef);

  const actorNameOf = useCallback(
    (item: AuditLogItem): string => {
      if (item.actorType === "SYSTEM") {
        return "系统";
      }
      if (item.actorId === null) {
        return "未知用户";
      }
      return directoryNames.get(item.actorId) ?? "用户 #" + item.actorId;
    },
    [directoryNames],
  );

  const actorAvatarOf = useCallback(
    (item: AuditLogItem): string => {
      if (item.actorType === "SYSTEM") {
        return "系";
      }
      if (item.actorId === null) {
        return "?";
      }
      const name = directoryNames.get(item.actorId);
      return name === undefined ? "U" + (item.actorId % 100) : name.slice(0, 1);
    },
    [directoryNames],
  );

  // 对象列尽量说人话：用户与项目按目录换成名字，业务实体优先用载荷里的
  // 编号与标题，读不到才退回原始数据库 ID。
  const targetLabelOf = useCallback(
    (item: AuditLogItem): string => {
      const typeLabel = auditTargetTypeLabel(item.targetType);
      if (item.targetId === null) {
        return typeLabel;
      }
      const numeric = Number(item.targetId);
      if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        return typeLabel + " " + item.targetId;
      }
      if (item.targetType === "USER") {
        const identity = payloadIdentity(
          item,
          item.action === "admin.user.delete",
        );
        if (identity.name !== null) {
          return typeLabel + " " + identity.name;
        }
        if (identity.code !== null) {
          return typeLabel + " " + identity.code;
        }
        const name = directoryNames.get(numeric);
        if (name !== undefined) {
          return typeLabel + " " + name;
        }
      }
      if (item.targetType === "PROJECT") {
        const name = projectNameOf(numeric);
        if (name !== null) {
          return typeLabel + " " + name;
        }
      }
      const identity = payloadIdentity(item);
      if (identity.code !== null || identity.name !== null) {
        return entityLabel(typeLabel, identity);
      }
      return typeLabel + " #" + item.targetId;
    },
    [directoryNames, projectNameOf],
  );

  const scopeLabelOf = useCallback(
    (item: AuditLogItem): string =>
      item.projectId === null
        ? "系统链"
        : "项目 " + (projectNameOf(item.projectId) ?? "#" + item.projectId),
    [projectNameOf],
  );

  const chainLabelOf = useCallback(
    (item: AuditLogItem): string => {
      if (item.chainId === "SYSTEM") {
        return "SYSTEM 链";
      }
      const name =
        item.projectId === null ? null : projectNameOf(item.projectId);
      return "「" + (name ?? item.chainId) + "」项目链";
    },
    [projectNameOf],
  );

  const describeChain = useCallback(
    (value: AuditChain): string =>
      value.kind === "all"
        ? "全部记录（所有链）"
        : value.kind === "system"
          ? "SYSTEM 链"
          : "「" +
            (projectNameOf(value.projectId) ?? "项目 #" + value.projectId) +
            "」项目链",
    [projectNameOf],
  );

  const updateDraft = (patch: Partial<AuditFilters>) => {
    setDraftFilters((current) => ({ ...current, ...patch }));
  };

  const applyFilters = () => {
    const invalid = validateAuditFilters(draftFilters);
    if (invalid !== null) {
      setFilterError(invalid);
      return;
    }
    setFilterError(null);
    setFilters(draftFilters);
  };

  const resetFilters = () => {
    setDraftFilters(EMPTY_AUDIT_FILTERS);
    setFilters(EMPTY_AUDIT_FILTERS);
    setFilterError(null);
  };

  const handleChainChange = (value: string) => {
    if (value === "all") {
      setChain({ kind: "all" });
      return;
    }
    if (value === "system") {
      setChain({ kind: "system" });
      return;
    }
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      setChain({ kind: "project", projectId: parsed });
    }
  };

  const activeChainLabel = describeChain(chain);

  let content: React.ReactNode;
  if (auditQuery.isPending) {
    content = (
      <div className="activity-state">
        <span className="activity-spinner" />
        正在读取原始审计链...
      </div>
    );
  } else if (auditQuery.isError) {
    content = (
      <CalmEmptyState
        icon="alert"
        title="原始审计读取失败"
        description={describeAuditError(auditQuery.error)}
      >
        <button
          type="button"
          className="secondary-button"
          onClick={() => void auditQuery.refetch()}
        >
          重试
        </button>
      </CalmEmptyState>
    );
  } else if (items.length === 0) {
    content = (
      <CalmEmptyState
        icon="shield"
        title="没有匹配的审计记录"
        description="调整筛选条件，或切换审计链后重试。"
      >
        <button
          type="button"
          className="secondary-button"
          onClick={resetFilters}
        >
          清除筛选
        </button>
      </CalmEmptyState>
    );
  } else {
    content = (
      <>
        <div className="audit-list">
          {dayGroups.map((group) => {
            const collapsed = collapsedDays.has(group.key);
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
                    title={collapsed ? "展开当天记录" : "收起当天记录"}
                    onClick={() => toggleDay(group.key)}
                  >
                    <InpulseIcon
                      name="chevron"
                      size={14}
                      {...(collapsed ? {} : { className: "expanded" })}
                    />
                    <strong>{group.label}</strong>
                    <small>{group.items.length} 条</small>
                  </button>
                </div>
                {collapsed
                  ? null
                  : group.items.map((item) => {
                      const time = formatAuditTime(item.occurredAt);
                      const rowKey = item.chainId + "-" + item.sequenceNo;
                      return (
                        <div
                          className="audit-row"
                          key={rowKey}
                          data-testid={"audit-item-" + rowKey}
                        >
                          <div className="audit-time">
                            {time.date}
                            <small>{time.time}</small>
                          </div>
                          <div className="audit-line">
                            <span />
                          </div>
                          <div className="audit-content">
                            <div className="activity-avatar">
                              {actorAvatarOf(item)}
                            </div>
                            <div>
                              <strong>
                                {actorNameOf(item)}
                                <span>{auditActionLabel(item.action)}</span>
                              </strong>
                              <p>对象：{targetLabelOf(item)}</p>
                              <small>
                                {"第 " +
                                  item.sequenceNo +
                                  " 条 · " +
                                  scopeLabelOf(item)}
                              </small>
                            </div>
                          </div>
                          <div className="audit-actions">
                            <span className="audit-entity-badge">
                              {item.actorType === "SYSTEM"
                                ? "系统操作"
                                : "用户操作"}
                            </span>
                            <button
                              type="button"
                              className="secondary-button"
                              aria-label={
                                "查看原始快照 第 " + item.sequenceNo + " 条"
                              }
                              onClick={() => setSnapshot(item)}
                            >
                              <InpulseIcon name="shield" size={13} />
                              原始快照
                            </button>
                          </div>
                        </div>
                      );
                    })}
              </section>
            );
          })}
        </div>
        {auditQuery.hasNextPage ? (
          <button
            type="button"
            className="secondary-button activity-load-more"
            disabled={auditQuery.isFetchingNextPage}
            onClick={() => void auditQuery.fetchNextPage()}
          >
            {auditQuery.isFetchingNextPage ? "正在加载..." : "加载更多"}
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
            <h1>动态审计</h1>
            <p>
              原始审计链仅系统管理员可读；读取不会在审计链留下记录，可按动作、
              操作人与时间范围筛选。
            </p>
          </div>
          <div className="catalog-actions activity-header-actions">
            <span className="activity-scope-badge">
              当前链：{activeChainLabel}
            </span>
            <span className="activity-admin-badge">管理员可查看原始快照</span>
          </div>
        </div>

        <div className="toolbar activity-toolbar audit-toolbar">
          <CalmSelect
            ariaLabel="审计链"
            value={
              chain.kind === "all"
                ? "all"
                : chain.kind === "system"
                  ? "system"
                  : String(chain.projectId)
            }
            appearance="rich"
            onChange={(next) => handleChainChange(String(next))}
            options={projectChainOptions}
            animated
          />
          <AuditActionFilter
            value={draftFilters.action}
            onChange={(action) => updateDraft({ action })}
          />
          <CalmSelect
            ariaLabel="操作人"
            appearance="member"
            multiple
            maxTagCount={1}
            width={176}
            value={draftFilters.actorIds}
            onChange={(next) =>
              updateDraft({ actorIds: next.map((value) => Number(value)) })
            }
            placeholder="全员（可勾选多人）"
            loading={directoryQuery.isPending}
            options={(directoryQuery.data ?? []).map((entry) => ({
              value: entry.id,
              label: entry.name,
              avatarUrl: entry.avatarUrl ?? null,
              description: entry.isAdmin ? "系统管理员" : "项目成员",
            }))}
            animated
          />
          <label className="audit-time-field">
            <span className="audit-time-label">开始</span>
            <i className="audit-time-divider" aria-hidden="true" />
            <input
              type="datetime-local"
              value={draftFilters.from}
              aria-label="开始时间"
              onChange={(event) =>
                updateDraft({ from: event.currentTarget.value })
              }
            />
          </label>
          <label className="audit-time-field">
            <span className="audit-time-label">结束</span>
            <i className="audit-time-divider" aria-hidden="true" />
            <input
              type="datetime-local"
              value={draftFilters.to}
              aria-label="结束时间"
              onChange={(event) =>
                updateDraft({ to: event.currentTarget.value })
              }
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={applyFilters}
          >
            查询
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={resetFilters}
          >
            重置
          </button>
        </div>
      </div>

      <p className="permission-hint">
        <InpulseIcon name="shield" size={14} />
        每页 {AUDIT_PAGE_LIMIT} 条（契约默认值）；
        操作人不选即全体，可勾选多人； from / to 为半开区间 [from,
        to)，按浏览器本地时区换算为带时区时间；
        游标由服务端签名，不能跨查询复用。
      </p>

      {filterError ? (
        <div className="permission-note note-warning" role="alert">
          <InpulseIcon name="alert" size={16} />
          <span>{filterError}</span>
        </div>
      ) : null}

      {content}

      <section className="activity-rules">
        <CalmSectionTitle title="审计规则" hint="BR-012 · 原始审计只追加" />
        <ul className="rule-list">
          <li>
            <strong>只追加</strong>
            审计链不可编辑、不可删除；修正历史只能通过新事件或版本恢复完成。
          </li>
          <li>
            <strong>范围</strong>
            默认读取「全部记录（所有链）」并按发生时间倒序跨链分页；选择 SYSTEM
            链或某个项目链后只读该链，按链内序号倒序返回。
          </li>
        </ul>
      </section>

      <Modal
        open={snapshot !== null}
        eyebrow={
          snapshot === null
            ? undefined
            : formatAuditDateTime(snapshot.occurredAt) +
              " · " +
              actorNameOf(snapshot)
        }
        title="原始审计快照"
        onCancel={() => setSnapshot(null)}
        size="lg"
        className="snapshot-modal"
      >
        {snapshot ? (
          <div className="snapshot-body" data-testid="audit-snapshot">
            <section className="snapshot-group">
              <h3 className="snapshot-group-title">基本信息</h3>
              <dl className="calm-meta">
                <dt>链</dt>
                <dd>{chainLabelOf(snapshot)}</dd>
                <dt>链序号</dt>
                <dd>第 {snapshot.sequenceNo} 条</dd>
                <dt>操作</dt>
                <dd>{auditActionWithCode(snapshot.action)}</dd>
                <dt>对象</dt>
                <dd>{targetLabelOf(snapshot)}</dd>
                <dt>原始标识</dt>
                <dd>
                  {auditTargetTypeWithCode(snapshot.targetType) +
                    (snapshot.targetId === null
                      ? ""
                      : " · " + snapshot.targetId)}
                </dd>
                <dt>项目</dt>
                <dd>
                  {snapshot.projectId === null
                    ? "系统级（无项目）"
                    : (projectNameOf(snapshot.projectId) ??
                      "项目 #" + snapshot.projectId)}
                </dd>
                <dt>操作人</dt>
                <dd>{actorNameOf(snapshot)}</dd>
                <dt>时间</dt>
                <dd title={snapshot.occurredAt}>
                  {formatAuditDateTime(snapshot.occurredAt)}
                </dd>
              </dl>
            </section>
            <section className="snapshot-group">
              <h3 className="snapshot-group-title">请求上下文</h3>
              <dl className="calm-meta">
                <dt>请求 ID</dt>
                <dd className="snapshot-copyable">
                  <code>{snapshot.requestId}</code>
                  <button
                    type="button"
                    className="snapshot-copy-button"
                    onClick={() =>
                      void copySnapshotField("requestId", snapshot.requestId)
                    }
                  >
                    {copiedField === "requestId" ? "已复制" : "复制"}
                  </button>
                </dd>
                <dt>客户端请求 ID</dt>
                {snapshot.clientRequestId === null ? (
                  <dd>—</dd>
                ) : (
                  <dd className="snapshot-copyable">
                    <code>{snapshot.clientRequestId}</code>
                    <button
                      type="button"
                      className="snapshot-copy-button"
                      onClick={() =>
                        void copySnapshotField(
                          "clientRequestId",
                          snapshot.clientRequestId ?? "",
                        )
                      }
                    >
                      {copiedField === "clientRequestId" ? "已复制" : "复制"}
                    </button>
                  </dd>
                )}
                <dt>IP 地址</dt>
                <dd>{snapshot.ipAddress ?? "—"}</dd>
                <dt>User-Agent</dt>
                <dd>{snapshot.userAgent ?? "—"}</dd>
              </dl>
            </section>
            <section className="snapshot-group">
              <h3 className="snapshot-group-title">完整性校验</h3>
              <dl className="calm-meta">
                <dt>密钥版本</dt>
                <dd>{snapshot.keyVersion}</dd>
                <dt>规范化版本</dt>
                <dd>{snapshot.canonicalVersion}</dd>
                <dt>前一条哈希</dt>
                <dd className="snapshot-copyable">
                  <code>{snapshot.prevHash}</code>
                  <button
                    type="button"
                    className="snapshot-copy-button"
                    onClick={() =>
                      void copySnapshotField("prevHash", snapshot.prevHash)
                    }
                  >
                    {copiedField === "prevHash" ? "已复制" : "复制"}
                  </button>
                </dd>
                <dt>本条哈希</dt>
                <dd className="snapshot-copyable">
                  <code>{snapshot.recordHash}</code>
                  <button
                    type="button"
                    className="snapshot-copy-button"
                    onClick={() =>
                      void copySnapshotField("recordHash", snapshot.recordHash)
                    }
                  >
                    {copiedField === "recordHash" ? "已复制" : "复制"}
                  </button>
                </dd>
              </dl>
            </section>
            <section className="snapshot-group">
              <h3 className="snapshot-group-title">事件载荷</h3>
              <div className="snapshot-payload">
                <div className="snapshot-payload-bar">
                  <span className="snapshot-payload-kind">JSON</span>
                  <button
                    type="button"
                    className="snapshot-copy-button"
                    onClick={() =>
                      void copySnapshotField(
                        "payload",
                        snapshotPayloadText(snapshot),
                      )
                    }
                  >
                    {copiedField === "payload" ? "已复制" : "复制"}
                  </button>
                </div>
                <pre data-testid="audit-snapshot-payload">
                  {snapshotPayloadText(snapshot)}
                </pre>
              </div>
            </section>
            <p className="permission-hint">
              <InpulseIcon name="shield" size={14} />
              审计日志不允许删除；原始快照仅系统管理员可见。
            </p>
          </div>
        ) : null}
      </Modal>
      <BackToTop />
    </div>
  );
};

export default AuditLogPageView;

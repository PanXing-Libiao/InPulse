import { ExternalLinksPanel } from "@features/external-links/ExternalLinksPanel";
import { useAuth } from "@features/auth/auth-context";
import { RecordLifecycleButton } from "./RecordLifecycleButton";
import { ConvertLeftoverTask } from "./ConvertLeftoverTask";
import { EditPublishedRecord } from "./EditPublishedRecord";
import { AppendLeftoverForm } from "./AppendLeftoverForm";
import { taskDetailPath, type TaskLocation } from "@features/tasks/task-links";
import { fieldText } from "@features/record-drafts/record-content";
import React, { useMemo, useState } from "react";
import { Alert, Button } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  createApiClient,
  type InpulseApiClient,
  type ChangeRecordVersion,
  ApiError,
} from "@generated/api";
import { RecordMarkdown } from "@features/common/components/RecordMarkdown";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { CalmBadge } from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { formatBeijingMinute } from "@features/common/beijing-time";
import { useModules } from "@features/modules/module-query";
import { useProjectDetail } from "@features/projects/project-query";
import { useProjectFeatureNames } from "@features/records/feature-name-map";
import { useUserDirectoryQuery } from "@features/users/user-directory-query";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";
import { SESSION_EXPIRED_MESSAGE } from "@shared/api/request-messages";

/** 正式记录正文的四段字段与中文标签：详情卡展开区与版本差异共用。 */
export const recordContentFields = [
  ["title", "迭代标题"],
  ["contextProblem", "改动原因"],
  ["changeSolution", "具体改动"],
  ["resultVerification", "改动效果"],
  ["remainingIssues", "遗留问题"],
] as const;

/** 逐字段对比两个不可变版本，供「版本差异」区渲染。数组字段先投影成文本再比较。 */
export function compareRecordVersions(
  before: ChangeRecordVersion,
  after: ChangeRecordVersion,
) {
  return recordContentFields.map(([field, label]) => ({
    field,
    label,
    before: fieldText(before, field),
    after: fieldText(after, field),
    changed: fieldText(before, field) !== fieldText(after, field),
  }));
}

export function publishedRecordErrorMessage(error: unknown) {
  return error instanceof ApiError && error.status === 401
    ? SESSION_EXPIRED_MESSAGE
    : error instanceof ApiError && error.status === 404
      ? "记录不存在或当前无法访问。"
      : "暂时无法加载记录，请重试。";
}

/** 遗留项状态中文标签：未处理 / 已处理 / 已作废。 */
export function leftoverStatusText(
  status: "ACTIVE" | "CONVERTED" | "RESOLVED" | "VOIDED",
) {
  if (status === "ACTIVE") return "未处理";
  return status === "VOIDED" ? "已作废" : "已处理";
}

/** 遗留项状态徽章色调：与任务记录列表的状态徽章同一套 CalmBadge。 */
const leftoverTone = {
  ACTIVE: "amber",
  CONVERTED: "green",
  RESOLVED: "green",
  VOIDED: "gray",
} as const;

/**
 * B-3a：正式记录卡片的展开区（设计师稿 record-card 的 record-expanded）。
 * 详情、不可变版本、GitHub 关联、生命周期与遗留项操作按记录 id 独立加载；
 * 折叠时组件卸载，不保留已加载的正文。
 */
export function PublishedRecordDetail({
  projectId,
  recordId,
  client,
  writable,
  onListChanged,
  standalone,
  labels,
  readOnly = false,
  onOpenTask,
}: {
  readonly projectId: number;
  readonly recordId: number;
  readonly client?: InpulseApiClient | undefined;
  readonly writable: boolean;
  readonly onListChanged?: (() => void) | undefined;
  /**
   * 无卡片摘要的独立展开（/records 深链到列表之外的记录）时补身份行：
   * 列表内展开的卡片由 summary 常驻展示编号、版本与状态，不重复渲染。
   */
  readonly standalone?: boolean | undefined;
  /** 列表条目已回填的名称：有值时用名称替代裸 ID（设计师稿 record-facts）。 */
  readonly labels?:
    | {
        readonly project: string;
        readonly module: string;
        readonly feature: string | null;
        readonly author: string;
        readonly impactFeatures: readonly string[];
      }
    | undefined;
  /**
   * 只读语境（迭代总结明细等）：不渲染任何写入入口（编辑 / 作废 / 遗留项转任务与
   * 追加）与 GitHub 关联面板，也不加载不可变版本与版本对比，只保留四段正文、
   * 遗留问题与事实区。与 `writable` 的分工：`writable` 只把按钮置灰，`readOnly`
   * 直接不渲染。
   */
  readonly readOnly?: boolean | undefined;
  /**
   * 就地打开来源任务（遗留问题页等已挂任务详情宿主时传入）：传了就渲染成按钮，
   * 点击交回宿主在当前页面打开任务弹窗、关掉后回到本条记录弹窗，不改变地址栏；
   * 缺省仍是深链到功能档案的 ?taskId=，由目标页自己打开任务详情。
   */
  readonly onOpenTask?: ((location: TaskLocation) => void) | undefined;
}) {
  const { user } = useAuth();
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const [oldVersion, setOldVersion] = useState(0),
    [newVersion, setNewVersion] = useState(0),
    [githubOpen, setGithubOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["published-record", projectId, recordId],
    queryFn: ({ signal }) =>
      api.getChangeRecord(projectId, recordId, { signal }),
    enabled: projectId > 0 && recordId > 0,
    retry: false,
  });
  const versions = useQuery({
    queryKey: ["record-versions", projectId, recordId],
    queryFn: ({ signal }) =>
      api.listChangeRecordVersions(projectId, recordId, { signal }),
    enabled: projectId > 0 && recordId > 0 && !!detail.data && !readOnly,
    retry: false,
  });
  /**
   * 记录接口只回传归属与作者的 ID。列表语境把名称带进来（`labels`），弹窗、深链与
   * 聚合组等没有列表的语境就地解析：项目详情、模块清单、功能名表与用户目录，
   * 与记录页卡片共用同一批查询键，命中缓存时不额外发请求。
   */
  const needsLabels = labels === undefined;
  const projectDetail = useProjectDetail({
    client,
    projectId,
    enabled: needsLabels,
  });
  const modules = useModules(needsLabels ? projectId : 0, client);
  const featureNames = useProjectFeatureNames(
    needsLabels ? projectId : 0,
    client,
  );
  const directory = useUserDirectoryQuery({ client, enabled: needsLabels });
  const history = versions.data?.items ?? [];
  const before =
    history.find((v) => v.versionNo === oldVersion) ??
    history[history.length - 1];
  const after = history.find((v) => v.versionNo === newVersion) ?? history[0];
  // 版本对比只展示有修改的字段：无变化字段两列内容相同，重复渲染只会淹没真正改动。
  const changedRows =
    before === undefined || after === undefined
      ? []
      : compareRecordVersions(before, after).filter((row) => row.changed);
  if (detail.isPending)
    return (
      <section className="record-expanded" aria-label="正式记录详情">
        <CalmSkeleton variant="lines" rows={5} label="正在加载记录详情" />
      </section>
    );
  if (detail.isError)
    return (
      <section className="record-expanded" aria-label="正式记录详情">
        <Alert
          type="error"
          title={publishedRecordErrorMessage(detail.error)}
          action={
            <Button onClick={() => void detail.refetch()}>重试记录</Button>
          }
        />
      </section>
    );
  if (!detail.data)
    return <section className="record-expanded" aria-label="正式记录详情" />;
  const record = detail.data;
  // 列举名称优先用列表回填的 labels；解析尚未就绪或失败时回落裸 ID，事实区不空项、不报错。
  const projectName =
    labels?.project ??
    projectDetail.data?.project.name ??
    `项目 #${record.projectId}`;
  const moduleName =
    labels?.module ??
    modules.query.data?.items.find((item) => item.id === record.moduleId)
      ?.name ??
    `模块 #${record.moduleId}`;
  const featureName =
    record.featureId === null
      ? null
      : (labels?.feature ??
        featureNames.get(record.featureId) ??
        `功能 #${record.featureId}`);
  const authorName =
    labels?.author ??
    record.authorName ??
    (directory.data ?? []).find((item) => item.id === record.authorId)?.name ??
    `用户 #${record.authorId}`;
  const impactNames =
    labels?.impactFeatures && labels.impactFeatures.length > 0
      ? labels.impactFeatures
      : record.impactFeatureIds
          .map((id) => featureNames.get(id))
          .filter((name): name is string => typeof name === "string");
  // 已解决的遗留项不在当前版本的列表里，只能通过相邻版本的条目数差判断是否移除过。
  const removedLeftovers = (() => {
    const current = history.find(
      (version) => version.versionNo === record.currentVersion,
    );
    const previous = history.find(
      (version) => version.versionNo === record.currentVersion - 1,
    );
    return current === undefined || previous === undefined
      ? 0
      : previous.leftovers.length - current.leftovers.length;
  })();
  // 来源任务位置（模块级任务回模块任务页、功能级任务回功能页）；taskId 为空时整个入口不渲染。
  const sourceTask: TaskLocation | null =
    record.taskId === null
      ? null
      : {
          projectId,
          moduleId: record.moduleId,
          featureId: record.featureId,
          taskId: record.taskId,
        };
  return (
    <section className="record-expanded" aria-label="正式记录详情">
      {standalone ? (
        <div className="record-expanded-head">
          <h3>{record.title}</h3>
        </div>
      ) : null}
      {/* 事实区（归属 / 影响功能 / 作者与时间）提到正文之上（2026-10-10 定案），
          进弹窗先看到「这条记录属于谁、谁在什么时候写的」。 */}
      <dl className="record-facts">
        <dt>归属</dt>
        <dd>
          {[projectName, moduleName, featureName]
            .filter((part) => part !== null)
            .join(" / ")}
        </dd>
        {impactNames.length > 0 && (
          <>
            <dt>影响功能</dt>
            <dd>{impactNames.join("、")}</dd>
          </>
        )}
        <dt>作者与时间</dt>
        <dd>
          {authorName} · 创建 {formatBeijingMinute(record.createdAt)}
          {record.status === "PUBLISHED"
            ? ` · 发布 ${formatBeijingMinute(record.publishedAt)}`
            : ""}
        </dd>
        {record.status === "VOID" && (
          <>
            <dt>可见范围</dt>
            <dd>已作废，仅管理员可读取</dd>
          </>
        )}
      </dl>
      {recordContentFields
        .filter(([field]) => field !== "title")
        .map(([field, label]) =>
          field === "remainingIssues" ? (
            <section key={field} aria-label="遗留问题列表">
              <div className="leftover-section-head">
                <h4>{label}</h4>
                {record.status === "PUBLISHED" && !readOnly && (
                  <AppendLeftoverForm
                    item={record}
                    api={api}
                    writable={writable}
                    onAdded={() => {
                      void detail.refetch();
                      void versions.refetch();
                      onListChanged?.();
                    }}
                  />
                )}
              </div>
              {record.leftovers.length === 0 ? (
                <RecordMarkdown content="暂无已知遗留问题" />
              ) : (
                <ul className="leftover-list">
                  {record.leftovers.map((leftover) => (
                    <li key={leftover.id}>
                      <div className="leftover-content">
                        <RecordMarkdown content={leftover.content} />
                      </div>
                      <CalmBadge tone={leftoverTone[leftover.status]}>
                        {leftoverStatusText(leftover.status)}
                      </CalmBadge>
                      {leftover.linkedTaskId !== null && (
                        <a
                          className="leftover-followup"
                          href={taskDetailPath({
                            projectId: record.projectId,
                            moduleId: record.moduleId,
                            featureId: record.featureId,
                            taskId: leftover.linkedTaskId,
                          })}
                        >
                          查看跟进任务
                        </a>
                      )}
                      {!readOnly &&
                        leftover.status === "ACTIVE" &&
                        record.status === "PUBLISHED" && (
                          <ConvertLeftoverTask
                            key={`convert-${record.id}-${leftover.id}`}
                            item={record}
                            leftover={leftover}
                            api={api}
                            writable={writable}
                            onConverted={() => {
                              void detail.refetch();
                              onListChanged?.();
                            }}
                          />
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section key={field}>
              <h4>{label}</h4>
              <RecordMarkdown content={record[field] || "（空）"} />
            </section>
          ),
        )}
      {!readOnly &&
        record.leftovers.some(
          (leftover) => leftover.status === "CONVERTED",
        ) && (
          <p>已转任务的遗留问题保留原任务关联，修订文字不会创建第二个任务。</p>
        )}
      {removedLeftovers > 0 && (
        <p>已删除或标记解决的遗留问题保留历史内容，不再计入未处理。</p>
      )}
      {record.status === "VOID" && (
        <Alert
          type="warning"
          title="已作废 · 仅管理员可见"
          description={
            <>
              最近作废：
              {formatBeijingMinute(record.voidedAt)}
              <p className="draft-content">{record.voidReason}</p>
            </>
          }
        />
      )}
      {history.length > 1 && (
        <section aria-label="历史版本">
          <h4>历史版本与对比</h4>
          {versions.isPending ? (
            <CalmSkeleton
              variant="lines"
              rows={3}
              compact
              label="正在加载历史版本"
            />
          ) : versions.isError ? (
            <Alert
              type="error"
              title={publishedRecordErrorMessage(versions.error)}
              action={
                <Button onClick={() => void versions.refetch()}>
                  重试版本
                </Button>
              }
            />
          ) : (
            <>
              <p>选择两个版本查看差异，只展示有修改的字段。</p>
              <div className="record-version-pickers">
                <label>
                  较早版本
                  <CalmSelect
                    ariaLabel="较早版本"
                    value={before?.versionNo ?? ""}
                    appearance="menu"
                    width={230}
                    onChange={(next) => setOldVersion(Number(next))}
                    options={history.map((v) => ({
                      value: v.versionNo,
                      label:
                        "v" +
                        v.versionNo +
                        " · " +
                        formatBeijingMinute(v.createdAt),
                    }))}
                    animated
                  />
                </label>
                <label>
                  对照版本
                  <CalmSelect
                    ariaLabel="对照版本"
                    value={after?.versionNo ?? ""}
                    appearance="menu"
                    width={230}
                    onChange={(next) => setNewVersion(Number(next))}
                    options={history.map((v) => ({
                      value: v.versionNo,
                      label:
                        "v" +
                        v.versionNo +
                        " · " +
                        formatBeijingMinute(v.createdAt),
                    }))}
                    animated
                  />
                </label>
              </div>
              {before && after && (
                <div aria-label="版本差异">
                  {changedRows.length === 0 ? (
                    <p>这两个版本的内容完全一致。</p>
                  ) : (
                    changedRows.map((row) => (
                      <section key={row.field}>
                        <h5>{row.label}</h5>
                        <div className="record-version-columns">
                          <div>
                            <strong>v{before.versionNo}</strong>
                            <RecordMarkdown content={row.before || "（空）"} />
                          </div>
                          <div>
                            <strong>v{after.versionNo}</strong>
                            <RecordMarkdown content={row.after || "（空）"} />
                          </div>
                        </div>
                      </section>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
      {!readOnly && (
        <div className="record-github">
          {/* 链接列表可能很长，默认折叠，点击标题展开；折叠时不挂载面板、不发列表请求。 */}
          <button
            type="button"
            className={`record-github-toggle${githubOpen ? "" : " collapsed"}`}
            aria-expanded={githubOpen}
            onClick={() => setGithubOpen((open) => !open)}
          >
            <InpulseIcon
              name="chevron"
              size={14}
              {...(githubOpen ? { className: "expanded" } : {})}
            />
            <span>GitHub 关联</span>
          </button>
          {githubOpen && (
            <ExternalLinksPanel
              key={record.id}
              targetType="CHANGE_RECORD"
              targetId={record.id}
              client={api}
              variant="inline"
            />
          )}
        </div>
      )}
      {/* 底部动作行（2026-10-10 定案）：来源任务入口靠左，修订 / 作废靠右；
          没有来源任务时动作按钮同样贴右。只读语境仍保留来源任务这一条只读导航。 */}
      {(record.taskId !== null ||
        (!readOnly &&
          (record.status === "PUBLISHED" || user?.isAdmin === true))) && (
        <div className="record-actions">
          {sourceTask === null ? null : onOpenTask === undefined ? (
            <a
              className="secondary-button record-source-link"
              href={taskDetailPath(sourceTask)}
            >
              <InpulseIcon name="cornerDown" size={14} />
              查看来源任务
            </a>
          ) : (
            <button
              type="button"
              className="secondary-button record-source-link"
              onClick={() => onOpenTask(sourceTask)}
            >
              <InpulseIcon name="cornerDown" size={14} />
              查看来源任务
            </button>
          )}
          {!readOnly && record.status === "PUBLISHED" && (
            <EditPublishedRecord item={record} api={api} writable={writable} />
          )}
          {!readOnly && user?.isAdmin === true && (
            <RecordLifecycleButton
              item={record}
              api={api}
              onChanged={() => {
                void detail.refetch();
                onListChanged?.();
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

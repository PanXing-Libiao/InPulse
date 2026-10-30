import React, { useState } from "react";
import { Alert } from "antd";
import type { InpulseApiClient, TaskGroupRecordItem } from "@generated/api";
import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { isCardClick } from "@features/common/card-click";
import {
  CalmBadge,
  CalmEmptyState,
  CalmSegmented,
} from "@features/common/components/Calm";
import {
  RecordDetailModal,
  type RecordDetailTarget,
} from "@features/published-records/RecordDetailModal";
import {
  taskPriorityBadgeTone,
  taskPriorityLabel,
  taskToneClassName,
} from "@features/common/task-tone";
import type { TaskLocation } from "@features/tasks/task-links";
import { TaskGroupRecordLinks } from "./TaskGroupRecordLinks";
import { UnmergeTaskGroupButton } from "./UnmergeTaskGroupButton";
import {
  describeTaskGroupError,
  useTaskGroupQuery,
  useTaskGroupRecordsQuery,
} from "./task-groups-query";
import { formatDateTime, formatDay } from "./task-groups-format";
import {
  memberRoleLabel,
  type TaskGroupAdapter,
  type TaskGroupMember,
} from "./task-groups-types";
import { CalmSkeleton } from "@features/common/components/CalmSkeleton";

/**
 * F-25 聚合组正文面板：成员与分支、组内记录（按分支筛选、服务端过滤并以签名
 * 游标分页，R-4）。视图只消费服务端字段：不复制任务或记录实体，也不展示原始
 * 审计内容；GitHub 链接按关联时刻快照标注（A 裁决 Q-13 / Q-14）。解除合并入口
 * 只对活跃 SOURCE 成员开放（F-24）。
 *
 * 本实现由 TaskGroupDetailModal 独占使用（`/task-groups/{id}` 独立页已删除），
 * 记录筛选状态由宿主弹层持有，面板本身不读 URL。成员任务标题经宿主下发的
 * `onOpenTask` 就地打开任务详情（与任务中心、模块任务页同一实现）。
 */

const ALL_RECORDS_VALUE = "all";

/** 聚合组记录列表 → 详情弹窗入参：分支任务作为眉标语境，作废状态由弹窗补。 */
function recordDetailTarget(record: TaskGroupRecordItem): RecordDetailTarget {
  return {
    recordId: record.recordId,
    code: record.code,
    title: record.title,
    recordStatus: record.recordStatus,
    publishedAt: record.publishedAt,
    contextLabel:
      record.sourceLabel === "主任务"
        ? "主任务"
        : "分支任务 " + record.sourceLabel,
    externalLinks: record.externalLinks,
  };
}

const workStatusLabels = {
  TODO: "未完成",
  DONE: "已完成",
  CANCELED: "已取消",
} as const;

const workStatusTone = {
  TODO: "blue",
  DONE: "green",
  CANCELED: "gray",
} as const;

export interface TaskGroupDetailPanelsProps {
  readonly groupId: number;
  readonly adapter: TaskGroupAdapter;
  /** 解除合并写路径使用的生成客户端。 */
  readonly api: InpulseApiClient;
  /** 记录筛选命中的成员任务 id；null 表示全部记录。 */
  readonly memberTaskId: number | null;
  readonly onMemberTaskIdChange: (memberTaskId: number | null) => void;
  /** 解除合并等写操作完成后回调宿主，供列表等上层数据刷新。 */
  readonly onChanged?: (() => void) | undefined;
  /**
   * 点击成员任务标题时就地打开任务详情弹窗：由宿主页面下发（任务中心与模块任务页
   * 都传同一实现），缺省时标题按纯文本渲染，不给出点了没反应的入口。
   */
  readonly onOpenTask?: ((location: TaskLocation) => void) | undefined;
}

export const TaskGroupDetailPanels: React.FC<TaskGroupDetailPanelsProps> = ({
  groupId,
  adapter,
  api,
  memberTaskId,
  onMemberTaskIdChange,
  onChanged,
  onOpenTask,
}) => {
  const groupQuery = useTaskGroupQuery({ groupId, adapter });
  const [unmerged, setUnmerged] = useState(false);
  /** 当前打开的记录详情（null 表示弹层关闭）。 */
  const [openRecord, setOpenRecord] = useState<TaskGroupRecordItem | null>(
    null,
  );

  const group = groupQuery.data?.group ?? null;
  const members = groupQuery.data?.members ?? [];
  const mainMember = members.find((member) => member.role === "MAIN") ?? null;
  const activeSources = members.filter(
    (member) => member.role === "SOURCE" && member.memberStatus === "ACTIVE",
  );
  const effectiveMemberTaskId =
    memberTaskId !== null &&
    members.some((member) => member.taskId === memberTaskId)
      ? memberTaskId
      : null;

  const recordsQuery = useTaskGroupRecordsQuery({
    groupId,
    memberTaskId: effectiveMemberTaskId,
    adapter,
  });
  const records = recordsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  /** 成员任务自带归属（moduleId），点击后按它自身的范围打开详情。 */
  const openMemberTask = (member: TaskGroupMember) => {
    if (onOpenTask === undefined || group === null) return;
    onOpenTask({
      projectId: group.projectId,
      moduleId: member.moduleId,
      taskId: member.taskId,
    });
  };

  const filterOptions = [
    { value: ALL_RECORDS_VALUE, label: "全部记录" },
    ...members.map((member) => ({
      value: String(member.taskId),
      label: member.role === "MAIN" ? "主任务" : "分支任务 " + member.taskCode,
    })),
  ];

  // 分支卡片与任务卡片同一套配色（2026-09-21）：未完成按优先级铺淡色底与左侧
  // 色条，已完成转青碧、已取消转灰；已解除合并的历史成员保持灰底。
  // 整块成员区就是任务入口（2026-09-22 产品要求）：点空白处、徽章或元信息文字
  // 都能打开任务详情，不必瞄准标题；块内的按钮（解除合并）由 isCardClick 拦截，
  // 不会顺带触发。宿主未下发 onOpenTask 时保持纯展示，不加焦点也不给手型。
  const memberOpenable = onOpenTask !== undefined;
  const renderMember = (member: TaskGroupMember) => {
    const detached = member.memberStatus === "DETACHED";
    return (
      <li
        key={member.taskId}
        className={
          detached
            ? "task-group-member detached"
            : "task-group-member " +
              taskToneClassName(member.priority, member.workStatus)
        }
        data-testid={"task-group-member-" + member.taskId}
        tabIndex={memberOpenable ? 0 : undefined}
        aria-label={
          memberOpenable ? "查看任务详情：" + member.title : undefined
        }
        onClick={(event) => {
          if (!memberOpenable || !isCardClick(event)) return;
          openMemberTask(member);
        }}
        onKeyDown={(event) => {
          if (!memberOpenable) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          openMemberTask(member);
        }}
      >
        <div className="task-group-member-head">
          <span className="task-id">{member.taskCode}</span>
          <CalmBadge tone={member.role === "MAIN" ? "violet" : "cyan"}>
            {memberRoleLabel(member)}
          </CalmBadge>
          <CalmBadge tone={workStatusTone[member.workStatus]}>
            {workStatusLabels[member.workStatus]}
          </CalmBadge>
          <CalmBadge
            tone={taskPriorityBadgeTone(member.priority)}
            title={"优先级：" + taskPriorityLabel(member.priority)}
          >
            {taskPriorityLabel(member.priority)}
          </CalmBadge>
          {member.role === "SOURCE" && member.memberStatus === "ACTIVE" ? (
            <UnmergeTaskGroupButton
              groupId={groupId}
              member={{
                taskId: member.taskId,
                taskCode: member.taskCode,
                title: member.title,
              }}
              closesGroup={activeSources.length === 1}
              api={api}
              onReload={async () => {
                await groupQuery.refetch();
              }}
              onChanged={() => {
                setUnmerged(true);
                onChanged?.();
              }}
            />
          ) : null}
        </div>
        {onOpenTask === undefined ? (
          <strong>{member.title}</strong>
        ) : (
          <button
            type="button"
            className="task-group-member-title"
            aria-haspopup="dialog"
            data-testid={"task-group-member-open-" + member.taskId}
            onClick={() => openMemberTask(member)}
          >
            <strong>{member.title}</strong>
          </button>
        )}
        <p className="task-group-member-meta">
          {"负责人 " +
            member.assignee.name +
            " · 已发布记录 " +
            member.publishedRecordCount +
            " 条 · 合并于 " +
            formatDay(member.joinedAt)}
        </p>
        {detached ? (
          <p
            className="permission-hint"
            data-testid={"task-group-detached-" + member.taskId}
          >
            <InpulseIcon name="alert" size={14} />
            {member.detachedAt === null
              ? "已解除合并"
              : "已于 " + formatDateTime(member.detachedAt) + " 解除合并"}
            {member.detachReason === null ? "" : "：" + member.detachReason}
          </p>
        ) : null}
        {member.role === "SOURCE" &&
        member.memberStatus === "ACTIVE" &&
        member.sourceKind === "HISTORICAL" ? (
          <p
            className="permission-hint"
            data-testid={"task-group-historical-" + member.taskId}
          >
            <InpulseIcon name="alert" size={14} />
            {"历史分支：后续工作建议归入主任务" +
              (mainMember === null ? "" : " " + mainMember.taskCode) +
              "。"}
          </p>
        ) : null}
      </li>
    );
  };

  return (
    <>
      {unmerged ? (
        <div data-testid="task-group-unmerged-notice">
          <Alert type="success" title="已解除合并，聚合组状态与记录已刷新。" />
        </div>
      ) : null}

      {groupQuery.isPending ? (
        <CalmSkeleton variant="lines" rows={4} label="正在加载聚合组…" />
      ) : groupQuery.isError ? (
        <Alert type="error" title={describeTaskGroupError(groupQuery.error)} />
      ) : (
        <>
          {group !== null && group.status === "CLOSED" ? (
            <Alert
              type="warning"
              title="聚合组已关闭：组内分支已全部解除，历史关系与记录仍可查看。"
            />
          ) : null}
          <div className="task-group-panels">
            <section
              className="overview-panel"
              aria-labelledby="task-group-members-title"
            >
              <div className="panel-head">
                <div>
                  <h2 id="task-group-members-title">成员与分支</h2>
                  <p>
                    {activeSources.length > 0
                      ? "活跃分支 " +
                        activeSources.length +
                        " 个 · 可逐个解除合并"
                      : "没有活跃分支"}
                  </p>
                </div>
              </div>
              {members.length > 0 ? (
                <ul className="task-group-member-list">
                  {members.map(renderMember)}
                </ul>
              ) : (
                <CalmEmptyState
                  icon="gitMerge"
                  title="暂无组成员"
                  description="聚合组创建后，主任务与分支任务会显示在这里。"
                />
              )}
            </section>
            <section
              className="overview-panel"
              aria-labelledby="task-group-records-title"
            >
              <div className="panel-head">
                <div>
                  <h2 id="task-group-records-title">迭代记录</h2>
                  <p>组内已发布与已作废记录；按记录归属的分支任务标注</p>
                </div>
              </div>
              <div className="task-group-record-filter">
                <CalmSegmented
                  label="记录筛选"
                  value={
                    effectiveMemberTaskId === null
                      ? ALL_RECORDS_VALUE
                      : String(effectiveMemberTaskId)
                  }
                  options={filterOptions}
                  onChange={(value) =>
                    onMemberTaskIdChange(
                      value === ALL_RECORDS_VALUE ? null : Number(value),
                    )
                  }
                />
              </div>
              {recordsQuery.isPending ? (
                <CalmSkeleton variant="list" rows={3} label="正在加载记录" />
              ) : recordsQuery.isError ? (
                <Alert
                  type="error"
                  title={describeTaskGroupError(recordsQuery.error)}
                />
              ) : records.length === 0 ? (
                <CalmEmptyState
                  icon="calendar"
                  title="暂无迭代记录"
                  description={
                    effectiveMemberTaskId === null
                      ? "组内任务发布迭代记录后会按分支汇聚在这里。"
                      : "该分支还没有已发布或已作废的迭代记录。"
                  }
                />
              ) : (
                <>
                  <ul className="task-group-record-list">
                    {records.map((record) => (
                      <li
                        key={record.recordId}
                        data-testid={"task-group-record-" + record.recordId}
                      >
                        {/* 整块摘要可点开详情弹窗；关联记录切换按钮留在按钮外，
                            避免交互元素嵌套。 */}
                        <button
                          type="button"
                          className="task-group-record-open"
                          data-testid={
                            "task-group-record-open-" + record.recordId
                          }
                          aria-haspopup="dialog"
                          onClick={() => setOpenRecord(record)}
                        >
                          <span className="task-group-record-head">
                            <span className="task-id">{record.code}</span>
                            <CalmBadge
                              tone={
                                record.sourceLabel === "主任务"
                                  ? "violet"
                                  : "cyan"
                              }
                            >
                              {record.sourceLabel === "主任务"
                                ? "主任务"
                                : "分支任务 " + record.sourceLabel}
                            </CalmBadge>
                            {record.recordStatus === "VOID" ? (
                              <CalmBadge tone="gray">已作废</CalmBadge>
                            ) : null}
                            <InpulseIcon
                              name="chevronRight"
                              size={14}
                              className="task-group-record-open-chevron"
                            />
                          </span>
                          <strong>{record.title}</strong>
                          <small className="task-group-record-meta">
                            {formatDay(record.publishedAt) + " 发布"}
                          </small>
                        </button>
                        {record.externalLinks.length > 0 ? (
                          <TaskGroupRecordLinks
                            recordId={record.recordId}
                            links={record.externalLinks}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {recordsQuery.hasNextPage ? (
                    <div className="task-group-load-more">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={recordsQuery.isFetchingNextPage}
                        onClick={() => void recordsQuery.fetchNextPage()}
                      >
                        {recordsQuery.isFetchingNextPage
                          ? "正在加载…"
                          : "加载更多"}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          </div>
        </>
      )}
      {group === null ? null : (
        <RecordDetailModal
          projectId={group.projectId}
          record={openRecord === null ? null : recordDetailTarget(openRecord)}
          api={api}
          /* 本面板只出现在 `lg` 的聚合组弹窗里，记录详情必须收窄才能看出层级。 */
          nested
          onClose={() => setOpenRecord(null)}
          onChanged={() => {
            // 修订、作废与遗留项操作会改变记录正文、组成员计数与筛选结果。
            void recordsQuery.refetch();
            void groupQuery.refetch();
            onChanged?.();
          }}
        />
      )}
    </>
  );
};

export default TaskGroupDetailPanels;

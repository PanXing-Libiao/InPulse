import React from "react";

import { InpulseIcon } from "@features/common/components/InpulseIcon";

import {
  avatarTextOf,
  avatarToneOf,
  dueListLabelOf,
  laneProgressOf,
  laneToneOf,
  LEFTOVER_SOURCE_BADGE,
  priorityMarkOf,
  workStatusLabelOf,
  workStatusToneOf,
} from "../task-board-format";
import { assigneeNamesOf } from "@features/tasks/detached-assignee";
import type { TaskBoardCard, TaskBoardModule } from "../task-board-types";

/**
 * 列表视图：按模块分组的高密度表格，列固定为
 * 编号 / 标题 / 负责人 / 优先级 / 状态 / 截止或完成时间。
 * 分组头沿用泳道统计（全量口径），行点击就地打开任务详情。
 * 行底色按优先级区分程度（紧急红 / 高橙 / 普通蓝 / 低灰），已完成与
 * 已取消覆盖为对应状态色；色值只在 design-system.css 的 --tb-row-* 维护。
 * 遗留问题来源任务在标题前带「遗留问题」徽章（与卡片同一标记）。
 */
export interface TaskBoardTableProps {
  readonly modules: readonly TaskBoardModule[];
  readonly collapsedIds: ReadonlySet<number>;
  readonly leftoverIds: ReadonlySet<number>;
  /** 项目活跃成员 id：null = 名单未就绪，此时不标「已移出项目」。 */
  readonly activeMemberIds: ReadonlySet<number> | null;
  readonly onToggleLane: (moduleId: number) => void;
  readonly onOpenTask: (card: TaskBoardCard) => void;
}

/**
 * 行配色类：优先级决定底色与左侧色条，DONE / CANCELED 覆盖状态色。
 * 遗留问题来源不覆盖行配色（2026-09-23 八次配色定案），只由标题前的
 * 「遗留问题」徽章表达。类名与 design-system.css 的 --tb-row-* 变量一一对应。
 */
function rowClassNameOf(card: TaskBoardCard): string {
  const base = "tb-row tb-row--tone-" + priorityMarkOf(card.priority).tone;
  if (card.workStatus === "DONE") return base + " tb-row--done";
  if (card.workStatus === "CANCELED") return base + " tb-row--canceled";
  return base;
}

const TaskBoardTableRow: React.FC<{
  readonly card: TaskBoardCard;
  readonly leftoverSource: boolean;
  readonly index: number;
  readonly activeMemberIds: ReadonlySet<number> | null;
  readonly onOpen: (card: TaskBoardCard) => void;
}> = ({ card, leftoverSource, index, activeMemberIds, onOpen }) => {
  const due = dueListLabelOf(card);
  const priority = priorityMarkOf(card.priority);
  // ADR-040：负责人是平权集合，列表行要列出全部人，用「、」连接，
  // 超出列宽时由 .tb-owner-name 省略并以 title 兑底全名单。
  const lead = card.assignees[0];
  // 负责人已移出项目时姓名后面带「（已移出项目）」，hover 再给一句处置指引。
  const assigneeNames = assigneeNamesOf(card.assignees, activeMemberIds, false);
  // 进入动画的错开序号：上限 12，长分组里最后一行不必等太久（见 .tb-row）。
  const enterIndex = Math.min(index, 12);
  return (
    <button
      type="button"
      className={rowClassNameOf(card)}
      style={{ "--tb-enter-i": enterIndex } as React.CSSProperties}
      onClick={() => onOpen(card)}
      aria-label={"打开任务 " + card.code + " " + card.title}
    >
      <span className="tb-code">{card.code}</span>
      <span className="tb-row-title">
        {leftoverSource ? (
          <span
            className={LEFTOVER_SOURCE_BADGE.className}
            title={LEFTOVER_SOURCE_BADGE.title}
          >
            {LEFTOVER_SOURCE_BADGE.label}
          </span>
        ) : null}
        <span className="tb-row-title-text">{card.title}</span>
      </span>
      <span className="tb-row-owner">
        {lead === undefined ? null : (
          <span className={"tb-ava " + avatarToneOf(lead.userId)}>
            {avatarTextOf(lead.name)}
          </span>
        )}
        <span
          className="tb-owner-name"
          title={
            "负责人：" + assigneeNamesOf(card.assignees, activeMemberIds, true)
          }
        >
          {assigneeNames}
        </span>
      </span>
      <span className={"tb-prio tb-prio--" + priority.tone}>
        {priority.label}
      </span>
      <span className={"tb-st tb-st--" + workStatusToneOf(card.workStatus)}>
        {workStatusLabelOf(card.workStatus)}
      </span>
      <span className={"tb-row-date tb-date--" + due.tone}>{due.text}</span>
    </button>
  );
};

export const TaskBoardTable: React.FC<TaskBoardTableProps> = ({
  modules,
  collapsedIds,
  leftoverIds,
  activeMemberIds,
  onToggleLane,
  onOpenTask,
}) => {
  return (
    <div className="tb-list-wrap">
      <div className="tb-list-head">
        <span>编号</span>
        <span>标题</span>
        <span>负责人</span>
        <span>优先级</span>
        <span>状态</span>
        <span>截止 / 完成</span>
      </div>
      {modules.map((lane) => {
        const progress = laneProgressOf(lane);
        const collapsed = collapsedIds.has(lane.moduleId);
        return (
          <section className="tb-lgroup-section" key={lane.moduleId}>
            <div
              className={
                "tb-lgroup" + (collapsed ? " tb-lgroup--collapsed" : "")
              }
              onClick={() => onToggleLane(lane.moduleId)}
            >
              {/* 箭头按钮保留键盘焦点与可访问名；点击事件冒泡到整行头部统一切换。 */}
              <button
                type="button"
                className="tb-lane-toggle"
                aria-expanded={!collapsed}
                aria-label={(collapsed ? "展开模块 " : "折叠模块 ") + lane.name}
              >
                <InpulseIcon name="chevron" size={14} />
              </button>
              <span className={"tb-lane-icon " + laneToneOf(lane.moduleId)}>
                <InpulseIcon name="boxes" size={14} />
              </span>
              <strong>{lane.name}</strong>
              <span className="tb-lgroup-sub">
                {lane.stats.total} 个任务 · 进行中 {lane.stats.open}
              </span>
              {lane.stats.overdue > 0 ? (
                <span className="tb-emergency">逾期 {lane.stats.overdue}</span>
              ) : null}
              <div className="tb-lane-spacer" />
              <div className="tb-lane-progress">
                <div className="tb-bar">
                  <i
                    className={progress.percent < 60 ? "low" : ""}
                    style={{ width: progress.percent + "%" }}
                  />
                </div>
                <b>
                  {progress.done}/{progress.denominator}
                </b>
                <span>{progress.percent}%</span>
              </div>
            </div>
            {/* 展开 / 收起动画：行列表常驻挂载，data-open 驱动 grid-template-rows 的
                0fr ↔ 1fr 过渡（与泳道 .tb-lane-cards 同一套实现）；折叠收起后 clip 层
                visibility: hidden，行不参与键盘焦点与读屏。 */}
            <div
              className="tb-fold"
              data-open={collapsed ? "false" : "true"}
              aria-hidden={collapsed ? true : undefined}
            >
              <div className="tb-fold-clip">
                {lane.tasks.map((card, index) => (
                  <TaskBoardTableRow
                    key={card.taskId}
                    card={card}
                    leftoverSource={leftoverIds.has(card.taskId)}
                    index={index}
                    activeMemberIds={activeMemberIds}
                    onOpen={onOpenTask}
                  />
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
};

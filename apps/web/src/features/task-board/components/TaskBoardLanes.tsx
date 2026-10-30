import React from "react";

import { InpulseIcon } from "@features/common/components/InpulseIcon";
import { taskToneClassName } from "@features/common/task-tone";

import {
  avatarTextOf,
  avatarToneOf,
  cardMarkOf,
  dueLabelOf,
  laneProgressOf,
  laneToneOf,
  LEFTOVER_SOURCE_BADGE,
} from "../task-board-format";
import { assigneeNamesOf } from "@features/tasks/detached-assignee";
import type { TaskBoardCard, TaskBoardModule } from "../task-board-types";

/**
 * 看板视图：按模块分泳道，泳道头含模块名、任务计数、逾期角标、
 * 完成进度与负责人头像组；泳道内任务卡按服务端排序（与任务中心共用
 * apps/api/src/modules/tasks/task-list-order.ts 的同一套排序键）。点击卡片就地打开
 * 任务详情（TaskDetailOverlay）。
 *
 * 泳道头统计恒为全量口径，不随筛选跳变；被筛空的泳道整体隐藏。
 */
export interface TaskBoardLanesProps {
  readonly modules: readonly TaskBoardModule[];
  readonly collapsedIds: ReadonlySet<number>;
  readonly leftoverIds: ReadonlySet<number>;
  /** 项目活跃成员 id：null = 名单未就绪，此时不标「已移出项目」。 */
  readonly activeMemberIds: ReadonlySet<number> | null;
  readonly onToggleLane: (moduleId: number) => void;
  readonly onOpenTask: (card: TaskBoardCard) => void;
}

/**
 * 卡片配色与列表行、任务中心同源：优先级决定底色，已完成 / 已取消覆盖状态色。
 * 遗留问题来源同样不参与配色（2026-09-23 八次配色定案），来源只由卡片上的
 * 「遗留问题」徽章表达。已逾期 / 今天到期不参与配色（2026-09-22 产品口径
 * 「逾期的不搞特殊了，原本的优先级是什么就呈现什么颜色」）：看板只在日期文案上
 * 用 .tb-date--overdue / .tb-date--today 提示，且只读服务端 dueState，
 * 不在前端按本地时钟重算。
 */
function cardClassNameOf(card: TaskBoardCard): string {
  return "tb-card " + taskToneClassName(card.priority, card.workStatus);
}

const TaskBoardCardItem: React.FC<{
  readonly card: TaskBoardCard;
  readonly leftoverSource: boolean;
  readonly index: number;
  readonly activeMemberIds: ReadonlySet<number> | null;
  readonly onOpen: (card: TaskBoardCard) => void;
}> = ({ card, leftoverSource, index, activeMemberIds, onOpen }) => {
  const mark = cardMarkOf(card);
  const due = dueLabelOf(card);
  // ADR-040：负责人是平权集合，卡片要列出全部人（与任务中心同一口径），
  // 头像取首位、姓名用「、」连接，空间不足时由 .tb-meta-name 省略并以 title 兑底全名单。
  const lead = card.assignees[0];
  // 负责人已移出项目时姓名后面带「（已移出项目）」，hover 再给一句处置指引：
  // 看板此前只平铺姓名，人已移出也看不出来（2026-10-16 实测反馈）。
  const assigneeNames = assigneeNamesOf(card.assignees, activeMemberIds, false);
  // 进入动画的错开序号：上限 12，长泳道里最后一张不必等太久（见 .tb-lane-cards > li）。
  const enterIndex = Math.min(index, 12);
  return (
    <li style={{ "--tb-enter-i": enterIndex } as React.CSSProperties}>
      <button
        type="button"
        className={cardClassNameOf(card)}
        onClick={() => onOpen(card)}
        aria-label={"打开任务 " + card.code + " " + card.title}
      >
        <span className="tb-card-top">
          <span className="tb-code">{card.code}</span>
          <span className="tb-card-flags">
            {leftoverSource ? (
              <span
                className={LEFTOVER_SOURCE_BADGE.className}
                title={LEFTOVER_SOURCE_BADGE.title}
              >
                {LEFTOVER_SOURCE_BADGE.label}
              </span>
            ) : null}
            {mark.kind === "done" ? (
              <span
                className="tb-check"
                title={mark.label}
                aria-label={mark.label}
              >
                ✓
              </span>
            ) : (
              <span className={"badge badge-" + mark.tone}>{mark.label}</span>
            )}
          </span>
        </span>
        <span className="tb-card-title">{card.title}</span>
        <span className="tb-card-meta">
          {lead === undefined ? null : (
            <>
              <span className={"tb-ava " + avatarToneOf(lead.userId)}>
                {avatarTextOf(lead.name)}
              </span>
              <span
                className="tb-meta-name"
                title={
                  "负责人：" +
                  assigneeNamesOf(card.assignees, activeMemberIds, true)
                }
              >
                {assigneeNames}
              </span>
            </>
          )}
          <span className={"tb-date tb-date--" + due.tone}>{due.text}</span>
        </span>
      </button>
    </li>
  );
};

const TaskBoardLane: React.FC<{
  readonly lane: TaskBoardModule;
  readonly collapsed: boolean;
  readonly leftoverIds: ReadonlySet<number>;
  readonly activeMemberIds: ReadonlySet<number> | null;
  readonly onToggle: () => void;
  readonly onOpenTask: (card: TaskBoardCard) => void;
}> = ({
  lane,
  collapsed,
  leftoverIds,
  activeMemberIds,
  onToggle,
  onOpenTask,
}) => {
  const progress = laneProgressOf(lane);
  return (
    <article
      className={"tb-lane" + (collapsed ? " tb-lane--collapsed" : "")}
      aria-label={"模块 " + lane.name}
    >
      {" "}
      <header className="tb-lane-head" onClick={onToggle}>
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
        <div className="tb-lane-title">
          <h2>{lane.name}</h2>
          <p>
            {lane.stats.total} 个任务 · 进行中 {lane.stats.open}
          </p>
        </div>
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
        <div className="tb-lane-people">
          {lane.assignees.map((user) => (
            <span
              key={user.userId}
              className={"tb-avatar " + avatarToneOf(user.userId)}
              title={user.name}
            >
              {avatarTextOf(user.name)}
            </span>
          ))}
        </div>
      </header>
      {/* 展开 / 收起动画：卡片列表常驻挂载，data-open 驱动 grid-template-rows 的
          0fr ↔ 1fr 过渡（与项目树 .tree-children 同一范式）；折叠收起后 clip 层
          visibility: hidden，卡片不参与键盘焦点与读屏。列表视图的行列表共用这套实现。 */}
      <div
        className="tb-fold"
        data-open={collapsed ? "false" : "true"}
        aria-hidden={collapsed ? true : undefined}
      >
        <div className="tb-fold-clip">
          <ul className="tb-lane-cards">
            {lane.tasks.map((card, index) => (
              <TaskBoardCardItem
                key={card.taskId}
                card={card}
                leftoverSource={leftoverIds.has(card.taskId)}
                index={index}
                activeMemberIds={activeMemberIds}
                onOpen={onOpenTask}
              />
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
};

export const TaskBoardLanes: React.FC<TaskBoardLanesProps> = ({
  modules,
  collapsedIds,
  leftoverIds,
  activeMemberIds,
  onToggleLane,
  onOpenTask,
}) => {
  return (
    <div className="tb-board">
      {modules.map((lane) => (
        <TaskBoardLane
          key={lane.moduleId}
          lane={lane}
          collapsed={collapsedIds.has(lane.moduleId)}
          leftoverIds={leftoverIds}
          activeMemberIds={activeMemberIds}
          onToggle={() => onToggleLane(lane.moduleId)}
          onOpenTask={onOpenTask}
        />
      ))}
    </div>
  );
};

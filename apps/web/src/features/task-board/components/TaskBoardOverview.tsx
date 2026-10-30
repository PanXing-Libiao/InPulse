import React from "react";

import {
  completionSplitOf,
  ringDashOffsetOf,
  TASK_BOARD_RING_CIRCUMFERENCE,
} from "../task-board-format";
import type { TaskBoardStats } from "../task-board-types";

/**
 * 顶部项目完成程度卡：环形完成率 + 三段构成条 + 六项指标。
 *
 * 统计恒为项目全量口径，不随筛选跳变（定稿取舍）：筛选生效时在图表区追加
 * 「筛选结果 N / 总数 · 清除筛选」，避免把筛选结果误读成项目完成率。
 */
export interface TaskBoardOverviewProps {
  readonly stats: TaskBoardStats;
  readonly visibleCount: number;
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
}

export const TaskBoardOverview: React.FC<TaskBoardOverviewProps> = ({
  stats,
  visibleCount,
  filtered,
  onClearFilters,
}) => {
  const split = completionSplitOf(stats);
  const hasDenominator = stats.done + stats.open > 0;
  return (
    <section className="tb-overview" aria-label="项目完成程度">
      <div
        className="tb-ring"
        role="img"
        aria-label={
          "项目完成率 " +
          (hasDenominator ? stats.completionRate + "%" : "暂无数据")
        }
      >
        <svg viewBox="0 0 104 104" aria-hidden="true">
          <circle
            cx="52"
            cy="52"
            r="44"
            fill="none"
            stroke="#e7eef6"
            strokeWidth="10"
          />
          <circle
            className="tb-ring-fg"
            cx="52"
            cy="52"
            r="44"
            fill="none"
            stroke="#3f9d72"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={TASK_BOARD_RING_CIRCUMFERENCE}
            strokeDashoffset={ringDashOffsetOf(stats.completionRate)}
            transform="rotate(-90 52 52)"
          />
        </svg>
        <div className="tb-ring-center">
          <b>{hasDenominator ? stats.completionRate + "%" : "—"}</b>
          <span>项目完成率</span>
        </div>
      </div>

      <div className="tb-overview-mid">
        <div className="tb-overview-head">
          <b>
            已完成 {stats.done} / {stats.total}
          </b>
          <span>
            未完成 {stats.open} · 逾期 {stats.overdue} · 今日到期{" "}
            {stats.dueToday}
          </span>
        </div>
        <div className="tb-split-bar" aria-hidden="true">
          <i className="sb-done" style={{ width: split.donePercent + "%" }} />
          <i className="sb-todo" style={{ width: split.todoPercent + "%" }} />
        </div>
        <div className="tb-legend">
          <span>
            <i className="tb-dot sb-done" aria-hidden="true" />
            已完成
            <b>{stats.done}</b>
          </span>
          <span>
            <i className="tb-dot sb-todo" aria-hidden="true" />
            未完成
            <b>{stats.open}</b>
          </span>
          {filtered ? (
            <span className="tb-filter-info">
              筛选结果 {visibleCount} / {stats.total}
              <button
                type="button"
                className="tb-link"
                onClick={onClearFilters}
              >
                清除筛选
              </button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="tb-metrics">
        <div className="tb-metric">
          <span>未完成任务</span>
          <b>{stats.open}</b>
        </div>
        <div className="tb-metric tb-warn">
          <span>已逾期</span>
          <b>{stats.overdue}</b>
        </div>
        <div className="tb-metric tb-soon">
          <span>今日到期</span>
          <b>{stats.dueToday}</b>
        </div>
        <div className="tb-metric tb-good">
          <span>本周完成</span>
          <b>{stats.completedThisWeek}</b>
        </div>
        <div className="tb-metric">
          <span>已取消任务</span>
          <b>{stats.canceled}</b>
        </div>
        <div className="tb-metric">
          <span>参与成员</span>
          <b>{stats.memberCount}</b>
        </div>
      </div>
    </section>
  );
};

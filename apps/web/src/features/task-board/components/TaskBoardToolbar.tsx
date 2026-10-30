import React from "react";

import {
  CalmSegmentedThumb,
  useCalmSegmentedThumb,
} from "@features/common/components/Calm";
import { CalmSelect } from "@features/common/components/CalmSelect";
import { priorityDotColor } from "@features/common/priority-select-option";
import { InpulseIcon } from "@features/common/components/InpulseIcon";

import type {
  TaskBoardFilters,
  TaskBoardPriority,
  TaskBoardStatusFilter,
  TaskBoardTimeFilter,
  UserRef,
} from "../task-board-types";

/**
 * 工具栏：看板 / 列表切换 + 状态与时间 chips + 优先级与负责人下拉 + 搜索。
 *
 * 交互与定稿一致（尽量少点击）：状态 chip 直接切换并重置时间筛选；
 * 时间 chip 再次点击即取消；下拉与搜索即时生效；筛选状态由页面写入 URL。
 */

export interface TaskBoardToolbarCounts {
  readonly all: number;
  readonly open: number;
  readonly done: number;
  readonly overdue: number;
  readonly today: number;
}

interface StatusChipSpec {
  readonly key: TaskBoardStatusFilter;
  readonly label: string;
  readonly countKey: keyof TaskBoardToolbarCounts;
}

const statusChips: readonly StatusChipSpec[] = [
  { key: "all", label: "全部", countKey: "all" },
  { key: "open", label: "未完成", countKey: "open" },
  { key: "done", label: "已完成", countKey: "done" },
];

const timeChips: readonly {
  readonly key: TaskBoardTimeFilter;
  readonly label: string;
  readonly countKey: keyof TaskBoardToolbarCounts;
}[] = [
  { key: "overdue", label: "逾期", countKey: "overdue" },
  { key: "today", label: "今日到期", countKey: "today" },
];

const priorityOptions: readonly {
  readonly value: TaskBoardPriority;
  readonly label: string;
  readonly dotColor: string;
}[] = [
  { value: "URGENT", label: "紧急", dotColor: priorityDotColor("URGENT") },
  { value: "HIGH", label: "高", dotColor: priorityDotColor("HIGH") },
  { value: "NORMAL", label: "普通", dotColor: priorityDotColor("NORMAL") },
];

export interface TaskBoardToolbarProps {
  readonly filters: TaskBoardFilters;
  readonly counts: TaskBoardToolbarCounts;
  readonly assignees: readonly UserRef[];
  readonly onChange: (next: TaskBoardFilters) => void;
}

export const TaskBoardToolbar: React.FC<TaskBoardToolbarProps> = ({
  filters,
  counts,
  assignees,
  onChange,
}) => {
  const { trackRef, thumb } = useCalmSegmentedThumb();

  return (
    <section className="tb-toolbar" aria-label="任务看板视图与筛选">
      <div
        className="segmented segmented-slide"
        role="group"
        aria-label="视图切换"
        ref={trackRef}
      >
        <button
          type="button"
          className={filters.view === "board" ? "selected" : undefined}
          aria-pressed={filters.view === "board"}
          onClick={() => onChange({ ...filters, view: "board" })}
        >
          <InpulseIcon name="layoutGrid" size={12} />
          看板
        </button>
        <button
          type="button"
          className={filters.view === "list" ? "selected" : undefined}
          aria-pressed={filters.view === "list"}
          onClick={() => onChange({ ...filters, view: "list" })}
        >
          <InpulseIcon name="list" size={12} />
          列表
        </button>
        <CalmSegmentedThumb box={thumb} />
      </div>

      <div className="tb-chips" role="group" aria-label="按状态筛选">
        {statusChips.map((chip) => {
          const selected = filters.status === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              className={selected ? "tb-chip selected" : "tb-chip"}
              aria-pressed={selected}
              onClick={() =>
                onChange({ ...filters, status: chip.key, time: "all" })
              }
            >
              {chip.label}
              <span className="tb-chip-count">{counts[chip.countKey]}</span>
            </button>
          );
        })}
      </div>

      <span className="tb-divider" aria-hidden="true" />

      <div className="tb-chips" role="group" aria-label="按时间筛选">
        {timeChips.map((chip) => {
          const selected = filters.time === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              className={selected ? "tb-chip selected" : "tb-chip"}
              aria-pressed={selected}
              onClick={() =>
                onChange({
                  ...filters,
                  time: selected ? "all" : chip.key,
                })
              }
            >
              {chip.label}
              <span className="tb-chip-count">{counts[chip.countKey]}</span>
            </button>
          );
        })}
      </div>

      <div className="tb-toolbar-right">
        <CalmSelect
          className="tb-select"
          ariaLabel="按优先级筛选"
          value={filters.priority ?? "all"}
          appearance="menu"
          onChange={(next) =>
            onChange({
              ...filters,
              priority: next === "all" ? null : (next as TaskBoardPriority),
            })
          }
          options={[
            { value: "all", label: "全部优先级" },
            ...priorityOptions.map((option) => ({
              value: option.value,
              label: option.label,
              dotColor: option.dotColor,
            })),
          ]}
          animated
        />
        <CalmSelect
          className="tb-select"
          ariaLabel="按负责人筛选"
          value={
            filters.assigneeId === null ? "all" : String(filters.assigneeId)
          }
          appearance="member"
          onChange={(next) =>
            onChange({
              ...filters,
              assigneeId: next === "all" ? null : Number(next),
            })
          }
          options={[
            { value: "all", label: "全部负责人" },
            ...assignees.map((user) => ({
              value: String(user.userId),
              label: user.name,
              avatarUrl: user.avatarUrl,
            })),
          ]}
          animated
        />
        <input
          className="tb-search"
          type="search"
          aria-label="搜索任务"
          placeholder="搜索编号 / 标题 / 负责人"
          value={filters.query}
          onChange={(event) =>
            onChange({ ...filters, query: event.target.value })
          }
        />
      </div>
    </section>
  );
};

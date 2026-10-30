import type { CalmBadgeTone } from "@features/common/components/Calm";
import { taskPriorityBadgeTone } from "@features/common/task-tone";

import type {
  TaskBoardCard,
  TaskBoardModule,
  TaskBoardPriority,
  TaskBoardStats,
  TaskBoardWorkStatus,
} from "./task-board-types";

/**
 * 任务看板展示映射（纯函数）。
 *
 * 日期一律按 Asia/Shanghai 渲染，与契约里 dueState / 统计的时区口径一致；
 * 组件不得用本地时区重新格式化任务日期。逾期与「今天」只读服务端 dueState，
 * 前端不做任何时间判断。
 */

export type BadgeTone = "red" | "amber" | "blue" | "gray" | "green";

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
});

const SHANGHAI_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function readPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/** MM-DD（Asia/Shanghai）。 */
export function formatTaskBoardDay(iso: string): string {
  const parts = SHANGHAI_DAY_FORMATTER.formatToParts(new Date(iso));
  return readPart(parts, "month") + "-" + readPart(parts, "day");
}

/** YYYY-MM-DD HH:mm（Asia/Shanghai），用于「数据截至」。 */
export function formatTaskBoardDateTime(iso: string): string {
  const parts = SHANGHAI_DATE_TIME_FORMATTER.formatToParts(new Date(iso));
  return (
    readPart(parts, "year") +
    "-" +
    readPart(parts, "month") +
    "-" +
    readPart(parts, "day") +
    " " +
    readPart(parts, "hour") +
    ":" +
    readPart(parts, "minute")
  );
}

export interface DueLabel {
  readonly text: string;
  readonly tone: "done" | "canceled" | "overdue" | "today" | "plain" | "none";
}

/** 卡片底部日期文案；语义只由 workStatus 与服务端 dueState 决定。 */
export function dueLabelOf(card: TaskBoardCard): DueLabel {
  if (card.workStatus === "DONE") {
    const record =
      card.publishedRecordCount > 0
        ? " · 迭代 " + card.publishedRecordCount
        : "";
    if (card.completedAt === null) {
      return { text: "已完成" + record, tone: "done" };
    }
    return {
      text: "完成 " + formatTaskBoardDay(card.completedAt) + record,
      tone: "done",
    };
  }
  if (card.workStatus === "CANCELED") {
    if (card.dueAt === null) {
      return { text: "已取消", tone: "canceled" };
    }
    return { text: formatTaskBoardDay(card.dueAt) + " 取消", tone: "canceled" };
  }
  if (card.dueAt === null) {
    return { text: "未设截止", tone: "none" };
  }
  const day = formatTaskBoardDay(card.dueAt);
  if (card.dueState === "OVERDUE") {
    return { text: day + " 逾期", tone: "overdue" };
  }
  if (card.dueState === "TODAY") {
    return { text: "今天 " + day, tone: "today" };
  }
  return { text: day + " 截止", tone: "plain" };
}

export interface CardMark {
  /** "done" 渲染绿色对勾；"badge" 渲染彩色徽章。 */
  readonly kind: "done" | "badge";
  readonly label: string;
  readonly tone: CalmBadgeTone;
}

export function priorityMarkOf(priority: TaskBoardPriority): {
  readonly label: string;
  readonly tone: BadgeTone;
} {
  switch (priority) {
    case "URGENT":
      return { label: "紧急", tone: "red" };
    case "HIGH":
      return { label: "高", tone: "amber" };
    case "NORMAL":
    default:
      return { label: "普通", tone: "gray" };
  }
}

/**
 * 看板卡右上角标记：已完成勾选 / 已取消灰徽章 / 其余按优先级彩色徽章。
 * 徽章色调取自共用的 `taskPriorityBadgeTone`（普通 = 淡蓝，2026-09-23 九次配色定案），
 * 与 `priorityMarkOf` 的 tone 刻意分开：后者同时喂看板列表行的行色类与优先级单元格，
 * 仍要保持六次定案那一档「白底蓝边」的行配色。
 */
export function cardMarkOf(card: TaskBoardCard): CardMark {
  if (card.workStatus === "DONE") {
    return { kind: "done", label: "已完成", tone: "green" };
  }
  if (card.workStatus === "CANCELED") {
    return { kind: "badge", label: "已取消", tone: "gray" };
  }
  return {
    kind: "badge",
    label: priorityMarkOf(card.priority).label,
    tone: taskPriorityBadgeTone(card.priority),
  };
}

/**
 * 裁决修订 D-2：由遗留问题转换而来的任务在看板卡片与列表行显示「遗留问题」
 * 徽章；数据来自 R-5 批量标记（hasLeftoverSource），读取失败时按缺席隐藏，
 * 与模块任务面板同一文案与色调。
 */
export const LEFTOVER_SOURCE_BADGE = {
  label: "遗留问题",
  className: "badge badge-leftover",
  title: "由遗留问题转换而来的跟进任务",
} as const;

export function workStatusLabelOf(status: TaskBoardWorkStatus): string {
  if (status === "DONE") return "已完成";
  if (status === "CANCELED") return "已取消";
  return "未完成";
}

export function workStatusToneOf(status: TaskBoardWorkStatus): BadgeTone {
  if (status === "DONE") return "green";
  if (status === "CANCELED") return "gray";
  return "blue";
}

export interface CompletionSplit {
  readonly done: number;
  readonly todo: number;
  readonly canceled: number;
  readonly total: number;
  readonly donePercent: number;
  readonly todoPercent: number;
  readonly canceledPercent: number;
}

/** 三段构成条：按全量 total 分配宽度（保留一位小数）。 */
export function completionSplitOf(stats: TaskBoardStats): CompletionSplit {
  const total = Math.max(stats.total, 0);
  const percentOf = (value: number): number =>
    total === 0 ? 0 : Math.round((value / total) * 1000) / 10;
  return {
    done: stats.done,
    todo: stats.open,
    canceled: stats.canceled,
    total,
    donePercent: percentOf(stats.done),
    todoPercent: percentOf(stats.open),
    canceledPercent: percentOf(stats.canceled),
  };
}

/** 泳道进度：done / (done + open)，与服务端 completionRate 同口径。 */
export function laneProgressOf(lane: TaskBoardModule): {
  readonly done: number;
  readonly denominator: number;
  readonly percent: number;
} {
  return {
    done: lane.stats.done,
    denominator: lane.stats.done + lane.stats.open,
    percent: lane.stats.completionRate,
  };
}

/** 圆形指示环：周长 276.46（r=44, stroke-width=10）。 */
export const TASK_BOARD_RING_CIRCUMFERENCE = 276.46;

export function ringDashOffsetOf(completionRate: number): number {
  const clamped = Math.min(Math.max(completionRate, 0), 100);
  return (TASK_BOARD_RING_CIRCUMFERENCE * (100 - clamped)) / 100;
}

const AVATAR_TONES = [
  "tb-ava-1",
  "tb-ava-2",
  "tb-ava-3",
  "tb-ava-4",
  "tb-ava-5",
  "tb-ava-6",
  "tb-ava-7",
  "tb-ava-8",
] as const;

/** 头像底色：按 userId 稳定分配，保证同一成员在各泳道颜色一致。 */
export function avatarToneOf(userId: number): string {
  const index =
    ((userId % AVATAR_TONES.length) + AVATAR_TONES.length) %
    AVATAR_TONES.length;
  return AVATAR_TONES[index] ?? "ava-1";
}

/** 头像文字：姓名首字。 */
export function avatarTextOf(name: string): string {
  return name.slice(0, 1);
}

const LANE_TONES = [
  "tb-tone-blue",
  "tb-tone-green",
  "tb-tone-violet",
  "tb-tone-amber",
  "tb-tone-cyan",
] as const;

/** 泳道图标底色：按 moduleId 稳定分配。 */
export function laneToneOf(moduleId: number): string {
  const index =
    ((moduleId % LANE_TONES.length) + LANE_TONES.length) % LANE_TONES.length;
  return LANE_TONES[index] ?? "tone-blue";
}

/**
 * 列表视图的截止 / 完成列文案：已完成显示完成日期，已取消显示截止日期，
 * 未完成按 dueState 显示「逾期 / 今天到期 / 日期 / 未设截止」。
 */
export function dueListLabelOf(card: TaskBoardCard): DueLabel {
  if (card.workStatus === "DONE") {
    if (card.completedAt === null) return { text: "已完成", tone: "done" };
    return { text: formatTaskBoardDay(card.completedAt), tone: "done" };
  }
  if (card.workStatus === "CANCELED") {
    if (card.dueAt === null) return { text: "—", tone: "canceled" };
    return { text: formatTaskBoardDay(card.dueAt), tone: "canceled" };
  }
  if (card.dueAt === null) return { text: "未设截止", tone: "none" };
  if (card.dueState === "OVERDUE") {
    return { text: formatTaskBoardDay(card.dueAt) + " 逾期", tone: "overdue" };
  }
  if (card.dueState === "TODAY") return { text: "今天到期", tone: "today" };
  return { text: formatTaskBoardDay(card.dueAt), tone: "plain" };
}

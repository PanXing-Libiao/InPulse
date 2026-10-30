import { describe, expect, it } from "vitest";

import type { TaskBoardCard, TaskBoardStats } from "./task-board-types";
import {
  avatarTextOf,
  avatarToneOf,
  cardMarkOf,
  completionSplitOf,
  dueLabelOf,
  dueListLabelOf,
  formatTaskBoardDateTime,
  formatTaskBoardDay,
  laneProgressOf,
  laneToneOf,
  priorityMarkOf,
  ringDashOffsetOf,
  TASK_BOARD_RING_CIRCUMFERENCE,
  workStatusLabelOf,
  workStatusToneOf,
} from "./task-board-format";

function cardOf(overrides: Partial<TaskBoardCard> = {}): TaskBoardCard {
  return {
    taskId: 1,
    code: "T-1001",
    title: "实现任务看板",
    moduleId: 3,
    priority: "NORMAL",
    workStatus: "TODO",
    dueAt: "2026-09-17T18:30:00.000Z",
    completedAt: null,
    dueState: "SCHEDULED",
    assignees: [{ userId: 9, name: "张启明", avatarUrl: null }],
    publishedRecordCount: 0,
    ...overrides,
  };
}

const stats: TaskBoardStats = {
  total: 42,
  done: 27,
  open: 12,
  canceled: 3,
  overdue: 3,
  dueToday: 2,
  completedThisWeek: 5,
  completionRate: 69,
  memberCount: 4,
};

describe("Asia/Shanghai 日期渲染", () => {
  it("跨日时间按上海时区落到次日", () => {
    expect(formatTaskBoardDay("2026-09-17T18:30:00.000Z")).toBe("09-18");
  });

  it("数据截至时间按上海时区渲染到分钟", () => {
    expect(formatTaskBoardDateTime("2026-09-17T06:20:00.000Z")).toBe(
      "2026-09-17 14:20",
    );
  });
});

describe("dueLabelOf", () => {
  it("已完成显示完成日期与迭代条数", () => {
    const card = cardOf({
      workStatus: "DONE",
      completedAt: "2026-09-17T18:30:00.000Z",
      publishedRecordCount: 2,
    });
    expect(dueLabelOf(card)).toEqual({
      text: "完成 09-18 · 迭代 2",
      tone: "done",
    });
  });

  it("已完成但没有完成时间时只显示状态", () => {
    expect(
      dueLabelOf(cardOf({ workStatus: "DONE", completedAt: null })),
    ).toEqual({ text: "已完成", tone: "done" });
  });

  it("已取消沿用截止日期，未设截止时退回状态", () => {
    expect(dueLabelOf(cardOf({ workStatus: "CANCELED" }))).toEqual({
      text: "09-18 取消",
      tone: "canceled",
    });
    expect(dueLabelOf(cardOf({ workStatus: "CANCELED", dueAt: null }))).toEqual(
      { text: "已取消", tone: "canceled" },
    );
  });

  it("未完成按 dueState 区分逾期、今日与临近", () => {
    expect(dueLabelOf(cardOf({ dueState: "OVERDUE" }))).toEqual({
      text: "09-18 逾期",
      tone: "overdue",
    });
    expect(dueLabelOf(cardOf({ dueState: "TODAY" }))).toEqual({
      text: "今天 09-18",
      tone: "today",
    });
    expect(dueLabelOf(cardOf({ dueState: "SCHEDULED" }))).toEqual({
      text: "09-18 截止",
      tone: "plain",
    });
    expect(dueLabelOf(cardOf({ dueAt: null, dueState: "NONE" }))).toEqual({
      text: "未设截止",
      tone: "none",
    });
  });
});

describe("dueListLabelOf", () => {
  it("列表视图区分已完成、已取消与到期状态", () => {
    expect(
      dueListLabelOf(
        cardOf({ workStatus: "DONE", completedAt: "2026-09-17T18:30:00.000Z" }),
      ),
    ).toEqual({ text: "09-18", tone: "done" });
    expect(
      dueListLabelOf(cardOf({ workStatus: "CANCELED", dueAt: null })),
    ).toEqual({ text: "—", tone: "canceled" });
    expect(dueListLabelOf(cardOf({ dueState: "TODAY" }))).toEqual({
      text: "今天到期",
      tone: "today",
    });
    expect(dueListLabelOf(cardOf({ dueState: "SCHEDULED" }))).toEqual({
      text: "09-18",
      tone: "plain",
    });
  });
});

describe("标记映射", () => {
  it("优先级三档各有独立文案与色调", () => {
    expect(priorityMarkOf("URGENT")).toEqual({ label: "紧急", tone: "red" });
    expect(priorityMarkOf("HIGH")).toEqual({ label: "高", tone: "amber" });
    expect(priorityMarkOf("NORMAL")).toEqual({ label: "普通", tone: "gray" });
  });

  it("已完成渲染绿勾，已取消渲染灰徽章，其余按优先级", () => {
    expect(cardMarkOf(cardOf({ workStatus: "DONE" }))).toEqual({
      kind: "done",
      label: "已完成",
      tone: "green",
    });
    expect(cardMarkOf(cardOf({ workStatus: "CANCELED" }))).toEqual({
      kind: "badge",
      label: "已取消",
      tone: "gray",
    });
    expect(cardMarkOf(cardOf({ priority: "URGENT" }))).toEqual({
      kind: "badge",
      label: "紧急",
      tone: "red",
    });
    // 2026-09-23 九次配色定案：卡上「普通」徽章与任务中心同一套淡蓝；
    // priorityMarkOf 的 tone 仍留给看板列表行的行配色，两者刻意不共用。
    expect(cardMarkOf(cardOf({ priority: "NORMAL" }))).toEqual({
      kind: "badge",
      label: "普通",
      tone: "blue",
    });
  });

  it("工作状态文案与色调固定", () => {
    expect(workStatusLabelOf("DONE")).toBe("已完成");
    expect(workStatusLabelOf("CANCELED")).toBe("已取消");
    expect(workStatusLabelOf("TODO")).toBe("未完成");
    expect(workStatusToneOf("DONE")).toBe("green");
    expect(workStatusToneOf("CANCELED")).toBe("gray");
    expect(workStatusToneOf("TODO")).toBe("blue");
  });
});

describe("统计派生", () => {
  it("三段构成条按全量总数分配宽度", () => {
    expect(completionSplitOf(stats)).toEqual({
      done: 27,
      todo: 12,
      canceled: 3,
      total: 42,
      donePercent: 64.3,
      todoPercent: 28.6,
      canceledPercent: 7.1,
    });
  });

  it("空项目不产生除零宽度", () => {
    const split = completionSplitOf({
      ...stats,
      total: 0,
      done: 0,
      open: 0,
      canceled: 0,
    });
    expect(split.donePercent).toBe(0);
    expect(split.todoPercent).toBe(0);
    expect(split.canceledPercent).toBe(0);
  });

  it("泳道进度与服务端 completionRate 同口径", () => {
    expect(
      laneProgressOf({
        moduleId: 3,
        name: "调度模块",
        stats: {
          total: 30,
          done: 25,
          open: 4,
          canceled: 1,
          overdue: 1,
          completionRate: 86,
        },
        assignees: [],
        tasks: [],
      }),
    ).toEqual({ done: 25, denominator: 29, percent: 86 });
  });

  it("环形进度按完成率换算 dashoffset 并被裁剪到 0 到 100", () => {
    expect(TASK_BOARD_RING_CIRCUMFERENCE).toBe(276.46);
    expect(ringDashOffsetOf(0)).toBeCloseTo(276.46, 2);
    expect(ringDashOffsetOf(100)).toBe(0);
    expect(ringDashOffsetOf(69)).toBeCloseTo(85.7026, 3);
    expect(ringDashOffsetOf(-20)).toBeCloseTo(276.46, 2);
    expect(ringDashOffsetOf(140)).toBe(0);
  });
});

describe("稳定色调分配", () => {
  it("头像色调按 userId 稳定映射到 8 档", () => {
    expect(avatarToneOf(9)).toBe("tb-ava-2");
    expect(avatarToneOf(8)).toBe("tb-ava-1");
    expect(avatarToneOf(0)).toBe("tb-ava-1");
    expect(avatarToneOf(9)).toBe(avatarToneOf(9));
    expect(avatarTextOf("张启明")).toBe("张");
  });

  it("泳道色调按 moduleId 稳定映射到 5 档", () => {
    expect(laneToneOf(0)).toBe("tb-tone-blue");
    expect(laneToneOf(1)).toBe("tb-tone-green");
    expect(laneToneOf(3)).toBe("tb-tone-amber");
    expect(laneToneOf(5)).toBe("tb-tone-blue");
  });
});

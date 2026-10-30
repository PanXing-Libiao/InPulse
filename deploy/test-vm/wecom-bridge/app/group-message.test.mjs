import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupActivityCard,
  buildGroupActivityMarkdown,
} from "./group-message.mjs";

const base = {
  activity_type: "module.create",
  summary: "模块创建：支付",
  occurred_at: "2026-10-21T05:58:00.000Z",
  project_name: "商城系统",
  project_code: "SHOP",
  actor_name: "邵晨宇",
  metadata: { moduleId: 12 },
  module_code: "SHOP-M-3",
  module_name: "支付",
  task_code: null,
  task_title: null,
  priority: null,
  work_status: null,
  due_at: null,
  task_assignees: null,
};

test("builds a layered task completion message with task and scope context", () => {
  const markdown = buildGroupActivityMarkdown({
    ...base,
    activity_type: "task.complete",
    summary: "任务完成：支付回调",
    metadata: { taskId: 99, moduleId: 12 },
    task_code: "SHOP-T-99",
    task_title: "支付回调",
    priority: "HIGH",
    work_status: "DONE",
    due_at: "2026-10-23T10:00:00.000Z",
    task_assignees: "邵晨宇、林雨研",
  });

  assert.match(markdown, /\*\*INPULSE · 任务\*\*/);
  assert.match(markdown, /\*\*商城系统\*\* ｜ SHOP/);
  assert.match(markdown, /\*\*任务已完成\*\*/);
  assert.match(markdown, /「支付回调」/);
  assert.match(markdown, /编号 SHOP-T-99 ｜ 优先级 高 ｜ 状态 已完成/);
  assert.match(markdown, /负责人 邵晨宇、林雨研/);
  assert.match(markdown, /截止 2026-10-23 18:00/);
  assert.match(markdown, /模块 SHOP-M-3 · 支付/);
  assert.doesNotMatch(markdown, /功能|所属模块/);
  assert.match(markdown, /操作人 邵晨宇 ｜ 2026-10-21 13:58/);
  assert.doesNotMatch(markdown, /任务完成：/);
});

test("marks a real assignment change as a reassignment", () => {
  const markdown = buildGroupActivityMarkdown({
    ...base,
    activity_type: "task.update",
    summary: "任务更新：支付回调",
    metadata: { taskId: 99, assignmentChanged: true },
    task_code: "SHOP-T-99",
    task_title: "支付回调",
    priority: "NORMAL",
    work_status: "TODO",
    task_assignees: "林雨研",
  });

  assert.match(markdown, /\*\*任务已改派\*\*/);
  assert.match(markdown, /「支付回调」/);
  assert.match(markdown, /状态 未完成/);
  assert.match(markdown, /负责人 林雨研/);
});

test("renders a module event as a clean subject and identifier", () => {
  const markdown = buildGroupActivityMarkdown(base);

  assert.match(markdown, /\*\*INPULSE · 模块\*\*/);
  assert.match(markdown, /\*\*新建模块\*\*/);
  assert.match(markdown, /「支付」/);
  assert.match(markdown, /编号 SHOP-M-3/);
  assert.doesNotMatch(markdown, /模块创建：/);
});

test("renders a historical feature event without a live feature lookup", () => {
  const markdown = buildGroupActivityMarkdown({
    ...base,
    activity_type: "feature.create",
    summary: "功能创建：退款",
  });

  assert.match(markdown, /\*\*INPULSE · 功能\*\*/);
  assert.match(markdown, /\*\*新建功能\*\*/);
  assert.match(markdown, /「退款」/);
  assert.doesNotMatch(markdown, /SHOP-F-8|所属模块/);
});

test("shows project status transitions without duplicating the project name", () => {
  const markdown = buildGroupActivityMarkdown({
    ...base,
    activity_type: "PROJECT_STATUS_CHANGED",
    summary: "项目状态：维护中 → 进行中（商城系统）",
    metadata: { beforeStatus: "MAINTENANCE", afterStatus: "ACTIVE" },
  });

  assert.match(markdown, /\*\*INPULSE · 项目\*\*/);
  assert.match(markdown, /\*\*项目重新开工\*\*/);
  assert.doesNotMatch(markdown, /（商城系统）/);
  assert.match(markdown, /状态 维护中 → 进行中/);
});

test("unknown activity types still render without null placeholders", () => {
  const markdown = buildGroupActivityMarkdown({
    ...base,
    activity_type: "future.event",
    summary: "未来事件：兼容",
    module_code: null,
    module_name: null,
  });

  assert.match(markdown, /\*\*INPULSE · 项目动态\*\*/);
  assert.match(markdown, /「兼容」/);
  assert.doesNotMatch(markdown, /undefined|null/);
  assert.match(markdown, /操作人 邵晨宇/);
});

test("builds the same text notice card structure as personal notifications", () => {
  const message = buildGroupActivityCard(
    {
      ...base,
      activity_type: "task.complete",
      summary: "任务完成：支付回调",
      metadata: { taskId: 99, moduleId: 12 },
      task_code: "SHOP-T-99",
      task_title: "支付回调",
      priority: "HIGH",
      work_status: "DONE",
      due_at: "2026-10-23T10:00:00.000Z",
      task_assignees: "邵晨宇、林雨研",
    },
    { cardActionUrl: "https://test-inpulse.libiaorobot.com/" },
  );

  assert.equal(message.msgtype, "template_card");
  assert.equal(message.template_card.card_type, "text_notice");
  assert.deepEqual(message.template_card.source, {
    desc: "InPulse",
    desc_color: 0,
  });
  assert.equal(message.template_card.main_title.title, "任务已完成：支付回调");
  assert.equal(message.template_card.main_title.desc, "编号 SHOP-T-99");
  assert.match(
    message.template_card.sub_title_text,
    /商城系统 · SHOP · 任务动态/,
  );
  assert.deepEqual(
    message.template_card.horizontal_content_list.map((row) => row.keyname),
    ["负责人", "进度", "截止", "模块", "操作人", "时间"],
  );
  assert.equal(
    message.template_card.card_action.url,
    "https://test-inpulse.libiaorobot.com/",
  );
});

test("renders a historical feature card with module context only", () => {
  const message = buildGroupActivityCard({
    ...base,
    activity_type: "feature.create",
    summary: "功能创建：退款",
  });

  assert.equal(message.template_card.main_title.title, "新建功能：退款");
  assert.equal(message.template_card.main_title.desc, "编号 SHOP");
  assert.deepEqual(message.template_card.horizontal_content_list[0], {
    keyname: "模块",
    value: "SHOP-M-3 · 支付",
  });
  assert.equal(message.template_card.card_action, undefined);
});

test("omits an unsafe card action url", () => {
  const message = buildGroupActivityCard(base, {
    cardActionUrl: "javascript:alert(1)",
  });
  assert.equal(message.template_card.card_action, undefined);
});

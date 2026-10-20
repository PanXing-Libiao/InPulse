import { expect, test } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { fillLeftovers } from "../helpers/record-leftovers.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  pickCalmSelectOption,
  pickFirstCalmSelectOption,
} from "../helpers/calm-select.js";
test("F18 独立发布、修订、明确解决遗留与不可变历史对比", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const title = `正式记录-${Date.now()}`;
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const draft = page.getByRole("dialog", { name: "新建迭代记录" });
    await pickFirstCalmSelectOption(draft, "所属模块");
    await draft.getByLabel("迭代标题").fill(title);
    await draft.getByLabel("改动原因").fill("版本一问题");
    await draft.getByLabel("具体改动").fill("版本一方案");
    await draft.getByLabel("改动效果").fill("版本一验证");
    await fillLeftovers(draft, ["需要后续跟进"]);
    await draft.getByRole("button", { name: "保存草稿" }).click();
    await expect(draft).toBeHidden();
    await page.getByRole("button", { name: "发布记录", exact: true }).click();
    const publish = page.getByRole("dialog", { name: "发布迭代记录" });
    await publish.getByRole("button", { name: "确认发布" }).click();
    await expect(publish).toBeHidden();
    const detail = page.getByRole("region", { name: "正式记录详情" });
    // 回归（2026-09-30 修）：草稿详情页发布后正式记录必须立刻进入时间线。该路径此前失效的
    // 是没有任何地方定义过的死键 ["published-records"]，列表不刷新，页面停在
    // 「暂无已发布记录」，只能靠 !items.some(publishedId) 的独立详情形态兜底。
    await expect(page.getByText("暂无已发布记录")).toBeHidden();
    // 记录进入列表后标题由卡片摘要行承载：.record-expanded-head 的 <h3> 只在独立详情形态
    // 渲染（同 docs/test-matrix.md「记录标题移出详情区」那条对 task-completion 的处理）。
    await expect(
      page
        .locator(".record-card")
        .filter({ hasText: title })
        .locator("summary"),
    ).toContainText(title);
    await detail.getByRole("button", { name: "修订内容" }).click();
    const edit = page.getByRole("dialog", { name: "修订迭代记录" });
    await edit.getByLabel("具体改动").fill("版本二方案");
    await edit.getByRole("button", { name: "保存新版本" }).click();
    await expect(edit).toBeHidden();
    await expect(
      detail
        .locator(":scope > section:not([aria-label])")
        .filter({
          has: page.getByRole("heading", { name: "具体改动", exact: true }),
        })
        .getByText("版本二方案", { exact: true }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "修订内容" }).click();
    await edit.getByRole("button", { name: /^移\s*除$/ }).click();
    await expect(
      edit.getByRole("button", { name: "保存新版本" }),
    ).toBeDisabled();
    await edit
      .getByRole("checkbox", { name: /确认移除的遗留问题已处理/ })
      .check();
    await edit.getByRole("button", { name: "保存新版本" }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    const card = page.locator(".record-card").filter({ hasText: title });
    await expect(card.locator("summary")).toContainText(/-CR-\d+ · v3 · 发布/);
    await expect(card.locator(".record-summary-badges")).toContainText(
      "已发布",
    );
    await expect(
      detail.getByText(
        "已删除或标记解决的遗留问题保留历史内容，不再计入未处理。",
      ),
    ).toBeVisible();
    await pickCalmSelectOption(detail, "较早版本", /^v1 · /);
    await pickCalmSelectOption(detail, "对照版本", /^v3 · /);
    const diff = detail.getByLabel("版本差异");
    await expect(diff.getByText("版本一方案")).toBeVisible();
    await expect(diff.getByText("版本二方案")).toBeVisible();
    await expect(diff.getByText("需要后续跟进")).toBeVisible();
    // 详情页快捷追加：不改写整段正文也形成一次记录版本（v4），列表出现新条目且历史保留。
    await detail.getByRole("button", { name: "追加遗留问题" }).click();
    await detail.getByLabel("追加遗留问题内容").fill("追加的遗留问题");
    await detail.getByRole("button", { name: "保存为新版本" }).click();
    await expect(
      detail.getByText("追加的遗留问题", { exact: true }),
    ).toBeVisible();
    await expect(card.locator("summary")).toContainText(/-CR-\d+ · v4 · 发布/);
    await page.screenshot({
      path: "test-results/f18-independent-versions.png",
      fullPage: true,
    });
    await page.goto(`/search?q=${encodeURIComponent(title)}`);
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});
test("F18 已完成 FEATURE 来源任务的记录发布和历史查看", async ({ browser }) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now();
    await page.goto(`/projects/${runtime.projectId}/modules`);
    await page.locator(".module-card").first().click();
    await page.getByRole("button", { name: "新增功能" }).click();
    const feature = page.getByRole("dialog", { name: "新增功能" });
    await feature.getByLabel("功能名称").fill(`发布功能-${suffix}`);
    await feature.getByRole("button", { name: /保\s*存/ }).click();
    await expect(feature).toBeHidden();
    await page
      .locator(".calm-feature-card")
      .filter({ hasText: `发布功能-${suffix}` })
      .click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    const taskForm = page.getByRole("dialog", { name: "新建任务" });
    await taskForm.getByLabel("任务标题").fill(`发布来源-${suffix}`);
    await pickCalmSelectOption(taskForm, "负责人", runtime.user.name);
    await taskForm.getByRole("button", { name: /创建任务/ }).click();
    await expect(taskForm).toBeHidden();
    const task = page.getByRole("dialog", { name: "任务详情" });
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const complete = page.getByRole("dialog", {
      name: "完成任务",
      exact: true,
    });
    await complete.getByRole("button", { name: /没有，仅完成任务/ }).click();
    await pickCalmSelectOption(complete, "完成原因", "测试验证");
    await complete.getByRole("button", { name: "确认完成任务" }).click();
    await expect(complete).toBeHidden();
    await task.getByRole("link", { name: "打开迭代记录" }).click();
    await page.getByRole("button", { name: "新建来源草稿" }).click();
    const draft = page.getByRole("dialog", { name: "新建任务迭代" });
    await draft.getByLabel("改动原因").fill("补充测试记录");
    await draft.getByLabel("具体改动").fill("整理测试用例");
    await draft.getByLabel("改动效果").fill("验证全部通过");
    await draft.getByRole("button", { name: "保存草稿" }).click();
    await expect(draft).toBeHidden();
    await page.getByRole("button", { name: "发布记录", exact: true }).click();
    await page
      .getByRole("dialog", { name: "发布迭代记录" })
      .getByRole("button", { name: "确认发布" })
      .click();
    const detail = page.getByRole("region", { name: "正式记录详情" });
    // 发布后记录立刻进入时间线卡片（与首个 F18 用例同一回归口径，标题落在摘要行）。
    await expect(
      page
        .locator(".record-card")
        .filter({ hasText: "发布来源-" + suffix })
        .locator("summary"),
    ).toContainText("发布来源-" + suffix);
    await detail.getByRole("link", { name: "查看来源任务" }).click();
    await expect(
      task.getByRole("button", { name: "重新打开", exact: true }),
    ).toBeEnabled();
    await expect(task.locator(".task-status-history > li")).toHaveCount(2);
    // C-1：详情弹窗与任务卡片显示已发布迭代记录条数（D-1 数量口径，
    // 多个版本不重复计数）；未合并任务不显示关系徽章。
    await expect(task.getByText("迭代记录 1 条")).toBeVisible();
    await task.getByRole("button", { name: "关闭" }).click();
    await pickCalmSelectOption(page, "任务状态筛选", "已完成");
    const card = page
      .locator(".calm-task-card")
      .filter({ hasText: `发布来源-${suffix}` });
    // 86dd2b2 起卡片计数文案简化为「记录 N 条」（详情弹窗仍为「迭代记录 N 条」）。
    await expect(card.getByText("记录 1 条")).toBeVisible();
    await expect(card.getByText("来源任务")).toHaveCount(0);
    await expect(card.getByText("主任务")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("F18 未完成任务的迭代记录可以直接发布且任务状态不变（ADR-047）", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now();
    await page.goto(`/projects/${runtime.projectId}/modules`);
    await page.locator(".module-card").first().click();
    await page.getByRole("button", { name: "新增功能" }).click();
    const feature = page.getByRole("dialog", { name: "新增功能" });
    await feature.getByLabel("功能名称").fill(`直发功能-${suffix}`);
    await feature.getByRole("button", { name: /保\s*存/ }).click();
    await expect(feature).toBeHidden();
    await page
      .locator(".calm-feature-card")
      .filter({ hasText: `直发功能-${suffix}` })
      .click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    const taskForm = page.getByRole("dialog", { name: "新建任务" }),
      taskTitle = `直发来源-${suffix}`;
    await taskForm.getByLabel("任务标题").fill(taskTitle);
    await pickCalmSelectOption(taskForm, "负责人", runtime.user.name);
    await taskForm.getByRole("button", { name: /创建任务/ }).click();
    await expect(taskForm).toBeHidden();
    const task = page.getByRole("dialog", { name: "任务详情" });
    await task.getByRole("tab", { name: "迭代记录" }).click();
    await task.getByRole("button", { name: "记录一次迭代" }).click();
    const modal = page.getByRole("dialog", { name: "新建任务迭代" });
    // 与迭代记录页同一套排版：归属按来源快照只读呈现，页脚直接给发布入口。
    await expect(modal.getByText("所属功能")).toBeVisible();
    await expect(modal.getByLabel("迭代标题")).toHaveValue(taskTitle);
    await modal.getByLabel("改动原因").fill("未完成任务也要记录本次迭代");
    await modal.getByLabel("具体改动").fill("发布与任务完成解耦");
    await modal.getByLabel("改动效果").fill("任务状态保持不变");
    await modal.getByRole("button", { name: "发布迭代记录" }).click();
    await expect(modal).toBeHidden();
    // 发布成功后不强制跳转：停在任务详情，但即刻给出一条直达正式记录的入口。
    await expect(task.getByText(/迭代记录已发布：/)).toBeVisible();
    await task.getByRole("button", { name: "查看正式记录" }).click();
    const record = page.getByRole("dialog", { name: taskTitle });
    await expect(record).toBeVisible();
    await expect(record.getByText("发布与任务完成解耦").first()).toBeVisible();
    await record.getByRole("button", { name: "关闭迭代记录详情" }).click();
    await expect(record).toBeHidden();
    // 记录落进本任务列表并计入条数；任务自身没有完成，状态历史仍只有创建一条。
    await expect(
      task.locator(".task-record-list li").filter({ hasText: taskTitle }),
    ).toContainText("已发布");
    await expect(task.getByRole("tab", { name: "迭代记录 1" })).toBeVisible();
    await expect(task.locator(".task-status-history > li")).toHaveCount(1);
    await expect(
      task.getByRole("button", { name: "完成任务", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: "test-results/f18-unfinished-source-publish.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

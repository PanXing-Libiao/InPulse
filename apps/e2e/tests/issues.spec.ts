import { expect, test } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { fillLeftovers } from "../helpers/record-leftovers.js";
import { loadRuntime } from "../helpers/runtime.js";
import { pickCalmSelectOption } from "../helpers/calm-select.js";

/**
 * F-20 遗留问题页（R-6）关键路径 E2E：发布带「遗留问题」的迭代记录后，
 * 未处理桶展示来源记录、来源迭代弹窗入口与转为任务入口；页内完成转换后按应用统一
 * 模式自动打开新建的跟进任务详情，回到遗留问题页可见该条移入已处理折叠区
 * 并保留跟进任务入口，原记录内容不被改写。
 */

test("F-20 遗留问题页未处理展示与页内转为任务", async ({ browser }) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now().toString(16).toUpperCase();
    const taskTitle = "遗留页来源任务-" + suffix;
    const followupTitle = "遗留页跟进-" + suffix;
    const leftover =
      "遗留页跟原文 " + suffix + "：充电策略参数配置项缺少默认值校验。";

    await page.goto("/projects/" + runtime.projectId + "/modules");
    await page.locator(".module-card").first().click();
    await page.getByRole("tab", { name: /模块级任务/ }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    const form = page.getByRole("dialog", { name: "新建任务" });
    await form.getByLabel("任务标题").fill(taskTitle);
    await pickCalmSelectOption(form, "负责人", runtime.user.name);
    await form.getByRole("button", { name: /创建任务/ }).click();
    await expect(form).toBeHidden();
    const task = page.getByRole("dialog", { name: "任务详情" });
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const completion = page.getByRole("dialog", {
      name: "完成任务",
      exact: true,
    });
    await completion.getByRole("button", { name: /有，填写迭代记录/ }).click();
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await completion.getByLabel(label).fill("F-20 E2E 内容 " + suffix);
    await fillLeftovers(completion, [leftover]);
    await completion
      .getByRole("button", { name: "发布并完成任务", exact: true })
      .click();
    await expect(completion).toBeHidden();

    await page.goto("/issues");
    await expect(page.getByTestId("issues-page")).toBeVisible();
    // 2026-10-10 用户指示：未闭环分档标题（含条数与排序说明）整条删除，
    // 列表直接挂在页面下，不再有标题行。
    await expect(page.getByText(/按发布时间倒序/)).toHaveCount(0);
    await expect(page.locator(".issues-page > .issue-list")).toBeVisible();

    // 2026-10-19 用户反馈「布局放中间点，右边留白太多了」：宽屏下 1020px 定宽
    // 列表必须在内容区内水平居中，左右留白差值不超过 1px；随后恢复默认视口继续交互。
    await page.setViewportSize({ width: 1680, height: 900 });
    const listSpacing = await page.evaluate(() => {
      const list = document.querySelector(".issues-page > .issue-list");
      const content = document.querySelector("main");
      if (!(list instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        throw new Error("遗留问题页缺少内容区或列表容器");
      }
      const contentRect = content.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return {
        contentWidth: contentRect.width,
        listWidth: listRect.width,
        left: listRect.left - contentRect.left,
        right: contentRect.right - listRect.right,
      };
    });
    expect(listSpacing.contentWidth).toBeGreaterThan(1020);
    expect(listSpacing.listWidth).toBeLessThanOrEqual(1020);
    expect(Math.abs(listSpacing.left - listSpacing.right)).toBeLessThanOrEqual(
      1,
    );
    await page.setViewportSize({ width: 1280, height: 720 });

    const row = page
      .getByTestId(/^leftover-item-/)
      .filter({ hasText: leftover });
    await expect(row).toBeVisible();
    await expect(row.getByText("未处理")).toBeVisible();
    await expect(row).toContainText(taskTitle);

    // 2026-10-10 用户指示：原「来源任务 <编号>」按钮改为「来源迭代」，点击就地打开这条
    // 来源记录的详情弹窗（与任务详情「查看来源记录」同一实现），不再跳转任务详情；
    // 来源任务仍可从记录详情里的「查看来源任务」进入。
    await row.getByRole("button", { name: "来源迭代", exact: true }).click();
    const record = page.getByRole("dialog", { name: taskTitle });
    await expect(record).toBeVisible();
    await expect(record.getByText(leftover).first()).toBeVisible();

    // 2026-10-10 用户指示：记录详情里的「查看来源任务」只在当前页面就地打开任务弹窗
    // （与任务中心同一宿主），不跳转到项目 / 模块 / 功能页；关掉任务弹窗后回到本条
    // 记录弹窗，地址栏始终停在 /issues。
    await record.getByRole("button", { name: "查看来源任务" }).click();
    const sourceTask = page.getByRole("dialog", { name: "任务详情" });
    await expect(sourceTask).toBeVisible();
    await expect(sourceTask.getByText(taskTitle)).toBeVisible();
    await expect(page).toHaveURL(/\/issues$/);
    await sourceTask.getByRole("button", { name: "关闭任务详情" }).click();
    await expect(sourceTask).toBeHidden();
    await expect(record).toBeVisible();
    await expect(page).toHaveURL(/\/issues$/);

    await record.getByRole("button", { name: "关闭迭代记录详情" }).click();
    await expect(record).toBeHidden();

    await page.goto("/issues");
    await page
      .getByTestId(/^leftover-item-/)
      .filter({ hasText: leftover })
      .getByRole("button", { name: "转为任务" })
      .click();
    const convert = page.getByRole("dialog", { name: "遗留问题转为新任务" });
    await expect(convert.getByText(leftover)).toBeVisible();
    await convert.getByLabel("标题").fill(followupTitle);
    await pickCalmSelectOption(convert, "负责人", runtime.user.name);
    await convert.getByRole("button", { name: "创建跟进任务" }).click();
    await expect(convert).toBeHidden();

    // 转换成功后与新建任务一致，自动打开新建的跟进任务详情。
    const detail = page.getByRole("dialog", { name: "任务详情" });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(followupTitle)).toBeVisible();

    // 回到遗留问题页：条目离开未处理桶，进入已处理或已作废折叠区并保留跟进任务入口。
    await page.goto("/issues");
    await expect(
      page
        .locator(".issues-page > .issue-list")
        .getByTestId(/^leftover-item-/)
        .filter({ hasText: leftover }),
    ).toHaveCount(0);

    const closed = page.locator("details.history-block");
    await expect(closed.locator("summary")).toContainText("已处理或已作废");

    // 已处理或已作废折叠区与列表使用同一条居中内容列：宽屏下左右留白同样对称。
    await page.setViewportSize({ width: 1680, height: 900 });
    const historySpacing = await page.evaluate(() => {
      const history = document.querySelector(".issues-page > .history-block");
      const content = document.querySelector("main");
      if (
        !(history instanceof HTMLElement) ||
        !(content instanceof HTMLElement)
      ) {
        throw new Error("遗留问题页缺少内容区或已处理折叠区");
      }
      const contentRect = content.getBoundingClientRect();
      const historyRect = history.getBoundingClientRect();
      return {
        left: historyRect.left - contentRect.left,
        right: contentRect.right - historyRect.right,
      };
    });
    expect(
      Math.abs(historySpacing.left - historySpacing.right),
    ).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 720 });

    await closed.locator("summary").click();
    const closedRow = closed
      .getByTestId(/^leftover-item-/)
      .filter({ hasText: leftover });
    await expect(closedRow).toBeVisible();
    await expect(closedRow.getByText("已处理")).toBeVisible();
    await closedRow.getByRole("button", { name: /查看跟进任务/ }).click();
    await expect(detail).toBeVisible();
    await expect(detail.getByText(followupTitle)).toBeVisible();
  } finally {
    await context.close();
  }
});

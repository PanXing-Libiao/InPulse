import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import { pickCalmSelectOption } from "../helpers/calm-select.js";

// R-8 项目任务看板关键路径（真实 UI，2026-09-18）：
// 完成程度概览 -> 看板内新建任务并自动刷新 -> 看板 / 列表视图切换 ->
// 状态 chip、时间 chip、优先级下拉与搜索筛选 -> 清空筛选 -> 打开任务详情。
test("R-8 任务看板展示完成程度并支持视图切换与筛选", async ({ browser }) => {
  test.setTimeout(180_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now();
    const title = "看板任务-" + suffix;
    const cardOf = (text: string) =>
      page.getByRole("button", { name: new RegExp("打开任务 .+ " + text) });

    await page.goto("/projects/" + runtime.projectId + "/task-board");
    await expect(page.getByRole("heading", { name: /任务看板/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /项目完成率/ })).toBeVisible();
    await expect(page.getByLabel("项目完成程度")).toBeVisible();
    await expect(page.locator(".tb-overview-head b")).toContainText(
      /已完成 \d+ \/ \d+/,
    );

    // 看板内新建任务：保存后任务看板查询失效并自动刷新出卡片。
    await page.getByRole("button", { name: "新建任务" }).click();
    const create = page.getByRole("dialog", { name: "新建任务" });
    await create.getByLabel("任务标题").fill(title);
    await pickCalmSelectOption(create, "所属模块", "未分类");
    // 该下拉的可见标签是「指派给」，无障碍名称沿用统一的「负责人」。
    await pickCalmSelectOption(create, "负责人", runtime.user.name);
    await create.getByRole("button", { name: "创建任务" }).click();
    await expect(create).toBeHidden();
    const detail = page.getByRole("dialog", { name: "任务详情" });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(title)).toBeVisible();
    await detail.getByRole("button", { name: "关闭" }).click();
    await expect(detail).toBeHidden();
    await expect(cardOf(title)).toBeVisible();

    // 视图切换：列表视图带固定表头，切回看板恢复泳道。
    const viewGroup = page.getByRole("group", { name: "视图切换" });
    await viewGroup.getByRole("button", { name: "列表" }).click();
    await expect(page).toHaveURL(/view=list/);
    await expect(page.locator(".tb-list-head")).toContainText("编号");
    await expect(cardOf(title)).toBeVisible();
    await viewGroup.getByRole("button", { name: "看板" }).click();
    await expect(page).not.toHaveURL(/view=list/);
    await expect(page.locator(".tb-lane-cards").first()).toBeVisible();

    // 状态 chip：未完成的看板任务在「已完成」筛选下被过滤。
    const statusGroup = page.getByRole("group", { name: "按状态筛选" });
    await statusGroup.getByRole("button", { name: /^已完成/ }).click();
    await expect(page).toHaveURL(/status=done/);
    await expect(cardOf(title)).toBeHidden();
    await statusGroup.getByRole("button", { name: /^全部/ }).click();
    await expect(page).not.toHaveURL(/status=done/);
    await expect(cardOf(title)).toBeVisible();

    // 时间 chip：新建任务没有截止时间，逾期筛选下应被过滤；再次点击取消。
    const timeGroup = page.getByRole("group", { name: "按时间筛选" });
    await timeGroup.getByRole("button", { name: /^逾期/ }).click();
    await expect(page).toHaveURL(/time=overdue/);
    await expect(cardOf(title)).toBeHidden();
    await timeGroup.getByRole("button", { name: /^逾期/ }).click();
    await expect(page).not.toHaveURL(/time=overdue/);
    await expect(cardOf(title)).toBeVisible();

    // 优先级下拉：普通优先级的任务在「紧急」下被过滤。
    await pickCalmSelectOption(page, "按优先级筛选", "紧急");
    await expect(page).toHaveURL(/priority=URGENT/);
    await expect(cardOf(title)).toBeHidden();
    await pickCalmSelectOption(page, "按优先级筛选", "全部优先级");
    await expect(cardOf(title)).toBeVisible();

    // 搜索：命中标题；无命中时给出空态，清除筛选后恢复。
    const search = page.getByLabel("搜索任务");
    await search.fill(title);
    // 标题含中文，URL 里是百分号编码，只断言 q 参数命中本次后缀。
    await expect(page).toHaveURL(new RegExp("q=[^&]*" + suffix));
    await expect(cardOf(title)).toBeVisible();
    await search.fill("看板无匹配-" + suffix);
    await expect(page.getByText("没有匹配筛选条件的任务")).toBeVisible();
    await page
      .locator(".tb-empty")
      .getByRole("button", { name: "清除筛选" })
      .click();
    await expect(search).toHaveValue("");
    await expect(cardOf(title)).toBeVisible();

    // 列表视图点击行就地打开任务详情。
    await viewGroup.getByRole("button", { name: "列表" }).click();
    await cardOf(title).click();
    await expect(detail).toBeVisible();
    await expect(detail.getByText(title)).toBeVisible();
  } finally {
    await context.close();
  }
});

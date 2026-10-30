import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  calmSelectTrigger,
  pickCalmSelectOption,
} from "../helpers/calm-select.js";
import { openFirstModuleTasks } from "../helpers/module-tasks.js";

/**
 * F-23 合并到主任务 / F-24 解除合并 / F-25 聚合组详情与任务中心聚合组卡片的关键
 * 路径 E2E。从模块任务详情发起合并（搜索主任务 → 选择 → 确认），合并在当前页面
 * 就地打开聚合组弹窗（`/task-groups/{id}` 独立页已改为弹层，地址不变），在弹窗里
 * 验证主任务与来源分支的展示与记录筛选；任务中心验证聚合组卡片（任务卡片同款混排、
 * 已合并任务不再单独出卡片），随后解除合并，验证组关闭、关系标记已解除但历史保留。
 * 用例依赖任务创建时同事务写入的搜索投影。
 */

test("F-23/F-24/F-25 合并到主任务、聚合组详情与解除合并", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now().toString(16).toUpperCase();
    const mainTaskTitle = "合并主任务-" + suffix;
    const sourceTaskTitle = "合并来源任务-" + suffix;

    await openFirstModuleTasks(page, runtime.projectId);

    const detail = page.getByRole("dialog", { name: "任务详情" });
    for (const title of [mainTaskTitle, sourceTaskTitle]) {
      await page.getByRole("button", { name: "新建任务", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建任务" });
      await dialog.getByLabel("任务标题").fill(title);
      await pickCalmSelectOption(dialog, "负责人", runtime.user.name);
      await dialog.getByRole("button", { name: /创建任务/ }).click();
      await expect(dialog).toBeHidden();
      // 任务保存后应用会自动打开该任务的详情弹窗（带遮罩），先关闭再继续，
      // 否则后续点击会被遮罩挡住直到用例超时。
      await expect(detail).toBeVisible();
      await detail.getByRole("button", { name: "关闭" }).click();
      await expect(detail).toBeHidden();
    }

    // F-23：从来源任务详情合并到同项目内的主任务。
    await page
      .locator(".calm-task-card")
      .filter({ hasText: sourceTaskTitle })
      .click();
    await expect(detail).toBeVisible();
    // 2026-10-09 改版（定稿方案 D）：合并入口从详情动作行搬进「编辑任务」页脚。
    await detail.getByRole("button", { name: "编辑任务" }).click();
    await page
      .getByRole("dialog", { name: "编辑任务" })
      .getByRole("button", { name: "合并到主任务" })
      .click();
    const mergeDialog = page.getByRole("dialog", { name: "合并到主任务" });
    // 主任务候选由服务端搜索提供（最小 2 字符），先敲标题再点候选。
    await pickCalmSelectOption(
      mergeDialog,
      "主任务",
      mainTaskTitle,
      mainTaskTitle,
    );
    await expect(calmSelectTrigger(mergeDialog, "主任务")).toContainText(
      mainTaskTitle,
    );
    await mergeDialog.getByRole("button", { name: "确认合并" }).click();

    // F-25：合并成功后在当前页面就地打开聚合组弹窗（地址不变），弹窗展示主任务
    // 与来源分支；记录为空时给出空态。
    const group = page.locator(".task-group-detail-modal");
    await expect(group).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain("/task-groups/");
    // 设计师稿 task-center.tsx 的聚合组区块没有「接口说明」黄条：服务端适配器下
    // 弹窗只呈现头部、成员分支与记录面板，开发期接口说明不进入用户界面。
    await expect(group.getByText(/接口说明/)).toHaveCount(0);
    const mainMember = group
      .locator(".task-group-member")
      .filter({ hasText: mainTaskTitle });
    await expect(mainMember).toContainText("主任务");
    const sourceMember = group
      .locator(".task-group-member")
      .filter({ hasText: sourceTaskTitle });
    await expect(sourceMember).toContainText("活动分支");
    await expect(group.getByText("暂无迭代记录")).toBeVisible();

    // 记录筛选是弹层局部状态（不再写入 URL），点击后筛选按钮保持选中。
    const mainFilter = group.getByRole("button", {
      name: "主任务",
      exact: true,
    });
    await mainFilter.click();
    await expect(mainFilter).toHaveAttribute("aria-pressed", "true");
    expect(new URL(page.url()).searchParams.get("task")).toBeNull();

    // F-24：解除合并需要二次确认，最后一个活跃来源分支会关闭聚合组。
    await sourceMember.getByRole("button", { name: "解除合并" }).click();
    const unmergeDialog = page.getByRole("dialog", { name: "解除合并" });
    await expect(unmergeDialog).toContainText("最后一个活跃分支");
    await unmergeDialog
      .getByLabel("解除原因（选填）")
      .fill("E2E：两个任务实际不重复");
    await unmergeDialog.getByRole("button", { name: "确认解除合并" }).click();
    await expect(page.getByTestId("task-group-unmerged-notice")).toBeVisible();
    await expect(
      group.locator(".task-group-member").filter({ hasText: sourceTaskTitle }),
    ).toContainText("已解除");
    await expect(group.getByText(/聚合组已关闭/)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F-25 任务中心聚合组卡片代表已合并任务，弹窗展示主分支与来源分支", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now().toString(16).toUpperCase();
    const mainTaskTitle = "面板主任务-" + suffix;
    const sourceTaskTitle = "面板来源任务-" + suffix;

    const moduleTasksPath = await openFirstModuleTasks(page, runtime.projectId);

    const detail = page.getByRole("dialog", { name: "任务详情" });
    for (const title of [mainTaskTitle, sourceTaskTitle]) {
      await page.getByRole("button", { name: "新建任务", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建任务" });
      await dialog.getByLabel("任务标题").fill(title);
      await pickCalmSelectOption(dialog, "负责人", runtime.user.name);
      await dialog.getByRole("button", { name: /创建任务/ }).click();
      await expect(dialog).toBeHidden();
      await expect(detail).toBeVisible();
      await detail.getByRole("button", { name: "关闭" }).click();
      await expect(detail).toBeHidden();
    }

    await page
      .locator(".calm-task-card")
      .filter({ hasText: sourceTaskTitle })
      .click();
    await expect(detail).toBeVisible();
    // 2026-10-09 改版（定稿方案 D）：合并入口从详情动作行搬进「编辑任务」页脚。
    await detail.getByRole("button", { name: "编辑任务" }).click();
    await page
      .getByRole("dialog", { name: "编辑任务" })
      .getByRole("button", { name: "合并到主任务" })
      .click();
    const mergeDialog = page.getByRole("dialog", { name: "合并到主任务" });
    await pickCalmSelectOption(
      mergeDialog,
      "主任务",
      mainTaskTitle,
      mainTaskTitle,
    );
    await mergeDialog.getByRole("button", { name: "确认合并" }).click();
    await expect(page.locator(".task-group-detail-modal")).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain("/task-groups/");

    // C-1：模块任务页卡片按 R-5 页面级批量显示关系徽章，来源任务详情
    // 的「查看主任务」直达当前聚合组。
    await page.goto(moduleTasksPath);
    const sourceCard = page
      .locator(".calm-task-card")
      .filter({ hasText: sourceTaskTitle });
    await expect(
      sourceCard.getByText("分支任务", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".calm-task-card")
        .filter({ hasText: mainTaskTitle })
        .getByText("主任务", { exact: true }),
    ).toBeVisible();
    await sourceCard.click();
    await expect(detail.getByText("分支任务", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "查看主任务" }).click();
    // 聚合组入口就地打开弹窗，不再离开当前模块任务页。
    await expect(page.locator(".task-group-detail-modal")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(moduleTasksPath);

    // 任务中心：聚合组以任务卡片同款外观与任务卡片同网格混排（2026-09-21 定案），
    // 不再有独立「任务聚合组」区块；分支明细与主任务入口都在组卡打开的弹窗里。
    // 口径切到「未完成」（today=0）：这两个已合并任务本身属于该口径，若未被隐藏就会
    // 以任务卡片出现，因此能证明它们只由聚合组卡片代表。
    const taskCenterLoaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/tasks",
    );
    await page.goto("/tasks?today=0");
    await taskCenterLoaded;
    const groupCard = page
      .locator(".calm-task-grid .task-group-card")
      .filter({ hasText: mainTaskTitle });
    await expect(groupCard).toBeVisible();
    // 2026-09-22 起组卡与任务卡同一套纵向排版（产品要求「组卡的布局要和 P2 一样」）：
    // 卡片上不再有编号行，编号只留在列表视图的标题下方与聚合组弹窗里。
    await expect(groupCard.locator(".task-id")).toHaveCount(0);
    await expect(groupCard.locator(".calm-card-top")).toHaveCount(0);
    // 底部那一排只留三枚徽章（2026-09-22 三次调整）：分支数改成「聚合组」徽章的 title，
    // 这一排才和任务卡片一样只占一行；列表视图仍逐字给出「编号 · 聚合组 · n 条分支」。
    await expect(groupCard.getByText("聚合组", { exact: true })).toBeVisible();
    await expect(
      groupCard.getByTitle("聚合组：包含 2 条分支（主分支与全部来源分支）"),
    ).toBeVisible();
    // 状态徽章按组内分支完成情况派生（2026-09-22 产品口径）：没有任何分支完成 → 未开始；
    // 任意分支完成 → 进行中；全部分支收尾 → 已完成，并归到工具栏「已完成」档。本例两条
    // 分支都未完成，因此是「未开始」，明细计数留在徽章的 title 里。
    await expect(groupCard.getByText("未开始", { exact: true })).toBeVisible();
    await expect(groupCard.locator(".task-group-card-top")).toHaveCount(0);
    await expect(groupCard.getByTitle("0 / 2 条分支任务已完成")).toBeVisible();
    await expect(groupCard).toContainText(runtime.projectName);
    // 组卡列出各分支负责人（本例两条分支同一人负责，按 userId 去重后只出现一次）。
    await expect(groupCard).toContainText(runtime.user.name);
    // 组优先级按未完成分支里的最高一档派生（2026-09-21 产品要求）：两条分支都以
    // 默认优先级「普通」创建且都未完成，组卡显示「普通」优先级徽章。整卡底色自
    // 2026-09-22 起跟随派生优先级（复用任务卡片的 .tone-prio-*），因此是普通蓝。
    await expect(groupCard.getByText("普通", { exact: true })).toBeVisible();
    await expect(groupCard).toHaveClass(/tone-prio-normal/);
    // 已合并任务不再单独出卡片：来源任务标题在组卡上不出现；主任务标题只由组卡
    // 承载（组名=主任务标题，所以这里必须排除组卡本身）。
    await expect(
      page.locator(".calm-task-card").filter({ hasText: sourceTaskTitle }),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".calm-task-card:not(.task-group-card)")
        .filter({ hasText: mainTaskTitle }),
    ).toHaveCount(0);

    // 点击组卡就地打开聚合组弹窗（地址不变），弹窗保留主分支与活动来源分支。
    await groupCard.click();
    const group = page.locator(".task-group-detail-modal");
    await expect(group).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain("/task-groups/");
    const mainMemberRow = group
      .locator(".task-group-member")
      .filter({ hasText: mainTaskTitle });
    await expect(mainMemberRow).toContainText("主任务");
    await expect(mainMemberRow).toContainText(runtime.user.name);
    const sourceMemberRow = group
      .locator(".task-group-member")
      .filter({ hasText: sourceTaskTitle });
    await expect(sourceMemberRow).toContainText("活动分支");

    // 弹窗成员标题按统一模式就地打开任务详情：来源任务与主任务都可直达。
    await sourceMemberRow.locator(".task-group-member-title").click();
    await expect(detail).toBeVisible();
    await expect(detail.getByText(sourceTaskTitle)).toBeVisible();
    await detail.getByRole("button", { name: "关闭" }).click();
    await expect(detail).toBeHidden();
    await mainMemberRow.locator(".task-group-member-title").click();
    await expect(detail).toBeVisible();
    await expect(detail.getByText(mainTaskTitle)).toBeVisible();
  } finally {
    await context.close();
  }
});

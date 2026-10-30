import { expect, test } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import { pickCalmSelectOption } from "../helpers/calm-select.js";
import {
  createTaskInOpenModule,
  openFirstModuleTasks,
} from "../helpers/module-tasks.js";

test("F-16 模块任务状态闭环与不可变历史", async ({ browser }) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await openFirstModuleTasks(page, runtime.projectId);
    const suffix = Date.now();
    const title = `状态任务-${suffix}`;
    const detail = await createTaskInOpenModule(page, runtime.user.name, title);
    await detail.getByRole("button", { name: "完成任务", exact: true }).click();
    const complete = page.getByRole("dialog", {
      name: "完成任务",
      exact: true,
    });
    await complete.getByRole("button", { name: /有，填写迭代记录/ }).click();
    await expect(
      complete.getByRole("button", { name: "发布并完成任务" }),
    ).toBeDisabled();
    await complete.getByRole("button", { name: /上一步/ }).click();
    await complete.getByRole("button", { name: /没有，仅完成任务/ }).click();
    await pickCalmSelectOption(complete, "完成原因", "测试验证");
    await complete.getByLabel("完成补充说明").fill("首次验证完成");
    await complete.getByRole("button", { name: "确认完成任务" }).click();
    await expect(complete).toBeHidden();
    await expect(
      detail.getByText("完成说明：测试验证，不关联迭代记录：首次验证完成"),
    ).toBeVisible();
    // ADR-058：「取消任务」「恢复任务」已整体下线（取消即软删除、没有恢复入口），
    // 状态闭环只剩「完成任务 ↔ 重新打开」；删除流程见本用例末尾。
    await detail.getByRole("button", { name: "重新打开", exact: true }).click();
    const reopen = page.getByRole("dialog", {
      name: "重新打开",
      exact: true,
    });
    await reopen.getByLabel("操作原因（选填）").fill("追加验证");
    await reopen.getByRole("button", { name: "确认重新打开" }).click();
    await expect(reopen).toBeHidden();
    await expect(
      detail.getByText("原因：追加验证", { exact: true }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "完成任务", exact: true }).click();
    await complete.getByRole("button", { name: /没有，仅完成任务/ }).click();
    await pickCalmSelectOption(complete, "完成原因", "技术调研");
    await complete.getByLabel("完成补充说明").fill("二次完成");
    await complete.getByRole("button", { name: "确认完成任务" }).click();
    await expect(complete).toBeHidden();
    // 4 条 = 创建 / 完成 / 重新打开 / 再完成（ADR-058 后不再有取消与恢复两步）。
    await expect(detail.locator(".task-status-history > li")).toHaveCount(4);
    await page.screenshot({
      path: `test-results/f16-module-task-history.png`,
      fullPage: true,
    });
    await page.reload();
    await pickCalmSelectOption(page, "任务状态筛选", "已完成");
    // 删除验证要回到同一个列表页；详情弹窗不写地址栏，这里取到的就是列表地址。
    const listUrl = page.url();
    await page.locator(".calm-task-card").filter({ hasText: title }).click();
    await expect(detail.locator(".task-status-history > li")).toHaveCount(4);
    await expect(
      detail.getByText("完成说明：技术调研，不关联迭代记录：二次完成"),
    ).toBeVisible();
    await page.goto(`/search?q=${encodeURIComponent(title)}`);
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    // ADR-058：任务级操作已由「取消任务」改为「删除任务」——编辑弹窗页脚最左、
    // 二次确认后软删除：任务退出列表与搜索且没有恢复入口。入口只对未完成任务
    // 开放，所以先重新打开再删。
    await page.goto(listUrl);
    await page.locator(".calm-task-card").filter({ hasText: title }).click();
    await detail.getByRole("button", { name: "重新打开", exact: true }).click();
    const reopenAgain = page.getByRole("dialog", {
      name: "重新打开",
      exact: true,
    });
    await reopenAgain.getByRole("button", { name: "确认重新打开" }).click();
    await expect(reopenAgain).toBeHidden();
    await detail.getByRole("button", { name: "编辑任务" }).click();
    await page
      .getByRole("dialog", { name: "编辑任务" })
      .getByRole("button", { name: "删除任务", exact: true })
      .click();
    const confirmDelete = page.getByRole("dialog", { name: "确认删除任务" });
    await confirmDelete.getByRole("button", { name: "确认删除" }).click();
    await expect(confirmDelete).toBeHidden();
    await expect(
      page.locator(".calm-task-card").filter({ hasText: title }),
    ).toHaveCount(0);
    await page.goto(`/search?q=${encodeURIComponent(title)}`);
    await expect(
      page.getByText("未找到匹配结果", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("search-result-item")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

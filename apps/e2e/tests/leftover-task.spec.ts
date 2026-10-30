import { expect, test, type Page } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { fillLeftovers, leftoverField } from "../helpers/record-leftovers.js";
import { loadRuntime } from "../helpers/runtime.js";
import { pickCalmSelectOption } from "../helpers/calm-select.js";
import {
  createTaskInOpenModule,
  openFirstModuleTasks,
} from "../helpers/module-tasks.js";
async function createTask(
  page: Page,
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
) {
  const title = `组合任务-${Date.now()}`;
  await openFirstModuleTasks(page, runtime.projectId);
  const task = await createTaskInOpenModule(page, runtime.user.name, title);
  const sourceUrl = new URL(
    (await task
      .getByRole("link", { name: "打开迭代记录" })
      .getAttribute("href"))!,
    page.url(),
  );
  const url = new URL(page.url());
  url.searchParams.set("taskId", sourceUrl.searchParams.get("taskId")!);
  return { title, task, url: url.toString() };
}

async function createRecord(
  page: Page,
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
) {
  const { task, title } = await createTask(page, runtime);
  await task.getByRole("button", { name: "完成任务", exact: true }).click();
  const form = page.getByRole("dialog", { name: "完成任务", exact: true });
  await form.getByRole("button", { name: /有，填写迭代记录/ }).click();
  for (const label of ["改动原因", "具体改动", "改动效果"])
    await form.getByLabel(label).fill("F20来源内容");
  await fillLeftovers(form, ["本次需要跟进的完整遗留原文"]);
  await form
    .getByRole("button", { name: "发布并完成任务", exact: true })
    .click();
  await expect(form).toBeHidden();
  await task.getByRole("link", { name: "查看已发布记录" }).click();
  const summary = page
    .locator("details.record-card")
    .filter({ hasText: title })
    .locator("summary");
  await expect(summary).toContainText(/-CR-\d+ · v1 · 发布/);
  await expect(summary.locator(".record-summary-badges")).toContainText(
    "已发布",
  );
  const record = page.getByRole("region", { name: "正式记录详情" });
  await expect(record).toBeVisible();
  return record;
}
test("F20 模块任务遗留转任务、来源双向链接和转换后稳定历史", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const record = await createRecord(page, runtime);
    await record.getByRole("button", { name: "转为新任务" }).click();
    const dialog = page.getByRole("dialog", { name: "遗留问题转为新任务" });
    await expect(dialog.getByText("本次需要跟进的完整遗留原文")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "创建跟进任务" }),
    ).toBeDisabled();
    const title = `遗留跟进-${Date.now()}`;
    await dialog.getByLabel("标题").fill(title);
    await pickCalmSelectOption(dialog, "负责人", runtime.user.name);
    await dialog.getByLabel("任务说明").fill("F20 用户补充说明");
    await dialog.getByLabel("截止时间").fill("2026-10-10T18:30");
    await dialog.getByRole("button", { name: "创建跟进任务" }).click();
    await expect(dialog).toBeHidden();
    const link = record.getByRole("link", {
      name: "查看跟进任务",
      exact: true,
    });
    await expect(link).toBeVisible();
    const target = await link.getAttribute("href");
    await link.click();
    const task = page.getByRole("dialog", { name: "任务详情" });
    await expect(
      task.getByRole("button", { name: "完成任务", exact: true }),
    ).toBeEnabled();
    await expect(task.locator(".task-status-history > li")).toHaveCount(1);
    await expect(task.getByText(/来源记录：.*-CR-/)).toBeVisible();
    await expect(task.getByText("F20 用户补充说明")).toBeVisible();
    {
      await task.getByRole("button", { name: "编辑任务", exact: true }).click();
      const editTask = page.getByRole("dialog", {
        name: "编辑任务",
        exact: true,
      });
      await expect(editTask.getByLabel("截止时间")).toHaveValue(
        "2026-10-10T18:30",
      );
      // 2026-10-09 改版：编辑任务弹窗页脚新增任务级操作（现为 ADR-058 的「删除任务 / 合并到主任务」），
      // 原来的 /取\s*消/ 会同时命中这两枚按钮，这里收紧成整名匹配表单的「取 消」。
      await editTask.getByRole("button", { name: /^取\s*消$/ }).click();
      await expect(editTask).toBeHidden();
      // Opening the editor closes the detail drawer; return through the real task URL.
      await page.goto(target!);
    }
    // 2026-09-28 产品反馈：入口由整页跳转到记录工作区改为就地打开记录详情弹窗。
    const taskUrl = page.url();
    await task.getByRole("button", { name: "查看遗留来源记录" }).click();
    await expect(
      page.getByRole("button", { name: "关闭迭代记录详情" }),
    ).toBeVisible();
    expect(page.url()).toBe(taskUrl);
    await expect(
      record.getByRole("link", { name: "查看跟进任务", exact: true }),
    ).toHaveAttribute("href", target!);
    await expect(
      record.getByRole("button", { name: "转为新任务" }),
    ).toHaveCount(0);
    {
      for (const value of ["转换后的再次填写", "再次改写同一问题"]) {
        await record.getByRole("button", { name: "修订内容" }).click();
        const edit = page.getByRole("dialog", { name: "修订迭代记录" });
        // 已转任务的条目在新 UI 下锁定：只保留关联与文字，不提供移除按钮
        await expect(edit.getByText("已转任务，保留关联")).toBeVisible();
        await leftoverField(edit, 1).fill(value);
        await edit.getByRole("button", { name: "保存新版本" }).click();
        await expect(edit).toBeHidden();
        await expect(
          record.getByRole("link", { name: "查看跟进任务", exact: true }),
        ).toHaveAttribute("href", target!);
        await expect(
          record.getByRole("button", { name: "转为新任务" }),
        ).toHaveCount(0);
      }
      await pickCalmSelectOption(record, "较早版本", /^v1 · /);
      await pickCalmSelectOption(record, "对照版本", /^v3 · /);
      await expect(
        record.getByLabel("版本差异").getByText("本次需要跟进的完整遗留原文"),
      ).toBeVisible();
    }
  } finally {
    await context.close();
  }
});
test("F20 其他页面修订造成409，保留任务输入并明确确认最新内容后转换", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const record = await createRecord(page, runtime),
      url = page.url();
    await record.getByRole("button", { name: "转为新任务" }).click();
    const dialog = page.getByRole("dialog", { name: "遗留问题转为新任务" });
    await expect(dialog.getByText("本次需要跟进的完整遗留原文")).toBeVisible();
    await dialog.getByLabel("标题").fill("冲突后保留的任务标题");
    await pickCalmSelectOption(dialog, "负责人", runtime.user.name);
    const other = await context.newPage();
    await other.goto(url);
    await other.getByRole("button", { name: "修订内容" }).click();
    const edit = other.getByRole("dialog", { name: "修订迭代记录" });
    await leftoverField(edit, 1).fill("并发修订后的最新遗留");
    await edit.getByRole("button", { name: "保存新版本" }).click();
    await expect(edit).toBeHidden();
    await other.close();
    await dialog.getByRole("button", { name: "创建跟进任务" }).click();
    await expect(
      dialog.getByRole("button", { name: "刷新转换预览" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("标题")).toHaveValue("冲突后保留的任务标题");
    await dialog.getByRole("button", { name: "刷新转换预览" }).click();
    await expect(dialog.getByText("并发修订后的最新遗留")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "创建跟进任务" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "确认使用最新预览" }).click();
    await dialog.getByRole("button", { name: "创建跟进任务" }).click();
    await expect(dialog).toBeHidden();
    await record
      .getByRole("link", { name: "查看跟进任务", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "任务详情" })
        .getByText(/并发修订后的最新遗留/),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

import { expect, test, type Page } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  pickCalmSelectOption,
  pickCalmSelectOptions,
} from "../helpers/calm-select.js";

/**
 * 标题行内的标题、任务数徽章与右侧控件必须共用同一条垂直中线。
 * 功能档案页把任务面板嵌在 `.feature-reading` 里，该容器的 `h3` 规则曾给面板标题
 * 补上 12px 下边距，在垂直居中的标题行里把标题顶高了 6px。
 */
async function expectTaskPanelHeadingAligned(page: Page): Promise<void> {
  const row = page
    .locator(".calm-section-title", {
      has: page.locator(".task-panel-heading"),
    })
    .first();
  await expect(row).toBeVisible();
  const centers = await row.evaluate((element) => {
    const selectors = [
      ".task-panel-heading h3",
      ".task-panel-heading .badge",
      ".task-status-filter",
      ".segmented",
      ".primary-button",
    ];
    return selectors
      .map((selector) => element.querySelector(selector))
      .filter((target): target is Element => target !== null)
      .map((target) => {
        const rect = target.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
  });
  expect(centers).toHaveLength(5);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
}

test("F-15 单份模块任务影响两功能，引用计数与增删关系持久化", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/projects/${runtime.projectId}/modules`);
    const suffix = Date.now();
    const moduleName = `模块任务隔离-${suffix}`;
    await page.getByRole("button", { name: "新增模块" }).first().click();
    const moduleDialog = page.getByRole("dialog", { name: "新增模块" });
    await moduleDialog.getByLabel("模块名称").fill(moduleName);
    await moduleDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(moduleDialog).toBeHidden();
    // 「查看功能」在 `.calm-feature-card` 内，而「模块任务」在它的兄弟
    // `span.catalog-edit-link` 内，两者共同的父级是 `article.catalog-module-wrap`。
    const moduleEntry = page
      .locator("article.catalog-module-wrap")
      .filter({ hasText: moduleName });
    await moduleEntry.locator(".module-card").click();
    const listUrl = page.url();
    const moduleId = listUrl.match(/modules\/(\d+)/)![1];
    const names = [`影响甲-${suffix}`, `影响乙-${suffix}`];
    const featureUrls: string[] = [];
    for (const name of names) {
      await page.goto(listUrl);
      await page.getByRole("button", { name: "新增功能" }).click();
      const dialog = page.getByRole("dialog", { name: "新增功能" });
      await dialog.getByLabel("功能名称").fill(name);
      await dialog.getByRole("button", { name: /保\s*存/ }).click();
      await expect(dialog).toBeHidden();
      await page
        .locator(".calm-feature-card")
        .filter({ hasText: name })
        .click();
      featureUrls.push(page.url());
    }
    await page.goto(`/projects/${runtime.projectId}/modules`);
    await moduleEntry.locator(".module-card").click();
    await page.getByRole("tab", { name: /模块级任务/ }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建任务" });
    const title = `公共任务-${suffix}`;
    await create.getByLabel("任务标题").fill(title);
    await pickCalmSelectOption(create, "负责人", runtime.user.name);
    await pickCalmSelectOptions(create, "影响功能", [names[0]!, names[1]!]);
    await create.getByRole("button", { name: /创建任务/ }).click();
    await expect(create).toBeHidden();
    await expect(
      page.getByRole("dialog", { name: "任务详情" }).getByText(/影响功能：/),
    ).toContainText(names[0]!);
    for (const url of featureUrls) {
      await page.goto(url);
      // 86dd2b2 起模块级任务在卡片上用「模块级」徽标标识，不再渲染「模块级任务 · 引用」文案。
      const moduleCard = page
        .getByRole("article")
        .filter({ has: page.getByText(title, { exact: true }) });
      await expect(
        moduleCard.getByText("模块级", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("1 个任务")).toBeVisible();
      await moduleCard.click();
      // 单份引用：功能页只展示模块级任务的引用，状态流转仍按 taskWritable=false
      // 关闭（ADR-054 已下线任务的归档 / 恢复入口）。
      const referenced = page.getByRole("dialog", { name: "任务详情" });
      await expect(
        referenced.getByRole("button", { name: "完成任务" }),
      ).toBeDisabled();
      // 2026-09-24 产品要求删除正文里的「打开模块任务」跳转：它与任务中心详情
      // 动作行的「在项目中打开」以及功能页头部的「模块级任务」标签是同一去向。
      await expect(
        referenced.getByRole("link", { name: "打开模块任务" }),
      ).toHaveCount(0);
    }
    await page.goto(`/projects/${runtime.projectId}/modules/${moduleId}/tasks`);
    await page
      .locator(".calm-task-card")
      .filter({ has: page.getByText(title, { exact: true }) })
      .click();
    await page.getByRole("button", { name: "编辑任务" }).click();
    const edit = page.getByRole("dialog", { name: "编辑任务" });
    // 影响功能已是多选下拉（2026-09-28）：再点一次同一项即取消选中。
    await pickCalmSelectOptions(edit, "影响功能", [names[0]!]);
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    await page.goto(featureUrls[0]!);
    await expect(page.getByText("暂无任务", { exact: true })).toBeVisible();
    await page.goto(featureUrls[1]!);
    await expect(page.getByText("1 个任务")).toBeVisible();
    await expectTaskPanelHeadingAligned(page);
    await page.goto(`/projects/${runtime.projectId}/modules/${moduleId}/tasks`);
    await page
      .locator(".calm-task-card")
      .filter({ has: page.getByText(title, { exact: true }) })
      .click();
    await page.getByRole("button", { name: "编辑任务" }).click();
    await pickCalmSelectOptions(edit, "影响功能", [names[0]!]);
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    await expect(page.locator(".module-work-tabs")).toContainText(
      "模块级任务 1",
    );
    await page.goto(featureUrls[0]!);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText("1 个任务")).toBeVisible();
    await page.goto("/notifications");
    await page.getByText(`任务指派：${title}`, { exact: true }).click();
    const notificationDetail = page.getByRole("dialog", { name: "任务详情" });
    await expect(notificationDetail).toBeVisible();
    await expect(page).toHaveURL(/\/notifications$/);
    await notificationDetail
      .getByRole("button", { name: "在项目中打开" })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/modules/${moduleId}/tasks\\?taskId=`),
    );
    await expect(page.getByRole("dialog", { name: "任务详情" })).toBeVisible();
  } finally {
    await context.close();
  }
});

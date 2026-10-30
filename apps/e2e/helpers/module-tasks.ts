import { expect, type Locator, type Page } from "@playwright/test";

import { pickCalmSelectOption } from "./calm-select.js";

/** ADR-109：模块直接进入任务页；测试不再经过已删除的功能层。 */
export async function createModuleViaUi(
  page: Page,
  projectId: number,
  name: string,
  description = "Playwright 模块任务夹具",
): Promise<Locator> {
  await page.goto("/projects/" + String(projectId) + "/modules");
  await page.getByRole("button", { name: "新增模块" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新增模块" });
  await dialog.getByLabel("模块名称").fill(name);
  await dialog.getByLabel("模块说明").fill(description);
  await dialog.getByRole("button", { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  const card = page
    .locator("article.catalog-module-wrap")
    .filter({ hasText: name });
  await expect(card).toBeVisible();
  return card;
}

export async function openModuleTasks(
  page: Page,
  moduleCard: Locator,
): Promise<string> {
  await moduleCard.locator(".module-card").click();
  await expect(page).toHaveURL(/\/modules\/\d+\/tasks$/);
  return new URL(page.url()).pathname;
}

export async function openFirstModuleTasks(
  page: Page,
  projectId: number,
): Promise<string> {
  await page.goto("/projects/" + String(projectId) + "/modules");
  await page.locator(".module-card").first().click();
  await expect(page).toHaveURL(/\/modules\/\d+\/tasks$/);
  return new URL(page.url()).pathname;
}

export async function createTaskInOpenModule(
  page: Page,
  assigneeName: string,
  title: string,
  options: { description?: string; priority?: string; dueAt?: string } = {},
): Promise<Locator> {
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建任务" });
  await expect(form.getByLabel("所属模块")).toHaveCount(0);
  await expect(form.getByText("任务范围", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("影响功能")).toHaveCount(0);
  await form.getByLabel("任务标题").fill(title);
  if (options.description !== undefined) {
    await form.getByLabel("任务说明").fill(options.description);
  }
  await pickCalmSelectOption(form, "负责人", assigneeName);
  if (options.priority !== undefined) {
    await pickCalmSelectOption(form, "优先级", options.priority);
  }
  if (options.dueAt !== undefined) {
    await form.getByLabel("截止时间").fill(options.dueAt);
  }
  await form.getByRole("button", { name: /创建任务/ }).click();
  await expect(form).toBeHidden();
  const detail = page.getByRole("dialog", { name: "任务详情" });
  await expect(detail).toBeVisible();
  return detail;
}

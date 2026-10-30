import { expect, test } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import {
  createModuleViaUi,
  createTaskInOpenModule,
  openModuleTasks,
} from "../helpers/module-tasks.js";
import { loadRuntime } from "../helpers/runtime.js";

test("F-15 模块直接创建、编辑并持久化直属任务", async ({ browser }) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const suffix = Date.now();
  try {
    const moduleName = "模块直属任务-" + String(suffix);
    const moduleCard = await createModuleViaUi(
      page,
      runtime.projectId,
      moduleName,
    );
    const moduleTasksPath = await openModuleTasks(page, moduleCard);

    const originalTitle = "直属任务-" + String(suffix);
    const detail = await createTaskInOpenModule(
      page,
      runtime.user.name,
      originalTitle,
      { description: "模块直属任务说明" },
    );
    await expect(
      detail.getByText("模块直属任务说明", { exact: true }),
    ).toBeVisible();
    await expect(detail.getByText("影响功能", { exact: true })).toHaveCount(0);

    await detail.getByRole("button", { name: "编辑任务" }).click();
    const edit = page.getByRole("dialog", { name: "编辑任务" });
    const updatedTitle = "直属任务已更新-" + String(suffix);
    await edit.getByLabel("任务标题").fill(updatedTitle);
    await edit.getByLabel("任务说明").fill("更新后的模块直属任务说明");
    await expect(edit.getByText("任务范围", { exact: true })).toHaveCount(0);
    await expect(edit.getByLabel("影响功能")).toHaveCount(0);
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();

    await page.goto(moduleTasksPath);
    const taskCard = page
      .locator(".calm-task-card")
      .filter({ has: page.getByText(updatedTitle, { exact: true }) });
    await expect(taskCard).toBeVisible();
    await taskCard.click();
    const reopened = page.getByRole("dialog", { name: "任务详情" });
    await expect(
      reopened.getByText("更新后的模块直属任务说明", { exact: true }),
    ).toBeVisible();

    await page.goto("/search?q=" + encodeURIComponent(updatedTitle));
    await expect(
      page.getByText(updatedTitle, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator(".module-work-tabs")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

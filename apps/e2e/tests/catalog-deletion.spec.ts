import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import { fillLeftovers } from "../helpers/record-leftovers.js";
import {
  createModuleViaUi,
  createTaskInOpenModule,
  openModuleTasks,
} from "../helpers/module-tasks.js";

test("ADR-109 删除模块：确认后级联移除任务、记录与搜索投影", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const suffix = Date.now();
  try {
    const moduleName = "待删除模块-" + suffix;
    const taskTitle = "模块级联任务-" + suffix;
    const moduleCard = await createModuleViaUi(
      page,
      runtime.projectId,
      moduleName,
    );
    await openModuleTasks(page, moduleCard);
    const task = await createTaskInOpenModule(
      page,
      runtime.user.name,
      taskTitle,
    );
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const complete = page.getByRole("dialog", {
      name: "完成任务",
      exact: true,
    });
    await complete.getByRole("button", { name: /有，填写迭代记录/ }).click();
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await complete.getByLabel(label).fill("验证模块级联删除");
    await fillLeftovers(complete, ["删除后应一并消失"]);
    await complete
      .getByRole("button", { name: "发布并完成任务", exact: true })
      .click();
    await expect(complete).toBeHidden();

    await page.goto("/search?q=" + encodeURIComponent(taskTitle));
    await expect(page.getByTestId("search-result-item").first()).toBeVisible();

    await page.goto("/projects/" + runtime.projectId + "/modules");
    await moduleCard.getByRole("button", { name: "编辑模块" }).click();
    const edit = page.getByRole("dialog", { name: "编辑模块" });
    await edit.getByRole("button", { name: "删除模块" }).click();
    const confirm = page.getByRole("dialog", { name: "确认删除模块" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(moduleName);
    await expect(confirm).toContainText("该模块下有 0 项未完成任务");
    await expect(confirm).toContainText("1 项已完成任务");
    await expect(confirm).toContainText("仅保留审计日志与项目动态");

    await page.getByTestId("confirm-delete-module").click();
    await expect(confirm).toBeHidden();
    await expect(moduleCard).toHaveCount(0);
    await page.reload();
    await expect(moduleCard).toHaveCount(0);

    await page.goto("/search?q=" + encodeURIComponent(taskTitle));
    await expect(page.getByTestId("search-result-item")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

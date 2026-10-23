import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";

test("ADR-096 删除功能：取消保留、确认后物理移除且所属模块仍在", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const suffix = Date.now();
  try {
    const moduleName = "删除功能模块-" + suffix;
    const featureName = "待删除功能-" + suffix;
    await page.goto("/projects/" + runtime.projectId + "/modules");
    await page.getByRole("button", { name: "新增模块" }).first().click();
    const moduleDialog = page.getByRole("dialog", { name: "新增模块" });
    await moduleDialog.getByLabel("模块名称").fill(moduleName);
    await moduleDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(moduleDialog).toBeHidden();

    const moduleCard = page
      .locator("article.catalog-module-wrap")
      .filter({ hasText: moduleName });
    await moduleCard.locator(".module-card").click();
    await expect(page).toHaveURL(/\/modules\/\d+\/features$/);

    await page.getByRole("button", { name: "新增功能" }).click();
    const featureDialog = page.getByRole("dialog", { name: "新增功能" });
    await featureDialog.getByLabel("功能名称").fill(featureName);
    await featureDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(featureDialog).toBeHidden();
    await page
      .locator(".calm-feature-card")
      .filter({ hasText: featureName })
      .click();
    await expect(
      page.getByRole("heading", { name: featureName }),
    ).toBeVisible();

    await page.getByRole("button", { name: "编辑功能" }).click();
    const edit = page.getByRole("dialog", { name: "编辑功能" });
    await edit.getByRole("button", { name: "删除功能" }).click();
    const confirm = page.getByRole("dialog", { name: "确认删除功能" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(featureName);
    await expect(confirm).toContainText("所属模块与其他功能保留");
    await expect(confirm).toContainText("该功能下没有未完成或已完成的任务");
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(confirm).toBeHidden();
    await expect(
      page.getByRole("heading", { name: featureName }),
    ).toBeVisible();

    await edit.getByRole("button", { name: "删除功能" }).click();
    await expect(confirm).toBeVisible();
    await page.getByTestId("confirm-delete-feature").click();
    await expect(confirm).toBeHidden();
    await expect(page).toHaveURL(/\/modules\/\d+\/features$/);
    await expect(
      page.locator(".calm-feature-card").filter({ hasText: featureName }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.locator(".calm-feature-card").filter({ hasText: featureName }),
    ).toHaveCount(0);

    await page.goto("/projects/" + runtime.projectId + "/modules");
    await expect(page.getByRole("heading", { name: moduleName })).toBeVisible();

    await page.goto("/search?q=" + encodeURIComponent(featureName));
    await expect(page.getByTestId("search-result-item")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("ADR-096 删除模块：确认后级联移除下级功能并清掉搜索投影", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const suffix = Date.now();
  try {
    const moduleName = "待删除模块-" + suffix;
    const featureName = "模块下级功能-" + suffix;
    await page.goto("/projects/" + runtime.projectId + "/modules");
    await page.getByRole("button", { name: "新增模块" }).first().click();
    const moduleDialog = page.getByRole("dialog", { name: "新增模块" });
    await moduleDialog.getByLabel("模块名称").fill(moduleName);
    await moduleDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(moduleDialog).toBeHidden();

    const moduleCard = page
      .locator("article.catalog-module-wrap")
      .filter({ hasText: moduleName });
    await moduleCard.locator(".module-card").click();
    await expect(page).toHaveURL(/\/modules\/\d+\/features$/);
    await page.getByRole("button", { name: "新增功能" }).click();
    const featureDialog = page.getByRole("dialog", { name: "新增功能" });
    await featureDialog.getByLabel("功能名称").fill(featureName);
    await featureDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(featureDialog).toBeHidden();

    await page.goto("/projects/" + runtime.projectId + "/modules");
    await moduleCard.getByRole("button", { name: "编辑模块" }).click();
    const edit = page.getByRole("dialog", { name: "编辑模块" });
    await edit.getByRole("button", { name: "删除模块" }).click();
    const confirm = page.getByRole("dialog", { name: "确认删除模块" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(moduleName);
    await expect(confirm).toContainText("该模块下有 1 个功能");
    await expect(confirm).toContainText("仅保留审计日志与项目动态");

    await page.getByTestId("confirm-delete-module").click();
    await expect(confirm).toBeHidden();
    await expect(moduleCard).toHaveCount(0);
    await page.reload();
    await expect(moduleCard).toHaveCount(0);

    await page.goto("/search?q=" + encodeURIComponent(featureName));
    await expect(page.getByTestId("search-result-item")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

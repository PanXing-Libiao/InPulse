import { expect } from "@playwright/test";
import { test } from "../helpers/admin-fixture.js";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";

test("功能档案：模块入口、创建详情、双页面三方合并、刷新持久化", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/projects/${runtime.projectId}/modules`);
    const firstModule = page.locator(".calm-feature-card").first();
    const firstModuleName = (
      await firstModule.getByRole("heading").first().innerText()
    ).trim();
    await firstModule.click();
    await expect(
      page.getByRole("heading", { name: firstModuleName }),
    ).toBeVisible();
    expect(page.url()).toMatch(/\/modules\/\d+\/features$/);
    const listUrl = page.url();
    const name = `退款功能-${Date.now()}`;
    await page.getByRole("button", { name: "新增功能" }).click();
    const create = page.getByRole("dialog", { name: "新增功能" });
    await create.getByLabel("功能名称").fill(name);
    await create.getByLabel("当前功能说明").fill("创建时的说明");
    await create.getByRole("button", { name: "新标签" }).click();
    const tagEntry = create.getByLabel("标签（最多 50 个）");
    await tagEntry.fill("支付");
    await tagEntry.press("Enter");
    await tagEntry.fill("退款");
    await tagEntry.press("Enter");
    await expect(create.getByText("支付", { exact: true })).toBeVisible();
    await create.getByRole("button", { name: /保\s*存/ }).click();
    await expect(create).toBeHidden();
    await page.locator(".calm-feature-card").filter({ hasText: name }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    // 0f34d7a 起功能说明只在标题下方渲染，正文不再重复一遍。
    await expect(
      page
        .locator(".feature-modal-header")
        .getByText("创建时的说明", { exact: true }),
    ).toBeVisible();
    // ADR-045：功能只有 ACTIVE，编辑弹层底部不再有归档入口。
    await page.getByRole("button", { name: "编辑功能" }).click();
    const edit = page.getByRole("dialog", { name: "编辑功能" });
    await expect(edit.getByTestId("feature-modal-lifecycle")).toHaveCount(0);
    await expect(edit.getByLabel("操作原因")).toHaveCount(0);
    // 编辑弹窗里标签以胶囊预填（2026-10-12 起不再是逐行文本框）。
    await expect(edit.getByText("支付", { exact: true })).toBeVisible();
    await expect(edit.getByText("退款", { exact: true })).toBeVisible();
    await edit.getByLabel("功能名称").fill(`${name}-更新`);
    const other = await context.newPage();
    await other.goto(page.url());
    await other.getByRole("button", { name: "编辑功能" }).click();
    const otherEdit = other.getByRole("dialog", { name: "编辑功能" });
    await otherEdit.getByLabel("当前功能说明").fill("其他页面的新说明");
    await otherEdit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(otherEdit).toBeHidden();
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit.getByText(/输入已保留/)).toBeVisible();
    await edit.getByRole("button", { name: "加载最新版本后继续编辑" }).click();
    await expect(edit.getByLabel("当前功能说明")).toHaveValue(
      "其他页面的新说明",
    );
    await expect(edit.getByLabel("功能名称")).toHaveValue(`${name}-更新`);
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    await page.getByRole("button", { name: "编辑功能" }).click();
    await edit.getByLabel("当前功能说明").fill("我的说明草稿");
    await other.reload();
    await other.getByRole("button", { name: "编辑功能" }).click();
    await otherEdit.getByLabel("当前功能说明").fill("其他页面再次修改");
    await otherEdit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(otherEdit).toBeHidden();
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit.getByText(/输入已保留/)).toBeVisible();
    await edit.getByRole("button", { name: "加载最新版本后继续编辑" }).click();
    await expect(edit.getByText("当前功能说明存在冲突")).toBeVisible();
    await expect(edit.getByRole("button", { name: /保\s*存/ })).toBeDisabled();
    await edit.getByRole("button", { name: "采用最新当前功能说明" }).click();
    await edit.getByRole("button", { name: "应用合并结果" }).click();
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    await expect(
      page
        .locator(".feature-modal-header")
        .getByText("其他页面再次修改", { exact: true }),
    ).toBeVisible();
    await page.goto(listUrl);
    await expect(
      page
        .locator(".calm-feature-card")
        .filter({ hasText: name + "-更新" })
        .getByRole("heading", { name: name + "-更新", exact: true }),
    ).toBeVisible();
    await other.close();
  } finally {
    await context.close();
  }
});

test("功能页不再有归档与恢复入口，功能始终可编辑（ADR-045）", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/projects/${runtime.projectId}/modules`);
    await page.locator(".module-card").first().click();
    await page.getByRole("button", { name: "新增功能" }).click();
    const create = page.getByRole("dialog", { name: "新增功能" });
    const name = `无归档功能-${Date.now()}`;
    await create.getByLabel("功能名称").fill(name);
    await create.getByRole("button", { name: /保\s*存/ }).click();
    await expect(create).toBeHidden();
    await page.locator(".calm-feature-card").filter({ hasText: name }).click();
    const detail = page.getByRole("main");
    // ADR-045：功能只有 ACTIVE，卡片、页头与弹层都没有归档 / 恢复入口。
    // getByRole 的 name 默认按子串匹配，本用例新建的功能名「无归档功能-…」也在卡片
    // 按钮的无障碍名称里，必须用 exact 才能只命中真正的动作按钮。
    await expect(
      page.getByRole("button", { name: "归档功能", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "恢复功能", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator(".feature-facts").getByText("已归档", { exact: true }),
    ).toHaveCount(0);
    await detail.getByRole("button", { name: "编辑功能" }).click();
    const edit = page.getByRole("dialog", { name: "编辑功能" });
    await expect(edit.getByTestId("feature-modal-lifecycle")).toHaveCount(0);
    await expect(edit.getByLabel("操作原因")).toHaveCount(0);
    await expect(edit.getByRole("button", { name: /保\s*存/ })).toBeVisible();
    await edit.getByLabel("功能名称").fill(`${name}-已修改`);
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: `${name}-已修改` }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

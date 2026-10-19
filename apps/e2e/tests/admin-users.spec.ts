import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";
import postgres from "postgres";
import { test } from "../helpers/admin-fixture.js";

import {
  createAuthenticatedContext,
  loginAdminViaUi,
} from "../helpers/auth-context.js";
import { loadRuntime, requiredE2eDatabaseUrl } from "../helpers/runtime.js";

test("普通成员可进入成员与设置并只读查看同组织成员", async ({ browser }) => {
  test.setTimeout(60_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto("/settings");
    // ADR-081：入口对全体成员开放；普通成员只读查看自己组织，不出现管理员专属视图。
    await expect(
      page.getByRole("heading", { name: "成员与设置" }),
    ).toBeVisible();
    await expect(page.getByTestId("admin-forbidden")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "成员与角色" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "加入组织" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "批量管理" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("管理员完成用户编辑、停用、启用与强制退出", async ({ browser, admin }) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const context = await browser.newContext({
    baseURL: runtime.webBaseUrl,
  });
  const page = await context.newPage();
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const loginName = `f03_${suffix}`;
  const name = `F-03 用户 ${suffix}`;
  // 新增用户入口已按「将来只用单点登录」的口径从管理页移除，目标账号改由夹具
  // 直接预置（与 SSO JIT 开通一致：password_hash 为空）；`f03_` 前缀由
  // global-teardown 的夹具清理统一物理删除。
  const sql = postgres(requiredE2eDatabaseUrl(), {
    max: 1,
    onnotice: () => undefined,
  });

  try {
    await sql`INSERT INTO app.users (login_name, name, password_hash, is_admin, status) VALUES (${loginName}, ${name}, NULL, false, 'ACTIVE')`;
    await loginAdminViaUi(page, runtime, admin);
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "成员与设置" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "新增用户" })).toHaveCount(0);

    const card = page.locator(".member-row").filter({ hasText: loginName });
    await expect(card.getByText(name, { exact: true })).toBeVisible();

    await card.getByRole("button", { name: /编\s*辑/ }).click();
    const editDialog = page.getByRole("dialog", { name: "编辑用户" });
    const updatedName = `${name}-已编辑`;
    await editDialog.getByLabel("姓名").fill(updatedName);
    await editDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(editDialog).toBeHidden();
    await expect(card.getByText(updatedName, { exact: true })).toBeVisible();

    await card.getByRole("button", { name: /停\s*用/ }).click();
    const disableDialog = page.getByRole("dialog", { name: "停用用户" });
    await disableDialog.getByRole("button", { name: /确\s*认/ }).click();
    await expect(disableDialog).toBeHidden();
    await expect(card.getByText("停用", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: /启\s*用/ }).click();
    const enableDialog = page.getByRole("dialog", { name: "启用用户" });
    await enableDialog.getByRole("button", { name: /确\s*认/ }).click();
    await expect(enableDialog).toBeHidden();
    await expect(card.getByText("启用", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "强制退出" }).click();
    const logoutDialog = page.getByRole("dialog", { name: "强制退出" });
    await logoutDialog.getByRole("button", { name: /确\s*认/ }).click();
    await expect(logoutDialog).toBeHidden();
    await expect(
      page.getByText("已强制退出该用户", { exact: true }),
    ).toBeVisible();
  } finally {
    await sql.end({ timeout: 5 });
    await context.close();
  }
});

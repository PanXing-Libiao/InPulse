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
    await expect(page.locator(".settings-members-panel h3")).toHaveText(/\S+/);
    await expect(page.getByRole("button", { name: "加入组织" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "批量管理" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("管理员完成用户编辑、停用、启用与强制删除", async ({ browser, admin }) => {
  test.setTimeout(180_000);
  const runtime = await loadRuntime();
  const context = await browser.newContext({
    baseURL: runtime.webBaseUrl,
  });
  const page = await context.newPage();
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const loginName = `f03_${suffix}`;
  const name = `F-03 用户 ${suffix}`;
  // 新增用户入口已按「将来只用单点登录」的口径从管理页移除，目标账号改由夹具
  // 直接预置（与 SSO JIT 开通一致：password_hash 为空）；sso_subject 保留夹具
  // 前缀，仍便于清理脚本识别可能残留的夹具数据。
  const sql = postgres(requiredE2eDatabaseUrl(), {
    max: 1,
    onnotice: () => undefined,
  });

  try {
    const [created] = await sql<{ id: number }[]>`
      INSERT INTO app.users (
        login_name,
        name,
        password_hash,
        is_admin,
        status,
        sso_subject
      )
      VALUES (
        ${loginName},
        ${name},
        NULL,
        false,
        'ACTIVE',
        ${"e2e_" + suffix}
      )
      RETURNING id
    `;
    if (!created) throw new Error("E2E user fixture insert returned no row");
    const targetId = created.id;
    await loginAdminViaUi(page, runtime, admin);
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "成员与设置" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "新增用户" })).toHaveCount(0);
    await expect(page.getByText("当前账号", { exact: true })).toHaveCount(0);
    // 先等目标成员数据渲染完成再量工具栏几何，避免把加载中の过渡布局当成最终排版。
    await expect(
      page.locator(".member-row").filter({ hasText: loginName }),
    ).toContainText(name);
    const scope = page.getByRole("group", { name: "成员状态筛选" });
    const filterBox = await scope.boundingBox();
    const searchBox = await page.getByLabel("搜索成员").boundingBox();
    if (!filterBox || !searchBox)
      throw new Error("member toolbar is not laid out");
    expect(filterBox.x).toBeLessThan(searchBox.x);
    expect(
      Math.abs(
        filterBox.y +
          filterBox.height / 2 -
          (searchBox.y + searchBox.height / 2),
      ),
    ).toBeLessThan(2);
    await expect(
      scope.getByRole("button", { name: "启用中", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    const currentCard = page
      .locator(".member-row")
      .filter({ hasText: admin.account.loginName })
      .first();
    await expect(currentCard).toBeVisible();
    await expect(currentCard.locator(".member-action-placeholder")).toHaveCount(
      1,
    );
    await expect(
      currentCard.getByRole("button", { name: /停\s*用/ }),
    ).toHaveCount(0);

    const card = page.locator(".member-row").filter({ hasText: loginName });
    await expect(card.getByText(name, { exact: true })).toBeVisible();
    await expect(currentCard.locator(".member-org-tags")).toContainText(
      "未分配",
    );
    await expect(card.locator(".member-org-tags")).not.toContainText(
      "统一身份",
    );
    const editButton = card.getByRole("button", { name: /编\s*辑/ });
    const stopButton = card.getByRole("button", { name: /停\s*用/ });
    const statusBox = await card.locator(".member-status").boundingBox();
    const stopBox = await stopButton.boundingBox();
    const editBox = await editButton.boundingBox();
    const currentStatusBox = await currentCard
      .locator(".member-status")
      .boundingBox();
    const currentEditBox = await currentCard
      .getByRole("button", { name: /编\s*辑/ })
      .boundingBox();
    if (
      !statusBox ||
      !stopBox ||
      !editBox ||
      !currentStatusBox ||
      !currentEditBox
    )
      throw new Error("member actions are not laid out");
    expect(Math.abs(currentStatusBox.x - statusBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(currentEditBox.x - editBox.x)).toBeLessThanOrEqual(2);
    expect(stopBox.x).toBeLessThan(editBox.x);
    expect(stopBox.height).toBeGreaterThanOrEqual(30);
    expect(editBox.height).toBeGreaterThanOrEqual(30);
    await expect(stopButton).toHaveCSS("font-size", "14px");
    await expect(editButton).toHaveCSS("font-size", "14px");
    expect(stopBox.x).toBeGreaterThan(statusBox.x + statusBox.width);

    await editButton.click();
    const editDialog = page.getByRole("dialog", { name: "编辑用户" });
    const updatedName = `${name}-已编辑`;
    await editDialog.getByLabel("姓名").fill(updatedName);
    await editDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(editDialog).toBeHidden();
    await expect(card.getByText(updatedName, { exact: true })).toBeVisible();

    await stopButton.click();
    const disableDialog = page.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await expect(disableDialog.getByText("全部项目已完成。")).toBeVisible();
    await disableDialog.getByRole("button", { name: /确认停用/ }).click();
    await expect(disableDialog).toBeHidden();
    await expect(card).toHaveCount(0);
    await scope.getByRole("button", { name: "已停用", exact: true }).click();
    await expect(card.getByText("停用", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /启\s*用/ })).toBeVisible();
    await expect(card.getByRole("button", { name: "强制删除" })).toBeVisible();
    await expect(page.getByRole("button", { name: "加入组织" })).toHaveCount(0);

    await card.getByRole("button", { name: /启\s*用/ }).click();
    const enableDialog = page.getByRole("dialog", { name: "启用用户" });
    await enableDialog.getByRole("button", { name: /确\s*认/ }).click();
    await expect(enableDialog).toBeHidden();
    await expect(card).toHaveCount(0);
    await scope.getByRole("button", { name: "启用中", exact: true }).click();
    await expect(card.getByText("启用", { exact: true })).toBeVisible();

    await stopButton.click();
    const disableAgainDialog = page.getByRole("dialog", {
      name: "停用账号 · 任务交接",
    });
    await expect(
      disableAgainDialog.getByText("全部项目已完成。"),
    ).toBeVisible();
    await disableAgainDialog.getByRole("button", { name: /确认停用/ }).click();
    await expect(disableAgainDialog).toBeHidden();
    await expect(card).toHaveCount(0);
    await scope.getByRole("button", { name: "已停用", exact: true }).click();
    await expect(card.getByText("停用", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "强制删除" }).click();
    const deleteDialog = page.getByRole("dialog", { name: /强制删除/ });
    await expect(deleteDialog).toContainText("删除不可撤销");
    await deleteDialog.getByRole("button", { name: "确认删除" }).click();
    await expect(deleteDialog).toBeHidden();
    await expect(
      page.getByText("账号已删除，审计与项目动态保留事件当时姓名", {
        exact: true,
      }),
    ).toBeVisible();

    await expect(card).toHaveCount(0);
    await scope.getByRole("button", { name: "启用中", exact: true }).click();
    await expect(card).toHaveCount(0);
    await scope.getByRole("button", { name: "已停用", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(
      page.locator(".member-row").filter({ hasText: `账号 #${targetId}` }),
    ).toHaveCount(0);
    await expect(page.getByText("删除用户", { exact: true })).toHaveCount(0);
  } finally {
    await sql.end({ timeout: 5 });
    await context.close();
  }
});

import { expect, test, type Page } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { createProjectViaUi } from "../helpers/project-create.js";
import { loadRuntime } from "../helpers/runtime.js";

async function openNotificationPolicy(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "通知策略" }).click();
  const toggle = page.getByRole("switch", {
    name: "接收项目成员被加入提醒",
  });
  await expect(toggle).toBeVisible();
  return toggle;
}

test("关闭个人通知类型只停止后续通知，历史通知保持原状", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  const notificationItems = (projectName: string) =>
    page
      .locator('[data-testid^="notification-item-"]')
      .filter({ hasText: projectName });

  const beforeDisable = await createProjectViaUi(page, runtime, "NPREF");
  await page.goto("/notifications");
  await expect(notificationItems(beforeDisable.name)).toBeVisible();

  const toggle = await openNotificationPolicy(page);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  // 刷新后仍保持关闭，证明偏好写入服务端而不是浏览器本地存储。
  await page.reload();
  await page.getByRole("button", { name: "通知策略" }).click();
  await expect(
    page.getByRole("switch", { name: "接收项目成员被加入提醒" }),
  ).not.toBeChecked();

  // 关闭期间创建新项目：后续加入通知不应再生成，但关闭前的历史通知仍在。
  const whileDisabled = await createProjectViaUi(page, runtime, "NPREF2");
  await page.goto("/notifications");
  await expect(notificationItems(beforeDisable.name)).toBeVisible();
  await expect(notificationItems(whileDisabled.name)).toHaveCount(0);

  // 重新开启后历史保持原状，关闭期间未发送的通知也不补发。
  const reopened = await openNotificationPolicy(page);
  await expect(reopened).not.toBeChecked();
  await reopened.click();
  await expect(reopened).toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "通知策略" }).click();
  await expect(
    page.getByRole("switch", { name: "接收项目成员被加入提醒" }),
  ).toBeChecked();

  await page.goto("/notifications");
  await expect(notificationItems(beforeDisable.name)).toBeVisible();
  await expect(notificationItems(whileDisabled.name)).toHaveCount(0);

  await context.close();
});

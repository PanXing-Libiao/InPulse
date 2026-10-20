import { expect, test, type Locator } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { createProjectViaUi } from "../helpers/project-create.js";
import { loadRuntime } from "../helpers/runtime.js";

async function readUnreadCount(bell: Locator): Promise<number> {
  await expect(bell).toHaveAttribute("title", /^\d+ 条未读通知$/);
  const title = await bell.getAttribute("title");
  const match = title?.match(/^(\d+) 条未读通知$/);
  if (match?.[1] === undefined) {
    throw new Error(`无法解析通知未读数: ${title ?? "missing"}`);
  }
  return Number(match[1]);
}

test("登录用户可在通知页切换已读/未读并全部已读", async ({ browser }) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  // 先在测试库清空历史未读，避免“未读优先 + 首屏 20 条”把刚标记已读的条目
  // 顶到后续分页，从而使已读/未读往返断言变成对分页顺序的偶然依赖。
  await page.goto("/notifications");
  const markAllRead = page.getByRole("button", { name: "全部已读" });
  if (await markAllRead.isEnabled()) {
    await markAllRead.click();
    await expect(markAllRead).toBeDisabled();
  }
  const created = await createProjectViaUi(page, runtime, "NOT");
  await page.goto("/notifications");

  const item = page
    .locator('[data-testid^="notification-item-"]')
    .filter({ hasText: created.name });
  const bell = page.getByRole("button", { name: "通知", exact: true });

  await expect(item).toBeVisible();
  await expect(
    item.getByText(`已加入项目 ${created.name}`, { exact: true }),
  ).toBeVisible();
  await expect(item.getByRole("button", { name: "标记已读" })).toBeVisible();

  const initialUnread = await readUnreadCount(bell);
  expect(initialUnread).toBeGreaterThan(0);

  await item.getByRole("button", { name: "标记已读" }).click();
  await expect(item.getByRole("button", { name: "标记未读" })).toBeVisible();
  await expect(bell).toHaveAttribute(
    "title",
    `${initialUnread - 1} 条未读通知`,
  );

  await item.getByRole("button", { name: "标记未读" }).click();
  await expect(item.getByRole("button", { name: "标记已读" })).toBeVisible();
  await expect(bell).toHaveAttribute("title", `${initialUnread} 条未读通知`);

  await page.getByRole("button", { name: "全部已读" }).click();
  await expect(item.getByRole("button", { name: "标记未读" })).toBeVisible();
  await expect(bell).toHaveAttribute("title", "0 条未读通知");
  await expect(page.getByRole("button", { name: "全部已读" })).toBeDisabled();

  await context.close();
});

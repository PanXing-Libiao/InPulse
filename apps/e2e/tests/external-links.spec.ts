import { expect, test, type Locator, type Page } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  pickCalmSelectOption,
  pickFirstCalmSelectOption,
} from "../helpers/calm-select.js";
import {
  createTaskInOpenModule,
  openFirstModuleTasks,
} from "../helpers/module-tasks.js";
async function add(page: Page, url: string, label: string) {
  const modal = page.getByRole("dialog", { name: "GitHub 链接", exact: true });
  // 方案 A：写操作按需展开，先点「添加链接」再填地址。
  await modal.getByRole("button", { name: "添加链接" }).click();
  await modal.getByLabel("GitHub URL").fill(url);
  await modal.getByRole("button", { name: "确认添加" }).click();
  await expect(
    modal.getByRole("link", { name: label, exact: true }),
  ).toBeVisible();
  const link = modal.getByRole("link", { name: label, exact: true });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  return modal;
}
async function addInline(
  scope: Locator,
  url: string,
  label: string,
): Promise<void> {
  await scope.getByRole("button", { name: "添加 GitHub 链接" }).click();
  await scope.getByLabel("GitHub URL").fill(url);
  await scope.getByRole("button", { name: "确认添加" }).click();
  const link = scope.getByRole("link", { name: label, exact: true });
  await expect(link).toBeVisible({ timeout: 15000 });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
}
test("F22 项目与任务多链接持久化，重复和不安全链接有明确提示", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/projects/${runtime.projectId}/modules`);
    await page.getByRole("button", { name: "GitHub 链接" }).click();
    let modal = await add(
      page,
      "https://github.com/inpulse/core/issues/22001",
      "Issue #22001",
    );
    await modal.getByRole("button", { name: "关闭关联" }).click();
    await page.goto(`/search?q=${encodeURIComponent(runtime.searchQuery)}`);
    await expect(
      page
        .getByTestId("search-result-item")
        .filter({ hasText: runtime.projectTitle }),
    ).toBeVisible();

    await page.goto(`/projects/${runtime.projectId}/modules`);
    await page.getByRole("button", { name: "GitHub 链接" }).click();
    modal = await add(
      page,
      "https://GitHub.com:443/inpulse/core/releases/tag/v2.6.0?utm_source=test#notes",
      "Release v2.6.0",
    );
    await modal.getByRole("button", { name: "添加链接" }).click();
    await modal
      .getByLabel("GitHub URL")
      .fill("https://github.com/inpulse/core/releases/tag/v2.6.0");
    await modal.getByRole("button", { name: "确认添加" }).click();
    await expect(modal.getByText("该链接已关联，请勿重复添加。")).toBeVisible();
    await modal.getByRole("button", { name: "加载最新关联" }).click();
    await expect(modal.getByRole("button", { name: "确认添加" })).toBeEnabled();
    await modal
      .getByLabel("GitHub URL")
      .fill("https://github.com.evil.test/inpulse/core");
    await modal.getByRole("button", { name: "确认添加" }).click();
    await expect(modal.getByText(/链接无效/)).toBeVisible();
    await modal.getByRole("button", { name: "关闭关联" }).click();

    await openFirstModuleTasks(page, runtime.projectId);
    const detail = await createTaskInOpenModule(
      page,
      runtime.user.name,
      "GitHub任务-" + Date.now(),
    );
    await detail.getByRole("button", { name: "GitHub 链接" }).click();
    modal = await add(
      page,
      "https://github.com/inpulse/core/pull/22002",
      "PR #22002",
    );
    await add(
      page,
      "https://github.com/inpulse/core/commit/0ab12cd34ef",
      "Commit 0ab12cd34ef",
    );
    await modal.getByRole("button", { name: "关闭关联" }).click();
    await page.reload();
    await page.locator(".calm-task-card").first().click();
    await detail.getByRole("button", { name: "GitHub 链接" }).click();
    await expect(modal.getByRole("link", { name: "PR #22002" })).toBeVisible();
    await modal.getByRole("button", { name: "解除 PR #22002" }).click();
    await modal.getByRole("button", { name: "确认解除关联" }).click();
    await expect(modal.getByRole("link", { name: "PR #22002" })).toHaveCount(0);
    await expect(
      modal.getByRole("link", { name: "Commit 0ab12cd34ef" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/f22-task-links.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
test("F22 draft links survive publication and revision without changing old version", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const draft = page.getByRole("dialog", { name: "新建迭代记录" });
    await pickFirstCalmSelectOption(draft, "所属模块");
    await draft.getByLabel("迭代标题").fill("F22记录" + Date.now());
    await draft.getByLabel("改动原因").fill("原始问题");
    await draft.getByLabel("具体改动").fill("原始方案");
    await draft.getByLabel("改动效果").fill("原始验证");
    await draft.getByRole("button", { name: "保存草稿" }).click();
    await expect(draft).toBeHidden();
    await page
      .getByRole("region", { name: "草稿详情" })
      .getByRole("button", { name: "GitHub 链接" })
      .click();
    const modal = await add(
      page,
      "https://github.com/inpulse/core/issues/22003",
      "Issue #22003",
    );
    await modal.getByRole("button", { name: "关闭关联" }).click();
    await page.getByRole("button", { name: "发布记录", exact: true }).click();
    const publish = page.getByRole("dialog", { name: "发布迭代记录" });
    await publish.getByRole("button", { name: "确认发布" }).click();
    await expect(publish).toBeHidden();
    const detail = page.getByRole("region", { name: "正式记录详情" });
    // GitHub 关联默认折叠，先展开再断言链接。
    await detail.getByRole("button", { name: "GitHub 关联" }).click();
    await expect(
      detail.getByRole("link", { name: "Issue #22003", exact: true }),
    ).toBeVisible();
    await addInline(
      detail,
      "https://github.com/inpulse/core/pull/22004",
      "PR #22004",
    );
    await detail.getByRole("button", { name: "修订内容" }).click();
    const edit = page.getByRole("dialog", { name: "修订迭代记录" });
    await edit.getByLabel("具体改动").fill("修订方案");
    await edit.getByRole("button", { name: "保存新版本" }).click();
    await expect(edit).toBeHidden();
    await expect(
      detail
        .locator(":scope > section:not([aria-label])")
        .filter({
          has: page.getByRole("heading", { name: "具体改动", exact: true }),
        })
        .getByText("修订方案", { exact: true }),
    ).toBeVisible();
    await pickCalmSelectOption(detail, "较早版本", /^v1 · /);
    await pickCalmSelectOption(detail, "对照版本", /^v2 · /);
    await expect(
      detail.getByLabel("版本差异").getByText("原始方案"),
    ).toBeVisible();
    await expect(
      detail.getByRole("link", { name: "Issue #22003", exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("link", { name: "PR #22004", exact: true }),
    ).toBeVisible();
    await page.goto("/search?q=22004");
    await expect(page.getByText(/F22记录/).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F22 新建迭代弹窗内直接暂存 GitHub 链接，发布后落到正式记录", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const suffix = Date.now();
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const draft = page.getByRole("dialog", { name: "新建迭代记录" });
    await pickFirstCalmSelectOption(draft, "所属模块");
    await draft.getByLabel("迭代标题").fill(`F22内联记录${suffix}`);
    await draft.getByLabel("改动原因").fill("原始问题");
    await draft.getByLabel("具体改动").fill("原始方案");
    await draft.getByLabel("改动效果").fill("原始验证");
    // 弹窗内直接暂存 GitHub 链接：非法链接被拦下，合法的进入待添加列表。
    await draft
      .getByLabel("GitHub 链接地址")
      .fill("https://gitlab.com/inpulse/core/pull/22311");
    await draft.getByRole("button", { name: "添加链接" }).click();
    await expect(
      draft.getByText("只接受 github.com 的 HTTPS 链接，请检查输入。"),
    ).toBeVisible();
    await draft
      .getByLabel("GitHub 链接地址")
      .fill("https://github.com/inpulse/core/pull/22311");
    await draft.getByRole("button", { name: "添加链接" }).click();
    await expect(draft.getByText("PR #22311")).toBeVisible();
    await expect(draft.locator(".completion-links-pending li")).toHaveCount(1);
    await draft.screenshot({
      path: "test-results/f22-dialog-staged-link-form.png",
    });
    // 三态主按钮统一为「发布迭代记录」，独立新建同样会立即播给项目成员。
    await draft
      .getByRole("button", { name: "发布迭代记录", exact: true })
      .click();
    await expect(draft).toBeHidden();
    // 发布后直接落到正式记录：链接随草稿一起写入，无需再手工关联一次。
    const detail = page.getByRole("region", { name: "正式记录详情" });
    await detail.getByRole("button", { name: "GitHub 关联" }).click();
    await expect(
      detail.getByRole("link", { name: "PR #22311", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/f22-dialog-staged-link.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

import { expect, test } from "@playwright/test";
import {
  createAuthenticatedContext,
  loginViaUi,
} from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  pickCalmSelectOption,
  pickCalmSelectOptions,
} from "../helpers/calm-select.js";

test("F-14 项目成员创建/指派任务，双页面合并，通知直达和刷新持久化", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const recipientContext = await browser.newContext({
    baseURL: runtime.webBaseUrl,
  });
  try {
    const suffix = Date.now().toString(16).toUpperCase();
    await page.goto("/projects");
    await page.getByTestId("create-project-button").click();
    const project = page.getByRole("dialog");
    await project.getByLabel("项目名称").fill(`任务验收-${suffix}`);
    await project.getByLabel("项目编码").fill(`T14${suffix}`);
    await pickCalmSelectOptions(project, "选择项目成员", [runtime.member.name]);
    await project.getByRole("button", { name: "创建项目" }).click();
    await page.getByTestId("open-created-project-activity").click();
    const projectId = page.url().match(/projects\/(\d+)/)![1];
    await page.goto(`/projects/${projectId}/modules`);
    // 空项目的模块页直接显示「项目 → 模块 → 任务」搭建引导。
    await expect(page.getByTestId("project-setup-guide")).toBeVisible();
    await page.getByRole("button", { name: "新增模块", exact: true }).click();
    const moduleDialog = page.getByRole("dialog", { name: "新增模块" });
    await moduleDialog.getByLabel("模块名称").fill(`支付模块-${suffix}`);
    await moduleDialog.getByRole("button", { name: /保\s*存/ }).click();
    await expect(moduleDialog).toBeHidden();
    await page.locator(".module-card").first().click();
    await expect(page).toHaveURL(/\/modules\/\d+\/tasks$/);
    const moduleTasksUrl = page.url();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    const form = page.getByRole("dialog", { name: "新建任务" });
    await form.getByLabel("任务标题").fill(`退款任务-${suffix}`);
    await form.getByLabel("任务说明").fill("最初说明");
    await pickCalmSelectOption(form, "负责人", runtime.member.name);
    await pickCalmSelectOption(form, "优先级", "高");
    await form.getByLabel("截止时间").fill("2026-10-01T18:00");
    await form.getByRole("button", { name: /创建任务/ }).click();
    await expect(form).toBeHidden();
    const drawer = page.getByRole("dialog", { name: "任务详情" });
    await expect(drawer.getByText("最初说明", { exact: true })).toBeVisible();
    await expect(
      drawer
        .locator(".task-modal-facts")
        .getByText(runtime.member.name, { exact: true }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: "编辑任务" }).click();
    const edit = page.getByRole("dialog", { name: "编辑任务" });
    await edit.getByLabel("任务标题").fill(`我的标题-${suffix}`);
    const other = await context.newPage();
    await other.goto(moduleTasksUrl);
    await other.locator(".calm-task-card").first().click();
    await other.getByRole("button", { name: "编辑任务" }).click();
    const otherEdit = other.getByRole("dialog", { name: "编辑任务" });
    await otherEdit.getByLabel("任务说明").fill("另一页面说明");
    await otherEdit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(otherEdit).toBeHidden();
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await edit.getByRole("button", { name: "加载最新版本后继续编辑" }).click();
    await expect(edit.getByLabel("任务说明")).toHaveValue("另一页面说明");
    await expect(edit.getByLabel("任务标题")).toHaveValue(`我的标题-${suffix}`);
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    // Same-field conflict must require a conscious choice.
    await page.getByRole("button", { name: "编辑任务" }).click();
    await edit.getByLabel("任务说明").fill("我的最终说明");
    await other.reload();
    await other.locator(".calm-task-card").first().click();
    await other.getByRole("button", { name: "编辑任务" }).click();
    await otherEdit.getByLabel("任务说明").fill("他人的最终说明");
    await otherEdit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(otherEdit).toBeHidden();
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await edit.getByRole("button", { name: "加载最新版本后继续编辑" }).click();
    await expect(edit.getByText("任务说明存在冲突")).toBeVisible();
    await expect(edit.getByRole("button", { name: /保\s*存/ })).toBeDisabled();
    await edit.getByRole("button", { name: "保留我的任务说明" }).click();
    await edit.getByRole("button", { name: "应用合并结果" }).click();
    await edit.getByRole("button", { name: /保\s*存/ }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await expect(
      page.getByRole("cell", { name: `我的标题-${suffix}` }),
    ).toBeVisible();
    await page.getByRole("button", { name: `我的标题-${suffix}` }).click();
    await expect(page.getByText("我的最终说明", { exact: true })).toBeVisible();
    const recipient = await recipientContext.newPage();
    await loginViaUi(recipient, runtime, runtime.member);
    await recipient.goto("/notifications");
    await recipient
      .getByText(`任务指派：退款任务-${suffix}`, { exact: true })
      .click();
    await expect(
      recipient.getByRole("dialog", { name: "任务详情" }),
    ).toBeVisible();
    await expect(
      recipient
        .getByRole("dialog", { name: "任务详情" })
        .getByText("我的最终说明", { exact: true }),
    ).toBeVisible();
    await other.close();
  } finally {
    await context.close();
    await recipientContext.close();
  }
});

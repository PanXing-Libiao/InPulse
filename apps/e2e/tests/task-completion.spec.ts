import { expect, test, type Page } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { fillLeftovers } from "../helpers/record-leftovers.js";
import {
  calmSelectTrigger,
  pickCalmSelectOption,
  pickCalmSelectOptionByIndex,
} from "../helpers/calm-select.js";
import { loadRuntime } from "../helpers/runtime.js";
import {
  createTaskInOpenModule,
  openFirstModuleTasks,
} from "../helpers/module-tasks.js";
async function createTask(
  page: Page,
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
) {
  const title = `组合任务-${Date.now()}`;
  await openFirstModuleTasks(page, runtime.projectId);
  const task = await createTaskInOpenModule(page, runtime.user.name, title);
  const sourceUrl = new URL(
    (await task
      .getByRole("link", { name: "打开迭代记录" })
      .getAttribute("href"))!,
    page.url(),
  );
  const url = new URL(page.url());
  url.searchParams.set("taskId", sourceUrl.searchParams.get("taskId")!);
  return { title, task, url: url.toString() };
}
test("F19 模块任务内联记录发布并完成任务", async ({ browser }) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const { task, title } = await createTask(page, runtime);
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const form = page.getByRole("dialog", { name: "完成任务", exact: true });
    await form.getByRole("button", { name: /有，填写迭代记录/ }).click();
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await form.getByLabel(label).fill("真实组合流程");
    await fillLeftovers(form, ["需要后续跟进"]);
    await form
      .getByRole("button", { name: "发布并完成任务", exact: true })
      .click();
    await expect(form).toBeHidden();
    await expect(
      task.getByRole("button", { name: "重新打开", exact: true }),
    ).toBeEnabled();
    await expect(task.locator(".task-status-history > li")).toHaveCount(2);
    await task.getByRole("link", { name: "查看已发布记录" }).click();
    // 设计师稿把记录标题、编号与状态徽章放在卡片摘要行，展开区只承载正文与操作。
    const summary = page
      .locator("details.record-card")
      .filter({ hasText: title })
      .locator("summary");
    await expect(summary).toContainText(title);
    await expect(summary).toContainText(/-CR-\d+ · v1 · 发布/);
    await expect(summary.locator(".record-summary-badges")).toContainText(
      "已发布",
    );
    const record = page.getByRole("region", { name: "正式记录详情" });
    await expect(record).toBeVisible();
    await record.getByRole("link", { name: "查看来源任务" }).click();
    await expect(
      task.getByRole("button", { name: "重新打开", exact: true }),
    ).toBeEnabled();
  } finally {
    await context.close();
  }
});
test("F19 草稿超限失败保留待办和选择，修正草稿后可发布并完成", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const { task, url } = await createTask(page, runtime);
    await task.getByRole("link", { name: "打开迭代记录" }).click();
    await page.getByRole("button", { name: "新建来源草稿" }).click();
    const draft = page.getByRole("dialog", { name: "新建任务迭代" });
    // 草稿与正式版本共用字段上限，超限只能在发布阶段由搜索容量触发；API 请求体默认上限
    // 100KB，因此只能用单字节字符：33600×3 越过 100000 字符的搜索文本上限，请求体约 100KB。
    const filler = "a".repeat(33600);
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await draft.getByLabel(label).fill(filler);
    await draft.getByRole("button", { name: "保存草稿" }).click();
    await expect(draft).toBeHidden();
    await page.goto(url);
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const form = page.getByRole("dialog", { name: "完成任务", exact: true });
    await form.getByRole("button", { name: /有，填写迭代记录/ }).click();
    await pickCalmSelectOption(form, "记录来源", "选择已有草稿");
    await pickCalmSelectOptionByIndex(form, "待发布草稿", 1);
    const selection = (
      await calmSelectTrigger(form, "待发布草稿").innerText()
    ).trim();
    // 草稿编辑后 rowVersion 递增，选项标题尾部的「版本 N」不再稳定；第二轮用
    // 「标题 · 草稿 #id」这段前缀匹配，保证仍然锁定同一条草稿。
    const draftRef = new RegExp(
      selection
        .split("· 版本")[0]!
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    await form
      .getByRole("button", { name: "发布并完成任务", exact: true })
      .click();
    await expect(form.getByText(/超出发布容量/)).toBeVisible();
    await expect(calmSelectTrigger(form, "待发布草稿")).toHaveText(selection);
    await expect(task.locator(".task-status-history > li")).toHaveCount(1);
    await form.getByRole("link", { name: "打开草稿继续编辑" }).click();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑草稿" });
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await edit.getByLabel(label).fill("可保留的完整内容");
    await fillLeftovers(edit, ["后续跟进"]);
    await edit.getByRole("button", { name: "保存草稿" }).click();
    await expect(edit).toBeHidden();
    await page.goto(url);
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    await form.getByRole("button", { name: /有，填写迭代记录/ }).click();
    await pickCalmSelectOption(form, "记录来源", "选择已有草稿");
    await pickCalmSelectOption(form, "待发布草稿", draftRef);
    await form
      .getByRole("button", { name: "发布并完成任务", exact: true })
      .click();
    await expect(form).toBeHidden();
    await expect(
      task.getByRole("button", { name: "重新打开", exact: true }),
    ).toBeEnabled();
    await task.getByRole("link", { name: "查看已发布记录" }).click();
    await expect(
      page
        .getByRole("region", { name: "正式记录详情" })
        .getByText("后续跟进", { exact: true })
        .first(),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
test("F22 任务上的 GitHub 链接可勾选沿用到新发布的迭代记录", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const { task } = await createTask(page, runtime);
    // 任务先挂一条 PR 链接，完成任务时把它连同新添加的 Issue 一起贴到新记录上。
    await task.getByRole("button", { name: "GitHub 链接" }).click();
    const links = page.getByRole("dialog", {
      name: "GitHub 链接",
      exact: true,
    });
    await links.getByRole("button", { name: "添加链接" }).click();
    await links
      .getByLabel("GitHub URL")
      .fill("https://github.com/inpulse/core/pull/22003");
    await links.getByRole("button", { name: "确认添加" }).click();
    await expect(
      links.getByRole("link", { name: "PR #22003", exact: true }),
    ).toBeVisible();
    await links.getByRole("button", { name: "关闭关联" }).click();
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const form = page.getByRole("dialog", { name: "完成任务", exact: true });
    await form.getByRole("button", { name: /有，填写迭代记录/ }).click();
    const section = form.getByRole("region", { name: "GitHub 链接" });
    // 任务上已有的链接收在下拉框里且默认勾选：展开后直接沿用。
    await section
      .getByRole("button", { name: /已选 1 \/ 1 条任务链接/ })
      .click();
    await expect(
      section.getByRole("checkbox", { name: /pull\/22003/ }),
    ).toBeChecked();
    await section
      .getByLabel("GitHub 链接地址")
      .fill("https://github.com/inpulse/core/issues/22004");
    await section.getByRole("button", { name: "添加链接" }).click();
    await expect(section.getByText("Issue #22004")).toBeVisible();
    // 勾选行与「自己添加」的待关联行同形：反例是修复前的单行 93px（复选框被顶到文案上方）。
    const checkedRow = await section
      .locator(".completion-links-list li")
      .first()
      .boundingBox();
    const pendingRow = await section
      .locator(".completion-links-pending li")
      .first()
      .boundingBox();
    expect(checkedRow?.height ?? 0).toBeLessThan(46);
    expect(
      Math.abs((checkedRow?.height ?? 0) - (pendingRow?.height ?? 0)),
    ).toBeLessThan(4);
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await form.getByLabel(label).fill("链接沿用流程");
    await fillLeftovers(form, ["需要后续跟进"]);
    await form
      .getByRole("button", { name: "发布并完成任务", exact: true })
      .click();
    await expect(form).toBeHidden();
    await task.getByRole("link", { name: "查看已发布记录" }).click();
    const record = page.getByRole("region", { name: "正式记录详情" });
    await expect(record).toBeVisible();
    await record.getByRole("button", { name: "GitHub 关联" }).click();
    await expect(
      record.getByRole("link", { name: "PR #22003", exact: true }),
    ).toBeVisible();
    await expect(
      record.getByRole("link", { name: "Issue #22004", exact: true }),
    ).toBeVisible();
    // 自己添加的 Issue 还应该存进项目链接库并关联到任务本身。
    await record.getByRole("link", { name: "查看来源任务" }).click();
    await task.getByRole("button", { name: "GitHub 链接" }).click();
    const taskLinks = page.getByRole("dialog", {
      name: "GitHub 链接",
      exact: true,
    });
    await expect(
      taskLinks.getByRole("link", { name: "Issue #22004", exact: true }),
    ).toBeVisible();
    await expect(
      taskLinks.getByRole("link", { name: "PR #22003", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
test("F22 记录一次迭代可勾选沿用任务上已有的 GitHub 链接", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const runtime = await loadRuntime(),
    { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const { task } = await createTask(page, runtime);
    // 任务先挂一条链接，再从「记录一次迭代」入口把链接带进新记录。
    await task.getByRole("button", { name: "GitHub 链接" }).click();
    const links = page.getByRole("dialog", {
      name: "GitHub 链接",
      exact: true,
    });
    await links.getByRole("button", { name: "添加链接" }).click();
    await links
      .getByLabel("GitHub URL")
      .fill("https://github.com/inpulse/core/issues/22005");
    await links.getByRole("button", { name: "确认添加" }).click();
    await expect(
      links.getByRole("link", { name: "Issue #22005", exact: true }),
    ).toBeVisible();
    await links.getByRole("button", { name: "关闭关联" }).click();
    await task.getByRole("tab", { name: "迭代记录" }).click();
    await task.getByRole("button", { name: "记录一次迭代" }).click();
    const draft = page.getByRole("dialog", { name: "新建任务迭代" });
    const section = draft.getByRole("region", { name: "GitHub 链接" });
    // 与「完成任务」入口同一套小节：任务上已有的链接收在下拉框里且默认勾选，也可以再添加新的。
    await section
      .getByRole("button", { name: /已选 1 \/ 1 条任务链接/ })
      .click();
    await expect(
      section.getByRole("checkbox", { name: /issues\/22005/ }),
    ).toBeChecked();
    await section
      .getByLabel("GitHub 链接地址")
      .fill("https://github.com/inpulse/core/pull/22006");
    await section.getByRole("button", { name: "添加链接" }).click();
    await expect(section.getByText("PR #22006")).toBeVisible();
    for (const label of ["改动原因", "具体改动", "改动效果"])
      await draft.getByLabel(label).fill("记录一次迭代沿用链接");
    await draft
      .getByRole("button", { name: "发布迭代记录", exact: true })
      .click();
    await expect(draft).toBeHidden();
    await expect(task.getByText(/迭代记录已发布：/)).toBeVisible();
    await task.getByRole("button", { name: "查看正式记录" }).click();
    const record = page.getByRole("region", { name: "正式记录详情" });
    await record.getByRole("button", { name: "GitHub 关联" }).click();
    await expect(
      record.getByRole("link", { name: "Issue #22005", exact: true }),
    ).toBeVisible();
    await expect(
      record.getByRole("link", { name: "PR #22006", exact: true }),
    ).toBeVisible();
    // 草稿弹窗里自己添加的 PR 同样要进链接库并关联到来源任务。
    await record.getByRole("link", { name: "查看来源任务" }).click();
    await task.getByRole("button", { name: "GitHub 链接" }).click();
    const taskLinks = page.getByRole("dialog", {
      name: "GitHub 链接",
      exact: true,
    });
    await expect(
      taskLinks.getByRole("link", { name: "PR #22006", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

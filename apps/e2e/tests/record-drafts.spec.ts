import { expect, test } from "@playwright/test";
import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { fillLeftovers } from "../helpers/record-leftovers.js";
import { loadRuntime } from "../helpers/runtime.js";
import { pickFirstCalmSelectOption } from "../helpers/calm-select.js";
import {
  createTaskInOpenModule,
  openFirstModuleTasks,
} from "../helpers/module-tasks.js";
test("F-17 独立草稿保存、继续编辑和刷新持久化", async ({ browser }) => {
  test.setTimeout(90000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const create = page.getByRole("dialog", { name: "新建迭代记录" });
    // 该弹窗的「所属模块」没有占位项，选第一项即第一个真实模块。
    await pickFirstCalmSelectOption(create, "所属模块");
    const title = `独立草稿-${Date.now()}`;
    await create.getByLabel("迭代标题").fill(title);
    await create.getByLabel("改动原因").fill("重复提交造成状态冲突");
    await create.getByLabel("具体改动").fill("增加幂等校验");
    await create.getByLabel("改动效果").fill("并发请求验证通过");
    await create.getByRole("button", { name: "保存草稿" }).click();
    await expect(create).toBeHidden();
    // 14808b1 起标题在弹层页头、草稿说明在弹层页脚，都在 region 之外。
    const detail = page.getByRole("dialog", {
      name: "草稿详情",
      exact: true,
    });
    await expect(detail.getByText("暂无已知遗留问题")).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑草稿" });
    await fillLeftovers(edit, ["继续观察高峰流量"]);
    await edit.getByRole("button", { name: "保存草稿" }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    await expect(detail.getByText("继续观察高峰流量")).toBeVisible();
    await expect(
      detail.getByText("草稿尚未发布，不计入正式迭代统计。"),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/f17-independent-draft.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});
test("F-17 弹窗内的 Ctrl+Enter 直接保存草稿且不发布", async ({ browser }) => {
  test.setTimeout(90000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const create = page.getByRole("dialog", { name: "新建迭代记录" });
    await pickFirstCalmSelectOption(create, "所属模块");
    const title = `快捷键草稿-${Date.now()}`;
    await create.getByLabel("迭代标题").fill(title);
    await create.getByLabel("改动原因").fill("用快捷键保存");
    await create.getByLabel("具体改动").fill("弹窗内 Ctrl+Enter");
    await create.getByLabel("改动效果").fill("草稿已落库");
    // 多行字段里直接按 Ctrl+Enter：等同于「保存草稿」，绝不会顺手发布。
    await create.getByLabel("改动效果").press("Control+Enter");
    await expect(create).toBeHidden();
    const detail = page.getByRole("dialog", { name: "草稿详情", exact: true });
    await expect(detail).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "草稿详情" })
        .getByText("弹窗内 Ctrl+Enter"),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F-17 未保存就离开先确认，放弃后不留痕迹", async ({ browser }) => {
  test.setTimeout(90000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const create = page.getByRole("dialog", { name: "新建迭代记录" });
    await pickFirstCalmSelectOption(create, "所属模块");
    const title = `未保存草稿-${Date.now()}`;
    await create.getByLabel("迭代标题").fill(title);
    await create.getByLabel("改动原因").fill("未保存就不该留下痕迹");
    // Esc 是误触高发路径：先确认，输入原样留着。
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog", { name: "放弃未保存的内容" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "继续编辑" }).click();
    await expect(discard).toBeHidden();
    await expect(create.getByLabel("迭代标题")).toHaveValue(title);
    // 真放弃才关闭：没有保存过，也不会有任何写入。
    await page.keyboard.press("Escape");
    await discard.getByRole("button", { name: "放弃修改" }).click();
    await expect(create).toBeHidden();
    await expect(
      page.locator(".draft-card").filter({ hasText: title }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("F-17 模块任务来源多草稿选择与不完成任务", async ({ browser }) => {
  test.setTimeout(90000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await openFirstModuleTasks(page, runtime.projectId);
    const suffix = Date.now();
    const title = `草稿任务-${suffix}`;
    const task = await createTaskInOpenModule(page, runtime.user.name, title);
    await task.getByRole("button", { name: "完成任务", exact: true }).click();
    const complete = page.getByRole("dialog", {
      name: "完成任务",
      exact: true,
    });
    await complete.getByRole("button", { name: /有，填写迭代记录/ }).click();
    await expect(
      complete.getByRole("button", { name: "发布并完成任务" }),
    ).toBeDisabled();
    await complete.getByRole("link", { name: "选择或新建草稿" }).click();
    for (let i = 1; i <= 2; i++) {
      await page.getByRole("button", { name: "新建来源草稿" }).click();
      const create = page.getByRole("dialog", { name: "新建任务迭代" });
      await expect(create.getByLabel("迭代标题")).toHaveValue(title);
      if (i === 2) await create.getByLabel("迭代标题").fill(title + "第二条");
      await create.getByLabel("改动原因").fill("来源问题" + i);
      await create.getByLabel("具体改动").fill("方案" + i);
      await create.getByLabel("改动效果").fill("验证" + i);
      await create.getByRole("button", { name: "保存草稿" }).click();
      await expect(create).toBeHidden();
      const detail = page.getByRole("dialog", {
        name: "草稿详情",
        exact: true,
      });
      await expect(detail).toBeVisible();
      await detail.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(detail).toBeHidden();
      await expect(page.getByRole("button", { name: /继续编辑/ })).toHaveCount(
        i,
      );
    }
    await page
      .locator(".draft-card")
      .filter({ hasText: title + "第二条" })
      .click();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑草稿" });
    await fillLeftovers(edit, ["来源草稿补充"]);
    await edit.getByRole("button", { name: "保存草稿" }).click();
    await expect(edit).toBeHidden();
    await page.reload();
    await expect(
      page.getByRole("region", { name: "草稿详情" }).getByText("来源草稿补充"),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/f17-module-task-drafts.png`,
      fullPage: true,
    });
    await page
      .getByRole("dialog", { name: "草稿详情", exact: true })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.getByRole("link", { name: "返回来源任务" }).click();
    await expect(
      task.getByRole("button", { name: "完成任务", exact: true }),
    ).toBeEnabled();
    await expect(task.locator(".task-status-history > li")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("F-17 草稿箱里的迭代记录可以删除", async ({ browser }) => {
  test.setTimeout(90000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/records?projectId=${runtime.projectId}`);
    await page.getByRole("button", { name: "新建迭代记录" }).click();
    const create = page.getByRole("dialog", { name: "新建迭代记录" });
    await pickFirstCalmSelectOption(create, "所属模块");
    const title = `待删除草稿-${Date.now()}`;
    await create.getByLabel("迭代标题").fill(title);
    await create.getByLabel("改动原因").fill("草稿写错了，需要作废");
    await create.getByLabel("具体改动").fill("改为删除草稿");
    await create.getByLabel("改动效果").fill("草稿箱保持干净");
    await create.getByRole("button", { name: "保存草稿" }).click();
    await expect(create).toBeHidden();
    const card = page.locator(".draft-card").filter({ hasText: title });
    await expect(card).toBeVisible();
    const detail = page.getByRole("dialog", { name: "草稿详情", exact: true });
    await expect(detail).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑草稿" });
    await expect(edit).toBeVisible();
    await edit.getByRole("button", { name: "删除草稿" }).click();
    const confirm = page.getByRole("dialog", { name: "删除草稿", exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("且不能恢复。")).toBeVisible();
    await expect(confirm.getByText("已经发布的迭代记录不受影响")).toBeVisible();
    await page.screenshot({
      path: "test-results/f17-draft-delete-confirm.png",
      fullPage: true,
    });
    await confirm.getByRole("button", { name: "确认删除" }).click();
    await expect(edit).toBeHidden();
    await expect(detail).toBeHidden();
    await expect(card).toHaveCount(0);
    await page.screenshot({
      path: "test-results/f17-draft-deleted.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

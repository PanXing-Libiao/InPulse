import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";

test("F-32 从文档导入整项目：预览、创建、模块可见与重复导入拦截", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  const suffix = Date.now().toString(16).slice(-8).toUpperCase();
  const code = `F32${suffix}`;
  const name = `F-32 文档导入项目 ${code}`;
  const document = [
    `# 项目：${name}`,
    `- 项目编码：${code}`,
    "- 项目说明：由 Playwright 文档导入创建，验证整项目导入关键路径。",
    // ADR-072/071：项目成员必填、必须含全部任务负责人；创建者写不写都行（写了也不重复）。
    `- 项目成员：${runtime.user.loginName}, ${runtime.member.loginName}`,
    "",
    "## 模块：文档导入模块",
    "- 说明：整项目导入的模块。",
    "",
    "### 任务：文档导入任务",
    `- 负责人：${runtime.member.loginName}`,
  ].join("\n");

  await page.goto("/projects");
  await page.getByTestId("import-project-document-button").click();
  const dialog = page.getByRole("dialog");
  // 工作台空态默认是拖入区：先展开文本区再粘贴。
  await dialog.getByRole("button", { name: "直接粘贴文本" }).click();
  // 展开后光标已经在文本区里，用户接着 Ctrl+V 就行。
  await expect(dialog.getByLabel("导入文档内容")).toBeFocused();
  await dialog.getByLabel("导入文档内容").fill(document);
  await dialog.getByTestId("document-import-preview").click();

  await expect(dialog.getByTestId("document-import-summary")).toBeVisible();
  await expect(dialog.getByText(/计划创建模块 1 个/)).toBeVisible();
  // 工作台预览计划卡片：模块名 + 「新建模块」标签。
  const planCardHead = dialog.locator(".import-plan-cardhead").first();
  await expect(planCardHead).toContainText("文档导入模块");
  await expect(planCardHead.locator("em")).toHaveText("新建模块");

  // 预览阶段点右上角叉只「关闭预览」：退回工作台、草稿还在，不会把整个弹窗关掉。
  await dialog.getByRole("button", { name: "关闭预览" }).click();
  await expect(dialog.getByTestId("document-import-summary")).toHaveCount(0);
  await expect(dialog.getByLabel("导入文档内容")).toHaveValue(document);
  await dialog.getByTestId("document-import-preview").click();
  await expect(dialog.getByTestId("document-import-summary")).toBeVisible();

  await dialog.getByTestId("document-import-apply").click();
  await expect(page).toHaveURL(/\/projects\/\d+\/modules/);
  await expect(
    page.getByRole("heading", { name: "文档导入模块", exact: true }),
  ).toBeVisible();

  // 任务落在模块内：点击模块卡片直接进入模块任务页。
  await page
    .getByRole("heading", { name: "文档导入模块", exact: true })
    .click();
  await expect(page).toHaveURL(/\/modules\/\d+\/tasks$/);
  await expect(
    page.getByRole("heading", { name: "文档导入模块", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("文档导入任务", { exact: true })).toBeVisible();

  // 同一文档再次导入：预览给出重复提示，确认按钮禁用。
  await page.goto("/projects");
  await page.getByTestId("import-project-document-button").click();
  const again = page.getByRole("dialog");
  // 工作台空态默认是拖入区：先展开文本区再粘贴。
  await again.getByRole("button", { name: "直接粘贴文本" }).click();
  await again.getByLabel("导入文档内容").fill(document);
  await again.getByTestId("document-import-preview").click();
  await expect(again.getByText("该文档已导入过，不能重复导入。")).toBeVisible();
  await expect(again.getByTestId("document-import-apply")).toBeDisabled();

  await context.close();
});

test("F-32 项目内从文档导入多个模块与任务", async ({ browser }) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  const suffix = Date.now().toString(16).slice(-6).toUpperCase();
  const moduleA = `批次模块甲 ${suffix}`;
  const moduleB = `批次模块乙 ${suffix}`;
  const document = [
    `## 模块：${moduleA}`,
    "- 说明：批量导入的模块甲。",
    "",
    "### 任务：批次任务甲",
    // 项目内导入（模式 A）要求负责人已是项目活跃成员：夹具项目里只有 E2E 用户本人。
    `- 负责人：${runtime.user.loginName}`,
    "",
    `## 模块：${moduleB}`,
  ].join("\n");

  await page.goto(`/projects/${runtime.projectId}/modules`);
  await page.getByTestId("import-project-document-button").click();
  const dialog = page.getByRole("dialog");
  // 工作台空态默认是拖入区：先展开文本区再粘贴。
  await dialog.getByRole("button", { name: "直接粘贴文本" }).click();
  await dialog.getByLabel("导入文档内容").fill(document);
  await dialog.getByTestId("document-import-preview").click();
  await expect(dialog.getByText(/计划创建模块 2 个/)).toBeVisible();
  await dialog.getByTestId("document-import-apply").click();

  await expect(page.getByText(/文档导入完成：新建 2 个模块/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: moduleA, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: moduleB, exact: true }),
  ).toBeVisible();

  await context.close();
});

test("F-32 文档导入弹窗在矮窗口下页脚不被裁切、正文内部滚动（布局回归）", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  // 模拟「窗口没全屏」：620px 高度下，工作台（拖入区 / 草稿 / 助手对话）必然超过可用高度。
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto("/projects");
  await page.getByTestId("import-project-document-button").click();
  const dialog = page.getByRole("dialog");

  // 页脚（取消 / 预览）必须完整落在视口内，不能被 overflow 裁掉。
  const preview = dialog.getByTestId("document-import-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toBeInViewport();
  const box = await preview.boundingBox();
  expect(box, "预览按钮应有布局盒").not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(620);

  // 空态拖入区不应把工作台撑破：弹窗正文自身不溢出。
  const bodyMetrics = await dialog
    .locator(".import-workbench-body")
    .evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  expect(bodyMetrics.scrollHeight).toBeLessThanOrEqual(
    bodyMetrics.clientHeight + 1,
  );

  // 展开文本区并粘进长文档：文本区保持可用高度，靠自身滚动适配，而不是压扁弹窗。
  await dialog.getByRole("button", { name: "直接粘贴文本" }).click();
  const document = Array.from(
    { length: 30 },
    (_, index) => "- 项目说明：第 " + String(index + 1) + " 行说明文本",
  ).join("\n");
  const textarea = dialog.getByLabel("导入文档内容");
  await textarea.fill(document);
  const textareaBox = await textarea.boundingBox();
  expect(textareaBox, "文本框应有布局盒").not.toBeNull();
  // ADR-094 的「导入位置」工具条会占用一行高度；620px 视口下仍有约 199px，
  // 这里守住「是一块可编辑的大文本区」这一交互目标，而不是写死一次性的像素值。
  expect(textareaBox!.height).toBeGreaterThanOrEqual(180);
  const textareaMetrics = await textarea.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(textareaMetrics.scrollHeight).toBeGreaterThan(
    textareaMetrics.clientHeight,
  );
  await expect(preview).toBeInViewport();

  // 文本区能滚到自己的末尾，且不会越出工作台（此前越界的那截正是压在底部行上的重影）。
  const scrolled = await textarea.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return {
      scrollTop: el.scrollTop,
      maxScroll: el.scrollHeight - el.clientHeight,
    };
  });
  expect(scrolled.scrollTop).toBeGreaterThan(0);
  expect(scrolled.scrollTop).toBeGreaterThanOrEqual(scrolled.maxScroll - 1);
  const paneBottom = await dialog
    .locator(".import-pane")
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const bodyBottom = await dialog
    .locator(".import-workbench-body")
    .evaluate((el) => el.getBoundingClientRect().bottom);
  expect(paneBottom).toBeLessThanOrEqual(bodyBottom + 1);

  await context.close();
});

test("F-32 文档导入右栏输入行贴底：高窗口下不留悬空空隙（布局回归）", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  // 高窗口 + 左栏长草稿：右栏被左栏 stretch 撑高。此前 `.import-assist-msgs` 的
  // max-height: 38vh 提前封顶，flex 列的余量只能留在列尾，输入行就浮在面板底部之上。
  await page.setViewportSize({ width: 1280, height: 1040 });
  await page.goto("/projects");
  await page.getByTestId("import-project-document-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "直接粘贴文本" }).click();
  const document = Array.from({ length: 10 }, (_, index) =>
    [
      "## 模块：模块 " + String(index + 1),
      "### 任务：任务 " + String(index + 1),
    ].join("\n"),
  ).join("\n");
  await dialog.getByLabel("导入文档内容").fill(document);
  await dialog.getByRole("button", { name: "内容梳理" }).click();

  const pane = await dialog.locator(".import-assist").boundingBox();
  const composer = await dialog.locator(".import-composer").boundingBox();
  expect(pane, "右栏应有布局盒").not.toBeNull();
  expect(composer, "输入行应有布局盒").not.toBeNull();
  // 弹窗外框已固定为 min(760px, 100dvh - 56px)，右栏高度来自外框而不是被左栏
  // 撑高；这里只要求它确实占到固定外框内的高度，后面的贴底断言才有意义。
  expect(pane!.height).toBeGreaterThan(400);
  // 输入行底部与面板底部只差面板的下内边距（12px）量级，不再悬空。
  const gap = pane!.y + pane!.height - (composer!.y + composer!.height);
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(gap).toBeLessThanOrEqual(18);

  await context.close();
});

test("F-32 文档导入拥挤时不越界压字：草稿区留在自己的栏里（布局回归）", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  const document = [
    "# 项目：压测项目",
    "- 项目编码：TMPLOAD",
    ...Array.from({ length: 14 }, (_, index) => {
      const order = String(index + 1);
      return [
        "## 模块：模块 " + order,
        "- 说明：该模块覆盖售前规划到验收的全流程数据记录与展示。",
      ].join("\n");
    }),
  ].join("\n");

  for (const width of [1280, 880]) {
    // 620px 高的窗口里，草稿区拿不到它原本 200px 的下限：此前 .import-draft-scroll
    // 会伸出 .import-draft，把下面的文件行和右栏压出重影（用户反馈「拥挤的时候为
    // 什么会出现这个情况」）。880px 走窄屏上下排列，两栏曾被 flex 比例硬分高度，
    // 同样会被压扁，所以两种宽度都覆盖。
    await page.setViewportSize({ width, height: 620 });
    await page.goto("/projects");
    await page.getByTestId("import-project-document-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "直接粘贴文本" }).click();
    await dialog.getByLabel("导入文档内容").fill(document);
    await dialog.getByRole("button", { name: "内容梳理" }).click();
    await expect(dialog.getByTestId("document-import-draft")).toContainText(
      "模块 14",
    );

    // getByRole("dialog") 会同时命中 Ant 外壳与工作台两层，取工作台本体做量测。
    const metrics = await page.locator(".import-workbench").evaluate((root) => {
      const read = (selector: string) => {
        const element = root.querySelector(selector);
        return element === null
          ? null
          : element.getBoundingClientRect().toJSON();
      };
      return {
        draft: read(".import-draft"),
        scroll: read(".import-draft-scroll"),
        pane: read(".import-pane"),
        assist: read(".import-assist"),
        composer: read(".import-composer"),
      };
    });
    const label = "窗口 " + String(width) + "x620";
    expect(metrics.draft, label + " 应有草稿栏").not.toBeNull();
    expect(metrics.scroll, label + " 应有草稿滚动区").not.toBeNull();
    expect(metrics.assist, label + " 应有助手栏").not.toBeNull();
    expect(metrics.composer, label + " 应有输入行").not.toBeNull();

    // 滚动区留在草稿栏里：越界的那部分正是压在下一页脚与下一栏上的重影。
    expect(
      metrics.scroll!.bottom,
      label + " 草稿滚动区越出了草稿栏",
    ).toBeLessThanOrEqual(metrics.draft!.bottom + 1);
    // 右栏输入行留在助手栏里。
    expect(
      metrics.composer!.bottom,
      label + " 右栏输入行越出了助手栏",
    ).toBeLessThanOrEqual(metrics.assist!.bottom + 1);
  }

  await context.close();
});

test("F-32 成员字段按姓名筛账号：选完成一个标签、候选常驻（候选浮在导入弹窗之上）", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);

  const suffix = Date.now().toString(16).slice(-6).toUpperCase();
  const document = [
    `# 项目：成员建议 ${suffix}`,
    `- 项目编码：MEMBERS${suffix}`,
    // 写成员姓名（不是登录名）：目录里只有姓名，建议按姓名子串筛。
    `- 项目成员：${runtime.user.name}`,
    "",
    "## 模块：成员建议模块",
    "",
    "### 任务：成员建议任务",
    `- 负责人：${runtime.user.name}`,
  ].join("\n");

  await page.goto("/projects");
  await page.getByTestId("import-project-document-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "直接粘贴文本" }).click();
  await dialog.getByLabel("导入文档内容").fill(document);
  await dialog.getByRole("button", { name: "内容梳理" }).click();

  // 点「项目成员」的值变标签行：已写定的名字各是一个标签，末尾输入框只装正在输入的那一段。
  await dialog.getByRole("button", { name: "项目：项目成员" }).click();
  const editor = dialog.getByLabel("项目：项目成员");
  await expect(editor).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: `移除 ${runtime.user.name}` }),
  ).toBeVisible();

  // 弹层 portal 到 body，不在弹窗里查；能点到就说明它没被弹窗盖住，而且编辑期间一直挂着。
  const suggest = page.getByTestId("document-import-member-suggest");
  await expect(suggest).toBeVisible();

  // 打另一个成员名字里的一小段就出候选（本人已经是标签，不会再被建议）。
  const typed = runtime.member.name.slice(-4);
  await editor.pressSequentially(typed);
  await suggest.getByRole("button", { name: runtime.member.name }).click();

  // 点一条只多一个标签、输入框清空，候选列表照旧挂着：接着点就能加下一个人。
  await expect(editor).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: `移除 ${runtime.member.name}` }),
  ).toBeVisible();
  await expect(suggest).toBeVisible();

  await editor.press("Enter");
  await expect(dialog.getByLabel("导入文档内容")).toHaveValue(
    new RegExp(`- 项目成员：${runtime.user.name}、${runtime.member.name}`),
  );

  await context.close();
});

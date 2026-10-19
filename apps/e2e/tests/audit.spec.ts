import { expect } from "@playwright/test";

import {
  createAuthenticatedContext,
  loginAdminViaUi,
} from "../helpers/auth-context.js";
import { test } from "../helpers/admin-fixture.js";
import {
  calmSelectTrigger,
  pickCalmSelectOption,
} from "../helpers/calm-select.js";
import { createProjectViaUi } from "../helpers/project-create.js";
import { loadRuntime } from "../helpers/runtime.js";

test("普通成员不能访问审计页", async ({ browser }) => {
  test.setTimeout(60_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto("/audit");
    await expect(page.getByTestId("admin-forbidden")).toBeVisible();
    await expect(page.getByText("无权访问", { exact: true })).toBeVisible();
    await expect(
      page.getByText("此区域仅限系统管理员访问。", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("管理员读取项目审计链、按动作与操作人过滤、查看快照，且读取不留痕", async ({
  browser,
  admin,
}) => {
  test.setTimeout(240_000);
  const runtime = await loadRuntime();

  // 先由普通成员创建一个全新项目：其 PROJECT 链必定包含 project.create，
  // 作为过滤与快照断言的确定性锚点（读取已不写审计，不能再拿 AUDIT_LOG_READ 当锚点）。
  const creator = await createAuthenticatedContext(browser, runtime);
  const project = await createProjectViaUi(creator.page, runtime, "E2EAUDIT");
  await creator.context.close();

  const context = await browser.newContext({ baseURL: runtime.webBaseUrl });
  const page = await context.newPage();
  try {
    await loginAdminViaUi(page, runtime, admin);

    // ADR-031 之后高风险只读只要求完整管理员 Session，直接进入即可读取。
    // ADR-061 起默认链是「全部记录（所有链）」，首次加载即跨链读取。
    const firstLoad = page.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/audit-logs?") &&
        request.url().includes("chain=all"),
      { timeout: 30_000 },
    );
    await page.goto("/audit");
    await firstLoad;
    await expect(page.getByRole("heading", { name: "动态审计" })).toBeVisible();
    await expect(page.locator(".activity-scope-badge")).toContainText(
      "全部记录（所有链）",
    );

    // 默认跨链首屏（有行或空态）。
    const list = page.locator(".audit-list");
    const empty = page.getByText("没有匹配的审计记录", { exact: true });
    await expect(list.or(empty).first()).toBeVisible();

    // 读取不写审计（ADR-060）：页头说明已更新为不写审计，页面上不再有隐藏读取留痕
    // 的开关与提示。页头说明段落受设计系统 `.page-header > div > p { display: none }`
    // 隐藏，因此这里断言文本而不是可见性。
    await expect(page.locator(".activity-page-header")).toContainText(
      "读取不会在审计链留下记录",
    );
    await expect(page.getByLabel("隐藏读取留痕")).toHaveCount(0);
    await expect(page.getByText("显示读取留痕", { exact: true })).toHaveCount(
      0,
    );

    // 操作人不选即全体（2026-10-10 起占位文案改为「全员（可勾选多人）」）。
    await expect(
      page.getByText("全员（可勾选多人）", { exact: true }),
    ).toBeVisible();

    // 切到新建项目的 PROJECT 链：project.create 必定命中。
    // CalmSelect 的选项 title 形如「PROJECT:<id> · <项目名>」，编号从 title 里取。
    await calmSelectTrigger(page, "审计链").click();
    const projectOption = page
      .locator(".ant-select-dropdown:visible .ant-select-item-option")
      .filter({ hasText: project.name });
    await expect(projectOption).toHaveCount(1, { timeout: 30_000 });
    const chainTitle = await projectOption.getAttribute("title");
    const projectId = chainTitle?.match(/^PROJECT:(\d+) · /)?.[1] ?? null;
    if (projectId === null) {
      throw new Error("项目链选项缺少编号");
    }
    // 切回单链读取：请求带 projectId 且不再携带 chain=all（两者互斥）。
    const projectChainRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/audit-logs?") &&
        request.url().includes(`projectId=${projectId}`) &&
        !request.url().includes("chain=all"),
      { timeout: 30_000 },
    );
    await projectOption.click();
    await projectChainRequest;
    await expect(page.locator(".activity-scope-badge")).toContainText(
      project.name,
    );

    // 动作码候选是自绘 listbox（2026-10-19 修复原生 datalist 与输入框不对齐）：
    // 面板外边缘必须与 .audit-action-search 外边框重合，且支持过滤与点选原始码。
    const actionInput = page.getByRole("combobox", { name: "动作码" });
    await actionInput.click();
    const actionPanel = page.getByRole("listbox", { name: "动作码候选" });
    await expect(actionPanel).toBeVisible();
    const actionBox = await page.locator(".audit-action-search").boundingBox();
    const panelBox = await actionPanel.boundingBox();
    if (actionBox === null || panelBox === null) {
      throw new Error("动作码候选面板缺少布局盒");
    }
    expect(Math.abs(panelBox.x - actionBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.width - actionBox.width)).toBeLessThanOrEqual(1);

    await actionInput.fill("project.cr");
    await expect(actionPanel.getByRole("option")).toHaveCount(1);
    await actionPanel.getByRole("option").click();
    await expect(actionInput).toHaveValue("project.create");
    await expect(actionPanel).toHaveCount(0);

    // 选中创建者作为操作人：动作码与 actorIds 必须同时进入请求。
    await pickCalmSelectOption(page, "操作人", runtime.user.name);
    const filteredRequest = page.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/audit-logs?") &&
        request.url().includes(`projectId=${projectId}`) &&
        request.url().includes("action=project.create") &&
        request.url().includes(`actorIds=${runtime.userId}`),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "查询" }).click();
    await filteredRequest;

    const createRow = page
      .locator(".audit-row")
      .filter({ hasText: "创建项目" })
      .first();
    await expect(createRow).toBeVisible();
    await expect(createRow).toContainText(project.name);
    await expect(createRow).toContainText(runtime.user.name);
    await expect(
      createRow.getByText("用户操作", { exact: true }),
    ).toBeVisible();

    // 行内原始快照：项目链、动作与事件载荷（项目编码）可见。
    await createRow.getByRole("button", { name: /查看原始快照/ }).click();
    const snapshot = page.getByRole("dialog", { name: "原始审计快照" });
    await expect(snapshot).toBeVisible();
    await expect(page.getByTestId("audit-snapshot")).toContainText(
      "project.create",
    );
    await expect(page.getByTestId("audit-snapshot")).toContainText("项目链");
    await expect(page.getByTestId("audit-snapshot-payload")).toContainText(
      project.code,
    );
    await page.keyboard.press("Escape");
    await expect(snapshot).toBeHidden();

    await page.getByRole("button", { name: "重置" }).click();
    await expect(page.getByRole("combobox", { name: "动作码" })).toHaveValue(
      "",
    );
    // 重置回到「全员」：操作人多选清空。
    await expect(
      page.getByText("全员（可勾选多人）", { exact: true }),
    ).toBeVisible();

    await page.screenshot({
      path: "test-results/f08-audit-e2e.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

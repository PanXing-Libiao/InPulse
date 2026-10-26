import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";

test("captures the migrated command palette, notification popover and activity pages", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const output = path.join(process.env.TEMP ?? ".", "inpulse-visual");
  mkdirSync(output, { recursive: true });

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "项目列表" })).toBeVisible();
  await page.screenshot({ path: path.join(output, "01-projects.png") });

  const suffix = Date.now().toString(16).slice(-8).toUpperCase();
  const code = `VIS${suffix}`;
  const name = `视觉迁移项目 ${code}`;
  await page.getByTestId("create-project-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("项目名称").fill(name);
  await dialog.getByLabel("项目编码").fill(code.toLowerCase());
  await dialog.getByLabel("项目描述").fill("用于迁移后的活动页视觉检查。");
  await dialog.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText("项目创建成功", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "打开全局搜索" }).click();
  const palette = page.getByRole("dialog", { name: "全局搜索" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("全局搜索关键词").fill(code);
  await expect(palette.getByText(/已找到/)).toBeVisible();
  await page.screenshot({ path: path.join(output, "02-command-palette.png") });
  await page.keyboard.press("Escape");

  // 通知铃铛已收敛到侧栏底部工具条，exact 名称固定匹配该按钮。
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "通知中心" })).toBeVisible();
  await page.screenshot({
    path: path.join(output, "03-notification-popover.png"),
  });
  await page
    .getByRole("button", { name: `打开通知：已加入项目 ${name}` })
    .click();

  await expect(page.getByRole("heading", { name: "项目动态" })).toBeVisible();
  await expect(page.getByText(/创建了项目/)).toBeVisible();
  await page.screenshot({ path: path.join(output, "04-project-activity.png") });

  // 侧栏项目目录改为下拉浮层（2026-10-23 用户指示）：项目再多也只占浮层内部，
  // 不允许把「交付记录 / 全局」等固定入口顶下去。
  await page.locator(".nav-project-menu > .nav-item").click();
  await expect(page.locator(".project-menu-panel")).toBeVisible();
  // 展开区在文档流内限高滚动；下方所有固定入口必须仍然可见。
  const sidebarNav = page.getByRole("navigation", { name: "工作区导航" });
  for (const name of [
    "任务中心",
    "迭代记录",
    "遗留问题",
    "项目动态",
    "成员与设置",
  ]) {
    await expect(
      sidebarNav.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  }
  const treeLayout = await page.evaluate(() => {
    const panel = document.querySelector(".project-menu-panel");
    if (panel === null) {
      throw new Error("侧栏项目下拉未渲染");
    }
    const rect = panel.getBoundingClientRect();
    return {
      position: getComputedStyle(panel).position,
      overflowY: getComputedStyle(panel).overflowY,
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      bottom: Math.round(rect.bottom),
      rows: document.querySelectorAll(
        ".project-tree-scroll > .tree-project > .tree-row",
      ).length,
      treeCodes: document.querySelectorAll(".tree-code").length,
    };
  });
  expect(treeLayout.position).toBe("static");
  expect(treeLayout.overflowY).toBe("auto");
  expect(treeLayout.height).toBeLessThanOrEqual(281);
  expect(treeLayout.bottom).toBeLessThan(treeLayout.viewportHeight);
  expect(treeLayout.rows).toBeGreaterThan(1);
  // 项目行右侧的编码小字已删除。
  expect(treeLayout.treeCodes).toBe(0);

  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "项目动态" })).toBeVisible();
  await page.getByLabel("搜索动态").fill(code);
  await expect(page.getByTestId(/^activity-item-/)).toBeVisible();
  await page.screenshot({ path: path.join(output, "05-activity-index.png") });

  await context.close();
});

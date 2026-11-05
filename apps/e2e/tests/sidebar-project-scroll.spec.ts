import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";

test("侧栏项目抽屉使用单滚动条且项目与模块不跳转", async ({ browser }) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "项目列表" })).toBeVisible();

    await page.locator(".nav-project-menu > .nav-item").click();
    const panel = page.locator(".project-menu-panel");
    await expect(panel).toBeVisible();
    await panel
      .locator(".project-node")
      .filter({ hasText: runtime.projectName })
      .click();
    await expect(page).toHaveURL(
      new RegExp("/projects/" + String(runtime.projectId) + "/modules$"),
    );

    await panel.getByRole("button", { name: "任务看板", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp("/projects/" + String(runtime.projectId) + "/task-board$"),
    );
    await expect(page.getByRole("heading", { name: /任务看板/ })).toBeVisible();
    await expect(panel).toBeVisible();

    const modulesRow = panel.getByRole("button", {
      name: "项目与模块",
      exact: true,
    });
    await expect(modulesRow).toBeVisible();
    const modulesPanel = panel.locator(".tree-modules").first();
    await expect(modulesPanel).toHaveAttribute("data-open", "true");

    const urlBefore = page.url();
    await modulesRow.click();
    await expect(modulesPanel).toHaveAttribute("data-open", "false");
    await expect(page).toHaveURL(urlBefore);
    await modulesRow.click();
    await expect(modulesPanel).toHaveAttribute("data-open", "true");
    await expect(page).toHaveURL(urlBefore);
    await expect(panel.locator(".module-node").first()).toBeVisible();

    await panel.evaluate(async (outer) => {
      await Promise.all(
        outer
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });

    const layout = await panel.evaluate((outer) => {
      const content = outer.querySelector<HTMLElement>(".tree-modules-content");
      if (!content) {
        throw new Error("模块列表内容未渲染");
      }
      const contentStyle = getComputedStyle(content);
      return {
        contentBorderStyle: contentStyle.borderTopStyle,
        contentBorderWidth: contentStyle.borderTopWidth,
        contentMaxHeight: contentStyle.maxHeight,
        contentOverflowY: contentStyle.overflowY,
        outerOverflowY: getComputedStyle(outer).overflowY,
        rightInset:
          outer.getBoundingClientRect().right -
          content.getBoundingClientRect().right,
      };
    });
    expect(layout.outerOverflowY).toBe("auto");
    expect(layout.contentOverflowY).not.toBe("auto");
    expect(layout.contentOverflowY).not.toBe("scroll");
    expect(layout.contentMaxHeight).toBe("none");
    expect(layout.rightInset).toBeGreaterThanOrEqual(10);
    expect(layout.contentBorderStyle).not.toBe("none");
    expect(Number.parseFloat(layout.contentBorderWidth)).toBeGreaterThan(0);

    const horizontalOverflow = await panel.evaluate((outer) => {
      const moduleName = outer.querySelector(".module-node .tree-label strong");
      const content = outer.querySelector(".tree-modules-content");
      if (!moduleName || !content) {
        throw new Error("侧栏模块名称未渲染");
      }
      moduleName.textContent = "应用组件【角色与权限】超长名称回归";
      return {
        clientWidth: outer.clientWidth,
        scrollWidth: outer.scrollWidth,
        contentRight: content.getBoundingClientRect().right,
        panelRight: outer.getBoundingClientRect().right,
      };
    });
    expect(horizontalOverflow.scrollWidth).toBeLessThanOrEqual(
      horizontalOverflow.clientWidth + 1,
    );
    expect(horizontalOverflow.contentRight).toBeLessThanOrEqual(
      horizontalOverflow.panelRight + 1,
    );

    const overflow = await panel.evaluate((outer) => {
      const content = outer.querySelector<HTMLElement>(".tree-modules-content");
      const moduleRow = content?.querySelector<HTMLElement>(".module-node");
      if (!content || !moduleRow) {
        throw new Error("侧栏模块列表未渲染");
      }
      for (let index = 0; index < 10; index += 1) {
        content.append(moduleRow.cloneNode(true));
      }
      outer.scrollTop = 0;
      return {
        contentScrollTop: content.scrollTop,
        outerScrollable: outer.scrollHeight - outer.clientHeight,
      };
    });
    expect(overflow.outerScrollable).toBeGreaterThan(0);
    expect(overflow.contentScrollTop).toBe(0);

    const content = panel.locator(".tree-modules-content");
    const box = await content.boundingBox();
    if (box === null) {
      throw new Error("模块列表内容不可见");
    }
    await page.mouse.move(box.x + Math.min(box.width / 2, 100), box.y + 30);
    await page.mouse.wheel(0, 240);

    await expect
      .poll(() => panel.evaluate((outer) => outer.scrollTop))
      .toBeGreaterThan(0);
    expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
  } finally {
    await context.close();
  }
});

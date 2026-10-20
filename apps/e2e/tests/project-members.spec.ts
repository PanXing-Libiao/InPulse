import { expect } from "@playwright/test";
import { test } from "../helpers/admin-fixture.js";

import {
  createAuthenticatedContext,
  loginAdminViaUi,
} from "../helpers/auth-context.js";
import { pickCalmSelectOptions } from "../helpers/calm-select.js";
import { loadRuntime } from "../helpers/runtime.js";
import { createProjectViaUi } from "../helpers/project-create.js";

test("普通成员可查看并管理本项目成员，不能读取其他项目", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    await page.goto(`/projects/${runtime.projectId}/members`);
    // 只读视图复用管理员页的视觉语言：h1 为项目名，成员渲染为
    // .calm-member-card 卡片；不再提供旧的 `.project-members` 列表结构。
    // 用 testid 锚定成员卡片：同一页的项目企微群卡片也带 .settings-panel，
    // 类名选择器会撞上两个元素（2026-10-16 实测 strict mode violation）。
    const members = page.getByTestId("project-members-panel");
    await expect(
      page.getByRole("heading", { name: runtime.projectName, level: 1 }),
    ).toBeVisible();
    await expect(members).toBeVisible();
    await expect(
      members
        .locator(".calm-member-card")
        .filter({ hasText: runtime.user.name }),
    ).toHaveCount(1);
    await expect(
      members.getByRole("button", { name: "添加成员" }),
    ).toBeVisible();
    // ADR-053：项目创建者就是组长，组长不能被直接移除或撤销，需先把其他成员
    // 设为组长完成转移；因此自己的卡片上没有「移除」入口，也没有角色按钮。
    await expect(
      members
        .locator(".calm-member-card")
        .filter({ hasText: runtime.user.name }),
    ).toContainText("组长");
    await expect(
      members
        .locator(".calm-member-card")
        .filter({ hasText: runtime.user.name })
        .getByRole("button", { name: /移\s*除/ }),
    ).toHaveCount(0);
    await expect(
      members
        .locator(".calm-member-card")
        .filter({ hasText: runtime.user.name })
        .getByRole("button", { name: "转移组长" }),
    ).toHaveCount(0);

    const forbidden = page.waitForResponse((response) =>
      response
        .url()
        .endsWith(`/api/v1/projects/${runtime.hiddenProjectId}/active-members`),
    );
    await page.goto(`/projects/${runtime.hiddenProjectId}/members`);
    expect((await forbidden).status()).toBe(404);
    await expect(
      page.getByText("项目或成员不存在，或你已无权访问。", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".calm-member-card")).toHaveCount(0);
    await expect(
      page.getByText(runtime.member.name, { exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("管理员完成成员添加与移除，并校验不存在项目的读取边界", async ({
  browser,
  admin,
}) => {
  test.setTimeout(180_000);
  const runtime = await loadRuntime();
  const context = await browser.newContext({ baseURL: runtime.webBaseUrl });
  const page = await context.newPage();
  const memberCard = page
    .locator(".calm-member-card")
    .filter({ hasText: runtime.member.name })
    .last();

  try {
    await loginAdminViaUi(page, runtime, admin);
    await page.goto(`/projects/${runtime.projectId}/members`);
    await expect(
      page.getByRole("heading", { name: runtime.projectName, exact: true }),
    ).toBeVisible();

    await expect(page.getByRole("heading", { name: "项目成员" })).toBeVisible();
    await expect(
      page.locator(".calm-member-card").filter({ hasText: runtime.user.name }),
    ).toHaveCount(1);

    await page.getByRole("button", { name: "添加成员" }).click();
    const addDialog = page.getByRole("dialog", { name: "添加项目成员" });
    // 搜索框是真实 <input>：宿主表单会给它加边框、内边距与聚焦光环，触发器里因此
    // 会多出一个「空输入小方框」。真实浏览器里锁定它已被复位。
    const triggerInput = addDialog
      .locator(".calm-select-multiple .ant-select-input")
      .first();
    await expect(triggerInput).toHaveCount(1);
    await expect(triggerInput).toHaveCSS("border-top-width", "0px");
    await expect(triggerInput).toHaveCSS("padding-left", "0px");
    await expect(triggerInput).toHaveCSS("box-shadow", "none");
    await pickCalmSelectOptions(addDialog, "选择要添加的用户", [
      runtime.member.name,
    ]);
    await addDialog.getByRole("button", { name: "添加成员" }).click();
    await expect(
      page.getByText("已添加 1 位项目成员，项目成员列表已更新。"),
    ).toBeVisible();
    await expect(
      memberCard.getByText("活跃成员", { exact: true }),
    ).toBeVisible();

    await memberCard.getByRole("button", { name: /移\s*除/ }).click();
    const removeDialog = page.getByRole("dialog", { name: "移除项目成员" });
    await expect(
      removeDialog.getByText(`确认从项目中移除 ${runtime.member.name}？`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      removeDialog.getByText("该成员没有未完成任务。", { exact: true }),
    ).toBeVisible();
    await removeDialog.getByRole("button", { name: "确认移除" }).click();
    await expect(
      page.getByText(
        "成员已移出项目，未改派任务保留原负责人且该成员已失去处理权限。",
      ),
    ).toBeVisible();
    // 2026-09-23：列表只展示活跃成员，移除后该成员卡片立即从列表消失。
    await expect(
      page
        .locator(".calm-member-card")
        .filter({ hasText: runtime.member.name }),
    ).toHaveCount(0);
    await expect(page.getByText("已移除", { exact: true })).toHaveCount(0);

    await page.goto("/projects/999999999/members");
    await expect(
      page.getByText("项目成员加载失败", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("项目或成员不存在，或你已无权访问。", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("项目组长本人可把组长身份转交给其他成员（ADR-053）", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  try {
    const created = await createProjectViaUi(page, runtime, "LEAD");
    await page.getByTestId("open-created-project-activity").click();
    await expect(page).toHaveURL(/\/projects\/\d+\/activity/);
    const projectId = Number(
      page.url().match(/\/projects\/(\d+)\/activity/)?.[1],
    );
    expect(Number.isSafeInteger(projectId)).toBe(true);

    await page.goto(`/projects/${projectId}/members`);
    await expect(
      page.getByRole("heading", { name: created.name, level: 1 }),
    ).toBeVisible();
    const ownCard = page
      .locator(".calm-member-card")
      .filter({ hasText: runtime.user.name });
    const targetCard = page
      .locator(".calm-member-card")
      .filter({ hasText: runtime.member.name });
    await expect(ownCard).toContainText("组长");
    await expect(ownCard.getByRole("button", { name: /移\s*除/ })).toHaveCount(
      0,
    );
    // 组长不能给自己改角色，只能在其他成员卡片上看到「转移组长」。
    await expect(ownCard.getByRole("button", { name: "转移组长" })).toHaveCount(
      0,
    );

    await targetCard.getByRole("button", { name: "转移组长" }).click();
    const dialog = page.getByRole("dialog", { name: "确认转移组长" });
    // 组长没有撤销组长的入口：弹窗只确认转移，不再提供角色选项。
    await expect(
      dialog.getByText(
        `将组长身份转交给 ${runtime.member.name}（仅在本项目生效）`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认转移" }).click();
    await expect(
      page.getByText(
        `已将组长身份转交给 ${runtime.member.name}，你已成为普通成员。`,
        { exact: true },
      ),
    ).toBeVisible();

    // 转移生效：接手人成为组长且不可移除，原组长降级为普通成员。
    await expect(targetCard).toContainText("组长");
    await expect(
      targetCard.getByRole("button", { name: /移\s*除/ }),
    ).toHaveCount(0);
    await expect(ownCard).not.toContainText("组长");
    await expect(ownCard.getByRole("button", { name: "转移组长" })).toHaveCount(
      0,
    );
  } finally {
    await context.close();
  }
});

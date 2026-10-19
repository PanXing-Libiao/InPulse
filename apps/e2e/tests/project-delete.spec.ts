import { expect } from "@playwright/test";

import { test } from "../helpers/admin-fixture.js";
import {
  createAuthenticatedContext,
  loginAdminViaUi,
  loginViaUi,
} from "../helpers/auth-context.js";
import { createProjectViaUi } from "../helpers/project-create.js";
import { loadRuntime } from "../helpers/runtime.js";

/**
 * ADR-062 / ADR-085：项目删除是物理删除且不可撤销，但项目历史审计链保留。
 *
 * 确认弹窗必须把级联范围讲清楚（下级业务数据清除、编码可复用、项目审计链保留、
 * 系统审计链另留一条供管理员追溯），删除后项目从列表与刷新后的接口里都消失。
 */
const DELETE_WARNING =
  "删除不可撤销，会物理删除该项目下的全部模块、功能、任务、迭代记录、GitHub 链接、通知与项目动态，项目编码将可以被重新使用；该项目的历史审计链会保留，仅供系统管理员在审计日志中查看。";

test("普通成员在编辑项目弹窗里看不到删除入口", async ({ browser }) => {
  test.setTimeout(180_000);
  const runtime = await loadRuntime();

  const leader = await createAuthenticatedContext(browser, runtime);
  const project = await createProjectViaUi(leader.page, runtime, "E2EDELM");
  await leader.context.close();

  const memberContext = await browser.newContext({
    baseURL: runtime.webBaseUrl,
  });
  const page = await memberContext.newPage();
  try {
    // 创建项目时把 runtime.member 加为项目成员（角色 MEMBER）。
    await loginViaUi(page, runtime, runtime.member);
    await page.goto("/projects");
    const card = page
      .locator(".project-card")
      .filter({ hasText: project.name });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "编辑" }).click();

    const editor = page.getByRole("dialog", { name: "编辑项目" });
    await expect(editor).toBeVisible();
    // 与服务端 projectDeleterRole 同口径：只有系统管理员与本项目组长能看到入口。
    await expect(editor.getByTestId("delete-project-button")).toHaveCount(0);
    await expect(page.getByText("确认删除项目", { exact: true })).toHaveCount(
      0,
    );

    await editor.getByRole("button", { name: "取消" }).click();
    await expect(editor).toBeHidden();
  } finally {
    await memberContext.close();
  }
});

test("组长删除项目后列表不再出现，管理员在审计日志看到「删除项目」留痕", async ({
  browser,
  admin,
}) => {
  test.setTimeout(300_000);
  const runtime = await loadRuntime();

  const leader = await createAuthenticatedContext(browser, runtime);
  const project = await createProjectViaUi(leader.page, runtime, "E2EDEL");
  const page = leader.page;

  await page.goto("/projects");
  const card = page.locator(".project-card").filter({ hasText: project.name });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "编辑" }).click();

  const editor = page.getByRole("dialog", { name: "编辑项目" });
  await expect(editor).toBeVisible();
  await editor.getByTestId("delete-project-button").click();

  // 二次确认：必须先讲清级联范围，再允许执行。
  const confirm = page.getByRole("dialog", { name: "确认删除项目" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`确认删除项目「${project.name}」？`);
  await expect(confirm).toContainText(DELETE_WARNING);

  await confirm.getByTestId("confirm-delete-project").click();
  await expect(confirm).toBeHidden();
  await expect(editor).toBeHidden();
  await expect(page.getByTestId("project-management-success")).toContainText(
    `项目「${project.name}」已删除，其业务数据已清除`,
  );
  await expect(card).toHaveCount(0);

  // 刷新后仍然不存在：删除已经落库，不是前端缓存假象。
  await page.reload();
  await expect(page.getByRole("heading", { name: "项目列表" })).toBeVisible();
  await expect(
    page.locator(".project-card").filter({ hasText: project.name }),
  ).toHaveCount(0);

  await leader.context.close();

  const adminContext = await browser.newContext({
    baseURL: runtime.webBaseUrl,
  });
  const auditPage = await adminContext.newPage();
  try {
    await loginAdminViaUi(auditPage, runtime, admin);
    await auditPage.goto("/audit");
    await expect(
      auditPage.getByRole("heading", { name: "动态审计" }),
    ).toBeVisible();

    // 按动作码过滤「删除项目」，请求必须带上该过滤条件。
    await auditPage
      .getByRole("combobox", { name: "动作码" })
      .fill("project.delete");
    const filteredRequest = auditPage.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/audit-logs?") &&
        request.url().includes("action=project.delete"),
      { timeout: 30_000 },
    );
    await auditPage.getByRole("button", { name: "查询" }).click();
    await filteredRequest;

    const row = auditPage
      .locator(".audit-row")
      .filter({ hasText: project.code })
      .first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("删除项目");
    await expect(row).toContainText(runtime.user.name);
    await expect(row.getByText("用户操作", { exact: true })).toBeVisible();
    // SYSTEM 链上另有一条删除留痕；项目自己的审计链仍按 ADR-085 保留。
    await expect(row).toContainText("系统链");

    await row.getByRole("button", { name: /查看原始快照/ }).click();
    const snapshot = auditPage.getByRole("dialog", { name: "原始审计快照" });
    await expect(snapshot).toBeVisible();
    await expect(auditPage.getByTestId("audit-snapshot")).toContainText(
      "project.delete",
    );
    // 快照里的链名用 `chainLabelOf`，SYSTEM 链显示为「SYSTEM 链」。
    await expect(auditPage.getByTestId("audit-snapshot")).toContainText(
      "SYSTEM 链",
    );
    const payload = auditPage.getByTestId("audit-snapshot-payload");
    await expect(payload).toContainText(project.code);
    await expect(payload).toContainText(project.name);
    await expect(payload).toContainText("actorRole");
    await auditPage.keyboard.press("Escape");
    await expect(snapshot).toBeHidden();

    // ADR-085：项目行删除后，原项目链必须仍能在审计页读到，不能只剩 SYSTEM
    // 链的 project.delete。按 project.create 过滤可稳定命中删除前的历史。
    await auditPage
      .getByRole("combobox", { name: "动作码" })
      .fill("project.create");
    const retainedRequest = auditPage.waitForRequest(
      (request) =>
        request.url().includes("/api/v1/audit-logs?") &&
        request.url().includes("action=project.create"),
      { timeout: 30_000 },
    );
    await auditPage.getByRole("button", { name: "查询" }).click();
    await retainedRequest;

    const retainedRow = auditPage
      .locator(".audit-row")
      .filter({ hasText: project.code })
      .first();
    await expect(retainedRow).toBeVisible();
    await expect(retainedRow).toContainText("创建项目");
    await expect(retainedRow).toContainText(project.name);
    await expect(retainedRow).toContainText("项目 #");
    await retainedRow.getByRole("button", { name: /查看原始快照/ }).click();
    const retainedSnapshot = auditPage.getByRole("dialog", {
      name: "原始审计快照",
    });
    await expect(retainedSnapshot).toBeVisible();
    await expect(auditPage.getByTestId("audit-snapshot")).toContainText(
      "project.create",
    );
    await expect(auditPage.getByTestId("audit-snapshot")).toContainText(
      "PROJECT:",
    );
  } finally {
    await adminContext.close();
  }
});

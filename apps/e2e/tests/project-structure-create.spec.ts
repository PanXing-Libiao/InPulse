import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { createAuthenticatedContext } from "../helpers/auth-context.js";
import { loadRuntime } from "../helpers/runtime.js";

function uniqueCode(prefix: string): string {
  return (
    prefix +
    Date.now().toString(16).slice(-8).toUpperCase() +
    randomBytes(2).toString("hex").toUpperCase()
  );
}

test("新建项目一次创建多个模块与任务，并在模块页可见", async ({ browser }) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const code = uniqueCode("STRUCT");
  const name = "结构创建 " + code;

  await page.goto("/projects");
  await page.getByTestId("create-project-button").click();

  const projectDialog = page.getByRole("dialog", { name: "新建项目" });
  await projectDialog.getByLabel("项目名称").fill(name);
  await projectDialog.getByLabel("项目编码").fill(code.toLowerCase());
  await projectDialog
    .getByLabel("项目描述")
    .fill("验证一次创建模块与任务，并保留返回后的编辑内容。");

  const projectBox = await projectDialog.boundingBox();
  expect(projectBox).not.toBeNull();
  // 高度按第一层内容收敛，不再回到旧的 860px 大留白。
  expect(projectBox!.height).toBeLessThan(760);

  await projectDialog.getByRole("button", { name: /添加模块/ }).click();
  const structureDialog = page.getByRole("dialog", {
    name: "添加模块与任务",
  });
  const structureBox = await structureDialog.boundingBox();
  expect(structureBox).not.toBeNull();
  expect(Math.abs(structureBox!.height - projectBox!.height)).toBeLessThan(1);

  await structureDialog.getByLabel("模块 1 名称").fill("扫码巡检");
  await structureDialog
    .getByLabel("模块 1 说明")
    .fill("扫码、异常上报与现场拍照");

  await structureDialog.getByRole("button", { name: /新建任务/ }).click();
  await structureDialog.getByLabel("任务 1 标题").fill("完成扫码入口");
  await structureDialog
    .getByLabel("任务 1 负责人")
    .selectOption({ label: runtime.user.name });
  await structureDialog.getByLabel("任务 1 优先级").selectOption("URGENT");
  await structureDialog.getByLabel("任务 1 截止日期").fill("2026-12-31");
  await structureDialog
    .getByLabel("任务 1 详情")
    .fill("验收：首次扫码后可以看到最近记录。");

  await structureDialog.getByRole("button", { name: /新建任务/ }).click();
  await structureDialog.getByLabel("任务 2 标题").fill("异常上报");
  await structureDialog
    .getByLabel("任务 2 负责人")
    .selectOption({ label: runtime.user.name });

  await structureDialog.getByRole("button", { name: /添加模块/ }).click();
  await structureDialog.getByLabel("模块 2 名称").fill("权限配置");
  const moduleTwoCard = structureDialog.locator(".project-module-card").nth(1);
  await moduleTwoCard.getByRole("button", { name: /新建任务/ }).click();
  await structureDialog.getByLabel("任务 3 标题").fill("整理角色矩阵");
  await structureDialog
    .getByLabel("任务 3 负责人")
    .selectOption({ label: runtime.user.name });
  await structureDialog.getByLabel("任务 3 优先级").selectOption("HIGH");

  await structureDialog.getByRole("button", { name: /返回项目信息/ }).click();
  await expect(page.getByRole("dialog", { name: "新建项目" })).toBeVisible();
  await expect(projectDialog.getByLabel("项目名称")).toHaveValue(name);
  await expect(projectDialog.getByLabel("项目描述")).toHaveValue(
    "验证一次创建模块与任务，并保留返回后的编辑内容。",
  );
  await projectDialog
    .getByLabel("项目描述")
    .fill("返回后修改描述，再直接提交结构。");

  await projectDialog.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText("项目创建成功", { exact: true })).toBeVisible();

  await page.getByTestId("open-created-project-activity").click();
  await expect(page.getByRole("heading", { name: "项目动态" })).toBeVisible();
  const match = new URL(page.url()).pathname.match(/\/projects\/(\d+)/);
  const projectId = Number(match === null ? NaN : match[1]);
  expect(Number.isInteger(projectId)).toBe(true);

  await page.goto("/projects/" + projectId + "/modules");
  await expect(
    page.getByRole("heading", { name: "扫码巡检", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "权限配置", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText(/2 项待办/)).toBeVisible();
  await expect(page.getByText(/1 项待办/)).toBeVisible();

  await page.getByRole("heading", { name: "扫码巡检", level: 2 }).click();
  await expect(
    page.getByRole("heading", { name: "扫码巡检", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "完成扫码入口" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "异常上报" })).toBeVisible();
  await expect(page.getByText(runtime.user.name).first()).toBeVisible();

  await page.getByRole("button", { name: "返回模块列表" }).click();
  await page.getByRole("heading", { name: "权限配置", level: 2 }).click();
  await expect(
    page.getByRole("heading", { name: "整理角色矩阵" }),
  ).toBeVisible();

  await context.close();
});

test("结构页必填校验阻止创建，项目字段错误会退回第一层", async ({
  browser,
}) => {
  const runtime = await loadRuntime();
  const { context, page } = await createAuthenticatedContext(browser, runtime);
  const code = uniqueCode("VALID");

  await page.goto("/projects");
  await page.getByTestId("create-project-button").click();
  const projectDialog = page.getByRole("dialog", { name: "新建项目" });
  await projectDialog.getByLabel("项目名称").fill("校验 " + code);
  await projectDialog.getByLabel("项目编码").fill(code.toLowerCase());

  await projectDialog.getByRole("button", { name: /添加模块/ }).click();
  const structureDialog = page.getByRole("dialog", {
    name: "添加模块与任务",
  });

  await structureDialog.getByRole("button", { name: "创建项目" }).click();
  await expect(structureDialog.getByText("请填写模块名称")).toBeVisible();

  await structureDialog.getByLabel("模块 1 名称").fill("校验模块");
  await structureDialog.getByRole("button", { name: /新建任务/ }).click();
  await structureDialog.getByRole("button", { name: "创建项目" }).click();
  await expect(structureDialog.getByText("请填写任务标题")).toBeVisible();

  await structureDialog.getByLabel("任务 1 标题").fill("校验任务");
  await structureDialog.getByRole("button", { name: "创建项目" }).click();
  await expect(structureDialog.getByText("请选择负责人")).toBeVisible();
  await structureDialog
    .getByLabel("任务 1 负责人")
    .selectOption({ label: runtime.user.name });

  await structureDialog.getByRole("button", { name: /返回项目信息/ }).click();
  await projectDialog.getByLabel("项目名称").fill("");
  await projectDialog.getByRole("button", { name: /添加模块/ }).click();
  await structureDialog.getByLabel("模块 2 名称").fill("校验模块二");
  await structureDialog.getByRole("button", { name: "创建项目" }).click();

  await expect(page.getByRole("dialog", { name: "新建项目" })).toBeVisible();
  await expect(projectDialog.getByText("请输入项目名称")).toBeVisible();

  await projectDialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog", { name: "新建项目" })).toBeHidden();

  await context.close();
});

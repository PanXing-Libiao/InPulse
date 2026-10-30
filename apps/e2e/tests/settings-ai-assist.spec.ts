import { expect } from "@playwright/test";
import postgres from "postgres";

import { test } from "../helpers/admin-fixture.js";
import {
  createAuthenticatedContext,
  loginAdminViaUi,
} from "../helpers/auth-context.js";
import { buildDocxFixture } from "../helpers/office-fixtures.js";
import { loadRuntime, requiredE2eDatabaseUrl } from "../helpers/runtime.js";

/** 假密钥与尾号在运行时拼接，避免 check:secrets 把字面量赋值判为 Secret 泄露。 */
const SAVED_API_KEY = ["e2e", "live", "key", "e2e9"].join("-");
const SAVED_KEY_HINT = "e2e9";
const STUB_MODEL = "e2e-stub-model";

/** 清掉在线配置行，让 API 回到环境变量模式（其它 spec 依赖该模式）。 */
async function clearOnlineConfig(): Promise<void> {
  const sql = postgres(requiredE2eDatabaseUrl(), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await sql`DELETE FROM app.ai_assist_settings`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe.serial("ADR-068 管理员在线配置", () => {
  test.beforeAll(async () => {
    await clearOnlineConfig();
  });

  test.afterAll(async () => {
    await clearOnlineConfig();
  });

  test("管理员保存配置并测试连接，状态切换为数据库来源", async ({
    browser,
    admin,
  }) => {
    test.setTimeout(120_000);
    const runtime = await loadRuntime();
    const context = await browser.newContext({ baseURL: runtime.webBaseUrl });
    const page = await context.newPage();
    try {
      await loginAdminViaUi(page, runtime, admin);
      await page.goto("/settings?tab=aiAssist");
      const panel = page.getByRole("region", { name: "AI 辅助转换" });
      await expect(panel).toBeVisible();
      await expect(
        panel.getByText("来源：环境变量（遗留模式；保存一次后即转为在线配置）"),
      ).toBeVisible();

      // 端点由环境变量预填；模型先留空，验证首次配置无需保存即可发现模型。
      const endpoint = await panel.getByLabel("服务端点").inputValue();
      expect(endpoint.length).toBeGreaterThan(0);
      await panel.getByLabel("模型").fill("");
      await panel.getByLabel("API 密钥").fill(SAVED_API_KEY);
      await panel.getByRole("button", { name: "获取可用模型" }).click();
      await expect(
        panel.getByText(
          "已获取 2 个可用模型：" + STUB_MODEL + "、" + STUB_MODEL + "-alt",
        ),
      ).toBeVisible();

      // 选择刚发现的模型后再保存；密钥仍只在本次请求中传输，不会回显。
      await panel.getByLabel("模型").fill(STUB_MODEL);
      await panel.getByRole("button", { name: "保存配置" }).click();

      await expect(panel.getByText("AI 辅助转换配置已保存")).toBeVisible();
      await expect(panel.getByText("已启用，可发起转换")).toBeVisible();
      await expect(
        panel.getByText("来源：在线配置（数据库，优先于环境变量）"),
      ).toBeVisible();
      await expect(
        panel.getByText("密钥已配置（尾号 ****" + SAVED_KEY_HINT + "）"),
      ).toBeVisible();
      // 密钥永不回显：保存成功后输入框清空。
      await expect(panel.getByLabel("API 密钥")).toHaveValue("");

      await panel.getByRole("button", { name: "测试连接" }).click();
      await expect(
        panel.getByText("连接成功，上游模型：" + STUB_MODEL),
      ).toBeVisible();

      await panel.getByRole("button", { name: "获取可用模型" }).click();
      await expect(
        panel.getByText(
          "已获取 2 个可用模型：" + STUB_MODEL + "、" + STUB_MODEL + "-alt",
        ),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // 串行依赖上一条用例保存的数据库配置：主开关拨动即落库，刷新后状态保持。
  test("主开关拨动即保存：刷新后仍为关闭，随后恢复启用供后续用例使用", async ({
    browser,
    admin,
  }) => {
    const runtime = await loadRuntime();
    const context = await browser.newContext({ baseURL: runtime.webBaseUrl });
    const page = await context.newPage();
    try {
      await loginAdminViaUi(page, runtime, admin);
      await page.goto("/settings?tab=aiAssist");
      const panel = page.getByRole("region", { name: "AI 辅助转换" });
      const toggle = panel.getByRole("switch", { name: "启用 AI 辅助转换" });
      await expect(toggle).toBeChecked();

      // 不点「保存配置」，开关自己落库。
      await toggle.click();
      await expect(panel.getByText("已保存：AI 辅助转换已关闭")).toBeVisible();

      await page.reload();
      await expect(
        panel.getByRole("switch", { name: "启用 AI 辅助转换" }),
      ).not.toBeChecked();
      await expect(panel.getByText("当前未启用")).toBeVisible();

      await panel.getByRole("switch", { name: "启用 AI 辅助转换" }).click();
      await expect(panel.getByText("已保存：AI 辅助转换已启用")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // 串行依赖上一条用例保存的数据库配置：在线配置对普通成员同样生效。
  test("在线配置生效：成员文档导入经数据库配置完成转换", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const runtime = await loadRuntime();
    const { context, page } = await createAuthenticatedContext(
      browser,
      runtime,
    );
    try {
      const marker = `AIE2E-${Date.now().toString(36).toUpperCase()}`;
      const docx = buildDocxFixture([
        "需求文档（在线配置 E2E）",
        `模块标记 ${marker}`,
        `任务负责人：${runtime.user.loginName}`,
      ]);

      await page.goto(`/projects/${String(runtime.projectId)}/modules`);
      await page.getByTestId("import-project-document-button").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("选择文档进行分析").setInputFiles({
        name: "在线配置.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: docx,
      });

      // 数据库密钥若无法解密，服务端 fail closed，这里必然取不到 stub 草稿。
      await expect(dialog.getByTestId("document-import-draft")).toContainText(
        `AI 导入模块 ${marker}`,
      );
      // 「预览文档」只读对照本地抽出的原文，不含 AI 改写。
      await dialog.getByRole("button", { name: "预览文档" }).click();
      await expect(dialog.getByLabel("导入文档内容")).toHaveValue(
        /需求文档（在线配置 E2E）/,
      );

      await dialog.getByTestId("document-import-preview").click();
      await expect(dialog.getByTestId("document-import-summary")).toBeVisible();
      await dialog.getByTestId("document-import-apply").click();
      await expect(page.getByText(/文档导入完成/)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

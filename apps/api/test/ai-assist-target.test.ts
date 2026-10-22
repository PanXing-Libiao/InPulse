import { describe, expect, it } from "vitest";

import {
  validateAiAssistTarget,
  type AiAssistTarget,
} from "../src/modules/document-import/ai-assist-target.js";
import { parseDocumentTemplate } from "../src/modules/document-import/document-template.parser.js";

const MODULE_TARGET: AiAssistTarget = {
  kind: "MODULE",
  projectId: 2,
  moduleId: 7,
  moduleName: "支付",
};

const FEATURE_TARGET: AiAssistTarget = {
  kind: "FEATURE",
  projectId: 2,
  moduleId: 7,
  moduleName: "支付",
  featureId: 8,
  featureName: "退款回调",
};

function errorsOf(markdown: string, target: AiAssistTarget) {
  return validateAiAssistTarget(parseDocumentTemplate(markdown), target).filter(
    (issue) => issue.severity === "ERROR",
  );
}

describe("ADR-094 AI assist target validation", () => {
  it("accepts a module-scoped draft with new features and module tasks", () => {
    const markdown = [
      "## 模块：支付",
      "- 说明：支付与退款",
      "### 功能：退款回调",
      "#### 任务：补超时重试",
      "- 优先级：高",
      "### 任务：梳理支付告警",
      "- 优先级：普通",
    ].join("\n");
    expect(errorsOf(markdown, MODULE_TARGET)).toEqual([]);
  });

  it("rejects a mismatched or extra module", () => {
    expect(
      errorsOf("## 模块：订单\n- 说明：订单", MODULE_TARGET)[0],
    ).toMatchObject({ code: "AI_ASSIST_TARGET_MODULE_MISMATCH" });
    expect(
      errorsOf(
        "## 模块：支付\n- 说明：支付\n## 模块：订单\n- 说明：订单",
        MODULE_TARGET,
      )[0],
    ).toMatchObject({ code: "AI_ASSIST_TARGET_MODULE_EXTRA" });
  });

  it("rejects a project section at project root", () => {
    expect(
      errorsOf("# 项目：商城\n- 项目编码：MALL\n## 模块：支付", {
        kind: "PROJECT_ROOT",
        projectId: 2,
      })[0],
    ).toMatchObject({ code: "AI_ASSIST_TARGET_PROJECT_SECTION" });
  });

  it("accepts only tasks under the exact target feature", () => {
    const markdown = [
      "## 模块：支付",
      "### 功能：退款回调",
      "#### 任务：补超时重试",
      "- 优先级：高",
    ].join("\n");
    expect(errorsOf(markdown, FEATURE_TARGET)).toEqual([]);
  });

  it("rejects a mismatched feature, module task and extra feature", () => {
    expect(
      errorsOf(
        "## 模块：支付\n### 功能：支付查询\n#### 任务：查询",
        FEATURE_TARGET,
      )[0],
    ).toMatchObject({ code: "AI_ASSIST_TARGET_FEATURE_MISMATCH" });

    expect(
      errorsOf(
        "## 模块：支付\n### 任务：模块级任务\n### 功能：退款回调",
        FEATURE_TARGET,
      )[0],
    ).toMatchObject({ code: "AI_ASSIST_TARGET_MODULE_TASK" });

    expect(
      errorsOf(
        "## 模块：支付\n### 功能：退款回调\n### 功能：支付查询",
        FEATURE_TARGET,
      )[0],
    ).toMatchObject({ code: "AI_ASSIST_TARGET_FEATURE_EXTRA" });
  });
});

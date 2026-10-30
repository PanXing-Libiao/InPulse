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

function errorsOf(markdown: string, target: AiAssistTarget) {
  return validateAiAssistTarget(parseDocumentTemplate(markdown), target).filter(
    (issue) => issue.severity === "ERROR",
  );
}

describe("ADR-094 AI assist target validation", () => {
  it("accepts a module-scoped draft with direct tasks", () => {
    const markdown = [
      "## 模块：支付",
      "- 说明：支付与退款",
      "### 任务：补超时重试",
      "- 优先级：高",
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
});

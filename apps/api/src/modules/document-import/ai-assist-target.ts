import type { DocumentImportIssue } from "@inpulse/api-contract";

import {
  normalizeDocumentName,
  type ParsedDocument,
} from "./document-template.parser.js";

/**
 * ADR-094 / ADR-109：AI 辅助转换的已解析目标。名称来自服务端数据库，
 * 不是用户输入；只用于 system 提示词与生成后的确定性范围校验。
 */
export type AiAssistTarget =
  | {
      readonly kind: "PROJECT_ROOT";
      readonly projectId: number;
    }
  | {
      readonly kind: "MODULE";
      readonly projectId: number;
      readonly moduleId: number;
      readonly moduleName: string;
    };

const TARGET_PROJECT_SECTION = "AI_ASSIST_TARGET_PROJECT_SECTION";
const TARGET_MODULE_MISSING = "AI_ASSIST_TARGET_MODULE_MISSING";
const TARGET_MODULE_MISMATCH = "AI_ASSIST_TARGET_MODULE_MISMATCH";
const TARGET_MODULE_EXTRA = "AI_ASSIST_TARGET_MODULE_EXTRA";

function issue(
  line: number,
  code: string,
  message: string,
): DocumentImportIssue {
  return {
    severity: "ERROR",
    line: Math.min(Math.max(1, line), 1_000_000),
    code,
    message,
  };
}

function matches(name: string, targetName: string): boolean {
  return normalizeDocumentName(name) === normalizeDocumentName(targetName);
}

/**
 * 只检查生成结果是否越出 UI 目标；不修改模型输出。问题以 ERROR 返回，
 * 用户仍可在左栏修正后重新预览，服务端不会静默改写草稿。
 */
export function validateAiAssistTarget(
  parsed: ParsedDocument,
  target: AiAssistTarget,
): readonly DocumentImportIssue[] {
  if (target.kind === "PROJECT_ROOT") {
    return parsed.project === null
      ? []
      : [
          issue(
            parsed.project.line,
            TARGET_PROJECT_SECTION,
            "本次目标是项目根级，草稿不得包含「# 项目」段。",
          ),
        ];
  }

  const issues: DocumentImportIssue[] = [];
  if (parsed.project !== null) {
    issues.push(
      issue(
        parsed.project.line,
        TARGET_PROJECT_SECTION,
        "目标模式不接受项目段；草稿应从「## 模块：」开始。",
      ),
    );
  }

  if (parsed.modules.length === 0) {
    issues.push(
      issue(
        1,
        TARGET_MODULE_MISSING,
        "AI 草稿没有生成指定模块「" + target.moduleName + "」。",
      ),
    );
    return issues;
  }

  const matchedModules = parsed.modules.filter((module) =>
    matches(module.name, target.moduleName),
  );
  if (matchedModules.length === 0) {
    issues.push(
      issue(
        parsed.modules[0]?.line ?? 1,
        TARGET_MODULE_MISMATCH,
        "AI 草稿的模块「" +
          (parsed.modules[0]?.name ?? "") +
          "」不是指定目标「" +
          target.moduleName +
          "」。",
      ),
    );
    return issues;
  }
  if (parsed.modules.length > 1) {
    const extra = parsed.modules.find(
      (module) => !matches(module.name, target.moduleName),
    );
    issues.push(
      issue(
        extra?.line ?? parsed.modules[1]?.line ?? 1,
        TARGET_MODULE_EXTRA,
        "指定模块模式下只能出现模块「" +
          target.moduleName +
          "」，草稿还包含其他模块。",
      ),
    );
  }
  return issues;
}

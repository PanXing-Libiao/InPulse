import type { DocumentImportIssue } from "@inpulse/api-contract";

import {
  normalizeDocumentName,
  type ParsedDocument,
} from "./document-template.parser.js";

/**
 * ADR-094：AI 辅助转换的已解析目标。名称来自服务端数据库，不是用户输入；
 * 只用于 system 提示词与生成后的确定性范围校验。
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
    }
  | {
      readonly kind: "FEATURE";
      readonly projectId: number;
      readonly moduleId: number;
      readonly moduleName: string;
      readonly featureId: number;
      readonly featureName: string;
    };

const TARGET_PROJECT_SECTION = "AI_ASSIST_TARGET_PROJECT_SECTION";
const TARGET_MODULE_MISSING = "AI_ASSIST_TARGET_MODULE_MISSING";
const TARGET_MODULE_MISMATCH = "AI_ASSIST_TARGET_MODULE_MISMATCH";
const TARGET_MODULE_EXTRA = "AI_ASSIST_TARGET_MODULE_EXTRA";
const TARGET_FEATURE_MISSING = "AI_ASSIST_TARGET_FEATURE_MISSING";
const TARGET_FEATURE_MISMATCH = "AI_ASSIST_TARGET_FEATURE_MISMATCH";
const TARGET_FEATURE_EXTRA = "AI_ASSIST_TARGET_FEATURE_EXTRA";
const TARGET_MODULE_TASK = "AI_ASSIST_TARGET_MODULE_TASK";

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
    return issues;
  }

  if (target.kind === "MODULE") {
    return issues;
  }

  const module = matchedModules[0]!;
  if (module.tasks.length > 0) {
    issues.push(
      issue(
        module.tasks[0]?.line ?? module.line,
        TARGET_MODULE_TASK,
        "指定功能模式下不能在模块下直接创建任务；任务必须写在功能「" +
          target.featureName +
          "」的「#### 任务」下。",
      ),
    );
  }

  if (module.features.length === 0) {
    issues.push(
      issue(
        module.line,
        TARGET_FEATURE_MISSING,
        "AI 草稿没有生成指定功能「" + target.featureName + "」。",
      ),
    );
    return issues;
  }

  const matchedFeatures = module.features.filter((feature) =>
    matches(feature.name, target.featureName),
  );
  if (matchedFeatures.length === 0) {
    issues.push(
      issue(
        module.features[0]?.line ?? module.line,
        TARGET_FEATURE_MISMATCH,
        "AI 草稿的功能「" +
          (module.features[0]?.name ?? "") +
          "」不是指定目标「" +
          target.featureName +
          "」。",
      ),
    );
    return issues;
  }
  if (module.features.length > 1) {
    const extra = module.features.find(
      (feature) => !matches(feature.name, target.featureName),
    );
    issues.push(
      issue(
        extra?.line ?? module.features[1]?.line ?? module.line,
        TARGET_FEATURE_EXTRA,
        "指定功能模式下只能出现功能「" +
          target.featureName +
          "」，草稿还包含其他功能。",
      ),
    );
  }
  return issues;
}

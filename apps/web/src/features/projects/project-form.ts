import { z } from "zod";
import type { CreateProjectRequest } from "@generated/api";

export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_CODE_MAX_LENGTH = 32;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 20_000;
export const PROJECT_CARD_SHORTNAME_LENGTH = 3;
export const PROJECT_WECOM_WEBHOOK_LABEL_MAX_LENGTH = 80;
export const PROJECT_WECOM_WEBHOOK_URL_MAX_LENGTH = 2048;

const PROJECT_WECOM_WEBHOOK_ORIGIN = "https://qyapi.weixin.qq.com";
const PROJECT_WECOM_WEBHOOK_PATH = "/cgi-bin/webhook/send";
const PROJECT_WECOM_WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const projectCodePattern = /^[A-Z][A-Z0-9_]{1,31}$/;

export const projectFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入项目名称")
    .max(
      PROJECT_NAME_MAX_LENGTH,
      `项目名称不能超过 ${PROJECT_NAME_MAX_LENGTH} 个字符`,
    ),
  code: z
    .string()
    .trim()
    .min(2, "项目编码至少需要 2 个字符")
    .max(
      PROJECT_CODE_MAX_LENGTH,
      `项目编码不能超过 ${PROJECT_CODE_MAX_LENGTH} 个字符`,
    )
    .regex(
      projectCodePattern,
      "项目编码需为 2-32 位大写字母、数字或下划线，且以字母开头",
    ),
  description: z
    .string()
    .trim()
    .max(
      PROJECT_DESCRIPTION_MAX_LENGTH,
      `项目描述不能超过 ${PROJECT_DESCRIPTION_MAX_LENGTH} 个字符`,
    ),
});

export type ProjectFormValues = z.infer<typeof projectFormSchema>;

/** 项目编辑只允许整笔替换名称与描述；编码创建后不可修改。 */
export const projectEditFormSchema = projectFormSchema.pick({
  name: true,
  description: true,
});

export type ProjectEditFormValues = z.infer<typeof projectEditFormSchema>;

export function validateProjectWecomWebhookUrl(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0) return "请粘贴企业微信群机器人 Webhook 地址";
  if (raw.length > PROJECT_WECOM_WEBHOOK_URL_MAX_LENGTH) {
    return `Webhook 地址不能超过 ${PROJECT_WECOM_WEBHOOK_URL_MAX_LENGTH} 个字符`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Webhook 地址格式不正确，请重新复制";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== PROJECT_WECOM_WEBHOOK_ORIGIN ||
    parsed.pathname !== PROJECT_WECOM_WEBHOOK_PATH ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    return "请使用企业微信官方群机器人 Webhook 地址";
  }
  const keys = parsed.searchParams.getAll("key");
  if (keys.length !== 1 || parsed.searchParams.size !== 1) {
    return "Webhook 地址只能包含一个 key 参数";
  }
  if (!PROJECT_WECOM_WEBHOOK_KEY_PATTERN.test(keys[0] ?? "")) {
    return "Webhook key 格式不正确，请重新复制";
  }
  return null;
}

export function normalizeProjectCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * 从名称自动推导项目编码：只取其中的英文与数字，中文、空格与符号作为分隔丢弃。
 * 推导结果不满足编码规则时返回空串，避免自动写入无法提交的值，改由用户手填。
 */
export function deriveProjectCodeFromName(name: string): string {
  const candidate = name
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, PROJECT_CODE_MAX_LENGTH);
  return projectCodePattern.test(candidate) ? candidate : "";
}

export function deriveProjectCardShortname(code: string): string {
  const normalized = normalizeProjectCode(code);
  return normalized.slice(0, PROJECT_CARD_SHORTNAME_LENGTH) || "—";
}

export function toCreateProjectRequest(
  values: ProjectFormValues,
  selectedMemberIds: readonly number[] = [],
): CreateProjectRequest {
  return {
    name: values.name,
    code: values.code,
    description: values.description,
    memberIds: Array.from(
      new Set(
        selectedMemberIds.filter(
          (memberId) => Number.isSafeInteger(memberId) && memberId > 0,
        ),
      ),
    ).sort((left, right) => left - right),
  };
}

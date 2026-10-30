import type { ExternalLinkTargetType } from "@inpulse/api-contract";
import { ACTIVITY_SUMMARY_MAX_LENGTH } from "../activity/index.js";
import { githubLinkLabel } from "./github-link-label.js";

const TARGET_LABELS: Readonly<Record<ExternalLinkTargetType, string>> = {
  PROJECT: "项目",
  TASK: "任务",
  CHANGE_RECORD: "迭代记录",
};

/**
 * 2026-10-09 用户反馈：`添加 GitHub 关联` / `解除 GitHub 关联` 只说动作，
 * 读不出关联的是哪个对象。摘要因此写明链接标签与目标身份，例如
 * `添加 GitHub 关联：PR #245（任务 LIINK-T-90「登录企业微信」）`。
 * 仍不写 URL 与正文（沿用 F22 脱敏口径）；前端 activitySubject 会剥离
 * 「动作：」前缀，把余下部分作为动态描述展示。
 */
export function externalLinkActivitySummary(input: {
  readonly adding: boolean;
  readonly url: string;
  readonly targetType: ExternalLinkTargetType;
  readonly target: { readonly code: string | null; readonly title: string };
}): string {
  const prefix = input.adding ? "添加 GitHub 关联：" : "解除 GitHub 关联：";
  const label = githubLinkLabel(input.url).label;
  const identity =
    input.target.code === null
      ? TARGET_LABELS[input.targetType]
      : `${TARGET_LABELS[input.targetType]} ${input.target.code}`;
  const head = `${prefix}${label}（${identity}「`;
  const tail = "」）";
  const room = ACTIVITY_SUMMARY_MAX_LENGTH - head.length - tail.length;
  const title =
    input.target.title.length > room
      ? input.target.title.slice(0, Math.max(0, room - 1)) + "…"
      : input.target.title;
  return `${head}${title}${tail}`;
}

/**
 * 链接事件是否写项目动态。ADR-048：未发布草稿不产生活动、也不出现在项目动态，
 * 草稿上的链接操作只留审计，避免把草稿标题带进全员可见的动态流。
 */
export function externalLinkActivityApplies(
  targetType: ExternalLinkTargetType,
  status: string,
): boolean {
  return !(targetType === "CHANGE_RECORD" && status === "DRAFT");
}

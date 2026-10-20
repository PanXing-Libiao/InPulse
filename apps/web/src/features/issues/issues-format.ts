import type { LeftoverListItem } from "@generated/api";
import { formatBeijingDate } from "@features/common/beijing-time";

/** 遗留问题页展示口径：日期按北京时间日历日，不直接暴露 ISO 时间串。 */
export function formatIssueDate(value: string): string {
  return formatBeijingDate(value);
}

/** 来源行拆分结果：项目名与其余部分分开渲染，便于在行首放项目标识。 */
export interface IssueOriginParts {
  readonly projectName: string;
  readonly detail: string;
}

/**
 * 来源行：`项目名 · 记录「记录标题」 · 模块 / 功能 · 作者 · 日期`。
 *
 * 2026-10-10 用户指示：项目名从行中间提到行首单独成段，行首接项目标识，
 * 同一项目的卡片靠标识成组；项目名与记录之间改用 ` · `，
 * 模块 / 功能继续用 ` / ` 表示父子层级。
 */
export function issueOriginParts(item: LeftoverListItem): IssueOriginParts {
  const scope = [
    item.moduleName,
    ...(item.featureName === null ? [] : [item.featureName]),
  ].join(" / ");
  return {
    projectName: item.projectName,
    detail:
      "记录「" +
      item.recordTitle +
      "」 · " +
      scope +
      " · " +
      item.author.name +
      " · " +
      formatIssueDate(item.publishedAt),
  };
}

/** 已处理 = 已转为跟进任务（CONVERTED）或已标记解决（RESOLVED）。 */
export function isLeftoverClosed(item: LeftoverListItem): boolean {
  return item.status !== "ACTIVE";
}

/** 遗留问题对外状态文案：父记录作废时由 API 派生为 VOIDED。 */
export function leftoverStatusText(status: LeftoverListItem["status"]): string {
  if (status === "ACTIVE") return "未处理";
  if (status === "VOIDED") return "已作废";
  return "已处理";
}

/** 徽章色调：未处理用琥珀色，已处理用绿色，已作废用灰色。 */
export function leftoverStatusTone(
  status: LeftoverListItem["status"],
): "amber" | "green" | "gray" {
  if (status === "ACTIVE") return "amber";
  return status === "VOIDED" ? "gray" : "green";
}

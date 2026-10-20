import {
  isProjectNotificationCategory,
  notificationTypesByProjectCategory,
} from "@inpulse/api-contract";

export class InvalidMutedProjectCategoriesError extends Error {
  constructor() {
    super("mutedProjectCategories is invalid");
    this.name = "InvalidMutedProjectCategoriesError";
  }
}

/**
 * 把契约中的 projectId:category 对展开成 projectId|notificationType 规则，
 * 供通知列表与未读数 SQL 使用。该参数只是当前用户的只读视图筛选。
 */
export function notificationMuteRules(
  raw: string | undefined,
): readonly string[] {
  if (raw === undefined) return [];
  const rules = new Set<string>();
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf(":");
    if (separator <= 0 || separator === pair.length - 1) {
      throw new InvalidMutedProjectCategoriesError();
    }
    const projectIdText = pair.slice(0, separator);
    if (!/^[1-9][0-9]*$/.test(projectIdText)) {
      throw new InvalidMutedProjectCategoriesError();
    }
    const projectId = Number(projectIdText);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new InvalidMutedProjectCategoriesError();
    }
    const category = pair.slice(separator + 1);
    if (!isProjectNotificationCategory(category)) {
      throw new InvalidMutedProjectCategoriesError();
    }
    for (const notificationType of notificationTypesByProjectCategory[
      category
    ]) {
      rules.add(projectId + "|" + notificationType);
    }
  }
  return Array.from(rules);
}

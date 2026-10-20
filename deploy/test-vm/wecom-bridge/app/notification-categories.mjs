// ADR-090：项目群通知类别映射。桥接只做确定性分类，不把用户输入当 SQL 或命令。
// 未识别的未来通知 / 动态默认放行，保持「全部 MEMBER 可见动态」的旧口径，
// 避免新增事件因为忘记登记映射而静默丢失。
export const GROUP_NOTIFICATION_CATEGORIES = [
  "task.assign",
  "task.status",
  "record",
  "project.member",
  "scope.delete",
];

const FLAG_BY_CATEGORY = {
  "task.assign": "taskAssignEnabled",
  "task.status": "taskStatusEnabled",
  record: "recordEnabled",
  "project.member": "projectMemberEnabled",
  "scope.delete": "scopeDeleteEnabled",
};

const NOTIFICATION_TYPE_CATEGORY = new Map([
  ["task.assigned", "task.assign"],
  ["task_assigned", "task.assign"],
  ["leftover.convert", "record"],
  ["task.complete", "task.status"],
  ["task.reopen", "task.status"],
  ["task.cancel", "task.status"],
  ["task.restore", "task.status"],
  ["task.merge", "task.status"],
  ["task.unmerge", "task.status"],
  ["record.publish", "record"],
  ["record.version.create", "record"],
  ["record.leftover.add", "record"],
  ["change_record_voided", "record"],
  ["change_record_restored", "record"],
  ["project_created", "project.member"],
  ["project_joined", "project.member"],
  ["project.status.change", "project.member"],
  ["project_status_changed", "project.member"],
]);

const ACTIVITY_TYPE_CATEGORY = new Map([
  ["task.create", "task.assign"],
  ["task.update", "task.assign"],
  ["task.complete", "task.status"],
  ["task.reopen", "task.status"],
  ["task.cancel", "task.status"],
  ["task.restore", "task.status"],
  ["task.merge", "task.status"],
  ["task.unmerge", "task.status"],
  ["leftover.convert", "record"],
  ["record.publish", "record"],
  ["record.version.create", "record"],
  ["record.leftover.add", "record"],
  ["change_record_voided", "record"],
  ["change_record_restored", "record"],
  ["project_created", "project.member"],
  ["project_updated", "project.member"],
  ["project_status_changed", "project.member"],
  ["project_member_added", "project.member"],
  ["project_member_removed", "project.member"],
  ["project_member_role_changed", "project.member"],
  ["external_link_added", "project.member"],
  ["external_link_removed", "project.member"],
  ["module.create", "project.member"],
  ["module.update", "project.member"],
  ["feature.create", "project.member"],
  ["feature.update", "project.member"],
  ["task.delete", "scope.delete"],
  ["task_deleted", "scope.delete"],
  ["module.delete", "scope.delete"],
  ["module_deleted", "scope.delete"],
  ["feature.delete", "scope.delete"],
  ["feature_deleted", "scope.delete"],
]);

const ENTITY_CATEGORY = new Map([
  ["TASK", "task.assign"],
  ["TASK_GROUP", "task.status"],
  ["CHANGE_RECORD", "record"],
  ["LEFTOVER_ITEM", "record"],
  ["PROJECT", "project.member"],
  ["MODULE", "project.member"],
  ["FEATURE", "project.member"],
  ["EXTERNAL_LINK", "project.member"],
]);

function normalize(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
}

/** 通知表类型 -> 项目群类别；未知类型返回 null（默认放行）。 */
export function groupCategoryForNotification(notificationType) {
  return NOTIFICATION_TYPE_CATEGORY.get(normalize(notificationType)) ?? null;
}

/** 动态类型优先精确匹配，再按来源实体兜底；未知动态返回 null（默认放行）。 */
export function groupCategoryForActivity(activityType, sourceEntityType) {
  const byType = ACTIVITY_TYPE_CATEGORY.get(normalize(activityType));
  if (byType !== undefined) return byType;
  return ENTITY_CATEGORY.get(String(sourceEntityType ?? "").trim()) ?? null;
}

/** 数据库缺行 -> undefined，调用方按五类全开处理。 */
export function flagsFromRow(row) {
  if (row === null || row === undefined) return undefined;
  return {
    taskAssignEnabled: row.task_assign_enabled !== false,
    taskStatusEnabled: row.task_status_enabled !== false,
    recordEnabled: row.record_enabled !== false,
    projectMemberEnabled: row.project_member_enabled !== false,
    scopeDeleteEnabled: row.scope_delete_enabled !== false,
  };
}

/** 未知类别或没有偏好行时放行；显式 FALSE 才拦截。 */
export function groupCategoryIsEnabled(category, flags) {
  if (category === null || category === undefined) return true;
  if (flags === null || flags === undefined) return true;
  const flag = FLAG_BY_CATEGORY[category];
  return flag === undefined ? true : flags[flag] !== false;
}

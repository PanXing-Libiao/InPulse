// ADR-090 / ADR-093：项目群通知类别映射。
// ADR-093 起群消息只消费 MEMBER 可见的项目动态，不再从 app.notifications 复制；
// 未知动态仍默认放行，但不按来源实体猜测类别，避免未知任务事件被误归为任务派发。
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
  ["project_wrapped", "project.member"],
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

function normalize(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
}

/**
 * 项目动态 -> 群投递处置。
 * - task.update 只有 metadata.assignmentChanged === true 才属于任务派发；
 *   普通标题、描述、优先级等编辑返回 skip，不进入群发送队列；
 * - 已知动态按五类映射；未识别动态返回 category = null 且不跳过，保持默认放行；
 * - 不再按 sourceEntityType 兜底，避免未来 TASK 动态被错误归入 task.assign。
 */
export function groupActivityDisposition(activityType, metadata) {
  const type = normalize(activityType);
  if (
    type === "task.update" &&
    !(
      metadata !== null &&
      typeof metadata === "object" &&
      metadata.assignmentChanged === true
    )
  ) {
    return { category: null, skip: true };
  }
  return {
    category: ACTIVITY_TYPE_CATEGORY.get(type) ?? null,
    skip: false,
  };
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

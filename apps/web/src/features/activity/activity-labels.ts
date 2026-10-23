import type { ActivityItem } from "@generated/api";
import type { ActivityCategory } from "./activity-query";

/**
 * 项目动态的分类筛选项，取值与设计师稿 `activity.tsx` 的 chip 行一致。
 * 服务端 `sourceEntityType` 比这八项更细（另有任务组与遗留问题），
 * 它们分别归入「任务」与「迭代记录」，与设计师稿的语义保持一致。
 */
export const ACTIVITY_CHIPS = [
  "全部",
  "任务",
  "迭代记录",
  "功能",
  "模块",
  "项目",
  "成员",
  "GitHub",
] as const;

export type ActivityChip = (typeof ACTIVITY_CHIPS)[number];

const ENTITY_LABELS: Readonly<Record<string, string>> = {
  PROJECT: "项目",
  MODULE: "模块",
  FEATURE: "功能",
  TASK: "任务",
  TASK_GROUP: "任务组",
  CHANGE_RECORD: "迭代记录",
  EXTERNAL_LINK: "GitHub",
  LEFTOVER_ITEM: "遗留问题",
};

/**
 * 服务端 `activityType` 的中文动作标签。
 * 后端存在两种命名风格：项目与迭代记录生命周期用 UPPER_SNAKE
 * （`PROJECT_CREATED`、`CHANGE_RECORD_VOIDED`），
 * 模块 / 功能 / 任务 / 记录草稿用 dot.case（`task.create`、`record.publish`）。
 * 未收录的取值按原样显示，便于在界面上直接发现新的后端事件。
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  PROJECT_CREATED: "创建项目",
  PROJECT_UPDATED: "更新项目",
  PROJECT_STATUS_CHANGED: "变更项目状态",
  PROJECT_WRAPPED: "项目封箱",
  // ADR-062：删除项目改为物理删除、同一事务只写系统审计链，不再写项目动态；
  // 该文案只用于渲染历史动态与历史通知。
  PROJECT_DELETED: "删除项目",
  // ADR-043：项目归档已下线，以下四条只用于展示历史动态与历史通知。
  PROJECT_ARCHIVED: "归档项目",
  PROJECT_RESTORED: "恢复项目",
  PROJECT_MEMBER_ADDED: "添加成员",
  PROJECT_MEMBER_REMOVED: "移除成员",
  PROJECT_MEMBER_ROLE_CHANGED: "变更成员角色",
  "module.create": "创建模块",
  "module.update": "更新模块",
  // ADR-096：删除模块与删除功能动态（与审计 `module.delete` / `feature.delete` 同一动作）。
  MODULE_DELETED: "删除模块",
  "module.archive": "归档模块",
  "module.restore": "恢复模块",
  "feature.create": "创建功能",
  "feature.update": "更新功能",
  FEATURE_DELETED: "删除功能",
  "feature.archive": "归档功能",
  "feature.restore": "恢复功能",
  "task.create": "创建任务",
  "task.update": "更新任务",
  "task.complete": "完成任务",
  "task.reopen": "重新打开任务",
  "task.cancel": "取消任务",
  "task.restore": "恢复任务",
  "task.archive": "归档任务",
  "task.unarchive": "恢复任务",
  TASK_ARCHIVED: "归档任务",
  TASK_RESTORED: "恢复任务",
  // ADR-096：删除任务动态（与审计 `task.delete` 同一动作）。
  TASK_DELETED: "删除任务",
  "task.merge": "合并任务",
  "task.unmerge": "解除合并",
  "record.publish": "发布记录",
  "record.version.create": "修订记录",
  "record.draft.create": "创建草稿",
  "record.draft.update": "更新草稿",
  "record.leftover.add": "追加遗留问题",
  "leftover.convert": "遗留问题转任务",
  PROJECT_ARCHIVE_REQUESTED: "申请归档项目",
  PROJECT_ARCHIVE_REJECTED: "驳回归档申请",
  CHANGE_RECORD_VOIDED: "作废记录",
  CHANGE_RECORD_RESTORED: "恢复记录",
  EXTERNAL_LINK_ADDED: "添加 GitHub 关联",
  EXTERNAL_LINK_REMOVED: "解除 GitHub 关联",
  // 早期演示数据里的历史取值
  PROJECT_JOINED: "加入项目",
  TASK_COMPLETED: "完成任务",
  TASK_ASSIGNED: "指派任务",
};

export function activityActionLabel(activityType: string): string {
  return ACTION_LABELS[activityType] ?? activityType;
}

export function activityEntityLabel(sourceEntityType: string): string {
  return ENTITY_LABELS[sourceEntityType] ?? sourceEntityType;
}

/**
 * chip 到服务端分类的映射。分类过滤由服务端 SQL 完成
 * （`ACTIVITY_CATEGORY_SQL`），这里的取值必须与契约 `ACTIVITY_CATEGORIES`
 * 一一对应，否则界面会筛出空列表；改映射时必须同时改两处。
 */
export const ACTIVITY_CHIP_CATEGORY: Readonly<
  Record<ActivityChip, ActivityCategory>
> = {
  全部: "all",
  任务: "task",
  迭代记录: "record",
  功能: "feature",
  模块: "module",
  项目: "project",
  成员: "member",
  GitHub: "github",
};

const SUBJECT_PREFIX_MAX_LENGTH = 16;

/**
 * 服务端摘要统一是「动作：对象标题」（`任务完成：F-01 用户登录与会话管理 交付`）。
 * 设计师稿把动作与对象分成两行，这里只取冒号后的对象标题；
 * 摘要不含前缀时原样返回，避免截断历史数据。
 */
export function activitySubject(summary: string): string {
  const index = summary.indexOf("：");
  if (index <= 0 || index > SUBJECT_PREFIX_MAX_LENGTH) {
    return summary;
  }
  return summary.slice(index + 1).trim() || summary;
}

/** 服务端摘要内嵌的项目内角色枚举；取值与成员页 `roleLabel` 保持一致。 */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  MEMBER: "成员",
  LEADER: "组长",
};

/**
 * 动态行的描述文本。成员类动态的服务端摘要把角色写成枚举
 * （`将用户 X 的项目角色设置为 LEADER`），而动态投影是落库快照，
 * 历史行不会再被改写，因此在这里按值替换成中文；其余类型仍只做
 * 「动作：对象」的前缀剥离。
 */
export function activityDescription(item: ActivityItem): string {
  const subject = activitySubject(item.summary);
  if (!item.activityType.startsWith("PROJECT_MEMBER")) {
    return subject;
  }
  return subject.replace(
    /\b(MEMBER|LEADER)\b/g,
    (token) => ROLE_LABELS[token] ?? token,
  );
}

export interface ActivityTargetOptions {
  readonly isAdmin: boolean;
}

/**
 * 「查看对象」的落点。活动投影只有对象类型与对象 ID，没有模块 / 功能归属，
 * 所以任务与模块只能落到项目级列表；迭代记录与遗留问题走记录页的 `recordId` 定位；
 * 成员变更只有管理员能打开成员管理页。
 */
export function activityTargetPath(
  item: ActivityItem,
  options: ActivityTargetOptions,
): string {
  const projectId = item.projectId;
  if (item.activityType.startsWith("PROJECT_MEMBER")) {
    return options.isAdmin
      ? `/projects/${projectId}/members`
      : `/projects/${projectId}/modules`;
  }
  switch (item.sourceEntityType) {
    case "CHANGE_RECORD":
      return `/records?recordId=${item.sourceEntityId}`;
    case "LEFTOVER_ITEM":
      return "/records";
    case "MODULE":
    case "FEATURE":
      return `/projects/${projectId}/modules`;
    case "TASK":
    case "TASK_GROUP":
      return `/tasks?project=${projectId}`;
    default:
      return `/projects/${projectId}/modules`;
  }
}

export function activityTargetLabel(item: ActivityItem): string {
  return `${activityEntityLabel(item.sourceEntityType)} #${item.sourceEntityId}`;
}

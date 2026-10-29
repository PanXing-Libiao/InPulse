/**
 * 成员与设置页的权限矩阵文案。授权真相源仍是 docs/permissions.md 与
 * packages/api-contract；本文件只决定展示顺序与中文说明。
 *
 * ADR-104：11 个项目成员能力由系统管理员按三档统一配置；
 * 查看、个人设置、个人通知与企业微信绑定固定开放；
 * 作废/恢复迭代记录与系统管理审计固定仅系统管理员。
 */

import type {
  ProjectMemberPermissionLevel,
  ProjectMemberPermissionsUpdateRequest,
} from "@generated/api";
import type { PersonalNotificationSetting } from "@shared/notifications/personal-notification-settings";

export type ConfigurablePermissionKey =
  keyof ProjectMemberPermissionsUpdateRequest;

export interface PermissionMatrixRow {
  readonly key: string;
  readonly feature: string;
  readonly capability?: ConfigurablePermissionKey | undefined;
  readonly fixedAccess?: "ALL_MEMBERS" | "ADMINS_ONLY" | undefined;
  readonly note: string;
}

export const projectMemberPermissionCapabilities = [
  "projectEdit",
  "projectMemberManage",
  "projectLeaderTransfer",
  "projectDelete",
  "projectDocumentImport",
  "moduleFeatureEdit",
  "moduleFeatureDelete",
  "taskEdit",
  "taskLifecycle",
  "recordWrite",
  "projectWecomGroup",
] as const satisfies readonly ConfigurablePermissionKey[];

const configurablePermissionSet = new Set<ConfigurablePermissionKey>(
  projectMemberPermissionCapabilities,
);

export function isConfigurablePermissionKey(
  value: string,
): value is ConfigurablePermissionKey {
  return configurablePermissionSet.has(value as ConfigurablePermissionKey);
}

export const projectMemberPermissionLevelLabels: Readonly<
  Record<ProjectMemberPermissionLevel, string>
> = {
  ALL_MEMBERS: "全部成员",
  LEADERS_ONLY: "仅组长",
  ADMINS_ONLY: "仅系统管理员",
};

export const projectMemberPermissionLevelOptions = (
  Object.entries(projectMemberPermissionLevelLabels) as ReadonlyArray<
    [ProjectMemberPermissionLevel, string]
  >
).map(([value, label]) => ({ value, label }));

export const permissionMatrixRows: readonly PermissionMatrixRow[] = [
  {
    key: "view",
    feature: "查看项目、动态、成员与搜索",
    fixedAccess: "ALL_MEMBERS",
    note: "固定开放；管理员可查看全部，成员仅可查看已加入项目和可读范围内的动态与搜索结果",
  },
  {
    key: "create-project",
    feature: "创建项目与成员选择",
    fixedAccess: "ALL_MEMBERS",
    note: "固定开放；创建者自动成为项目成员，且不可取消",
  },
  {
    key: "personal-settings",
    feature: "个人设置与通知偏好",
    fixedAccess: "ALL_MEMBERS",
    note: "固定开放；只能读取和修改本人设置，不影响其他成员",
  },
  {
    key: "personal-wecom",
    feature: "个人企业微信绑定",
    fixedAccess: "ALL_MEMBERS",
    note: "固定开放；绑定、解绑与验证码只作用于本人账号",
  },
  {
    key: "projectEdit",
    feature: "编辑项目与变更状态",
    capability: "projectEdit",
    note: "名称、描述与状态；进入维护中要求任务全部收尾",
  },
  {
    key: "projectMemberManage",
    feature: "添加/移除项目成员",
    capability: "projectMemberManage",
    note: "组长不可被移除，需先转交组长身份；移除时需完成在办任务交接",
  },
  {
    key: "projectLeaderTransfer",
    feature: "转移项目组长",
    capability: "projectLeaderTransfer",
    note: "只能把身份转交给其他活跃成员；项目必须始终保留一名组长",
  },
  {
    key: "projectDelete",
    feature: "删除项目",
    capability: "projectDelete",
    note: "物理删除且不可撤销；项目审计链保留，编码可重新使用",
  },
  {
    key: "projectDocumentImport",
    feature: "导入文档与项目内 AI 辅助",
    capability: "projectDocumentImport",
    note: "整项目导入仍固定开放；这里控制既有项目内的文档预览、执行与 AI 辅助；实际创建内容还受模块/功能与任务权限约束",
  },
  {
    key: "moduleFeatureEdit",
    feature: "创建/编辑模块、功能与说明",
    capability: "moduleFeatureEdit",
    note: "包含任务创建时就地新建模块或功能",
  },
  {
    key: "moduleFeatureDelete",
    feature: "删除模块/功能",
    capability: "moduleFeatureDelete",
    note: "物理删除并级联清除下级任务与记录，不保留历史；只保留审计与项目动态",
  },
  {
    key: "taskEdit",
    feature: "创建/编辑/指派任务",
    capability: "taskEdit",
    note: "负责人须为项目活跃成员；遗留问题转任务同样受此权限约束",
  },
  {
    key: "taskLifecycle",
    feature: "任务状态、合并与删除",
    capability: "taskLifecycle",
    note: "完成、重开、合并、解除、取消、恢复与删除；删除不可恢复，合并/解除需二次确认",
  },
  {
    key: "recordWrite",
    feature: "迭代记录、遗留问题与 GitHub 链接",
    capability: "recordWrite",
    note: "创建、编辑、发布；已发布修改生成新版本；任务、功能、项目与记录的 GitHub 链接变更同样受此权限约束",
  },
  {
    key: "projectWecomGroup",
    feature: "项目企业微信群",
    capability: "projectWecomGroup",
    note: "添加、删除群 Webhook 并调整群消息开关；关闭只影响之后的新群消息",
  },
  {
    key: "record-lifecycle",
    feature: "作废/恢复迭代记录",
    fixedAccess: "ADMINS_ONLY",
    note: "固定仅系统管理员；恢复保留作废快照与全部版本，原因进入不可变审计",
  },
  {
    key: "admin-audit",
    feature: "系统管理与审计",
    fixedAccess: "ADMINS_ONLY",
    note: "固定仅系统管理员；账号停用交接、组织与归属管理、系统配置及原始审计快照",
  },
];

export interface NotificationScenarioRow {
  /** 后端通知类型；同一类型对应同一个开关。 */
  readonly key: PersonalNotificationSetting;
  readonly event: string;
  readonly audience: string;
}

export const notificationScenarios: readonly NotificationScenarioRow[] = [
  {
    key: "PROJECT_JOINED",

    event: "项目成员被加入",
    audience: "你被加入一个项目时提醒你",
  },
  {
    key: "task.assigned",

    event: "任务被指派 / 负责人变更",
    audience: "新任务指派或负责人变更（含新增负责人）",
  },
  {
    key: "task.complete",

    event: "任务完成",
    audience: "你创建或负责的任务被完成时",
  },
  {
    key: "task.reopen",

    event: "任务重新打开",
    audience: "你负责或创建的任务被重新打开时",
  },
  {
    key: "task.merge",

    event: "任务被合并",
    audience: "你是主任务 / 分支任务的负责人或创建人时",
  },
  {
    key: "task.unmerge",

    event: "任务解除合并",
    audience: "相关任务的负责人或创建人",
  },
  {
    key: "record.publish",

    event: "迭代记录发布",
    audience: "相关任务负责人、功能相关人",
  },
  {
    key: "record.version.create",

    event: "迭代记录被修改",
    audience: "原记录作者、相关任务负责人",
  },
  {
    key: "record.leftover.add",

    event: "迭代记录追加遗留问题",
    audience: "原记录作者、相关任务负责人",
  },
  {
    key: "leftover.convert",

    event: "遗留问题转为任务",
    audience: "遗留问题转成任务并指派给你时",
  },
  {
    key: "project.status.change",

    event: "项目开工 / 状态变化 / 封箱",
    audience: "你所在项目的状态发生变化，或项目首次进入维护中时",
  },
];

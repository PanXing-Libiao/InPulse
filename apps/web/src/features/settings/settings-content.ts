/**
 * 成员与设置页的只读界面镜像，来源为设计师稿 latest-version/views/settings.tsx。
 *
 * 授权的可执行真相源仍是 docs/permissions.md 与 packages/api-contract 的路由权限矩阵；
 * 本文件只承载说明表文案，不含任何鉴权判断，也不得被其他模块引用。
 * docs/permissions.md 的功能级条目发生变化时必须同步本文件。
 * 全角色都不具备的能力不列入矩阵。
 */

import type { PersonalNotificationSetting } from "@shared/notifications/personal-notification-settings";

/** 项目成员列取值：true = 任意活跃成员；"leader" = 仅本项目现任组长；false = 无人。 */
export type MemberPermissionMark = boolean | "leader";

export interface PermissionMatrixRow {
  readonly feature: string;
  readonly admin: boolean;
  readonly member: MemberPermissionMark;
  readonly note: string;
}

export const permissionMatrixRows: readonly PermissionMatrixRow[] = [
  {
    feature: "查看项目与动态",
    admin: true,
    member: true,
    note: "管理员可查看全部；成员仅已加入项目，动态按可读范围展示",
  },
  {
    feature: "创建项目与成员选择",
    admin: true,
    member: true,
    note: "创建者自动成为项目成员，且不可取消",
  },
  {
    feature: "编辑项目与变更状态",
    admin: true,
    member: true,
    note: "名称、描述与状态；进入维护中要求任务全部收尾",
  },
  {
    feature: "添加/移除项目成员",
    admin: true,
    member: true,
    note: "组长不可被移除，需先转交组长身份",
  },
  {
    feature: "组长转移与删除项目",
    admin: true,
    member: "leader",
    note: "组长身份只能转交其他活跃成员；删除项目不可撤销，审计链保留",
  },
  {
    feature: "导入文档与 AI 辅助",
    admin: true,
    member: true,
    note: "项目导入需活跃成员；整项目导入任何登录用户；AI 功能需管理员启用",
  },
  {
    feature: "创建/编辑模块、功能与说明",
    admin: true,
    member: true,
    note: "—",
  },
  {
    feature: "删除模块/功能",
    admin: true,
    member: "leader",
    note: "物理删除并级联清除下级任务与记录，不保留历史；仅保留审计与项目动态",
  },
  {
    feature: "创建/编辑/指派任务",
    admin: true,
    member: true,
    note: "负责人须为项目活跃成员",
  },
  {
    feature: "任务状态、合并与删除",
    admin: true,
    member: true,
    note: "完成、重开、合并、解除与删除；删除不可恢复，合并/解除需二次确认",
  },
  {
    feature: "迭代记录与 GitHub 链接",
    admin: true,
    member: true,
    note: "创建、编辑、发布；已发布修改生成新版本；链接变更留痕",
  },
  {
    feature: "作废/恢复迭代记录",
    admin: true,
    member: false,
    note: "—",
  },
  {
    feature: "个人通知与企业微信",
    admin: true,
    member: true,
    note: "站内通知与偏好仅本人；机器人绑定/解绑本人；关闭只抑制后续新通知",
  },
  {
    feature: "项目企业微信群",
    admin: true,
    member: "leader",
    note: "组长或管理员签发绑定码、解绑并调整群消息开关；普通成员只读；关闭只影响之后的新群消息",
  },
  {
    feature: "系统管理与审计",
    admin: true,
    member: false,
    note: "账号停用交接、组织与归属管理、系统配置及原始审计快照",
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

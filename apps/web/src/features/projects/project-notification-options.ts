import type { ProjectNotificationCategory } from "@shared/notifications/project-notification-policy";

export interface ProjectNotificationOption {
  readonly key: ProjectNotificationCategory;
  readonly event: string;
  readonly description: string;
}

/** 企业微信项目群可推送的消息口径；默认全开，同时用于过滤站内通知。 */
export const projectNotificationOptions: readonly ProjectNotificationOption[] =
  [
    {
      key: "task.assign",
      event: "任务派发",
      description: "新任务指派、负责人变更（含新增负责人）",
    },
    {
      key: "task.status",
      event: "任务状态变化",
      description: "完成、重新打开、合并、解除合并",
    },
    {
      key: "record",
      event: "迭代记录发布与修订",
      description: "含追加遗留问题、作废与恢复",
    },
    {
      key: "project.member",
      event: "项目与成员变化",
      description: "开工、状态变更、成员加入 / 移出 / 角色调整",
    },
    {
      key: "scope.delete",
      event: "范围与删除",
      description: "模块 / 功能 / 任务的删除等成员可见动态",
    },
  ];

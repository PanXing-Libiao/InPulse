import type { ProjectNotificationCategory } from "@shared/notifications/project-notification-policy";

export interface ProjectNotificationOption {
  readonly key: ProjectNotificationCategory;
  readonly event: string;
  readonly description: string;
}

/** 企业微信项目群推送类别；默认全开，由服务端保存并供桥接物化前过滤。 */
export const projectNotificationOptions: readonly ProjectNotificationOption[] =
  [
    {
      key: "task.assign",
      event: "任务派发",
      description: "新任务、负责人变更（含新增负责人）；普通编辑不推送",
    },
    {
      key: "task.status",
      event: "任务状态变化",
      description: "完成、重新打开、取消、恢复、合并、解除合并",
    },
    {
      key: "record",
      event: "迭代记录发布与修订",
      description:
        "发布、修订、追加遗留问题、恢复；作废记录仅管理员可见，不推群",
    },
    {
      key: "project.member",
      event: "项目与成员变化",
      description: "项目状态、成员加入 / 移出 / 角色调整、模块与功能信息更新",
    },
    {
      key: "scope.delete",
      event: "范围与删除",
      description: "模块 / 功能 / 任务的删除等成员可见动态",
    },
  ];

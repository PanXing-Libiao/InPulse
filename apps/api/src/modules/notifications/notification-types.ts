import type { PersonalNotificationSetting } from "@inpulse/api-contract";

/**
 * 站内通知类型目录：业务写入点只引用这里的常量，避免同一事件在不同 Workflow
 * 里写成不同字符串。取值必须与 packages/api-contract 的个人通知设置、
 * 项目通知类别映射保持一致。
 */
export const PROJECT_NOTIFICATION_TYPES = {
  projectJoined: "PROJECT_JOINED",
  projectStatusChange: "project.status.change",
  taskAssigned: "task.assigned",
  taskComplete: "task.complete",
  taskReopen: "task.reopen",
  taskMerge: "task.merge",
  taskUnmerge: "task.unmerge",
  recordPublish: "record.publish",
  recordVersionCreate: "record.version.create",
  recordLeftoverAdd: "record.leftover.add",
  leftoverConvert: "leftover.convert",
} as const satisfies Record<string, PersonalNotificationSetting>;

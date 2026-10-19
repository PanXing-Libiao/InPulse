/**
 * F-08 原始审计的展示标签：`action` 与 `targetType` 是审计契约里的机器码，
 * 列表与筛选一律显示中文；未收录的取值按原样显示，便于在界面上发现新的
 * 后端事件。映射只服务展示，请求仍发送原始码（服务端按码精确匹配）。
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  "project.create": "创建项目",
  "project.update": "更新项目",
  "project.status.change": "变更项目状态",
  "project.delete": "删除项目",
  "project.archive": "归档项目",
  "project.restore": "恢复项目",
  // ADR-062：删除项目改为物理删除并取消保留期自动清理，只剩历史行。
  "project.purge": "彻底删除项目",
  "project.archive.request": "提交归档申请",
  "project.archive.reject": "驳回归档申请",
  "project.member.add": "添加项目成员",
  "project.member.remove": "移除项目成员",
  "project.member.role.set": "调整成员角色",
  "project.documentImport": "导入文档",
  "module.create": "创建模块",
  "module.update": "更新模块",
  // ADR-059：删除模块与删除功能（软删除，无还原入口）。
  "module.delete": "删除模块",
  "module.archive": "归档模块",
  "module.restore": "恢复模块",
  "feature.create": "创建功能",
  "feature.update": "更新功能",
  "feature.delete": "删除功能",
  "feature.archive": "归档功能",
  "feature.restore": "恢复功能",
  "task.create": "创建任务",
  "task.update": "更新任务",
  "task.status": "变更任务状态",
  "task.archive": "归档任务",
  "task.unarchive": "恢复任务",
  "task.merge": "合并任务",
  "task.unmerge": "解除合并",
  // ADR-058：删除任务（软删除，无恢复入口）。
  "task.delete": "删除任务",
  "record.draft.create": "创建草稿",
  "record.draft.update": "更新草稿",
  "record.draft.delete": "删除草稿",
  "record.publish": "发布记录",
  "record.version.create": "修订记录",
  "record.leftover.add": "追加遗留问题",
  "leftover.convert": "遗留问题转任务",
  CHANGE_RECORD_VOIDED: "作废记录",
  CHANGE_RECORD_RESTORED: "恢复记录",
  EXTERNAL_LINK_ADDED: "添加 GitHub 关联",
  EXTERNAL_LINK_REMOVED: "解除 GitHub 关联",
  "admin.user.create": "创建用户",
  "admin.user.update": "更新用户",
  "admin.user.disable": "停用用户",
  "admin.user.enable": "启用用户",
  "admin.user.force_logout": "强制退出登录",
  "admin.user.delete": "强制删除用户",
  "admin.wecomRobot.update": "更新机器人配置",
  "admin.aiAssistSettings.update": "更新 AI 辅助设置",
  "auth.sso_login": "统一身份认证登录",
  "auth.sso_login_failed": "统一身份认证登录失败",
  "auth.sso_account_provisioned": "统一身份认证首次开通账号",
  "auth.sso_account_linked": "绑定统一身份认证账号",
  AUDIT_LOG_READ: "读取审计日志",
  AUDIT_KEY_ROTATED: "轮换审计签名密钥",
  SYSTEM_TEST: "系统测试写入",
};

/** 演示种子数据等整族前缀：整族共用同一文案，避免逐条枚举。 */
const ACTION_PREFIX_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["AUDIT_SEED_", "演示种子数据"],
];

export function auditActionLabel(action: string): string {
  const exact = ACTION_LABELS[action];
  if (exact !== undefined) {
    return exact;
  }
  for (const [prefix, label] of ACTION_PREFIX_LABELS) {
    if (action.startsWith(prefix)) {
      return label;
    }
  }
  return action;
}

/** 「中文（原始码）」对照文案；未收录动作只显示原始码，避免出现 `X（X）`。 */
export function auditActionWithCode(action: string): string {
  const label = auditActionLabel(action);
  return label === action ? action : label + "（" + action + "）";
}

const TARGET_TYPE_LABELS: Readonly<Record<string, string>> = {
  USER: "用户",
  SYSTEM: "系统",
  AUDIT_CHAIN: "审计链",
  PROJECT: "项目",
  MODULE: "模块",
  FEATURE: "功能",
  TASK: "任务",
  TASK_GROUP: "任务聚合组",
  CHANGE_RECORD: "迭代记录",
  LEFTOVER_ITEM: "遗留问题",
  EXTERNAL_LINK: "GitHub 链接",
  WECOM_ROBOT_CONFIG: "企业微信机器人配置",
  AI_ASSIST_SETTINGS: "AI 辅助设置",
};

export function auditTargetTypeLabel(targetType: string): string {
  return TARGET_TYPE_LABELS[targetType] ?? targetType;
}

export function auditTargetTypeWithCode(targetType: string): string {
  const label = auditTargetTypeLabel(targetType);
  return label === targetType ? targetType : label + "（" + targetType + "）";
}

export interface AuditActionOption {
  readonly code: string;
  readonly label: string;
}

/**
 * 已下线的动作码：功能移除后不会再产生新记录（ADR-043 项目归档、ADR-044
 * 模块归档、ADR-045 功能归档、ADR-054 任务归档、ADR-060 读取留痕、
 * ADR-062 项目还原与保留期彻底删除；SYSTEM_TEST 仅由测试写入）。ACTION_LABELS 仍保留它们的中文文案供历史行
 * 渲染，但筛选候选不再列出——选中一个永远为空的动作只会误导。
 */
const RETIRED_ACTION_CODES: ReadonlySet<string> = new Set([
  "project.archive",
  "project.archive.request",
  "project.archive.reject",
  "project.restore",
  "project.purge",
  "module.archive",
  "module.restore",
  "feature.archive",
  "feature.restore",
  "task.archive",
  "task.unarchive",
  "AUDIT_LOG_READ",
  "SYSTEM_TEST",
]);

/** 动作筛选候选：去掉已下线动作码，按中文名排序，填入的仍是原始码。 */
export const AUDIT_ACTION_OPTIONS: readonly AuditActionOption[] =
  Object.entries(ACTION_LABELS)
    .filter(([code]) => !RETIRED_ACTION_CODES.has(code))
    .map(([code, label]) => ({ code, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));

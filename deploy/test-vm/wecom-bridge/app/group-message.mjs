// ADR-093：项目群动态的统一展示层。纯函数，不连接数据库或企业微信。
const NEWLINE = String.fromCharCode(10);

const PROJECT_STATUS_LABELS = {
  NOT_STARTED: "未开始",
  ACTIVE: "进行中",
  MAINTENANCE: "维护中",
};
const PRIORITY_LABELS = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};
const WORK_STATUS_LABELS = {
  TODO: "未完成",
  DONE: "已完成",
  CANCELED: "已取消",
};
const ROLE_LABELS = {
  MEMBER: "成员",
  LEADER: "组长",
};

const SECTION_BY_ACTIVITY = new Map([
  ["task.create", "任务"],
  ["task.update", "任务"],
  ["task.complete", "任务"],
  ["task.reopen", "任务"],
  ["task.cancel", "任务"],
  ["task.restore", "任务"],
  ["task.merge", "任务"],
  ["task.unmerge", "任务"],
  ["module.create", "模块"],
  ["module.update", "模块"],
  ["feature.create", "功能"],
  ["feature.update", "功能"],
  ["record.publish", "迭代记录"],
  ["record.version.create", "迭代记录"],
  ["record.draft.create", "迭代记录"],
  ["record.draft.update", "迭代记录"],
  ["record.leftover.add", "迭代记录"],
  ["leftover.convert", "迭代记录"],
  ["change_record_voided", "迭代记录"],
  ["change_record_restored", "迭代记录"],
  ["project_created", "项目"],
  ["project_updated", "项目"],
  ["project_status_changed", "项目"],
  ["project_wrapped", "项目"],
  ["project_member_added", "成员"],
  ["project_member_removed", "成员"],
  ["project_member_role_changed", "成员"],
  ["project_joined", "成员"],
  ["external_link_added", "GitHub"],
  ["external_link_removed", "GitHub"],
  ["module_deleted", "内容删除"],
  ["module.delete", "内容删除"],
  ["feature_deleted", "内容删除"],
  ["feature.delete", "内容删除"],
  ["task_deleted", "内容删除"],
  ["task.delete", "内容删除"],
  ["project_deleted", "内容删除"],
]);

const EVENT_TITLES = new Map([
  ["task.create", "新任务指派"],
  ["task.update", "任务信息更新"],
  ["task.complete", "任务已完成"],
  ["task.reopen", "任务已重新打开"],
  ["task.cancel", "任务已取消"],
  ["task.restore", "任务已恢复"],
  ["task.merge", "任务已合并"],
  ["task.unmerge", "任务已解除合并"],
  ["module.create", "新建模块"],
  ["module.update", "模块信息更新"],
  ["feature.create", "新建功能"],
  ["feature.update", "功能信息更新"],
  ["record.publish", "迭代记录已发布"],
  ["record.version.create", "迭代记录已修订"],
  ["record.draft.create", "新建记录草稿"],
  ["record.draft.update", "记录草稿已更新"],
  ["record.leftover.add", "迭代记录追加遗留问题"],
  ["leftover.convert", "遗留问题已转为任务"],
  ["change_record_voided", "迭代记录已作废"],
  ["change_record_restored", "迭代记录已恢复"],
  ["project_created", "项目已创建"],
  ["project_updated", "项目信息已更新"],
  ["project_member_added", "成员加入项目"],
  ["project_member_removed", "成员移出项目"],
  ["project_member_role_changed", "项目角色调整"],
  ["project_joined", "成员加入项目"],
  ["external_link_added", "新增 GitHub 关联"],
  ["external_link_removed", "解除 GitHub 关联"],
  ["module_deleted", "模块已删除"],
  ["module.delete", "模块已删除"],
  ["feature_deleted", "功能已删除"],
  ["feature.delete", "功能已删除"],
  ["task_deleted", "任务已删除"],
  ["task.delete", "任务已删除"],
  ["project_deleted", "项目已删除"],
]);

const TASK_ACTIVITY_TYPES = new Set([
  "task.create",
  "task.update",
  "task.complete",
  "task.reopen",
  "task.cancel",
  "task.restore",
  "task.merge",
  "task.unmerge",
  "task_deleted",
  "task.delete",
]);

function cleanText(value, maxLength = 120) {
  const text = String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1)) + "…";
}

function labelOf(labels, value) {
  const key = cleanText(value, 40);
  return labels[key] === undefined ? key : labels[key];
}

function metadataOf(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function cleanSummary(value, projectName) {
  let summary = cleanText(value, 160);
  const suffix = projectName.length > 0 ? "（" + projectName + "）" : "";
  if (suffix.length > 0 && summary.endsWith(suffix)) {
    summary = summary.slice(0, -suffix.length).trim();
  }
  return summary;
}

function summarySubject(summary) {
  const text = cleanText(summary, 120);
  const separator = text.indexOf("：");
  if (separator < 0 || separator === text.length - 1) return text;
  return text.slice(separator + 1).trim();
}

function projectStatusTitle(item) {
  const metadata = metadataOf(item.metadata);
  const before = cleanText(metadata.beforeStatus, 40).toUpperCase();
  const after = cleanText(metadata.afterStatus, 40).toUpperCase();
  if (after === "MAINTENANCE") return "项目进入维护";
  if (before === "MAINTENANCE" && after === "ACTIVE") return "项目重新开工";
  return "项目状态更新";
}

function eventTitleFor(item, activityType) {
  if (activityType === "project_status_changed")
    return projectStatusTitle(item);
  if (activityType === "task.update") {
    const metadata = metadataOf(item.metadata);
    if (metadata.assignmentChanged === true) return "任务已改派";
  }
  return EVENT_TITLES.get(activityType) ?? "";
}

function subjectFor(item, activityType, summary, projectName) {
  if (TASK_ACTIVITY_TYPES.has(activityType)) {
    return cleanText(item.task_title, 100) || summarySubject(summary);
  }
  if (activityType === "module.create" || activityType === "module.update") {
    return cleanText(item.module_name, 80) || summarySubject(summary);
  }
  if (
    activityType === "project_created" ||
    activityType === "project_updated"
  ) {
    return projectName || summarySubject(summary);
  }
  if (activityType === "project_status_changed") return "";
  return summarySubject(summary);
}

function taskStatusOf(item, activityType) {
  if (activityType === "task.complete") return "DONE";
  if (activityType === "task.cancel") return "CANCELED";
  if (activityType === "task.reopen") return "TODO";
  return cleanText(item.work_status, 40).toUpperCase();
}

function taskContext(item, activityType) {
  const lines = [];
  const head = [];
  const code = cleanText(item.task_code, 48);
  const priority = labelOf(PRIORITY_LABELS, item.priority);
  const status = labelOf(WORK_STATUS_LABELS, taskStatusOf(item, activityType));
  if (code.length > 0) head.push("编号 " + code);
  if (priority.length > 0) head.push("优先级 " + priority);
  if (status.length > 0) head.push("状态 " + status);
  if (head.length > 0) lines.push(head.join(" ｜ "));
  const assignees = cleanText(item.task_assignees, 100);
  if (assignees.length > 0) lines.push("负责人 " + assignees);
  const due = formatDateTime(item.due_at);
  if (due.length > 0) lines.push("截止 " + due);
  lines.push(...moduleScopeLine(item));
  return lines;
}

function moduleContext(item, subject) {
  const code = cleanText(item.module_code, 48);
  const name = cleanText(item.module_name, 80);
  const lines = [];
  if (code.length > 0) lines.push("编号 " + code);
  if (name.length > 0 && name !== subject) lines.push("名称 " + name);
  return lines;
}

function moduleScopeLine(item) {
  const code = cleanText(item.module_code, 48);
  const name = cleanText(item.module_name, 80);
  if (code.length === 0 && name.length === 0) return [];
  return [
    "模块 " + [code, name].filter((value) => value.length > 0).join(" · "),
  ];
}

function projectStatusContext(item) {
  const metadata = metadataOf(item.metadata);
  const before = labelOf(PROJECT_STATUS_LABELS, metadata.beforeStatus);
  const after = labelOf(PROJECT_STATUS_LABELS, metadata.afterStatus);
  if (before.length === 0 || after.length === 0) return [];
  return ["状态 " + before + " → " + after];
}

function memberContext(item) {
  const metadata = metadataOf(item.metadata);
  const role = labelOf(ROLE_LABELS, metadata.role);
  return role.length > 0 ? ["角色 " + role] : [];
}

function recordContext(item) {
  const metadata = metadataOf(item.metadata);
  const version = Number(metadata.version);
  const lines = [];
  if (Number.isSafeInteger(version) && version > 0) {
    lines.push("版本 v" + String(version));
  }
  lines.push(...moduleScopeLine(item));
  return lines;
}

function contextLines(item, activityType, subject) {
  if (TASK_ACTIVITY_TYPES.has(activityType)) {
    return taskContext(item, activityType);
  }
  if (activityType === "module.create" || activityType === "module.update") {
    return moduleContext(item, subject);
  }
  if (activityType === "project_status_changed")
    return projectStatusContext(item);
  if (
    activityType.startsWith("project_member") ||
    activityType === "project_joined"
  ) {
    return memberContext(item);
  }
  if (
    activityType.startsWith("record.") ||
    activityType === "change_record_voided" ||
    activityType === "change_record_restored" ||
    activityType === "leftover.convert"
  ) {
    return recordContext(item);
  }
  return [];
}

/**
 * 生成项目群动态 Markdown。
 * 结构固定为：板块 -> 项目 -> 事件标题 / 对象 -> 业务上下文 -> 操作人/时间。
 */
export function buildGroupActivityMarkdown(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("群动态数据不是对象");
  }
  const activityType = cleanText(item.activity_type, 80).toLowerCase();
  const section = SECTION_BY_ACTIVITY.get(activityType) ?? "项目动态";
  const projectName = cleanText(item.project_name, 40);
  const projectCode = cleanText(item.project_code, 40);
  const projectLine = [
    projectName.length > 0 ? "**" + projectName + "**" : "",
    projectCode,
  ]
    .filter((value) => value.length > 0)
    .join(" ｜ ");
  const summary = cleanSummary(item.summary, projectName);
  const eventTitle = eventTitleFor(item, activityType);
  const subject = subjectFor(item, activityType, summary, projectName);

  const lines = ["**INPULSE · " + section + "**"];
  if (projectLine.length > 0) lines.push(projectLine);
  if (eventTitle.length > 0 || (subject.length > 0 && subject !== eventTitle)) {
    lines.push("");
  }
  if (eventTitle.length > 0) lines.push("**" + eventTitle + "**");
  if (subject.length > 0 && subject !== eventTitle) {
    lines.push("「" + subject + "」");
  }
  const context = contextLines(item, activityType, subject);
  if (context.length > 0) lines.push("", ...context);

  const actorName = cleanText(item.actor_name, 40);
  const occurredAt = formatDateTime(item.occurred_at);
  const footer = [actorName.length > 0 ? "操作人 " + actorName : "", occurredAt]
    .filter((value) => value.length > 0)
    .join(" ｜ ");
  if (footer.length > 0) lines.push("", footer);

  return lines.join(NEWLINE);
}

function normalizeCardActionUrl(value) {
  const text = cleanText(value, 2048);
  if (text.length === 0) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function pushCardRow(rows, keyname, value, maxLength = 40) {
  const text = cleanText(value, maxLength);
  if (text.length === 0) return;
  rows.push({ keyname: keyname, value: text });
}

function cardScopeRows(rows, item) {
  const moduleCode = cleanText(item.module_code, 48);
  const moduleName = cleanText(item.module_name, 60);
  if (moduleCode.length === 0 && moduleName.length === 0) return;
  pushCardRow(
    rows,
    "模块",
    [moduleCode, moduleName].filter((value) => value.length > 0).join(" · "),
    44,
  );
}

function cardRowsFor(item, activityType) {
  const rows = [];
  if (TASK_ACTIVITY_TYPES.has(activityType)) {
    pushCardRow(rows, "负责人", item.task_assignees, 40);
    const priority = labelOf(PRIORITY_LABELS, item.priority);
    const status = labelOf(
      WORK_STATUS_LABELS,
      taskStatusOf(item, activityType),
    );
    const progress = [
      priority.length > 0 ? "优先级 " + priority : "",
      status.length > 0 ? "状态 " + status : "",
    ]
      .filter((value) => value.length > 0)
      .join(" · ");
    pushCardRow(rows, "进度", progress, 40);
    pushCardRow(rows, "截止", formatDateTime(item.due_at), 32);
    cardScopeRows(rows, item);
  } else if (
    activityType === "feature.create" ||
    activityType === "feature.update"
  ) {
    cardScopeRows(rows, item);
  } else if (activityType === "project_status_changed") {
    const metadata = metadataOf(item.metadata);
    const before = labelOf(PROJECT_STATUS_LABELS, metadata.beforeStatus);
    const after = labelOf(PROJECT_STATUS_LABELS, metadata.afterStatus);
    if (before.length > 0 && after.length > 0) {
      pushCardRow(rows, "状态", before + " → " + after, 40);
    }
  } else if (
    activityType.startsWith("project_member") ||
    activityType === "project_joined"
  ) {
    const metadata = metadataOf(item.metadata);
    pushCardRow(rows, "角色", labelOf(ROLE_LABELS, metadata.role), 20);
  } else if (
    activityType.startsWith("record.") ||
    activityType === "change_record_voided" ||
    activityType === "change_record_restored" ||
    activityType === "leftover.convert"
  ) {
    const metadata = metadataOf(item.metadata);
    const version = Number(metadata.version);
    if (Number.isSafeInteger(version) && version > 0) {
      pushCardRow(rows, "版本", "v" + String(version), 20);
    }
    cardScopeRows(rows, item);
  }

  pushCardRow(rows, "操作人", item.actor_name, 32);
  pushCardRow(rows, "时间", formatDateTime(item.occurred_at), 32);
  return rows.slice(0, 6);
}

function cardTitleFor(eventTitle, subject, projectName) {
  const combined =
    eventTitle.length > 0 && subject.length > 0 && subject !== projectName
      ? eventTitle + "：" + subject
      : eventTitle || subject;
  return cleanText(combined.length > 0 ? combined : projectName, 40);
}

function cardCodeFor(item, activityType) {
  let code = "";
  if (TASK_ACTIVITY_TYPES.has(activityType))
    code = cleanText(item.task_code, 48);
  else if (
    activityType === "module.create" ||
    activityType === "module.update"
  ) {
    code = cleanText(item.module_code, 48);
  }
  if (code.length === 0) code = cleanText(item.project_code, 48);
  return code.length > 0 ? "编号 " + code : "";
}

/**
 * 生成与个人通知一致的 text_notice 模板卡片。
 * 群动态使用有限横向字段，避免 Markdown 长文把消息撑得过高。
 */
export function buildGroupActivityCard(item, options = {}) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("群动态数据不是对象");
  }
  const activityType = cleanText(item.activity_type, 80).toLowerCase();
  const section = SECTION_BY_ACTIVITY.get(activityType) ?? "项目动态";
  const projectName = cleanText(item.project_name, 40);
  const projectCode = cleanText(item.project_code, 40);
  const summary = cleanSummary(item.summary, projectName);
  const eventTitle = eventTitleFor(item, activityType);
  const subject = subjectFor(item, activityType, summary, projectName);
  const title = cardTitleFor(eventTitle, subject, projectName);
  const code = cardCodeFor(item, activityType);
  const subtitle = [projectName, projectCode, section + "动态"]
    .filter((value) => value.length > 0)
    .join(" · ");
  const rows = cardRowsFor(item, activityType);
  const template = {
    card_type: "text_notice",
    source: { desc: "InPulse", desc_color: 0 },
    main_title: { title: title || section },
    sub_title_text: cleanText(subtitle || "InPulse 项目群动态", 60),
    horizontal_content_list: rows,
  };
  if (code.length > 0) template.main_title.desc = cleanText(code, 40);
  const cardActionUrl = normalizeCardActionUrl(options.cardActionUrl);
  if (cardActionUrl.length > 0) {
    template.card_action = { type: 1, url: cardActionUrl };
  }
  return { msgtype: "template_card", template_card: template };
}

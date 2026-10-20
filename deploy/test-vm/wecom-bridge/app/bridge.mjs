// InPulse -> 企业微信智能机器人 临时通知桥 v5（演示用，不进入 InPulse 仓库）
// v4 变化：消息改为 template_card 卡片（主标题 + 编号 + 字段行），通过 PoC raw 通道发送。
// v5 变化（ADR-077 第二批，2026-10-16）：新增项目群投递物化——把新的 task.assigned
// 通知与 MEMBER 可见项目动态写成 app.wecom_group_deliveries 的 PENDING 行，
// 由 long-conn 消费并回写 SENT / FAILED；个人单聊推送逻辑不变。
// v6 变化（ADR-090，2026-10-20）：物化前读取项目群通知开关，按五个类别过滤；
// 缺行或未识别的新事件默认放行，关闭只影响此后物化，不回溯历史或已排队消息。
// 可选键：groupDeliveries=false 关闭物化、groupNotificationTypes 覆盖类型清单
// （默认 ["task.assigned"]）、startFromGroupNotificationId / startFromActivityId
// 指定游标初值（缺省从当前最大 id 开始，不回补历史）。
// 数据：直连本地开发库只读查询（演示用 cluster_bootstrap；正式实现不得照搬此方式）。
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  flagsFromRow,
  groupCategoryForActivity,
  groupCategoryForNotification,
  groupCategoryIsEnabled,
} from "./notification-categories.mjs";

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, "bridge-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

// 数据库连接：优先 DATABASE_URL（runner 注入），其次 bridge-config.databaseUrl
// （本地 PoC），最后按 DB_* 组件 + DB_PASSWORD_FILE 自拼（独立容器与自检场景）。
function buildDatabaseUrl() {
  const host = process.env.DB_HOST || "db";
  const port = process.env.DB_PORT || "5432";
  const name = process.env.DB_NAME || "app";
  const user = process.env.DB_USER || "app_runtime";
  const passwordFile =
    process.env.DB_PASSWORD_FILE || "/run/secrets/db_runtime_password";
  const password = readFileSync(passwordFile, "utf8").trim();
  const sslmode = (process.env.DB_SSLMODE || "").trim();
  const base =
    "postgresql://" +
    encodeURIComponent(user) +
    ":" +
    encodeURIComponent(password) +
    "@" +
    host +
    ":" +
    port +
    "/" +
    name;
  return sslmode.length > 0 ? base + "?sslmode=" + sslmode : base;
}
const envUrl =
  typeof process.env.DATABASE_URL === "string"
    ? process.env.DATABASE_URL.trim()
    : "";
const configUrl =
  typeof config.databaseUrl === "string" ? config.databaseUrl.trim() : "";
const databaseUrl =
  envUrl.length > 0
    ? envUrl
    : configUrl.length > 0
      ? configUrl
      : buildDatabaseUrl();
const recipients = new Map(Object.entries(config.recipients || {}));
const configuredTypes = Array.isArray(config.forwardTypes)
  ? config.forwardTypes
  : [];
const forwardAll =
  configuredTypes.length === 0 || configuredTypes.includes("*");
const forwardTypes = new Set(configuredTypes);
const commandFile = resolve(here, config.commandFile || "config-commands.txt");
const stateFile = resolve(here, config.stateFile || "bridge-state.json");
const pollIntervalMs =
  Number(config.pollIntervalMs) > 0 ? Number(config.pollIntervalMs) : 3000;
const dryRun = config.dryRun === true;
const maxIterations =
  Number.isInteger(config.maxIterations) && config.maxIterations > 0
    ? config.maxIterations
    : null;
const cardActionUrl = String(config.cardActionUrl || "https://example.com");
const groupDeliveriesEnabled = config.groupDeliveries !== false;
const groupNotificationTypes = new Set(
  Array.isArray(config.groupNotificationTypes) &&
    config.groupNotificationTypes.length > 0
    ? config.groupNotificationTypes.filter(
        (value) => typeof value === "string" && value.length > 0,
      )
    : ["task.assigned"],
);

const PRIORITY_LABELS = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};
const STATUS_LABELS = { TODO: "未完成", DONE: "已完成", CANCELED: "已取消" };
const TYPE_LABELS = {
  "task.assigned": "新任务指派",
  "leftover.convert": "遗留问题转任务",
  "task.complete": "任务完成",
  "task.reopen": "任务重新打开",
  "task.merge": "合并任务",
  "task.unmerge": "解除合并",
  "record.publish": "发布记录",
  "record.version.create": "修订记录",
  "record.leftover.add": "追加遗留问题",
  PROJECT_JOINED: "加入项目",
  PROJECT_ARCHIVE_REQUESTED: "归档申请",
  PROJECT_ARCHIVE_APPROVED: "归档通过",
  PROJECT_ARCHIVE_REJECTED: "归档驳回",
};
const SUBTITLE = {
  "task.assigned": "有新的任务指派给你",
  "leftover.convert": "有新的遗留问题转为任务",
  "task.complete": "任务状态更新：已完成",
  "task.reopen": "任务被重新打开",
  "task.merge": "任务合并变动",
  "task.unmerge": "任务合并解除",
  "record.publish": "有新的迭代记录发布",
  "record.version.create": "迭代记录有新修订",
  "record.leftover.add": "迭代记录追加了遗留问题",
  PROJECT_JOINED: "项目成员变动",
  PROJECT_ARCHIVE_REQUESTED: "收到项目归档申请",
  PROJECT_ARCHIVE_APPROVED: "项目归档申请已通过",
  PROJECT_ARCHIVE_REJECTED: "项目归档申请被驳回",
};
const ASSIGNMENT_TYPES = new Set(["task.assigned", "leftover.convert"]);
const BODY_IS_CODE_TYPES = new Set([
  "task.assigned",
  "leftover.convert",
  "task.complete",
  "task.reopen",
  "record.publish",
  "record.version.create",
  "record.leftover.add",
]);

const POLL_SQL = [
  "select",
  "  n.id,",
  "  n.recipient_id,",
  "  n.notification_type,",
  "  n.title,",
  "  n.body as task_code,",
  "  t.title as task_title,",
  "  t.priority,",
  "  t.work_status,",
  "  t.due_at,",
  "  p.name as project_name",
  "from app.notifications n",
  "left join app.tasks t",
  "  on t.id = nullif(substring(n.target_path from 'taskId=([0-9]+)'), '')::int",
  "left join app.projects p on p.id = n.project_id",
  "where n.id > $1",
  "order by n.id asc",
  "limit 100",
].join(" ");

function log(...parts) {
  console.log("[" + new Date().toISOString() + "]", ...parts);
}

function clean(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, maxChars) {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1) + "…";
}

function formatDue(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

function buildCard(row) {
  const typeLabel = TYPE_LABELS[row.notification_type] || row.notification_type;
  const title = clamp(clean(row.title) || typeLabel, 40);
  const code = BODY_IS_CODE_TYPES.has(row.notification_type)
    ? clean(row.task_code)
    : "";
  const rows = [];
  const projectName = clean(row.project_name);
  if (projectName.length > 0 && title.indexOf(projectName) < 0) {
    rows.push({ keyname: "项目", value: clamp(projectName, 40) });
  }
  const actorName = row.actor_type === "USER" ? clean(row.actor_name) : "";
  rows.push({
    keyname: ASSIGNMENT_TYPES.has(row.notification_type) ? "指派人" : "操作人",
    value: actorName.length > 0 ? actorName : "系统",
  });
  const isTask = row.task_title !== null && row.task_title !== undefined;
  if (isTask) {
    if (PRIORITY_LABELS[row.priority])
      rows.push({ keyname: "优先级", value: PRIORITY_LABELS[row.priority] });
    if (STATUS_LABELS[row.work_status])
      rows.push({ keyname: "状态", value: STATUS_LABELS[row.work_status] });
    const due = formatDue(row.due_at);
    if (due.length > 0) rows.push({ keyname: "截止", value: due });
  }
  const template = {
    card_type: "text_notice",
    source: { desc: "InPulse", desc_color: 0 },
    main_title: { title: title },
    sub_title_text: SUBTITLE[row.notification_type] || "InPulse 通知",
    horizontal_content_list: rows,
    card_action: { type: 1, url: cardActionUrl },
  };
  if (code.length > 0) template.main_title.desc = "编号 " + clamp(code, 40);
  return { msgtype: "template_card", template_card: template };
}

function appendCommand(line) {
  let prefix = "";
  if (existsSync(commandFile)) {
    const raw = readFileSync(commandFile, "utf8");
    if (raw.length > 0 && !raw.endsWith("\n")) prefix = "\n";
  }
  appendFileSync(commandFile, prefix + line + "\n", "utf8");
}

function loadState() {
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      return {
        lastId: Number.isInteger(state.lastId) ? state.lastId : null,
        lastGroupNotificationId: Number.isInteger(state.lastGroupNotificationId)
          ? state.lastGroupNotificationId
          : null,
        lastActivityId: Number.isInteger(state.lastActivityId)
          ? state.lastActivityId
          : null,
      };
    } catch {
      // 状态文件损坏时忽略，走正常初始化
    }
  }
  return { lastId: null, lastGroupNotificationId: null, lastActivityId: null };
}

async function reloadRecipients() {
  let dbRows;
  try {
    const result = await pool.query(
      "select user_id, wecom_userid, status from app.user_wecom_bindings",
    );
    dbRows = result.rows;
  } catch (error) {
    // 绑定表暂不可读时保持现有映射，等待下一轮
    log(
      "读取绑定表失败（本轮沿用现有映射）:",
      error && error.message ? error.message : String(error),
    );
    return;
  }
  const next = new Map();
  const seenUserIds = new Set();
  for (const row of dbRows) {
    const key = String(row.user_id);
    seenUserIds.add(key);
    if (row.status === "ACTIVE") next.set(key, String(row.wecom_userid));
  }
  try {
    // 静态映射只服务「数据库里从未出现过绑定记录」的过渡账号；
    // 用户一旦在数据库绑定或解绑过，其收件人一律以数据库为准。
    const live = JSON.parse(readFileSync(configPath, "utf8"));
    for (const [key, value] of Object.entries(live.recipients || {})) {
      if (
        typeof value === "string" &&
        value.length > 0 &&
        !seenUserIds.has(key)
      ) {
        next.set(key, value);
      }
    }
  } catch {
    // 配置文件不可读时忽略，仅用数据库映射
  }
  recipients.clear();
  for (const [key, value] of next) recipients.set(key, value);
}

let lastId = null;
let lastGroupNotificationId = null;
let lastActivityId = null;
let iterations = 0;
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

async function currentMaxId() {
  const result = await pool.query(
    "select coalesce(max(id), 0) as max_id from app.notifications",
  );
  return Number(result.rows[0].max_id);
}

async function currentMaxActivityId() {
  const result = await pool.query(
    "select coalesce(max(id), 0) as max_id from app.activity_projection",
  );
  return Number(result.rows[0].max_id);
}

// 读取项目级通知开关；缺行等价于五类全开。每轮物化读取一次，保存后下一轮生效。
async function loadGroupNotificationOptions() {
  const result = await pool.query(
    [
      "select project_id,",
      "  task_assign_enabled,",
      "  task_status_enabled,",
      "  record_enabled,",
      "  project_member_enabled,",
      "  scope_delete_enabled",
      "from app.project_wecom_group_notification_options",
    ].join(" "),
  );
  const byProject = new Map();
  for (const row of result.rows) {
    byProject.set(Number(row.project_id), flagsFromRow(row));
  }
  return byProject;
}

// 物化项目群投递：为每条候选来源在「该项目当前 ACTIVE 群绑定」下写一条 PENDING。
// 同一审计事件的多个收件人（同 chain+sequence+type）只占一行，消费侧再聚合姓名；
// 只物化「绑定时间之后发生」的来源，桥接停机期间也不会补发绑定前的历史。
// ADR-090：先读项目通知开关，关闭类别不进入投递队列；游标照常前进，
// 因此重新开启不会补发关闭期间的历史。
async function insertGroupDelivery(kind, sourceId, projectId, sourceAt) {
  const result = await pool.query(
    [
      "insert into app.wecom_group_deliveries (group_binding_id, source_kind, source_id)",
      "select g.id, $1, $2",
      "from app.project_wecom_groups g",
      "where g.project_id = $3 and g.status = 'ACTIVE' and g.bound_at <= $4",
      "on conflict (group_binding_id, source_kind, source_id) do nothing",
    ].join(" "),
    [kind, sourceId, projectId, sourceAt],
  );
  return result.rowCount;
}

async function materializeGroupDeliveries() {
  if (!groupDeliveriesEnabled || dryRun) return 0;
  let created = 0;
  const notificationOptions = await loadGroupNotificationOptions();

  const notifications = await pool.query(
    [
      "select n.id, n.project_id, n.notification_type, n.created_at, n.source_chain_id, n.source_sequence",
      "from app.notifications n",
      "where n.id > $1",
      "order by n.id asc",
      "limit 200",
    ].join(" "),
    [lastGroupNotificationId],
  );
  const representatives = new Map();
  let maxNotificationId = lastGroupNotificationId;
  for (const row of notifications.rows) {
    const id = Number(row.id);
    if (id > maxNotificationId) maxNotificationId = id;
    if (!groupNotificationTypes.has(row.notification_type)) continue;
    if (row.project_id === null || row.project_id === undefined) continue;
    const projectId = Number(row.project_id);
    const category = groupCategoryForNotification(row.notification_type);
    if (!groupCategoryIsEnabled(category, notificationOptions.get(projectId))) {
      continue;
    }
    const key =
      row.source_chain_id +
      "|" +
      row.source_sequence +
      "|" +
      row.notification_type;
    const current = representatives.get(key);
    if (current === undefined || id < current.sourceId) {
      representatives.set(key, {
        sourceId: id,
        projectId,
        sourceAt: row.created_at,
      });
    }
  }
  for (const item of representatives.values()) {
    created += await insertGroupDelivery(
      "NOTIFICATION",
      item.sourceId,
      item.projectId,
      item.sourceAt,
    );
  }
  lastGroupNotificationId = maxNotificationId;

  const activities = await pool.query(
    [
      "select a.id, a.project_id, a.visibility_scope, a.occurred_at, a.activity_type, a.source_entity_type",
      "from app.activity_projection a",
      "where a.id > $1",
      "order by a.id asc",
      "limit 200",
    ].join(" "),
    [lastActivityId],
  );
  let maxActivityId = lastActivityId;
  for (const row of activities.rows) {
    const id = Number(row.id);
    if (id > maxActivityId) maxActivityId = id;
    if (row.visibility_scope !== "MEMBER") continue;
    const projectId = Number(row.project_id);
    const category = groupCategoryForActivity(
      row.activity_type,
      row.source_entity_type,
    );
    if (!groupCategoryIsEnabled(category, notificationOptions.get(projectId))) {
      continue;
    }
    created += await insertGroupDelivery(
      "ACTIVITY",
      id,
      projectId,
      row.occurred_at,
    );
  }
  lastActivityId = maxActivityId;
  return created;
}

async function pollOnce() {
  await reloadRecipients();
  let materialized = 0;
  try {
    materialized = await materializeGroupDeliveries();
  } catch (error) {
    log(
      "群投递物化失败（本轮仅跳过物化）:",
      error && error.message ? error.message : String(error),
    );
  }
  const result = await pool.query(POLL_SQL, [lastId]);
  let delivered = 0;
  for (const row of result.rows) {
    lastId = Math.max(lastId, Number(row.id));
    if (!forwardAll && !forwardTypes.has(row.notification_type)) continue;
    const wecomUserId = recipients.get(String(row.recipient_id));
    if (!wecomUserId) {
      log(
        "跳过（该用户未绑定企业微信）: 通知",
        row.id,
        "-> 用户",
        row.recipient_id,
        row.notification_type,
        row.title,
      );
      continue;
    }
    const card = buildCard(row);
    if (dryRun) {
      log("[dry-run] 将发送给", wecomUserId, ":");
      console.log(JSON.stringify(card, null, 2));
    } else {
      appendCommand("raw " + wecomUserId + " " + JSON.stringify(card));
      log(
        "已投递发送队列: 通知",
        row.id,
        "[" + row.notification_type + "] ->",
        card.template_card.main_title.title,
      );
    }
    delivered += 1;
  }
  return { rows: result.rows.length, delivered, materialized };
}

function persistState() {
  writeFileSync(
    stateFile,
    JSON.stringify({
      lastId: lastId,
      lastGroupNotificationId: lastGroupNotificationId,
      lastActivityId: lastActivityId,
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

async function main() {
  log(
    "通知桥 v6 启动",
    dryRun ? "(dry-run)" : "(实发)",
    "| 转发范围:",
    forwardAll ? "全部类型" : [...forwardTypes].join(","),
    "| 卡片动作链接:",
    cardActionUrl,
  );
  const state = loadState();
  lastId = state.lastId;
  if (
    lastId === null &&
    Number.isInteger(config.startFromId) &&
    config.startFromId >= 0
  ) {
    lastId = config.startFromId;
  }
  if (lastId === null) {
    lastId = await currentMaxId();
    log("无状态文件且未指定 startFromId，从当前最大 id 之后开始:", lastId);
  } else {
    log("从 id >", lastId, "开始轮询");
  }
  lastGroupNotificationId = state.lastGroupNotificationId;
  if (
    lastGroupNotificationId === null &&
    Number.isInteger(config.startFromGroupNotificationId) &&
    config.startFromGroupNotificationId >= 0
  ) {
    lastGroupNotificationId = config.startFromGroupNotificationId;
  }
  if (lastGroupNotificationId === null) {
    lastGroupNotificationId = await currentMaxId();
    log(
      "群投递：通知游标从当前最大通知 id 之后开始",
      lastGroupNotificationId,
      "（不回补历史）",
    );
  }
  lastActivityId = state.lastActivityId;
  if (
    lastActivityId === null &&
    Number.isInteger(config.startFromActivityId) &&
    config.startFromActivityId >= 0
  ) {
    lastActivityId = config.startFromActivityId;
  }
  if (lastActivityId === null) {
    lastActivityId = await currentMaxActivityId();
    log(
      "群投递：动态游标从当前最大动态 id 之后开始",
      lastActivityId,
      "（只投递此后新增的 MEMBER 可见动态）",
    );
  }
  log(
    "群投递物化:",
    groupDeliveriesEnabled && !dryRun ? "已启用" : "未启用",
    "| 通知游标",
    lastGroupNotificationId,
    "| 动态游标",
    lastActivityId,
  );
  if (!dryRun) persistState();

  for (;;) {
    iterations += 1;
    try {
      const outcome = await pollOnce();
      if (outcome.rows > 0 || outcome.materialized > 0) {
        log(
          "本轮读取",
          outcome.rows,
          "条，投递",
          outcome.delivered,
          "条，群投递物化",
          outcome.materialized,
          "条，lastId =",
          lastId,
        );
        if (!dryRun) persistState();
      }
    } catch (error) {
      log("轮询失败:", error && error.message ? error.message : String(error));
    }
    if (maxIterations !== null && iterations >= maxIterations) {
      log("已达 maxIterations =", maxIterations, "，退出");
      break;
    }
    await new Promise((done) => setTimeout(done, pollIntervalMs));
  }
  await pool.end();
  process.exit(0);
}

main().catch((error) => {
  console.error("桥接进程异常退出:", error);
  process.exit(1);
});

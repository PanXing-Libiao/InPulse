// InPulse x 企业微信智能机器人（长连接）PoC 验证脚本
// 用途：验证 aibot_subscribe 订阅、回调接收、aibot_send_msg 主动推送
// 用法：node wecom-long-conn-poc.mjs <config.json>
// 说明：临时验证工具，不进入 InPulse 仓库，不承载生产逻辑。
// 2026-10-13 改造（ADR-070 桥接侧批次）：
//   机器人凭据不再写在 config.json，改为从 InPulse 数据库 app.wecom_robot_config
//   读取 AES-256-GCM 密文，用同一 keyring 文件解密；轮询 row_version，
//   管理员在设置页保存新机器人后本进程自动重连生效。
//   config.json 键：databaseUrl、keyringFile、configPollMs；
//   仍兼容旧的静态键 botId/secret（静态模式不轮询、不自动重连）。
// 2026-10-16 改造（进入会话欢迎语 + 限频）：
//   进入会话不再回显 PoC 调试文案，改为欢迎语：未绑定用户给「把绑定码发给我」的引导
//   （默认 10 分钟最多一条），已绑定用户只发一句简短欢迎（默认 24 小时最多一条）；
//   限频时间戳落在 welcomeStateFile（默认与命令文件同目录，容器内即 /state 下）。
//   config.json 可选键：welcomeUnboundThrottleMs、welcomeBoundThrottleMs（0 = 该类用户不再自动发）、
//   welcomeStateFile。普通文本消息的自动回复也改为按绑定状态给指引，不再回 PoC 文案。
// 2026-10-16 改造（ADR-077 第二批：项目群消息投递）：
//   消费 app.wecom_group_deliveries 的 PENDING 行（由 bridge.mjs 物化），
//   按 id 升序经 aibot_send_msg + chat_type:2 投递到绑定的项目群；
//   发送结果以响应帧 errcode 为准回写 SENT / FAILED、attempts 与 last_error
//   （失败同时截断回写绑定行 last_delivery_error），限速 30 条/分钟、
//   1000 条/小时，超限自动退避；重启后从 PENDING 断点续传。
//   config.json 可选键：groupDeliveries=false 关闭、groupDeliveryPollMs、
//   groupDeliveriesPerMinute、groupDeliveriesPerHour。
// 2026-10-20 改造（ADR-091：项目封箱彩蛋）：
//   PROJECT_WRAPPED 动态发送「封箱文案 + 海报」两段；delivered_step_count 持久化
//   已成功的段数，文本先成功、图片失败或进程重启时只续发图片。
import { readFileSync, writeFileSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import {
  BINDING_FAILURE_REASONS,
  PROJECT_BINDING_FAILURE_REASONS,
  redeemBindingCode,
  redeemProjectGroupCode,
} from "./binding-code.mjs";
import { buildGroupActivityCard } from "./group-message.mjs";
import {
  buildGroupWrapText,
  imageMessageFromPoster,
  normalizeWrapSnapshot,
  renderWrapPoster,
} from "./wrap-poster.mjs";
import { WebSocket } from "ws";
import pg from "pg";

const { Pool } = pg;
const WS_URL = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_MS = 30000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const EXTRA_PUSH_DELAY_MS = 3000;
const OPEN = 1;
const PUSH_INTERVAL_MS = 1200;
const DEFAULT_CONFIG_POLL_MS = 5000;
const DEFAULT_WELCOME_UNBOUND_THROTTLE_MS = 10 * 60 * 1000;
const DEFAULT_WELCOME_BOUND_THROTTLE_MS = 24 * 60 * 60 * 1000;
const WELCOME_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_GROUP_DELIVERY_POLL_MS = 3000;
const DEFAULT_GROUP_DELIVERIES_PER_MINUTE = 30;
const DEFAULT_GROUP_DELIVERIES_PER_HOUR = 1000;
const GROUP_DELIVERY_RESPONSE_TIMEOUT_MS = 15000;
const GROUP_DELIVERY_RETRY_BACKOFF_MS = 60000;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_AAD = Buffer.from("app.wecom_robot_config.secret", "utf8");
const KEYRING_ENTRY = /^([1-9][0-9]*)\s*:\s*([0-9a-fA-F]{64,})\s*$/;

const configPath = process.argv[2];
if (!configPath) {
  console.error("用法: node wecom-long-conn-poc.mjs <config.json>");
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(
    "读取 config.json 失败:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(2);
}

const databaseUrl =
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.trim().length > 0
    ? process.env.DATABASE_URL.trim()
    : typeof config.databaseUrl === "string"
      ? config.databaseUrl.trim()
      : "";
const keyringFile =
  typeof config.keyringFile === "string" ? config.keyringFile.trim() : "";
const dbMode = databaseUrl.length > 0;
if (dbMode && keyringFile.length === 0) {
  console.error("config.json 配置 databaseUrl 时还需要 keyringFile");
  process.exit(2);
}
if (
  !dbMode &&
  (typeof config.botId !== "string" ||
    config.botId.length === 0 ||
    typeof config.secret !== "string" ||
    config.secret.length === 0)
) {
  console.error(
    "config.json 需要 databaseUrl + keyringFile（推荐），或静态 botId 与 secret",
  );
  process.exit(2);
}

const commandFile =
  typeof config.commandFile === "string" && config.commandFile.length > 0
    ? config.commandFile
    : configPath.endsWith(".json")
      ? configPath.slice(0, -5) + "-commands.txt"
      : configPath + "-commands.txt";
const pushOnCallback = config.pushOnCallback !== false;
const extraUserIds = Array.isArray(config.extraUserIds)
  ? config.extraUserIds.filter(
      (value) => typeof value === "string" && value.length > 0,
    )
  : [];
const configPollMs =
  Number(config.configPollMs) > 0
    ? Number(config.configPollMs)
    : DEFAULT_CONFIG_POLL_MS;
const cardActionUrl =
  typeof config.cardActionUrl === "string" ? config.cardActionUrl.trim() : "";

// 进入会话欢迎语配置：未绑定用户按短窗口重复提醒绑定，已绑定用户按长窗口只问好。
const welcomeUnboundThrottleMs = readThrottleWindow(
  config.welcomeUnboundThrottleMs,
  DEFAULT_WELCOME_UNBOUND_THROTTLE_MS,
);
const welcomeBoundThrottleMs = readThrottleWindow(
  config.welcomeBoundThrottleMs,
  DEFAULT_WELCOME_BOUND_THROTTLE_MS,
);
const welcomeStateFile =
  typeof config.welcomeStateFile === "string" &&
  config.welcomeStateFile.trim().length > 0
    ? config.welcomeStateFile.trim()
    : commandFile.endsWith(".txt")
      ? commandFile.slice(0, -4) + "-welcome.json"
      : commandFile + "-welcome.json";
const groupDeliveriesEnabled = dbMode && config.groupDeliveries !== false;
const groupDeliveryPollMs = readPositiveNumber(
  config.groupDeliveryPollMs,
  DEFAULT_GROUP_DELIVERY_POLL_MS,
);
const groupDeliveriesPerMinute = readPositiveNumber(
  config.groupDeliveriesPerMinute,
  DEFAULT_GROUP_DELIVERIES_PER_MINUTE,
);
const groupDeliveriesPerHour = readPositiveNumber(
  config.groupDeliveriesPerHour,
  DEFAULT_GROUP_DELIVERIES_PER_HOUR,
);
const welcomeSentAt = new Map();
loadWelcomeState();

const pool = dbMode
  ? new Pool({ connectionString: databaseUrl, max: 2 })
  : null;

let commandOffset = 0;

function pollCommandFile() {
  let raw;
  try {
    raw = readFileSync(commandFile, "utf8");
  } catch {
    return;
  }
  if (raw.length <= commandOffset) {
    if (raw.length < commandOffset) commandOffset = 0;
    return;
  }
  const chunk = raw.slice(commandOffset);
  commandOffset = raw.length;
  for (const line of chunk.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      const preview = line.trim();
      log(
        "执行命令文件指令:",
        preview.length > 160 ? preview.slice(0, 160) + "…" : preview,
      );
    }
    handleStdinLine(line);
  }
}

let socket = null;
let seq = 0;
let subscribed = false;
let awaitingSubscribeResponse = false;
let heartbeat = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let closing = false;
let extraPushDone = false;
let activeCreds = null;
let refreshing = false;
let warnedNoConfig = false;
const observedUserIds = new Set();
const pendingCommands = new Map();

function log(...parts) {
  console.log("[" + new Date().toISOString() + "]", ...parts);
}

function nextReqId() {
  seq += 1;
  return "poc-" + seq + "-" + Date.now();
}

function sendCommand(cmd, body) {
  if (socket === null || socket.readyState !== OPEN) {
    log("连接不可用，未发送:", cmd);
    return null;
  }
  const reqId = nextReqId();
  const frame = { cmd: cmd, headers: { req_id: reqId } };
  if (body !== undefined) frame.body = body;
  socket.send(JSON.stringify(frame));
  return reqId;
}

function commandFailure(cmd, errcode, errmsg) {
  const error = new Error(
    "企业微信指令 " +
      cmd +
      " 失败：errcode " +
      String(errcode) +
      " " +
      String(errmsg === null || errmsg === undefined ? "" : errmsg),
  );
  error.errcode = Number(errcode);
  error.errmsg = String(errmsg === null || errmsg === undefined ? "" : errmsg);
  return error;
}

function requestCommand(cmd, body, timeoutMs) {
  if (socket === null || socket.readyState !== OPEN || !subscribed) {
    return Promise.reject(new Error("长连接尚未就绪，未发送: " + cmd));
  }
  const reqId = nextReqId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(reqId);
      const error = new Error(
        "企业微信指令 " +
          cmd +
          " 响应超时（" +
          String(Math.round(timeoutMs / 1000)) +
          " 秒）",
      );
      error.errcode = -1;
      error.retryable = true;
      reject(error);
    }, timeoutMs);
    pendingCommands.set(reqId, { cmd, resolve, reject, timer });
    const frame = { cmd: cmd, headers: { req_id: reqId } };
    if (body !== undefined) frame.body = body;
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      clearTimeout(timer);
      pendingCommands.delete(reqId);
      reject(error);
    }
  });
}

function loadKeyringKeys() {
  const content = readFileSync(keyringFile, "utf8");
  const keys = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = KEYRING_ENTRY.exec(line);
    if (match === null) throw new Error("keyring 行格式非法");
    keys.set(Number.parseInt(match[1], 10), Buffer.from(match[2], "hex"));
  }
  if (keys.size === 0) throw new Error("keyring 为空");
  return keys;
}

function decryptRobotSecret(ciphertext, keyVersion) {
  const keys = loadKeyringKeys();
  const key = keys.get(keyVersion);
  if (key === undefined)
    throw new Error("keyring 中缺少主密钥版本 " + keyVersion);
  const buf = Buffer.isBuffer(ciphertext)
    ? ciphertext
    : Buffer.from(ciphertext);
  if (buf.length < NONCE_BYTES + TAG_BYTES + 1) throw new Error("密文长度非法");
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const body = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(SECRET_AAD);
  decipher.setAuthTag(tag);
  const secret = Buffer.concat([
    decipher.update(body),
    decipher.final(),
  ]).toString("utf8");
  if (secret.length === 0) throw new Error("解密结果为空");
  return secret;
}

async function refreshCredentials() {
  if (pool === null || refreshing) return;
  refreshing = true;
  try {
    const result = await pool.query(
      "SELECT bot_id, secret_ciphertext, secret_key_version, row_version FROM app.wecom_robot_config WHERE id = 1",
    );
    const row = result.rows[0];
    if (row === undefined) {
      if (!warnedNoConfig) {
        warnedNoConfig = true;
        log("数据库中尚无机器人配置（等待管理员在设置页保存）");
      }
      return;
    }
    warnedNoConfig = false;
    const rowVersion = Number(row.row_version);
    if (
      activeCreds !== null &&
      activeCreds.rowVersion === rowVersion &&
      activeCreds.botId === row.bot_id
    ) {
      return;
    }
    const secret = decryptRobotSecret(
      row.secret_ciphertext,
      Number(row.secret_key_version),
    );
    const firstLoad = activeCreds === null;
    activeCreds = { botId: row.bot_id, secret: secret, rowVersion: rowVersion };
    if (firstLoad) {
      log(
        "已从数据库读取机器人配置 bot_id=" +
          row.bot_id +
          " row_version=" +
          rowVersion +
          " secret=****" +
          secret.slice(-4),
      );
      ensureConnected();
    } else {
      log(
        "检测到机器人配置变更 bot_id=" +
          row.bot_id +
          " row_version=" +
          rowVersion +
          "，自动重连",
      );
      restartConnection();
    }
  } catch (error) {
    log(
      "读取机器人配置失败（保留现状，继续等待）:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    refreshing = false;
  }
}

const pushQueue = [];
function enqueuePush(label, run) {
  pushQueue.push({ label: label, run: run });
  log("已入发送队列（" + pushQueue.length + " 条待发）:", label);
}
setInterval(() => {
  if (pushQueue.length === 0) return;
  if (socket === null || socket.readyState !== OPEN || !subscribed) return;
  const next = pushQueue.shift();
  next.run();
}, PUSH_INTERVAL_MS);

function sendMarkdown(userId, content) {
  enqueuePush("markdown -> " + userId, () => {
    const reqId = sendCommand("aibot_send_msg", {
      chatid: userId,
      chat_type: 1,
      msgtype: "markdown",
      markdown: { content: content },
    });
    if (reqId !== null) log("已发起 markdown 主动推送 ->", userId);
  });
}

function sendMarkdownToGroup(chatId, content) {
  enqueuePush("markdown -> group " + chatId, () => {
    const reqId = sendCommand("aibot_send_msg", {
      chatid: chatId,
      chat_type: 2,
      msgtype: "markdown",
      markdown: { content: content },
    });
    if (reqId !== null) log("已发起 markdown 群推送 ->", chatId);
  });
}

function sendCard(userId, title, desc, url) {
  enqueuePush("template_card -> " + userId, () => {
    const reqId = sendCommand("aibot_send_msg", {
      chatid: userId,
      chat_type: 1,
      msgtype: "template_card",
      template_card: {
        card_type: "text_notice",
        main_title: { title: title, desc: desc },
        sub_title_text: "InPulse 任务指派通知（PoC）",
        card_action: { type: 1, url: url },
      },
    });
    if (reqId !== null) log("已发起 template_card 主动推送 ->", userId);
  });
}

// ---- 项目群投递消费（ADR-077 第二批，2026-10-16）----
// ADR-093 起队列行只由 MEMBER 可见项目动态物化，不再从 app.notifications 复制；
// 升级前已排队的 NOTIFICATION 行仍保留兼容消费，避免丢失旧 PENDING 消息。
// 发送结果以 aibot_send_msg 响应帧为准回写状态；重启后从 PENDING 断点续传。

const GROUP_NEWLINE = String.fromCharCode(10);
const GROUP_PRIORITY_LABELS = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
};
const GROUP_STATUS_LABELS = {
  TODO: "未完成",
  DONE: "已完成",
  CANCELED: "已取消",
};
const GROUP_PENDING_SQL = [
  "select",
  "  d.id as delivery_id,",
  "  d.group_binding_id,",
  "  d.source_kind,",
  "  d.source_id,",
  "  d.delivered_step_count,",
  "  g.status as binding_status,",
  "  g.wecom_chat_id",
  "from app.wecom_group_deliveries d",
  "join app.project_wecom_groups g on g.id = d.group_binding_id",
  "where d.status = 'PENDING'",
  "order by d.id asc",
  "limit 1",
].join(" ");
const GROUP_NOTIFICATION_SQL = [
  "select",
  "  n.id,",
  "  n.notification_type,",
  "  n.title,",
  "  n.body as task_code,",
  "  n.source_chain_id,",
  "  n.source_sequence,",
  "  t.title as task_title,",
  "  t.priority,",
  "  t.work_status,",
  "  t.due_at,",
  "  p.name as project_name",
  "from app.notifications n",
  "left join app.tasks t",
  "  on t.id = nullif(substring(n.target_path from 'taskId=([0-9]+)'), '')::int",
  "left join app.projects p on p.id = n.project_id",
  "where n.id = $1",
].join(" ");
const GROUP_NOTIFICATION_RECIPIENTS_SQL = [
  "select u.name",
  "from app.notifications n",
  "join app.users u on u.id = n.recipient_id",
  "where n.source_chain_id = $1",
  "  and n.source_sequence = $2",
  "  and n.notification_type = $3",
  "order by n.id asc",
].join(" ");
const GROUP_ACTIVITY_SQL = [
  "select",
  "  a.id,",
  "  a.activity_type,",
  "  a.metadata,",
  "  a.summary,",
  "  a.occurred_at,",
  "  a.project_id,",
  "  p.name as project_name,",
  "  p.code as project_code,",
  "  u.name as actor_name,",
  "  m.code as module_code,",
  "  m.name as module_name,",
  "  f.code as feature_code,",
  "  f.name as feature_name,",
  "  fm.code as feature_module_code,",
  "  fm.name as feature_module_name,",
  "  t.code as task_code,",
  "  t.title as task_title,",
  "  t.priority,",
  "  t.work_status,",
  "  t.due_at,",
  "  (",
  "    select string_agg(u2.name, '、' order by ta.created_at asc, ta.user_id asc)",
  "    from app.task_assignees ta",
  "    join app.users u2 on u2.id = ta.user_id",
  "    where ta.task_id = t.id and ta.project_id = t.project_id",
  "  ) as task_assignees",
  "from app.activity_projection a",
  "left join app.projects p on p.id = a.project_id",
  "left join app.users u on u.id = a.actor_id",
  "left join app.modules m",
  "  on m.id = case when a.metadata->>'moduleId' ~ '^[0-9]+$' then (a.metadata->>'moduleId')::integer end",
  " and m.project_id = a.project_id",
  "left join app.features f",
  "  on f.id = case when a.metadata->>'featureId' ~ '^[0-9]+$' then (a.metadata->>'featureId')::integer end",
  " and f.project_id = a.project_id",
  "left join app.modules fm on fm.id = f.module_id and fm.project_id = f.project_id",
  "left join app.tasks t",
  "  on t.id = case when a.metadata->>'taskId' ~ '^[0-9]+$' then (a.metadata->>'taskId')::integer end",
  " and t.project_id = a.project_id",
  "where a.id = $1",
].join(" ");
const GROUP_WRAP_SNAPSHOT_SQL = [
  "select w.snapshot",
  "from app.project_wraps w",
  "where w.project_id = $1",
].join(" ");

const MEDIA_CHUNK_SIZE = 512 * 1024;
const MEDIA_UPLOAD_TIMEOUT_MS = 60000;

function readResponseBodyValue(frame, key) {
  if (frame && frame.body && typeof frame.body === "object") {
    const value = frame.body[key];
    if (value !== undefined && value !== null) return value;
  }
  return frame && frame[key] !== undefined ? frame[key] : undefined;
}

async function uploadImageMedia(image) {
  const base64 = String(image && image.base64 ? image.base64 : "");
  if (base64.length === 0) throw new Error("图片消息缺少 base64");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) throw new Error("图片 base64 解码为空");
  const totalChunks = Math.max(1, Math.ceil(buffer.length / MEDIA_CHUNK_SIZE));
  if (totalChunks > 100) throw new Error("图片超过企业微信 50MB 上传限制");
  const digest = createHash("md5").update(buffer).digest("hex");
  const init = await requestCommand(
    "aibot_upload_media_init",
    {
      type: "image",
      filename: "project-wrap-" + digest.slice(0, 12) + ".jpg",
      total_size: buffer.length,
      total_chunks: totalChunks,
      md5: digest,
    },
    MEDIA_UPLOAD_TIMEOUT_MS,
  );
  const uploadId = readResponseBodyValue(init, "upload_id");
  if (typeof uploadId !== "string" || uploadId.length === 0) {
    throw new Error("企业微信图片上传初始化未返回 upload_id");
  }
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunk = buffer.subarray(
      chunkIndex * MEDIA_CHUNK_SIZE,
      (chunkIndex + 1) * MEDIA_CHUNK_SIZE,
    );
    await requestCommand(
      "aibot_upload_media_chunk",
      {
        upload_id: uploadId,
        chunk_index: chunkIndex,
        base64_data: chunk.toString("base64"),
      },
      MEDIA_UPLOAD_TIMEOUT_MS,
    );
  }
  const finish = await requestCommand(
    "aibot_upload_media_finish",
    { upload_id: uploadId },
    MEDIA_UPLOAD_TIMEOUT_MS,
  );
  const mediaId = readResponseBodyValue(finish, "media_id");
  if (typeof mediaId !== "string" || mediaId.length === 0) {
    throw new Error("企业微信图片上传完成未返回 media_id");
  }
  return mediaId;
}

async function sendImageMessage(chatId, chatType, image) {
  const mediaId = await uploadImageMedia(image);
  return requestCommand(
    "aibot_send_msg",
    {
      chatid: chatId,
      chat_type: chatType,
      msgtype: "image",
      image: { media_id: mediaId },
    },
    GROUP_DELIVERY_RESPONSE_TIMEOUT_MS,
  );
}

async function sendImageToUser(userId, image) {
  try {
    await sendImageMessage(userId, 1, image);
    log("企业微信图片主动推送成功 ->", userId);
  } catch (error) {
    log(
      "企业微信图片主动推送失败 ->",
      userId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

let groupDeliveryBusy = false;
let groupDeliveryRateLogAt = 0;
const groupSendTimestamps = [];
const groupDeliveryBackoffUntil = new Map();

function clampGroupText(value, maxChars) {
  const text = String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}

function formatGroupTime(value) {
  if (value === null || value === undefined) return "";
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

function groupSendCountSince(now, windowMs) {
  const from = now - windowMs;
  let count = 0;
  for (let index = groupSendTimestamps.length - 1; index >= 0; index -= 1) {
    if (groupSendTimestamps[index] >= from) count += 1;
    else break;
  }
  return count;
}

function pruneGroupSendTimestamps(now) {
  const cutoff = now - 60 * 60 * 1000;
  let remove = 0;
  while (
    remove < groupSendTimestamps.length &&
    groupSendTimestamps[remove] < cutoff
  ) {
    remove += 1;
  }
  if (remove > 0) groupSendTimestamps.splice(0, remove);
}

async function buildGroupNotificationContent(sourceId) {
  const detail = await pool.query(GROUP_NOTIFICATION_SQL, [sourceId]);
  const item = detail.rows[0];
  if (item === undefined) return null;
  if (item.notification_type !== "task.assigned") {
    const projectName = clampGroupText(item.project_name, 40);
    const lines = [
      projectName.length > 0
        ? "**【" + projectName + "】项目通知**"
        : "**【项目通知】**",
    ];
    const title = clampGroupText(item.title, 60);
    if (title.length > 0) lines.push("**" + title + "**");
    return lines.join(GROUP_NEWLINE);
  }
  const recipients = await pool.query(GROUP_NOTIFICATION_RECIPIENTS_SQL, [
    item.source_chain_id,
    item.source_sequence,
    item.notification_type,
  ]);
  const names = [];
  for (const row of recipients.rows) {
    const name = clampGroupText(row.name, 30);
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  const projectName = clampGroupText(item.project_name, 40);
  const lines = [
    projectName.length > 0
      ? "**【" + projectName + "】新任务指派**"
      : "**【新任务指派】**",
  ];
  const taskTitle = clampGroupText(
    item.task_title === null || item.task_title === undefined
      ? item.title
      : item.task_title,
    60,
  );
  if (taskTitle.length > 0) lines.push("**" + taskTitle + "**");
  const headMeta = [];
  const code = clampGroupText(item.task_code, 40);
  if (code.length > 0) headMeta.push("编号 " + code);
  headMeta.push("指派给 " + (names.length > 0 ? names.join("、") : "（未知）"));
  lines.push(headMeta.join(" ｜ "));
  const taskMeta = [];
  const priority = GROUP_PRIORITY_LABELS[item.priority];
  if (priority !== undefined) taskMeta.push("优先级 " + priority);
  const status = GROUP_STATUS_LABELS[item.work_status];
  if (status !== undefined) taskMeta.push("状态 " + status);
  const due = formatGroupTime(item.due_at);
  if (due.length > 0) taskMeta.push("截止 " + due);
  if (taskMeta.length > 0) lines.push(taskMeta.join(" ｜ "));
  return lines.join(GROUP_NEWLINE);
}

async function buildGroupActivityMessages(sourceId) {
  const detail = await pool.query(GROUP_ACTIVITY_SQL, [sourceId]);
  const item = detail.rows[0];
  if (item === undefined) return null;
  if (item.activity_type === "PROJECT_WRAPPED") {
    const projectId = Number(item.project_id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new Error("项目封箱动态缺少有效 project_id");
    }
    const wrapResult = await pool.query(GROUP_WRAP_SNAPSHOT_SQL, [projectId]);
    const wrap = wrapResult.rows[0];
    if (wrap === undefined) {
      throw new Error("项目封箱快照不存在");
    }
    const snapshot = normalizeWrapSnapshot(wrap.snapshot);
    const messages = [
      {
        msgtype: "markdown",
        markdown: { content: buildGroupWrapText(snapshot) },
      },
    ];
    try {
      const poster = await renderWrapPoster({ snapshot });
      messages.push(imageMessageFromPoster(poster));
    } catch (error) {
      log(
        "项目封箱群海报渲染失败，降级为纯文本: 项目",
        projectId,
        error instanceof Error ? error.message : String(error),
      );
    }
    return messages;
  }
  return [buildGroupActivityCard(item, { cardActionUrl: cardActionUrl })];
}

async function buildGroupNotificationMessages(sourceId) {
  const content = await buildGroupNotificationContent(sourceId);
  if (content === null || content.trim().length === 0) return null;
  return [
    {
      msgtype: "markdown",
      markdown: { content: content },
    },
  ];
}

async function markGroupDeliverySent(deliveryId, bindingId) {
  await pool.query(
    [
      "update app.wecom_group_deliveries",
      "set status = 'SENT', sent_at = now(), attempts = attempts + 1, last_error = null",
      "where id = $1",
    ].join(" "),
    [deliveryId],
  );
  await pool.query(
    [
      "update app.project_wecom_groups",
      "set last_delivery_error = null, updated_at = now()",
      "where id = $1 and last_delivery_error is not null",
    ].join(" "),
    [bindingId],
  );
}

async function markGroupDeliveryFailed(deliveryId, bindingId, reason) {
  const text = clampGroupText(reason, 500) || "未知错误";
  await pool.query(
    [
      "update app.wecom_group_deliveries",
      "set status = 'FAILED', attempts = attempts + 1, last_error = $2",
      "where id = $1",
    ].join(" "),
    [deliveryId, text],
  );
  await pool.query(
    [
      "update app.project_wecom_groups",
      "set last_delivery_error = $2, updated_at = now()",
      "where id = $1 and status = 'ACTIVE'",
    ].join(" "),
    [bindingId, text],
  );
  log("群投递失败：投递行", deliveryId, "绑定行", bindingId, "原因:", text);
}

async function keepGroupDeliveryForRetry(deliveryId, note) {
  groupDeliveryBackoffUntil.set(
    deliveryId,
    Date.now() + GROUP_DELIVERY_RETRY_BACKOFF_MS,
  );
  await pool.query(
    [
      "update app.wecom_group_deliveries",
      "set attempts = attempts + 1, last_error = $2",
      "where id = $1 and status = 'PENDING'",
    ].join(" "),
    [deliveryId, clampGroupText(note, 500) || "稍后重试"],
  );
}

function summarizeGroupMessage(message) {
  if (message && message.msgtype === "image") {
    const base64 = String(
      message.image && message.image.base64 ? message.image.base64 : "",
    );
    return (
      "image md5=" +
      String(message.image && message.image.md5) +
      " bytes=" +
      base64.length
    );
  }
  if (message && message.msgtype === "template_card") {
    return (
      "template_card(" +
      clampGroupText(
        String(
          message.template_card &&
            message.template_card.main_title &&
            message.template_card.main_title.title,
        ),
        80,
      ) +
      ")"
    );
  }
  if (message && message.msgtype === "markdown") {
    return clampGroupText(
      String(message.markdown && message.markdown.content)
        .split(GROUP_NEWLINE)
        .join(" / "),
      140,
    );
  }
  return message && message.msgtype ? String(message.msgtype) : "unknown";
}

function isRetryableGroupSendError(errcode, errmsg) {
  if (errcode === 45009) return true;
  const text = String(errmsg === null || errmsg === undefined ? "" : errmsg);
  return /限|频繁|too many|rate|limit/i.test(text);
}

function isRetryableCommandFailure(error) {
  if (error && error.retryable === true) return true;
  const errcode = Number(error && error.errcode);
  return (
    Number.isFinite(errcode) &&
    isRetryableGroupSendError(errcode, error && error.errmsg)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordGroupDeliveryStep(deliveryId, deliveredStepCount) {
  await pool.query(
    [
      "update app.wecom_group_deliveries",
      "set delivered_step_count = $2",
      "where id = $1 and status = 'PENDING'",
    ].join(" "),
    [deliveryId, deliveredStepCount],
  );
}

async function sendGroupMessage(chatId, message) {
  if (message && message.msgtype === "image") {
    await sendImageMessage(chatId, 2, message.image);
    return;
  }
  await requestCommand(
    "aibot_send_msg",
    Object.assign(
      {
        chatid: chatId,
        chat_type: 2,
      },
      message,
    ),
    GROUP_DELIVERY_RESPONSE_TIMEOUT_MS,
  );
}

async function pollGroupDeliveries() {
  if (!groupDeliveriesEnabled || pool === null || groupDeliveryBusy) return;
  if (!subscribed || socket === null || socket.readyState !== OPEN) return;
  groupDeliveryBusy = true;
  try {
    const pending = await pool.query(GROUP_PENDING_SQL);
    const row = pending.rows[0];
    if (row === undefined) return;
    const now = Date.now();
    const deliveryId = Number(row.delivery_id);
    const bindingId = Number(row.group_binding_id);
    const backoffUntil = groupDeliveryBackoffUntil.get(deliveryId);
    if (backoffUntil !== undefined && backoffUntil > now) return;
    if (row.binding_status !== "ACTIVE") {
      await markGroupDeliveryFailed(
        deliveryId,
        bindingId,
        "群绑定已解绑，消息未投递",
      );
      return;
    }
    let messages = null;
    try {
      if (row.source_kind === "NOTIFICATION") {
        messages = await buildGroupNotificationMessages(Number(row.source_id));
      } else if (row.source_kind === "ACTIVITY") {
        messages = await buildGroupActivityMessages(Number(row.source_id));
      }
    } catch (error) {
      await markGroupDeliveryFailed(
        deliveryId,
        bindingId,
        "来源数据无法生成群消息：" +
          (error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    if (messages === null || messages.length === 0) {
      await markGroupDeliveryFailed(
        deliveryId,
        bindingId,
        "来源数据不存在，无法生成群消息",
      );
      return;
    }
    let stepIndex = Math.max(0, Number(row.delivered_step_count) || 0);
    if (stepIndex >= messages.length) {
      await markGroupDeliverySent(deliveryId, bindingId);
      log(
        "群投递各分段均已成功，补记送达：投递行",
        deliveryId,
        "绑定行",
        bindingId,
      );
      return;
    }
    while (stepIndex < messages.length) {
      const sendNow = Date.now();
      pruneGroupSendTimestamps(sendNow);
      if (
        groupSendCountSince(sendNow, 60 * 1000) >= groupDeliveriesPerMinute ||
        groupSendCountSince(sendNow, 60 * 60 * 1000) >= groupDeliveriesPerHour
      ) {
        if (sendNow - groupDeliveryRateLogAt > 60000) {
          groupDeliveryRateLogAt = sendNow;
          log("群投递达到机器人限速窗口，窗口释放后自动继续");
        }
        return;
      }
      const message = messages[stepIndex];
      groupSendTimestamps.push(sendNow);
      log(
        "已发起群投递：投递行",
        deliveryId,
        "绑定行",
        bindingId,
        "分段",
        String(stepIndex + 1) + "/" + String(messages.length),
        "-> 群",
        row.wecom_chat_id,
      );
      log("  消息内容:", summarizeGroupMessage(message));
      try {
        await sendGroupMessage(row.wecom_chat_id, message);
      } catch (error) {
        const errorText =
          error instanceof Error ? error.message : String(error);
        if (isRetryableCommandFailure(error)) {
          await keepGroupDeliveryForRetry(
            deliveryId,
            "限速/临时错误，稍后重试：" + errorText,
          );
          log(
            "群投递遇到限速/临时错误，保持 PENDING 稍后重试：投递行",
            deliveryId,
            "分段",
            String(stepIndex + 1) + "/" + String(messages.length),
            errorText,
          );
        } else {
          await markGroupDeliveryFailed(
            deliveryId,
            bindingId,
            "分段 " +
              String(stepIndex + 1) +
              "/" +
              String(messages.length) +
              " 发送失败：" +
              errorText,
          );
        }
        return;
      }
      stepIndex += 1;
      await recordGroupDeliveryStep(deliveryId, stepIndex);
      groupDeliveryBackoffUntil.delete(deliveryId);
      log(
        "群投递分段已送达：投递行",
        deliveryId,
        "分段",
        String(stepIndex) + "/" + String(messages.length),
      );
      if (stepIndex < messages.length) await wait(1200);
    }
    await markGroupDeliverySent(deliveryId, bindingId);
    log("群投递已送达：投递行", deliveryId, "绑定行", bindingId);
  } finally {
    groupDeliveryBusy = false;
  }
}

function onSubscribed() {
  log("订阅成功：长连接已就绪，等待回调或主动推送");
  if (extraUserIds.length > 0 && !extraPushDone) {
    extraPushDone = true;
    setTimeout(() => {
      for (const userId of extraUserIds) {
        log("向配置中的 extraUserIds 推送（验证未交互用户能否收到）:", userId);
        sendMarkdown(
          userId,
          "**InPulse PoC**" +
            String.fromCharCode(10) +
            "这是一条给未交互用户的主动推送测试消息。",
        );
      }
    }, EXTRA_PUSH_DELAY_MS);
  }
}

// 欢迎语与自动回复文案（企业微信 markdown）。
const WELCOME_BOUND_TEXT = [
  "**你好，我是 InPulse 任务提醒机器人**",
  "",
  "任务指派、完成等提醒会发到这里。",
].join("\n");
const WELCOME_UNBOUND_TEXT = [
  "**你好，我是 InPulse 任务提醒机器人**",
  "",
  "把 InPulse 里生成的**绑定码**发给我即可完成绑定，之后派给你的任务会在这里提醒你。",
  "",
  "绑定码在 InPulse 网页右上角「账户菜单 → 绑定企业微信」里生成。",
].join("\n");
const REPLY_BOUND_TEXT = [
  "**消息已收到**",
  "",
  "我负责发送 InPulse 的任务提醒；需要解绑或重新绑定请在 InPulse 网页的账户菜单里操作。",
].join("\n");
const REPLY_UNBOUND_TEXT = [
  "**这不像是一个绑定码**",
  "",
  "绑定码请在 InPulse 网页右上角「账户菜单 → 绑定企业微信」里生成，生成后把码发给我即可完成绑定。",
].join("\n");

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readThrottleWindow(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadWelcomeState() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(welcomeStateFile, "utf8"));
  } catch {
    // 首次运行或文件不可读：从空状态开始（最多重启后多发一条欢迎语）
    return;
  }
  const sentAt = parsed && typeof parsed === "object" ? parsed.sentAt : null;
  if (sentAt === null || typeof sentAt !== "object") return;
  for (const [key, value] of Object.entries(sentAt)) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      welcomeSentAt.set(key, timestamp);
    }
  }
}

function persistWelcomeState() {
  const cutoff = Date.now() - WELCOME_STATE_RETENTION_MS;
  const sentAt = {};
  for (const [key, value] of welcomeSentAt) {
    if (value >= cutoff) sentAt[key] = value;
  }
  try {
    writeFileSync(
      welcomeStateFile,
      JSON.stringify({ sentAt: sentAt, updatedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch (error) {
    log(
      "写入欢迎语状态失败（本次仅内存限频生效）:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// 该企业微信用户在本地库是否有 ACTIVE 绑定；返回 null 表示无法判断（无数据库或查询失败）。
async function isWecomUserBound(wecomUserId) {
  if (!dbMode || pool === null) return null;
  try {
    const result = await pool.query(
      "select 1 from app.user_wecom_bindings where wecom_userid = $1 and status = 'ACTIVE' limit 1",
      [wecomUserId],
    );
    return result.rows.length > 0;
  } catch (error) {
    log(
      "读取绑定状态失败（本轮按已绑定处理，只发简短欢迎）:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function sendEnterChatWelcomeIfDue(wecomUserId) {
  const bound = await isWecomUserBound(wecomUserId);
  const unbound = bound === false;
  const throttleMs = unbound
    ? welcomeUnboundThrottleMs
    : welcomeBoundThrottleMs;
  if (throttleMs <= 0) {
    log("进入会话欢迎语已关闭（限频窗口为 0），跳过:", wecomUserId);
    return;
  }
  const now = Date.now();
  const lastSentAt = welcomeSentAt.get(wecomUserId) ?? 0;
  if (now - lastSentAt < throttleMs) {
    log(
      "跳过进入会话欢迎语（限频中，还剩 " +
        Math.ceil((throttleMs - (now - lastSentAt)) / 1000) +
        " 秒）:",
      wecomUserId,
    );
    return;
  }
  welcomeSentAt.set(wecomUserId, now);
  persistWelcomeState();
  log(
    "发送进入会话欢迎语:",
    wecomUserId,
    unbound ? "(未绑定)" : "(已绑定/未知)",
  );
  sendMarkdown(
    wecomUserId,
    unbound ? WELCOME_UNBOUND_TEXT : WELCOME_BOUND_TEXT,
  );
}

async function tryRedeemBindingCode(rawText, wecomUserId) {
  if (!dbMode || pool === null) return false;
  const result = await redeemBindingCode(pool, rawText, wecomUserId);
  if (result.outcome === "not-a-code") return false;
  if (result.outcome === "bound") {
    log(
      "绑定码兑换成功：wecom userid =",
      wecomUserId,
      "-> InPulse 用户",
      result.userId,
      result.displayName,
    );
    sendMarkdown(
      wecomUserId,
      "**绑定成功**" +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        "已绑定 InPulse 账号「" +
        result.displayName +
        "」。指派给你的任务会由我在这里提醒你。",
    );
  } else {
    log(
      "绑定码兑换失败：userid =",
      wecomUserId,
      "sqlstate =",
      result.sqlState,
      "message =",
      result.error && result.error.message
        ? result.error.message
        : String(result.error),
    );
    sendMarkdown(
      wecomUserId,
      "**绑定未完成**" +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        (BINDING_FAILURE_REASONS[result.sqlState] ||
          BINDING_FAILURE_REASONS.UNKNOWN),
    );
  }
  return true;
}

async function tryRedeemProjectGroupCode(rawText, wecomChatId, wecomUserId) {
  if (!dbMode || pool === null) return false;
  const result = await redeemProjectGroupCode(
    pool,
    rawText,
    wecomChatId,
    wecomUserId,
  );
  if (result.outcome === "not-a-code") return false;
  if (result.outcome === "bound") {
    log(
      "项目群绑定成功：chat =",
      wecomChatId,
      "project =",
      result.projectId,
      result.projectName,
      "rebound =",
      result.rebound,
    );
    sendMarkdownToGroup(
      wecomChatId,
      (result.rebound ? "**群绑定已更新**" : "**绑定成功**") +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        (result.rebound
          ? "本群已重新绑定到 InPulse 项目「" + result.projectName + "」。"
          : "本群已绑定 InPulse 项目「" +
            result.projectName +
            "」。如需解绑请在 InPulse 项目页操作。"),
    );
  } else {
    log(
      "项目群绑定失败：chat =",
      wecomChatId,
      "userid =",
      wecomUserId,
      "sqlstate =",
      result.sqlState,
      "message =",
      result.error && result.error.message
        ? result.error.message
        : String(result.error),
    );
    sendMarkdownToGroup(
      wecomChatId,
      "**绑定未完成**" +
        String.fromCharCode(10) +
        String.fromCharCode(10) +
        (PROJECT_BINDING_FAILURE_REASONS[result.sqlState] ||
          PROJECT_BINDING_FAILURE_REASONS.UNKNOWN),
    );
  }
  return true;
}

async function handleCallback(frame) {
  const body = frame.body || {};
  const userId = body.from && body.from.userid ? body.from.userid : null;
  if (userId !== null && !observedUserIds.has(userId)) {
    observedUserIds.add(userId);
    log("发现用户 userid:", userId);
  }
  console.log("  原始回调:", JSON.stringify(frame).slice(0, 1200));
  if (frame.cmd === "aibot_event_callback") {
    const eventType =
      body.event && body.event.eventtype ? body.event.eventtype : "unknown";
    log(
      "收到事件回调:",
      eventType,
      "userid=",
      userId,
      "chattype=",
      body.chattype,
    );
    if (eventType === "disconnected_event") {
      log("本连接已被新连接踢下线（单个机器人同时只允许一条长连接）");
      return;
    }
    if (
      eventType === "enter_chat" &&
      pushOnCallback &&
      userId !== null &&
      body.chattype !== "group"
    ) {
      // 欢迎语按绑定状态 + 限频窗口发送，不再回显 PoC 调试文案。
      await sendEnterChatWelcomeIfDue(userId);
    }
    return;
  }
  const msgType = body.msgtype || "unknown";
  log("收到消息回调:", msgType, "userid=", userId, "chattype=", body.chattype);
  const isGroupChat =
    body.chattype === "group" &&
    typeof body.chatid === "string" &&
    body.chatid.length > 0;
  if (msgType === "text" && body.text && body.text.content) {
    const content = String(body.text.content);
    log("  文本内容:", content.slice(0, 100));
    if (isGroupChat && userId !== null) {
      const handled = await tryRedeemProjectGroupCode(
        content,
        body.chatid,
        userId,
      );
      if (handled) return;
      log("  群消息不是项目绑定码，保持安静");
      return;
    }
    if (userId !== null) {
      const handled = await tryRedeemBindingCode(content, userId);
      if (handled) return;
    }
  }
  if (pushOnCallback && userId !== null && !isGroupChat) {
    // 不是绑定码：按绑定状态给下一步指引（未绑定引导去生成绑定码）。
    const bound = await isWecomUserBound(userId);
    sendMarkdown(
      userId,
      bound === false ? REPLY_UNBOUND_TEXT : REPLY_BOUND_TEXT,
    );
  }
}

function handleFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    log("收到非 JSON 帧:", String(raw).slice(0, 200));
    return;
  }
  const cmd = frame.cmd;
  if (cmd === "pong") return;
  if (cmd === "aibot_msg_callback" || cmd === "aibot_event_callback") {
    void handleCallback(frame).catch((error) => {
      log(
        "回调处理异常:",
        error && error.message ? error.message : String(error),
      );
    });
    return;
  }
  if (typeof frame.errcode === "number") {
    log(
      "收到响应:",
      frame.headers && frame.headers.req_id,
      "errcode=" + frame.errcode,
      "errmsg=" + (frame.errmsg || ""),
    );
    if (awaitingSubscribeResponse) {
      awaitingSubscribeResponse = false;
      if (frame.errcode === 0) {
        subscribed = true;
        reconnectDelay = RECONNECT_BASE_MS;
        onSubscribed();
      } else {
        log("订阅未成功，关闭当前连接并按退避重试");
        const ws = socket;
        socket = null;
        if (ws !== null) {
          try {
            ws.close();
          } catch {
            /* connection already closed */
          }
        }
        scheduleReconnect();
      }
    }
    const responseReqId =
      frame.headers && typeof frame.headers.req_id === "string"
        ? frame.headers.req_id
        : null;
    const pending =
      responseReqId === null ? undefined : pendingCommands.get(responseReqId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pendingCommands.delete(responseReqId);
      if (frame.errcode === 0) {
        pending.resolve(frame);
      } else {
        pending.reject(
          commandFailure(pending.cmd, frame.errcode, frame.errmsg),
        );
      }
      return;
    }
    return;
  }
  log("未识别帧:", JSON.stringify(frame).slice(0, 500));
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    if (subscribed) sendCommand("ping", undefined);
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function scheduleReconnect() {
  if (closing || reconnectTimer !== null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  log("将在", delay, "毫秒后重连");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function ensureConnected() {
  if (closing || socket !== null || reconnectTimer !== null) return;
  connect();
}

function connect() {
  if (closing) return;
  if (activeCreds === null) {
    log("尚无可用机器人配置，暂不连接");
    return;
  }
  log("连接", WS_URL, "bot_id=" + activeCreds.botId);
  const ws = new WebSocket(WS_URL, { handshakeTimeout: 15000 });
  socket = ws;

  ws.on("open", () => {
    if (socket !== ws) return;
    log("WebSocket 握手成功，发送 aibot_subscribe");
    awaitingSubscribeResponse = true;
    const reqId = sendCommand("aibot_subscribe", {
      bot_id: activeCreds.botId,
      secret: activeCreds.secret,
    });
    if (reqId === null) {
      awaitingSubscribeResponse = false;
      try {
        ws.close();
      } catch {
        /* connection already closed */
      }
      return;
    }
    startHeartbeat();
  });

  ws.on("message", (data) => {
    if (socket !== ws) return;
    handleFrame(data.toString("utf8"));
  });

  ws.on("close", (code, reason) => {
    log("连接关闭 code=", code, "reason=", reason ? reason.toString() : "");
    if (socket !== ws) return;
    socket = null;
    subscribed = false;
    awaitingSubscribeResponse = false;
    stopHeartbeat();
    if (!closing) scheduleReconnect();
  });

  ws.on("error", (error) => {
    if (socket !== ws) return;
    log("连接错误:", error && error.message ? error.message : String(error));
  });
}

function restartConnection() {
  reconnectDelay = RECONNECT_BASE_MS;
  subscribed = false;
  awaitingSubscribeResponse = false;
  stopHeartbeat();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const old = socket;
  socket = null;
  if (old !== null) {
    try {
      old.close();
    } catch {
      /* connection already closed */
    }
  }
  log("准备使用新配置重连（500 毫秒后）");
  setTimeout(() => {
    if (!closing && socket === null) connect();
  }, 500);
}

function shutdown() {
  closing = true;
  stopHeartbeat();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket !== null) socket.close();
  log("已退出");
  process.exit(0);
}

function handleStdinLine(line) {
  const text = line.trim();
  if (text.length === 0) return;
  const parts = text.split(" ");
  const command = parts[0];
  if (command === "quit" || command === "exit") {
    shutdown();
    return;
  }
  if (command === "ping") {
    sendCommand("ping", undefined);
    return;
  }
  if (command === "users") {
    log("已观察到的 userid:", [...observedUserIds].join(", ") || "(无)");
    return;
  }
  if (command === "whoami" || command === "config") {
    if (activeCreds === null) {
      log("当前无机器人配置");
    } else {
      log(
        "当前机器人 bot_id=" +
          activeCreds.botId +
          " row_version=" +
          (dbMode ? activeCreds.rowVersion : "(静态)"),
      );
    }
    return;
  }
  if (command === "push" || command === "card") {
    const userId = parts[1];
    if (!userId) {
      log("用法: push <userid> [文本] 或 card <userid> [文本]");
      return;
    }
    const rest = parts
      .slice(2)
      .join(" ")
      .replaceAll("\\n", String.fromCharCode(10));
    if (command === "push") {
      sendMarkdown(
        userId,
        rest.length > 0
          ? rest
          : "**InPulse PoC**" +
              String.fromCharCode(10) +
              "手动触发的主动推送。",
      );
    } else {
      sendCard(
        userId,
        "任务指派：PoC 卡片",
        rest.length > 0 ? rest : "手动触发",
        "https://example.com",
      );
    }
    return;
  }
  if (command === "raw") {
    const userId = parts[1];
    if (!userId || parts.length < 3) {
      log("用法: raw <userid> <JSON>");
      return;
    }
    const jsonText = parts.slice(2).join(" ");
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch (error) {
      log(
        "raw 指令 JSON 解析失败:",
        error && error.message ? error.message : String(error),
      );
      return;
    }
    if (payload && payload.msgtype === "image") {
      enqueuePush("image -> " + userId, () => {
        void sendImageToUser(userId, payload.image);
      });
      return;
    }
    enqueuePush("raw -> " + userId, () => {
      const reqId = sendCommand(
        "aibot_send_msg",
        Object.assign({ chatid: userId, chat_type: 1 }, payload),
      );
      if (reqId !== null) log("已发起 raw 推送 ->", userId);
    });
    return;
  }
  log(
    "可用命令: push <userid> [文本] | card <userid> | raw <userid> <JSON> | ping | users | config | quit",
  );
}

process.on("SIGINT", shutdown);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) handleStdinLine(line);
});

try {
  commandOffset = readFileSync(commandFile, "utf8").length;
} catch {
  commandOffset = 0;
}
setInterval(pollCommandFile, 1000);
log("命令文件:", commandFile);
log("InPulse x 企业微信智能机器人长连接 PoC 启动");
log("观察 userid：在企业微信里给机器人发一条消息，或直接进入机器人会话");

if (dbMode) {
  log("机器人凭据来源：数据库，每 " + configPollMs + " 毫秒检查配置变更");
  await refreshCredentials();
  if (activeCreds === null) {
    log("首次读取配置未成功，将按轮询自动重试");
  }
  setInterval(() => {
    refreshCredentials();
  }, configPollMs);
  if (groupDeliveriesEnabled) {
    setInterval(() => {
      pollGroupDeliveries().catch((error) => {
        log(
          "群投递轮询异常:",
          error instanceof Error ? error.message : String(error),
        );
      });
    }, groupDeliveryPollMs);
    log(
      "项目群投递：每 " +
        groupDeliveryPollMs +
        " 毫秒检查一次 PENDING 队列（限速 " +
        groupDeliveriesPerMinute +
        " 条/分钟、" +
        groupDeliveriesPerHour +
        " 条/小时）",
    );
  } else {
    log("项目群投递未启用（groupDeliveries=false 或未配置数据库）");
  }
} else {
  activeCreds = { botId: config.botId, secret: config.secret, rowVersion: 0 };
  log("机器人凭据来源：config.json 静态配置 bot_id=" + activeCreds.botId);
  connect();
}

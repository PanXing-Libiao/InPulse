// ADR-105：企业微信群机器人 Webhook 发送层。纯函数与可注入 fetch，测试不访问真实企业微信。
import { createDecipheriv } from "node:crypto";

export const WEBHOOK_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const WEBHOOK_DEFAULT_RATE_PER_MINUTE = 20;
const WEBHOOK_AAD = Buffer.from("app.project_wecom_groups.webhook_url", "utf8");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class WebhookDeliveryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "WebhookDeliveryError";
    this.retryable = options.retryable === true;
    this.errcode = Number.isFinite(Number(options.errcode))
      ? Number(options.errcode)
      : undefined;
    this.errmsg = options.errmsg;
  }
}

/** 解密 app.project_wecom_groups.webhook_url_ciphertext。 */
export function decryptWebhookUrl(ciphertext, keyVersion, keys) {
  const key = keys && keys.get ? keys.get(Number(keyVersion)) : undefined;
  if (key === undefined) {
    throw new WebhookDeliveryError("Webhook 加密主密钥版本不可用，稍后重试", {
      retryable: true,
    });
  }
  const buffer = Buffer.isBuffer(ciphertext)
    ? ciphertext
    : Buffer.from(ciphertext || []);
  if (buffer.length < NONCE_BYTES + TAG_BYTES + 1) {
    throw new WebhookDeliveryError("Webhook URL 密文长度非法");
  }
  try {
    const nonce = buffer.subarray(0, NONCE_BYTES);
    const tag = buffer.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const body = buffer.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(WEBHOOK_AAD);
    decipher.setAuthTag(tag);
    const url = Buffer.concat([
      decipher.update(body),
      decipher.final(),
    ]).toString("utf8");
    if (url.length === 0) {
      throw new WebhookDeliveryError("Webhook URL 解密结果为空");
    }
    return url;
  } catch (error) {
    if (error instanceof WebhookDeliveryError) throw error;
    throw new WebhookDeliveryError("Webhook URL 密文认证失败");
  }
}

function normalizedImagePayload(message) {
  const image = message && message.image;
  const base64 = String(image && image.base64 ? image.base64 : "");
  const md5 = String(image && image.md5 ? image.md5 : "");
  if (base64.length === 0 || !/^[0-9a-fA-F]{32}$/.test(md5)) {
    throw new WebhookDeliveryError("Webhook 图片消息缺少合法 base64 或 md5");
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    throw new WebhookDeliveryError("Webhook 图片 base64 解码为空");
  }
  if (buffer.length > WEBHOOK_MAX_IMAGE_BYTES) {
    throw new WebhookDeliveryError("Webhook 图片超过企业微信 2 MB 限制");
  }
  return { msgtype: "image", image: { base64, md5 } };
}

/** 把现有 BOT 消息对象收窄为 Webhook 官方消息体，绝不携带 chatid/chat_type。 */
export function buildWebhookPayload(message) {
  if (message === null || typeof message !== "object") {
    throw new WebhookDeliveryError("Webhook 消息不是对象");
  }
  if (message.msgtype === "image") return normalizedImagePayload(message);
  if (message.msgtype === "markdown") {
    const content = String(message.markdown && message.markdown.content);
    if (content.trim().length === 0) {
      throw new WebhookDeliveryError("Webhook markdown 内容为空");
    }
    return { msgtype: "markdown", markdown: { content } };
  }
  if (message.msgtype === "template_card") {
    if (
      message.template_card === null ||
      typeof message.template_card !== "object" ||
      Array.isArray(message.template_card)
    ) {
      throw new WebhookDeliveryError("Webhook template_card 内容非法");
    }
    return { msgtype: "template_card", template_card: message.template_card };
  }
  throw new WebhookDeliveryError("Webhook 不支持该消息类型");
}

function isRetryableErrcode(errcode, errmsg) {
  if (errcode === 45009) return true;
  const text = String(errmsg === null || errmsg === undefined ? "" : errmsg);
  return /限|频繁|too many|rate|limit/i.test(text);
}

/**
 * POST 到解密后的 Webhook URL。错误消息不包含 URL；调用方只记录目标标签/尾号。
 */
export async function sendWebhookMessage(webhookUrl, message, options = {}) {
  const payload = buildWebhookPayload(message);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WebhookDeliveryError("当前运行环境缺少 fetch");
  }
  const timeoutMs =
    Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new WebhookDeliveryError("Webhook 网络请求失败或超时，稍后重试", {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new WebhookDeliveryError(
      "企业微信 Webhook 暂时不可用：HTTP " + String(response.status),
      { retryable: true },
    );
  }
  if (!response.ok) {
    throw new WebhookDeliveryError(
      "企业微信 Webhook 请求失败：HTTP " + String(response.status),
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new WebhookDeliveryError("企业微信 Webhook 响应不是 JSON");
  }
  const errcode = Number(body && body.errcode);
  if (!Number.isFinite(errcode)) {
    throw new WebhookDeliveryError("企业微信 Webhook 响应缺少 errcode");
  }
  if (errcode !== 0) {
    const errmsg = String(body && body.errmsg ? body.errmsg : "");
    throw new WebhookDeliveryError(
      "企业微信 Webhook 返回 errcode " + String(errcode) + "：" + errmsg,
      {
        retryable: isRetryableErrcode(errcode, errmsg),
        errcode,
        errmsg,
      },
    );
  }
  return body;
}

/** 目标级滑动窗口限速；一个项目多个 Webhook 各自独立。 */
export class WebhookRateLimiter {
  constructor(limit = WEBHOOK_DEFAULT_RATE_PER_MINUTE, windowMs = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.sentAt = new Map();
  }

  #timestamps(key, now) {
    const cutoff = now - this.windowMs;
    const current = this.sentAt.get(key) || [];
    const kept = current.filter((value) => value > cutoff);
    if (kept.length === 0) this.sentAt.delete(key);
    else this.sentAt.set(key, kept);
    return kept;
  }

  canSend(key, now = Date.now()) {
    return this.#timestamps(key, now).length < this.limit;
  }

  record(key, now = Date.now()) {
    const timestamps = this.#timestamps(key, now);
    timestamps.push(now);
    this.sentAt.set(key, timestamps);
  }

  retryAfterMs(key, now = Date.now()) {
    const timestamps = this.#timestamps(key, now);
    if (timestamps.length < this.limit) return 0;
    return Math.max(0, timestamps[0] + this.windowMs - now);
  }

  prune(now = Date.now()) {
    for (const key of [...this.sentAt.keys()]) this.#timestamps(key, now);
  }
}

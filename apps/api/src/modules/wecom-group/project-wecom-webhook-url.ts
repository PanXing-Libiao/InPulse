import { createHash } from "node:crypto";

const WECOM_WEBHOOK_ORIGIN = "https://qyapi.weixin.qq.com";
const WECOM_WEBHOOK_PATH = "/cgi-bin/webhook/send";
const WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export class ProjectWecomWebhookUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ProjectWecomWebhookUrlError";
  }
}

export interface NormalizedProjectWecomWebhookUrl {
  /** 仅保留官方 origin、路径与一个 key 查询参数的规范 URL。 */
  readonly url: string;
  /** 规范 URL 的 SHA-256；数据库只用它做 ACTIVE 去重。 */
  readonly fingerprint: Buffer;
  /** Webhook Key 尾 4 位，用于脱敏展示。 */
  readonly hint: string;
}

/**
 * 严格规范化企业微信群机器人 Webhook URL。
 * 只接受官方 HTTPS origin 与 send 路径；拒绝用户信息、片段、额外参数、
 * 非单个 key 和非法 key。任何异常都不得把完整输入写进错误消息。
 */
export function normalizeProjectWecomWebhookUrl(
  input: string,
): NormalizedProjectWecomWebhookUrl {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 2048) {
    throw new ProjectWecomWebhookUrlError("长度必须为 1 到 2048");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProjectWecomWebhookUrlError("不是合法 URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== WECOM_WEBHOOK_ORIGIN ||
    parsed.pathname !== WECOM_WEBHOOK_PATH ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ProjectWecomWebhookUrlError("必须使用企业微信官方 Webhook 地址");
  }
  const keys = parsed.searchParams.getAll("key");
  if (keys.length !== 1 || parsed.searchParams.size !== 1) {
    throw new ProjectWecomWebhookUrlError(
      "只允许一个 key 查询参数，不能附加其它参数",
    );
  }
  const key = keys[0]!;
  if (!WEBHOOK_KEY_PATTERN.test(key)) {
    throw new ProjectWecomWebhookUrlError(
      "Webhook key 必须是 16 到 128 位字母、数字、下划线或连字符",
    );
  }
  const url =
    WECOM_WEBHOOK_ORIGIN +
    WECOM_WEBHOOK_PATH +
    "?key=" +
    encodeURIComponent(key);
  return {
    url,
    fingerprint: createHash("sha256").update(url, "utf8").digest(),
    hint: key.slice(-4),
  };
}

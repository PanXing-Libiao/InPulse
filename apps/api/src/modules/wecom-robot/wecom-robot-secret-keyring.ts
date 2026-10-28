import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const KEYRING_ENTRY = /^([1-9][0-9]*)\s*:\s*([0-9a-fA-F]{64,})\s*$/;
const KEYRING_COMMENT = /^\s*#/;
/** AES-256 主密钥长度（字节）。 */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** GCM 附加认证数据：恒定绑定到表与列（ADR-070）。 */
const ROBOT_SECRET_AAD = Buffer.from("app.wecom_robot_config.secret", "utf8");
const PROJECT_WECOM_WEBHOOK_URL_AAD = Buffer.from(
  "app.project_wecom_groups.webhook_url",
  "utf8",
);

/** 主密钥不可用（文件缺失 / 非法 / 缺版本）；HTTP 层 fail closed。 */
export class WecomRobotEncryptionUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Wecom robot encryption key unavailable: ${reason}`);
    this.name = "WecomRobotEncryptionUnavailableError";
  }
}

/** 密文解密失败（GCM 校验不通过）；按配置非法处理。 */
export class WecomRobotDecryptError extends Error {
  constructor() {
    super("Wecom robot secret ciphertext failed authentication");
    this.name = "WecomRobotDecryptError";
  }
}

export interface WecomRobotEncryptionKeyring {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

export function parseWecomRobotEncryptionKeyring(
  content: string,
  currentVersion: number,
): WecomRobotEncryptionKeyring {
  if (!Number.isInteger(currentVersion) || currentVersion <= 0) {
    throw new WecomRobotEncryptionUnavailableError(
      "current key version invalid",
    );
  }
  const keys = new Map<number, Buffer>();
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || KEYRING_COMMENT.test(line)) {
      continue;
    }
    const match = KEYRING_ENTRY.exec(line);
    if (match === null) {
      throw new WecomRobotEncryptionUnavailableError("keyring entry invalid");
    }
    const version = Number.parseInt(match[1]!, 10);
    const key = Buffer.from(match[2]!, "hex");
    if (key.length < KEY_BYTES) {
      throw new WecomRobotEncryptionUnavailableError("keyring key too short");
    }
    if (keys.has(version)) {
      throw new WecomRobotEncryptionUnavailableError(
        "duplicate keyring version",
      );
    }
    keys.set(version, key);
  }
  if (keys.size === 0) {
    throw new WecomRobotEncryptionUnavailableError("keyring is empty");
  }
  if (!keys.has(currentVersion)) {
    throw new WecomRobotEncryptionUnavailableError(
      "current key version missing",
    );
  }
  return { currentVersion, keys };
}

/**
 * 从环境变量加载机器人密钥加密主密钥 keyring（ADR-070）：文件路径必须指向
 * `/run/secrets/*` 直接子项；仅 `NODE_ENV=test` 且显式设置
 * `WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH=1` 时允许临时路径。
 * 任何失败都抛 WecomRobotEncryptionUnavailableError（fail closed，不回退）。
 */
export function loadWecomRobotEncryptionKeyring(
  env: Readonly<Record<string, string | undefined>>,
): WecomRobotEncryptionKeyring {
  const filePath = env["WECOM_ROBOT_ENCRYPTION_KEY_FILE"]?.trim();
  if (filePath === undefined || filePath.length === 0) {
    throw new WecomRobotEncryptionUnavailableError(
      "WECOM_ROBOT_ENCRYPTION_KEY_FILE is required",
    );
  }
  const allowTestPath =
    env["NODE_ENV"] === "test" &&
    env["WECOM_ROBOT_ENCRYPTION_KEY_TEST_PATH"] === "1";
  if (!allowTestPath && !filePath.startsWith("/run/secrets/")) {
    throw new WecomRobotEncryptionUnavailableError(
      "WECOM_ROBOT_ENCRYPTION_KEY_FILE must be under /run/secrets/",
    );
  }
  const versionRaw = env["WECOM_ROBOT_ENCRYPTION_KEY_VERSION"]?.trim();
  const currentVersion =
    versionRaw === undefined || versionRaw.length === 0
      ? 1
      : Number.parseInt(versionRaw, 10);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    throw new WecomRobotEncryptionUnavailableError(
      "WECOM_ROBOT_ENCRYPTION_KEY_FILE is not readable",
    );
  }
  return parseWecomRobotEncryptionKeyring(content, currentVersion);
}

function encryptWithAad(
  plaintext: string,
  keyring: WecomRobotEncryptionKeyring,
  aad: Buffer,
): { readonly ciphertext: Buffer; readonly keyVersion: number } {
  const key = keyring.keys.get(keyring.currentVersion);
  if (key === undefined) {
    throw new WecomRobotEncryptionUnavailableError(
      "current key version missing",
    );
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([nonce, tag, encrypted]),
    keyVersion: keyring.currentVersion,
  };
}

function decryptWithAad(
  ciphertext: Buffer,
  keyVersion: number,
  keyring: WecomRobotEncryptionKeyring,
  aad: Buffer,
): string {
  const key = keyring.keys.get(keyVersion);
  if (key === undefined) {
    throw new WecomRobotEncryptionUnavailableError("keyring version missing");
  }
  if (ciphertext.length < NONCE_BYTES + TAG_BYTES + 1) {
    throw new WecomRobotDecryptError();
  }
  const nonce = ciphertext.subarray(0, NONCE_BYTES);
  const tag = ciphertext.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const body = ciphertext.subarray(NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(body),
      decipher.final(),
    ]).toString("utf8");
    if (plaintext.length === 0) {
      throw new WecomRobotDecryptError();
    }
    return plaintext;
  } catch (error) {
    if (error instanceof WecomRobotDecryptError) {
      throw error;
    }
    throw new WecomRobotDecryptError();
  }
}

/** 加密机器人 Secret；返回 `nonce || tag || ciphertext` 与主密钥版本。 */
export function encryptWecomRobotSecret(
  plaintext: string,
  keyring: WecomRobotEncryptionKeyring,
): { readonly ciphertext: Buffer; readonly keyVersion: number } {
  return encryptWithAad(plaintext, keyring, ROBOT_SECRET_AAD);
}

/** 解密机器人 Secret；未知主密钥版本与 GCM 校验失败都抛错（fail closed）。 */
export function decryptWecomRobotSecret(
  ciphertext: Buffer,
  keyVersion: number,
  keyring: WecomRobotEncryptionKeyring,
): string {
  return decryptWithAad(ciphertext, keyVersion, keyring, ROBOT_SECRET_AAD);
}

/** 加密项目 Webhook URL；使用与机器人 Secret 独立列绑定的 AAD。 */
export function encryptWecomWebhookUrl(
  plaintext: string,
  keyring: WecomRobotEncryptionKeyring,
): { readonly ciphertext: Buffer; readonly keyVersion: number } {
  return encryptWithAad(plaintext, keyring, PROJECT_WECOM_WEBHOOK_URL_AAD);
}

/** 解密项目 Webhook URL；AAD 不匹配或密文损坏时 fail closed。 */
export function decryptWecomWebhookUrl(
  ciphertext: Buffer,
  keyVersion: number,
  keyring: WecomRobotEncryptionKeyring,
): string {
  return decryptWithAad(
    ciphertext,
    keyVersion,
    keyring,
    PROJECT_WECOM_WEBHOOK_URL_AAD,
  );
}

/** 密钥尾 4 位提示；短于 4 位时整体作为提示。 */
export function wecomRobotSecretHint(secret: string): string {
  return secret.slice(-4);
}

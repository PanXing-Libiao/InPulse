/**
 * ADR-105：跨模块公开的企微加密能力。
 * Webhook URL 与机器人 Secret 共用同一 keyring，但业务模块不得直接访问
 * wecom-robot 的内部实现。
 */
export {
  WecomRobotEncryptionUnavailableError,
  decryptWecomWebhookUrl,
  encryptWecomWebhookUrl,
  loadWecomRobotEncryptionKeyring,
} from "../wecom-robot-secret-keyring.js";

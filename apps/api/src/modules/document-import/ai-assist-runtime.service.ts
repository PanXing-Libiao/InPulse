import { Inject, Injectable, Logger } from "@nestjs/common";

import { PostgresUnitOfWork } from "../../database/unit-of-work.js";
import {
  aiAssistEmergencyStop,
  loadAiAssistConfig,
  validateAiAssistEndpoint,
  type AiAssistConfig,
} from "./ai-assist.config.js";
import {
  AiAssistDecryptError,
  AiAssistEncryptionUnavailableError,
  decryptAiAssistSecret,
  loadAiAssistEncryptionKeyring,
} from "./ai-assist-secret-keyring.js";
import {
  AiAssistSettingsRepository,
  type AiAssistSettingsRecord,
} from "./ai-assist-settings.repository.js";

/** 当前为何不可用（ADR-068 fail closed 分类）。 */
export type AiAssistDisabledReason =
  | "KILL_SWITCH"
  | "NOT_ENABLED"
  | "CONFIG_INVALID"
  | "ENCRYPTION_KEY_UNAVAILABLE";

export type AiAssistResolution =
  | {
      readonly kind: "READY";
      readonly config: AiAssistConfig;
      readonly source: "DATABASE" | "ENVIRONMENT";
    }
  | {
      readonly kind: "DISABLED";
      readonly reason: AiAssistDisabledReason;
      readonly detail: string | undefined;
    };

/** 模型发现复用已保存密钥时的解析结果；不含任何日志或响应可透出的明文。 */
export type AiAssistApiKeyResolution =
  | {
      readonly kind: "READY";
      readonly apiKey: string;
      readonly source: "DATABASE" | "ENVIRONMENT";
    }
  | { readonly kind: "MISSING" }
  | {
      readonly kind: "DISABLED";
      readonly reason: AiAssistDisabledReason;
      readonly detail: string | undefined;
    };

const LOGGER_CONTEXT = "AiAssistRuntime";

/**
 * ADR-068 配置解析（每次调用实时解析，低频操作不做缓存）：
 * 1. 急停开关（AI_ASSIST_ENABLED 显式非真值）最高优先；
 * 2. 数据库单行配置存在时以其为准（enabled=false 即关闭）；
 * 3. 无数据库行时回退 ADR-067 的环境变量模式；
 * 4. 其余情况关闭。
 * 解密失败与主密钥缺失都 fail closed，只返回分类原因（不含任何 Secret）。
 */
@Injectable()
export class AiAssistRuntimeService {
  private readonly logger = new Logger(LOGGER_CONTEXT);

  constructor(
    @Inject(PostgresUnitOfWork) private readonly uow: PostgresUnitOfWork,
    @Inject(AiAssistSettingsRepository)
    private readonly repository: AiAssistSettingsRepository,
  ) {}

  async resolve(): Promise<AiAssistResolution> {
    const env = process.env;
    if (aiAssistEmergencyStop(env)) {
      return { kind: "DISABLED", reason: "KILL_SWITCH", detail: undefined };
    }
    const row = await this.uow.run((tx) => this.repository.find(tx));
    return this.resolveFromRow(row);
  }

  /**
   * 模型发现只需要一个可用于本次探测的密钥：数据库行存在时即使配置处于
   * enabled=false 也可解密复用（管理员仍在做配置），无行时回退环境变量。
   * 急停、解密失败与主密钥不可用仍 fail closed。
   */
  async resolveApiKey(): Promise<AiAssistApiKeyResolution> {
    const env = process.env;
    if (aiAssistEmergencyStop(env)) {
      return { kind: "DISABLED", reason: "KILL_SWITCH", detail: undefined };
    }
    const row = await this.uow.run((tx) => this.repository.find(tx));
    if (row !== undefined) {
      const key = this.readDatabaseApiKey(row, env);
      if (key.kind === "DISABLED") {
        return key;
      }
      return { kind: "READY", apiKey: key.apiKey, source: "DATABASE" };
    }
    const legacy = loadAiAssistConfig(env);
    if (legacy.config !== undefined) {
      return {
        kind: "READY",
        apiKey: legacy.config.apiKey,
        source: "ENVIRONMENT",
      };
    }
    if (legacy.invalidReason !== undefined) {
      this.logger.warn(
        `AI_ASSIST_ENABLED 已启用但环境变量配置非法（密钥不可复用）：${legacy.invalidReason}`,
      );
      return {
        kind: "DISABLED",
        reason: "CONFIG_INVALID",
        detail: legacy.invalidReason,
      };
    }
    return { kind: "MISSING" };
  }

  /** 同步解析（不访问数据库）：管理端 GET / 测试连接复用同一份判定。 */
  resolveFromRow(
    row: AiAssistSettingsRecord | undefined,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): AiAssistResolution {
    if (aiAssistEmergencyStop(env)) {
      return { kind: "DISABLED", reason: "KILL_SWITCH", detail: undefined };
    }
    if (row !== undefined) {
      return this.resolveDatabaseRow(row, env);
    }
    const legacy = loadAiAssistConfig(env);
    if (legacy.config !== undefined) {
      return { kind: "READY", config: legacy.config, source: "ENVIRONMENT" };
    }
    if (legacy.invalidReason !== undefined) {
      this.logger.warn(
        `AI_ASSIST_ENABLED 已启用但环境变量配置非法（fail closed）：${legacy.invalidReason}`,
      );
      return {
        kind: "DISABLED",
        reason: "CONFIG_INVALID",
        detail: legacy.invalidReason,
      };
    }
    return { kind: "DISABLED", reason: "NOT_ENABLED", detail: undefined };
  }

  private readDatabaseApiKey(
    row: AiAssistSettingsRecord,
    env: Readonly<Record<string, string | undefined>>,
  ):
    | { readonly kind: "READY"; readonly apiKey: string }
    | {
        readonly kind: "DISABLED";
        readonly reason: AiAssistDisabledReason;
        readonly detail: string | undefined;
      } {
    try {
      const keyring = loadAiAssistEncryptionKeyring(env);
      return {
        kind: "READY",
        apiKey: decryptAiAssistSecret(
          row.apiKeyCiphertext,
          row.apiKeyKeyVersion,
          keyring,
        ),
      };
    } catch (error) {
      if (error instanceof AiAssistDecryptError) {
        this.logger.warn(
          "AI 辅助转换密钥解密失败（fail closed）：ciphertext 认证不通过",
        );
        return {
          kind: "DISABLED",
          reason: "CONFIG_INVALID",
          detail: "api key unreadable",
        };
      }
      if (error instanceof AiAssistEncryptionUnavailableError) {
        this.logger.warn(
          `AI 辅助转换主密钥不可用（fail closed）：${error.reason}`,
        );
        return {
          kind: "DISABLED",
          reason: "ENCRYPTION_KEY_UNAVAILABLE",
          detail: error.reason,
        };
      }
      throw error;
    }
  }

  private resolveDatabaseRow(
    row: AiAssistSettingsRecord,
    env: Readonly<Record<string, string | undefined>>,
  ): AiAssistResolution {
    if (!row.enabled) {
      return { kind: "DISABLED", reason: "NOT_ENABLED", detail: undefined };
    }
    if (
      row.endpoint.length === 0 ||
      row.endpoint.length > 2048 ||
      row.model.length === 0 ||
      row.model.length > 200
    ) {
      return {
        kind: "DISABLED",
        reason: "CONFIG_INVALID",
        detail: "stored config out of range",
      };
    }
    let endpoint: string;
    try {
      endpoint = validateAiAssistEndpoint(
        row.endpoint,
        env,
        "AI_ASSIST_ENDPOINT",
      );
    } catch (error) {
      return {
        kind: "DISABLED",
        reason: "CONFIG_INVALID",
        detail: error instanceof Error ? error.message : undefined,
      };
    }
    const apiKey = this.readDatabaseApiKey(row, env);
    if (apiKey.kind === "DISABLED") {
      return apiKey;
    }
    return {
      kind: "READY",
      config: {
        endpoint,
        model: row.model,
        apiKey: apiKey.apiKey,
        timeoutMs: row.timeoutMs,
        maxTokens: row.maxTokens,
      },
      source: "DATABASE",
    };
  }
}

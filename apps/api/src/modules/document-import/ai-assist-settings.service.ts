import { Inject, Injectable } from "@nestjs/common";
import type {
  AiAssistModelsRequest,
  AiAssistModelsResponse,
  AiAssistSettingsItem,
  AiAssistSettingsTestReason,
  AiAssistSettingsTestResponse,
  AiAssistSettingsUpdateRequest,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";
import { AdminHighRiskAuthService } from "../../auth/admin-high-risk.service.js";
import type { HttpHeaderBag } from "../../auth/csrf.http.js";
import { AuditWritePort } from "../../audit/index.js";
import {
  AiAssistSettingsError,
  AiAssistSettingsInputError,
} from "./ai-assist-settings.error.js";
import { AiAssistSettingsRepository } from "./ai-assist-settings.repository.js";
import { AiAssistRuntimeService } from "./ai-assist-runtime.service.js";
import { DocumentImportAiAssistClient } from "./ai-assist.client.js";
import { AiAssistUpstreamError } from "./ai-assist.client.js";
import {
  aiAssistEmergencyStop,
  aiAssistEnabled,
  validateAiAssistEndpoint,
} from "./ai-assist.config.js";
import {
  AiAssistEncryptionUnavailableError,
  aiAssistKeyHint,
  encryptAiAssistSecret,
  loadAiAssistEncryptionKeyring,
} from "./ai-assist-secret-keyring.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 8192;

export interface AiAssistSettingsMutationMeta {
  readonly actorId: number;
  readonly headers: HttpHeaderBag;
  readonly requestId: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

const upstreamReasonMap: Readonly<
  Record<AiAssistUpstreamError["reason"], AiAssistSettingsTestReason>
> = {
  auth: "AUTH",
  "rate-limited": "RATE_LIMITED",
  timeout: "TIMEOUT",
  network: "NETWORK",
  "context-limit": "CONTEXT_LIMIT",
  "invalid-response": "INVALID_RESPONSE",
};

/**
 * ADR-068 AI 辅助转换管理员配置服务：读视图、保存（加密 + 审计）、测试连接与模型发现。
 * 每个写命令显式接收同一 TransactionContext（应用服务约定）。
 */
@Injectable()
export class AiAssistSettingsService {
  constructor(
    private readonly repository: AiAssistSettingsRepository,
    private readonly runtime: AiAssistRuntimeService,
    private readonly highRisk: AdminHighRiskAuthService,
    private readonly client: DocumentImportAiAssistClient,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
  ) {}

  /** 管理端 GET：完整管理员 Session（只读，不要求 CSRF）。 */
  async view(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<AiAssistSettingsItem> {
    await this.highRisk.verifyRead(tx, headers);
    const row = await this.repository.find(tx);
    return this.toItem(row);
  }

  /** 保存配置：CSRF + 管理员（高风险门禁），密钥加密后落库并写审计。 */
  async update(
    tx: TransactionContext,
    meta: AiAssistSettingsMutationMeta,
    input: AiAssistSettingsUpdateRequest,
  ): Promise<AiAssistSettingsItem> {
    const actor = await this.highRisk.verify(tx, meta.headers);
    if (actor.userId !== meta.actorId) {
      throw new AiAssistSettingsError(
        403,
        "ADMIN_REQUIRED",
        "只有系统管理员可以保存 AI 辅助转换配置",
      );
    }
    let endpoint: string;
    try {
      endpoint = validateAiAssistEndpoint(
        input.endpoint,
        process.env,
        "endpoint",
      );
    } catch {
      throw new AiAssistSettingsInputError({
        endpoint: "端点必须是绝对 https 地址；回环 http 只允许开发 / 测试环境",
      });
    }
    const current = await this.repository.find(tx, true);
    let ciphertext: Buffer;
    let keyVersion: number;
    let keyHint: string;
    let keyChanged = false;
    const providedKey = input.apiKey ?? undefined;
    if (providedKey !== undefined) {
      let encrypted: ReturnType<typeof encryptAiAssistSecret>;
      try {
        const keyring = loadAiAssistEncryptionKeyring(process.env);
        encrypted = encryptAiAssistSecret(providedKey, keyring);
      } catch (error) {
        if (error instanceof AiAssistEncryptionUnavailableError) {
          throw new AiAssistSettingsError(
            503,
            "AI_ASSIST_SETTINGS_KEY_UNAVAILABLE",
            "服务器未配置密钥加密主密钥，暂时无法保存 API 密钥；请联系运维配置 AI_ASSIST_ENCRYPTION_KEY_FILE",
          );
        }
        throw error;
      }
      ciphertext = encrypted.ciphertext;
      keyVersion = encrypted.keyVersion;
      keyHint = aiAssistKeyHint(providedKey);
      keyChanged = true;
    } else if (current !== undefined) {
      ciphertext = current.apiKeyCiphertext;
      keyVersion = current.apiKeyKeyVersion;
      keyHint = current.apiKeyHint;
    } else {
      throw new AiAssistSettingsInputError({
        apiKey: "首次配置必须提供 API 密钥",
      });
    }
    const updated = await this.repository.upsert(tx, {
      enabled: input.enabled,
      endpoint,
      model: input.model,
      timeoutMs: input.timeoutMs,
      maxTokens: input.maxTokens,
      apiKeyCiphertext: ciphertext,
      apiKeyKeyVersion: keyVersion,
      apiKeyHint: keyHint,
      updatedBy: meta.actorId,
    });
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: meta.actorId,
      action: "admin.aiAssistSettings.update",
      targetType: "AI_ASSIST_SETTINGS",
      targetId: "1",
      eventPayload: {
        before: this.summary(current),
        after: this.summary(updated),
        keyChanged,
      },
      requestId: meta.requestId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toItem(updated);
  }

  /**
   * 模型发现：端点与超时使用设置页当前输入；apiKey 留空时只读复用已保存
   * 密钥。请求只在内存中拼出临时配置，不写任何持久化状态。
   */
  async listModels(
    input: AiAssistModelsRequest,
  ): Promise<AiAssistModelsResponse> {
    const env = process.env;
    if (aiAssistEmergencyStop(env)) {
      return { ok: false, reason: "KILL_SWITCH", models: [] };
    }
    let endpoint: string;
    try {
      endpoint = validateAiAssistEndpoint(input.endpoint, env, "endpoint");
    } catch {
      throw new AiAssistSettingsInputError({
        endpoint: "端点必须是绝对 https 地址；回环 http 只允许开发 / 测试环境",
      });
    }
    let apiKey = input.apiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      const saved = await this.runtime.resolveApiKey();
      if (saved.kind === "DISABLED") {
        return { ok: false, reason: saved.reason, models: [] };
      }
      if (saved.kind === "MISSING") {
        return { ok: false, reason: "CONFIG_INVALID", models: [] };
      }
      apiKey = saved.apiKey;
    }
    try {
      const { models } = await this.client.listModels({
        endpoint,
        model: "",
        apiKey,
        timeoutMs: input.timeoutMs,
        maxTokens: 1,
      });
      return { ok: true, reason: null, models: [...models] };
    } catch (error) {
      if (error instanceof AiAssistUpstreamError) {
        return {
          ok: false,
          reason: upstreamReasonMap[error.reason],
          models: [],
        };
      }
      throw error;
    }
  }

  /** 测试连接：用当前生效配置发最小探测请求；不写任何持久化状态。 */
  async testConnection(): Promise<AiAssistSettingsTestResponse> {
    const resolution = await this.runtime.resolve();
    if (resolution.kind === "DISABLED") {
      return { ok: false, reason: resolution.reason, model: null };
    }
    try {
      const { model } = await this.client.probe(resolution.config);
      return { ok: true, reason: null, model };
    } catch (error) {
      if (error instanceof AiAssistUpstreamError) {
        return {
          ok: false,
          reason: upstreamReasonMap[error.reason],
          model: null,
        };
      }
      throw error;
    }
  }

  private toItem(
    row: Awaited<ReturnType<AiAssistSettingsRepository["find"]>>,
  ): AiAssistSettingsItem {
    const resolution = this.runtime.resolveFromRow(row);
    const env = process.env;
    const envEnabled = aiAssistEnabled(env);
    const source =
      row !== undefined ? "DATABASE" : envEnabled ? "ENVIRONMENT" : "NONE";
    const endpoint =
      row !== undefined
        ? row.endpoint
        : (env["AI_ASSIST_ENDPOINT"]?.trim() ?? "") || null;
    const model =
      row !== undefined
        ? row.model
        : (env["AI_ASSIST_MODEL"]?.trim() ?? "") || null;
    const timeoutMs =
      row !== undefined
        ? row.timeoutMs
        : optionalInteger(env["AI_ASSIST_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS);
    const maxTokens =
      row !== undefined
        ? row.maxTokens
        : optionalInteger(env["AI_ASSIST_MAX_TOKENS"], DEFAULT_MAX_TOKENS);
    const ready = resolution.kind === "READY";
    return {
      enabled: row !== undefined ? row.enabled : envEnabled,
      source,
      ready,
      disabledReason: resolution.kind === "DISABLED" ? resolution.reason : null,
      endpoint,
      model,
      timeoutMs,
      maxTokens,
      keyConfigured:
        row !== undefined ? true : ready && resolution.source === "ENVIRONMENT",
      keyHint: row !== undefined ? row.apiKeyHint : null,
      rowVersion: row !== undefined ? row.rowVersion : null,
      updatedAt: row !== undefined ? row.updatedAt : null,
    };
  }

  private summary(
    row: Awaited<ReturnType<AiAssistSettingsRepository["find"]>>,
  ): Readonly<Record<string, unknown>> {
    if (row === undefined) {
      return { configured: false };
    }
    return {
      enabled: row.enabled,
      endpoint: row.endpoint,
      model: row.model,
      timeoutMs: row.timeoutMs,
      maxTokens: row.maxTokens,
      keyHint: row.apiKeyHint,
      rowVersion: row.rowVersion,
    };
  }
}

function optionalInteger(raw: string | undefined, fallback: number): number {
  const value = Number((raw ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

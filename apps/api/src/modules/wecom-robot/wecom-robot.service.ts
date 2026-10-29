import { Inject, Injectable } from "@nestjs/common";
import type {
  WecomRobotConfig,
  WecomRobotConfigUpdateRequest,
  WecomRobotDisabledReason,
} from "@inpulse/api-contract";

import type { TransactionContext } from "../../database/transaction-context.js";
import { AdminHighRiskAuthService } from "../../auth/admin-high-risk.service.js";
import type { HttpHeaderBag } from "../../auth/csrf.http.js";
import { AuditWritePort } from "../../audit/index.js";
import {
  WecomRobotConfigError,
  WecomRobotInputError,
} from "./wecom-robot.error.js";
import {
  WecomRobotConfigRepository,
  type WecomRobotConfigRecord,
} from "./wecom-robot.repository.js";
import {
  WecomRobotDecryptError,
  WecomRobotEncryptionUnavailableError,
  decryptWecomRobotSecret,
  encryptWecomRobotSecret,
  loadWecomRobotEncryptionKeyring,
  wecomRobotSecretHint,
} from "./wecom-robot-secret-keyring.js";

export interface WecomRobotConfigMutationMeta {
  readonly actorId: number;
  readonly headers: HttpHeaderBag;
  readonly requestId: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** 更换机器人时同一事务解除的绑定计数（供响应展示与审计留痕）。 */
interface WecomRobotBindingRevocation {
  readonly revokedUserBindings: number;
  readonly revokedProjectGroups: number;
}

const BOT_ID_MAX = 128;
const SECRET_MAX = 256;

/**
 * ADR-070 企业微信机器人管理员配置服务：读取当前配置与可用状态；保存时
 * 把 Secret 经 AES-256-GCM 加密后落库并写审计（不含密钥）。每个写命令
 * 显式接收同一 TransactionContext（应用服务约定）。
 */
@Injectable()
export class WecomRobotConfigService {
  constructor(
    private readonly repository: WecomRobotConfigRepository,
    private readonly highRisk: AdminHighRiskAuthService,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
  ) {}

  /** 管理端 GET：完整管理员 Session（只读，不要求 CSRF）。 */
  async view(
    tx: TransactionContext,
    headers: HttpHeaderBag,
  ): Promise<WecomRobotConfig> {
    await this.highRisk.verifyRead(tx, headers);
    const row = await this.repository.find(tx);
    return this.toItem(row);
  }

  /** 保存配置：CSRF + 管理员（高风险门禁），Secret 加密后落库并写审计。 */
  async update(
    tx: TransactionContext,
    meta: WecomRobotConfigMutationMeta,
    input: WecomRobotConfigUpdateRequest,
  ): Promise<WecomRobotConfig> {
    const actor = await this.highRisk.verify(tx, meta.headers);
    if (actor.userId !== meta.actorId) {
      throw new WecomRobotConfigError(
        403,
        "ADMIN_REQUIRED",
        "只有系统管理员可以保存企业微信机器人配置",
      );
    }
    const botId = input.botId.trim();
    if (botId.length === 0 || botId.length > BOT_ID_MAX || /\s/.test(botId)) {
      throw new WecomRobotInputError({
        botId: "botId 必须是 1 到 128 个字符、且不含空白字符",
      });
    }
    const current = await this.repository.find(tx, true);
    let ciphertext: Buffer;
    let keyVersion: number;
    let secretHint: string;
    let secretChanged = false;
    const providedSecret = input.secret ?? undefined;
    if (providedSecret !== undefined) {
      const secret = providedSecret.trim();
      if (
        secret.length === 0 ||
        secret.length > SECRET_MAX ||
        /\s/.test(secret)
      ) {
        throw new WecomRobotInputError({
          secret: "机器人 Secret 必须是 1 到 256 个字符、且不含空白字符",
        });
      }
      let encrypted: ReturnType<typeof encryptWecomRobotSecret>;
      try {
        const keyring = loadWecomRobotEncryptionKeyring(process.env);
        encrypted = encryptWecomRobotSecret(secret, keyring);
      } catch (error) {
        if (error instanceof WecomRobotEncryptionUnavailableError) {
          throw new WecomRobotConfigError(
            503,
            "WECOM_ROBOT_CONFIG_KEY_UNAVAILABLE",
            "服务器未配置机器人密钥加密主密钥，暂时无法保存 Secret；请联系运维配置 WECOM_ROBOT_ENCRYPTION_KEY_FILE",
          );
        }
        throw error;
      }
      ciphertext = encrypted.ciphertext;
      keyVersion = encrypted.keyVersion;
      secretHint = wecomRobotSecretHint(secret);
      secretChanged = true;
    } else if (current === undefined) {
      throw new WecomRobotInputError({
        secret: "首次配置必须提供机器人 Secret",
      });
    } else {
      ciphertext = current.secretCiphertext;
      keyVersion = current.secretKeyVersion;
      secretHint = current.secretHint;
    }
    // botProfileUrl 语义（与契约同口径）：缺省保持现值、null 清空、字符串设置。
    const botProfileUrl =
      input.botProfileUrl === undefined
        ? (current?.botProfileUrl ?? null)
        : input.botProfileUrl;
    await this.repository.upsert(tx, {
      botId,
      secretCiphertext: ciphertext,
      secretKeyVersion: keyVersion,
      secretHint,
      botProfileUrl,
      updatedBy: meta.actorId,
    });

    // ADR-078：botId 与已存值不同即「更换机器人」。企业微信智能机器人要求
    // 成员先主动对话激活，换机器人后旧个人绑定必然投递失败，因此在同一事务内
    // 只解除 ACTIVE 个人绑定；项目群 Webhook 不依赖机器人凭据，保持绑定。
    const robotChanged = current !== undefined && current.botId !== botId;
    let revocation: WecomRobotBindingRevocation | null = null;
    if (robotChanged) {
      const rows = (await tx.sql`
        SELECT revoked_user_bindings AS "revokedUserBindings",
               revoked_project_groups AS "revokedProjectGroups"
          FROM app.revoke_wecom_bindings_on_robot_change()
      `) as unknown as readonly WecomRobotBindingRevocation[];
      const counts = rows[0];
      if (counts === undefined) {
        throw new Error(
          "app.revoke_wecom_bindings_on_robot_change returned no counts",
        );
      }
      revocation = {
        revokedUserBindings: counts.revokedUserBindings,
        revokedProjectGroups: counts.revokedProjectGroups,
      };
    }

    const updated = await this.repository.find(tx);
    await this.audit.append(tx, {
      projectId: null,
      actorType: "USER",
      actorId: meta.actorId,
      action: "admin.wecomRobot.update",
      targetType: "WECOM_ROBOT_CONFIG",
      targetId: "1",
      eventPayload: {
        before: this.summary(current),
        after: this.summary(updated),
        secretChanged,
        robotChanged,
        revokedUserBindings: revocation?.revokedUserBindings ?? null,
        revokedProjectGroups: revocation?.revokedProjectGroups ?? null,
      },
      requestId: meta.requestId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toItem(updated, revocation);
  }

  private toItem(
    row: WecomRobotConfigRecord | undefined,
    revocation?: WecomRobotBindingRevocation | null,
  ): WecomRobotConfig {
    const revocationFields = {
      revokedUserBindings: revocation?.revokedUserBindings ?? null,
      revokedProjectGroups: revocation?.revokedProjectGroups ?? null,
    };
    if (row === undefined) {
      return {
        configured: false,
        ready: false,
        disabledReason: "NOT_CONFIGURED",
        botId: null,
        secretHint: null,
        secretKeyVersion: null,
        rowVersion: null,
        botProfileUrl: null,
        updatedAt: null,
        updatedByName: null,
        ...revocationFields,
      };
    }
    const failure = this.classify(row);
    return {
      configured: true,
      ready: failure === null,
      disabledReason: failure,
      botId: row.botId,
      secretHint: row.secretHint,
      secretKeyVersion: row.secretKeyVersion,
      rowVersion: row.rowVersion,
      botProfileUrl: row.botProfileUrl,
      updatedAt: row.updatedAt,
      updatedByName: row.updatedByName,
      ...revocationFields,
    };
  }

  /** 用当前主密钥试解密，判定配置是否可被桥接直接使用（fail closed 分类）。 */
  private classify(
    row: WecomRobotConfigRecord,
  ): WecomRobotDisabledReason | null {
    try {
      const keyring = loadWecomRobotEncryptionKeyring(process.env);
      decryptWecomRobotSecret(
        row.secretCiphertext,
        row.secretKeyVersion,
        keyring,
      );
      return null;
    } catch (error) {
      if (
        error instanceof WecomRobotEncryptionUnavailableError ||
        error instanceof WecomRobotDecryptError
      ) {
        return error instanceof WecomRobotEncryptionUnavailableError
          ? "ENCRYPTION_KEY_UNAVAILABLE"
          : "CONFIG_INVALID";
      }
      return "CONFIG_INVALID";
    }
  }

  private summary(
    row: WecomRobotConfigRecord | undefined,
  ): Readonly<Record<string, unknown>> {
    if (row === undefined) {
      return { configured: false };
    }
    return {
      botId: row.botId,
      secretHint: row.secretHint,
      secretKeyVersion: row.secretKeyVersion,
      rowVersion: row.rowVersion,
      botProfileUrl: row.botProfileUrl,
    };
  }
}

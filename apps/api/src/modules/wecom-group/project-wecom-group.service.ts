import { Inject, Injectable } from "@nestjs/common";

import type {
  ProjectWecomGroupNotificationOptions,
  ProjectWecomGroupStatus,
  ProjectWecomWebhookTarget,
} from "@inpulse/api-contract";
import {
  projectNotificationCategories,
  projectWecomGroupReplayContextSchema,
  projectWecomWebhookReplayContextSchema,
} from "@inpulse/api-contract";

import { AuditWritePort } from "../../audit/audit.port.js";
import type { TransactionContext } from "../../database/transaction-context.js";
import type { IdempotencyExecutionResult } from "../../idempotency/runner.js";
import {
  PROJECT_ACCESS_QUERY_PORT,
  ProjectRoleGateService,
  type ProjectAccessQueryPort,
} from "../projects/index.js";
import {
  WecomRobotEncryptionUnavailableError,
  encryptWecomWebhookUrl,
  loadWecomRobotEncryptionKeyring,
} from "../wecom-robot/public/wecom-encryption.js";
import {
  ProjectWecomWebhookUrlError,
  normalizeProjectWecomWebhookUrl,
} from "./project-wecom-webhook-url.js";

interface NotificationOptionFlags {
  readonly taskAssignEnabled: boolean;
  readonly taskStatusEnabled: boolean;
  readonly recordEnabled: boolean;
  readonly projectMemberEnabled: boolean;
  readonly scopeDeleteEnabled: boolean;
}

function notificationOptionFlagsFromOptions(
  options: ProjectWecomGroupNotificationOptions,
): NotificationOptionFlags {
  const disabled = new Set(options.disabledCategories);
  return {
    taskAssignEnabled: !disabled.has("task.assign"),
    taskStatusEnabled: !disabled.has("task.status"),
    recordEnabled: !disabled.has("record"),
    projectMemberEnabled: !disabled.has("project.member"),
    scopeDeleteEnabled: !disabled.has("scope.delete"),
  };
}

interface NotificationOptionRow {
  readonly taskAssignEnabled?: boolean | null;
  readonly taskStatusEnabled?: boolean | null;
  readonly recordEnabled?: boolean | null;
  readonly projectMemberEnabled?: boolean | null;
  readonly scopeDeleteEnabled?: boolean | null;
}

function notificationOptionsFromRow(
  row: NotificationOptionRow | null | undefined,
): ProjectWecomGroupNotificationOptions {
  const checks: readonly [
    (typeof projectNotificationCategories)[number],
    boolean | null | undefined,
  ][] = [
    ["task.assign", row?.taskAssignEnabled],
    ["task.status", row?.taskStatusEnabled],
    ["record", row?.recordEnabled],
    ["project.member", row?.projectMemberEnabled],
    ["scope.delete", row?.scopeDeleteEnabled],
  ];
  return {
    disabledCategories: checks
      .filter(([, enabled]) => enabled === false)
      .map(([category]) => category)
      .sort(),
  };
}

interface WebhookTargetRow {
  readonly id: number;
  readonly label: string;
  readonly urlHint: string;
  readonly boundAt: string;
  readonly boundByName: string | null;
  readonly lastDeliveryError: string | null;
}

const MAX_ACTIVE_WEBHOOKS_PER_PROJECT = 20;

export class ProjectWecomGroupError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectWecomGroupError";
  }
}

/**
 * ADR-106 项目企微群通知目标服务（Webhook-only）：
 * - 读取 ACTIVE Webhook 目标与项目级通知开关；
 * - 创建 / 删除 Webhook 目标，URL 加密且只返回尾号；
 * - 项目群不再支持智能机器人绑定码通道；个人单聊机器人不经过本服务。
 * 所有写命令显式接收同一个 TransactionContext，本服务不做网络请求。
 */
@Injectable()
export class ProjectWecomGroupService {
  constructor(
    @Inject(PROJECT_ACCESS_QUERY_PORT)
    private readonly access: ProjectAccessQueryPort,
    @Inject(ProjectRoleGateService)
    private readonly roleGate: ProjectRoleGateService,
    @Inject(AuditWritePort) private readonly audit: AuditWritePort,
  ) {}

  async status(
    tx: TransactionContext,
    input: { readonly actorId: number; readonly projectId: number },
  ): Promise<ProjectWecomGroupStatus> {
    await this.requireReadableProject(tx, input);
    const optionRows = (await tx.sql`
      SELECT
        task_assign_enabled AS "taskAssignEnabled",
        task_status_enabled AS "taskStatusEnabled",
        record_enabled AS "recordEnabled",
        project_member_enabled AS "projectMemberEnabled",
        scope_delete_enabled AS "scopeDeleteEnabled"
        FROM app.project_wecom_group_notification_options
       WHERE project_id = ${input.projectId}
    `) as unknown as readonly NotificationOptionFlags[];
    const webhookRows = (await tx.sql`
      SELECT
        g.id,
        g.webhook_label AS label,
        g.webhook_url_hint AS "urlHint",
        to_char(
          g.bound_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS "boundAt",
        g.bound_by_snapshot->>'name' AS "boundByName",
        g.last_delivery_error AS "lastDeliveryError"
        FROM app.project_wecom_groups AS g
       WHERE g.project_id = ${input.projectId}
         AND g.channel_type = 'WEBHOOK'
         AND g.status = 'ACTIVE'
       ORDER BY g.bound_at ASC, g.id ASC
    `) as unknown as readonly WebhookTargetRow[];
    const webhookTargets: ProjectWecomWebhookTarget[] = webhookRows.map(
      (row) => ({
        id: row.id,
        label: row.label,
        urlHint: row.urlHint,
        boundAt: row.boundAt,
        boundByName: row.boundByName ?? "未知",
        lastDeliveryError: row.lastDeliveryError,
      }),
    );
    return {
      state: webhookTargets.length === 0 ? "UNBOUND" : "BOUND",
      webhookTargets,
      notificationOptions: notificationOptionsFromRow(optionRows[0]),
    };
  }

  /** ADR-090 / ADR-106：整组替换项目群通知开关；只有 ACTIVE Webhook 时允许保存。 */
  async updateNotificationOptions(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly options: ProjectWecomGroupNotificationOptions;
      readonly requestId: string;
    },
  ): Promise<IdempotencyExecutionResult> {
    await this.requireBinderRole(tx, input);
    const bindings = (await tx.sql`
      SELECT id
        FROM app.project_wecom_groups
       WHERE project_id = ${input.projectId}
         AND channel_type = 'WEBHOOK'
         AND status = 'ACTIVE'
       ORDER BY id ASC
       FOR UPDATE
    `) as unknown as readonly { id: number }[];
    const binding = bindings[0];
    if (binding === undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_GROUP_NOT_BOUND",
        "项目尚未添加 ACTIVE Webhook 群目标，无法保存群通知选项",
      );
    }

    await tx.sql`
      INSERT INTO app.project_wecom_group_notification_options (project_id)
      VALUES (${input.projectId})
      ON CONFLICT (project_id) DO NOTHING
    `;
    const beforeRows = (await tx.sql`
      SELECT
        task_assign_enabled AS "taskAssignEnabled",
        task_status_enabled AS "taskStatusEnabled",
        record_enabled AS "recordEnabled",
        project_member_enabled AS "projectMemberEnabled",
        scope_delete_enabled AS "scopeDeleteEnabled"
        FROM app.project_wecom_group_notification_options
       WHERE project_id = ${input.projectId}
       FOR UPDATE
    `) as unknown as readonly NotificationOptionFlags[];
    const beforeRow = beforeRows[0];
    if (beforeRow === undefined) {
      throw new Error("project wecom group notification options row missing");
    }
    const enabled = notificationOptionFlagsFromOptions(input.options);
    const afterRows = (await tx.sql`
      UPDATE app.project_wecom_group_notification_options
         SET task_assign_enabled = ${enabled.taskAssignEnabled},
             task_status_enabled = ${enabled.taskStatusEnabled},
             record_enabled = ${enabled.recordEnabled},
             project_member_enabled = ${enabled.projectMemberEnabled},
             scope_delete_enabled = ${enabled.scopeDeleteEnabled},
             updated_at = now(),
             row_version = row_version + 1
       WHERE project_id = ${input.projectId}
       RETURNING
         task_assign_enabled AS "taskAssignEnabled",
         task_status_enabled AS "taskStatusEnabled",
         record_enabled AS "recordEnabled",
         project_member_enabled AS "projectMemberEnabled",
         scope_delete_enabled AS "scopeDeleteEnabled"
    `) as unknown as readonly NotificationOptionFlags[];
    const afterRow = afterRows[0];
    if (afterRow === undefined) {
      throw new Error(
        "project wecom group notification options update returned no row",
      );
    }
    const before = notificationOptionsFromRow(beforeRow);
    const after = notificationOptionsFromRow(afterRow);
    await this.audit.append(tx, {
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.wecomGroup.notificationOptions.update",
      targetType: "PROJECT",
      targetId: String(input.projectId),
      eventPayload: {
        groupBindingId: binding.id,
        before,
        after,
      },
      requestId: input.requestId,
      occurredAt: new Date(),
    });
    return {
      responseStatus: 200,
      responseSchemaRef: "ProjectWecomGroupNotificationOptions",
      responseHasBody: true,
      responseBody: after,
      replayAuthContext: { projectId: input.projectId },
    };
  }

  async createWebhook(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly label: string;
      readonly webhookUrl: string;
      readonly requestId: string;
    },
  ): Promise<IdempotencyExecutionResult> {
    await this.requireBinderRole(tx, input);
    let normalized: ReturnType<typeof normalizeProjectWecomWebhookUrl>;
    try {
      normalized = normalizeProjectWecomWebhookUrl(input.webhookUrl);
    } catch (error) {
      if (error instanceof ProjectWecomWebhookUrlError) {
        throw new ProjectWecomGroupError(
          422,
          "PROJECT_WECOM_WEBHOOK_URL_INVALID",
          "Webhook URL 必须使用企业微信官方群机器人地址，并只包含一个合法 key",
        );
      }
      throw error;
    }
    let encrypted: ReturnType<typeof encryptWecomWebhookUrl>;
    try {
      const keyring = loadWecomRobotEncryptionKeyring(process.env);
      encrypted = encryptWecomWebhookUrl(normalized.url, keyring);
    } catch (error) {
      if (error instanceof WecomRobotEncryptionUnavailableError) {
        throw new ProjectWecomGroupError(
          503,
          "PROJECT_WECOM_WEBHOOK_KEY_UNAVAILABLE",
          "服务器未配置 Webhook 加密主密钥，暂时无法保存目标；请联系运维配置 WECOM_ROBOT_ENCRYPTION_KEY_FILE",
        );
      }
      throw error;
    }

    await tx.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${"project-wecom-webhook:" + String(input.projectId)},
          0
        )
      )
    `;
    const duplicates = (await tx.sql`
      SELECT id
        FROM app.project_wecom_groups
       WHERE channel_type = 'WEBHOOK'
         AND status = 'ACTIVE'
         AND webhook_url_fingerprint = ${normalized.fingerprint}
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    if (duplicates[0] !== undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_WEBHOOK_ALREADY_BOUND",
        "该 Webhook 已绑定到一个活跃项目目标，不能重复添加",
      );
    }
    const activeRows = (await tx.sql`
      SELECT id
        FROM app.project_wecom_groups
       WHERE project_id = ${input.projectId}
         AND channel_type = 'WEBHOOK'
         AND status = 'ACTIVE'
    `) as unknown as readonly { id: number }[];
    if (activeRows.length >= MAX_ACTIVE_WEBHOOKS_PER_PROJECT) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_WEBHOOK_LIMIT_REACHED",
        "单个项目最多绑定 20 个 Webhook 目标",
      );
    }

    let rows: readonly WebhookTargetRow[];
    try {
      rows = (await tx.sql`
        INSERT INTO app.project_wecom_groups (
          project_id,
          channel_type,
          webhook_label,
          webhook_url_ciphertext,
          webhook_url_key_version,
          webhook_url_fingerprint,
          webhook_url_hint,
          bound_by_user_id
        )
        VALUES (
          ${input.projectId},
          'WEBHOOK',
          ${input.label.trim()},
          ${encrypted.ciphertext},
          ${encrypted.keyVersion},
          ${normalized.fingerprint},
          ${normalized.hint},
          ${input.actorId}
        )
        RETURNING
          id,
          webhook_label AS label,
          webhook_url_hint AS "urlHint",
          to_char(
            bound_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS "boundAt",
          bound_by_snapshot->>'name' AS "boundByName",
          last_delivery_error AS "lastDeliveryError"
      `) as unknown as readonly WebhookTargetRow[];
    } catch (error) {
      if ((error as { readonly code?: string }).code === "23505") {
        throw new ProjectWecomGroupError(
          409,
          "PROJECT_WECOM_WEBHOOK_ALREADY_BOUND",
          "该 Webhook 已绑定到一个活跃项目目标，不能重复添加",
        );
      }
      throw error;
    }
    const row = rows[0];
    if (row === undefined) {
      throw new Error("project wecom webhook insert returned no row");
    }
    const target: ProjectWecomWebhookTarget = {
      id: row.id,
      label: row.label,
      urlHint: row.urlHint,
      boundAt: row.boundAt,
      boundByName: row.boundByName ?? "未知",
      lastDeliveryError: row.lastDeliveryError,
    };
    await this.audit.append(tx, {
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.wecomGroup.webhook.create",
      targetType: "PROJECT_WECOM_GROUP",
      targetId: String(target.id),
      eventPayload: {
        projectId: input.projectId,
        webhookBindingId: target.id,
        label: target.label,
        urlHint: target.urlHint,
      },
      requestId: input.requestId,
      occurredAt: new Date(),
    });
    return {
      responseStatus: 201,
      responseSchemaRef: "ProjectWecomWebhookTarget",
      responseHasBody: true,
      responseBody: target,
      replayAuthContext: { projectId: input.projectId, bindingId: target.id },
    };
  }

  async deleteWebhook(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly bindingId: number;
      readonly requestId: string;
    },
  ): Promise<IdempotencyExecutionResult> {
    await this.requireBinderRole(tx, input);
    const revoked = (await tx.sql`
      UPDATE app.project_wecom_groups
         SET status = 'REVOKED',
             revoked_at = now(),
             updated_at = now(),
             row_version = row_version + 1
       WHERE id = ${input.bindingId}
         AND project_id = ${input.projectId}
         AND channel_type = 'WEBHOOK'
         AND status = 'ACTIVE'
      RETURNING
        id,
        webhook_label AS label,
        webhook_url_hint AS "urlHint"
    `) as unknown as readonly {
      id: number;
      label: string;
      urlHint: string;
    }[];
    const binding = revoked[0];
    if (binding === undefined) {
      throw new ProjectWecomGroupError(
        404,
        "PROJECT_WECOM_WEBHOOK_NOT_FOUND",
        "Webhook 目标不存在、已解除或不属于当前项目",
      );
    }
    await this.audit.append(tx, {
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.wecomGroup.webhook.delete",
      targetType: "PROJECT_WECOM_GROUP",
      targetId: String(binding.id),
      eventPayload: {
        projectId: input.projectId,
        webhookBindingId: binding.id,
        label: binding.label,
        urlHint: binding.urlHint,
      },
      requestId: input.requestId,
      occurredAt: new Date(),
    });
    return {
      responseStatus: 204,
      responseSchemaRef: null,
      responseHasBody: false,
      responseBody: null,
      replayAuthContext: {
        projectId: input.projectId,
        bindingId: input.bindingId,
      },
    };
  }

  async notificationOptionsReplayAuthorizer(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const parsed = projectWecomGroupReplayContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new Error("invalid project wecom group replay context");
    }
    await this.requireBinderRole(tx, {
      actorId,
      projectId: parsed.data.projectId,
    });
    const bindings = (await tx.sql`
      SELECT id
        FROM app.project_wecom_groups
       WHERE project_id = ${parsed.data.projectId}
         AND channel_type = 'WEBHOOK'
         AND status = 'ACTIVE'
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    if (bindings[0] === undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_GROUP_NOT_BOUND",
        "项目尚未添加 ACTIVE Webhook 群目标，无法重放群通知选项保存请求",
      );
    }
  }

  async createWebhookReplayAuthorizer(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const parsed = projectWecomWebhookReplayContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new Error("invalid project wecom webhook replay context");
    }
    await this.requireBinderRole(tx, {
      actorId,
      projectId: parsed.data.projectId,
    });
    const rows = (await tx.sql`
      SELECT id
        FROM app.project_wecom_groups
       WHERE id = ${parsed.data.bindingId}
         AND project_id = ${parsed.data.projectId}
         AND channel_type = 'WEBHOOK'
         AND status = 'ACTIVE'
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    if (rows[0] === undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_WEBHOOK_NOT_ACTIVE",
        "Webhook 目标已解除，不能重放旧创建响应",
      );
    }
  }

  async deleteWebhookReplayAuthorizer(
    tx: TransactionContext,
    actorId: number,
    context: unknown,
  ): Promise<void> {
    const parsed = projectWecomWebhookReplayContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new Error("invalid project wecom webhook replay context");
    }
    await this.requireBinderRole(tx, {
      actorId,
      projectId: parsed.data.projectId,
    });
    const rows = (await tx.sql`
      SELECT id
        FROM app.project_wecom_groups
       WHERE id = ${parsed.data.bindingId}
         AND project_id = ${parsed.data.projectId}
         AND channel_type = 'WEBHOOK'
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    if (rows[0] === undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_WEBHOOK_NOT_FOUND",
        "Webhook 目标不存在，不能重放旧解绑响应",
      );
    }
  }

  private async requireReadableProject(
    tx: TransactionContext,
    input: { readonly actorId: number; readonly projectId: number },
  ): Promise<void> {
    const check = await this.access.checkProjectForWrite(tx, {
      actorUserId: input.actorId,
      projectId: input.projectId,
    });
    if (check.kind === "not-found") {
      throw this.notFound();
    }
  }

  private async requireBinderRole(
    tx: TransactionContext,
    input: { readonly actorId: number; readonly projectId: number },
  ): Promise<void> {
    await this.requireReadableProject(tx, input);
    const role = await this.roleGate.wecomGroupBinderRole(
      tx,
      input.actorId,
      input.projectId,
    );
    if (role === "NOT_MEMBER") {
      throw this.notFound();
    }
  }

  private notFound(): ProjectWecomGroupError {
    return new ProjectWecomGroupError(
      404,
      "PROJECT_WECOM_GROUP_NOT_FOUND",
      "项目不存在或当前用户无权访问",
    );
  }
}

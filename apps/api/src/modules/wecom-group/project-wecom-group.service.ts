import { Inject, Injectable } from "@nestjs/common";

import type {
  ProjectWecomGroupCode,
  ProjectWecomGroupNotificationOptions,
  ProjectWecomGroupStatus,
} from "@inpulse/api-contract";
import {
  projectNotificationCategories,
  projectWecomGroupReplayContextSchema,
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
  WECOM_BINDING_CODE_TTL_MS,
  generateWecomBindingCode,
  hashWecomBindingCode,
} from "../wecom-binding/index.js";

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

/** 绑定码有效期沿用 ADR-069 的 10 分钟（ADR-077 复用同一编码与哈希规则）。 */
const CODE_TTL_SECONDS = Math.floor(WECOM_BINDING_CODE_TTL_MS / 1000);

export class ProjectWecomGroupError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectWecomGroupError";
  }
}

/**
 * ADR-077 项目企微群绑定服务：读取绑定三态；签发一次性绑定码（组长/系统管理员）；
 * 解绑（同一事务内作废待用码 + ACTIVE 绑定置 REVOKED + 写审计，不物理删除）。
 * 所有写命令必须显式接收同一个 TransactionContext。绑定兑换发生在长连接桥接侧，
 * 调用 app.redeem_project_wecom_binding_code（错误码 PWG01～PWG08）；本服务不接触
 * 明文码存储，也不做任何网络调用。
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
    const rows = (await tx.sql`
      SELECT
        (
          SELECT to_char(
                   g.bound_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                 )
            FROM app.project_wecom_groups AS g
           WHERE g.project_id = ${input.projectId}
             AND g.status = 'ACTIVE'
           LIMIT 1
        ) AS bound_at,
        (
          SELECT g.bound_by_snapshot->>'name'
            FROM app.project_wecom_groups AS g
           WHERE g.project_id = ${input.projectId}
             AND g.status = 'ACTIVE'
           LIMIT 1
        ) AS bound_by_name,
        (
          SELECT to_char(
                   c.expires_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                 )
            FROM app.project_wecom_binding_codes AS c
           WHERE c.project_id = ${input.projectId}
             AND c.consumed_at IS NULL
             AND c.expires_at > now()
           LIMIT 1
        ) AS code_expires_at,
        (
          SELECT g.last_delivery_error
            FROM app.project_wecom_groups AS g
           WHERE g.project_id = ${input.projectId}
             AND g.status = 'ACTIVE'
           LIMIT 1
        ) AS last_delivery_error,
        (
          SELECT o.task_assign_enabled
            FROM app.project_wecom_group_notification_options AS o
           WHERE o.project_id = ${input.projectId}
        ) AS "taskAssignEnabled",
        (
          SELECT o.task_status_enabled
            FROM app.project_wecom_group_notification_options AS o
           WHERE o.project_id = ${input.projectId}
        ) AS "taskStatusEnabled",
        (
          SELECT o.record_enabled
            FROM app.project_wecom_group_notification_options AS o
           WHERE o.project_id = ${input.projectId}
        ) AS "recordEnabled",
        (
          SELECT o.project_member_enabled
            FROM app.project_wecom_group_notification_options AS o
           WHERE o.project_id = ${input.projectId}
        ) AS "projectMemberEnabled",
        (
          SELECT o.scope_delete_enabled
            FROM app.project_wecom_group_notification_options AS o
           WHERE o.project_id = ${input.projectId}
        ) AS "scopeDeleteEnabled",
        (
          SELECT r.bot_profile_url
            FROM app.wecom_robot_config AS r
           WHERE r.id = 1
        ) AS bot_profile_url
    `) as unknown as readonly {
      bound_at: string | null;
      bound_by_name: string | null;
      code_expires_at: string | null;
      last_delivery_error: string | null;
      taskAssignEnabled: boolean | null;
      taskStatusEnabled: boolean | null;
      recordEnabled: boolean | null;
      projectMemberEnabled: boolean | null;
      scopeDeleteEnabled: boolean | null;
      bot_profile_url: string | null;
    }[];
    const row = rows[0];
    const boundAt = row?.bound_at ?? null;
    const codeExpiresAt = row?.code_expires_at ?? null;
    return {
      state:
        boundAt !== null
          ? "BOUND"
          : codeExpiresAt !== null
            ? "PENDING"
            : "UNBOUND",
      codeExpiresAt,
      boundAt,
      boundByName: row?.bound_by_name ?? null,
      lastDeliveryError: row?.last_delivery_error ?? null,
      botProfileUrl: row?.bot_profile_url ?? null,
      notificationOptions: notificationOptionsFromRow(row),
    };
  }

  async createCode(
    tx: TransactionContext,
    input: { readonly actorId: number; readonly projectId: number },
  ): Promise<ProjectWecomGroupCode> {
    await this.requireBinderRole(tx, input);
    const code = generateWecomBindingCode();
    const codeHash = hashWecomBindingCode(code);
    const rows = (await tx.sql`
      INSERT INTO app.project_wecom_binding_codes AS c
        (
          project_id,
          code_hash,
          expires_at,
          consumed_at,
          consumed_by_wecom_userid,
          consumed_by_user_id
        )
      VALUES
        (
          ${input.projectId},
          ${codeHash},
          now() + make_interval(secs => ${CODE_TTL_SECONDS}),
          NULL,
          NULL,
          NULL
        )
      ON CONFLICT (project_id) DO UPDATE
         SET code_hash = EXCLUDED.code_hash,
             expires_at = EXCLUDED.expires_at,
             consumed_at = NULL,
             consumed_by_wecom_userid = NULL,
             consumed_by_user_id = NULL,
             created_at = now()
      RETURNING to_char(
                 c.expires_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
               ) AS expires_at
    `) as unknown as readonly { expires_at: string }[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("project wecom group code upsert returned no row");
    }
    return { code, expiresAt: row.expires_at };
  }

  async unbind(
    tx: TransactionContext,
    input: {
      readonly actorId: number;
      readonly projectId: number;
      readonly requestId: string;
    },
  ): Promise<IdempotencyExecutionResult> {
    await this.requireBinderRole(tx, input);
    const pendingCodes = (await tx.sql`
      UPDATE app.project_wecom_binding_codes
         SET consumed_at = now(),
             consumed_by_wecom_userid = NULL,
             consumed_by_user_id = NULL
       WHERE project_id = ${input.projectId}
         AND consumed_at IS NULL
      RETURNING project_id
    `) as unknown as readonly { project_id: number }[];
    const revoked = (await tx.sql`
      UPDATE app.project_wecom_groups
         SET status = 'REVOKED',
             revoked_at = now(),
             updated_at = now(),
             row_version = row_version + 1
       WHERE project_id = ${input.projectId}
         AND status = 'ACTIVE'
      RETURNING id, wecom_chat_id AS "wecomChatId"
    `) as unknown as readonly { id: number; wecomChatId: string }[];
    const binding = revoked[0];
    await this.audit.append(tx, {
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.actorId,
      action: "project.wecomGroup.unbind",
      targetType: "PROJECT",
      targetId: String(input.projectId),
      eventPayload: {
        projectId: input.projectId,
        hadActiveBinding: binding !== undefined,
        groupBindingId: binding?.id ?? null,
        wecomChatId: binding?.wecomChatId ?? null,
        pendingCodeRevoked: pendingCodes.length > 0,
      },
      requestId: input.requestId,
      occurredAt: new Date(),
    });
    return {
      responseStatus: 204,
      responseSchemaRef: null,
      responseHasBody: false,
      responseBody: null,
      replayAuthContext: { projectId: input.projectId },
    };
  }

  /**
   * ADR-090：整组替换项目群通知开关。先锁 ACTIVE 群绑定，确保项目仍处于已绑定状态；
   * 再插入缺省行并 FOR UPDATE 读取旧值，随后更新与审计共用同一事务。
   */
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
         AND status = 'ACTIVE'
       FOR UPDATE
    `) as unknown as readonly { id: number }[];
    const binding = bindings[0];
    if (binding === undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_GROUP_NOT_BOUND",
        "项目尚未绑定企业微信群，无法保存群通知选项",
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

  /**
   * ADR-090 保存开关的幂等重放门禁：除重新校验组长 / 管理员身份外，
   * 项目还必须仍存在 ACTIVE 群绑定；解绑或换绑后不得再重放旧保存响应。
   */
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
         AND status = 'ACTIVE'
       LIMIT 1
    `) as unknown as readonly { id: number }[];
    if (bindings[0] === undefined) {
      throw new ProjectWecomGroupError(
        409,
        "PROJECT_WECOM_GROUP_NOT_BOUND",
        "项目尚未绑定企业微信群，无法重放群通知选项保存请求",
      );
    }
  }

  /**
   * 解绑幂等重放门禁（`projectWecomGroupReadAuthorizer`）：绑定行已 REVOKED 但
   * 项目仍在，重放只复核「如果绑定还在，这个人当初还能不能解绑」——重新读取
   * 实时成员关系与项目可写状态，组长被转移/降级、成员被移除或项目已删除一律
   * 拒绝；当前认证（Session 有效、用户未停用）由 HTTP 层在调用前完成。
   */
  async replayAuthorizer(
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
  }

  /**
   * 读路径门禁：项目存在且当前用户为活跃成员或系统管理员，否则 404
   * （与「资源不存在」不可区分，不泄露项目存在性）。
   */
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

  /**
   * ADR-077 写门禁：项目可写 + 组长/系统管理员专属（ADR-039 例外清单）。
   * 普通成员 403 `PROJECT_WECOM_GROUP_FORBIDDEN`；非成员/已移除 404。
   */
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

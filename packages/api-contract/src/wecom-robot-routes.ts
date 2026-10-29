import type { RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): RouteDefinition["responses"][string] => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const readErrors = {
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "500": json("ErrorResponse"),
};

const writeErrors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "409": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "500": json("ErrorResponse"),
  // 主密钥缺失 / 非法且本次请求需要加密新密钥时 fail closed（ADR-070）。
  "503": json("ErrorResponse"),
};

/** WecomRobotConfig 响应可安全进入幂等重放的全部叶子字段。 */
const configReplayFields = [
  "botId",
  "botProfileUrl",
  "configured",
  "disabledReason",
  "ready",
  "revokedProjectGroups",
  "revokedUserBindings",
  "rowVersion",
  "secretHint",
  "secretKeyVersion",
  "updatedAt",
  "updatedByName",
] as const;

const configReplayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "WecomRobotConfig" as const,
        safeBodyFieldPaths: configReplayFields,
      },
    },
  },
} as const;

const configReplayAuthorization = {
  version: "1.0.0",
  resources: {
    contextSchemaRef: "WecomRobotReplayContext" as const,
    resultRefExtractor: "wecomRobotConfigRow",
    currentReadAuthorizer: "adminWecomRobotConfigAuthorizer",
  },
} as const;

/**
 * ADR-070：企业微信机器人凭据的管理员在线配置。
 * GET 读取当前配置与可用状态；PUT 加密保存 botId / secret / botProfileUrl
 * 并写审计。两条路由都只服务完整管理员 Session（ADR-031 起不要求 TOTP 重认证）。
 */
export const wecomRobotRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/admin/wecom-robot",
    operationId: "getWecomRobotConfig",
    summary:
      "系统管理员读取企业微信机器人的当前配置；只返回 botId、密钥尾号与机器人链接，永不回显密钥；响应 no-store。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("WecomRobotConfig"), ...readErrors },
    authPolicy: "adminSession",
    csrfPolicy: "none",
    idempotencyPolicy: "none",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "PUT",
    path: "/admin/wecom-robot",
    operationId: "updateWecomRobotConfig",
    summary:
      "系统管理员保存企业微信机器人配置（botId 必填，secret 缺省表示保持已存密钥，botProfileUrl 缺省保持、null 清空），密钥经 AES-256-GCM 加密落库、明文永不入库；botId 与已存值不同（更换机器人）时同一事务只解除个人企业微信绑定，项目群 Webhook 不受影响；响应保留解绑计数，其中 revokedProjectGroups 固定为 0；写审计（不含密钥）。",
    request: {
      path: "none",
      query: "none",
      headers: "WecomRobotMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "WecomRobotConfigUpdateRequest",
          },
        ],
      },
    },
    responses: { "200": json("WecomRobotConfig"), ...writeErrors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // 2026-10-13：请求新增 botProfileUrl 语义输入、响应新增该重放安全字段，
    // 同版本指纹变化，故升级契约版本让旧 Key 在新契约下 409。
    // 2026-10-15：响应新增解绑计数（revokedUserBindings / revokedProjectGroups），
    // 同上让旧 Key 在新契约下 409，契约版本 1.1.0 → 1.2.0。
    idempotencyContractVersion: "1.2.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: configReplayPolicy,
    replayAuthorizationPolicy: configReplayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "none",
    },
    concurrencyPolicy: {
      rowVersion: "none",
      lockOrder: "none",
      retry:
        "单行配置 SELECT ... FOR UPDATE 显式行锁，更新成功后递增 row_version；不自动重试",
    },
    auditAction: "admin.wecomRobot.update",
  },
];

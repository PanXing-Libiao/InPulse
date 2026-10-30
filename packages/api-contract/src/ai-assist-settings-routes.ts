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

const modelsErrors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "500": json("ErrorResponse"),
};

const writeErrors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "409": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "500": json("ErrorResponse"),
  // 主密钥缺失 / 非法且本次请求需要加密新密钥时 fail closed（ADR-068）。
  "503": json("ErrorResponse"),
};

/** `AiAssistSettings` 响应可安全进入幂等重放的全部叶子字段。 */
const settingsReplayFields = [
  "disabledReason",
  "enabled",
  "endpoint",
  "keyConfigured",
  "keyHint",
  "maxTokens",
  "model",
  "ready",
  "rowVersion",
  "source",
  "timeoutMs",
  "updatedAt",
] as const;

const settingsReplayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "AiAssistSettings" as const,
        safeBodyFieldPaths: settingsReplayFields,
      },
    },
  },
} as const;

const settingsReplayAuthorization = {
  version: "1.0.0",
  resources: {
    contextSchemaRef: "AiAssistSettingsReplayContext" as const,
    resultRefExtractor: "aiAssistSettingsRow",
    currentReadAuthorizer: "adminAiAssistSettingsAuthorizer",
  },
} as const;

/**
 * ADR-068：AI 辅助转换管理员在线配置。
 * GET 读取当前生效状态；PUT 加密保存密钥并写审计；POST test 为纯校验探测；
 * POST models 用当前表单的一次性配置读取上游可用模型，密钥不落库。
 * 四条路由都只服务完整管理员 Session（ADR-031 起不要求 TOTP 重认证）。
 */
export const aiAssistSettingsRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/admin/ai-assist",
    operationId: "getAiAssistSettings",
    summary:
      "系统管理员读取 AI 辅助转换的当前生效配置与状态；只返回密钥尾号与是否已配置，永不回显密钥；响应 no-store。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("AiAssistSettings"), ...readErrors },
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
    path: "/admin/ai-assist",
    operationId: "updateAiAssistSettings",
    summary:
      "系统管理员保存 AI 辅助转换配置：整体替换非敏感项，apiKey 缺省表示保持已存密钥，提供时经 AES-256-GCM 加密落库；写审计（不含密钥）。",
    request: {
      path: "none",
      query: "none",
      headers: "AiAssistSettingsMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AiAssistSettingsUpdateRequest",
          },
        ],
      },
    },
    responses: { "200": json("AiAssistSettings"), ...writeErrors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: settingsReplayPolicy,
    replayAuthorizationPolicy: settingsReplayAuthorization,
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
    auditAction: "admin.aiAssistSettings.update",
  },
  {
    method: "POST",
    path: "/admin/ai-assist/models",
    operationId: "listAiAssistModels",
    summary:
      "系统管理员用设置页当前填写的端点、超时与一次性密钥向 OpenAI 兼容上游请求 /v1/models，返回当前令牌可用的模型 ID；apiKey 留空时复用已保存密钥。不写任何持久化状态、不发送用户数据、不写审计。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AiAssistModelsRequest",
          },
        ],
      },
    },
    responses: { "200": json("AiAssistModelsResponse"), ...modelsErrors },
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
    method: "POST",
    path: "/admin/ai-assist/test",
    operationId: "testAiAssistSettings",
    summary:
      "系统管理员用当前生效配置向上游发送 max_tokens=1 的最小探测请求，验证端点 / 密钥 / 模型可用；不写任何持久化状态、不发送用户数据、不写审计。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("AiAssistSettingsTestResponse"), ...readErrors },
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
];

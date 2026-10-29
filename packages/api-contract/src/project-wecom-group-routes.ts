import type { RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): RouteDefinition["responses"][string] => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const error = json("ErrorResponse");

/**
 * ADR-090 / ADR-105 / ADR-106：企业微信项目群 Webhook 通知目标（项目级）。
 * 项目群只支持群机器人 Webhook；个人单聊智能机器人不受本组路由影响。
 * GET 对活跃成员开放；通知选项、Webhook 创建与删除沿用 projectWecomGroup
 * 能力门禁、CSRF、数据库级幂等和项目级审计。
 */
export const projectWecomGroupRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/projects/{projectId}/wecom-group",
    operationId: "getProjectWecomGroup",
    summary:
      "读取项目企业微信群 Webhook 状态与通知开关；本项目活跃成员或系统管理员可读，非成员按资源不存在 404。响应含 UNBOUND / BOUND、脱敏 Webhook 目标列表和五类通知开关，no-store。",
    request: {
      path: "ProjectWecomGroupPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": json("ProjectWecomGroupStatus"),
      "401": error,
      "404": error,
      "500": error,
    },
    authPolicy: "session",
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
    path: "/projects/{projectId}/wecom-group/notification-options",
    operationId: "updateProjectWecomGroupNotificationOptions",
    summary:
      "保存项目企业微信群的通知开关：整组替换 disabledCategories；仅系统管理员或本项目组长可写，且项目必须至少有一个 ACTIVE Webhook；设置只影响之后物化的群消息，历史与已排队消息不回溯；CSRF 与 Idempotency-Key 必填，写审计 project.wecomGroup.notificationOptions.update。",
    request: {
      path: "ProjectWecomGroupPath",
      query: "none",
      headers: "ProjectWecomGroupMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "ProjectWecomGroupNotificationOptions",
          },
        ],
      },
    },
    responses: {
      "200": json("ProjectWecomGroupNotificationOptions"),
      "400": error,
      "401": error,
      "403": error,
      "404": error,
      "409": error,
      "422": error,
      "500": error,
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "ProjectWecomGroupNotificationOptions",
            safeBodyFieldPaths: ["disabledCategories[]"],
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "ProjectWecomGroupReplayContext",
        resultRefExtractor: "projectId",
        currentReadAuthorizer: "projectWecomGroupNotificationOptionsAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "project.wecomGroup.notificationOptions.update",
  },
  {
    method: "POST",
    path: "/projects/{projectId}/wecom-group/webhooks",
    operationId: "createProjectWecomWebhook",
    summary:
      "添加项目企业微信 Webhook 群目标：严格限制为企业微信官方群机器人 URL，服务端加密保存完整 URL，只返回标签、Key 尾号、绑定时间、绑定人与最近投递错误；同一 URL 全局只能有一个 ACTIVE 目标，单项目最多 20 个；仅具有 projectWecomGroup 能力的成员可写（默认组长/系统管理员），非成员 404；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.webhook.create。",
    request: {
      path: "ProjectWecomGroupPath",
      query: "none",
      headers: "ProjectWecomGroupMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "ProjectWecomWebhookCreateRequest",
          },
        ],
      },
    },
    responses: {
      "201": json("ProjectWecomWebhookTarget"),
      "400": error,
      "401": error,
      "403": error,
      "404": error,
      "409": error,
      "422": error,
      "500": error,
      "503": error,
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "201": {
          body: {
            responseSchemaRef: "ProjectWecomWebhookTarget",
            safeBodyFieldPaths: [
              "id",
              "label",
              "urlHint",
              "boundAt",
              "boundByName",
              "lastDeliveryError",
            ],
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "ProjectWecomWebhookReplayContext",
        resultRefExtractor: "bindingId",
        currentReadAuthorizer: "projectWecomWebhookCreateReplayAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "project.wecomGroup.webhook.create",
  },
  {
    method: "DELETE",
    path: "/projects/{projectId}/wecom-group/webhooks/{bindingId}",
    operationId: "deleteProjectWecomWebhook",
    summary:
      "解除指定项目 Webhook 群目标：ACTIVE 目标置 REVOKED（不物理删除，保留投递历史）；目标必须属于该项目且 channel_type=WEBHOOK；仅具有 projectWecomGroup 能力的成员可写，非成员 404；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.webhook.delete，不记录完整 URL 或 Key。",
    request: {
      path: "ProjectWecomWebhookPath",
      query: "none",
      headers: "ProjectWecomGroupMutationHeaders",
      body: { noBody: true },
    },
    responses: {
      "204": { noBody: true },
      "400": error,
      "401": error,
      "403": error,
      "404": error,
      "409": error,
      "500": error,
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: { "204": { noBody: true } },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "ProjectWecomWebhookReplayContext",
        resultRefExtractor: "bindingId",
        currentReadAuthorizer: "projectWecomWebhookDeleteReplayAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "project.wecomGroup.webhook.delete",
  },
];

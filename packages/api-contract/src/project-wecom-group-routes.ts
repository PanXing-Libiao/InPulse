import type { RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): RouteDefinition["responses"][string] => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const error = json("ErrorResponse");

/**
 * ADR-077：企业微信项目群绑定（项目级）。
 * GET 读取当前绑定状态（成员可读）；POST codes 签发一次性绑定码
 * （securityFlow，ADR-023 allowlist 扩展，仅组长/系统管理员）；DELETE 解绑
 * （状态流转 + 审计，仅组长/系统管理员）。绑定兑换发生在长连接桥接侧，
 * 调用 app.redeem_project_wecom_binding_code（PWG01～PWG08）。
 */
export const projectWecomGroupRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/projects/{projectId}/wecom-group",
    operationId: "getProjectWecomGroup",
    summary:
      "读取项目企业微信群绑定状态；本项目活跃成员或系统管理员可读，非成员按资源不存在 404。返回三态（UNBOUND / PENDING / BOUND）、待用码过期时间、绑定人与绑定时间、桥接侧最近投递错误与机器人资料链接；响应 no-store。",
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
    method: "POST",
    path: "/projects/{projectId}/wecom-group/codes",
    operationId: "createProjectWecomGroupCode",
    summary:
      "为项目签发一次性企微群绑定码（10 分钟有效；明文只返回一次，服务端只存 SHA-256 Hash）。ADR-077 将本路由加入 ADR-023 allowlist：签发一次性安全材料，重复请求签发新码并立即作废旧码、不进入通用幂等记录。仅系统管理员或本项目组长可签发（普通成员 403 PROJECT_WECOM_GROUP_FORBIDDEN，非成员 404），CSRF 与同源校验必填。",
    request: {
      path: "ProjectWecomGroupPath",
      query: "none",
      headers: "ProjectWecomGroupMutationHeaders",
      body: { noBody: true },
    },
    responses: {
      "201": json("ProjectWecomGroupCode"),
      "400": error,
      "401": error,
      "403": error,
      "404": error,
      "500": error,
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "securityFlow",
    idempotencyExceptionAdr: "ADR-023",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: {
      singleConsumptionOrNaturalIdempotency:
        "每次调用在同一事务内覆盖签发新码并立即作废旧码；码只存 SHA-256 Hash，10 分钟有效、一次性消费（兑换函数按 Hash 行锁 + 条件消费 + 唯一索引兜底），不存在重复签发或重放歧义；码被兑换前不产生任何绑定",
      clientRecoveryPath:
        "重新调用本端点生成新码；无效、已过期或已被使用的码一律拒绝兑换，由组长或系统管理员在项目成员页重新生成",
    },
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "PUT",
    path: "/projects/{projectId}/wecom-group/notification-options",
    operationId: "updateProjectWecomGroupNotificationOptions",
    summary:
      "保存项目企业微信群的通知开关：整组替换 disabledCategories；仅系统管理员或本项目组长可写，且项目必须已绑定 ACTIVE 群；设置只影响之后物化的群消息，历史与已排队消息不回溯；CSRF 与 Idempotency-Key 必填，写审计 project.wecomGroup.notificationOptions.update。",
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
    method: "DELETE",
    path: "/projects/{projectId}/wecom-group",
    operationId: "deleteProjectWecomGroup",
    summary:
      "解除项目与企业微信群的绑定：作废待用绑定码并把 ACTIVE 绑定置 REVOKED（状态流转，不物理删除；重新绑定生成新绑定行、旧行保留投递历史）；仅系统管理员或本项目组长（普通成员 403 PROJECT_WECOM_GROUP_FORBIDDEN，非成员 404）；CSRF 与 Idempotency-Key 必填；写审计 project.wecomGroup.unbind。",
    request: {
      path: "ProjectWecomGroupPath",
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
        contextSchemaRef: "ProjectWecomGroupReplayContext",
        resultRefExtractor: "projectId",
        currentReadAuthorizer: "projectWecomGroupReadAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "project.wecomGroup.unbind",
  },
];

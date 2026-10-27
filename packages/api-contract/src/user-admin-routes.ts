import type { RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): RouteDefinition["responses"][string] => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const errors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "404": json("ErrorResponse"),
  "409": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "500": json("ErrorResponse"),
};

const safeUserFields = [
  "id",
  "loginName",
  "name",
  "email",
  "avatarUrl",
  "isAdmin",
  "organizations[].id",
  "organizations[].name",
  "organizations[].source",
  "organizations[].groupPath",
  "managedBySso",
  "status",
  "openTaskCount",
  "rowVersion",
  "disabledAt",
  "deletedAt",
  "createdAt",
  "updatedAt",
] as const;

const resourceReplay = {
  version: "1.0.0",
  resources: {
    contextSchemaRef: "AdminUserReplayContext" as const,
    resultRefExtractor: "adminUserId",
    currentReadAuthorizer: "adminUserReadAuthorizer",
  },
} as const;

const replayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "AdminUserItem" as const,
        safeBodyFieldPaths: safeUserFields,
      },
    },
  },
} as const;

const noBodyReplayPolicy = {
  version: "1.0.0",
  success: { "204": { noBody: true as const } },
} as const;

const upstreamErrors = {
  ...errors,
  "503": json("ErrorResponse"),
} as const;

/** Casdoor 导入结果只含计数，不含目录 PII；重放只要求原操作人仍是完整管理员。 */
const casdoorImportReplayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "CasdoorImportResult" as const,
        safeBodyFieldPaths: [
          "scannedUserCount",
          "created",
          "linked",
          "refreshed",
          "skipped",
          "createdOrganizationCount",
          "membershipCount",
        ],
      },
    },
  },
} as const;

const casdoorImportWritePolicy = {
  idempotencyExceptionAdr: "none",
  idempotencyContractVersion: "1.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  idempotencyReplayPolicy: casdoorImportReplayPolicy,
  replayAuthorizationPolicy: {
    version: "1.0.0",
    actorOnly: true as const,
  },
  securityFlowPolicy: "none",
} as const;

const writePolicy = {
  idempotencyExceptionAdr: "none",
  idempotencyContractVersion: "1.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  idempotencyReplayPolicy: replayPolicy,
  replayAuthorizationPolicy: resourceReplay,
  securityFlowPolicy: "none",
} as const;

const noBodyWritePolicy = {
  ...writePolicy,
  idempotencyReplayPolicy: noBodyReplayPolicy,
} as const;

/**
 * ADR-088 物理删除后目标用户行已不存在，重放只校验原始操作人与删除身份快照；
 * 安全重放语义变化，幂等契约版本随之升级。
 */
const deleteWritePolicy = {
  ...noBodyWritePolicy,
  idempotencyContractVersion: "2.0.0",
  replayAuthorizationPolicy: {
    version: "1.0.0",
    actorOnly: true as const,
  },
} as const;

/** 停用请求新增任务交接与组长移交 body，旧幂等 Key 在新契约下返回 409。 */
const disableWritePolicy = {
  ...noBodyWritePolicy,
  idempotencyContractVersion: "3.0.0",
} as const;

/**
 * createUser / updateUser 的响应为 AdminUserItem：ADR-081 新增 openTaskCount，
 * ADR-082 新增 deletedAt，ADR-097 将单一 organizationId 改为 organizations 数组
 * 并新增 managedBySso。响应 Schema 与可重放叶子字段都已变化，因此把这两条路由的
 * 幂等契约版本升级到 1.4.0（旧 Key 在新契约下返回 409）。
 */
const userBodyWritePolicy = {
  ...writePolicy,
  idempotencyContractVersion: "1.4.0",
} as const;

const versionedWritePolicy = {
  versionPolicy: {
    apiVersion: "v1",
    schemaVersion: "1.0.0",
    ifMatch: "required" as const,
  },
  concurrencyPolicy: {
    rowVersion: "required" as const,
    lockOrder: "none" as const,
    retry:
      "目标用户 FOR UPDATE；管理员移除前按 id 升序锁定全部活跃管理员；版本或状态冲突返回 409，不自动重试",
  },
};

const createWritePolicy = {
  versionPolicy: {
    apiVersion: "v1",
    schemaVersion: "1.0.0",
    ifMatch: "none" as const,
  },
  concurrencyPolicy: {
    rowVersion: "none" as const,
    lockOrder: "none" as const,
    retry: "登录名/邮箱唯一约束兜底；冲突映射 409",
  },
} as const;

export const adminUserRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/admin/users",
    operationId: "listAdminUsers",
    summary:
      "系统管理员读取当前存在的用户账号，用于编辑、启停与角色管理；已物理删除的账号不再出现在列表，不返回任何认证材料。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("AdminUserListResponse"), ...errors },
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
    method: "GET",
    path: "/admin/users/{userId}/offboarding",
    operationId: "getAdminUserOffboarding",
    summary:
      "系统管理员读取待停用账号的交接清单：按项目分组返回未完成任务、当前负责人与可接手的项目成员；无任务时返回空 projects。",
    request: {
      path: "AdminUserPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("AdminUserOffboardingResponse"), ...errors },
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
    method: "GET",
    path: "/admin/users/casdoor-import/preview",
    operationId: "previewCasdoorUserImport",
    summary:
      "系统管理员实时读取配置 Casdoor 组织的启用账号，过滤 Virtual 与停用组，并按平台身份映射给出创建、绑定、刷新或跳过预览；不写数据库。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": json("CasdoorImportPreviewResponse"),
      ...upstreamErrors,
    },
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
    path: "/admin/users/casdoor-import",
    operationId: "importCasdoorUsers",
    summary:
      "系统管理员按预览勾选一次性批量导入 Casdoor 账号：新建账号无本地口令且非管理员，按既有规则绑定同名账号，并在同一事务内同步 Physical 组织与成员关系；不自动停用或删除平台账号。",
    request: {
      path: "none",
      query: "none",
      headers: "AdminUserMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "CasdoorImportRequest",
          },
        ],
      },
    },
    responses: { "200": json("CasdoorImportResult"), ...upstreamErrors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: [],
    ...casdoorImportWritePolicy,
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "none",
    },
    concurrencyPolicy: {
      rowVersion: "none",
      lockOrder: "none",
      retry:
        "单事务按 Casdoor 账号标识逐项锁定平台用户；目录在事务外读取，身份冲突跳过该账号，目录在预览后缺失所选账号时整批 409 并要求重新预览",
    },
    auditAction: "admin.user.casdoorImport",
  },
  {
    method: "POST",
    path: "/admin/users",
    operationId: "createUser",
    summary:
      "系统管理员新增用户；初始密码只接收一次并生成 Argon2id 哈希，同一事务写用户与审计留痕。",
    request: {
      path: "none",
      query: "none",
      headers: "AdminUserMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AdminUserCreateRequest",
          },
        ],
      },
    },
    responses: { "200": json("AdminUserItem"), ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: [],
    ...userBodyWritePolicy,
    ...createWritePolicy,
    auditAction: "admin.user.create",
  },
  {
    method: "PATCH",
    path: "/admin/users/{userId}",
    operationId: "updateUser",
    summary:
      "系统管理员编辑用户资料与管理员角色；移除最后一名可用管理员前按编号锁定全部活跃管理员并拒绝。",
    request: {
      path: "AdminUserPath",
      query: "none",
      headers: "AdminUserVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AdminUserUpdateRequest",
          },
        ],
      },
    },
    responses: { "200": json("AdminUserItem"), ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: ["If-Match"],
    ...userBodyWritePolicy,
    ...versionedWritePolicy,
    auditAction: "admin.user.update",
  },
  {
    method: "POST",
    path: "/admin/users/{userId}/disable",
    operationId: "disableUser",
    summary:
      "系统管理员停用指定用户：同一事务先按项目交接全部未完成任务（保留其他负责人、增补接手人或删除唯一负责人任务），并把该账号担任组长的项目移交给项目内其他活跃成员，再递增 auth_version、撤销全部 Session 并写审计；停用后所有受保护请求返回 401。",
    request: {
      path: "AdminUserPath",
      query: "none",
      headers: "AdminUserVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AdminUserDisableRequest",
          },
        ],
      },
    },
    responses: { "204": { noBody: true }, ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: ["If-Match"],
    ...disableWritePolicy,
    ...versionedWritePolicy,
    auditAction: "admin.user.disable",
  },
  {
    method: "POST",
    path: "/admin/users/{userId}/enable",
    operationId: "enableUser",
    summary:
      "系统管理员重新启用指定用户；不清除历史，不恢复已撤销 Session，并写审计。",
    request: {
      path: "AdminUserPath",
      query: "none",
      headers: "AdminUserVersionHeaders",
      body: { noBody: true },
    },
    responses: { "204": { noBody: true }, ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: ["If-Match"],
    ...noBodyWritePolicy,
    ...versionedWritePolicy,
    auditAction: "admin.user.enable",
  },
  {
    method: "POST",
    path: "/admin/users/{userId}/delete",
    operationId: "deleteUser",
    summary:
      "系统管理员物理删除已停用且已退出全部项目的用户：同事务级联清除个人 Session、TOTP、恢复码、通知与企业微信绑定，保留业务历史并写入删除前身份快照；删除不可恢复。",
    request: {
      path: "AdminUserPath",
      query: "none",
      headers: "AdminUserVersionHeaders",
      body: { noBody: true },
    },
    responses: { "204": { noBody: true }, ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: ["If-Match"],
    ...deleteWritePolicy,
    ...versionedWritePolicy,
    auditAction: "admin.user.delete",
  },
];

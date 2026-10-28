import type { BodyBinding, RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): BodyBinding => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const readErrors = {
  "401": json("ErrorResponse"),
  "500": json("ErrorResponse"),
};

const writeErrors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "409": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "500": json("ErrorResponse"),
};

/** ProjectMemberPermissions 的全部叶子字段；幂等重放必须逐字段声明。 */
const permissionFields = [
  "projectEdit",
  "projectMemberManage",
  "projectLeaderTransfer",
  "projectDelete",
  "projectDocumentImport",
  "moduleFeatureEdit",
  "moduleFeatureDelete",
  "taskEdit",
  "taskLifecycle",
  "recordWrite",
  "projectWecomGroup",
  "rowVersion",
  "updatedAt",
  "updatedByName",
] as const;

const replayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "ProjectMemberPermissions" as const,
        safeBodyFieldPaths: permissionFields,
      },
    },
  },
} as const;

const replayAuthorization = {
  version: "1.0.0",
  resources: {
    contextSchemaRef: "ProjectMemberPermissionReplayContext" as const,
    resultRefExtractor: "projectMemberPermissionSettingsRow",
    currentReadAuthorizer: "adminProjectMemberPermissionsAuthorizer",
  },
} as const;

/**
 * ADR-104：全平台项目成员权限的三档配置。
 * GET 对所有已登录账号开放，便于成员页只读展示当前策略；
 * PUT 只允许完整管理员 Session，要求 CSRF、数据库级幂等与 If-Match。
 */
export const projectMemberPermissionRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/project-member-permissions",
    operationId: "getProjectMemberPermissions",
    summary:
      "读取全平台统一的项目成员权限配置；所有已登录账号可读，成员页按当前配置只读展示。查看项目与动态、创建项目、个人通知与企业微信固定开放，不参与配置。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("ProjectMemberPermissions"), ...readErrors },
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
    path: "/project-member-permissions",
    operationId: "updateProjectMemberPermissions",
    summary:
      "系统管理员整体保存全平台项目成员权限：每项可选全部活跃成员、仅项目组长或仅系统管理员；管理员修改后下一次请求立即生效，不缓存到 Session。查看项目与动态、创建项目、个人通知与企业微信固定开放；迭代记录作废/恢复与系统管理固定仅管理员。CSRF、If-Match 与数据库幂等必填，版本冲突 409，同一事务写审计。",
    request: {
      path: "none",
      query: "none",
      headers: "ProjectMemberPermissionMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "ProjectMemberPermissionsUpdateRequest",
          },
        ],
      },
    },
    responses: { "200": json("ProjectMemberPermissions"), ...writeErrors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: replayPolicy,
    replayAuthorizationPolicy: replayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: "none",
      retry:
        "单行全局配置 SELECT ... FOR UPDATE 显式行锁；版本不符 409，不自动重试",
    },
    auditAction: "admin.projectMemberPermissions.update",
  },
];

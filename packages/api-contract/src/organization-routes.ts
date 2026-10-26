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

const organizationSafeFields = [
  "id",
  "name",
  "source",
  "groupPath",
  "parentId",
  "rowVersion",
  "createdAt",
  "updatedAt",
] as const;

/**
 * 组织 CRUD 的幂等重放授权（ADR-081 的 actorOnly 取舍）：组织行可能在重放前
 * 被改名或删除（删除是物理删除），任何资源级复核都会把合法重放变成 404；
 * 因此只复核当前有效的完整管理员会话（HTTP 层在重放前完成）。
 */
const actorOnlyReplayAuthorization = {
  version: "1.0.0",
  actorOnly: true,
} as const;

const createReplayPolicy = {
  version: "2.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "OrganizationItem" as const,
        safeBodyFieldPaths: organizationSafeFields,
      },
    },
  },
} as const;

const updateReplayPolicy = {
  version: "2.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "OrganizationItem" as const,
        safeBodyFieldPaths: organizationSafeFields,
      },
    },
  },
} as const;

const deleteReplayPolicy = {
  version: "1.0.0",
  success: { "204": { noBody: true as const } },
} as const;

const assignReplayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "OrganizationAssignResponse" as const,
        safeBodyFieldPaths: ["updatedCount"] as const,
      },
    },
  },
} as const;

const createWritePolicy = {
  idempotencyExceptionAdr: "none",
  idempotencyContractVersion: "2.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  idempotencyReplayPolicy: createReplayPolicy,
  replayAuthorizationPolicy: actorOnlyReplayAuthorization,
  securityFlowPolicy: "none",
  versionPolicy: {
    apiVersion: "v1",
    schemaVersion: "1.0.0",
    ifMatch: "none" as const,
  },
  concurrencyPolicy: {
    rowVersion: "none" as const,
    lockOrder: "none" as const,
    retry: "名称函数唯一索引兜底；冲突映射 409",
  },
} as const;

const updateWritePolicy = {
  idempotencyExceptionAdr: "none",
  idempotencyContractVersion: "2.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  idempotencyReplayPolicy: updateReplayPolicy,
  replayAuthorizationPolicy: actorOnlyReplayAuthorization,
  securityFlowPolicy: "none",
  versionPolicy: {
    apiVersion: "v1",
    schemaVersion: "1.0.0",
    ifMatch: "required" as const,
  },
  concurrencyPolicy: {
    rowVersion: "required" as const,
    lockOrder: "none" as const,
    retry: "组织行 FOR UPDATE；版本或名称冲突返回 409，不自动重试",
  },
} as const;

const deleteWritePolicy = {
  idempotencyExceptionAdr: "none",
  idempotencyContractVersion: "1.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  idempotencyReplayPolicy: deleteReplayPolicy,
  replayAuthorizationPolicy: actorOnlyReplayAuthorization,
  securityFlowPolicy: "none",
  versionPolicy: {
    apiVersion: "v1",
    schemaVersion: "1.0.0",
    ifMatch: "required" as const,
  },
  concurrencyPolicy: {
    rowVersion: "required" as const,
    lockOrder: "none" as const,
    retry: "组织行 FOR UPDATE；版本冲突返回 409，不自动重试",
  },
} as const;

const assignWritePolicy = {
  idempotencyExceptionAdr: "none",
  idempotencyContractVersion: "1.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  idempotencyReplayPolicy: assignReplayPolicy,
  replayAuthorizationPolicy: actorOnlyReplayAuthorization,
  securityFlowPolicy: "none",
  versionPolicy: {
    apiVersion: "v1",
    schemaVersion: "1.0.0",
    ifMatch: "none" as const,
  },
  concurrencyPolicy: {
    rowVersion: "none" as const,
    lockOrder: "none" as const,
    retry:
      "用户行按 id 升序 FOR UPDATE；只更新 organization_id IS DISTINCT FROM 目标值的行，重复调用自然幂等（updatedCount = 0）",
  },
} as const;

export const organizationRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/admin/organizations",
    operationId: "listOrganizations",
    summary:
      "系统管理员读取全部 LOCAL 与 CASDOOR 组织（含来源、群组完整路径、父级、行版本与时间戳）；按 id 升序，响应 no-store。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("OrganizationListResponse"), ...errors },
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
    path: "/admin/organizations",
    operationId: "createOrganization",
    summary:
      "系统管理员新建 LOCAL 组织；名称 btrim 后 1～100 字符，LOCAL 名称按 lower(btrim(name)) 唯一去重，重名 409 ORGANIZATION_NAME_CONFLICT；同一事务写审计。",
    request: {
      path: "none",
      query: "none",
      headers: "OrganizationMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "OrganizationCreateRequest",
          },
        ],
      },
    },
    responses: { "200": json("OrganizationItem"), ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: [],
    ...createWritePolicy,
    auditAction: "admin.organization.create",
  },
  {
    method: "PATCH",
    path: "/admin/organizations/{organizationId}",
    operationId: "updateOrganization",
    summary:
      "系统管理员修改 LOCAL 组织名称；CASDOOR 组织返回 409 ORGANIZATION_SSO_MANAGED；If-Match 乐观锁，版本冲突 409 ORGANIZATION_VERSION_CONFLICT、重名 409 ORGANIZATION_NAME_CONFLICT；同一事务写审计。",
    request: {
      path: "OrganizationPath",
      query: "none",
      headers: "OrganizationVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "OrganizationUpdateRequest",
          },
        ],
      },
    },
    responses: { "200": json("OrganizationItem"), ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: ["If-Match"],
    ...updateWritePolicy,
    auditAction: "admin.organization.update",
  },
  {
    method: "DELETE",
    path: "/admin/organizations/{organizationId}",
    operationId: "deleteOrganization",
    summary:
      "系统管理员删除 LOCAL 组织（物理删除）：成员关系级联清理，不删除用户；CASDOOR 组织返回 409 ORGANIZATION_SSO_MANAGED；If-Match 乐观锁；204 无正文；审计记录成员数。",
    request: {
      path: "OrganizationPath",
      query: "none",
      headers: "OrganizationVersionHeaders",
      body: { noBody: true },
    },
    responses: {
      "204": { noBody: true },
      "400": json("ErrorResponse"),
      "401": json("ErrorResponse"),
      "403": json("ErrorResponse"),
      "404": json("ErrorResponse"),
      "409": json("ErrorResponse"),
      "422": json("ErrorResponse"),
      "500": json("ErrorResponse"),
    },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: ["If-Match"],
    ...deleteWritePolicy,
    auditAction: "admin.organization.delete",
  },
  {
    method: "POST",
    path: "/admin/users/organization",
    operationId: "assignUsersOrganization",
    summary:
      "系统管理员批量调整本地账号的 LOCAL 组织归属：userIds 1～200 去重、按 id 升序 FOR UPDATE；organizationId 为 null 表示移出组织；SSO 用户或 CASDOOR 目标组织返回 409 ORGANIZATION_SSO_MANAGED；只统计实际变化的用户并返回 updatedCount；组织不存在 422 ORGANIZATION_NOT_FOUND。",
    request: {
      path: "none",
      query: "none",
      headers: "OrganizationMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "OrganizationAssignRequest",
          },
        ],
      },
    },
    responses: { "200": json("OrganizationAssignResponse"), ...errors },
    authPolicy: "adminSession",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    behaviorHeaders: [],
    ...assignWritePolicy,
    auditAction: "admin.user.organizations.assign",
  },
  {
    method: "GET",
    path: "/organizations/me/members",
    operationId: "getMyOrganizationMembers",
    summary:
      "当前登录用户读取自己所属全部组织与去重后的同组织 ACTIVE 成员（脱敏字段：id、姓名、头像、是否管理员、organizationIds；未分配返回空数组）；响应 no-store。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("MyOrganizationMembersResponse"), ...errors },
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
];

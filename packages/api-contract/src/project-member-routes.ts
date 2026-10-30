import type { BodyBinding, RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): BodyBinding => ({
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

const readPolicies = {
  // ADR-033/ADR-039：成员管理读路径下放给本项目全体活跃成员，角色门禁在
  // 权限矩阵 conditional 条目与服务层校验，系统管理员经 is_admin 旁路。
  authPolicy: "session" as const,
  csrfPolicy: "none" as const,
  idempotencyPolicy: "none" as const,
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
} as const;

const replayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "AddProjectMemberResponse" as const,
        safeBodyFieldPaths: [
          "member.membershipId",
          "member.projectId",
          "member.userId",
          "member.name",
          "member.avatarUrl",
          "member.status",
          "member.role",
          "member.joinedAt",
          "member.removedAt",
        ],
      },
    },
  },
} as const;

const removeReplayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "RemoveProjectMemberResponse" as const,
        safeBodyFieldPaths: [
          "member.membershipId",
          "member.projectId",
          "member.userId",
          "member.name",
          "member.avatarUrl",
          "member.status",
          "member.role",
          "member.joinedAt",
          "member.removedAt",
          "reassignedTaskIds[]",
          "unfinishedTaskCount",
        ],
      },
    },
  },
} as const;

const replayAuthorization = {
  version: "1.0.0",
  resources: {
    contextSchemaRef: "ProjectMemberReplayContext" as const,
    resultRefExtractor: "memberUserId",
    currentReadAuthorizer: "projectMemberReadAuthorizer",
  },
} as const;

export const projectMemberRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/projects/{projectId}/members",
    operationId: "listProjectMembers",
    summary:
      "读取项目成员完整历史；系统管理员或本项目任意活跃成员（ADR-039）可读，其余成员与非成员统一 403/404。",
    request: {
      path: "ProjectMemberCollectionPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("ProjectMembersListResponse"), ...errors },
    ...readPolicies,
  },
  {
    method: "GET",
    path: "/projects/{projectId}/members/{userId}/unfinished-tasks",
    operationId: "listProjectMemberUnfinishedTasks",
    summary:
      "读取项目成员当前未完成任务，用于移除前提示改派或保留原负责人；系统管理员或本项目任意活跃成员（ADR-039）可读。",
    request: {
      path: "ProjectMemberPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": json("ProjectMemberUnfinishedTasksResponse"),
      ...errors,
    },
    ...readPolicies,
  },
  {
    method: "POST",
    path: "/projects/{projectId}/members",
    operationId: "addProjectMember",
    summary:
      "添加项目成员；系统管理员或本项目任意活跃成员（ADR-039）可写；已停用或不存在用户 422，重复活跃成员 409，重新加入新增历史记录并同事务发送通知与审计。",
    request: {
      path: "ProjectMemberCollectionPath",
      query: "none",
      headers: "ProjectMemberMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AddProjectMemberRequest",
          },
        ],
      },
    },
    responses: { "200": json("AddProjectMemberResponse"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-033/ADR-039：响应新增 role 且重放门禁加入项目成员复核，旧 Key 409。
    // 2026-09-22：role 枚举收窄（移除 PROJECT_ADMIN），重放安全字段变化，旧 Key 409。
    idempotencyContractVersion: "1.2.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: replayPolicy,
    replayAuthorizationPolicy: replayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "none",
    },
    concurrencyPolicy: {
      rowVersion: "none",
      lockOrder: ["project"],
      retry:
        "项目 FOR SHARE，成员历史 FOR UPDATE；活跃唯一索引冲突映射 409，不自动重试",
    },
    auditAction: "project.member.add",
  },
  {
    method: "POST",
    path: "/projects/{projectId}/members/{userId}/remove",
    operationId: "removeProjectMember",
    summary:
      "移除项目成员；系统管理员或本项目任意活跃成员（ADR-039）可写，但组长成员行不得被移除（ADR-053：需先把其他成员设为组长完成转移，再由新组长移除，项目至少要保留一名成员）；可同时提交真实任务改派，每项可指定一位或多位接手成员，未改派任务保留原负责人但成员立即失去访问权与角色，同事务写审计与活动。",
    request: {
      path: "ProjectMemberPath",
      query: "none",
      headers: "ProjectMemberMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "RemoveProjectMemberRequest",
          },
        ],
      },
    },
    responses: { "200": json("RemoveProjectMemberResponse"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-033/ADR-039：响应新增 role、LEADER 移除保护与重放角色复核，旧 Key 409。
    // 2026-09-22：role 枚举收窄（移除 PROJECT_ADMIN），重放安全字段变化，旧 Key 409。
    // 2026-09-24：请求体改派目标由 assigneeId 改为 assigneeIds，请求 Schema 与摘要变化，旧 Key 409。
    // ADR-053：组长移除保护与重放复核语义不变，仅文案澄清「先转移」；契约版本不升。
    idempotencyContractVersion: "1.3.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: removeReplayPolicy,
    replayAuthorizationPolicy: replayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "none",
    },
    concurrencyPolicy: {
      rowVersion: "none",
      lockOrder: ["project", "module", "task"],
      retry:
        "项目 FOR SHARE，任务按父级与 ID 锁序改派后成员 FOR UPDATE；任务版本冲突 409，不自动重试",
    },
    auditAction: "project.member.remove",
  },
  {
    method: "POST",
    path: "/projects/{projectId}/members/{userId}/role",
    operationId: "setProjectMemberRole",
    summary:
      "ADR-053 任命/转移组长：系统管理员可把任意活跃成员设为 MEMBER/LEADER（把其他成员设为 LEADER 即完成转移，原组长自动降级），本项目组长可把其他活跃成员设为组长以转交身份（不能自设、不能撤销）；不允许直接撤销组长（409 PROJECT_MEMBER_LEADER_REQUIRED，项目必须始终保留一名组长）；普通成员 403，目标必须为 ACTIVE 成员，LEADER 唯一性由部分唯一索引保证，冲突 409。",
    request: {
      path: "ProjectMemberPath",
      query: "none",
      headers: "ProjectMemberMutationHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "SetProjectMemberRoleRequest",
          },
        ],
      },
    },
    responses: { "200": json("SetProjectMemberRoleResponse"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-039：role 枚举收窄为 MEMBER/LEADER 且门禁改为仅系统管理员，旧 Key 409。
    // ADR-053：撤销组长（MEMBER）由允许改为 409 PROJECT_MEMBER_LEADER_REQUIRED，
    // 且项目组长本人由 403 放行为可转交组长身份，旧 Key 409。
    idempotencyContractVersion: "2.2.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "SetProjectMemberRoleResponse",
            safeBodyFieldPaths: [
              "member.membershipId",
              "member.projectId",
              "member.userId",
              "member.name",
              "member.avatarUrl",
              "member.status",
              "member.role",
              "member.joinedAt",
              "member.removedAt",
            ],
          },
        },
      },
    },
    replayAuthorizationPolicy: replayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "none",
    },
    concurrencyPolicy: {
      rowVersion: "none",
      lockOrder: ["project"],
      retry:
        "项目 FOR SHARE，成员行 FOR UPDATE；LEADER 唯一索引冲突映射 409，不自动重试",
    },
    auditAction: "project.member.role.set",
  },
];

import type { BodyBinding, RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";
const json = (schemaRef: SchemaName): BodyBinding => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 429, 500].map((n) => [
    String(n),
    json("ErrorResponse"),
  ]),
);
export const taskCreateRoutes: readonly RouteDefinition[] = [
  {
    method: "POST",
    path: "/projects/{projectId}/tasks",
    operationId: "createTaskWithScope",
    summary: "同事务创建任务与可选新模块，整笔幂等。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "ModuleMutationHeaders",
      body: {
        contentTypes: [
          { contentType: "application/json", schemaRef: "TaskCreateRequest" },
        ],
      },
    },
    responses: { "200": json("TaskCreateResult"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-109：移除功能创建与影响集合，破坏性契约变更。
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "TaskCreateResult",
            safeBodyFieldPaths: ["projectId", "moduleId", "taskId"],
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "TaskCreateResult",
        resultRefExtractor: "createdTaskScope",
        currentReadAuthorizer: "createdTaskScopeAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: {
      rowVersion: "none",
      lockOrder: ["project", "module"],
      retry: "none; same transaction",
    },
    auditAction: "task.create",
  },
  {
    method: "GET",
    path: "/projects/{projectId}/active-members",
    operationId: "listActiveProjectMembers",
    summary:
      "同项目当前成员基本资料与项目内角色（ADR-033）；只读，不暴露成员历史。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("ActiveProjectMembersResponse"), ...errors },
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
    path: "/tasks",
    operationId: "listTaskCenter",
    summary:
      "任务中心：个人、项目全员、管理员全部任务；服务端授权与逾期过滤先于分页。",
    request: {
      path: "none",
      query: "TaskCenterQuery",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("MyTaskPage"), ...errors },
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

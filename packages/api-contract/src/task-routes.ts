import type { BodyBinding, RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): BodyBinding => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 429, 500].map((status) => [
    String(status),
    json("ErrorResponse"),
  ]),
);
const collection = "/projects/{projectId}/modules/{moduleId}/tasks";
const fields = [
  "id",
  "projectId",
  "moduleId",
  "code",
  "title",
  "description",
  "assigneeId",
  "assigneeIds[]",
  "assigneeNames[]",
  "creatorId",
  "creatorName",
  "priority",
  "workStatus",
  "lifecycleStatus",
  "dueAt",
  "rowVersion",
  "createdAt",
  "updatedAt",
];
const deletionFields = [
  "id",
  "projectId",
  "moduleId",
  "code",
  "title",
  "workStatus",
  "deletedRecordCount",
  "removedLinkCount",
  "detachedGroupRole",
];
const base = {
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
} as const;

/** ADR-109：只保留模块直属任务的 8 条路由，不再存在功能内任务入口。 */
export const moduleTaskRoutes: readonly RouteDefinition[] = [
  {
    ...base,
    method: "GET",
    path: collection,
    operationId: "listModuleTasks",
    summary: "读取模块直属任务。",
    request: {
      path: "ModuleTaskCollectionPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("ModuleTaskListResponse"), ...errors },
  },
  {
    ...base,
    method: "GET",
    path: collection + "/assignees",
    operationId: "listModuleTaskAssignees",
    summary: "读取当前项目可指派成员。",
    request: {
      path: "ModuleTaskCollectionPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("TaskAssigneesResponse"), ...errors },
  },
  {
    ...base,
    method: "GET",
    path: collection + "/{taskId}",
    operationId: "getModuleTask",
    summary: "读取模块直属任务。",
    request: {
      path: "ModuleTaskResourcePath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("ModuleTaskItem"), ...errors },
  },
  ...(["createModuleTask", "updateModuleTask"] as const).map(
    (operationId): RouteDefinition => {
      const create = operationId === "createModuleTask";
      return {
        ...base,
        method: create ? "POST" : "PATCH",
        path: collection + (create ? "" : "/{taskId}"),
        operationId,
        summary:
          "模块任务创建或编辑；创建/改派只接受项目活跃成员，保留未变的历史负责人。",
        request: {
          path: create ? "ModuleTaskCollectionPath" : "ModuleTaskResourcePath",
          query: "none",
          headers: create ? "TaskMutationHeaders" : "TaskVersionHeaders",
          body: {
            contentTypes: [
              { contentType: "application/json", schemaRef: "TaskEditRequest" },
            ],
          },
        },
        responses: { "200": json("ModuleTaskItem"), ...errors },
        csrfPolicy: "required",
        idempotencyPolicy: "idempotencyRequired",
        // ADR-109：功能字段移除，破坏性契约变更。
        idempotencyContractVersion: "5.0.0",
        idempotencyFingerprintVersion: "1.0.0",
        behaviorHeaders: create ? [] : ["If-Match"],
        idempotencyReplayPolicy: {
          version: "1.0.0",
          success: {
            "200": {
              body: {
                responseSchemaRef: "ModuleTaskItem",
                safeBodyFieldPaths: fields,
              },
            },
          },
        },
        replayAuthorizationPolicy: {
          version: "1.0.0",
          resources: {
            contextSchemaRef: "ModuleTaskReplayContext",
            resultRefExtractor: "moduleTaskResultResource",
            currentReadAuthorizer: "moduleTaskCurrentReadAuthorizer",
          },
        },
        versionPolicy: {
          apiVersion: "v1",
          schemaVersion: "1.0.0",
          ifMatch: create ? "none" : "required",
        },
        concurrencyPolicy: {
          rowVersion: create ? "none" : "required",
          lockOrder: create
            ? ["project", "module"]
            : ["project", "module", "task"],
          retry:
            "none; parents FOR SHARE, task FOR UPDATE, then assignee user/membership FOR SHARE",
        },
        auditAction: create ? "task.create" : "task.update",
      };
    },
  ),
  {
    ...base,
    method: "POST",
    path: collection + "/{taskId}/status",
    operationId: "transitionModuleTask",
    summary: "任务状态流转与不可变历史。",
    request: {
      path: "ModuleTaskResourcePath",
      query: "none",
      headers: "TaskVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "TaskStatusRequest",
          },
        ],
      },
    },
    responses: { "200": json("ModuleTaskItem"), ...errors },
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    // ADR-109：移除功能字段，响应结构变化。
    idempotencyContractVersion: "6.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: {
      version: "3.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "ModuleTaskItem",
            safeBodyFieldPaths: fields,
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "2.0.0",
      resources: {
        contextSchemaRef: "TaskStatusCompatibilityReplayContext",
        resultRefExtractor: "taskStatusCompatibilityResources",
        currentReadAuthorizer: "taskStatusCompatibilityCurrentReadAuthorizer",
      },
    },
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project", "module", "task"],
      retry:
        "COMPLETE uses TaskCompletionWorkflow with branch recheck and bounded retry; other transitions retain existing state semantics",
    },
    auditAction: "task.status",
  },
  {
    ...base,
    method: "GET",
    path: collection + "/{taskId}/status-history",
    operationId: "getModuleTaskStatusHistory",
    summary: "读取模块直属任务状态历史。",
    request: {
      path: "ModuleTaskResourcePath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("TaskStatusHistoryResponse"), ...errors },
  },
  {
    ...base,
    method: "POST",
    path: collection + "/{taskId}/delete",
    operationId: "deleteModuleTask",
    summary:
      "删除任务：同一事务物理删除任务、全部迭代记录与下级数据，只保留审计、项目动态与删除事件（ADR-096/ADR-109）。",
    request: {
      path: "ModuleTaskResourcePath",
      query: "none",
      headers: "TaskVersionHeaders",
      body: {
        contentTypes: [
          { contentType: "application/json", schemaRef: "DeleteTaskRequest" },
        ],
      },
    },
    responses: { "200": json("TaskDeletionResponse"), ...errors },
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    // ADR-109：删除结果不再回述功能归属。
    idempotencyContractVersion: "3.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: {
      version: "3.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "TaskDeletionResponse",
            safeBodyFieldPaths: deletionFields,
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "TaskDeletionReplayContext",
        resultRefExtractor: "taskDeletionResources",
        currentReadAuthorizer: "taskDeletionCurrentReadAuthorizer",
      },
    },
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project", "module", "task", "taskGroup"],
      retry:
        "parents FOR SHARE then task FOR UPDATE; hard-delete function closes touched task groups in the same transaction",
    },
    auditAction: "task.delete",
  },
];

/** 兼容既有内部命名；注册表只引用 moduleTaskRoutes，避免重复注册。 */
export const taskRoutes = moduleTaskRoutes;

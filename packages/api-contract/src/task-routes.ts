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
const collection =
  "/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks";
const fields = [
  "id",
  "projectId",
  "moduleId",
  "featureId",
  "scopeType",
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
const basicTaskRoutes: readonly RouteDefinition[] = [
  ...(["listTasks", "getTask", "listTaskAssignees"] as const).map(
    (operationId): RouteDefinition => ({
      method: "GET",
      path: `${collection}${operationId === "getTask" ? "/{taskId}" : operationId === "listTaskAssignees" ? "/assignees" : ""}`,
      operationId,
      summary: "读取真实功能归属下的任务或当前项目可指派成员。",
      request: {
        path:
          operationId === "getTask" ? "TaskResourcePath" : "TaskCollectionPath",
        query: "none",
        headers: "none",
        body: { noBody: true },
      },
      responses: {
        "200": json(
          operationId === "getTask"
            ? "TaskItem"
            : operationId === "listTaskAssignees"
              ? "TaskAssigneesResponse"
              : "TaskListResponse",
        ),
        ...errors,
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
    }),
  ),
  ...(["createTask", "updateTask"] as const).map(
    (operationId): RouteDefinition => {
      const create = operationId === "createTask";
      return {
        method: create ? "POST" : "PATCH",
        path: `${collection}${create ? "" : "/{taskId}"}`,
        operationId,
        summary:
          "功能任务创建或编辑；创建/改派只接受项目活跃成员，保留未变的历史负责人。",
        request: {
          path: create ? "TaskCollectionPath" : "TaskResourcePath",
          query: "none",
          headers: create ? "TaskMutationHeaders" : "TaskVersionHeaders",
          body: {
            contentTypes: [
              { contentType: "application/json", schemaRef: "TaskEditRequest" },
            ],
          },
        },
        responses: { "200": json("TaskItem"), ...errors },
        authPolicy: "session",
        csrfPolicy: "required",
        idempotencyPolicy: "idempotencyRequired",
        idempotencyExceptionAdr: "none",
        // ADR-040：请求体 assigneeId 改为 assigneeIds，响应新增 assigneeIds，属破坏性契约变更，主版本递增。
        // ADR-054：响应 lifecycleStatus 去掉不可达的 ARCHIVED，再次递增主版本。
        // ADR-082：响应新增墓碑账号展示名，重放字段变化再次递增主版本。
        idempotencyContractVersion: "4.0.0",
        idempotencyFingerprintVersion: "1.0.0",
        behaviorHeaders: create ? [] : ["If-Match"],
        idempotencyReplayPolicy: {
          version: "1.0.0",
          success: {
            "200": {
              body: {
                responseSchemaRef: "TaskItem",
                safeBodyFieldPaths: fields,
              },
            },
          },
        },
        replayAuthorizationPolicy: {
          version: "1.0.0",
          resources: {
            contextSchemaRef: "TaskReplayContext",
            resultRefExtractor: "taskResultResource",
            currentReadAuthorizer: "taskCurrentReadAuthorizer",
          },
        },
        securityFlowPolicy: "none",
        versionPolicy: {
          apiVersion: "v1",
          schemaVersion: "1.0.0",
          ifMatch: create ? "none" : "required",
        },
        concurrencyPolicy: {
          rowVersion: create ? "none" : "required",
          lockOrder: create
            ? ["project", "module", "feature"]
            : ["project", "module", "feature", "task"],
          retry:
            "none; parents FOR SHARE, task FOR UPDATE, then assignee user/membership FOR SHARE",
        },
        auditAction: create ? "task.create" : "task.update",
      };
    },
  ),
];

const deletionFields = [
  "id",
  "projectId",
  "moduleId",
  "featureId",
  "code",
  "title",
  "workStatus",
  "deletedRecordCount",
  "removedLinkCount",
  "detachedGroupRole",
];
export const taskRoutes: readonly RouteDefinition[] = [
  ...basicTaskRoutes,
  {
    ...basicTaskRoutes[1]!,
    operationId: "getTaskStatusHistory",
    path: collection + "/{taskId}/status-history",
    summary: "读取真实归属任务的不可变状态历史，包含历次完成与重开快照。",
    responses: { "200": json("TaskStatusHistoryResponse"), ...errors },
  },
  {
    ...basicTaskRoutes[4]!,
    method: "POST",
    operationId: "transitionTask",
    // ADR-040：响应 TaskItem 新增 assigneeIds，属破坏性契约变更，主版本递增。
    // ADR-054：响应 lifecycleStatus 去掉不可达的 ARCHIVED，再次递增主版本。
    // ADR-082：响应新增墓碑账号展示名，重放字段变化再次递增主版本。
    idempotencyContractVersion: "5.0.0",
    replayAuthorizationPolicy: {
      version: "2.0.0",
      resources: {
        contextSchemaRef: "TaskStatusCompatibilityReplayContext",
        resultRefExtractor: "taskStatusCompatibilityResources",
        currentReadAuthorizer: "taskStatusCompatibilityCurrentReadAuthorizer",
      },
    },
    path: collection + "/{taskId}/status",
    summary: "完成（仅 WITHOUT_RECORD）、重开、取消或恢复任务；原子保留历史。",
    request: {
      ...basicTaskRoutes[4]!.request,
      body: {
        contentTypes: [
          { contentType: "application/json", schemaRef: "TaskStatusRequest" },
        ],
      },
    },
    auditAction: "task.status",
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project", "module", "feature", "task", "taskGroup"],
      retry:
        "COMPLETE uses TaskCompletionWorkflow with branch recheck and bounded retry; other transitions retain existing state semantics",
    },
  },
  {
    ...basicTaskRoutes[4]!,
    method: "POST",
    operationId: "deleteTask",
    // ADR-096：删除任务改为物理删除，只保留审计、项目动态与删除事件。
    idempotencyContractVersion: "2.0.0",
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "TaskDeletionReplayContext",
        resultRefExtractor: "taskDeletionResources",
        currentReadAuthorizer: "taskDeletionCurrentReadAuthorizer",
      },
    },
    path: collection + "/{taskId}/delete",
    summary:
      "删除任务：同一事务物理删除任务、全部迭代记录与下级数据，只保留审计、项目动态与删除事件（ADR-096）。",
    request: {
      ...basicTaskRoutes[4]!.request,
      body: {
        contentTypes: [
          { contentType: "application/json", schemaRef: "DeleteTaskRequest" },
        ],
      },
    },
    responses: { "200": json("TaskDeletionResponse"), ...errors },
    idempotencyReplayPolicy: {
      version: "2.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "TaskDeletionResponse",
            safeBodyFieldPaths: deletionFields,
          },
        },
      },
    },
    auditAction: "task.delete",
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project", "module", "feature", "task", "taskGroup"],
      retry:
        "parents FOR SHARE then task FOR UPDATE; hard-delete function closes touched task groups in the same transaction",
    },
  },
];

/** Same task commands and security policies, addressed through the true MODULE parent. */
export const moduleTaskRoutes: readonly RouteDefinition[] = taskRoutes.map(
  (route) => {
    const write = route.method !== "GET";
    const create = route.operationId === "createTask";
    return {
      ...route,
      operationId: route.operationId.replace("Task", "ModuleTask"),
      path: route.path.replace("/features/{featureId}", ""),
      summary:
        route.operationId === "transitionTask" ||
        route.operationId === "getTaskStatusHistory"
          ? "模块真实归属下的任务状态和历史。"
          : route.operationId === "deleteTask"
            ? "删除模块级任务：同一事务物理删除任务、全部迭代记录、版本、遗留项与链接关联，并关闭相关聚合组。"
            : "模块级任务或成员读取；影响关系为同模块当前集合，增删与完整审计快照原子提交。",
      request: {
        ...route.request,
        path:
          route.request.path === "TaskResourcePath"
            ? "ModuleTaskResourcePath"
            : "ModuleTaskCollectionPath",
        body:
          write &&
          route.operationId !== "transitionTask" &&
          route.operationId !== "deleteTask"
            ? {
                contentTypes: [
                  {
                    contentType: "application/json",
                    schemaRef: "ModuleTaskEditRequest",
                  },
                ],
              }
            : route.request.body,
      },
      responses: {
        ...route.responses,
        "200": json(
          route.operationId === "getTaskStatusHistory"
            ? "TaskStatusHistoryResponse"
            : route.operationId === "deleteTask"
              ? "TaskDeletionResponse"
              : route.operationId === "listTaskAssignees"
                ? "TaskAssigneesResponse"
                : route.operationId === "listTasks"
                  ? "ModuleTaskListResponse"
                  : "ModuleTaskItem",
        ),
      },
      idempotencyReplayPolicy:
        route.operationId === "deleteTask"
          ? {
              version: "1.0.0",
              success: {
                "200": {
                  body: {
                    responseSchemaRef: "TaskDeletionResponse",
                    safeBodyFieldPaths: deletionFields,
                  },
                },
              },
            }
          : write
            ? {
                version: "1.0.0",
                success: {
                  "200": {
                    body: {
                      responseSchemaRef: "ModuleTaskItem",
                      safeBodyFieldPaths: [...fields, "impactFeatureIds[]"],
                    },
                  },
                },
              }
            : "none",
      replayAuthorizationPolicy:
        route.operationId === "transitionTask" ||
        route.operationId === "deleteTask"
          ? route.replayAuthorizationPolicy
          : write
            ? {
                version: "1.0.0",
                resources: {
                  contextSchemaRef: "ModuleTaskReplayContext",
                  resultRefExtractor: "moduleTaskResultResource",
                  currentReadAuthorizer: "moduleTaskCurrentReadAuthorizer",
                },
              }
            : "none",
      concurrencyPolicy:
        route.operationId === "transitionTask" ||
        route.operationId === "deleteTask"
          ? route.concurrencyPolicy
          : write
            ? {
                rowVersion: create ? "none" : "required",
                lockOrder: create
                  ? ["project", "module", "feature"]
                  : ["project", "module", "feature", "task"],
                retry:
                  "up to 3 savepoint attempts; sorted union of current/target feature ids before task; re-read under task lock",
              }
            : "none",
    };
  },
);

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
const fields = [
  "id",
  "projectId",
  "moduleId",
  "taskId",
  "handlerId",
  "authorId",
  "moduleName",
  "authorName",
  "handlerName",
  "status",
  "code",
  "currentVersion",
  "publishedAt",
  "rowVersion",
  "createdAt",
  "updatedAt",
  "title",
  "contextProblem",
  "changeSolution",
  "resultVerification",
  "remainingIssues[].id",
  "remainingIssues[].content",
];
export const recordDraftRoutes: readonly RouteDefinition[] = (
  [
    "listRecordDrafts",
    "getRecordDraft",
    "createIndependentRecordDraft",
    "updateIndependentRecordDraft",
  ] as const
).map((operationId) => {
  const create = operationId === "createIndependentRecordDraft";
  const write = create || operationId === "updateIndependentRecordDraft";
  const list = operationId === "listRecordDrafts";
  return {
    operationId,
    method: create ? "POST" : write ? "PATCH" : "GET",
    path: create
      ? "/projects/{projectId}/modules/{moduleId}/record-drafts"
      : `/projects/{projectId}/record-drafts${list ? "" : "/{recordId}"}`,
    summary: "独立迭代记录草稿；三段必填、不编号、不发布、不改变任务状态。",
    request: {
      path: create
        ? "RecordDraftCreatePath"
        : list
          ? "RecordDraftProjectPath"
          : "RecordDraftResourcePath",
      query: list ? "RecordDraftListQuery" : "none",
      headers: write
        ? create
          ? "RecordDraftHeaders"
          : "RecordDraftVersionHeaders"
        : "none",
      body: write
        ? {
            contentTypes: [
              {
                contentType: "application/json",
                schemaRef: create
                  ? "IndependentRecordDraftRequest"
                  : "RecordDraftContent",
              },
            ],
          }
        : { noBody: true },
    },
    responses: {
      "200": json(list ? "RecordDraftPage" : "RecordDraftItem"),
      ...errors,
    },
    authPolicy: "session",
    csrfPolicy: write ? "required" : "none",
    idempotencyPolicy: write ? "idempotencyRequired" : "none",
    idempotencyExceptionAdr: "none",
    // 1.2.0：遗留问题由单段文本改为条目数组。
    idempotencyContractVersion: write ? "2.0.0" : "none",
    idempotencyFingerprintVersion: write ? "2.0.0" : "none",
    behaviorHeaders: write ? (create ? [] : ["If-Match"]) : "none",
    idempotencyReplayPolicy: write
      ? {
          version: "1.0.0",
          success: {
            "200": {
              body: {
                responseSchemaRef: "RecordDraftItem",
                safeBodyFieldPaths: fields,
              },
            },
          },
        }
      : "none",
    replayAuthorizationPolicy: write
      ? {
          version: "1.0.0",
          resources: {
            contextSchemaRef: "RecordDraftReplayContext",
            resultRefExtractor: "recordDraftResultResource",
            currentReadAuthorizer: "recordDraftCurrentReadAuthorizer",
          },
        }
      : "none",
    securityFlowPolicy: "none",
    versionPolicy: write
      ? {
          apiVersion: "v1",
          schemaVersion: "1.0.0",
          ifMatch: create ? "none" : "required",
        }
      : "none",
    concurrencyPolicy: write
      ? {
          rowVersion: create ? "none" : "required",
          lockOrder: create
            ? ["project", "module"]
            : ["project", "module", "changeRecord"],
          retry:
            "none; sorted parent FOR SHARE then draft FOR UPDATE; recheck scope/version",
        }
      : "none",
    auditAction: write
      ? create
        ? "record.draft.create"
        : "record.draft.update"
      : "none",
  };
});

/**
 * 删除草稿：只允许 DRAFT；未发布过的草稿不属于业务历史，可连同子行物理删除。
 * 独立草稿与来源草稿共用这条路径——删除不派生来源内容，不需要走来源流程，
 * 来源任务本身与已发布历史都不受影响。
 */
export const recordDraftDeleteRoutes: readonly RouteDefinition[] = (
  ["deleteRecordDraft"] as const
).map((operationId): RouteDefinition => {
  const base = recordDraftRoutes[3]!;
  return {
    ...base,
    operationId,
    method: "DELETE",
    summary: "删除未发布的草稿；已发布记录、来源任务与审计历史都不受影响。",
    request: {
      path: "RecordDraftResourcePath",
      query: "none",
      headers: "RecordDraftVersionHeaders",
      body: { noBody: true },
    },
    responses: {
      "200": json("RecordDraftDeleteResult"),
      ...errors,
    },
    auditAction: "record.draft.delete",
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    idempotencyReplayPolicy: {
      version: "2.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "RecordDraftDeleteResult",
            safeBodyFieldPaths: ["projectId", "recordId", "moduleId", "taskId"],
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "RecordDraftDeleteResult",
        resultRefExtractor: "recordDraftResultResource",
        currentReadAuthorizer: "recordDraftCurrentReadAuthorizer",
      },
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project", "module", "changeRecord"],
      retry: "none; parents FOR SHARE then draft FOR UPDATE, recheck version",
    },
  };
});

export const taskRecordDraftRoutes: readonly RouteDefinition[] = (
  [
    "getTaskRecordDrafts",
    "createTaskRecordDraft",
    "updateTaskRecordDraft",
  ] as const
).map((operationId): RouteDefinition => {
  const read = operationId === "getTaskRecordDrafts";
  const update = operationId === "updateTaskRecordDraft";
  const base = recordDraftRoutes[read ? 0 : update ? 3 : 2]!;
  return {
    ...base,
    operationId,
    path:
      "/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/record-drafts" +
      (update ? "/{recordId}" : ""),
    summary:
      "任务来源草稿；多条独立记录，保存不改变任务状态；由Workflow绑定真实来源。",
    request: {
      ...base.request,
      query: "none",
      path: update ? "TaskRecordDraftResourcePath" : "TaskRecordDraftPath",
      headers: read ? "none" : "RecordDraftVersionHeaders",
      body: read
        ? { noBody: true }
        : {
            contentTypes: [
              {
                contentType: "application/json",
                schemaRef: update
                  ? "RecordDraftContent"
                  : "TaskRecordDraftRequest",
              },
            ],
          },
    },
    responses: {
      ...base.responses,
      "200": json(read ? "TaskRecordDraftsResponse" : "RecordDraftItem"),
    },
    behaviorHeaders: read ? "none" : ["If-Match"],
    versionPolicy: read
      ? "none"
      : { apiVersion: "v1", schemaVersion: "1.0.0", ifMatch: "required" },
    concurrencyPolicy: read
      ? "none"
      : {
          rowVersion: "required",
          lockOrder: ["project", "module", "task", "changeRecord"],
          retry:
            "up to 3 savepoint attempts; sorted task and record locks, then task reread, then record; create If-Match targets task, edit targets record",
        },
  };
});

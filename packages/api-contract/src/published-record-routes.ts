import { recordDraftRoutes } from "./record-draft-routes.js";
import type { RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";
const json = (schemaRef: SchemaName) => ({
  body: {
    contentTypes: [{ contentType: "application/json" as const, schemaRef }],
  },
});
export const publishedRecordRoutes: readonly RouteDefinition[] = (
  [
    "listChangeRecords",
    "getChangeRecord",
    "listChangeRecordVersions",
    "getChangeRecordVersion",
  ] as const
).map((operationId) => {
  const list = operationId === "listChangeRecords",
    version = operationId === "getChangeRecordVersion",
    versions = operationId === "listChangeRecordVersions" || version;
  return {
    operationId,
    method: "GET",
    path: `/projects/{projectId}/change-records${list ? "" : "/{recordId}"}${versions ? "/versions" : ""}${version ? "/{versionNo}" : ""}`,
    summary: "当前有权项目内的正式记录与不可变版本",
    request: {
      path: list
        ? "RecordDraftProjectPath"
        : version
          ? "ChangeRecordVersionPath"
          : "RecordDraftResourcePath",
      query: list ? "RecordListQuery" : "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": json(
        list
          ? "ReadableRecordPage"
          : version
            ? "ChangeRecordVersion"
            : versions
              ? "ChangeRecordVersionList"
              : "ReadableRecord",
      ),
      "401": json("ErrorResponse"),
      "404": json("ErrorResponse"),
      "422": json("ErrorResponse"),
      "500": json("ErrorResponse"),
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
  };
});

const fields = [
  "id",
  "projectId",
  "moduleId",
  "taskId",
  "handlerId",
  "authorId",
  "authorName",
  "handlerName",
  "moduleName",
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
  "leftovers[].id",
  "leftovers[].content",
  "leftovers[].status",
  "leftovers[].rowVersion",
  "leftovers[].linkedTaskId",
];
export const recordPublicationRoutes: readonly RouteDefinition[] = (
  ["publishChangeRecord", "createChangeRecordVersion"] as const
).map((operationId) => {
  const publish = operationId === "publishChangeRecord";
  return {
    ...recordDraftRoutes[3]!,
    operationId,
    method: "POST",
    path:
      "/projects/{projectId}/change-records/{recordId}/" +
      (publish ? "publish" : "versions"),
    summary: publish
      ? "发布已保存草稿，来源为空或当前DONE"
      : "保存不可变新版本，保留身份和历史",
    request: {
      path: "RecordDraftResourcePath",
      query: "none",
      headers: publish
        ? "RecordDraftVersionHeaders"
        : "PublishedRecordVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: publish
              ? "PublishRecordRequest"
              : "PublishedRecordContent",
          },
        ],
      },
    },
    responses: {
      "200": json("PublishedRecord"),
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 422, 429, 500].map((status) => [
          String(status),
          json("ErrorResponse"),
        ]),
      ),
    },
    behaviorHeaders: publish ? ["If-Match"] : ["If-Match", "X-Record-Version"],
    // 1.2.0：遗留问题由单段文本改为条目数组，响应移除标量 leftoverItem。
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "2.0.0",
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "PublishedRecord",
            safeBodyFieldPaths: fields,
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "RecordPublicationReplayContext",
        resultRefExtractor: "recordPublicationResources",
        currentReadAuthorizer: "recordPublicationCurrentReadAuthorizer",
      },
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: publish
        ? ["project", "module", "task", "changeRecord", "leftoverItem"]
        : ["project", "module", "changeRecord", "leftoverItem"],
      retry:
        "source pre-read changes release savepoint locks and retry at most 3 times",
    },
    auditAction: publish ? "record.publish" : "record.version.create",
  };
});

const versionRoute = recordPublicationRoutes[1]!;
/**
 * F-18 详情页快捷追加：只追加一条遗留问题，其余条目按当前版本原样沿用；
 * 服务端仍写一次记录版本，因此审计、活动、通知与搜索投影与修订完全一致。
 */
export const recordLeftoverRoutes: readonly RouteDefinition[] = [
  {
    ...versionRoute,
    operationId: "addChangeRecordLeftover",
    path: "/projects/{projectId}/change-records/{recordId}/leftovers",
    summary: "在已有正式记录上追加一条遗留问题，仍形成一次记录版本",
    request: {
      ...versionRoute.request,
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "AddRecordLeftoverRequest",
          },
        ],
      },
    },
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "2.0.0",
    auditAction: "record.leftover.add",
  },
];

export const recordLifecycleRoutes: readonly RouteDefinition[] = (
  ["voidChangeRecord", "restoreChangeRecord"] as const
).map((operationId) => ({
  ...recordDraftRoutes[3]!,
  operationId,
  method: "POST",
  path:
    "/projects/{projectId}/change-records/{recordId}/" +
    (operationId === "voidChangeRecord" ? "void" : "restore"),
  summary: "ADR-024 管理员作废/恢复；只改记录状态及同事务审计/投影",
  authPolicy: "adminSession",
  // 该路由的请求/响应/重放策略未随记录内容变化，保持既有契约与 fingerprint 版本。
  idempotencyContractVersion: "1.1.0",
  idempotencyFingerprintVersion: "1.1.0",
  request: {
    path: "RecordDraftResourcePath",
    query: "none",
    headers: "RecordDraftVersionHeaders",
    body: {
      contentTypes: [
        {
          contentType: "application/json",
          schemaRef: "RecordLifecycleRequest",
        },
      ],
    },
  },
  responses: {
    "200": json("RecordLifecycleResult"),
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 422, 429, 500].map((status) => [
        String(status),
        json("ErrorResponse"),
      ]),
    ),
  },
  behaviorHeaders: ["If-Match"],
  idempotencyReplayPolicy: {
    version: "1.0.0",
    success: {
      "200": {
        body: {
          responseSchemaRef: "RecordLifecycleResult",
          safeBodyFieldPaths: ["id", "projectId", "status", "rowVersion"],
        },
      },
    },
  },
  replayAuthorizationPolicy: {
    version: "1.0.0",
    resources: {
      contextSchemaRef: "RecordLifecycleReplayContext",
      resultRefExtractor: "recordLifecycleResources",
      currentReadAuthorizer: "recordLifecycleCurrentReadAuthorizer",
    },
  },
  concurrencyPolicy: {
    rowVersion: "required",
    lockOrder: ["project", "module", "changeRecord"],
    retry:
      "none; lock ownership parents then conditional status and row_version update",
  },
  auditAction:
    operationId === "voidChangeRecord"
      ? "CHANGE_RECORD_VOIDED"
      : "CHANGE_RECORD_RESTORED",
}));

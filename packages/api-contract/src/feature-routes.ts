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
const fields = [
  "id",
  "projectId",
  "name",
  "currentBehavior",
  "acceptanceCriteria",
  "moduleId",
  "code",
  "createdBy",
  "createdByName",
  "tags[]",
  "rowVersion",
  "createdAt",
  "updatedAt",
  "stats.openTaskCount",
  "stats.completedTaskCount",
  "stats.recordCount",
];
/** ADR-096：删除功能重放可安全回述的影响面计数。 */
const featureDeletionFields = [
  "id",
  "projectId",
  "moduleId",
  "code",
  "name",
  "deletedTaskCount",
  "deletedRecordCount",
  "removedLinkCount",
];
export const featureRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/projects/{projectId}/modules/{moduleId}/features",
    operationId: "listFeatures",
    summary:
      "读取可访问项目的全部功能；先按派生档位（进行中、未开始）排序，同档位内按创建时间从近到远、创建时间相同时按功能 ID 降序（ADR-045：功能已无归档态，档位只剩两档）。",
    request: {
      path: "FeatureCollectionPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("FeatureListResponse"), ...errors },
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
    path: "/projects/{projectId}/modules/{moduleId}/features/similar",
    operationId: "findSimilarFeatures",
    summary: "当前项目最多十个关键词候选，不自动阻止创建或合并。",
    request: {
      path: "FeatureCollectionPath",
      query: "FeatureSimilarQuery",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("FeatureListResponse"), ...errors },
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
    path: "/projects/{projectId}/modules/{moduleId}/features/{featureId}",
    operationId: "getFeature",
    summary: "按完整项目和模块归属读取功能详情。",
    request: {
      path: "FeatureResourcePath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: { "200": json("FeatureItem"), ...errors },
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
  ...(["createFeature", "updateFeature"] as const).map(
    (operationId): RouteDefinition => {
      const create = operationId === "createFeature";
      const action = create ? "create" : "update";
      return {
        method: create ? "POST" : "PATCH",
        path: `/projects/{projectId}/modules/{moduleId}/features${create ? "" : "/{featureId}"}`,
        operationId,
        summary: `${action} 功能；项目可写，项目/模块/编号/创建者不可变；ADR-045 起功能不再有归档态。`,
        request: {
          path: create ? "FeatureCollectionPath" : "FeatureResourcePath",
          query: "none",
          headers: create ? "FeatureMutationHeaders" : "FeatureVersionHeaders",
          body: {
            contentTypes: [
              {
                contentType: "application/json",
                schemaRef: "FeatureEditRequest",
              },
            ],
          },
        },
        responses: { "200": json("FeatureItem"), ...errors },
        authPolicy: "session",
        csrfPolicy: "required",
        idempotencyPolicy: "idempotencyRequired",
        idempotencyExceptionAdr: "none",
        // ADR-045：功能下线归档后 FeatureItem 去掉 status / archivedAt，两条归档路由一并移除，
        // 统计新增 stats.completedTaskCount，重放安全字段集合随响应 Schema 变化，
        // 旧 Key 在新契约下 409。
        idempotencyContractVersion: "1.4.0",
        idempotencyFingerprintVersion: "1.0.0",
        behaviorHeaders: create ? [] : ["If-Match"],
        idempotencyReplayPolicy: {
          version: "1.0.0",
          success: {
            "200": {
              body: {
                responseSchemaRef: "FeatureItem",
                safeBodyFieldPaths: fields,
              },
            },
          },
        },
        replayAuthorizationPolicy: {
          version: "1.0.0",
          resources: {
            contextSchemaRef: "FeatureReplayContext",
            resultRefExtractor: "featureResultResource",
            currentReadAuthorizer: "featureCurrentReadAuthorizer",
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
            ? ["project", "module"]
            : ["project", "module", "feature"],
          retry:
            "none; parent FOR SHARE, feature FOR UPDATE, expected row_version",
        },
        auditAction: `feature.${action}`,
      };
    },
  ),
  {
    // ADR-096：删除功能改为物理删除，级联删除其下任务、记录与全部下级数据。
    method: "POST",
    path: "/projects/{projectId}/modules/{moduleId}/features/{featureId}/delete",
    operationId: "deleteFeature",
    summary:
      "删除功能：同一事务物理删除功能、其下任务、全部迭代记录及下级数据，只保留审计、项目动态与删除事件（ADR-096）。",
    request: {
      path: "FeatureResourcePath",
      query: "none",
      headers: "FeatureVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "DeleteFeatureRequest",
          },
        ],
      },
    },
    responses: { "200": json("FeatureDeletionResponse"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: {
      version: "2.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "FeatureDeletionResponse",
            safeBodyFieldPaths: featureDeletionFields,
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "FeatureDeletionReplayContext",
        resultRefExtractor: "featureDeletionResources",
        currentReadAuthorizer: "featureDeleteReplayAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project", "module", "feature", "task", "taskGroup"],
      retry:
        "parents FOR SHARE, feature FOR UPDATE; hard-delete function locks features, tasks, task groups and records in ascending id order",
    },
    auditAction: "feature.delete",
  },
];

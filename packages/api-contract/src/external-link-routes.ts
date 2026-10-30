import { recordDraftRoutes } from "./record-draft-routes.js";
import { publishedRecordRoutes } from "./published-record-routes.js";
import type { RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";
const json = (schemaRef: SchemaName) => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});
export const externalLinkRoutes: readonly RouteDefinition[] = [
  "listExternalLinks",
  "addExternalLink",
  "removeExternalLink",
].map((operationId) => {
  const write = operationId !== "listExternalLinks",
    remove = operationId === "removeExternalLink";
  return {
    ...(write ? recordDraftRoutes[3]! : publishedRecordRoutes[1]!),
    operationId,
    // 新增路由接受裸 commit SHA，同一请求由必然 422 变为可成功写库，故升级契约版本让旧 Key 在新契约下 409。
    idempotencyContractVersion: write ? (remove ? "2.0.0" : "2.1.0") : "none",
    // 该路由的请求/响应/重放策略与记录内容无关，保持既有 fingerprint 版本。
    idempotencyFingerprintVersion: write ? "1.1.0" : "none",
    method: write ? (remove ? "DELETE" : "POST") : "GET",
    path:
      "/external-links/{targetType}/{targetId}" + (remove ? "/{linkId}" : ""),
    summary: write
      ? remove
        ? "管理目标的当前GitHub关联并保留实体和审计"
        : "新增目标的GitHub关联（接受完整链接或项目根仓库下的commit SHA）并保留实体和审计"
      : "读取当前有权目标的GitHub关联；项目目标聚合其有效任务与已发布记录上的关联并标注来源（取消或无效任务不聚合）",
    request: {
      path: remove ? "ExternalLinkResourcePath" : "ExternalLinkTargetPath",
      query: "none",
      headers: write ? "RecordDraftVersionHeaders" : "none",
      body:
        write && !remove
          ? {
              contentTypes: [
                {
                  contentType: "application/json",
                  schemaRef: "ExternalLinkRequest",
                },
              ],
            }
          : { noBody: true },
    },
    responses: {
      "200": json(write ? "ExternalLinkResult" : "ExternalLinkList"),
      "400": json("ErrorResponse"),
      "401": json("ErrorResponse"),
      "403": json("ErrorResponse"),
      "404": json("ErrorResponse"),
      "409": json("ErrorResponse"),
      "422": json("ErrorResponse"),
      "429": json("ErrorResponse"),
      "500": json("ErrorResponse"),
    },
    auditAction: write
      ? remove
        ? "EXTERNAL_LINK_REMOVED"
        : "EXTERNAL_LINK_ADDED"
      : "none",
    behaviorHeaders: write ? ["If-Match"] : "none",
    idempotencyReplayPolicy: write
      ? {
          version: "1.0.0",
          success: {
            "200": {
              body: {
                responseSchemaRef: "ExternalLinkResult",
                safeBodyFieldPaths: [
                  "projectId",
                  "targetType",
                  "targetId",
                  "linkId",
                  "rowVersion",
                ],
              },
            },
          },
        }
      : "none",
    replayAuthorizationPolicy: write
      ? {
          version: "1.0.0",
          resources: {
            contextSchemaRef: "ExternalLinkReplayContext",
            resultRefExtractor: "externalLinkTarget",
            currentReadAuthorizer: "externalLinkCurrentRead",
          },
        }
      : "none",
    concurrencyPolicy: write
      ? {
          rowVersion: "required",
          lockOrder: ["project", "module", "task", "changeRecord"],
          retry:
            "Re-read true ownership after ordered target lock; reject changed version",
        }
      : "none",
  };
});

import { recordPublicationRoutes } from "./published-record-routes.js";
import type { RouteDefinition } from "./route-definition.js";
const publication = recordPublicationRoutes[0]!;
const policy = publication.idempotencyReplayPolicy;
if (
  policy === "none" ||
  !policy.success["200"] ||
  !("body" in policy.success["200"])
)
  throw new Error("Publication response policy required");
const taskFields = [
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
  "impactFeatureIds[]",
];
export const taskCompletionRoutes: readonly RouteDefinition[] = [
  {
    ...publication,
    operationId: "completeTask",
    path: "/tasks/{taskId}/complete",
    summary: "无变化完成或同事务绑定并发布一条记录",
    request: {
      path: "TaskCompletionPath",
      headers: "RecordDraftVersionHeaders",
      query: "none",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "TaskCompletionRequest",
          },
        ],
      },
    },
    responses: {
      ...publication.responses,
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "TaskCompletionResponse",
            },
          ],
        },
      },
    },
    // ADR-040：响应内嵌 TaskItem 新增 assigneeIds，属破坏性契约变更，主版本递增。
    // ADR-082：TaskItem 新增墓碑账号展示名，重放字段变化再次递增主版本。
    idempotencyContractVersion: "3.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "TaskCompletionResponse",
            safeBodyFieldPaths: [
              ...taskFields.map((field) => "task." + field),
              "record",
              ...policy.success["200"].body.safeBodyFieldPaths.map(
                (field) => "record." + field,
              ),
            ],
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "TaskCompletionReplayContext",
        resultRefExtractor: "taskCompletionResources",
        currentReadAuthorizer: "taskCompletionCurrentReadAuthorizer",
      },
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: [
        "project",
        "module",
        "feature",
        "task",
        "taskGroup",
        "changeRecord",
        "leftoverItem",
      ],
      retry:
        "Pre-read complete parent and aggregate sets; release savepoint locks and retry at most 3 times on change",
    },
    auditAction: "task.status",
  },
];

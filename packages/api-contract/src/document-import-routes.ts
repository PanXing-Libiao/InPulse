import type { BodyBinding, RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): BodyBinding => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const previewErrors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "500": json("ErrorResponse"),
} as const;

const memberPreviewErrors = {
  ...previewErrors,
  "404": json("ErrorResponse"),
} as const;

const mutationErrors = {
  "400": json("ErrorResponse"),
  "401": json("ErrorResponse"),
  "403": json("ErrorResponse"),
  "409": json("ErrorResponse"),
  "422": json("ErrorResponse"),
  "429": json("ErrorResponse"),
  "500": json("ErrorResponse"),
} as const;

const documentResultFields = [
  "projectId",
  "projectCode",
  "digest",
  "counts.modules",
  "counts.tasks",
  "counts.reusedModules",
  "counts.addedMembers",
  "modules[].id",
  "modules[].code",
  "tasks[].id",
  "tasks[].code",
  "tasks[].moduleId",
];

const documentRequestBody = {
  contentTypes: [
    {
      contentType: "application/json",
      schemaRef: "ProjectDocumentImportRequest",
    },
  ],
} as const;

const previewRequestBody = {
  contentTypes: [
    {
      contentType: "application/json",
      schemaRef: "ProjectDocumentImportPreviewRequest",
    },
  ],
} as const;

const previewRoute = (input: {
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly hasProject: boolean;
}): RouteDefinition => ({
  method: "POST",
  path: input.path,
  operationId: input.operationId,
  summary: input.summary,
  request: {
    path: input.hasProject ? "ProjectPath" : "none",
    query: "none",
    headers: "none",
    body: previewRequestBody,
  },
  responses: {
    "200": json("ProjectDocumentImportPreviewResponse"),
    ...(input.hasProject ? memberPreviewErrors : previewErrors),
  },
  authPolicy: "session",
  // ADR-064：纯校验接口（预览不写任何持久化状态）显式声明 none。
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
});

const applyRoute = (input: {
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly hasProject: boolean;
}): RouteDefinition => ({
  method: "POST",
  path: input.path,
  operationId: input.operationId,
  summary: input.summary,
  request: {
    path: input.hasProject ? "ProjectPath" : "none",
    query: "none",
    headers: "ModuleMutationHeaders",
    body: documentRequestBody,
  },
  responses: {
    "200": json("ProjectDocumentImportResult"),
    ...mutationErrors,
    ...(input.hasProject ? { "404": json("ErrorResponse") } : {}),
  },
  authPolicy: "session",
  csrfPolicy: "required",
  idempotencyPolicy: "idempotencyRequired",
  idempotencyExceptionAdr: "none",
  // ADR-109：结果移除功能统计、功能 ID 与任务 scope，破坏性契约变更。
  idempotencyContractVersion: "2.0.0",
  idempotencyFingerprintVersion: "1.0.0",
  behaviorHeaders: [],
  idempotencyReplayPolicy: {
    version: "1.0.0",
    success: {
      "200": {
        body: {
          responseSchemaRef: "ProjectDocumentImportResult",
          safeBodyFieldPaths: documentResultFields,
        },
      },
    },
  },
  replayAuthorizationPolicy: {
    version: "1.0.0",
    resources: {
      contextSchemaRef: "ProjectDocumentImportReplayContext",
      resultRefExtractor: "documentImportResultResources",
      currentReadAuthorizer: "documentImportReplayAuthorizer",
    },
  },
  securityFlowPolicy: "none",
  versionPolicy: "none",
  concurrencyPolicy: {
    rowVersion: "none",
    lockOrder: ["project", "module", "task"],
    retry:
      "none; single transaction; project row FOR UPDATE reserved before any sequence or effect write",
  },
  auditAction: "project.documentImport",
});

/**
 * ADR-067 AI 辅助转换：`POST /document-imports/assist`。
 * 纯校验接口（无任何持久化副作用）：会话认证、无 CSRF、无幂等；调用管理员
 * 配置的 OpenAI 兼容端点把用户文档转成模板草稿。ADR-094 起，携带 target
 * 时先用一个只读短事务校验项目写权限与模块归属，上游调用仍在事务外。
 */
const assistRoute: RouteDefinition = {
  method: "POST",
  path: "/document-imports/assist",
  operationId: "assistDocumentImport",
  summary:
    "把用户自己的项目文档（任意结构）交给服务端配置的 OpenAI 兼容端点转成固定模板草稿，返回解析器预检问题；可选 target 在服务端校验项目写权限与模块归属。不写任何持久化状态，无 CSRF 与幂等记录。",
  request: {
    path: "none",
    query: "none",
    headers: "none",
    body: {
      contentTypes: [
        {
          contentType: "application/json",
          schemaRef: "DocumentImportAssistRequest",
        },
      ],
    },
  },
  responses: {
    "200": json("DocumentImportAssistResponse"),
    "400": json("ErrorResponse"),
    "401": json("ErrorResponse"),
    "404": json("ErrorResponse"),
    "422": json("ErrorResponse"),
    "500": json("ErrorResponse"),
    "503": json("ErrorResponse"),
  },
  authPolicy: "session",
  // ADR-067：纯校验接口（不写任何持久化状态）显式声明 none。
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

/**
 * ADR-064 文档导入：项目内导入（带 projectId）与整项目导入（不带 projectId）
 * 各两条路由，预览为纯校验接口，执行为数据库级幂等写命令。
 * ADR-067 追加 AI 辅助转换路由（纯校验，无持久化副作用）。
 */
export const documentImportRoutes: readonly RouteDefinition[] = [
  previewRoute({
    path: "/projects/{projectId}/document-imports/preview",
    operationId: "previewProjectDocumentImport",
    summary:
      "解析固定模板文档并返回模块/任务计划、行级问题与重复导入提示；不写任何持久化状态，执行时整笔重放校验。",
    hasProject: true,
  }),
  applyRoute({
    path: "/projects/{projectId}/document-imports",
    operationId: "importProjectDocument",
    summary:
      "在单个事务内按文档创建/复用模块并创建任务，写审计、活动、通知与搜索投影；同摘要文档禁止重复导入，整笔幂等。",
    hasProject: true,
  }),
  previewRoute({
    path: "/project-imports/preview",
    operationId: "previewProjectImport",
    summary:
      "解析整项目导入文档（含项目段）：校验项目编码、成员与全部下级计划；不写任何持久化状态。",
    hasProject: false,
  }),
  applyRoute({
    path: "/project-imports",
    operationId: "importProject",
    summary:
      "单事务创建整个项目：项目、项目成员（含任务负责人自动加入）、模块与任务，写审计、活动、通知与搜索投影；项目编码全局唯一，同摘要文档禁止重复导入。",
    hasProject: false,
  }),
  assistRoute,
];

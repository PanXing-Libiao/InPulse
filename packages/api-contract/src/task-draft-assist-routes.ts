import type { BodyBinding, RouteDefinition } from "./route-definition.js";
import type { SchemaName } from "./schema-registry.js";

const json = (schemaRef: SchemaName): BodyBinding => ({
  body: { contentTypes: [{ contentType: "application/json", schemaRef }] },
});

const errors = (statuses: readonly number[]) =>
  Object.fromEntries(
    statuses.map((status) => [String(status), json("ErrorResponse")]),
  );

/**
 * 新建任务 AI 识别：只做识别与预填建议，不创建任务、不写任何持久化状态。
 *
 * projectId 走路径参数：服务端据此校验实时成员关系，并把项目成员、模块与
 * 功能清单作为候选交给模型；模型只按名称回答，真实 ID 全部由服务端匹配。
 * 因此本路由不信任任何客户端提交的归属 ID，也不让模型直接产出 ID。
 */
export const taskDraftAssistRoutes: readonly RouteDefinition[] = [
  {
    method: "POST",
    path: "/projects/{projectId}/task-draft-assist",
    operationId: "assistTaskDraft",
    summary:
      "把一句模糊的任务描述结合最近对话整理成新建任务草稿：标题、说明、优先级、截止时间、归属与负责人；只返回预填建议，不创建任务、不写库。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "none",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "TaskDraftAssistRequest",
          },
        ],
      },
    },
    responses: {
      "200": json("TaskDraftAssistResponse"),
      ...errors([400, 401, 404, 422, 500, 503]),
    },
    authPolicy: "session",
    // 纯校验接口：不写任何持久化状态，只把当前用户有权看到的项目清单
    // 交给管理员配置的 AI 端点，并把结果回给本人（与 assistDocumentImport 同族）。
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
    method: "POST",
    path: "/task-draft-assist",
    operationId: "assistTaskDraftStandalone",
    summary:
      "未选择项目时先读取用户描述或聊天截图，整理成可预填的任务草稿；只返回文本字段，模块、功能与负责人留空，等用户补充项目后再确认归属。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "TaskDraftAssistRequest",
          },
        ],
      },
    },
    responses: {
      "200": json("TaskDraftAssistResponse"),
      ...errors([400, 401, 422, 500, 503]),
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
  },
];

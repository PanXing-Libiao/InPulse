/**
 * AGENTS.md 第 6 节：纯校验接口（无任何持久化副作用）可以显式声明
 * idempotencyPolicy: none 与 csrfPolicy: none。allowlist 之外的 POST / PUT /
 * PATCH / DELETE 一律默认 idempotencyRequired；allowlist 成员必须同时满足
 * POST + idempotencyPolicy none + csrfPolicy none，任一不满足即契约失败。
 */
export const pureValidationOperationIds = [
  "previewProjectDocumentImport",
  "previewProjectImport",
  // ADR-067：AI 辅助转换只生成草稿文本，不写任何持久化状态。
  "assistDocumentImport",
  // ADR-068：测试连接只发最小探测请求，不写任何持久化状态。
  "testAiAssistSettings",
  // ADR-076：迭代总结 AI 改写只返回文本，不写任何持久化状态。
  "assistRecordSummary",
  // 新建任务 AI 识别只返回预填建议，不写任何持久化状态。
  "assistTaskDraft",
] as const;

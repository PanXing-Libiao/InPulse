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
 * B-3b 跨项目记录读路由（F-18 / F-19 的跨项目读扩展）。
 *
 * 两条都是只读 GET：authPolicy 为 session，其余策略按 §3 全量显式写 none。
 * 授权范围固定为服务端 AuthorizedProjectScope：非成员项目被静默排除而不是
 * 返回 403 / 404（与 R-6 遗留问题列表、R-7 聚合组列表同族），因此不登记
 * 403 与 404；status=VOID / ALL 的 VOID 行只对系统管理员可见，非管理员请求
 * 收敛为 PUBLISHED 行而不是 403。校验失败（含归一化后 q 不足 2 字）统一 422。
 */
export const recordFeedRoutes: readonly RouteDefinition[] = [
  {
    method: "GET",
    path: "/change-records",
    operationId: "listRecordFeed",
    summary:
      "B-3b 跨项目迭代记录清单：按 AuthorizedProjectScope 汇总所有可读项目的正式记录（PUBLISHED / VOID），支持按项目收窄、状态（PUBLISHED / VOID / ALL）、来源（主任务 / 来源任务 / 模块级）与 q 全文检索筛选；服务端批量回填项目 / 模块名与作者引用；固定 published_at DESC, id DESC 游标分页，limit 1～100、默认 20；projectId 只收窄范围，非成员项目为空页而不是 404。",
    request: {
      path: "none",
      query: "RecordFeedQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": json("RecordFeedPage"),
      ...errors([401, 422, 500]),
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
  {
    method: "GET",
    path: "/me/record-drafts",
    operationId: "listMyRecordDrafts",
    summary:
      "B-3b 我的草稿（全局）：跨项目列出当前用户为作者的未发布草稿，服务端批量回填项目 / 模块名；作者恒为当前 actor，不接受 assigneeId / userId / projectIds 等他人身份或授权范围参数；固定 created_at DESC, id DESC 游标分页，limit 1～100、默认 20；被移出项目后其草稿立即不再返回。",
    request: {
      path: "none",
      query: "MyRecordDraftListQuery",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": json("MyRecordDraftPage"),
      ...errors([401, 422, 500]),
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

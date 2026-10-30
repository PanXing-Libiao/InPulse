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

/** ProjectDetailResponse 的完整叶子字段；幂等重放必须逐字段声明。 */
const projectDetailFields = [
  "project.id",
  "project.code",
  "project.name",
  "project.description",
  "project.status",
  "project.hasCompletedTask",
  "project.rowVersion",
  "project.createdBy",
  "project.createdAt",
  "project.updatedAt",
  "project.memberCount",
  "project.stats.activeModuleCount",
  "project.stats.openTaskCount",
  "project.stats.completedTaskCount",
  "currentUserRole",
] as const;

const replayPolicy = {
  version: "1.0.0",
  success: {
    "200": {
      body: {
        responseSchemaRef: "ProjectDetailResponse" as const,
        safeBodyFieldPaths: projectDetailFields,
      },
    },
  },
} as const;

const replayAuthorization = {
  version: "1.0.0",
  resources: {
    contextSchemaRef: "ProjectReplayContext" as const,
    resultRefExtractor: "projectId",
    currentReadAuthorizer: "projectCurrentReadAuthorizer",
  },
} as const;

/**
 * ADR-062 / ADR-085：删除是物理删除——项目行与全部下级业务数据消失，但项目
 * 自己的审计链作为只读历史保留。响应仍然无正文，因此重放策略只有 noBody 分支；
 * 载荷本身不携带任何项目字段。
 */
const deleteReplayPolicy = {
  version: "1.0.0",
  success: { "204": { noBody: true } },
} as const;

/**
 * 项目删除的幂等重放授权（ADR-062 的 `actorOnly` 例外）：物理删除之后项目行与
 * 成员关系消失，项目审计链虽按 ADR-085 保留但已冻结，不参与资源级复核——复核
 * 项目可读性会把合法重放变成 404，复核「保留的成员关系」也已无数据可依。因此
 * 重放只复核当前认证（Session 有效、用户未被停用，由 HTTP 层在重放前完成），
 * 同 Key、同摘要与同契约版本直接重放已存的 204。
 */
const deleteReplayAuthorization = {
  version: "2.0.0",
  actorOnly: true,
} as const;

export const projectRoutes: readonly RouteDefinition[] = [
  {
    method: "PATCH",
    path: "/projects/{projectId}",
    operationId: "updateProject",
    summary:
      "项目活跃成员或系统管理员编辑项目名称与描述；编码不可修改，If-Match 乐观锁防并发覆盖，审计、活动与搜索投影在同一事务提交。2026-09-23 起项目不再有归档态，写权限只受实时成员关系与并发版本约束。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "ProjectVersionHeaders",
      body: {
        contentTypes: [
          { contentType: "application/json", schemaRef: "ProjectEditRequest" },
        ],
      },
    },
    responses: { "200": json("ProjectDetailResponse"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-033：详情响应新增 currentUserRole，重放安全字段变化，旧 Key 409。
    // 2026-09-16：项目统计新增 completedTaskCount，重放安全字段变化，旧 Key 409。
    // 2026-09-17：项目四态改造后 ProjectItem 新增 hasCompletedTask，重放安全字段变化，旧 Key 409。
    // 2026-09-22：ADR-039 移除 PROJECT_ADMIN，currentUserRole 枚举收窄，旧 Key 409。
    // 2026-09-23：项目三态改造，project.status 取值域收窄（去掉 ARCHIVED），旧 Key 409。
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: replayPolicy,
    replayAuthorizationPolicy: replayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project"],
      retry: "none; project FOR SHARE then FOR UPDATE, expected row_version",
    },
    auditAction: "project.update",
  },
  {
    method: "PATCH",
    path: "/projects/{projectId}/status",
    operationId: "changeProjectStatus",
    summary:
      "F-06.3 项目状态变更：本项目任意活跃成员或系统管理员（ADR-039）把项目在未开始 / 进行中 / 维护中之间手动切换（2026-09-23 起三态即全部状态，项目不再有归档）；进入维护中要求项目下任务全部收尾，仍有未完成且未取消的任务时 409 PROJECT_MAINTENANCE_TASKS_OPEN；未开始与维护中互改 409 PROJECT_STATUS_LEVEL_SKIP，项目内出现过已完成任务后回退未开始 409 PROJECT_STATUS_NOT_STARTED_LOCKED；维护中不通知，未开始升级为进行中通知全体成员；审计、活动与搜索投影在同一事务提交；状态变更不推进项目 `row_version`（ADR-092），内容修改仍每次 +1。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "ProjectVersionHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "ProjectStatusChangeRequest",
          },
        ],
      },
    },
    responses: { "200": json("ProjectDetailResponse"), ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // 2026-09-22：ADR-039 门禁改为任意活跃成员且 currentUserRole 枚举收窄，旧 Key 409。
    // 2026-09-23：新增维护中任务收尾门禁与 project.status 取值域收窄，旧 Key 409。
    // 2026-10-21：ADR-092 状态变更不再推进 row_version，响应版本语义变化，旧 Key 409。
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: replayPolicy,
    replayAuthorizationPolicy: replayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project"],
      retry: "none; project FOR UPDATE, expected row_version",
    },
    auditAction: "project.status.change",
  },
  {
    method: "DELETE",
    path: "/projects/{projectId}",
    operationId: "deleteProject",
    summary:
      "F-06.4 删除项目（ADR-062，项目审计链保留口径由 ADR-085 修订，替代 ADR-049/ADR-051 的软删除与彻底删除两步）：只有本项目组长与系统管理员可以删除，普通成员 403 PROJECT_DELETE_FORBIDDEN，非成员与不存在一律 404。删除是物理删除——项目行、模块、任务、聚合组、迭代记录、遗留项、外部链接、成员关系、通知、动态与搜索投影在同一事务内一并清空，不可撤销且没有还原入口；项目自己的 PROJECT 审计日志与链头保留为只读历史，项目编码随之释放、可以被新建项目复用。SYSTEM 审计链新增一条 project.delete（操作者、项目编码与名称、删除行数与保留审计行数），只对系统管理员可见。If-Match 版本不符 409 PROJECT_VERSION_CONFLICT，CSRF 与数据库幂等必填，同 Key 重放直接返回已存的 204。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "ProjectVersionHeaders",
      body: { noBody: true },
    },
    responses: { "204": { noBody: true }, ...errors },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-062：删除语义由软删除改为不可逆的物理删除，且重放授权由资源级降为
    // actorOnly，旧 Key 在新契约下 409。
    idempotencyContractVersion: "2.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: ["If-Match"],
    idempotencyReplayPolicy: deleteReplayPolicy,
    replayAuthorizationPolicy: deleteReplayAuthorization,
    securityFlowPolicy: "none",
    versionPolicy: {
      apiVersion: "v1",
      schemaVersion: "1.0.0",
      ifMatch: "required",
    },
    concurrencyPolicy: {
      rowVersion: "required",
      lockOrder: ["project"],
      retry: "none; project FOR UPDATE, expected row_version",
    },
    auditAction: "project.delete",
  },
];

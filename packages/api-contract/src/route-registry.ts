import { wecomBindingRoutes } from "./wecom-binding-routes.js";
import { wecomRobotRoutes } from "./wecom-robot-routes.js";
import { projectWecomGroupRoutes } from "./project-wecom-group-routes.js";
import { aiAssistSettingsRoutes } from "./ai-assist-settings-routes.js";
import { taskCreateRoutes } from "./task-create-routes.js";
import { documentImportRoutes } from "./document-import-routes.js";
import { aggregateReadRoutes } from "./aggregate-read-routes.js";
import { externalLinkRoutes } from "./external-link-routes.js";
import { leftoverTaskRoutes } from "./leftover-task-routes.js";
import { recordFeedRoutes } from "./record-feed-routes.js";
import { recordSummaryRoutes } from "./record-summary-routes.js";
import {
  recordDraftDeleteRoutes,
  recordDraftRoutes,
  taskRecordDraftRoutes,
} from "./record-draft-routes.js";
import { taskGroupRoutes } from "./task-group-routes.js";
import { taskCompletionRoutes } from "./task-completion-routes.js";
import { featureRoutes } from "./feature-routes.js";
import { taskRoutes, moduleTaskRoutes } from "./task-routes.js";
import { apiBasePath, type RouteDefinition } from "./route-definition.js";
import { moduleRoutes } from "./module-routes.js";
import { adminUserRoutes } from "./user-admin-routes.js";
import { organizationRoutes } from "./organization-routes.js";
import { projectMemberRoutes } from "./project-member-routes.js";
import { projectRoutes } from "./project-routes.js";
import {
  recordLifecycleRoutes,
  recordLeftoverRoutes,
  publishedRecordRoutes,
  recordPublicationRoutes,
} from "./published-record-routes.js";

export * from "./route-definition.js";

/**
 * Route Registry 是 method、path、operationId、状态码、Content-Type、鉴权、
 * CSRF、幂等与并发策略的唯一来源。只登记已实现的路由：Controller 未注册时
 * validateRouteRegistry 失败，未实现的规划路由不得提前登记。
 */
export const routeRegistry = [
  ...externalLinkRoutes,
  ...adminUserRoutes,
  ...organizationRoutes,
  ...wecomBindingRoutes,
  ...wecomRobotRoutes,
  ...projectWecomGroupRoutes,
  ...aiAssistSettingsRoutes,
  ...projectMemberRoutes,
  ...projectRoutes,
  ...moduleRoutes,
  ...taskCreateRoutes,
  ...featureRoutes,
  ...taskRoutes,
  ...recordDraftRoutes,
  ...recordDraftDeleteRoutes,
  ...publishedRecordRoutes,
  ...recordLifecycleRoutes,
  ...recordPublicationRoutes,
  ...recordLeftoverRoutes,
  ...taskRecordDraftRoutes,
  ...taskGroupRoutes,
  ...aggregateReadRoutes,
  ...recordFeedRoutes,
  ...recordSummaryRoutes,
  ...taskCompletionRoutes,
  ...leftoverTaskRoutes,
  ...moduleTaskRoutes,
  ...documentImportRoutes,
  {
    method: "GET",
    path: "/health",
    operationId: "getHealth",
    summary: "存活探针，不访问数据库，不需要认证。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "HealthResponse" },
          ],
        },
      },
    },
    authPolicy: "none",
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
    path: "/health/live",
    operationId: "getHealthLive",
    summary: "存活探针，只确认进程事件循环正常，不访问数据库。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "HealthResponse" },
          ],
        },
      },
    },
    authPolicy: "none",
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
    path: "/health/ready",
    operationId: "getHealthReady",
    summary: "就绪探针：验证数据库可连接且迁移版本存在，未就绪返回 503。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "HealthResponse" },
          ],
        },
      },
      "503": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "none",
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
    path: "/auth/csrf",
    operationId: "issueCsrfToken",
    summary:
      "匿名或已登录用户签发一次性同步 CSRF Token；匿名时创建预认证 Session。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "CsrfIssueResponse" },
          ],
        },
      },
    },
    authPolicy: "none",
    csrfPolicy: "none",
    idempotencyPolicy: "securityFlow",
    idempotencyExceptionAdr: "ADR-023",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: {
      singleConsumptionOrNaturalIdempotency:
        "每次签发新 Token 并轮换匿名预认证 Session，数据库只保存 Hash；已登录 Session 复用同一 Session 并最多保留 4 个有效 Hash",
      clientRecoveryPath: "再次调用签发端点",
    },
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "GET",
    path: "/me",
    operationId: "getCurrentUser",
    summary: "返回当前登录用户资料；身份由服务端从 Session Cookie 解析。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "CurrentUserResponse",
            },
          ],
        },
      },
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
    path: "/users",
    operationId: "getUserDirectory",
    summary:
      "读取全部启用用户的轻量目录，用于创建项目时选择项目成员；只返回 id、姓名、头像与管理员标记。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "UserDirectoryResponse",
            },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    method: "POST",
    path: "/auth/login",
    operationId: "login",
    summary:
      "只接受匿名预认证 Session 与 X-CSRF-Token；成功后消费预认证 Session、轮换 Cookie 并签发新认证 Session 与 CSRF Token。",
    request: {
      path: "none",
      query: "none",
      headers: "LoginHeaders",
      body: {
        contentTypes: [
          { contentType: "application/json", schemaRef: "LoginRequest" },
        ],
      },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "LoginResponse" },
          ],
        },
      },
      "429": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "none",
    csrfPolicy: "required",
    idempotencyPolicy: "securityFlow",
    idempotencyExceptionAdr: "ADR-023",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: {
      singleConsumptionOrNaturalIdempotency:
        "同一匿名预认证 Session 与其 CSRF Hash 只能成功登录一次；成功时在同一事务条件消费预认证 Session，并创建新的认证 Session 与 CSRF Hash",
      clientRecoveryPath:
        "若已有认证/受限 Session 先登出或清 Cookie，再重新调用 CSRF 签发端点并登录",
    },
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "POST",
    path: "/auth/logout",
    operationId: "logout",
    summary:
      "有效 Session 验证同源与当前 CSRF Token 后在事务内撤销；无效或已撤销 Session 仅清 Cookie，统一返回 204。",
    request: {
      path: "none",
      query: "none",
      headers: "LogoutHeaders",
      body: { noBody: true },
    },
    responses: {
      "204": { noBody: true },
    },
    authPolicy: "none",
    csrfPolicy: "required",
    idempotencyPolicy: "securityFlow",
    idempotencyExceptionAdr: "ADR-023",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: {
      singleConsumptionOrNaturalIdempotency:
        "有效 Session 只在同一事务验证 CSRF 后条件撤销；无效或已撤销 Session 的同源重试仅清 Cookie，不执行状态写",
      clientRecoveryPath:
        "直接重试同一登出请求；有效 Session 需先调用 CSRF 签发端点取得当前 Token",
    },
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "GET",
    path: "/auth/sso/start",
    operationId: "startSsoLogin",
    summary:
      "生成 state、nonce 与 PKCE verifier（只保存 Hash 并绑定发起浏览器 Cookie）后 302 到 Casdoor 授权端点；SSO 未配置时 302 回本地隐藏入口。",
    request: {
      path: "none",
      query: "SsoStartQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "302": { noBody: true },
    },
    authPolicy: "none",
    csrfPolicy: "none",
    idempotencyPolicy: "securityFlow",
    idempotencyExceptionAdr: "ADR-023",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: {
      singleConsumptionOrNaturalIdempotency:
        "每次调用生成新的 state、nonce 与 PKCE verifier 并只保存 Hash；同一 state 只允许一次 token 交换消费（条件更新）",
      clientRecoveryPath: "重新调用 /api/v1/auth/sso/start 发起新的登录",
    },
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "GET",
    path: "/auth/sso/callback",
    operationId: "completeSsoLogin",
    summary:
      "校验 state（含发起浏览器 Cookie 绑定）后一次性消费，服务端换取 token 并验签 id_token，按用户映射签发本地会话后 302 回应用；失败一律 302 回登录页携带错误码。",
    request: {
      path: "none",
      query: "SsoCallbackQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "302": { noBody: true },
    },
    authPolicy: "none",
    csrfPolicy: "none",
    idempotencyPolicy: "securityFlow",
    idempotencyExceptionAdr: "ADR-023",
    idempotencyContractVersion: "none",
    idempotencyFingerprintVersion: "none",
    behaviorHeaders: "none",
    idempotencyReplayPolicy: "none",
    replayAuthorizationPolicy: "none",
    securityFlowPolicy: {
      singleConsumptionOrNaturalIdempotency:
        "state 在同一事务内按 Hash 条件消费，只有一次 token 交换与一次本地会话签发成功；重复、过期或并发回调一律按失败重定向",
      clientRecoveryPath: "重新调用 /api/v1/auth/sso/start 发起新的登录",
    },
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "auth.sso_login",
  },
  {
    method: "GET",
    path: "/search",
    operationId: "getSearch",
    summary:
      "按服务端 AuthorizedProjectScope 搜索当前用户可访问项目中的投影实体；查询 1～200 个字符（单字可搜），普通输入使用 PGroonga 转义查询，禁止客户端传入授权范围；cursor 为服务端签名、校验并带过期时间的不透明字符串；includeVoid=true 仅供系统管理员显式开启 VOID 可见，普通调用不影响范围。",
    request: {
      path: "none",
      query: "SearchQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "SearchPage" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    path: "/audit-logs",
    operationId: "getAuditLogs",
    summary:
      "系统管理员读取原始审计链；要求当前有效的完整管理员 Session（is_admin），不要求 CSRF；AuditQueryService 使用独立 audit_reader 只读连接查询，读取不写审计（ADR-060）；action 精确匹配动作码，actorIds 为逗号分隔的 1..100 个操作人 ID（省略即不过滤，等价于全体操作人），from/to 为半开区间；不传 projectId 读 SYSTEM 链，传 projectId 读 PROJECT:<id> 链，chain=all 读取全部链并按 occurred_at 倒序跨链分页（ADR-061，与 projectId 互斥，同时传入返回 422）。",
    request: {
      path: "none",
      query: "AuditLogQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "AuditLogPage" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "403": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "adminSession",
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
    path: "/projects/{projectId}/activity",
    operationId: "getProjectActivity",
    summary:
      "读取当前用户可访问项目的脱敏动态时间线；SQL 前强制服务端 AuthorizedProjectScope，普通成员只返回 MEMBER，系统管理员可显式包含 ADMIN_ONLY；category 按 chip 分类在 SQL 层过滤；dayTotals 给出范围内每个 Asia/Shanghai 自然日的全量总数。",
    request: {
      path: "ActivityPath",
      query: "ActivityQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ActivityPage" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "404": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    path: "/activity",
    operationId: "listActivity",
    summary:
      "跨项目聚合动态时间线：服务端把实时 AuthorizedProjectScope 与全部已删除项目（ADR-050 / ADR-052 对全部登录用户可见的公开链）合并后在全量结果集上按 occurred_at DESC, id DESC 做全局游标分页，加载更多只会追加更早的条目；projectIds 只用于收窄（越权或未知项目静默排除，不返回 403 / 404）；category 按 chip 分类过滤；dayTotals 给出每个 Asia/Shanghai 自然日的全量总数，不随分页增长。",
    request: {
      path: "none",
      query: "ActivityFeedQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ActivityPage" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    path: "/projects",
    operationId: "listProjects",
    summary:
      "读取当前认证用户可见项目；系统管理员返回全部项目，普通用户只返回存在 ACTIVE 成员关系的项目；先按「未完成 / 维护中」两档排序（未完成 = 进行中与未开始同属一档，ADR-063 修订 ADR-046 决策 1 的项目行），档内按最近变更时间（该项目动态里最新一条业务事件的发生时间，如生成任务、完成任务、发布记录、成员变化）从近到远，再按创建时间、项目 ID 降序兜底；每个条目附带当前用户在本项目的成员角色；SQL 前使用服务端 AuthorizedProjectScope，不接受客户端传入授权范围。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "ProjectListResponse",
            },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    path: "/projects/{projectId}",
    operationId: "getProject",
    summary:
      "读取当前用户可访问的单项目摘要；系统管理员可访问全部项目；不存在与无权访问统一返回 404；包含归档历史。",
    request: {
      path: "ProjectPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "ProjectDetailResponse",
            },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "404": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    path: "/notifications",
    operationId: "getNotifications",
    summary:
      "当前用户自己的站内通知列表；SQL 强制 recipient_id=当前用户，cursor 为服务端签名、校验并带过期时间的不透明字符串；mutedProjectCategories 为逗号分隔的 projectId:category 对，用于按浏览器中的项目通知选项过滤当前用户的只读视图与未读数。",
    request: {
      path: "none",
      query: "NotificationQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "NotificationPage" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    path: "/notifications/unread-count",
    operationId: "getNotificationUnreadCount",
    summary:
      "返回当前登录用户的未读通知数量；mutedProjectCategories 与通知列表使用同一过滤口径，隐藏类别不会计入未读数。",
    request: {
      path: "none",
      query: "NotificationMuteQueryRequest",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "NotificationUnreadCountResponse",
            },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
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
    method: "POST",
    path: "/notifications/{notificationId}/read",
    operationId: "readNotification",
    summary:
      "把当前用户的一条通知标记为已读；不存在或非本人统一返回 404，重复执行自然幂等。",
    request: {
      path: "NotificationPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "204": { noBody: true },
      "400": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "403": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "404": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "409": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: { "204": { noBody: true } },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "NotificationReplayContext",
        resultRefExtractor: "notificationId",
        currentReadAuthorizer: "notificationOwnerAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "POST",
    path: "/notifications/{notificationId}/unread",
    operationId: "unreadNotification",
    summary:
      "把当前用户的一条通知标记为未读；不存在或非本人统一返回 404，重复执行自然幂等。",
    request: {
      path: "NotificationPath",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "204": { noBody: true },
      "400": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "403": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "404": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "409": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: { "204": { noBody: true } },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "NotificationReplayContext",
        resultRefExtractor: "notificationId",
        currentReadAuthorizer: "notificationOwnerAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "POST",
    path: "/notifications/read-all",
    operationId: "readAllNotifications",
    summary: "把当前用户的全部未读通知标记为已读；响应不暴露其他用户资源。",
    request: {
      path: "none",
      query: "none",
      headers: "none",
      body: { noBody: true },
    },
    responses: {
      "204": { noBody: true },
      "400": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "403": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "409": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    idempotencyContractVersion: "1.0.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: { "204": { noBody: true } },
    },
    replayAuthorizationPolicy: { version: "1.0.0", actorOnly: true },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "none",
  },
  {
    method: "POST",
    path: "/projects",
    operationId: "createProject",
    summary:
      "任一启用用户创建项目；创建者自动成为活跃成员且不可取消，可选项目成员；单事务内写审计、通知、活动与搜索投影，不创建任何模块（ADR-030 允许新项目零模块）；项目成员无效/停用/重复则整笔回滚。",
    request: {
      path: "none",
      query: "none",
      headers: "CreateProjectHeaders",
      body: {
        contentTypes: [
          {
            contentType: "application/json",
            schemaRef: "CreateProjectRequest",
          },
        ],
      },
    },
    responses: {
      "200": {
        body: {
          contentTypes: [
            {
              contentType: "application/json",
              schemaRef: "CreateProjectResponse",
            },
          ],
        },
      },
      "400": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "401": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "409": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "422": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
      "500": {
        body: {
          contentTypes: [
            { contentType: "application/json", schemaRef: "ErrorResponse" },
          ],
        },
      },
    },
    authPolicy: "session",
    csrfPolicy: "required",
    idempotencyPolicy: "idempotencyRequired",
    idempotencyExceptionAdr: "none",
    // ADR-033：响应成员摘要新增 role，重放安全字段随之变化，旧 Key 409。
    // 2026-09-17：项目四态改造后新建项目状态由 ACTIVE 改为 NOT_STARTED，响应 Schema 变化，旧 Key 409。
    // 2026-09-22：ADR-039 移除 PROJECT_ADMIN，members[].role 枚举收窄，旧 Key 409。
    idempotencyContractVersion: "2.3.0",
    idempotencyFingerprintVersion: "1.0.0",
    behaviorHeaders: [],
    idempotencyReplayPolicy: {
      version: "1.0.0",
      success: {
        "200": {
          body: {
            responseSchemaRef: "CreateProjectResponse",
            safeBodyFieldPaths: [
              "project.id",
              "project.code",
              "project.name",
              "project.description",
              "project.status",
              "project.rowVersion",
              "project.createdBy",
              "project.createdAt",
              "project.updatedAt",
              "members[].userId",
              "members[].status",
              "members[].role",
              "members[].joinedAt",
            ],
          },
        },
      },
    },
    replayAuthorizationPolicy: {
      version: "1.0.0",
      resources: {
        contextSchemaRef: "CreateProjectReplayContext",
        resultRefExtractor: "projectId",
        currentReadAuthorizer: "projectMemberReadAuthorizer",
      },
    },
    securityFlowPolicy: "none",
    versionPolicy: "none",
    concurrencyPolicy: "none",
    auditAction: "project.create",
  },
] satisfies readonly RouteDefinition[];

export type RegisteredRoute = (typeof routeRegistry)[number];

export function fullPath(path: string): string {
  return `${apiBasePath}${path}`;
}

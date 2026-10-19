# 权限矩阵

状态：已接受的设计基线；应用骨架建立后必须由 `apps/api/test/permissions.matrix.ts` 镜像为可执行测试数据。Route Registry 的每个操作至少匹配一条允许和一条拒绝用例，CI 禁止未覆盖路由。

## 身份定义

| 身份 | 定义 |
|---|---|
| 匿名 | 没有有效 Session |
| 活跃成员 | 在目标项目存在 ACTIVE 成员记录 |
| 其他项目成员 | 有有效 Session，但不是目标项目活跃成员 |
| 已移除成员 | 目标项目最近成员记录为 REMOVED |
| 停用用户 | 用户被停用；其全部 Session 按无效处理；本地口令与企业微信 SSO 均拒绝登录；历史数据与引用全部保留，可在成员列表中重新启用 |
| 系统管理员 | 全局管理员；高风险操作要求当前有效的完整管理员 Session（ADR-031 起不再要求 TOTP 重认证） |

项目创建者不是独立身份。创建时必须作为项目成员且表单不可取消，创建者成员行以 `role='LEADER'` 落库（ADR-033）；创建完成后可由系统管理员或现任组长把组长身份转交给其他活跃成员（[ADR-053](adr/ADR-053.md)：组长只能转移、不能被撤销，也不能被直接移除——要移除现任组长必须先把身份交出去；有活跃成员的项目必须恰好有一名组长）。`projects.created_by` 永久保留用于溯源，不直接授予权限；项目内权限来自成员行 `role`（`MEMBER | LEADER`，ADR-039、[ADR-053](adr/ADR-053.md)），角色只在本项目内生效，成员被移除即失效、重新加入从普通成员开始（无活跃组长的项目由首位加入者直接成为组长）。系统管理员创建者仍保留与成员记录无关的全局权限。详见 [ADR-012](adr/ADR-012.md)（已被 [ADR-033](adr/ADR-033.md) 扩展）。

## 认证安全流程矩阵

下表的 operationId 集合必须与 [ADR-023](adr/ADR-023.md) allowlist 精确相等（经 [ADR-032](adr/ADR-032.md) 扩展为 `issueCsrfToken`、`login`、`logout`、`startSsoLogin`、`completeSsoLogin` 五条，经 [ADR-069](adr/ADR-069.md) 扩展 `createWecomBindingCode`、经 [ADR-077](adr/ADR-077.md) 扩展 `createProjectWecomGroupCode` 为七条），并逐项镜像到 Route Registry 和可执行权限测试。“管理员完整 Session”指管理员密码登录成功后的完整认证态；ADR-031 起登录不再经过 MFA challenge，也不存在管理员受限 Session。即使某一身份列为允许，Origin、Fetch Metadata、CSRF、速率限制及指定前置状态仍可产生拒绝用例，确保每个 operationId 至少有一条允许和一条拒绝测试。

| operationId | 匿名/预认证 Session | 已认证普通用户 | 管理员完整 Session | 停用目标用户 | 前置状态与结果 |
|---|---:|---:|---:|---:|---|
| `issueCsrfToken` | 允许 | 允许 | 允许 | 允许（按匿名） | Fetch Metadata、同源可读与限流通过；GET 的 Origin/Referer 若存在则精确校验，缺失不单独拒绝；按当前有效 Session 类型签发 Token；停用/无效 Session 先清认证 Cookie，再创建匿名预认证状态，不恢复身份 |
| `login` | 仅有效 `PREAUTH` + CSRF 允许 | 409 | 409 | 401 | 只消费匿名预认证 Session 与其 CSRF；已有认证 Session 必须先登出/清 Cookie，再签发新预认证 CSRF；管理员密码验证成功后直接签发完整认证 Session 与新 CSRF，不再有 MFA 挑战步骤（[ADR-031](adr/ADR-031.md)） |
| `logout` | 204 | 204 | 204 | 204 | 有效 Session 时要求其 CSRF 并条件撤销；Session 无效、已撤销或首次响应丢失后的重试仅在同源 Origin/Referer 与 Fetch Metadata 通过时清 Cookie 并返回 204，不执行状态写 |
| `startSsoLogin` | 允许（302 到授权端点） | 允许（302） | 允许（302） | 允许（按匿名；302） | 每次调用生成新的 state、nonce 与 PKCE verifier 并只保存 Hash，同时下发短期 `__Host-sso-state` Cookie 绑定发起浏览器；`returnTo` 必须是站内相对路径，非法值回落默认路径；SSO 未配置时 302 回 `/login?local=1&sso=disabled`；302 只用于认证导航，本接口不签发本地会话（[ADR-032](adr/ADR-032.md)） |
| `completeSsoLogin` | 允许（302 回应用页；成功即签发本地会话） | 允许（302，按重新登录处理） | 允许（302） | 拒绝（302 回登录页携带错误码，不恢复身份） | 必须同时匹配 URL 的 state 与 `__Host-sso-state` Cookie，并在同一事务内一次性消费；缺失、过期、重放或并发消费失败、token 交换失败、id_token 验签或 iss/aud/exp/nonce 校验失败、账号同名但邮箱不一致、账号已停用一律 302 回登录页并审计；JIT 开通仅在开通事务内经 `pg_advisory_xact_lock` 串行化判定平台此前没有任何账号（`app.users` 无行）时授予 `is_admin=true`（[ADR-075](adr/ADR-075.md)），其余情况 `is_admin=false`；成功时签发与口令登录同构的本地会话与 CSRF；Casdoor 的 `isAdmin` 等其余 claims 不得用于 InPulse 权限判定（[ADR-032](adr/ADR-032.md)） |
| `createWecomBindingCode` | 401 | 允许 | 允许 | 401（按无效 Session） | 要求有效认证 Session、同源与当前 CSRF；每次调用覆盖签发新码并立即作废旧码，明文码只返回一次、服务端只存 SHA-256 Hash，10 分钟有效、一次性消费；同码重复兑换一律拒绝（[ADR-069](adr/ADR-069.md)） |
| `createProjectWecomGroupCode` | 401 | 允许（仅组长；普通成员 403） | 允许 | 401（按无效 Session） | 仅系统管理员或本项目组长（普通成员 403 `PROJECT_WECOM_GROUP_FORBIDDEN`、非成员 404）；同源 + 当前 CSRF 必填；每次调用覆盖签发新码并立即作废旧码，明文码只返回一次、服务端只存 SHA-256 Hash，10 分钟有效、一次性消费（[ADR-077](adr/ADR-077.md)） |

用户修改、管理员用户管理及其他不签发或消费一次性安全材料的写操作不在本表，仍按普通业务命令使用 `idempotencyRequired`；管理员高风险操作只要求当前有效的完整管理员 Session（[ADR-031](adr/ADR-031.md)）。

## 业务操作矩阵

F-12 本地接口已登记到可执行权限矩阵，真实 HTTP/数据库验收仍待运行，见 [交审说明](f12-local-handoff.md)：

| operationId | 允许主体 | 拒绝与附加门禁 |
| --- | --- | --- |
| listModules | 当前活跃项目成员、系统管理员 | 匿名/无效 Session 401，其他项目/已移除成员 404；ADR-044 起模块已无归档态，返回该项目全部模块 |
| createModule | 当前活跃项目成员、系统管理员 | 同上；父项目三态下均可写（ADR-043，项目已无归档态），Session/CSRF 与幂等必需，只能创建 NORMAL |
| updateModule | 当前活跃项目成员、系统管理员 | 同上；真实模块归属与父项目可写（ADR-043），If-Match；允许编辑未分类名称/描述 |
| deleteModule | **仅系统管理员或本项目 ACTIVE 组长（LEADER）**（[ADR-059](adr/ADR-059.md)，ADR-039 下放的第五处例外） | 匿名/停用 401；非成员、已移除成员与不存在统一 404 `MODULE_NOT_FOUND`（不泄露存在性）；普通成员与项目管理员 403 `MODULE_DELETE_FORBIDDEN`；**未分类模块一律 409 `MODULE_UNCLASSIFIED_PROTECTED`**（[ADR-059](adr/ADR-059.md) §2.2 在既有「不能物理删除」之上追加禁止软删除）；`If-Match`（模块 `row_version`）不符 409 `MODULE_VERSION_CONFLICT`；模块下仍有活跃聚合组主任务 409 `TASK_GROUP_MAIN_LOCKED`（给出任务 ID 清单）；要求同源 / CSRF、数据库幂等；`reason` 可空 1～10000 字符，空白回落「模块已被删除」；**软删除**（`deleted_at` / `deleted_by` + `row_version` +1），级联软删除模块内全部功能与任务，不物理删除任何业务历史；重放由 `moduleDeleteReplayAuthorizer` 复核当前认证与实时 `scopeDeleterRole`，模块已软删除不使合法重放变成 404 |

全部写接口重放前重查当前 Session/CSRF、原操作权限和结果模块可读权限。项目、模块与功能自 ADR-043 / ADR-044 / ADR-045 起都不再有归档只读态，不存在「父级已归档」的写入或重放拒绝；这些状态门禁不作用于普通 GET。

| 操作 | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 额外条件 |
|---|---:|---:|---:|---:|---:|---:|---|
| 读取当前用户 | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 服务端从 `__Host-session` 解析身份，不接受客户端传入用户 ID；响应 `no-store` |
| 读取用户目录（`getUserDirectory` · `GET /api/v1/users`） | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 服务端从 Session 解析身份；返回 `id`、`name`、`avatarUrl`、`isAdmin` 与组织归属（`organizationId` / `organizationName`，未分配为 `null`；ADR-081），不返回登录名、邮箱、密码哈希或停用状态；只返回 ACTIVE 且 `disabled_at IS NULL` 的用户，最多 300 条；响应 `no-store`；新建项目「项目成员」选择器按组织分组并支持整组勾选 |
| 创建项目（`createProject` · `POST /api/v1/projects`） | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 请求者自动成为活跃成员且创建时不可取消；请求头需同步 CSRF，正文 `memberIds` 为可选项目成员且不含创建者，服务端在单事务内校验全员 ACTIVE 并写审计、搜索/活动投影与通知；要求 `Idempotency-Key`，重放前需重新验证当前认证与项目可读权限；成功返回 200；`code` 显式提供时须符合 `^[A-Z][A-Z0-9_]{1,31}$`，未提供时由服务端从名称派生 |
| 项目列表（`listProjects` · `GET /api/v1/projects`）与项目详情（`getProject` · `GET /api/v1/projects/{projectId}`） | 401 | 列表返回本人全部活跃项目，详情按资源允许 | 列表只返回本人活跃项目，详情 404 | 列表只返回本人其他活跃项目，已移除项目不返回，详情 404 | 401 | 列表与详情均返回全部项目 | 服务端从 Session 解析 actor 并先取得 `AuthorizedProjectScope`，SQL 前限制项目范围，不接受客户端传入范围；无权限与不存在统一 404；历史数据仍可读；响应 `no-store`；`projectId` 非法时 422 |
| 编辑项目（`updateProject` · `PATCH /api/v1/projects/{projectId}`） | 401 | 允许 | 404 | 404 | 401 | 允许 | 项目编码创建后不可修改，只允许整笔替换 `name` 与 `description`；项目三态下都可写（ADR-043 起项目已无归档态）；CSRF 与 `Idempotency-Key` 必填、`If-Match` 乐观锁（版本冲突 409）；名称/描述、审计 `project.update`、活动与搜索投影同一事务；重放前重新验证当前成员关系与项目可写性 |
| 变更项目状态（`changeProjectStatus` · `PATCH /api/v1/projects/{projectId}/status`） | 401 | 403 | 404 | 404 | 401 | 允许 | ADR-039/ADR-043：本项目任意活跃成员或系统管理员可把项目在未开始 / 进行中 / 维护中之间切换（三态即全部状态，归档已下线），非成员或跨项目 404；请求体只收三个目标态（ARCHIVED 422 `PROJECT_VALIDATION_FAILED`）；版本不符 409 `PROJECT_VERSION_CONFLICT`，进入维护中且项目下仍有未收尾任务（`lifecycle_status = 'ACTIVE'` 且 `work_status NOT IN ('DONE','CANCELED')`）409 `PROJECT_MAINTENANCE_TASKS_OPEN`，目标与当前状态相同 409 `PROJECT_STATE_CONFLICT`；未开始与维护中禁止直接互改 409 `PROJECT_STATUS_LEVEL_SKIP`，项目内出现过已完成任务后不可回退未开始 409 `PROJECT_STATUS_NOT_STARTED_LOCKED`；CSRF、`Idempotency-Key` 与 `If-Match` 必填；只有「未开始 → 进行中」通知全体活跃成员，维护中不通知；审计 `project.status.change`、活动与搜索投影在同一事务提交；重放前重新验证当前成员关系与项目可读权限 |
| 删除项目（`deleteProject` · `DELETE /api/v1/projects/{projectId}`） | 401 | 403 | 404 | 404 | 401 | 允许 | [ADR-062](adr/ADR-062.md)（项目审计链保留口径由 [ADR-085](adr/ADR-085.md) 修订；替代 ADR-049 / ADR-050 / ADR-051 / ADR-052 / ADR-055 的项目删除链路）：只有系统管理员与本项目 ACTIVE 组长（实时成员关系，不缓存进 Session）可以删除，普通成员与项目管理员一律 403 `PROJECT_DELETE_FORBIDDEN`，非成员、已移除成员与不存在统一 404 `PROJECT_NOT_FOUND`（不泄露存在性）。删除是**不可逆的物理删除**：单一事务内经 `app.purge_project(integer)`（`SECURITY DEFINER` 窄口，运行时角色没有逐表 `DELETE` 权限）按外键序清空该项目的业务数据（模块、功能、任务、任务组、迭代记录、遗留项、全部关联表、通知、动态与搜索投影、`code_sequences`、`project_members`、外部链接）后再删 `projects` 行（非 1 行即整体失败）；项目自己的 `PROJECT:<id>` 审计日志与链头按 ADR-085 保留，形成只读历史；函数内 `fail closed` 拒绝不存在的项目，未分类模块的禁删触发器仅在同一事务的 `app.purge_project_id` 豁免下放行；项目编码随之释放，可被新建项目复用。请求无正文（204），CSRF、`Idempotency-Key` 与 `If-Match` 必填，版本不符 409 `PROJECT_VERSION_CONFLICT`；**不写项目动态、不发通知**，SYSTEM 审计链新增一条 `project.delete`（操作者与角色、项目编码与名称、状态、`rowVersion`、逐项删除行数与 `retainedAuditLogs`）记录本次操作，且只对系统管理员可见（`getAuditLogs` 的 `adminSession` 策略不变）；重放只复核当前认证（项目行已不存在，项目审计链保留但不参与资源级复核，任何资源级复核都会把合法重放变成 404，故 `replayAuthorizationPolicy` 为 `actorOnly`），幂等记录按操作者隔离 |
| 读取项目及下级资源 | 401 | 允许 | 404 | 404 | 401 | 允许 | 资源型接口隐藏存在性；归档数据仍可读；VOID 记录按下一行 |
| 读取 VOID 迭代记录详情 | 401 | 404 | 404 | 404 | 401 | 允许 | `status` 是可见性真相；恢复为 PUBLISHED 后活跃成员重新可读 |
| 新建或编辑模块、功能、任务、记录、链接 | 401 | 允许 | 404 | 404 | 401 | 允许 | 父级模块 / 功能可写（ADR-043，项目无归档态）；写接口默认幂等；未分类模块允许编辑名称、描述，kind 不变，不能物理删除（2026-09-09 人工确认；F-12 已本地实现，真库验收待运行）；[ADR-059](adr/ADR-059.md) 在此基础上追加：未分类模块也不能**软删除**（`deleteModule` 一律 409 `MODULE_UNCLASSIFIED_PROTECTED`，前端同样不渲染删除入口） |
| 删除模块（`deleteModule` · `POST /api/v1/projects/{projectId}/modules/{moduleId}/delete`）与删除功能（`deleteFeature` · `POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/delete`） | 401 | **仅本项目 ACTIVE 组长**（普通成员与项目管理员 403） | 404 | 404 | 401 | 允许 | [ADR-059](adr/ADR-059.md)：在本项目内**只**对系统管理员与组长开放（ADR-039 第五处例外），服务端按实时成员关系判定、不缓存进 Session；两者都是**软删除**（`deleted_at` / `deleted_by` + `row_version` +1），不提供还原入口，也不物理删除任何业务历史；级联删除所含功能与任务（任务逐条复用 ADR-058 的全部副作用链：解除 GitHub 链接关联、作废其已发布记录、处理聚合组、审计、动态、搜索投影），功能与模块自身再补软删除、外部链接解除、范围内记录作废与投影移除；存在活跃聚合组主任务时整体 409 `TASK_GROUP_MAIN_LOCKED` 且事务整体回滚；`If-Match` 与 `Idempotency-Key` 必填；同事务写审计 `module.delete` / `feature.delete`（模块级联会为每个被删功能单独写一条 `feature.delete`）与动态 `MODULE_DELETED` / `FEATURE_DELETED`（`MEMBER` 可见）；**不发通知** |
| 任务完成、重新打开、取消、恢复、合并、解除，遗留转任务 | 401 | 允许 | 404 | 404 | 401 | 允许 | 状态机、If-Match 与幂等约束 |
| 搜索（`getSearch` · `GET /api/v1/search`） | 401 | 仅本人活跃项目 | 不返回本项目（可搜索其他活跃成员项目） | 不返回本项目（可搜索其他活跃成员项目） | 401 | 按服务端 Scope | SQL 前强制 AuthorizedProjectScope；`q` 最短 2、最长 200，`limit` 1～50、默认 20，`q`/`limit`/`cursor` 字段校验失败统一返回 422；`cursor` 为服务端 HMAC 签名、校验并带过期时间的不透明字符串，绑定当前用户与规范化查询，TTL 15 分钟，A 已于 2026-09-08 正式确认；VOID 默认不返回，仅系统管理员显式传 `includeVoid=true` 时可见，普通成员传该参数也不会扩大范围；`app_runtime` 只允许 `app` schema USAGE、业务事务内对 `search_projection` 执行 `SELECT/INSERT/UPDATE`、查询 `search_projection` 及执行 `pgroonga_query_escape`/`&@~` 所需函数，不允许 `DELETE`、DDL 或管理函数；`LEFTOVER`（遗留问题）投影由父记录发布/修订/作废/恢复与遗留项转任务在同一事务维护，其可见性与状态跟随父记录与遗留项，不单独放宽授权 |
| 查看项目动态（`getProjectActivity` · `GET /api/v1/projects/{projectId}/activity`） | 401 | 允许 | 404 | 404 | 401 | 允许（默认 MEMBER；显式 `includeAdminOnly=true` 时可见 ADMIN_ONLY） | SQL 前强制服务端 `AuthorizedProjectScope`，不接受客户端传入授权范围；`projectId`、`limit`、`cursor`、`category` 校验失败统一 422；`cursor` 为服务端 HMAC 签名、绑定当前用户、项目与分类筛选、带过期时间的不透明字符串；普通成员传 `includeAdminOnly=true` 不扩大范围；`category`（`all`/`task`/`record`/`feature`/`module`/`project`/`member`/`github`）在 SQL 层按 `activityType` / `sourceEntityType` 过滤；`dayTotals` 按 Asia/Shanghai 自然日给出范围内全量总数（与当前 `includeAdminOnly`、`category` 同口径），不随分页增长；响应只暴露脱敏白名单字段；项目物理删除后不再产生任何动态（[ADR-062](adr/ADR-062.md) 起项目删除是物理删除，原 ADR-050 / ADR-052 的「已删除项目链对全部登录用户可见」例外随之下线），「不存在」「无权访问」「已移除成员」仍是 404 |
| 聚合动态（`listActivity` · `GET /api/v1/activity`） | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 跨项目聚合只读：服务端按实时 `AuthorizedProjectScope` 在单一结果集上按 `occurred_at DESC, id DESC` 全局游标分页——「加载更多」只会追加更早的条目，不会把新条目插入已展示的时间段；`projectIds`（逗号分隔的 1～100 个正整数，数量、格式或重复校验失败统一 422）只用于收窄，越权或未知项目静默排除，不返回 403 / 404；`category` 在 SQL 层过滤，未知取值 422；`includeAdminOnly` 只对系统管理员在本人的活跃成员项目扩大 ADMIN_ONLY；`dayTotals` 按 Asia/Shanghai 自然日给出范围内**全量**总数（与当前 `projectIds` / `category` / `includeAdminOnly` 同口径），不随分页增长，`dayTotalsTruncated` 为真时只覆盖最近 400 个自然日；`limit` 1～50、默认 20；游标为服务端 HMAC 签名、绑定当前用户、范围参数、分类与 `includeAdminOnly` 有效值，TTL 15 分钟；响应 `no-store` |
| 任务聚合组视图（`getTaskGroup` · `GET /api/v1/task-groups/{groupId}`） | 401 | 允许 | 404 | 404 | 401 | 允许 | 先按 `groupId` 反查项目归属，再按实时成员关系授权；非成员与不存在统一 404；返回组与全部成员（含已解除成员）及每任务 PUBLISHED 记录数，不返回审计快照；记录列表见下一行 |
| 任务聚合组记录（`listTaskGroupRecords` · `GET /api/v1/task-groups/{groupId}/records`） | 401 | 允许 | 404 | 404 | 401 | 允许 | 只返回 PUBLISHED 与 VOID（DRAFT 不可见）；`memberTaskId`/`limit`/`cursor` 校验失败统一 422；游标为服务端 HMAC 签名、绑定当前用户、聚合组与筛选，TTL 15 分钟；链接标题与状态为关联时刻快照，不得用于实时状态判断 |
| 项目概览（`getProjectOverview` · `GET /api/v1/projects/{projectId}/overview`） | 401 | 允许 | 404 | 404 | 401 | 允许 | 服务端聚合活跃模块、活跃功能、未完成任务、迭代记录数、最近迭代与待处理遗留问题；统计口径按功能设计 §29（历史来源分支不计入未完成、模块级记录不按影响功能去重、版本不增加记录数）；`recentRecordLimit`/`activeLeftoverLimit` 默认 3/2、上限 10，越界 422；`activeLeftoverTotal` 与 `activeLeftovers` 同一过滤（`status = 'ACTIVE'`）且不受 `activeLeftoverLimit` 影响；遗留行附来源记录当前标题 `recordTitle`（1～500，与 `recordCode` 并存） |
| 任务看板（`getProjectTaskBoard` · `GET /api/v1/projects/{projectId}/task-board`） | 401 | 允许 | 404 | 404 | 401 | 允许 | 只读聚合：SQL 前强制服务端 `AuthorizedProjectScope`，非成员与项目不存在统一 404；看板集合为项目内 `lifecycle_status = 'ACTIVE'` 任务并排除任务组历史来源分支，已取消任务保留为历史标记；完成率 = 已完成 ÷（已完成 + 未完成），已取消不计入分母；逾期、今日到期、本周完成与卡片 `dueState` 全部由 SQL 按 Asia/Shanghai 计算；单项目任务上限 1000 条，超出时 `truncated = true` 且顶部与泳道统计仍为全量口径；泳道头像最多 24 个 |
| 我的任务（`listMyTasks` · `GET /api/v1/me/tasks`） | 401 | 仅本人 | 仅本人 | 仅本人 | 401 | 仅本人 | 负责人固定为当前用户，拒绝客户端提交 `assigneeId`/`userId`/`projectIds`；SQL 前强制 AuthorizedProjectScope；`limit` 1～100、默认 20；游标为服务端 HMAC 签名、绑定当前用户与筛选条件，TTL 15 分钟；`hasPublishedRecord` 与分页在同一条 SQL 内先过滤后分页；V1 筛选为 `projectId`/`scopeType`/`workStatus`/`hasPublishedRecord`/`priority`/`includeCanceled`/`todayTodo`（`priority` 与 `workStatus` 正交；`includeCanceled` 缺省 false，与 `workStatus` 组合表达 `TODO ∪ CANCELED`；`todayTodo` 只表达「未完成且命中 逾期 ∪ 遗留来源（`leftover_task_links` 存在链接）∪ 标记紧急（`priority = 'URGENT'`）∪ 距截止 7 个日历日内 之一」，与服务端统计卡同口径）；条目含 `priority`/`dueAt`/`completedAt`/`creatorId`/`githubLinkCount`/`publishedRecordCount`（与 `hasPublishedRecord` 同源同口径，裁决修订 D-1）/`groupId`/`hasLeftoverSource`（按 `leftover_task_links` 存在链接行判定，与来源记录当前状态无关，裁决修订 D-2）（列表不返回 `description`）；响应附 `stats`（`todayTodo`/`todayTodoBreakdown`（`overdue`/`leftover`/`urgent`/`dueWithinDays`，四项各自独立计数、可以重叠，其并集即 `todayTodo`）/`myOpen`/`completed`/`created`；前三项按负责人维度、`created` 按创建人维度（2026-09-20 口径），日界按 Asia/Shanghai 由服务端计算）、`leftoverCount` 与 `leftoverSample`（最新 ACTIVE 遗留，summary 前 200 字符、超长追加 “…”），统计基准集合不受分页与游标影响 |
| 遗留问题列表（`listLeftoverItems` · `GET /api/v1/leftover-items`） | 401 | 仅本人活跃项目 | 不返回本项目（可读其他活跃成员项目） | 不返回本项目（可读其他活跃成员项目） | 401 | 按服务端 Scope | 跨项目按服务端 `AuthorizedProjectScope` 汇总可见记录（PUBLISHED / VOID）的稳定遗留项；`bucket` 只切换 OPEN（ACTIVE）与 CLOSED（CONVERTED / RESOLVED）展示分桶，不改变 `leftoverItemId DESC` 排序；内容取最新版本快照，来源任务与跟进任务只返回任务引用，不复制任务实体；`limit` 1～100、默认 20，`projectId` 只收窄范围；游标为服务端 HMAC 签名、绑定当前用户与筛选，TTL 15 分钟；非成员与不存在不返回 404 而是空页（与 `listMyTasks` 同族），字段校验失败统一 422 |
| 聚合组列表（`listTaskGroups` · `GET /api/v1/task-groups`） | 401 | 仅本人活跃项目 | 不返回本项目（可读其他活跃成员项目） | 不返回本项目（可读其他活跃成员项目） | 401 | 按服务端 Scope | 跨项目按服务端 `AuthorizedProjectScope` 列出聚合组与当前生效（ACTIVE）分支，已解除成员不进入摘要；主任务在前、来源任务按加入顺序；`groupRole`/`sourceKind`/`workStatus` 返回原始枚举由前端映射文案；`limit` 1～100、默认 20，`projectId` 只收窄范围；游标为服务端 HMAC 签名、绑定当前用户与筛选，TTL 15 分钟；非成员与不存在不返回 404 而是空页，字段校验失败统一 422 |
| 任务记录标记批量读（`listTaskGroupMemberships` · `GET /api/v1/task-groups/memberships`） | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 只读批量查询（裁决修订 D-1）；`taskIds` 为逗号分隔的 1～100 个正整数，数量、格式或重复校验失败统一 422；请求中每一个有权 taskId 都出现，未加入 `ACTIVE` 聚合组（含已解除）的任务以 `groupId`/`groupRole` 为 null 返回且 `publishedRecordCount` 照常（与 R-1/R-3 同口径、无记录为 0）；`hasLeftoverSource` 与 R-3 同源同口径（按 `leftover_task_links` 存在链接行判定，裁决修订 D-2）；无权、不存在（含跨项目）不出现、不泄露存在性（无 404）；不要求 CSRF 或幂等键 |
| 跨项目记录清单（`listRecordFeed` · `GET /api/v1/change-records`） | 401 | 仅本人活跃项目 | 不返回本项目（可读其他活跃成员项目） | 不返回本项目（可读其他活跃成员项目） | 401 | 按服务端 Scope（可显式读 VOID） | 跨项目按服务端 `AuthorizedProjectScope` 汇总可见正式记录（PUBLISHED / VOID），`projectId` 只收窄范围，非成员项目不返回 404 而是空页（与 `listLeftoverItems`/`listTaskGroups` 同族）；`status` 为 PUBLISHED / VOID / ALL，非系统管理员请求 VOID 或 ALL 时收敛为只返回 PUBLISHED 行（不返回 403，也不泄露其他项目是否存在作废记录）；`source` 为 ALL / MAIN / SOURCE / MODULE / FEATURE（MAIN = 未入聚合组任务与聚合组主任务，SOURCE = ACTIVE 聚合组来源任务，MODULE = 无任务模块级记录，FEATURE = 无任务功能级记录）；`q` 走 CHANGE_RECORD 全文投影（PGroonga），最短 2、最长 200，归一化后不足 2 字返回 422；服务端批量回填项目 / 模块 / 功能名与作者引用（不含登录名与邮箱）；固定 `published_at DESC, id DESC` 排序，`limit` 1～100、默认 20，游标为服务端 HMAC 签名、绑定 actor / 命名空间 / `projectId`（null = 全部项目），TTL 15 分钟；不要求 CSRF 或幂等键 |
| 迭代总结（`getRecordSummary` · `GET /api/v1/change-records/summary`） | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 只读聚合：SQL 前强制服务端 `AuthorizedProjectScope`，`projectId` / `memberId` 只收窄范围，越权项目与非成员项目静默排除（空结果，不返回 403 / 404，与 `listRecordFeed` / `listLeftoverItems` / `listTaskGroups` 同族）；`from` / `to` 为 Asia/Shanghai 自然日（含首尾），服务端在 SQL 内换算成 `[from 00:00, to 次日 00:00)` 半开区间，不用进程时区；起止倒置、跨度超过 400 个自然日、日期格式或 `groupBy` 非法统一 422；服务端只返回事实（范围内 PUBLISHED 正式记录、未失效的已完成任务、遗留问题与「已完成但范围内没有任何记录」的缺口，外加计数），分节标题与正文措辞由客户端按事实派生；不返回草稿与 VOID 记录；不要求 CSRF 或幂等键 |
| 我的草稿（`listMyRecordDrafts` · `GET /api/v1/me/record-drafts`） | 401 | 仅本人 | 仅本人 | 仅本人 | 401 | 仅本人 | 作者恒为当前 actor，拒绝客户端提交 `authorId`/`userId`/`projectIds` 等他人身份或授权范围参数；SQL 前强制 AuthorizedProjectScope，被移出项目后其草稿立即不可见（不返回 404 而是空页）；只返回 DRAFT，未发布不建搜索投影，故不接受 `q`；`limit` 1～100、默认 20，游标为服务端 HMAC 签名、绑定 actor 与命名空间，TTL 15 分钟；字段校验失败统一 422；不要求 CSRF 或幂等键 |
| 通知列表、未读数、单条已读/未读、全部已读（`getNotifications`、`getNotificationUnreadCount`、`readNotification`、`unreadNotification`、`readAllNotifications`） | 401 | 仅本人 | 仅本人 | 仅本人 | 401 | 仅本人 | 服务端始终从 Session 解析收件人，不接受客户端传入 `recipientId`；查询按 `recipient_id = 当前用户` 过滤；单条不存在或非本人统一 404，管理员也不得代读其他用户；三个 POST 均要求 CSRF 与 `Idempotency-Key`，重复执行可安全重放 |
| `listProjectMembers` · `GET /api/v1/projects/{projectId}/members` | 401 | 任意活跃成员（ADR-039） | 404 | 404 | 401 | 允许 | 完整管理员 Session 或本项目 LEADER/PROJECT_ADMIN 的认证 Session；返回项目成员完整历史（含 REMOVED）与脱敏 `name/avatarUrl/role`，不返回登录名/邮箱；不要求 CSRF 或幂等键；项目不存在或无权限统一 404；响应 `no-store` |
| `listProjectMemberUnfinishedTasks` · `GET /api/v1/projects/{projectId}/members/{userId}/unfinished-tasks` | 401 | 条件允许（同上） | 404 | 404 | 401 | 允许 | 同上；目标必须为 ACTIVE 成员，不存在、已移除或无权限统一 404；只返回当前 TODO 且 ACTIVE 的真实任务，提供改派所需 `rowVersion/moduleId/featureId` |
| `addProjectMember` · `POST /api/v1/projects/{projectId}/members` | 401 | 任意活跃成员（ADR-039） | 404 | 404 | 401 | 允许 | 目标用户必须 ACTIVE；CSRF 与 `Idempotency-Key` 必填；新成员通常 `role='MEMBER'`，仅当项目当前无活跃组长时首位加入者直接写入 `role='LEADER'`（历史数据/夹具清理后的项目，[ADR-053](adr/ADR-053.md)）；成员添加、审计、活动与通知在同一事务提交；重复活跃成员 409，停用/不存在用户 422；重放前重新验证当前认证、项目可写、成员资源与操作者仍为项目活跃成员 |
| `removeProjectMember` · `POST /api/v1/projects/{projectId}/members/{userId}/remove` | 401 | 任意活跃成员（ADR-039；目标为本项目 LEADER 时 409，[ADR-053](adr/ADR-053.md)：必须先指定其他成员为组长完成转移） | 404 | 404 | 401 | 允许（目标为本项目 LEADER 时同样 409） | 目标必须为 ACTIVE 成员；CSRF 与 `Idempotency-Key` 必填；组长不可被移除（含系统管理员），移除前必须先把组长身份转交其他活跃成员（转移后原组长降级为 MEMBER 才可移除）；「最后一名成员不可移除」由「唯一成员必然是组长」+ ADR-053 隐含，不另设错误码；可提交真实任务改派（每项可同时指定一位或多位接手成员，改派只摘掉该成员、同一任务的其他负责人不变；仅当被移除成员是唯一负责人时由所选接手成员顶上，[ADR-040](adr/ADR-040.md)），未改派任务保留原负责人但成员立即失去处理权限与角色（REMOVED 行 role 回落 MEMBER）；任务改派、成员移除、审计与活动同一事务；`created_by` 不变；重放前重新验证当前认证、项目可写、成员资源与操作者角色 |
| `setProjectMemberRole` · `POST /api/v1/projects/{projectId}/members/{userId}/role` | 401 | 系统管理员或本项目组长（[ADR-053](adr/ADR-053.md)：组长只能把身份转交给其他活跃成员；普通成员与组长自设一律 403 `PROJECT_MEMBER_ROLE_FORBIDDEN`） | 404 | 404 | 401 | 允许（可设 LEADER 转移组长；系统管理员也可把非组长成员设为 MEMBER） | ADR-033/ADR-039/ADR-053 组长转移（撤销已取消：把 ACTIVE LEADER 改为 `MEMBER` 返回 409 `PROJECT_MEMBER_LEADER_REQUIRED`）；目标必须为 ACTIVE 成员；CSRF 与 `Idempotency-Key` 必填；LEADER 唯一性由部分唯一索引与延迟约束共同保证，冲突 409 `PROJECT_MEMBER_LEADER_CONFLICT`；`idempotencyContractVersion` 升 `2.2.0`；审计 `project.member.role.set`、活动同事务；重放前重新验证当前认证、项目可写、成员资源与操作者角色 |
| 原始审计读取（`getAuditLogs` · `GET /api/v1/audit-logs`） | 401 | 403 | 403 | 403 | 401 | 允许（完整管理员 Session；只读，不要求 CSRF 或幂等键） | 读取范围三选一（[ADR-061](adr/ADR-061.md)）：不传 `projectId` 与 `chain` 读 SYSTEM 链、传 `projectId=<id>` 读 `PROJECT:<id>` 链、新增 `chain=all` 读全部链并按 `occurred_at DESC, chain_id DESC, sequence_no DESC` 跨链键集分页（`chain` 与 `projectId` 互斥，同传 422 `invalid-chain`，其余取值 Schema 层 422）；不接受客户端伪造归属，跨链读取不新增授权（管理员一次读其本就有权读的全部链）；查询经独立只读 `audit_reader` 连接（`AUDIT_DB_*` / `AUDIT_DATABASE_URL(_FILE)`，缺失、路径越界或权限不合规在首次读取 fail closed），不与业务连接共用；读取不写审计（[ADR-060](adr/ADR-060.md) 替代 [ADR-042](adr/ADR-042.md)）：读取、筛选、重置、重试、分页与切换审计对象都不产生 `AUDIT_LOG_READ`，历史留痕行保留在审计链中并按普通审计行可读；`cursor` 为服务端 HMAC 签名、绑定操作者与查询指纹，TTL 15 分钟，跨查询/过期/非法 422，跨链分页的游标另带成对链坐标（`c`/`t`），把单链游标拿到 `chain=all` 下继续翻页同样 422（不猜测、不回退首页）；`from`/`to` 为半开区间且必须带时区；`limit` 默认 50、最大 100；响应 `no-store`；批量导出与远端 WORM 归档由 `apps/ops` 归档进程交付（`audit_archive_writer` 只读审计与链头、WORM 凭据只允许新建对象；见[审计归档 Runbook](./runbooks/audit-archive.md)） |
| 作废 PUBLISHED / 恢复 VOID 迭代记录 | 401 | 403 | 403 | 403 | 401 | 允许 | 填写原因；写审计 |
| `listAdminUsers` · `GET /api/v1/admin/users` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整系统管理员 Session；读取全部账号的登录名、姓名、邮箱、头像、管理员角色、状态、未完成任务数、版本与时间，不返回密码哈希等认证材料；最多 1000 条；响应 `no-store`；不需要 CSRF 或幂等键 |
| `createUser` · `POST /api/v1/admin/users` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session；CSRF 与 `Idempotency-Key` 必填；Argon2id 哈希在事务外生成、业务与审计同事务写入；登录名/邮箱唯一冲突 409；响应不返回密码或认证材料 |
| `updateUser` · `PATCH /api/v1/admin/users/{userId}` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session；CSRF、`Idempotency-Key` 与 `If-Match` 必填；登录名不可修改，字段缺省保持不变，`email/avatarUrl` 为 null 表示清空；版本/状态冲突 409；禁止取消自己的管理员角色；移除 ACTIVE 管理员前按 id 升序锁定全部活跃管理员，剩余可用管理员数必须大于 1，否则 409；审计 `admin.user.update` |
| `disableUser` · `POST /api/v1/admin/users/{userId}/disable` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session；CSRF、`Idempotency-Key` 与 `If-Match` 必填；目标不存在 404、已停用或版本冲突 409；禁止停用自己；停用 ACTIVE 管理员时执行最后一名可用管理员保护；有未完成任务时返回 409 `ADMIN_USER_HAS_OPEN_TASKS`，`details.openTaskCount` 给出数量且不撤销会话、不改状态；同事务置 `DISABLED`/`disabled_at`、递增 `auth_version` 与 `row_version`、撤销全部 Session 并写审计；停用后目标所有受保护请求 401 |
| `enableUser` · `POST /api/v1/admin/users/{userId}/enable` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session；CSRF、`Idempotency-Key` 与 `If-Match` 必填；目标不存在 404、已启用或版本冲突 409；同事务清除停用态并递增 `row_version`、写审计；不恢复已撤销 Session 或登录限流历史 |
| `deleteUser` · `POST /api/v1/admin/users/{userId}/delete` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session；CSRF、`Idempotency-Key` 与 `If-Match` 必填；目标必须已停用、尚未墓碑化且无任何 ACTIVE 项目成员关系；禁止删除自己；同事务墓碑化账号（`deleted_at`、固定登录名与姓名、清除邮箱/头像/口令/组织/管理员身份）、递增 `auth_version` 与 `row_version`、撤销全部 Session、改写动态姓名并写 `admin.user.delete` 审计；已删除账号不可登录、启用、编辑或再次删除 |

## F-14 功能级任务接口（2026-09-09 本地实现）

F-14 功能级任务补充：`listTasks`、`getTask`、`listTaskAssignees`、`createTask`、`updateTask` 允许当前活跃项目成员与系统管理员，匿名/停用 401，非成员/已移除/归属错误 404；写接口须功能 ACTIVE（ADR-043 起项目无归档态、ADR-044 起模块无归档态），编辑还须任务生命周期为 `ACTIVE`（[ADR-054](adr/ADR-054.md) 起只有 `ACTIVE` 与 `INVALID` 两种取值，归档已下线，没有任何命令能写入），CSRF/数据库幂等，更新 If-Match。请求以 `assigneeIds`（1～20 人，服务端去重升序）提交；创建/真正新增指派须所选用户 ACTIVE 且为项目 ACTIVE 成员（管理员也不能例外），空集合、非项目活跃成员或超过 20 人 422 `TASK_ASSIGNEE_INVALID`；未改变的历史负责人允许保留，改派只替换被更换的人、其余负责人不变（[ADR-040](adr/ADR-040.md)）。重放重新验证当前资源权限与父级可写性，失败不返回已存成功内容。成员列表在同一事务内自行验证当前 actor 的项目访问，只暴露本项目活跃用户的 id/name/avatarUrl。实现与实际验证见 [F-14 交审](f14-local-handoff.md)。

## F-13 功能档案接口（2026-09-09 本地实现）

| operationId | 允许身份 | 拒绝与附加门禁 |
|---|---|---|
| listFeatures | 活跃项目成员、系统管理员 | 匿名/停用 401；非成员、已移除、模块归属错误 404；ADR-045 起功能无归档态，不再按状态过滤 |
| getFeature | 活跃项目成员、系统管理员 | 同上，项目/模块/功能完整归属不符 404 |
| findSimilarFeatures | 活跃项目成员、系统管理员 | 同上；SQL 在 LIMIT 前限制当前项目 FEATURE + MEMBER 投影；提示不阻止同名创建 |
| createFeature | 活跃项目成员、系统管理员 | 项目与模块存在且归属正确（ADR-043 起项目、ADR-044 起模块都无归档态）；Session、CSRF、同源和幂等 Key；只接受 name/currentBehavior/tags |
| updateFeature | 活跃项目成员、系统管理员 | 同上且功能存在（ADR-045 起功能只有 ACTIVE），If-Match；说明前后审计，不生成迭代记录 |
| deleteFeature | **仅系统管理员或本项目 ACTIVE 组长（LEADER）**（[ADR-059](adr/ADR-059.md)，ADR-039 下放的第五处例外） | 匿名/停用 401；非成员、已移除成员与不存在统一 404 `FEATURE_NOT_FOUND`（不泄露存在性）；普通成员与项目管理员 403 `FEATURE_DELETE_FORBIDDEN`；`If-Match`（功能 `row_version`）不符 409 `FEATURE_VERSION_CONFLICT`；功能下仍有活跃聚合组主任务 409 `TASK_GROUP_MAIN_LOCKED`；要求同源 / CSRF、数据库幂等；`reason` 可空 1～10000 字符，空白回落「功能已被删除」；**软删除**（`deleted_at` / `deleted_by` + `row_version` +1），级联软删除该功能下全部任务与该功能范围内的迭代记录（模块级记录不属该功能范围），不物理删除任何业务历史；重放由 `featureDeleteReplayAuthorizer` 复核当前认证与实时 `scopeDeleterRole`，功能已软删除不使合法重放变成 404 |

功能删除与模块删除由 [ADR-059](adr/ADR-059.md) 新增；两者不新增数据库表级 `DELETE` 权限，也不改任何既有授权口径。

两条写接口重放前重查 Session/CSRF、当前项目授权与完整结果归属；项目、模块或功能归属不存在时拒绝重放（ADR-043 起项目、ADR-044 起模块、ADR-045 起功能都无归档态，不再有存留的归档路由身份复核）。重复状态操作可重放原成功结果，不重复执行状态迁移。所有拒绝返回统一错误体，不泄露已存响应。真实测试入口见 [F-13 交审说明](f13-local-handoff.md)。

## 强制规则

1. 成员关系在每次请求中实时读取，不缓存到 Session 或长生命周期对象。
2. 资源型接口对“不存在”和“无项目权限”统一返回 404；明确的全局管理接口返回 403。
3. 停用用户的 Session 统一视为无效：所有受保护或业务路由返回 401，使用停用凭据登录也返回 401。仅 `issueCsrfToken` 与无效/已撤销 Session 的 `logout` 按匿名安全例外执行，前者只能创建无身份的预认证状态，后者只清 Cookie 且不写业务状态。
4. Controller 不接受客户端传入的授权 Scope；Scope 由 `ProjectAccessQueryPort` 在服务端计算并进入 SQL 谓词。
5. 所有非安全写方法的幂等默认值遵循 [ADR-019](adr/ADR-019.md)。
6. `securityFlow` 的 operationId、身份、challenge 前置状态与恢复路径必须同时符合本矩阵和 [ADR-023](adr/ADR-023.md)，不得通过改名或泛化“登录”绕过逐操作覆盖；`login` 只接受匿名预认证状态，不支持认证 Session 内重新登录。
7. 迭代记录的详情、统计、搜索和时间线必须以 `status` 判定可见性，不得以保留的 `voided_at` 推断当前状态。
8. 更改本矩阵需要同步 Route Registry、测试矩阵、相关设计与 ADR。
9. `app_runtime` 搜索数据库权限按最小集显式授予，不得依赖 PUBLIC；业务事务内仅允许维护 `search_projection` 的 `INSERT/UPDATE`（无 `DELETE`/DDL），普通查询只允许 `normalized_search_text &@~ app.pgroonga_query_escape($1)`。

## F-15 模块级任务接口（2026-09-09）

listModuleTasks/getModuleTask/listModuleTaskAssignees/createModuleTask/updateModuleTask允许当前项目活跃成员和系统管理员；匿名/停用401、非成员/移除/真实归属错误404。写操作要求项目可写、模块存在且归属正确、任务生命周期可写，编辑If-Match，全部写CSRF+数据库幂等；负责人沿用F14真实项目成员规则。新增影响必须ACTIVE同项目同模块，保留/移除既有归档影响合法，影响功能不是MODULE任务父级。原功能页listTasks可读模块引用，只有其真实模块路径提供修改入口；归档功能页不开放引用编辑。模块幂等重放检查任务以及响应全部影响功能的当前可读归属。见 [F15交审](f15-local-handoff.md)。


## F-16 任务状态和历史接口（2026-09-10）

transitionTask/transitionModuleTask/getTaskStatusHistory/getModuleTaskStatusHistory 允许当前项目活跃成员及系统管理员；匿名/停用401、无成员权限或错误真实归属404。写入要求父级可写、任务ACTIVE、合法状态迁移、CSRF、数据库幂等与If-Match；历史读取允许已归档父级。MODULE 已有归档影响关系可保留；功能引用页不直接执行模块命令。重放重新验证当前身份、权限、父级与已存结果影响资源。COMPLETE 服务端仅接受 WITHOUT_RECORD 六类原因，WITH_RECORD 返回422；取消/恢复不改变授权关系。见 [F16交审](f16-local-handoff.md)。

## F-17 迭代记录草稿接口（2026-09-10）

| operationId | 允许身份 | 附加门禁 |
| --- | --- | --- |
| listRecordDrafts / getRecordDraft | 当前活跃项目成员、系统管理员 | 匿名/停用 401；非成员、移除成员、错误真实归属 404；可读归档范围内 DRAFT；列表 `limit` 1～100、默认 20，`cursor` 为服务端 HMAC 签名、绑定 actor / 命名空间 / 项目、TTL 15 分钟，篡改 / 过期 / 跨项目 / 跨命名空间统一 422 `INVALID_CURSOR`，其余参数校验失败 422；详情读取不接受查询参数 |
| getTaskRecordDrafts | 同上 | 验证任务真实 project/module，返回来源身份和全部 DRAFT，不隐式选择或创建 |
| createIndependentRecordDraft | 同上 | 父级可写（ADR-043）；独立新选影响同项目同模块且 ACTIVE；处理人/作者为 actor；CSRF、同源、数据库幂等 |
| updateIndependentRecordDraft | 同上 | 父级可写，If-Match 为记录版本；有来源任务则拒绝并要求 Workflow；历史 MODULE 归档影响可保留 |
| createTaskRecordDraft | 同上 | 来源任务 ACTIVE、真实父级可写，If-Match 为任务版本；锁后派生标题/归属/负责人，允许同任务多草稿；CSRF、同源、数据库幂等 |
| updateTaskRecordDraft | 同上 | 同上但 If-Match 为记录版本；任务/记录完整同项目关联匹配，内容更新保留来源与记录快照 |
| deleteRecordDraft | 同上 | 只允许 `DRAFT`（[ADR-048](adr/ADR-048.md)）；独立与来源草稿共用；If-Match 为记录版本，不一致 409 `RECORD_VERSION_CONFLICT`；记录不存在、不是草稿、真实归属不匹配或父级不可写一律 404；CSRF、同源、数据库幂等；删除后同 Key 重放返回同一 200 结果 |

所有写接口成功重放前重新验证当前认证、CSRF、成员权限、真实可写父级和返回的全部影响资源；来源路径额外重读任务/记录关联。拒绝不泄露已存响应。TODO/DONE/CANCELED 均可保存来源草稿，保存不改变状态。无权限放宽、数据库权限或迁移变更。列表分页（B-1）返回 C-006 envelope（items/nextCursor/hasMore），按服务端固定 `created_at DESC,id DESC` keyset 排序；前端只按 `nextCursor` 追加，不得重排，也不得把游标跨项目或跨接口复用。见 [F-17 交审说明](f17-local-handoff.md)。 2026-09-28 追加：F-17 增加 `deleteRecordDraft`（草稿物理删除，[ADR-048](adr/ADR-048.md)），是本小节唯一放宽「无迁移/无数据库权限变更」的改动——迁移 `0026` 新增 `SECURITY DEFINER` 函数 `app.delete_change_record_draft` 并只授予 `app_runtime` `EXECUTE`，表级权限不放宽；删除只写审计 `record.draft.delete`，不写活动、通知与搜索投影。

## F-18 正式记录接口（2026-09-10）

| operationId | 允许主体 | 实时门禁及拒绝 |
| --- | --- | --- |
| listChangeRecords / getChangeRecord | 活跃项目成员、系统管理员 | 匿名/停用 401；非成员/撤权/跨项目 404；成员仅 PUBLISHED；管理员显式 VOID 列表及 VOID 详情，归档父级可读；列表 `limit` 1～100、默认 20，`cursor` 为服务端 HMAC 签名、绑定 actor / 命名空间 / 项目、TTL 15 分钟，篡改 / 过期 / 跨项目 / 跨命名空间统一 422 `INVALID_CURSOR`，其余参数校验失败 422；详情读取不接受查询参数 |
| listChangeRecordVersions / getChangeRecordVersion | 同上 | 真实项目及记录关系，版本属于该记录；普通成员 VOID 404，管理员可读全部版本；恢复以 status 为准 |
| publishChangeRecord | 同上 | 父级可写、记录 DRAFT、If-Match；来源为空或关联任务处于任意状态都可发布（[ADR-047](adr/ADR-047.md) 起完成状态不再是门禁），发布不改变任务状态；锁内归属变化 409 `RECORD_SCOPE_CONFLICT`；同源/CSRF、数据库幂等 |
| createChangeRecordVersion | 同上 | 父级可写、记录 PUBLISHED、If-Match 与 X-Record-Version；内容 DTO 禁止来源/身份/状态字段；ACTIVE 清空须明确确认；同源/CSRF、数据库幂等 |

三条 POST（发布、修订、追加遗留问题）重放重新验证当前身份、CSRF、实时权限、可写父级及结果记录/影响/遗留项归属（追加另需全部既有与新增 `leftovers[].id` 仍可读），拒绝不返回缓存结果。来源任务后续重开不取消已发布历史的修订/重放资格。发布通知去重后的作者/处理人/当前任务负责人/真实所属或影响功能创建者，修订通知原作者/当前任务负责人，逐人检查当前项目权限。无新增数据库角色或权限。列表分页（B-1）返回 C-006 envelope（items/nextCursor/hasMore），按 `published_at DESC,id DESC` keyset 排序，不改变可见性口径：无权限项目先按 404 收敛，再校验游标；VOID 列表仅管理员并复用同一游标绑定。见 [F-18 交审说明](f18-local-handoff.md)。

## F-23 任务合并接口（2026-09-10）

| operationId | 允许身份 | 附加门禁 |
| --- | --- | --- |
| mergeTaskGroup | 当前活跃项目成员、系统管理员 | 匿名/停用 401；非成员、移除成员、来源/主任务真实归属错误、跨项目或任务不存在 404；Session、CSRF、同源与数据库幂等 |

仅 `POST /api/v1/task-groups/merge`：请求只携带来源任务、主任务、分支类型（ACTIVE/HISTORICAL）与合并说明，项目、聚合组编号和成员快照（原工作状态/原负责人）全部由服务端在锁内按真实任务推导。服务端先按项目 -> 模块 -> 影响功能父到子顺序取 `FOR SHARE`，再按任务 ID 升序 `FOR UPDATE`，已有聚合组按组行 `FOR UPDATE` 后重读成员；来源任务已属于其他活跃聚合组、主任务在组内不是 MAIN、聚合组已关闭或主任务已变化统一 409。合并只写 `task_groups`/`task_group_members` 关系与来源快照、审计、活动、通知与搜索投影，不修改任何任务字段。重放前重新验证当前认证、CSRF、项目授权、聚合组仍为 ACTIVE 与全部结果任务可读，任一门禁失败不返回已存响应。无权限放宽、数据库权限或迁移变更。见 [F-23 交审说明](f23-local-handoff.md)。

## F-19 组合完成接口（2026-09-10）

| operationId | 允许主体 | 实时约束 |
| --- | --- | --- |
| completeTask | 当前活跃项目成员、系统管理员 | 匿名/停用/无效 CSRF 401，同源失败 403，错误归属/撤权/不可访问草稿 404；真实父级 ACTIVE，任务 ACTIVE/TODO、If-Match/expectedRowVersion 和引用草稿版本锁内检查，不匹配 409 |
| completeTask 重放 | 同上 | 重新验证身份、CSRF、当前项目权限、真实可写父级、组身份及全部任务/记录/影响/遗留资源；不得泄露已存状态码或结果 |

历史 SOURCE 不承接新执行工作，MAIN 与活动 SOURCE 可完成；无变化只保存六类原因和说明。有变化不得更改草稿身份/归属/历史影响或覆盖已有其他 task_id。两业务事件通知分别去重并检查收件人当前访问权。无权限基线、数据库角色或迁移改变。见 [F-19 交审说明](f19-local-handoff.md)。

F-19 兼容收口：transitionTask/transitionModuleTask 的 COMPLETE 也必须通过 TaskCompletionWorkflow 的真实归属、当前组身份与相关记录作者通知过滤。历史 SOURCE 当前执行及成功结果重放均拒绝；MAIN/活动 SOURCE 可完成。两旧 operation 幂等/重放授权契约升级 2.0.0，旧 1.0.0 Key 返回 409。REOPEN/CANCEL/RESTORE 保留原权限行为和旧 TaskItem/ModuleTaskItem 响应。
## F-20 遗留转换授权（2026-09-10）

| 路由 | 授权与限制 |
| --- | --- |
| convertLeftoverToTask | 匿名/失效401，非成员或错误记录/遗留404，真实父级归档409；当前PUBLISHED关系、稳定ACTIVE项、版本/继承确认、当前活跃成员指派、CSRF/同源/幂等 |
| previewLeftoverTask | 实时项目成员/管理员，PUBLISHED当前遗留；因为是写预览，真实父级归档409；MODULE归档影响只排除不阻断 |
| getLeftoverTaskSource | 按真实任务项目验证当前成员/管理员；任务不存在/失权404，归档历史可读；来源非PUBLISHED或未关联返回null，不暴露记录引用 |

不同Key重复转换先验证现有任务归属与访问再返回409引用；失权details为空。同Key成功结果重放检查当前记录、稳定链接、任务和保存影响资源。任务负责人须由服务端成员端口验证，来源scope与原文不可由客户端改写。三路由均no-store，具体测试与未验证项见[F-20交审说明](f20-local-handoff.md)。

## F-24 解除合并接口（2026-09-10）

| operationId | 允许身份 | 附加门禁 |
| --- | --- | --- |
| unmergeTaskGroup | 当前活跃项目成员、系统管理员 | 匿名/停用 401；非成员、已移除成员、来源/主任务真实归属错误、跨项目或任务不存在 404；Session、CSRF、同源与数据库幂等 |

仅 `POST /api/v1/task-groups/unmerge`：请求只携带来源任务与解除原因（可空，≤10000，空白回落固定文案），项目与聚合组归属全部由服务端在锁内推导。服务端按项目 -> 模块 -> 影响功能父到子顺序取 `FOR SHARE`，再按任务 ID 升序 `FOR UPDATE`，最后锁聚合组行并重读成员；仅允许解除活跃 SOURCE：来源已不是活跃成员 404 `TASK_NOT_MERGED`，来源是 MAIN、聚合组已关闭或锁内关系变化统一 409。解除只写 `task_group_members` 关系（`DETACHED` + 时间 + 原因）与聚合组状态/版本，不修改任务工作状态、负责人和迭代记录；最后一个来源解除时同事务关闭聚合组并解除 MAIN。重放前重新验证当前认证、CSRF、项目授权、聚合组可读与全部结果任务可读（组可为 `CLOSED`），任一门禁失败不返回已存响应。无权限放宽、数据库权限或迁移变更。见 [F-24 交审说明](f24-local-handoff.md)。

## F-21 记录作废与恢复（2026-09-10）

| operationId | 允许身份 | 拒绝与门禁 |
| --- | --- | --- |
| voidChangeRecord | 完整管理员 Session | 匿名/失效401；普通成员及其他非管理员403；原因非空、同源、CSRF、If-Match、数据库幂等；PUBLISHED→VOID；错误资源404，状态/版本/归档父级409 |
| restoreChangeRecord | 同上 | VOID→PUBLISHED；FEATURE 所属功能 ACTIVE（ADR-043 起项目无归档态、ADR-044 起模块无归档态）；MODULE 历史影响及来源任务不是父级门禁 |

listChangeRecords 默认 PUBLISHED，管理员显式 status=VOID 才列出作废记录；成员请求 VOID 返回404。getChangeRecord/listChangeRecordVersions/getChangeRecordVersion 允许管理员读取 VOID 详情和全部不可变版本，成员返回404。ReadableRecord 的 PUBLISHED 分支不包含作废快照；VOID 分支仅向管理员返回最近作废时间/原因。恢复后即便保留快照，成员读取仅取 PUBLISHED 分支。

迁移响应/幂等缓存只有 id/projectId/status/rowVersion。重放先重查当前完整认证、CSRF、管理员双时间戳和结果记录可读性；归档父级不取消历史可读性，重放不重复迁移。业务状态、审计、Search 与该记录全部 Activity 共用一个事务；Activity 不含原因，无作废/恢复通知。见 [F-21 交审说明](f21-local-handoff.md)。

## F-22 GitHub 当前关联

| operationId | 允许主体 | 拒绝与附加门禁 |
| --- | --- | --- |
| listExternalLinks | 当前活跃项目成员、系统管理员 | 匿名/无效Session401，其他项目/已移除成员404；按真实目标归属；VOID普通成员404、管理员只读；归档目标可读 |
| addExternalLink | 当前活跃项目成员、系统管理员 | 同上；目标及真实父级ACTIVE（记录DRAFT/PUBLISHED），VOID管理员409；CSRF、同源、If-Match、数据库幂等；重复当前关联409、容量超限422 |
| removeExternalLink | 当前活跃项目成员、系统管理员 | 同上；只解除当前类型化关联，保留链接实体与不可变审计；其他项目linkId404；状态/版本冲突409 |

三条路由使用严格的 PROJECT/FEATURE/TASK/CHANGE_RECORD 目标枚举。Workflow经各域公开QueryPort解析真实归属、按父到子顺序取锁，各域CommandPort递增目标row_version，不改正式current_version或不可变历史。MODULE的历史影响功能不是记录所属父级；合并来源任务的链接不转移。新写入取得目标锁后再验证Session/CSRF与实时成员关系。重放重新验证当前认证、原操作权限、真实目标和保留链接实体可读；已成功解除的关联无需仍存在，父级归档不隐藏历史成功结果，VOID成员仍404。

### F-22 父审核增量（2026-09-10）

读取与重放在真实父级锁后取目标FOR SHARE并重读，锁保持至本次关联读取/重放授权完成；预读状态不参与最终可见性判定。等待父锁期间PUBLISHED转VOID后，普通GET与添加/解除重放均404，管理员只读。Route Registry与实写审计统一EXTERNAL_LINK_ADDED/EXTERNAL_LINK_REMOVED；真实锁竞态和验证更正见[F22交审说明](f22-local-handoff.md)。

2026-10-09 修订：链接事件的动态摘要写明链接标签与目标身份快照（仍不写 URL/正文），并按 ADR-048 跳过未发布草稿——DRAFT 记录上的添加/解除只留审计，不进入项目动态；权限主体、锁序、幂等与重放门禁不变，不新增迁移。


## ADR-030 项目与任务新增入口

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `createTaskWithScope` | 401 | 允许 | 404 | 404 | 401 | 允许 | 父级可写，同项目负责人和完整归属；CSRF、整笔幂等、同事务审计；失败回滚新模块/功能 |
| `listActiveProjectMembers` | 401 | 允许 | 404 | 404 | 401 | 允许 | 仅当前项目启用成员的 id/name/avatarUrl/role/joinedAt（ADR-033）；不返回成员历史与管理写权限 |
| `listTaskCenter` | 401 | 条件允许 | 条件允许 | 条件允许 | 401 | 允许 | 非管理员只可 mine/created/project，all 返回 403；每次 SQL 均限制当前授权项目，已移除项目不返回；project 必须指定项目；`todayTodo` 与统计卡同口径（未完成且命中 逾期 ∪ 遗留来源 ∪ 紧急 ∪ 距截止 7 个日历日内） |

`addExternalLink` 设置根仓库沿用项目写权限、If-Match 和幂等；`removeExternalLink` 解除当前根仓库后概览不显示入口。历史草稿姓名通过 UserReadPort 读取授权资源的用户引用，不能把这些历史用户用于新任务指派。
## F-18 遗留问题多条化与追加接口（2026-09-17）

| operationId | 允许主体 | 实时门禁及拒绝 |
| --- | --- | --- |
| addChangeRecordLeftover | 活跃项目成员、系统管理员 | 匿名/停用 401；非成员/撤权/跨项目/记录不存在 404；记录非 PUBLISHED 或真实父级不可写 409；`If-Match`（记录 row_version）与 `X-Record-Version`（current_version）锁内校验，不匹配 409；`content` 1～10000 字符、空白拒绝 422；同源/CSRF、数据库幂等 |

一条迭代记录可挂多条遗留问题（每条 1～10000 字符、单记录最多 50 条），草稿与正式版本使用同一上限。追加接口只新增一条 ACTIVE 条目，服务端仍生成一次记录版本（进入版本历史，并按修订规则通知原作者与来源任务当前负责人）；既有条目 ID、状态与任务关联不变。移除 ACTIVE 条目必须明确确认已解决（RESOLVED），CONVERTED 条目保留关联且不重复建任务。重放重新验证当前认证、CSRF、实时权限、可写父级与 `leftovers[].id` 全部结果资源。无新增数据库角色或权限。

## ADR-058 删除任务接口（2026-10-09）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `deleteTask` | 401 | 允许 | 404 | 404 | 401 | 允许 | 父级可写（项目 / 模块 / 功能）、任务可读且未删除、`If-Match`（任务 `row_version`）锁内校验；同源 / CSRF、数据库幂等；`reason` 可空 1～10000 字符 |
| `deleteModuleTask` | 401 | 允许 | 404 | 404 | 401 | 允许 | 同上，模块级任务无功能段 |

删除是**软删除**：任务退出全部读路径（列表、任务中心、看板、详情、成员任务、项目统计与完成率），但编号、状态历史、迭代记录与审计原样保留。同一事务内解除该任务的 GitHub 链接关联（`app.external_links` 链接本体保留）、作废该任务的全部迭代记录、按聚合组身份处理关系（`SOURCE` 自动标记 `DETACHED`、最后一个来源关闭聚合组；`MAIN` 拒绝并返回 409 `TASK_GROUP_MAIN_LOCKED`），并写 `task.delete` 审计与 `TASK_DELETED` 动态、移除搜索投影。版本冲突 409 `TASK_STATE_CONFLICT`；删除后再次删除返回 404。

重放**不要求任务仍可读**（任务行已软删除）：只复核当前认证有效、缓存的 `projectId` / `moduleId` / `featureId` / `taskId` 与请求一致、以及原操作的写入门禁（项目可写 + 模块 / 功能归属）。普通项目成员即可删除，不需要管理员身份；不作废恢复、不重建链接关联、不提供还原入口。

## ADR-064 文档导入接口（2026-10-10）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `previewProjectDocumentImport` | 401 | 允许 | 404 | 404 | 401 | 允许 | 只读校验（不写任何持久化状态）：会话认证、无 CSRF、无幂等；`document` 1～200000 字符；项目可写门禁（非成员与不存在统一 404 `PROJECT_NOT_FOUND`） |
| `importProjectDocument` | 401 | 允许 | 404 | 404 | 401 | 允许 | 同源 / CSRF、数据库级幂等（`Idempotency-Key` 必填，契约版本 1.0.0）；`expectedDigest` 与文档不一致 409 `DOCUMENT_IMPORT_STALE`；同摘要文档在本项目内已导入 409 `DOCUMENT_IMPORT_DUPLICATE`（迁移 0039 `app.document_import_runs` 唯一约束兜底）；行级 ERROR 422 `DOCUMENT_IMPORT_INVALID`（负责人须为项目活跃成员，否则 `ASSIGNEE_NOT_MEMBER`）；同名模块 / 功能复用不覆盖（差异仅 WARNING）；写审计 `project.documentImport`、批次行与各域既有活动 / 通知 / 搜索投影，全部同事务 |
| `previewProjectImport` | 401 | 允许（任何已登录用户） | — | — | 401 | 允许 | 只读校验；整项目文档必须含项目段与项目编码（`^[A-Z][A-Z0-9_]{1,31}$`）；返回编码占用与全局重复导入提示 |
| `importProject` | 401 | 允许（任何已登录用户） | — | — | 401 | 允许 | 同源 / CSRF、数据库级幂等；项目编码强制必填且全局唯一，被占用 409 `PROJECT_CODE_CONFLICT`；项目成员与任务负责人解析后自动加入新项目（去重、排除创建者）；同一摘要文档全局查重 409；单事务创建项目与全部下级，任一行级 ERROR 整笔 422 零残留 |

模式 B 的预览 / 执行面向任何已登录用户（等价于 F-04 手工创建项目），执行成功后创建者自动成为新项目成员；模式 A 面向项目可写成员（活跃成员或系统管理员）。两种模式都不新增数据库角色或权限；负责人 / 成员令牌按登录名或姓名解析，未找到或同名歧义均 422 并给出可执行的修正提示。模式 A 的负责人必须是项目当前活跃成员（不隐式加成员）；模式 B 自动加入项目成员与全部任务负责人。

## ADR-067 AI 辅助文档转换接口（2026-10-13）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `assistDocumentImport` | 401 | 允许（任何已登录用户） | — | — | 401 | 允许 | 只读校验（不写任何持久化状态）：会话认证、无 CSRF、无幂等；`mode` 取 `IN_PROJECT` / `WHOLE_PROJECT`，`text` 1～200000 字符；调用管理员配置的 OpenAI 兼容端点生成模板草稿，未启用或配置非法 503 `AI_ASSIST_DISABLED`，上游鉴权 / 限流 / 超时 / 网络 / 上下文超限 / 响应非法 503 `AI_ASSIST_UPSTREAM_FAILED`（`details.reason` 为固定枚举）；不开启数据库事务、无 SQL 写、无审计 |

本接口只服务「用户自己的文档 → 固定模板草稿」的转换，AI 永远只产出草稿文本：不写任何业务表、不写审计 / 活动 / 通知 / 搜索投影；草稿必须经用户确认后走既有 ADR-064 预览 → 执行链路，必填、负责人解析、防重复与默认值规则与手工粘贴完全一致。文件始终只在浏览器本地抽取（ADR-066 边界不变），发给上游的只有抽取后的文本；密钥只从 `/run/secrets/*` 读取并 fail closed，单路由双模式不接触项目数据。

## ADR-068 管理员 AI 配置接口（2026-10-13）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `getAiAssistSettings` | 401 | 403 | 403 | 403 | 401 | 允许 | 只读、不写任何状态、响应 `no-store`；只返回密钥尾 4 位与是否已配置，永不回显密钥 |
| `updateAiAssistSettings` | 401 | 403 | 403 | 403 | 401 | 允许 | 同源 / CSRF、数据库级幂等（`Idempotency-Key` 必填，契约版本 1.0.0）；单行整体替换，`apiKey` 缺省表示保持已存密钥；密钥经 AES-256-GCM 加密落库；`SELECT ... FOR UPDATE` 行锁 + `row_version`；写审计 `admin.aiAssistSettings.update`（不含密钥） |
| `testAiAssistSettings` | 401 | 403 | 403 | 403 | 401 | 允许 | 纯校验（不写任何持久化状态、不写审计、不发送用户数据）：用当前生效配置发一条最小探测请求；加入 [ADR-019](adr/ADR-019.md) 纯校验 allowlist |

三条路由只服务「管理员维护 AI 辅助转换配置」，不接触任何项目数据，也不改变任何业务权限；管理员高风险门禁按 [ADR-031](adr/ADR-031.md) 只要求当前生效的完整管理员会话（不再要求 TOTP 重认证）。路由总数 107 → 110，`permissions:check` 110 条操作 / 110 条路由通过（2026-10-13 补记实测）。三条路由的真实 PostgreSQL 集成用例（`apps/api/test/admin-ai-assist-api.integration.test.ts` 11 例）与设置页 E2E（`apps/e2e/tests/settings-ai-assist.spec.ts` 2 例）已于同日补齐（见开发日志第一百四十五条）；权限与鉴权行为不变，仍按上表。
## ADR-069 企业微信机器人绑定接口（2026-10-13）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `getWecomBinding` | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 只读当前登录用户自己的绑定状态（含管理员配置的机器人链接 `botProfileUrl`）；服务端从 Session 解析身份，不接受客户端指定用户；响应 `no-store` |
| `createWecomBindingCode` | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 签发一次性绑定码（ADR-023 allowlist securityFlow，见认证安全流程矩阵）：同源 + 当前 CSRF 必填；每次调用覆盖旧码；明文码只返回一次、服务端只存 SHA-256 Hash；10 分钟有效、一次性消费；不写通用幂等记录 |
| `deleteWecomBinding` | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 解除绑定（数据库级幂等，actorOnly 重放授权）：作废待用码并撤销 ACTIVE 绑定（REVOKED，不物理删除）；重复执行自然幂等 |

三条路由都只操作当前登录用户自己的资源，与项目成员关系无关。绑定码兑换发生在长连接桥接侧调用 `app.redeem_wecom_binding_code`（按 Hash 行锁 + 条件消费 + 部分唯一索引兜底，错误码 WBC01～WBC06）；桥接侧不接触明文码存储，绑定成功前不产生任何机器人的通知投递。

## ADR-070 企业微信机器人配置接口（2026-10-13）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `getWecomRobotConfig` | 401 | 403 | 403 | 403 | 401 | 允许 | 只读机器人配置与可用状态（`configured` / `ready` / `disabledReason` / botId / 密钥尾号 / `botProfileUrl`）；响应 `no-store`、永不回显密钥；主密钥缺失 / 密文不可解按 `ENCRYPTION_KEY_UNAVAILABLE` / `CONFIG_INVALID` fail closed |
| `updateWecomRobotConfig` | 401 | 403 | 403 | 403 | 401 | 允许 | 保存 botId / secret / botProfileUrl（secret 缺省或 null 保持原值，首次必填；botProfileUrl 缺省保持、null 清空；AES-256-GCM 加密落库、明文不落库）；**botId 与已存值不同（更换机器人）时同一事务解除全部企业微信绑定（个人 + 项目群，ADR-078）并在响应返回解绑计数**；CSRF + 数据库级幂等（1.2.0）；主密钥不可用且需加密新密钥时 503 `WECOM_ROBOT_CONFIG_KEY_UNAVAILABLE` |

两条路由都只服务完整管理员 Session（ADR-031 起不要求 TOTP 重认证），只访问单行配置 `app.wecom_robot_config`；写审计 `admin.wecomRobot.update`（不含密钥材料）。凭据进入数据库是本 ADR 对 ADR-069 §2.4 的修订；桥接侧读取解密后的凭据为下一批改造。
## ADR-071 文档导入工作台（2026-10-13）

本 ADR 不新增、不修改任何路由与权限规则：`assistDocumentImport`、预览与执行路由的策略与上一节完全一致。本节落库时仓库为 110 条路由；合并远端企业微信两批（[ADR-069](adr/ADR-069.md) / [ADR-070](adr/ADR-070.md)，110 → 113 → 115）后当前为 115 条（`permissions:check` 115 条操作 / 115 条路由通过，2026-10-14 合并后复跑）。

| 变化 | 说明 |
|---|---|
| 路由 / operationId | 无新增、无删除、无策略变更 |
| 新增数据读取 | 前端复用既有 `GET /api/v1/users`（登录用户目录）做姓名匹配，不扩大服务端权限面 |
| 新增管理入口 | 右栏管理员可见「配置」链接，整页跳转到 [ADR-068](adr/ADR-068.md) 已有的管理页（不新增接口） |
| 未匹配名字的处理 | 候选与成员目录只在已登录用户自己的会话内展示；点候选只生成补充说明，最终仍由服务端解析器定案 |

## ADR-076 生成总结的 AI 改写接口（2026-10-14）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `assistRecordSummary` | 401 | 允许（任何已登录用户） | — | — | 401 | 允许 | 只读校验（不写任何持久化状态）：会话认证、无 CSRF、无幂等；`requirement` 1～500 字符、`facts` 1～20000 字符；调用管理员配置的 OpenAI 兼容端点，按前端给出的当前范围事实改写总结；未启用或配置非法 503 `AI_ASSIST_DISABLED`，上游鉴权 / 限流 / 超时 / 网络 / 上下文超限 / 响应非法 503 `AI_ASSIST_UPSTREAM_FAILED`（`details.reason` 为固定枚举）；不开启数据库事务、无 SQL 读写、无审计 |

本接口只服务「把当前已选范围的确定性正文改写成一份总结」，并按 [ADR-019](adr/ADR-019.md) 纯校验 allowlist 登记；它**不接受**项目 / 时间段 / 成员等筛选参数，范围仍由前端选择器决定（见 [ADR-076](adr/ADR-076.md) §2.2 与 §5）。路由总数 115 → 116，`permissions:check` 116 条操作 / 116 条路由通过（2026-10-14 实测）。真实 PostgreSQL 集成用例见 `apps/api/test/record-summary-assist.integration.test.ts`（7 例）。

## ADR-077 项目企微群绑定接口（2026-10-15）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `getProjectWecomGroup` | 401 | 允许 | 404 | 404 | 401 | 允许 | 读取项目企微群绑定三态 / 待用码过期时间 / 绑定人与时间 / 桥接侧最近投递错误 / 机器人资料链接；非成员按资源不存在 404；响应 `no-store` |
| `createProjectWecomGroupCode` | 401 | 403（普通成员）/ 允许（组长） | 404 | 404 | 401 | 允许 | 签发一次性项目群绑定码（ADR-023 allowlist securityFlow，见认证安全流程矩阵）：普通成员 403 `PROJECT_WECOM_GROUP_FORBIDDEN`；同源 + CSRF 必填；每次调用覆盖旧码；明文只返回一次、只存 SHA-256 Hash；10 分钟有效、一次性消费；不写通用幂等记录 |
| `deleteProjectWecomGroup` | 401 | 403（普通成员）/ 允许（组长） | 404 | 404 | 401 | 允许 | 解绑（数据库级幂等 1.0.0，重放复核同一组长 / 管理员门禁与实时成员关系）：作废待用码并把 ACTIVE 绑定置 REVOKED（不物理删除）；写审计 `project.wecomGroup.unbind`；重复执行自然幂等 |

三条路由都以项目为资源：成员关系与组长身份由服务端在同一事务内实时读取（ADR-039 例外清单新增 ADR-077），非成员一律 404。绑定兑换发生在长连接桥接侧调用 `app.redeem_project_wecom_binding_code`（锁序：码行 → 发送者个人绑定行 → 群绑定行，先 chat 后 project；错误码 PWG01～PWG08；系统管理员豁免成员校验）：一个项目至多一个 ACTIVE 群、一个群至多绑定一个项目，换绑 = 旧行 REVOKED + 新行 ACTIVE，投递历史按绑定行保留。群推送与个人单聊并存（个人继续 `chat_type:1`、项目群 `chat_type:2`），本批只落数据面与交互面，不产生任何群投递；桥接改造为第二批。路由总数 116 → 119（`permissions:check` 119 条操作 / 119 条路由，2026-10-15）。

## ADR-081 组织（部门）成员分组、批量归属与同组织可见（2026-10-16）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
|---|---|---|---|---|---|---|---|
| `listOrganizations` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session；返回全部组织（id / name / rowVersion / createdAt / updatedAt），按 id 升序；只读，无 CSRF 与幂等；响应 `no-store` |
| `createOrganization` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session + CSRF + 数据库级幂等（契约 1.0.0）；`name` 1～100 字符，按 `lower(btrim(name))` 函数唯一索引去重；重名 409 `ORGANIZATION_NAME_CONFLICT`；审计 `admin.organization.create` |
| `updateOrganization` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session + CSRF + 幂等（1.0.0）+ `If-Match`（`row_version`）；404 `ORGANIZATION_NOT_FOUND`；409 `ORGANIZATION_VERSION_CONFLICT` / `ORGANIZATION_NAME_CONFLICT`；审计 `admin.organization.update` |
| `deleteOrganization` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session + CSRF + 幂等（1.0.0）+ `If-Match`；204 无 body；同一事务先显式清空成员归属（递增 `row_version`，数据库级 `ON DELETE SET NULL` 兜底）再删组织；审计 `admin.organization.delete`（只记成员数） |
| `assignUsersOrganization` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session + CSRF + 幂等（1.0.0）；`userIds` 1～200 去重、`organizationId` 为正整数或 `null`；按用户 ID 升序 `FOR UPDATE` 逐行切换归属；目标组织不存在 422 `ORGANIZATION_NOT_FOUND`；重复调用 `updatedCount = 0` 自然幂等；审计 `admin.user.organizations.assign` |
| `getMyOrganizationMembers` | 401 | 允许 | 允许 | 允许 | 401 | 允许 | 任意有效会话：返回当前用户所属组织与该组织 ACTIVE 成员（`id` / `name` / `avatarUrl` / `isAdmin`，最多 300 条；不返回登录名、邮箱与停用状态）；未分配返回空列表；只读，响应 `no-store` |

六条路由承载 ADR-081 的组织（部门）能力：组织是全局平铺配置，一名成员至多归属一个组织（未分配为 `NULL`，删除组织即回到未分配），组织不代表任何项目权限；建 / 改 / 删 / 批量归属为系统管理员专属，沿用 ADR-031 只要求当前有效的完整管理员 Session；`getMyOrganizationMembers` 是本批新增的最小只读可见面，只暴露当前用户自己组织内的脱敏字段，不放宽 `getUserDirectory` 等既有授权。路由总数 119 → 125，`permissions:check` 125 条操作 / 125 条路由通过（2026-10-16 实测）；真实 PostgreSQL 集成用例 `apps/api/test/organizations-api.integration.test.ts` 3 例本地通过；迁移 `0046_organizations.sql`。2026-10-16 第二批（部分）与修正：① `getUserDirectory` 增加只读组织字段（未分配为 `null`，仍不含登录名与邮箱），新建项目「初始项目成员」选择器按组织分组并支持「全选组织」快捷按钮（仍受 1～20 人与项目成员约束不变）；② 修正 `/settings` 前端路由守卫——ADR-081 首批声明「入口对全体成员开放」但路由仍要求管理员，已改为登录守卫（`requiresAuth`），普通成员进入后只渲染只读同组织视图，管理能力由页面按 `isAdmin` 收缩；③ 真实 PostgreSQL 集成 `apps/api/test/user-directory.integration.test.ts` 增至 3 例（含组织归属 `null` / 非 `null`）。

## ADR-082 离职账号墓碑化删除（2026-10-19）

| operationId | 匿名 | 活跃成员 | 其他项目成员 | 已移除成员 | 停用用户 | 系统管理员 | 约束 |
| ------------ | ---- | -------- | ------------ | ---------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleteUser` | 401 | 403 | 403 | 403 | 401 | 允许 | 完整管理员 Session + CSRF + 数据库级幂等（1.0.0）+ `If-Match`；目标不存在 404；未停用、已墓碑化或版本冲突 409；禁止删除自己；仍有 ACTIVE 项目成员关系时 409 `ADMIN_USER_ACTIVE_PROJECT_MEMBERSHIP`；成功 204 无 body |

本路由只服务离职账号清理：管理员必须先把目标停用并移出全部项目，再执行删除。删除不是物理删除，而是不可逆墓碑化 `app.users` 行：保留主键与历史外键，清除登录名、姓名、邮箱、头像、口令、组织归属与管理员身份，撤销全部 Session，并在同一事务内改写项目动态中的姓名引用和写 `admin.user.delete` 审计。墓碑账号不可登录、启用、编辑或再次删除；原登录名可复用，`sso_subject` 保留用于阻止同一统一身份静默接管新账号。审计原始载荷与哈希链保持不可变，审计列表优先使用事件载荷中的历史姓名；历史业务记录显示「删除用户」。成员页默认展示启用账号，可切换到已停用/离职；墓碑账号不进入任何成员筛选。2026-10-19 按 [ADR-083](adr/ADR-083.md) 移除 `forceLogoutUser`：不再保留路由、服务端命令、生成客户端方法或前端入口，撤销目标会话只能通过停用账号完成。当前路由总数 125，`permissions:check` 125 条操作 / 125 条路由。真实 PostgreSQL 集成 `apps/api/test/admin-users-api.integration.test.ts`、`apps/api/test/login.integration.test.ts` 与 `database/test/integration/database.test.ts` 已覆盖墓碑化、Session 撤销、历史姓名、审计、幂等重放、登录拒绝与数据库不可逆约束。

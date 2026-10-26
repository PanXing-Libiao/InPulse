# InPulse 仓库开发规则

本文件适用于整个仓库，供人工开发者和编码代理共同遵守。子目录只有在确有不同约束时才添加更靠近代码的 `AGENTS.md` 或 `AGENTS.override.md`；子目录规则不得放宽本文件中的安全、数据一致性和审计要求。

## 1. 当前状态与事实来源

- 仓库当前处于阶段 0 实施中，阶段 0 尚未完成；不得把设计范围描述成已实现能力，也不得声称不存在的脚本、测试或服务已经运行成功。
- 当前候选开发基线由 [功能设计 V1.1](./功能设计v1.1.md)、[系统设计文档 V1.0.2](./系统设计文档v1.0.2.md)、[技术设计 V1.2.2](./技术设计v1.2.2.md) 与[正式 ADR 索引](./docs/adr/README.md)同步构成。功能设计负责业务规则，系统设计负责范围、模块和安全机制，技术设计负责实施细节。
- 经批准且明确取代既有决策的 ADR 优先；变更已接受的架构决策时，必须新增 ADR 并标记替代关系，再同步功能设计、系统设计、技术设计、权限矩阵和测试矩阵。
- 文档、ADR、代码或测试发生冲突时，不得静默选择其中一方。先记录冲突及影响；受影响实现必须等待人工定案，未受影响工作可以继续。
- [权限矩阵](./docs/permissions.md)和[测试矩阵](./docs/test-matrix.md)分别是授权验收与测试覆盖的维护入口；相关行为变化必须同步更新。
- 2026-10-20：项目企业微信群通知策略已按 [ADR-090](./docs/adr/ADR-090.md) 服务端化，五个项目级开关由组长 / 系统管理员保存并在桥接物化前过滤；当前路由总数 129，新增迁移 `0055_project_wecom_group_notification_options.sql`。本地 API / Web / 桥接已重启，测试 VM 尚未同步。
- 明确的任务目标决定本次修改范围，但不得绕过既有安全和数据不变量。若需求确需改变不变量，先走 ADR 和人工评审。

## 2. 开工方式

开始修改前必须：

1. 查看 `git status`，识别并保留用户或其他任务已有的改动；
2. 阅读本文件、相关设计章节、已有 ADR、相邻实现和测试；
3. 明确目标、范围、非目标、业务不变量、接口、数据库影响和验收方式；
4. 选择一个可审查的业务纵切片，小步实现，不一次生成整个系统再集中调试。

除非任务明确授权，编码代理不得：

- 新增核心生产依赖、升级主版本或更换架构/基础设施；
- 修改数据库不变量、放宽鉴权或降低安全基线；
- 删除、修改或重写已提交的历史迁移；
- 跳过、删除或弱化失败测试以获得通过；
- 读取、输出、复制或修改生产 Secrets；
- 把网络请求放进数据库事务；
- 物理删除必须保留的业务历史；
- 创建提交、推送、合并、打标签或修改远端仓库设置。

## 3. 架构与依赖边界

- 系统形态固定为模块化单体、React SPA、NestJS API 和单一 PostgreSQL 数据库。
- 本期不引入微服务、多租户、Kubernetes、Redis、Elasticsearch、WebSocket、Event Sourcing、CQRS 框架、自研权限 DSL、通用 Outbox/Worker、附件对象存储或 GitHub API/Webhook 深度集成。改变这些非目标必须新增 ADR。
- 后端调用方向为：`Controller -> 单域 Application Service 或跨域 Workflow -> Domain/Public Port -> Repository/Projection Writer -> PostgreSQL`。
- Controller 只能在单域 Use Case 和跨域 Workflow 之间二选一调用，不得直接访问数据库或重复实现业务规则。
- Repository 只负责持久化，不决定业务状态流转。
- 领域模块不得互相调用写服务或访问其他模块的内部 Repository。跨域写只允许 Workflow 调用公开 CommandPort；跨域读只允许通过稳定 QueryPort。
- 一个命令只创建一个 `UnitOfWork`。所有 CommandPort、Repository、审计、通知和投影写入必须显式接收同一个 `TransactionContext`；事务回调中禁止使用全局 Drizzle Client。
- 数据库事务内禁止网络请求和长时间 CPU 工作。
- 前端依赖方向为 `app -> pages -> features -> shared/generated`；`features` 禁止导入 `pages`，`shared` 和 `generated` 禁止反向依赖业务层。
- 禁止建立万能 `shared/utils`。共享代码只放被至少两个应用使用、语义稳定且没有环境副作用的内容。
- 应用代码落库后，CI 必须检查代码依赖图、禁止循环依赖和反向依赖。

## 4. 技术栈与依赖管理

- 使用 TypeScript 严格模式、pnpm workspace、单一 lockfile。
- 候选主版本基线为 Node.js 24.x、pnpm 11.x、React 19.x、Vite 8.x、Ant Design 6.x、TanStack Query 5.x、React Hook Form 7.x、Zod 4.x、PostgreSQL 18.x。
- NestJS 基线已按 [ADR-026](./docs/adr/ADR-026.md) 定案为 11.x 并锁定 11.2.3；升级 12.x 必须满足该 ADR 的触发条件与工作清单，并作为独立依赖升级 PR 由人工确认，不得提前写成既成事实。
- Drizzle 必须处于 `>=0.45.2、<0.46`，但实际补丁版本须由阶段 0 锁定。Nginx 固定为 1.30.x 系列，阶段 0 锁定实际补丁和镜像 digest；切换 stable 系列必须新增 ADR。
- `package.json`、`pnpm-lock.yaml`、CI 和生产镜像必须锁定经过批准的实际版本；生产依赖禁止使用 `latest`、`next`、`beta` 或 `rc`。
- 修改 manifest 时必须同步提交 lockfile。不得手工编辑 lockfile。
- 依赖升级只通过独立 PR 完成，必须人工确认；不得自动合并依赖更新。
- OpenAPI 生成工具链已由 [ADR-027](./docs/adr/ADR-027.md) 定为 `Accepted`（2026-09-07）；`apps/api` 的模块/解析制式已由 [ADR-028](./docs/adr/ADR-028.md) 定为 ESM/NodeNext（2026-09-07）；Nest Zod Pipe/Serializer 组合和运行参数已由 [ADR-029](./docs/adr/ADR-029.md) 定为 `Accepted`（2026-09-09）：Controller 只绑定 `@Operation("operationId")`，请求参数统一使用 `ContractBody/Query/Path/Headers`，响应由全局 ContractResponseInterceptor 按实际状态校验并剔除未知字段，异常由全局 Filter 输出统一错误体并设置 `X-Request-Id`。未转为 `Accepted` 的选择不得在规则或实现中伪装成已冻结基线。
- 搜索基线已经确定为 PostgreSQL + PGroonga + `SearchProjection`（V1 由 ADR-025 替代 ADR-010）：支持中文短词、完整英文缩写、完整代码标识符和完整编号，不保证任意英文/代码子串，不提供正则搜索；普通查询必须使用 `normalized_search_text &@~ app.pgroonga_query_escape($1)`。
- 生产 CSP 已确定使用逐响应 nonce 且禁止 `script-src/style-src 'unsafe-inline'`；阶段 0 验证的是 Ant Design/Vite 兼容性，失败时阻断并通过 ADR 更换方案，不得降低 CSP。

## 5. API 与前端契约

- HTTP API 使用 REST JSON 和 `/api/v1` 前缀。
- `packages/api-contract` 中的 Schema Registry/Zod（内部文件可按 `contracts/*.zod.ts` 组织）是请求与响应数据结构的唯一来源；类型化 Route Registry 是 method、path、operationId、状态码、Content-Type、鉴权、CSRF、幂等和并发策略的唯一来源。两者共同生成 OpenAPI 3.1 与 TypeScript 客户端。
- 每个路由必须完整登记策略；不适用的策略也必须显式写 `none`，不得依赖隐式默认值。
- Controller 只绑定 operationId、调用 Use Case/Workflow，并返回契约 DTO；禁止直接返回数据库实体或重复手写契约 DTO/OpenAPI Decorator。
- 服务端必须验证请求和响应；客户端校验不能替代服务端校验。错误响应统一为 `{ code, message, details, requestId }`，不得使用 NestJS 默认错误格式。
- 状态码语义固定为：400 请求格式或业务参数错误；401 未登录或 Session 失效；403 已登录但无全局权限；404 资源不存在或当前用户不可访问；409 版本、重复操作或状态冲突；422 字段校验错误；429 限流；500 未预期错误；503 服务未就绪（就绪探针未通过）。数据库异常、堆栈和响应校验内部细节不得原样返回客户端。
- 前端所有 API 调用必须经过生成客户端；组件和 feature 代码不得直接裸写 `fetch` 或 `axios`。
- OpenAPI 和生成客户端必须提交到仓库，但只能由生成工具更新，禁止手工修改。
- API 变更必须在同一 PR 中同步 Schema、Route Registry、Controller 绑定、权限矩阵、集成测试、OpenAPI 和客户端，并通过生成物无漂移检查。

## 6. 数据库、事务、幂等与并发

- 数据库约束是最终防线：必填归属使用 `NOT NULL`，状态使用 `TEXT + CHECK`，唯一性和引用完整性使用 `UNIQUE`/FK，而不是只靠应用校验。
- 所有项目内跨层关系必须包含 `project_id`，并使用复合外键阻止跨项目串联。
- 跨模块业务操作必须在同一事务中完成；审计、通知、活动投影和搜索投影与业务写入使用相同事务。
- 聚合更新使用条件更新或显式行锁；内容变化必须递增 `row_version`，项目纯状态变更按 [ADR-092](./docs/adr/ADR-092.md) 保持版本不变。唯一约束、版本冲突和状态冲突映射为明确的 409 业务错误。
- 多聚合命令固定锁序为：任务 ID 升序 -> 任务组 ID 升序 -> 迭代记录 ID 升序 -> 遗留项 ID 升序。预读结果在获得锁后发生变化时，必须重新读取并从头有限重试。
- 命令需要验证项目、模块或功能仍可写时，必须先按项目 -> 模块 -> 功能的父到子顺序和各层 ID 升序取得 `FOR SHARE`；归档方按相同顺序取得 `FOR UPDATE`，随后才进入上述业务聚合锁序，防止父级归档与子级写入竞态。
- 任务、功能与模块的物理删除只能经 `app.hard_delete_task` / `app.hard_delete_feature` / `app.hard_delete_module` 三个 `SECURITY DEFINER` 入口执行；共享 helper `app.hard_delete_business_scope` 不得授予 `app_runtime`，业务表 `DELETE` 权限不得因此放开。固定锁序为父级写前门禁 -> 功能 ID 升序 -> 任务 ID 升序 -> 聚合组 ID 升序 -> 迭代记录 ID 升序 -> 遗留项 ID 升序。
- 所有写接口（POST、PUT、PATCH、DELETE）默认必须在 Route Registry 声明 `idempotencyRequired` 并实现数据库级幂等；普通 GET、HEAD 和纯校验接口显式声明 `none`。[ADR-023](./docs/adr/ADR-023.md) allowlist 中的 operationId 必须且只能声明 `securityFlow`，包括签发/消费一次性安全材料（预认证 CSRF、Session 与 CSRF）、登录/登出与 SSO 认证导航（`startSsoLogin`/`completeSsoLogin`，共五条，[ADR-032](./docs/adr/ADR-032.md)）；新增例外必须另立 ADR。通用幂等记录禁止保存或重放 Cookie、CSRF Token 或任何一次性安全材料。
- `idempotencyRequired` 的请求摘要必须覆盖大写 method、operationId、幂等契约版本、摘要格式与请求 Schema 版本、Schema 解析后的 path 参数和规范 query、规范 Content-Type、Route Registry 声明的全部行为相关请求头以及 JCS 规范化 body；使用版本头的路由必须包含 `If-Match`。摘要使用独立、带版本密钥的 HMAC-SHA-256，不得把普通 SHA-256 用作密码、验证码或其他低熵输入的离线校验器。Cookie、Authorization、CSRF、追踪头和 Idempotency-Key 不进入摘要。任一语义输入或幂等契约版本不同都返回 409。幂等不能只依赖前端禁用按钮或进程内锁。
- 每条 `idempotencyRequired` 路由必须登记带版本的 `idempotencyReplayPolicy`：逐个列出可能缓存的 2xx 状态；有 body 时列出精确响应 Schema 引用以及可安全持久化和重放的全部 body 叶子字段，无 body 时使用互斥的 `noBody` 分支。CI 必须拒绝遗漏状态、字段不全或越界、Schema 不一致、Secret 字段以及任何 `Set-Cookie`/认证响应头重放；`none` 与 `securityFlow` 路由的该策略只能为 `none`。请求或安全重放策略变化必须升级幂等契约版本，旧 Key 在新契约下返回 409。
- 每条 `idempotencyRequired` 路由还必须登记 `replayAuthorizationPolicy`，以类型化、最小化的结果资源引用说明缓存响应暴露了哪些资源。幂等重放前必须重新验证当前认证、原操作权限、所有结果资源的当前可读权限及该路由要求的高风险门禁（当前有效的完整管理员 Session）；任一门禁失败时拒绝且不得泄露已存状态码或响应。只有全部门禁通过后，同 Key、同摘要和同契约版本才重放原 2xx。
- 项目创建时，创建者必须自动成为活跃成员且创建流程不可取消该成员关系；创建完成后，系统管理员可以按普通成员规则移除创建者（[ADR-033](./docs/adr/ADR-033.md) 起创建者成员行默认担任组长 LEADER，组长须先由系统管理员转移或撤销后才能被移除）。`projects.created_by` 只用于不可变溯源，不赋予额外权限，也不得随成员移除而改变。普通成员创建者被移除后立即失去成员关系派生的项目权限；若创建者本身是系统管理员，其全局管理员权限不受成员记录影响。测试必须分别覆盖这两种身份。
- 正式记录版本不可变；迭代记录状态只允许 `DRAFT -> PUBLISHED -> VOID`，以及系统管理员执行的 `VOID -> PUBLISHED` 恢复（[ADR-031](./docs/adr/ADR-031.md) 起不再要求 TOTP 重认证）。`status` 是详情、统计、搜索和时间线可见性的唯一真相，不得因恢复后仍保留 `voided_at` 而继续隐藏。恢复必须保留作废快照与全部版本，原因进入不可变审计，具体不变量见 [ADR-024](./docs/adr/ADR-024.md)。任务组成员关系是 MAIN/SOURCE 身份的唯一真相。业务历史默认通过归档、作废或新版本保留，不物理覆盖或删除；唯一显式例外是项目删除以及任务、功能、模块删除（[ADR-062](./docs/adr/ADR-062.md)、[ADR-096](./docs/adr/ADR-096.md)），其级联边界与保留面必须按 ADR 执行。
- 历史迁移一经合并不得修改、删除或重排。新迁移采用 expand/contract 思路，必须支持从上一正式版本验证升级和回滚兼容窗口。
- API 进程不得在启动时自动生成 Schema。迁移由独立、受限的 migration 任务执行。
- Repository/Application 集成测试必须使用真实 PostgreSQL 验证事务、锁、约束和权限，不能只 Mock Repository。
- 数据库迁移、约束、角色和权限变更必须人工评审。

## 7. 认证、鉴权与 Secrets

- 不信任客户端提交的 `projectId` 来证明资源归属。鉴权必须根据 actor、资源真实归属和实时成员关系在服务端完成。
- 成员关系不得缓存到 Session 或长生命周期对象；搜索和动态查询必须先取得服务端生成的 `AuthorizedProjectScope`，并在 SQL 层过滤。
- 资源不存在和无权访问统一返回 404，避免泄露资源存在性；已登录但缺少全局权限时返回 403。
- Session、CSRF 和预认证 Token 在数据库中只保存 Hash；Cookie、CSRF 和安全响应头必须遵守技术设计。
- 单点登录（[ADR-032](./docs/adr/ADR-032.md)，前端入口经 [ADR-036](./docs/adr/ADR-036.md)、[ADR-080](./docs/adr/ADR-080.md) 修订）是默认登录入口：匿名访问 `/login`（含 `?from=`）即刻整页跳转 `GET /api/v1/auth/sso/start`，不再默认呈现本地口令表单；该路由只保存 state 的 HMAC 并下发 `__Host-sso-state`，`GET /api/v1/auth/sso/callback` 必须同时匹配 URL `state` 与该 Cookie 后才一次性消费；nonce 与 PKCE verifier 由服务端从 state 派生、不落库；token 交换与 JWKS 验签禁止放进数据库事务；只允许用 `sub`/`Name`/`DisplayName`/`Email` 映射本地账号；`groups` 仅用于 ADR-097 的组织同步，Casdoor application 必须配置 `JWT-Custom` Token format、Token fields 包含 `Groups`、Token group format 为 `Path`；Casdoor 的 `isAdmin`、roles、permissions 等 claim 一律不得影响 InPulse 权限。
- SSO 首次登录 JIT 开通 `password_hash=NULL`、无任何项目成员关系的账号：平台已有账号时 `is_admin=false`；平台此前没有任何账号（`app.users` 无行，含停用账号也算有）时，第一个完成 SSO 登录的账号自动授予 `is_admin=true`（[ADR-075](./docs/adr/ADR-075.md)，判定与 INSERT 用固定键 `pg_advisory_xact_lock` 在同一事务内串行化，审计 payload 记 `grantedAdmin`）；映射优先级固定为 `sso_subject` 命中 → 登录名命中且未绑定且邮箱一致时绑定 → JIT；邮箱不一致或 subject 已绑定其它账号必须按冲突拒绝，禁止静默接管同名账号。无口令账号在本地入口必须干净地返回 401，不得抛错或 500。
- `SSO_ENABLED` 非真值即整体关闭；配置非法时 fail closed：访问登录页后由服务端 302 回 `/login?local=1&sso=disabled`，登录页提示未启用并展示本地口令表单（不自动跳转）；`/login?local=1` 是管理员应急口令入口（隐藏、不自动跳转）；`?sso_error=` 回落只显示错误与手动「重新登录」。SSO start/callback 是 302-only 路由，不参与生成客户端；前端只做同源整页跳转，不得为此新增裸 `fetch`/`axios`，也不得新增 SSO 状态查询接口。
- 登录只接受匿名预认证 Session 及其 CSRF Token；已有普通、受限或完整认证 Session 必须先登出，再签发新的预认证 CSRF。停用用户的旧 Session 按无效处理；受保护或业务接口返回 401，但 `issueCsrfToken` 与无效 Session 的同源 `logout` 可按匿名安全语义执行且不得恢复身份。
- 管理员高风险接口只要求当前有效的完整管理员 Session（`AUTHENTICATED`）、`is_admin`、写操作 CSRF、数据库级幂等与审计留痕；[ADR-031](./docs/adr/ADR-031.md) 起不再要求管理员密码与 TOTP 重认证，`reauthenticated_at`/`mfa_verified_at` 不再作为门禁条件。
- 认证 Session 的状态必须由每条签发路径显式赋值，不得默认成为完整认证态；[ADR-031](./docs/adr/ADR-031.md) 起 `user_sessions.auth_state` 只写入 `AUTHENTICATED`，历史取值不得作为有效认证态参与鉴权。
- Markdown 不允许原始 HTML；用户链接必须使用标准 URL Parser 和协议/域名白名单。V1.2.2 仅保存 GitHub HTTPS 链接，不主动抓取远程内容。
- 禁止读取、打印、记录、提交或复制 Secrets。`.env.example` 只放非敏感变量名，不放 Secret 示例值或占位值。
- 生产 Secret 只从 `/run/secrets/*` 读取；缺失、空值、路径越界或权限不合规必须 fail closed，不允许敏感环境变量 fallback。
- 若发现 Secret 已进入 Git 历史，立即停止传播，通知维护者先撤销/轮换，再制定历史清理方案；仅新增一次删除提交不视为完成处置。

## 8. 测试与验证

- 行为变更应先写或更新能失败的测试，再小步实现；修复缺陷必须覆盖回归路径。
- 先运行最小相关测试，再运行类型检查和模块测试；交付前运行所有适用于本次变更的完整门禁。
- 必须覆盖真实数据库约束、事务回滚、权限矩阵、幂等、乐观锁、并发竞态、请求/响应契约和关键 E2E 路径。
- 不得使用 `skip`、降低断言或删除用例来掩盖失败；确需隔离不稳定测试时必须说明原因、影响和恢复计划，并获得人工同意。
- `apps/web` 单测的等待预算是按 CI 实测定过的：`maxWorkers` 取「核数 - 1」与 8 的较小值（本机 20 核 = 8，CI 4 vCPU = 3；写死 8 会在 CI 上超额订阅，反而更慢、更容易超时）、`testTimeout` 20s、`@testing-library` 的 `asyncUtilTimeout` 4s（懒加载 chunk 冷启动与弹层过渡帧）。放宽等待预算不算弱化断言，但不得用来掩盖真实失败：同一个用例若继续红灯，必须回到实现或测试本身找原因。
- 本地跑真实 PostgreSQL 集成测试与 Playwright E2E 必须指向独立测试库（推荐 `app_ci`），不得指向本地演示库 `app`：夹具会直接写进演示页面，而演示库里的历史夹具只能人工清理。本机不要求 Docker Desktop：`pnpm test:integration:local` 与 `pnpm test:e2e:local` 默认指向本机原生 PostgreSQL 18（55432）上的 `app_ci`，会自动检测 PostgreSQL 18 + PGroonga，必要时初始化并启动 `.data/pg-dev`、创建 `app_ci`、执行 `000_roles.sql` / `020_pgroonga.sql` 与迁移；`POSTGRES_BIN` 指向本机 `bin`，`INPULSE_LOCAL_PG_PORT` / `INPULSE_LOCAL_PG_DATA` 可覆盖端口与数据目录，`--skip-migrate` 跳过迁移。也可手工准备测试库，并把 `TEST_DATABASE_URL` / `E2E_DATABASE_URL` 指向 `app_ci`；`test:e2e:local` 在解析出演示库 `app` 时直接拒绝运行。演示库若已被污染，用 `E2E_DATABASE_URL=postgresql://cluster_bootstrap@127.0.0.1:55432/app node apps/e2e/helpers/fixture-cleanup.ts` 清理（按夹具前缀删除并回退 SYSTEM 审计链头；`cleanupFixtures` 有事务级完整性断言）。
- 审计哈希链必须使用真实 PostgreSQL 验证同一 scope 至少 100 个并发业务事务；不得把测试拆成较低阈值后声称满足该门禁。若 CI 连接池无法支撑，必须提供容量依据并通过 ADR 调整，不得同时保留多个验收数字。
- 完整 CI 顺序以技术设计第 12 章为准。新增根脚本后，`README.md`、本文件和 CI 必须同时更新为同一组实际命令。

- 阶段 0 CI 最小链路已落库：根级可运行命令为 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm format`、`pnpm format:check`、`pnpm typecheck`、`pnpm test:unit`、`pnpm test:web`、`pnpm test:integration`、`pnpm db:migrations:check`、`pnpm db:seed:check`、`pnpm db:seed:demo`、`pnpm db:migrate`、`pnpm contract:generate`、`pnpm contract:drift`、`pnpm contract:validate`、`pnpm build`、`pnpm test:e2e`、`pnpm check:deploy:test`、`pnpm check:deps`、`pnpm check:frontend:boundaries`、`pnpm permissions:check`、`pnpm deps:audit`、`pnpm check:secrets`、`pnpm check:docs`，以及一次跑完全部非数据库门禁的 `pnpm check`（`pnpm check` 在 `db:migrations:check` 之后插入 `pnpm db:seed:check`；本机无 Docker 时使用 `check:deploy:static`，CI/发布仍执行严格 `check:deploy:test`）。GitHub Actions 的 `CI / workspace` job 按技术设计 §12.4 顺序执行同一组命令，`Documentation / docs` job 只执行 `check:docs`。因为 `0003_search_pgroonga.sql` 在缺少 PGroonga 时 fail closed，CI 先用 `database/poc/search-pgroonga/Dockerfile.pgroonga-pg18.6` 基于 digest 固定的 `postgres:18.6` 构建探针镜像，再按 `database/scripts/test-local.ps1` 的同一顺序执行 `000_roles.sql`、`020_pgroonga.sql`、空库迁移与集成测试；该探针镜像只服务 CI 与 PoC，不是生产部署镜像，也不等同于 §12.4 的容器镜像构建门禁。`pnpm db:migrate`、`pnpm test:integration`、`pnpm db:test` 与 `pnpm db:test:local` 需要已安装 PGroonga 的 PostgreSQL 18 实例，不含 PGroonga 的官方 PostgreSQL 18.6 安装会让 `db:test:local` 按设计直接失败；本机 PostgreSQL 18.6（`D:\PostgreSQL\18\pgsql`）已内置 PGroonga 4.0.8，`db:test:local` 与 API `test:integration` 均已在本地实测通过。`pnpm test:search:db` 与 `pnpm test` 还要求 `max_connections >= 150`，二者按既定决定尚未纳入 CI。`check:docs` 同时检查 HEAD、暂存区、工作区、未忽略的新文件和 Markdown 链接/锚点；`deps:audit` 需要访问 registry，曾因 `origin/main` PR #16 的 `@testing-library/*` -> `@testing-library/dom` -> `pretty-format@27.0.2` 带入 `ansi-regex@5.0.0`（GHSA-93q8-gq69-wqmw，high，补丁 `>=5.0.1`）而失败，已由 `pnpm-workspace.yaml` 的 `overrides` 把 `ansi-regex` 固定到 `^5.0.1`（lockfile 落为 `5.0.1`）解决；此前本地 `pnpm deps:audit` 与 `pnpm check` 已通过；当前本机 npm 镜像缺少 audit endpoint 时需用公共 registry 执行 `pnpm audit --registry=https://registry.npmjs.org`（2026-09-08 已验证无漏洞），该依赖变更为 dev 工具链，仍须按第 4 节作为独立依赖升级 PR 由人工确认。`test:integration` 已包含技术设计 §12.3/§12.4 要求的数据库角色与权限探针。A-1 备份/恢复集成测试需要真实 `pg_dump`/`pg_restore`：runner 自带的 PGDG noble 客户端为 16.x，pg_dump 拒绝连接主版本更新的服务器（测试库为 PostgreSQL 18.6），因此 `CI / workspace` 在集成测试前启用 PGDG 源并安装固定版本 `postgresql-client-18=18.6-1.pgdg24.04+2`，通过 `INPULSE_BACKUP_PG_DUMP`/`INPULSE_BACKUP_PG_RESTORE` 注入 `apps/ops` 集成测试（本地等价设置见本文件 A-1 条目）。Playwright 浏览器 E2E 测试基座已落库并纳入 `CI / workspace`（当前 Playwright 71 例（2026-10-10 全量本地通过）：项目创建关键路径、退出登录换号落点、F-03 用户管理、F-05 项目成员管理、F-13 功能档案、F-14 功能级任务、F-16 任务状态闭环、F-17 独立草稿、F-18 记录发布、搜索边界、F-27 项目动态专属路径与 F-28 通知状态联动已覆盖，其余完整关键路径待覆盖）；`deploy/compose.yaml`（§11.2 稳态拓扑预检，环境变量按当前代码实际名称）与镜像 ref 预检已落库，`pnpm check:deploy:test` 使用合成 ref 正例校验 compose 渲染、exact-tag@sha256 格式、PostgreSQL 18 命名卷挂载、非 root/只读/资源限制/健康检查/端口等结构，CI 另用 `.env.deploy.example` 验证占位符被拒绝；生产 Dockerfile（API/Migration/Web/DB-bootstrap）与基础镜像 digest 已按 [ADR-017](./docs/adr/ADR-017.md) 定案，§12.4 的容器镜像构建与 Trivy 镜像扫描已纳入 CI / workspace；真实镜像 Tag/digest 绑定与签名发布清单仍在发布环节由人工完成。`CI / workspace` 在同一 ref 上取消被新推送取代的在运行流水线（`main` 上的运行不取消）（曾试把 `apps/api` 的 `test:unit` 改为并行执行单元测试文件，CI 实测反而略慢：`apps/api test:unit` Duration 由 35.99s 变为 40.14s，原因是该套件在 4 vCPU runner 上受模块导入与 worker 启动开销支配，已回退为原串行方式）；这些只改变耗时，不改变 §12.4 的门禁顺序与判定。2026-09-10 用 `gh run view` 读到单次运行约 16 分钟，其中 `pnpm install --frozen-lockfile` 仅约 13 秒，因此没有为 pnpm store 引入缓存步骤；当前主要耗时项是 Browser E2E、生产镜像构建与 Trivy 扫描。CI 另为 Playwright 的 Chromium 增加 `actions/cache` 步骤缓存 `~/.cache/ms-playwright`（action 固定到 `v5.1.0` 的提交，键绑定 `pnpm-lock.yaml`），因为实测 Install Playwright browser 在 25s~116s 之间波动；Trivy 漏洞库已由 `trivy-action` 自带缓存，未再重复配置。生产镜像的 builder 改为先复制依赖清单（根 manifest、各 workspace 包 `package.json`、lockfile、`.npmrc`）再执行 `pnpm install --frozen-lockfile`，之后才 `COPY . .`，使依赖层不随源码失效；镜像构建改用 container driver 的 buildx 并带 `type=gha` 层缓存（各镜像独立 cache scope 与 `ignore-error=true`），对应 CI 的 Set up Docker Buildx with GHA layer cache 步骤；新增 workspace 包必须同步 `deploy/docker/{api,migration,web}.Dockerfile` 的依赖清单，否则 `--frozen-lockfile` 会因 lockfile 与 manifests 不一致而失败。固定 digest 的基础镜像不会因 Debian 安全更新自动重建，上游集中公布安全公告后 Trivy 镜像扫描会转红（2026-09-13 API 镜像报出 `libpcre2-8-0` 的 2 个 HIGH；2026-10-08 web 镜像报出 `libheif`/`openssl` 的 12 个 HIGH）：五个生产 Dockerfile 因此在 runtime 阶段刷新 Debian 安全包并 `apt-get clean && rm -rf /var/lib/apt/lists/*`——api/migration/ops 只带 Node、没有需要按版本确认的服务器二进制，用 `apt-get upgrade -y`；web 要让 nginx 停在 1.30.x、db-bootstrap 的 PGDG 源会让整体 upgrade 带走 PostgreSQL 18.6 基线，二者只用点名 `apt-get install -y --only-upgrade` 且两套套件的包名不同（bookworm 只有 `libpcre2-8-0`，trixie 依安全源公告逐个点名、2026-10-08 为 14 个包名，写错会 `E: Unable to locate package` 并 fail 构建）。设计一致性仍需人工检查，不得伪称已运行不存在或未执行的门禁。
- 2026-09-09 依赖审计复核与修复（覆盖上文 2026-09-08 “已验证无漏洞”的过时结论）：使用公共 registry 执行 `pnpm audit --audit-level=high` 时，当前基线经 `apps__api > @nestjs/core > @nestjs/platform-express > multer` 暴露 3 个 high（GHSA-wc9g-mqfw-jrwm、GHSA-qfvm-cv95-jqjf、GHSA-535w-7cp7-47q4），修复版本为 `multer >=2.3.0`；A 的独立 PR #56 已先合入 `multer: "^2.3.0"` override，C 的独立 PR #57 进一步收紧为精确版本 `multer: "2.3.0"` 并同步 lockfile，公共 registry 审计已返回无漏洞，`deps:audit` 不再被 multer 阻断；依赖变更按第 4 节经独立 PR 与人工确认，不得夹带。
- 阶段 0 搜索 PoC 已落库：PostgreSQL 18.6 探针镜像已完成 PGroonga 构建、扩展安装、迁移、15 组 V1 语义探针、90 条金标、跨项目隔离、`EXPLAIN (ANALYZE, BUFFERS)` 默认计划、`0000-0002 -> 0003-0005` 由 migration runner 升级/逐迁移事务内回滚和排除 Session 数据的逻辑恢复验证；旧 `pg_trgm` GIN 索引由 `0004` 删除、`pg_trgm` 扩展由 `0005` 在 contract 确认后删除；`search_projection` PGroonga bootstrap 与 `0003-0005` 显式迁移已通过真实 PostgreSQL 集成测试，`app_runtime` 使用未转义 `&~` 被拒绝；SearchQueryService 服务层与 `ProjectAccessQueryPort` 契约草案已落地，真实 PostgreSQL 权限过滤/参数化查询测试已通过；生产 `ProjectAccessQueryPort` 适配器与通用 `SessionAuthService` 已落库；`GET /api/v1/search` 契约纵切片（Schema、Route Registry、OpenAPI、生成客户端与最小 Controller）和服务端签名游标已落库，A 已正式确认 C-006；真实 HTTP API 集成测试已由本地 PostgreSQL 验证通过（2 个搜索文件 16 例、API 集成 14 个文件 60 例）；`SearchProjectionWritePort` 已实现独立 `SearchProjectionModule`、显式 `TransactionContext` 的 PostgreSQL upsert、输入校验、文本规范化与 `source_row_version` 防旧写，模块注入单测与真实 PostgreSQL 4 例已本地通过；搜索页面最小纵切片已本地落库并通过前端单测（10 文件 24 例），搜索边界 Playwright E2E 已本地 13/13，生产加密备份恢复仍待交付；`pnpm db:poc:search:local` 保留为原 `pg_trgm` GIN 默认计划未通过的证据并会非零退出。
- 阶段 0 F-27/F-28 纵切片已本地落库：新增活动/通知公共写端口与显式事务 PostgreSQL 适配器、项目动态读取（服务端 `AuthorizedProjectScope` + 白名单投影）、通知列表/未读数/单条已读未读/全部已读、签名游标、CSRF 与幂等重放；Schema、Route Registry、权限矩阵、OpenAPI、生成客户端和前端活动/通知页面已同步；现有 API 单测 39 文件 180 例、真实 PostgreSQL 集成 22 文件 89 例、前端 20 文件 48 例、全 workspace typecheck/build、契约/权限/依赖边界/Secret/文档门禁均本地通过，`pnpm check` 仅因本地 npm 镜像无 audit endpoint 失败，公共 registry 审计无漏洞；GitHub Actions 尚未执行；F-04 项目创建 Workflow 已调用活动、通知与搜索投影写端口并生成对应事件，但任务完成、记录作废/恢复、合并等 Workflow 尚未调用活动/通知写端口，未声明这些业务事件在生产侧生成。
- 阶段 0 F-31 Playwright 浏览器测试基座已本地落库：新增 `apps/e2e`（Playwright webServer 启动 API/Vite、global setup/teardown、真实 UI 登录辅助、API 启动探针/匿名保护页/全局搜索/站内通知/API Session/项目创建关键路径 6 个用例）、根级 `pnpm test:e2e`、Vite 代理与 CI / workspace 步骤；CI 步骤按 §12.4 位于 `pnpm build` 与 `pnpm check:deps` 之间；本地 6/6 通过，项目创建关键路径（登录 → 创建项目 → 项目动态 → 搜索 → 站内通知）已覆盖，其余完整业务关键路径仍未覆盖，Playwright 新增强需非作者人工评审。
- 阶段 0 F-04 项目创建前端纵切片已本地落库：`/projects` 改为登录保护，以 Ant Design、React Hook Form + Zod 实现项目创建表单，所有 API 调用均经生成客户端，先签发 CSRF Token 再携带 `x-csrf-token` 与 `Idempotency-Key` 调用 `createProject`；处理 401、403、409、422、429；创建后可直接打开项目动态并跳转全局搜索，完成登录 → 创建项目 → 项目动态 → 搜索 → 站内通知真实 UI 关键路径。修复 `ProjectBootstrapController` 将浏览器完整请求头误判为 422 的问题，并补充审计 keyring 的临时测试路径防线与项目创建控制器单元测试；API 单测 39 文件 180 例、真实 PostgreSQL 集成 22 文件 89 例、前端单测 20 文件 48 例、Playwright 6/6 通过，lint、typecheck、build、格式、契约/权限/依赖边界/Secret/文档/部署预检均本地通过；本地镜像下 `pnpm deps:audit` 与整体 `pnpm check` 因缺少 audit endpoint 在审计步骤失败，改用公共 registry `pnpm audit --registry=https://registry.npmjs.org` 返回无已知漏洞，其余门禁均通过；GitHub Actions 尚未执行。
- 阶段 0 F-01/F-08/F-11 缺口已本地落库：F-01 增加 Session 分批清理（单事务 `FOR UPDATE SKIP LOCKED`、过期/绝对过期/已消费三类数据与可配置批大小）；F-08 增加审计 HMAC 惰性轮换（keyring 当前版本驱动、先写 `AUDIT_KEY_ROTATED` 再写业务事件）和同事务回滚测试；F-11 按 [ADR-029](./docs/adr/ADR-029.md) 落库 `@Operation`、Contract 请求装饰器、全局响应 Serializer、统一异常 Filter 与同源 Guard。`pnpm check` 全绿，真实 PostgreSQL API 集成 28 文件 124 例、数据库集成 13 例、Playwright 8/8 通过；GitHub Actions 尚未就本轮 PR 执行。
- 阶段 0 用户目录与设计师最新视觉迁移已本地落库：新增 `GET /api/v1/users`（Schema、Route Registry、OpenAPI、生成客户端、Controller/Service/Repository），只返回 ACTIVE 且未停用用户的 `id/name/avatarUrl/isAdmin`，最多 300 条并响应 `no-store`；创建项目表单可在此目录中选择其他项目成员，前端去重排序、排除创建者并生成 `memberIds`；公共应用壳按最新设计师 token、深色侧栏、白色顶栏与面包屑迁移，项目页与创建弹窗同步新视觉；API 单测 39 文件 180 例、真实 PostgreSQL 集成 22 文件 89 例、前端 20 文件 48 例、Playwright 6/6 通过，lint/typecheck/build/契约/权限/依赖边界/Secret/文档/部署预检均本地通过，GitHub Actions 尚未执行。
- 阶段 0 全局命令面板、通知弹层与活动页设计师最新视觉迁移已本地落库：新增 `features/command-palette`、`features/activity-center`、`features/common/components/InpulseIcon` 与 `pages/activity-center`、`pages/issues`；命令面板支持 Ctrl/Cmd+K、类型分组、方向键/Enter/Esc 与生成客户端搜索；通知铃铛改为弹层，支持未读数量、最近通知、全部已读与点击目标直达；活动页拆为项目选择入口与项目动态详情，公共壳改用联合品牌图片；项目创建通知 `targetPath` 修正为 `/projects/{projectId}/activity`；API 单测 39 文件 180 例、真实 PostgreSQL API 集成 22 文件 89 例（含项目创建 4 例）、前端单测 23 文件 52 例、Playwright 7/7 通过，lint/typecheck/build/格式/契约/权限/依赖边界/Secret/文档/部署预检均本地通过，GitHub Actions 尚未执行。
- 阶段 0 依赖漏洞修复：`deps:audit` 另曾因 `multer@2.2.0` 的 3 个 high（GHSA-wc9g-mqfw-jrwm、GHSA-qfvm-cv95-jqjf、GHSA-535w-7cp7-47q4）失败；A #56 已通过 `pnpm-workspace.yaml` 的 `multer: "^2.3.0"` override 合入主线后，本 PR #57 再将版本收紧为精确 `2.3.0`（`pnpm-lock.yaml` 同步更新）；`pnpm audit --registry=https://registry.npmjs.org --audit-level=high` 已由公共 registry 验证返回 `No known vulnerabilities found`。该变更为 `@nestjs/platform-express@11.2.3` 的传递依赖，仍须按第 4 节作为独立依赖修复 PR 由人工确认，不得调低 `--audit-level`、添加 allowlist 或删除门禁。
- 2026-10-08 依赖审计修复（main CI `Dependency audit` 红灯）：公共 registry 的 `pnpm audit --audit-level=high` 对当时基线报 6 条——1 critical `proxy-addr@2.0.7`（GHSA-jqcg-44mw-7w3h，经 `@nestjs/core` / `@nestjs/platform-express` -> `express` -> `proxy-addr`）、3 high（`brace-expansion@5.0.9` 的 GHSA-qhr7-859c-m2p7 与 GHSA-6j4f-fj2g-mc7p，经 `eslint` -> `minimatch`；`source-map-js@1.2.1` 的 GHSA-68fv-2mgg-jv7q，经 `vitest` -> `vite` -> `postcss` 等 48 条路径）、2 moderate（`multer@2.3.0` 的 GHSA-3pph-fpjx-jg34、`brace-expansion` 的 GHSA-q2hr-2g5m-vwhr）；已在 `pnpm-workspace.yaml` 的 `overrides` 固定 `proxy-addr: "2.0.8"`、`brace-expansion: "5.0.12"`、`source-map-js: "1.2.2"` 并把 `multer` 收紧为 `"2.4.0"`（lockfile 同步），公共 registry 审计恢复零漏洞。该变更仍须按第 4 节作为独立依赖修复 PR 由人工确认，不得调低 `--audit-level` 或添加 allowlist。
- 阶段 0 前端 MFA 与管理员重认证交互已本地落库：登录页支持 TOTP 注册、验证与恢复码并在成功后轮换 CSRF Token；管理员账户菜单提供“管理员安全验证”弹窗，输入管理员密码和当前 TOTP 完成 5 分钟双因子重认证；所有前端调用经生成客户端并统一映射 401/403/409/422/429；新增前端单测（Web 25 文件 63 例）与 Playwright MFA 真实 UI 用例，E2E 总 8/8、API 单测 47 文件 224 例、真实 PostgreSQL 集成 22 文件 89 例均本地通过；lint、typecheck、build、格式、依赖边界、Secret 与文档检查通过；[PR #63](https://github.com/256-code/InPulse/pull/63) 的 GitHub Actions 已通过（workspace 10m2s，docs 通过）。
- 阶段 0 F-26 搜索边界 Playwright E2E 已本地落库：`search.spec.ts` 由 1 个正向用例扩为 5 个，覆盖无权限项目不返回、无匹配空态、签名游标 20→25 条加载更多、中文短词与特殊标识符；`global-setup` 创建无当前用户成员关系的隐藏项目、25 条分页投影与语义 fixture，`global-teardown` 同步清理；本地 E2E 13/13、`apps/e2e` typecheck 与 API build 通过；PR #68 GitHub Actions 已通过（workspace 10m14s，docs 通过）。
- 阶段 0 F-27/F-28 项目动态与通知状态 Playwright E2E 已本地落库：新增 `activity.spec.ts`，覆盖创建项目后进入专属动态页并看到 `project.create` 条目；`notifications.spec.ts` 扩为已读 ↔ 未读切换、全部已读与铃铛未读计数联动；抽取 `createProjectViaUi` 供动态/通知场景复用。本分支已 rebase 到 `origin/main` `1c2b5bf`；本地完整 `pnpm test:e2e` 16/16（含搜索边界与 F-13 功能档案），`pnpm build`、`apps/e2e` typecheck、`pnpm format:check`、`pnpm check:docs` 与 `git diff --check` 通过；PR #67 首次 CI 已通过（workspace 9m58s，docs 通过），rebase 后 GitHub Actions 已通过（workspace 11m7s，docs 通过，run 34334259877/34334259709）；本次 rebase 后仅文档同步，未等待新 CI。
- 阶段 1 F-03 用户管理（A）已本地落库：新增 `GET/POST /api/v1/admin/users`、`PATCH /api/v1/admin/users/{userId}`、`POST .../disable|enable|force-logout` 六条契约，管理列表、新增、编辑、启停、启用与强制退出；列表仅管理员；写操作要求 5 分钟密码 + 当前 TOTP 重认证、CSRF 与幂等键，版本化操作另带 `If-Match`；停用/强退同事务递增 `auth_version`、撤销 Session 并写审计；禁止自停用/自降级/自强退并保护最后一名可用 MFA 管理员；前端 `/settings` 改为管理员路由并用生成客户端完成全部交互；已合并 `origin/main` `8386b29`（含 F-13 与 F-27/F-28 E2E）并重新生成契约；本地验证：API 单测 55 文件 256 例、真实 PostgreSQL 集成 31 文件 152 例、前端 30 文件 87 例、契约 6 文件 63 例、数据库 5 例、Playwright 18/18，lint/typecheck/build/格式/契约 41 条路由/权限/依赖边界/Secret/59 个 Markdown/6 个迁移/部署预检/公共 registry 审计通过；GitHub Actions 尚未执行，最终 CI 与推送记录见开发日志。
- 阶段 1 F-23 任务合并（C）已本地落库：新增唯一路由 `POST /api/v1/task-groups/merge`（`mergeTaskGroup`，Session + CSRF + 数据库幂等，契约版本 1.0.0，锁序 project -> module -> feature -> task -> taskGroup，审计动作 `task.merge`）与 `TaskGroupsModule`；服务端按请求体任务 ID 解析归属项目，项目/模块/影响功能 `FOR SHARE` 后按任务 ID 升序 `FOR UPDATE` 并锁后重读，SAVEPOINT 有限重试；来源已属活跃聚合组、组内主任务变化或组已关闭 409，跨项目与非成员统一 404，归档父级 409；合并只写 `task_groups`/`task_group_members` 关系与来源快照（原工作状态、原负责人），不改任何任务字段，审计、活动、通知与搜索投影同事务；重放前重新验证当前认证、CSRF、项目可写、聚合组 ACTIVE 与全部结果任务可读；`TaskQueryPort` 新增 `findByTaskId`、`ProjectCodePort` 新增聚合组编号，`TaskDraftSource` 统一为 `TaskReadModel`；无新迁移。本地验证：API 集成全量 37 文件 232/232（F-23 文件 6/6）、API 单测 61 文件 291/291、契约 10 文件 75/75、前端 35 文件 120 例、`lint`/`format:check`/`typecheck`/`build`/`contract:drift`/`contract:validate`（73 条）/`permissions:check`（73/73）/`check:deps`/`check:frontend:boundaries`/`check:secrets`/`check:deploy:test`/`db:migrations:check` 与公共 registry 审计通过；`pnpm test:e2e` 未运行（无前端改动），GitHub Actions 未执行。详见 [F-23 交审说明](./docs/f23-local-handoff.md)。
- 阶段 0 F-09 逐响应 nonce CSP 与安全响应头纵切片已本地落库：Vite 构建期在入口 HTML 的 script/style/modulepreload 标签与 `csp-nonce` bootstrap meta 写入 `__INPULSE_CSP_NONCE__` 占位符，生产 Nginx 用每请求 16 随机字节的 `$request_id` 经 `sub_filter` 逐响应替换，CSP 头与 HTML 同值且 script-src/style-src 均无 `unsafe-inline`；HSTS/nosniff/X-Frame-Options/Referrer-Policy/Permissions-Policy 收敛到 `deploy/docker/nginx-security-headers.conf` 并由每个声明 `add_header` 的 location 显式 include；入口与 SPA 回退 `no-store` 并关闭条件请求与 ETag（避免 304 复用旧 nonce），哈希资源保持 `immutable`；`AppProviders` 改读 `meta.nonce` IDL 属性以适配生产构建；Playwright Web 服务改为 `vite build && vite preview`，`INPULSE_WEB_CSP` 非法值 fail closed 到 enforce。本地验证：web 单测 37 文件 136 例、`apps/e2e/tests/csp.spec.ts` 2/2、新增 `scripts/check-web-image-csp.sh` 在真实镜像与真实 Nginx 上 7 组断言通过、API 单测 61 文件 291 例、真实 PostgreSQL 集成 37 文件 232 例、`pnpm check` 全绿，CI 已在生产 Web 镜像构建后新增同脚本步骤；全量 `pnpm test:e2e` 最近一次 19 passed / 8 failed 均为本机既有失败或波动（`E2E_WEB_CSP=off` 对照仍失败），GitHub Actions 尚未执行。F-09 当时剩余的三项（SEC-004/SEC-006/SEC-007）已由后续切片交付，见下条；Markdown 白名单仍未交付。
- 阶段 0 F-09 数据安全专项其余三项（SEC-004/SEC-006/SEC-007）已本地落库：SEC-006 的未匹配路由由全局 `ApiExceptionFilter` 统一为固定文案 JSON 404（含前缀外与根路径，不回显 method/path 或框架文案，`X-Request-Id` 与 body 一致，已匹配路由不受影响），按 [ADR-026](./docs/adr/ADR-026.md) 直接修正异常过滤器、不引入 adapter 包装，回归用例 `apps/api/test/http-error-contract.integration.test.ts` 3 例；SEC-007 把 Secret 文件权限判定抽成 `database/src/config.ts` 的 `isPrivateOwnerReadableFile`，权限矩阵、生产路径越界（相对路径/`..`/嵌套/根目录本身）、缺失变量不回退与直连连接串在生产被拒、空内容拒绝共 15 例单测覆盖，真实 POSIX 权限位需 Linux 环境、Windows 本机不可复现，部署侧仍由 `check:deploy` 校验 compose secret 声明的 mode 0400/直接子项/uid-gid；SEC-004 按 [ADR-022](./docs/adr/ADR-022.md) 用标准 URL Parser 实现 `apps/api/src/modules/external-links/github-url.ts`（拒绝 http/ftp、用户信息、非默认端口、`api.github.com`、混淆域名与编码伪段，query 白名单化，识别 ISSUE/PULL_REQUEST/COMMIT，不发远程请求；16 例单测）并以 `database/test/integration/external-links.test.ts` 7 例锁定数据库防线（规范化 URL 同项目唯一与并发去重、非 https/混淆域名/带 fragment 被 CHECK 拒绝、跨项目与错配关联被复合外键拒绝、`normalized_url` 不可变）。本地 `pnpm check` 全绿（web 39 文件 140 例、api 单测 63 文件 309 例、真实 PostgreSQL 集成 database 2 文件 20 例与 api 40 文件 255 例、契约 77 例、权限矩阵 79/79、依赖边界 457 文件、Secret 704 文件、文档 61 文件、公共 registry 审计无已知漏洞）；未运行 `pnpm test:e2e`（无前端与路由行为变更）、GitHub Actions 与镜像扫描。仍未交付：Markdown 白名单（前端当前没有 Markdown 渲染落点，新增生产依赖必须独立 PR 并由人工确认）与外部链接的 HTTP 关联接口（属 F-14 业务纵切片）。
- 阶段 1 F-24 解除合并（C）已本地落库：新增唯一路由 `POST /api/v1/task-groups/unmerge`（`unmergeTaskGroup`，Session + CSRF + 数据库幂等，契约版本 1.0.0，锁序 project -> module -> feature -> task -> taskGroup，`versionPolicy: none` 以任务/聚合组行锁与 SAVEPOINT 有限重试实现等价并发控制，审计动作 `task.unmerge`）；请求只携带 `sourceTaskId` 与可空 `unmergeReason`（≤10000，空白回落固定文案），服务端在锁内仅允许解除活跃 SOURCE，把成员关系标记 `DETACHED`（时间 + 原因），最后一个来源解除时同事务关闭聚合组并解除 MAIN；任务工作状态、负责人、迭代记录与行版本不变；审计、活动、通知（去重接收人、深链来源任务）与搜索投影同事务；重放前重新验证当前认证、CSRF、项目可写、聚合组可读与全部结果任务可读（组可为 CLOSED）；响应 `TaskGroupUnmergeResponse` 含关闭状态与解除成员快照；无新迁移。本地验证：解除集成 8/8、`task-group` 2 文件 14/14、集成全量 40 文件 260 例（两轮各 1 例既有偶发失败，单文件复跑通过）、API 单测 63 文件 303/303、契约 12 文件 84/84、前端 37 文件 124 例（2 例既有计时敏感用例单跑通过）、`lint`/`format:check`/`typecheck`/`build`/`contract:drift`/`contract:validate`（81 条）/`permissions:check`（81/81）/`check:deps`/`check:frontend:boundaries`/`check:secrets`/`check:deploy:test`/`db:migrations:check` 与公共 registry 审计通过；`pnpm test:e2e` 未运行（无前端改动）。已两次 rebase（`c7c6881`：F-19 PR #85 之后；`14ce2ef`：F-09 加固 PR #86 之后）并强制推送；`c7c6881` 基线上 PR #87 的 GitHub Actions 已通过（workspace 12m4s，docs 通过），`14ce2ef` 基线本轮 CI 通过后同步到开发日志。详见 [F-24 交审说明](./docs/f24-local-handoff.md)。
- 阶段 1 F-32 任务中心与 F-29 项目概览前端骨架已本地落库（C）：`/tasks` 改为登录保护，页面以注入式 mock adapter 承载统计卡片、视图标签、高级筛选面板与任务明细，筛选状态按 F-30 由 URL 承载（scope/project/status/priority/level/relation/record/github/canceled/q/view/more，默认值省略、非法值回退、非管理员强制 mine）；`/projects/:projectId/overview` 按设计师稿还原项目详情头部、6 项指标条、最近迭代与待处理遗留问题面板，项目名/状态/成员数走 A 已有项目端口（2026-09-14 按用户确认改为 4 张指标小卡：未完成任务/迭代记录/成员/遗留问题，活跃模块与活跃功能从展示层取消、R-2 服务端口径不变，见测试矩阵 F-29 条目）；2026-09-14 按产品截图反馈删除任务中心只读详情弹层 `MyTaskDetailModal`：卡片与列表行点击改经 `onOpenTask`（`TasksPage` → `taskDetailPath`）直达功能档案 `?taskId=` 深链，写操作（编辑/状态推进/生成迭代记录/合并/关联链接）只在功能档案任务详情弹窗提供，任务中心不再复制入口，见测试矩阵「F-32 任务中心点击卡片直达功能档案」条目；2026-09-10 已按设计师最新稿逐页截图对比并迁移对齐（项目概览头部改纵向结构、指标条改 4 列网格、任务卡片顶部徽章与页脚优先级全称；设计师稿中任务中心的「任务聚合组」区块与项目概览的项目内导航/模块区块未迁移，分别属 F-25 与模块读端口依赖）；F-25/F-29/F-32 路由未由 A 冻结，按 `docs/c-port-extension-proposal.md` §7.5 不登记 Route Registry、不新增契约；前端单测 48 文件 195 例、typecheck/build/格式/lint/依赖边界通过，GitHub Actions 尚未执行；F-29 入口链接、F-32 补充字段（priority/dueAt/completedAt/description/creatorId）与 F-29 统计口径等待 A 裁定；该批前端改动已于 2026-09-14 随分支 `agents/fix-main-page-functionality` 首次推送（`pnpm test:web` 73 文件 399 例、typecheck/build/lint/format:check/check:docs/依赖边界与定向 Playwright 通过，GitHub Actions 尚未执行），仍需非作者人工评审。
- 阶段 0 F-09/SEC-004 外部链接数据库防线补齐（B，`codex/f22-external-links-fk-tests`）：`database/test/integration/external-links.test.ts` 由 7 例扩为 13 例，把复合外键覆盖从任务级扩到任务/功能/记录/项目四类类型化关联——跨项目串联、行内 `project_id` 与实体或链接归属错配均被复合外键拒绝（23503），四类关联重复关联同一链接均 23505，原有规范化 URL 同项目唯一与并发去重、非 https/混淆域名/带 fragment 被 CHECK 拒绝、`normalized_url` 不可变保持不变；`docs/test-matrix.md` 的 F09-SEC004-DB-001 与 SEC-004 条目同步为 13 例与四类关联。本地验证：真实 PostgreSQL 18.6 + PGroonga 下 `pnpm db:test`（数据库单测 15/15、集成 2 文件 26/26，其中 `external-links.test.ts` 13/13）、`@inpulse/database` typecheck、目标文件 ESLint 与 Prettier 检查、`pnpm check:docs`（72 个 Markdown 文件）通过；未提交、未推送，GitHub Actions 与其余门禁待 PR 执行。
- 阶段 0 F-08 步骤 4 原始审计读取留痕（A）已本地落库：新增唯一路由 `GET /api/v1/audit-logs`（`getAuditLogs`，完整管理员 Session + 5 分钟双时间戳重认证；只读，不要求 CSRF 或幂等键），Schema、Route Registry、权限矩阵、OpenAPI 与生成客户端同步（95 条路由）；查询走独立只读 `audit_reader` 连接（`AUDIT_DB_*` / `AUDIT_DATABASE_URL(_FILE)`，惰性建池、配置缺失即首次读取 fail closed；`deploy/compose.yaml` 新增 `db_audit_reader_password` secret 并启用 `AUDIT_DB_USER`），返回前在同一请求内用业务侧独立 `UnitOfWork` 向 SYSTEM 链追加 `AUDIT_LOG_READ`（filters/returnedCount/hasMore 与请求元数据，不含审计正文），留痕失败整体失败；游标为绑定操作者与查询指纹的 15 分钟 HMAC 签名；`AuditLogReadModule` 随 `authModules` 条件挂载，未配置 Session keyring 时健康探针仍可启动。新增 `apps/api/test/audit-logs.integration.test.ts` 7 例；本地 API 单测 66 文件 343 例、集成 48 文件 415 例、lint/typecheck/格式/契约 95 路由/权限 95/95/依赖边界/Secret/文档/部署预检与公共 registry 审计均通过；GitHub Actions 尚未执行。远端 WORM 归档与加密明细导出（F-08 步骤 6）仍未交付。
- 阶段 0 演示数据库已作为版本化种子落库：`database/seed/demo-data.sql` 是真实演示环境导出的业务数据快照（27 张业务表，含项目审计链），由 `scripts/export-demo-seed.mjs` 生成、`apps/api/scripts/seed-demo-data.mjs` 载入，根级入口为 `pnpm db:seed:demo`（载入，已有数据时需 `-- --force`）与 `pnpm db:seed:check`（生成物漂移检查，已插入 `pnpm check` 链）。导出只含业务数据：口令哈希在种子中是固定占位值、由载入脚本用 `@node-rs/argon2` 统一重置为演示口令并回读校验；登录会话、CSRF 材料、幂等记录、限流桶、MFA 恢复码与 TOTP 因子等运行痕迹既不导出也在载入时清空；审计链里的测试痕迹行在导出时按前缀剔除。载入前置条件是空库已执行 `bootstrap/000_roles.sql`、`bootstrap/020_pgroonga.sql` 与 `pnpm db:migrate`。本地验证（2026-09-13）：在新建库上按该顺序迁移 10 条后载入种子成功，逐表 `md5(string_agg(to_jsonb(t)::text))` 比对与演示库 26/27 表完全一致（仅 `users` 因口令占位重置与 `row_version` 递增不同，去掉口令列后一致），并对该库启动真实 API 跑通登录与 22 条读路径（账号/项目/概览/模块/功能点/任务/聚合组/遗留问题/迭代记录/动态/通知/搜索/用户目录）。种子文件只进版本库，不进入迁移历史、不改任何表结构。同批附带修复两处会阻断 `CI / workspace` 集成测试步骤的断言：`database/test/integration/database.test.ts` 的迁移不可变清单补齐 `0009_tasks_creator_index.sql`；`apps/api/test/aggregate-read-ports.integration.test.ts` 的「记录维度计数命中 `change_records` 索引」断言由只接受 `Index Scan using change_records_` 放宽为同时接受 `Bitmap Index Scan on change_records_`（同一 SQL、同一索引集下 Windows 本机与 Linux CI 规划器各选一种访问方式，节点文本分别为 `using` 与 `on`），`Seq Scan` 与 `actual time` 断言强度不变。该例的定位方式是用 `node:24.20.0-bookworm` 容器 + PGroonga 探针镜像复刻 CI 环境（因为 CI job logs 需要登录态而本机 `gh` 未登录），复现 exit 1 后修复，同一容器全量 51 文件 447 例全绿。
- 阶段 1 裁决修订 D-2「遗留问题转任务标签」已本地落库（C，未提交）：R-3 `MyTaskItem` 与 R-5 `TaskGroupMembershipItem` 增加 `hasLeftoverSource`（按 `leftover_task_links` 存在链接行判定，与来源记录当前状态无关，见 [A 的契约评审裁决](./docs/a-contract-review-f25-f29-f32.md) §12）；记录侧 `ChangeRecordReadPort.listLeftoverSourceTaskIds` 只读映射供 R-3 / R-5 同一只读事务消费；任务中心卡片/列表行与功能档案任务卡片/列表/详情弹窗显示「遗留问题」徽章（R-5 仍为页面级一次批量，读取失败降级隐藏）；契约、Route Registry summary、Schema Registry 描述、权限矩阵、OpenAPI 与生成客户端同一批再生成（105 条路由、5 产物漂移通过）。本地验证：API 单测 64 文件 351 例、Web 77 文件 455 例、契约 98 例、真库集成（aggregate-read-api / aggregate-read-ports / aggregate-read-list-api）3 文件 50 例、全 workspace typecheck、eslint/prettier（改动文件）、`check:frontend:boundaries`（251 模块）、`permissions:check`（105/105）通过；未跑全量 `test:integration` / `test:e2e` / `pnpm check` 整链，GitHub Actions 未执行；详见 [测试矩阵](./docs/test-matrix.md) D-2 章节。
- 阶段 1 任务看板（R-8）遗留问题徽章与优先级排序已本地落库（C，2026-09-21，`test`，未提交未推送）：看板卡片顶部标记组与列表行标题前显示「遗留问题」徽章（复用 R-5 `listTaskGroupMemberships` 页面级一次批量 `hasLeftoverSource`，读取失败按缺席隐藏，与任务中心/功能档案同文案同色调，遵循裁决修订 D-2；不改契约、路由与迁移）；`TaskQueryPort.listForBoard` 的未完成桶内排序改为先按优先级 紧急 → 高 → 普通 → 低、再按截止时间升序（NULL 最后），已完成仍按完成时间倒序、已取消不变，[ADR-037](./docs/adr/ADR-037.md) §3 的「看板口径不变」条目已加 2026-09-21 修订行。本地验证：Web 看板单测 4 文件 38 例、真实 PostgreSQL 看板端口集成 6 例（含优先级压过截止时间的反事实夹具）、全 workspace typecheck、lint、`format:check`、`check:frontend:boundaries`（280 模块）、`check:docs`（84 个 Markdown）、Web 生产构建通过；真实浏览器复验（项目 1 看板与列表视图）：T-58 卡片显示带提示的「遗留问题」徽章、列表行标题前同徽章、泳道顺序 高 → 高 → 普通 → 已完成（完成时间倒序）与底部图例一致；测试夹具已按 2026-09-17 指示清理（`user_` 前缀 8 账号、8 项目、2456 业务行，复核残留 0）。未运行：整链 `pnpm check`、Playwright E2E（本批未扩展）、API/数据库全量集成、GitHub Actions。
- 阶段 0 仍待建立的入口：其余业务关键路径 E2E、生产容器镜像构建、exact-tag/digest 格式校验（Compose 渲染与 ref 预检已落库为 `pnpm check:deploy` 与 CI 门禁）、镜像扫描，以及生产加密备份恢复。统一的根级安装、lint、格式、类型检查、单元测试、集成测试、生成物漂移检查、构建入口与 compose/ref 预检已落库；其余入口只有实际脚本落库后才能把命令写成可执行说明。
- 测试数据清理约定（2026-09-22 用户指示，长期有效）：本地/共享开发库上的集成测试、Playwright E2E 或手工冒烟产生的测试用户（`user_` 前缀登录名）、其创建的测试项目（`Project P` 前缀）及全部关联数据，跑完必须立即清理；统一入口 `node scripts/purge-test-data.mjs`（默认连接本机原生 PostgreSQL 18 的 `app`，先 `pg_dump` 备份到系统临时目录，再在一个事务内按外键顺序删除并校验剩余真实数据；`INPULSE_PURGE_DATABASE_URL` 可换目标库，`--dry-run` 预演、`--no-backup` 跳过备份；仅显式设置 `INPULSE_PG_CONTAINER` 时才走 Docker 兼容路径）。脚本保护 SYSTEM 审计链与真实项目数据，必要时临时禁用后恢复 `modules_protect_unclassified` 触发器，不进 CI、不改数据库结构。2026-09-22 首次清理记录：删除 62 测试用户、26 测试项目、共 602 行关联数据（含 28 模块、17 功能、13 任务、43 成员关系、17 审计、61 会话），清理后 6 个真实用户 / 3 个真实项目、4 条审计链哈希校验全部通过。

## 9. 文档与变更同步

- README 只说明项目目的、当前状态、快速上手入口和文档导航；详细开发流程放在 `CONTRIBUTING.md`，代理执行规则放在本文件。
- 改变架构、API、权限、事务、数据库、部署或运维行为时，必须同步相关 ADR、三份设计文档、权限矩阵、测试矩阵和 Runbook。
- 不允许只改代码而让设计文档失真，也不允许只改生成物而不改其源定义。
- 仓库内链接使用相对路径；新增或重命名文档后检查引用是否有效。

## 10. Git 与 Pull Request

- Git 细则以 [CONTRIBUTING.md](./CONTRIBUTING.md) 为准。
- `main` 是唯一可发布主线；`dev/a`、`dev/b`、`dev/c` 是三个岗位的长期工作分支，不得直接合并到 `main`。
- 只允许向自己的 `dev/<role>` 及其创建的交付短分支推送；禁止直接推送 `main` 或绕过 PR 合并。
- 使用短生命周期交付分支和小 PR；一个 PR 聚焦一个逻辑变更或业务纵切片，不得把未交付 WIP 混入 PR。交付分支合并删除后，把最新 `main` 同步回对应 `dev/<role>`。
- 每次向远端推送功能分支或创建/更新 PR 前，必须更新 [开发日志](./开发日志.md)，记录做了什么、功能、修复/重构或优化、实际验证结果、文档同步、风险与后续事项；不得编造测试或 CI 结果。
- 进入 `main` 的最终 squash commit 与 PR 标题使用 Conventional Commits 格式。
- 合并前必须通过适用检查并完成人工审查；数据库迁移、鉴权、权限、Secrets、API 契约、Dockerfile、Compose 和 GitHub workflow 是重点审查项。
- 禁止向 `main` 强制推送、重写共享历史、删除受保护分支或移动已发布标签。
- `pnpm-lock.yaml`、数据库迁移、生成的 OpenAPI/客户端和必要测试 fixtures 应提交；本地环境、Secrets、数据库备份和构建产物不得提交。

## 11. Code Review Rules

代码审查优先查找以下问题：

- 跨项目数据泄露、IDOR、鉴权或 CSRF 放宽；
- 跨模块 Repository 访问、反向/循环依赖、绕过 Workflow 的跨域写；
- 一个业务命令出现多个事务、事务中使用全局数据库 Client 或执行网络请求；
- 幂等、锁序、乐观锁、409 映射或数据库约束缺失；
- 手工修改生成客户端/OpenAPI，或 API 变更未同步权限与测试；
- 历史迁移被重写、业务历史被物理删除、Secrets 或敏感数据进入日志/仓库；
- 只依赖 Mock 而未验证真实 PostgreSQL 行为；
- 测试被跳过、弱化，或文档/ADR 与行为漂移。

格式化和纯样式问题交给自动化工具；审查意见应说明具体风险、触发条件和安全修改方向。

## 12. Definition of Done

只有同时满足以下条件才能声明完成：

- 用户目标和验收条件已满足，且没有夹带无关重构；
- 新行为、失败路径和回归路径有适当测试；
- 所有适用验证已通过，未执行或失败的检查被明确报告；
- API、客户端、数据库迁移和 lockfile 等派生产物无漂移；
- ADR、设计、权限矩阵、测试矩阵和运行文档已按行为同步；
- diff 已人工检查，不包含 Secrets、调试输出、临时文件或未经批准的依赖；
- [开发日志](./开发日志.md)已按本 PR 实际推送、验证和交付内容更新；
- 交付说明列出修改内容、验证证据、剩余风险和后续事项。

## 13. 基线冻结剩余事项

截至 2026-09-07，本轮评审已将创建者成员关系、写接口幂等范围和审计并发阈值转为本文件第 6、8 节的可执行规则，并分别落入 [ADR-012](./docs/adr/ADR-012.md)、[ADR-019](./docs/adr/ADR-019.md)、[ADR-008](./docs/adr/ADR-008.md)及[测试矩阵](./docs/test-matrix.md)；一次性认证流程的受控幂等例外见 [ADR-023](./docs/adr/ADR-023.md)，记录作废后恢复的状态与历史不变量见 [ADR-024](./docs/adr/ADR-024.md)，V1 搜索采用 PGroonga 的基线与阶段 0 证据见 [ADR-025](./docs/adr/ADR-025.md) 与 [PGroonga V1 PoC 结果](./docs/poc/search-pgroonga-v1-result.md)，NestJS 版本基线的阶段 0 兼容性门禁已完成并按 [ADR-026](./docs/adr/ADR-026.md) 定案为 11.2.3（替代 [ADR-003](./docs/adr/ADR-003.md)，验证证据见 [NestJS PoC 结果](./docs/poc/nestjs-11-vs-12-v1-result.md)）。ADR 编号冲突已由[唯一 ADR 索引](./docs/adr/README.md)消除：以技术设计的 ADR-001～ADR-020 为主线，系统设计新增的 CSP 与 ExternalLinks 决策顺延为 ADR-021、ADR-022，后续决策继续顺序编号。设计文档必须只引用该索引，不再维护相互冲突的编号正文。

开发基线仍不能宣告冻结，直至以下资料和门禁完成：

- 管理员完成 `CONTRIBUTING.md` 所列目标仓库设置；若 GitHub 方案不支持相应保护能力，须记录限制和替代人工门禁；
- 阶段 0 的技术验证、实际版本锁定和其余 CI 门禁通过：截至 2026-09-07，技术设计 §12.4 中 frozen lockfile 安装、lint、format check、typecheck、unit tests、空库迁移、真实 PostgreSQL 集成测试（含数据库角色/权限探针）、OpenAPI/客户端漂移检查、Route Registry/权限/响应 Schema 完整性、web/api 生产构建、依赖边界检查、权限矩阵检查与依赖/Secret 扫描已落库并在 `.github/workflows/ci.yml` 的 `CI / workspace` job 中按序执行。非数据库门禁已在本地实测通过；空库迁移与真实 PostgreSQL 集成测试曾在 `0000-0002` 上本地实测通过，但合并 `0003-0005` 后迁移与 `database/scripts/test-local.ps1` 均要求已安装 PGroonga 的 PostgreSQL 18 实例；本机 PostgreSQL 18.6 已内置 PGroonga 4.0.8，因此 `db:test:local`（`000_roles.sql` + `020_pgroonga.sql` + `0000-0005` 全量迁移 + database 单元/集成测试）与 API `test:integration` 均已在本地实测通过，CI 的 PGroonga 探针镜像仍作为可复现隔离门禁保留；仍缺 Playwright 完整关键路径 E2E（测试基座已落库）、生产容器镜像构建、exact-tag/digest 格式校验、镜像扫描（`deploy/compose.yaml` 与 ref 预检 `pnpm check:deploy` 已落库、CI 已加 compose 渲染与占位符拒绝门禁，但生产 Dockerfile 与真实 digest 未定案，只有 PoC/CI 探针镜像 Dockerfile），以及 Drizzle 与 Nginx 实际补丁与镜像 digest 锁定；[ADR-027](./docs/adr/ADR-027.md) 已转为 `Accepted`（2026-09-07，见该文件接受记录）。
- 2026-09-08：C 在本地完成搜索页面最小纵切片并同步 README、测试矩阵、前端契约说明与本日志；前端 typecheck、单测（10 文件 24 例）、依赖边界、构建、迁移/契约/权限/Secret/文档检查通过；`pnpm check` 仅因当前 npm 镜像无 audit endpoint 失败，公共 registry 单独审计无漏洞；GitHub Actions 尚未执行，真实登录态尚未接入。
- 2026-09-08：C 在本地完成 `SearchProjectionWritePort`（独立 `SearchProjectionModule`、显式 `TransactionContext` upsert、输入校验、文本规范化与 `source_row_version` 防旧写）；API 单测与真实 PostgreSQL 集成、类型检查、契约、构建、依赖边界、权限、Secret 与文档检查通过；`pnpm check` 同样仅因本地 npm 镜像无 audit endpoint 而在 `deps:audit` 中断，公共 registry 单独审计无漏洞；GitHub Actions 尚未执行。
- 2026-09-08：C 在本地完成 F-27 项目动态与 F-28 站内通知读写纵切片；同步 README、权限矩阵、测试矩阵、前端契约说明、开发日志与 AGENTS 状态；API 单测、真实 PostgreSQL 集成、前端单测与构建、类型检查、契约/权限/依赖边界/Secret/文档门禁均通过，`pnpm check` 因本地 npm 镜像无 audit endpoint 失败但公共 registry 审计无漏洞；GitHub Actions 尚未执行，业务 Workflow 尚未接入活动/通知写端口。

- 阶段 1 F-25/F-29/F-32 契约裁决已本地落库（A）：新增 [A 的契约评审裁决](./docs/a-contract-review-f25-f29-f32.md)，裁决 C-003（已接受，转具体 Route）与 C-010（已接受，转具体 Route 后关闭）以及 C 提交的 Q-01 ~ Q-15；三条候选路由进入正式契约，并按 Q-02 新增记录子资源路由，共四条：`getTaskGroup`、`getProjectOverview`、`listMyTasks`、`listTaskGroupRecords`，路径、operationId、状态码与只读策略全部冻结；跨域读归属裁定为「B 域单条 SQL 稳定只读端口加 C 聚合读服务」，拒绝直读他域业务表（路线 III）与依赖环（路线 I）两条路线，路线 IV 留待后续；同步回填上游清单 §4.8.1 / §6 / §7 与两份 C 提案（聚合契约提案、端口扩展提案）。本轮为文档裁决：未改任何代码、迁移、契约源或生成物，未运行代码类门禁；四条路由尚未登记 Route Registry——登记、权限矩阵、测试矩阵、OpenAPI 与生成客户端必须与实现同一个 PR 落库（依赖 B 的只读端口扩展），在此之前仍不是实现依据；工作书 F-32 步骤 1 的处方偏差需非作者人工确认。

- 阶段 1 F-29/F-32 第二轮契约裁决已本地落库（A）：回应 B 在 PR #98 后反馈的契约缺口与 `TaskItem.groupRole`。裁决 [A 的契约评审裁决](./docs/a-contract-review-f25-f29-f32.md) §10 接受 R-2 `activeLeftoverTotal` 与 `LeftoverItemSummary.recordTitle`、R-3 列表项 `priority` / `dueAt` / `completedAt` / `creatorId` / `githubLinkCount` / `groupId` 与 `stats` / `leftoverCount` / `leftoverSample`、筛选参数 `priority` 与 `includeCanceled`；拒绝列表返回 `description`；延后 `scopeCounts`、`relation`、`query` 与 `scope=created/all`。`TaskItem.groupRole` 不在 B 的任务读写路由扩字段（会形成 TasksModule 与 TaskGroupsModule 依赖环），改为新增 C 侧只读路由 R-5 `GET /api/v1/task-groups/memberships`（`listTaskGroupMemberships`）。本轮只做裁决与台账同步：未改代码、迁移、契约源或生成物，未注册路由；实现必须与 A 的契约登记、权限矩阵、测试矩阵、OpenAPI 与生成客户端同一个 PR 落库，`priority` / `includeCanceled` 需补 `EXPLAIN` 证据。

- 备份调度生效时机已裁定（A，2026-09-11）：定时备份（宿主每 12 小时加密备份、排除 Session、SHA-256/签名清单、异机保留与失败告警）是生产上线门禁项，上线时才启用；上线前不部署、不运行定时备份任务，`deploy/compose.yaml` 的 `operations` profile 保持未发布。同时修正文档内备份频率不一致：技术设计 §1.3、系统设计部署表与技术设计 §10.4/§11.5/§12 统一为与 ADR-020 一致的至少每 12 小时，未改动 ADR-020 决策。本轮仅文档变更，未改代码、迁移、契约源或生成物。

- 阶段 0 F-10 备份调度配置与 Runbook 已本地落库（A）：新增 `deploy/backup/`（`backupctl.sh` 宿主控制器 + `inpulse-backup`/`inpulse-backup-alert@`/`inpulse-backup-watchdog` systemd 单元与定时器 + `backup.env.example` 非敏感配置示例）与 `docs/runbooks/backup-restore.md`、`docs/runbooks/upgrade-rollback.md`；启用流程要求 `--confirm-go-live` 与全新主机恢复演练证据（fail closed），`run` 以 `flock` 串行化并执行 `docker compose --profile operations run --rm backup`，staleness 默认 18 小时、每小时 watchdog，告警 Webhook 只从受限文件读取且不进进程参数与日志；`scripts/check_deploy_refs.mjs` 新增 9 项备份资产与调度不变量静态校验（12 小时/每小时节奏、`Persistent`、`flock`、go-live 门禁与 `enabled-at` 启用基线、`*_FILE` 凭据、禁止 `--profile operations up`、`backup`/`audit-archive` 必须 `profiles: [operations]`）；本地 `pnpm check:deploy:test` 退出码 0、`bash -n deploy/backup/backupctl.sh` 通过；未运行：真实主机 systemd 安装、真实告警投递、全新主机恢复演练与 GitHub Actions；`backup`/`audit-archive` 服务本体（F-10.3）与真实镜像 digest 签名发布清单仍未交付。

- 阶段 1 F-25/F-29/F-32 第二轮契约扩展与 R-5 已本地落库（A）：R-2 `getProjectOverview` 增加 `activeLeftoverTotal` 与 `LeftoverItemSummary.recordTitle`；R-3 `listMyTasks` 列表项增加 `priority` / `dueAt` / `completedAt` / `creatorId` / `githubLinkCount` / `groupId`，响应增加 `stats`（`myOpen` / `dueToday` / `overdue` / `completedThisMonth`，Asia/Shanghai 日/月界由服务端计算）/ `leftoverCount` / `leftoverSample`（200 字符截断），筛选增加 `priority` 与 `includeCanceled`（`TODO ∪ CANCELED`）；新增 R-5 `GET /api/v1/task-groups/memberships`（`listTaskGroupMemberships`，`taskIds` 逗号分隔 1..100 正整数、422 校验，只返回授权项目内 `ACTIVE` 组关系、不泄露存在性）。契约、Route Registry、权限矩阵、测试矩阵、OpenAPI、生成客户端与服务端实现同一 PR 落库；`pnpm contract:validate`（94 条）、`pnpm contract:drift`（5 产物）、`pnpm permissions:check`（94/94）、API 单测 66 文件 343 例、真实 PostgreSQL 集成 47 文件 407 例（聚合读 19/19）、Web 58 文件 248 例、全 workspace typecheck 通过；`priority` / `includeCanceled` 的 `EXPLAIN (ANALYZE, BUFFERS)` 证据（30,481 行、反向主键索引扫描、非顺序扫描）已写入测试矩阵。C 侧 R-5 前端接线、F-29 / F-32 适配器降级项替换与 Playwright 关键路径仍待交付；`description` / `scopeCounts` / `relation` / `query` / `scope=created|all` 保持拒绝或延后。

- 阶段 0 F-26 搜索结果「遗留问题」独立分类已本地落库（A）：新增迁移 `0006_leftover_search_entity.sql` 把 `search_projection_entity_type_check` 扩展为 8 类；新增 `LeftoverSearchProjectionSync`，在记录发布/修订（`RecordPublicationEffects`）、作废/恢复（`RecordLifecycleService`）与遗留项转任务（`LeftoverTaskWorkflow`）的同一事务内按遗留项最新版本 `content_snapshot` 刷新 `LEFTOVER` 投影：`entityId` 为遗留项 ID、title 至多 500 字符、summary 标注处置状态（待处理/已解决/已转为任务）与来源记录、可见性跟随父记录（PUBLISHED=MEMBER、VOID=ADMIN_ONLY）、`sourceStatus` 为遗留项状态、`sourceRowVersion` 防旧写；搜索页面与命令面板新增「遗留问题」分组。本地验证：API 单测 66 文件 343 例、真实 PostgreSQL API 集成 47 文件 408 例、Web 58 文件 249 例、`pnpm db:test` 26 例、Playwright E2E 43/43，lint/format/typecheck/build/契约（94 条）/权限（94/94）/迁移（7 个）/Secret/文档/部署/依赖边界与公共 registry 审计全部通过；GitHub Actions 未执行。用户反馈的 A 缺口清单中 F-26 项关闭；F-08 的审计读取留痕与远端 WORM 归档仍待交付。

- 阶段 1 ADR-033 项目内角色（组长与项目管理员）已本地落库（A+C，未提交）：按用户要求「创建项目的人是项目小组组长，可以进行成员添加、归档模块、删除模块（逻辑归档），或让其他成员成为该项目管理员，权限只存在于被赋予的项目中」交付完整纵切片——[ADR-033](./docs/adr/ADR-033.md)（[ADR-012](./docs/adr/ADR-012.md) 转 Superseded）、迁移 `0015_project_member_roles.sql`（`project_members.role` + 枚举 CHECK + `project_members_one_leader` 部分唯一索引 + `project_members_removed_role_check` + 创建者回填 LEADER）、契约新增 `setProjectMemberRole` 路由与 `ProjectMemberRecordItem/ProjectMemberItem.role`、`ProjectDetailResponse.currentUserRole`（98 条路由，受影响路由 `authPolicy` 由 `adminSession` 调整为 `session`、幂等契约版本按重放字段升级）、后端 `ProjectRoleGateService` 同事务实时角色门禁（成员管理与模块归档/恢复：系统管理员/本项目 LEADER/PROJECT_ADMIN 允许、普通成员 403、非成员 404；组长不可被移除 409；系统管理员转移组长时同事务自动降级原组长；`removeMember` 同事务重置 role）、前端成员页角色徽标与「设置角色」弹窗（组长仅 MEMBER/PROJECT_ADMIN，系统管理员含 LEADER）、成员页入口按 `currentUserRole` 分流、模块/功能页归档入口按角色放开（功能归档仍仅系统管理员）；功能设计/系统设计/技术设计、权限矩阵与 `docs/permissions.md`、测试矩阵同步。本地验证：契约 generate/drift/validate（98 条）、permissions:check（98/98）、lint、format:check、全 workspace typecheck、check:deps（173 文件）、check:frontend:boundaries（248 模块）、db:migrations:check（16 迁移）、check:secrets（1002 文件）、API 单测 64 文件 351 例、Web 单测 76 文件 425 例、web/api 生产构建、真实 PostgreSQL 18.6 + PGroonga 下 API 集成 48 文件 444 例（含 ADR-033 角色矩阵新用例）与 database 单测 15 + 集成 26 全部通过；Playwright E2E、GitHub Actions 与 `deps:audit` 未运行；`check:docs` 仅因仓库根目录历史遗留未跟踪 `.tmp-*.diff` 文件失败（非本批文件）。本批未提交、未推送，等待用户评审。附带环境修复（不入库）：本机系统缺失 VC++ 运行库导致 `@node-rs/argon2` 原生模块加载失败（Win32 126），已在 node_modules 平台包目录补齐 `vcruntime140*.dll`/`msvcp140.dll` 恢复本机测试能力。
  完成一项后应在同一 PR 中更新本节并链接对应证据，避免保留已经解决的阻断描述。

- 2026-09-10 F-21 已本地交审：管理员记录作废/恢复、双时间戳重认证（含锁后复核）、原因/If-Match/数据库幂等、管理员VOID读取/发现及同事务审计/Activity/Search；版本、最近作废快照、遗留项及转换链接保留，无通知或迁移。真库四文件63/63、契约42/42、Web7/7、86路由/权限与5生成物漂移通过；Edge F21 1/1及相邻F18 2/2分别通过，未执行本批CI。代码 9b5805805bbee6f0ff964fba75d5732701570943，范围与失败历史见 [F-21交审说明](docs/f21-local-handoff.md)。

- 阶段 0 F-08 审计远端归档（步骤 6）已本地落库（A）：新增 `packages/canonical-json`（把 `canonicalizeJson` 从 `apps/api/src/idempotency/jcs.ts` 提取为共享包，API 幂等摘要、审计写与 ops 归档共用）与 `apps/ops`（`audit-archive` CLI：`checkpoint`/`export`/`both`/`verify`；自研 SigV4 最小 S3 WORM 客户端（PUT/GET、对象锁头、409/412 幂等、5xx 退避）；AES-256-GCM 明细导出与 HKDF-SHA256 子密钥派生；`<version>:<64hex>` 归档签名 keyring；`audit_archive_writer` 只读连接；生产凭据只走 `WORM_CREDENTIALS_FILE`/`ARCHIVE_SIGNING_KEY_FILE` 并 fail closed）；`deploy/compose.yaml` 新增 operations `audit-archive` 服务与 `db_audit_archive_password`/`audit_worm_credentials`/`audit_archive_signing_key` Secret（`OPS_IMAGE_REF` 加入发布清单必需 ref）；`deploy/backup/audit-archivectl.sh` + 每小时检查点与每日导出 service/timer + `audit-archive.env.example`，与备份调度共用告警单元与 go-live 门禁；`docs/runbooks/audit-archive.md` 交付启用/验证/失败处置；`scripts/check_deploy_refs.mjs` 新增审计归档资产与调度不变量校验。本地验证：`pnpm --filter @inpulse/ops test:unit` 7 文件 36 例、`test:integration` 4/4（真实 PostgreSQL）、typecheck、lint、格式、`check:deploy:test`（5 refs）、`check:deps`（604 文件）通过；未运行：真实 S3/Object-Lock 端点联调、真实主机 systemd 安装、GitHub Actions；`backup` 服务本体（F-10.3）仍未交付。

- 阶段 1 A-1 `operations/backup` 服务本体与镜像入口已本地落库（A）：新增 `apps/ops` 备份实现（`src/backup.ts` 流式 `pg_dump --format=custom --no-owner --no-acl --exclude-table-data=app.user_sessions|session_csrf_tokens|preauth_sessions` -> AES-256-GCM（HKDF-SHA256 派生 `inpulse-backup-encryption-v1` 子密钥）-> 明文/密文 SHA-256 -> `.partial` 原子重命名 -> AES-GCM 自校验 -> HMAC-SHA256+JCS 签名清单（含 DB 版本、迁移版本、审核链头锚点、Git SHA、镜像 ref）-> 异机 S3 兼容 WORM 上传（对象锁 ≥30 天）与本机 7 天保留；`src/backup-cli.ts` 提供 `backup`/`verify` 子命令，失败统一 `inpulse-backup:` 前缀）；`deploy/compose.yaml` 新增 operations `backup` 服务（非 root 10002、只读根、/backup 加密卷、`BACKUP_GIT_SHA`/`BACKUP_IMAGE_REF` 由发布清单注入，生产缺失即 fail closed）与 `db_backup_password`/`backup_encryption_key`/`offsite_credentials` Secret；新增 `deploy/docker/ops.Dockerfile` 生产镜像（PostgreSQL 18.6 客户端固定 `18.6-1.pgdg12+2`，供 pg_dump/pg_restore，CI 构建与 Trivy 扫描），并把 API/Migration/Ops 三镜像的 `pnpm deploy --legacy` 改为 `--config.node-linker=hoisted`，修复运行树把 workspace 包符号链接指回不存在 `/workspace` 导致镜像内模块解析失败的缺陷；新增迁移 `0007_backup_role_pg_dump_grants.sql`：实测 `pg_dump` 快照开始时对 dump 范围全部表加 ACCESS SHARE 锁，与「`app_backup` 显式无会话表 SELECT」不可兼得，故补表级 SELECT 与序列只读（数据仍由 `--exclude-table-data` 排除，无写权限/无 DDL），该设计冲突按仓库规则留待非作者评审定案；`scripts/check_deploy_refs.mjs` 把 ops Dockerfile、operations 服务 Secret 长语法与 runtime 工具链删除纳入校验。本地验证：`@inpulse/ops` 单测 8 文件 52 例、集成 2 文件 7 例（真实 PostgreSQL + 真实 pg_dump/pg_restore：备份、清单、WORM 桩上传、恢复演练后会话表为空/迁移与业务行存在）、数据库集成 26 例、`pnpm check:deploy:test`（5 refs）退出码 0、ops 镜像本地构建成功且容器内 `pg_dump 18.6`、非 root 10002、缺 Secret fail closed 已验证；未运行：真实 S3/Object-Lock 端点与 systemd 启用、真实全新主机恢复演练、GitHub Actions。

- 阶段 1 A-7 契约修订 D-1 已本地落库（A）：R-3 `MyTaskItem` 增加 `publishedRecordCount`（与 `hasPublishedRecord` 同源同口径，恒有 `hasPublishedRecord === (publishedRecordCount > 0)`）；R-5 `listTaskGroupMemberships` 由「聚合组成员关系」扩为「任务记录标记批量读」——条目为 `{ taskId, groupId, groupRole, publishedRecordCount }`，`groupId` / `groupRole` 改为可空，请求中每一个有权 taskId 都出现（未入组以 null 返回且计数照常），无权或不存在（含跨项目）仍不出现；`TaskGroupMembershipQueryService` 改为 `TaskQueryPort.listByIds` 求有权集合后，经 `TaskGroupMembershipReadPort.listGroupRoles` 与 B-7 的 `ChangeRecordReadPort.countPublishedByTask` 补齐关系与计数，空授权范围短路不发后续 SQL；Route Registry summary、权限矩阵、OpenAPI、生成客户端与测试同一 PR 同步。本地验证：契约漂移 / 校验 / 权限（5 产物、97 路由、97/97）、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm test:unit`（api 68 文件 351 例、web 64 文件 293 例、ops 8 文件 52 例）、真库 `apps/api/test/aggregate-read-api.integration.test.ts` 19/19 与 `apps/api/test/aggregate-read-ports.integration.test.ts` 17/17、全量 API 集成 49 文件 428 例均通过；`EXPLAIN (ANALYZE, BUFFERS)` 断言加强为 ANALYZE 实测输出（`actual time`）。GitHub Actions 尚未执行；R-5 的 `groupId` / `groupRole` 可空是破坏性契约变更，C-1 接线前必须先判 null。分支 `feature/a7-contract-d1`，见 [开发日志](./开发日志.md) 2026-09-11 A 条目与 [测试矩阵](./docs/test-matrix.md) A-7 章节。

- 阶段 1 A-2 未裁决契约项（C-001 / C-004 / C-005 / C-007 / C-008）已本地落库（A）：新增 [A 的契约评审裁决](./docs/a-contract-review-frontend-consumption.md)，五项全部定案——C-001 生成客户端输出位置冻结为 `apps/web/src/generated/api/`（`packages/api-contract` 只放 Schema / Route Registry、生成器与 OpenAPI 产物；技术设计仓库结构“客户端”修订为“客户端生成器”）；C-004 `details` 保持开放对象并冻结保留键 `issues` / `reason` 与空对象约定（FC-031 判别联合延后，恢复条件见裁决 §3.2）；C-005 冻结 `CSRF_ORIGIN_REJECTED` / `CSRF_TOKEN_INVALID` / `MFA_CSRF_REJECTED` / `ADMIN_CSRF_REJECTED` 四码，禁止用 `FORBIDDEN` 表示 CSRF 失败；C-007 生成客户端不做运行时 Schema 校验（只做类型映射 + 最小形状契约）；C-008 `message` 是稳定诊断文案、前端只按 `code` 分支。[error.zod.ts](./packages/api-contract/src/contracts/error.zod.ts) 四字段补 `description` 并随 `pnpm contract:generate` 同步 OpenAPI；`generation.test.ts` 新增 C-007 断言。本地验证：`contract:generate` / `contract:drift`（5 个产物）/ `contract:validate`（97 条路由）/ `permissions:check`（97/97）、`lint`、`format:check`、`typecheck`、`test:unit`（api-contract 94 例、api 68 文件 351 例、ops 8 文件 52 例、web 通过）、真库 `pnpm --filter @inpulse/api test:integration` 49 文件 428 例（三次连续全绿；最早一次运行出现一次不可复现失败，已记录）、`check:docs`（74 个 Markdown）、`check:secrets`（928 文件）均通过。GitHub Actions 尚未执行；FC-031 判别联合与逐路由 `details` Schema ref 为明确延后项。

- 阶段 1 A-3 `compose.init` 首次建库纵切片与灾难恢复离线 Runbook 已本地落库（A）：新增版本化一次性覆盖 `deploy/compose.init.yaml`（仅该次向 db 服务设置 `POSTGRES_DB=app` / `POSTGRES_USER=cluster_bootstrap` / `POSTGRES_PASSWORD_FILE`，只读挂载 bootstrap / migrator / runtime / backup / audit_reader / audit_archive 六份密码 Secret，target `/run/secrets/db_*`、mode 0400、uid/gid 999），新增 [灾难恢复离线 Runbook](./docs/runbooks/disaster-recovery.md)（离线材料清单、镜像 digest 校验、建库与角色探针、数据恢复、Session 处理、迁移与完整校验、RPO/RTO 门禁与故障处理；`backup-restore.md` §7 与 `database/README.md` 同步引用）；`database/bootstrap/010_passwords.sql` 容器内 Secret 路径对齐稳态命名 `db_*`（`database/.env.example` 同步）；`scripts/check_deploy_refs.mjs` 渲染 overlay 并静态保证稳态渲染不含 POSTGRES_* 与 db_bootstrap_password、六份 Secret 只挂 db、migrate/api/web/backup/audit-archive 从不挂 bootstrap、`.env.deploy.example` 占位符被拒；本地 Docker（Compose v5.5.0）实测构建 db-bootstrap 镜像后 overlay 首次建库（initdb 与 `000_roles.sql` / `010_passwords.sql` / `020_pgroonga.sql` 无报错、healthy）、角色/扩展探针（7 角色 NOLOGIN/LOGIN 与最小权限、`app_runtime` 密码登录且 `SET ROLE app_owner` 被拒、`pgroonga` 存在）、切回稳态 Compose 接管（同卷 healthy）；`pnpm check:deploy:test`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm check:docs`（75 个 Markdown）、`pnpm check:secrets` 本地通过；GitHub Actions 尚未执行；真实主机恢复演练（RECOVERY-001 / DEPLOY-003）仍属上线门禁。
- 阶段 1 A-4 SEC-003 CSRF 完整生命周期 E2E 已本地落库（A）：新增 `apps/api/test/csrf-lifecycle.integration.test.ts`（真实 PostgreSQL 与完整 AppModule HTTP：错误 CSRF 登录不消费预认证材料、重签后重试一次成功且成功即单次消费（重复登录 409/401）、认证 Session 最多保留 4 个 CSRF 并淘汰最旧、认证 Session 与预认证材料过期后重签恢复、登录不写 `app.idempotency_records` 且模块创建缺 `Idempotency-Key` 返回 400）；新增 `apps/e2e/tests/csrf.spec.ts`（Playwright：首登后 `__Host-preauth` 清除与 `__Host-session` HttpOnly/Secure/SameSite=Lax 属性、`GET /auth/csrf` 与 login 不发送业务幂等键、刷新后写操作重新签发 CSRF、多标签各自签发并独立写成功、模块编辑 PATCH 携带 `If-Match`/CSRF/幂等键）；本地验证：集成 4/4、E2E 4/4、`pnpm build`、`apps/e2e` typecheck、`pnpm format:check`、`pnpm check:docs` 通过；GitHub Actions 尚未执行。
- 阶段 1 项目主页恢复与「系统目录」导航（C，2026-09-14 本地落库）：上一轮目录改造（`codex/project-tree-nav`，未合并）把项目主页入口让给新建的只读复刻页（`/explorer` 重实现，从未进入任何提交），产品反馈项目主页面「严重丢失了好多功能和效果」并澄清「目录应该影响的是这个页面而不是新建页面」。本轮改为**目录只做导航**：新增 `apps/web/src/features/project-tree/`（`ProjectTree.tsx` 复用既有 `useProjectDetail` / `useModules` / `useFeatures` 与生成客户端渲染三级树；`tree-selection.ts` 的 `treeScopeOf` / `treePath` 负责选中层级与既有页面映射），在 `AppLayout` 既有 `nav[aria-label="工作区导航"]` 内新增「系统目录」分组（仅项目目录路径渲染），系统 / 模块 / 功能分别落到项目主页 `/projects/{p}/modules`、功能目录 `/projects/{p}/modules/{m}/features`、功能档案 `.../features/{f}`；删除只读复刻页与 `/explorer` 路由，项目卡片入口保持 `onOpenModules` → 项目主页；无新增路由、无 API / 契约 / 权限 / 迁移改动。本地验证：`project-tree` 2 文件 7 例与 `AppLayout.test.tsx` 新增 2 例、`pnpm test:web` 73 文件 399 例、`pnpm typecheck`（8 个 workspace）、`pnpm build`、`pnpm check:frontend:boundaries`（244 模块 / 1146 依赖）、`pnpm lint`、`pnpm format:check`、`pnpm check:docs`（75 个 Markdown）通过，真实浏览器人工复验三级目录分别驱动既有页面；**尚无目录树的 Playwright 用例**（E2E 覆盖待补），整链 `pnpm check`（本机 npm 镜像缺 audit endpoint）与全量 `pnpm test:e2e` 未运行，GitHub Actions 尚未执行；详见测试矩阵「项目主页目录树恢复」条目。 PR [#140](https://github.com/256-code/InPulse/pull/140) 首轮 CI 的 Browser E2E 暴露目录树节点与功能档案动作按钮的可访问名冲突：`features.spec.ts` 用例新建的功能名 `归档功能-<时间戳>` 同时命中树节点按钮与功能档案页的「归档功能」动作按钮（Playwright strict mode），已把该用例的动作按钮查询限定到 `page.getByRole` 的 `main` 主内容区，并在本地以 `E2E_DATABASE_URL=postgresql://cluster_bootstrap@127.0.0.1:55432/app`、`E2E_API_PORT=3188`、`E2E_WEB_PORT=4188` 复跑 `features.spec.ts` 2 passed（22.9s）；本轮为选择器作用域修正，产品行为与断言强度均未变。

## 2026-09-14 ADR-030 当前分支说明

项目与任务流程按用户确认的 ADR-030 修订：新项目不自动创建未分类模块；保留旧模块历史并新增项目内模块编号；支持任务/新模块/新功能同事务创建；当前项目成员只读、任务中心授权范围/逾期分页、功能验收标准、草稿详情及根仓库入口同步。迁移 `0010`–`0012`、契约、生成客户端、权限和测试矩阵已同步。历史模块编号回填后须在同一迁移内 `SET CONSTRAINTS ALL IMMEDIATE` 清空延迟事件，再修改模块表约束。联合创建先取得项目排他锁再进入各域 CommandPort，避免编号序列与审计锁交叉等待。

本轮仅进行了相关前端交互、服务层、真实 PostgreSQL 18.6/HTTP 回归和历史升级探针。遵循用户对本任务的限制，不执行全量构建、静态检查、依赖审计；不声明完整 CI 或浏览器 E2E 已通过。遗留问题转任务不属于本次修改范围。

## 2026-09-15 ADR-031 TOTP 验证移除说明

按用户明确要求，本期移除全部 TOTP 验证（连管理员高风险重认证一并取消），并以 ADR-031 取代 ADR-016；数据库本期只停用不删除（保留 `user_totp_factors`、`mfa_recovery_codes` 表与 `user_sessions.mfa_verified_at` 等列），后续 contract 迁移再删。因此：

- 登录只做密码验证（Argon2id + 登录限流），成功后直接签发自 `AUTHENTICATED` 的完整认证 Session 与新 CSRF；不存在 MFA 注册/验证/恢复码挑战与受限 Session。
- 管理员高风险操作（`listAdminUsers`/`createUser`/`updateUser`/`disableUser`/`enableUser`、`getAuditLogs`、`getProjectArchivePreview`/`archiveProject`/`restoreProject`、`archiveModule`/`restoreModule`、`archiveFeature`/`restoreFeature`、`addProjectMember`/`removeProjectMember`、`voidChangeRecord`/`restoreChangeRecord`）只要求当前有效的完整管理员 Session、`is_admin`、写操作 CSRF 与数据库级幂等；不再要求管理员密码 + TOTP 重认证，错误码收敛为 401 `ADMIN_SESSION_REQUIRED`、403 `ADMIN_REQUIRED` 与 401 `ADMIN_CSRF_REJECTED`。
- 删除 7 条 MFA 认证路由后 Route Registry 为 95 条；`securityFlow` allowlist 收敛为 `issueCsrfToken`/`login`/`logout` 三条。
- 管理员最后一名保护由「最后一名可用 MFA 管理员」改为「最后一名可用管理员」（`LAST_ACTIVE_ADMIN_REQUIRED`）。
- 本文件上文历史条目中出现的 TOTP/MFA/重认证描述均为当时事实，与本节冲突时以 ADR-031 与本节的现行规则为准。

## 2026-09-15 ADR-032 Casdoor 单点登录接入说明

按用户明确要求，InPulse 接入立镖公司 Casdoor OIDC 单点登录（ADR-032），口令入口降级为管理员应急通道。因此：

- `/login` 默认整页跳转到 `/api/v1/auth/sso/start?returnTo=...`（查询参数名必须与契约 `SsoStartQueryRequest` 一致），回调 `/api/v1/auth/sso/callback` 成功后复用与口令登录同一实现签发本地 Session；`securityFlow` allowlist 由三条扩为五条，Route Registry 为 97 条路由。
- 数据库迁移 `0013_sso_login.sql` 新增 `users.sso_subject`（部分唯一索引 + 绑定后不可改写触发器）、允许 `password_hash` 为空，并新增 `app.sso_login_attempts`；历史迁移不得修改。
- 本地会话空闲有效期由 8 小时收紧为 30 分钟，口令与 SSO 共用 `SESSION_TTL_POLICY`（`SESSION_IDLE_MAX_AGE_SECONDS` 可覆盖），绝对有效期仍为 7 天。
- 生产 Secret 为 `/run/secrets/sso_client_secret`（由 `SSO_CLIENT_SECRET_FILE` 指定）；本地与集成测试只允许 `NODE_ENV=test` 且 `SSO_CLIENT_SECRET_TEST_PATH=1` 时读取临时路径。
- 新增覆盖：`sso.config.test.ts`、`sso-oidc.client.test.ts`、`sso.controller.test.ts`、`sso-return-to.test.ts`、`session-ttl.policy.test.ts`、`sso-login.integration.test.ts`（真实 PostgreSQL + 桩 IdP）以及登录页单测与 E2E 用例。
- 迁移 `0014_sso_backup_grants.sql` 为 `app_backup` 补齐 `app.sso_login_attempts` 的表级 SELECT 与序列 USAGE/SELECT（pg_dump 一致性快照必需，与迁移 0007 同源），并把 `app.sso_login_attempts` 加入 `apps/ops/src/backup.ts` 的 `BACKUP_EXCLUDED_TABLE_DATA`：该表只保留结构、数据不进备份产物。新增表进入备份范围按 fail closed 处理——必须显式补一条备份授权迁移，不得改成 `ALTER DEFAULT PRIVILEGES` 默认授权（例外须新增 ADR）。
- 本轮联调修复（均为真实缺陷，已落库）：① `apps/api/src/auth/auth.module.ts` 与 `sso-login.service.ts` 曾从 `audit/index.js` barrel 引入 `AuditWritePort`，与 `AuditLogReadModule -> AuthModule` 形成循环依赖，导致整个 `AppModule` 初始化时 Nest 拿到 `undefined` 并以 `process.abort()` 崩溃（8 个 API 集成测试文件直接退出）；改为直接引用 `audit/audit.port.js`，该循环由 `pnpm check:deps` 的 `[circular-dependency]` 拦住；② `apps/web/tools/vite-csp.ts` 的 dev/preview CSP 中间件原先会短路所有无扩展名且 `Accept: text/html` 的请求，把浏览器整页导航到 `/api/v1/auth/sso/start` 的请求当成 SPA 入口返回 `index.html`，使 SSO 回落在本地预览里自跳转成环（URL 与请求头超限后返回 431）；新增 `isApiPath` 放行 `/api/**` 交给代理，E2E 复跑 56/56；③ `sso.config.ts` 的回调地址变量由 `SSO_REDIRECT_URL` 更名为 `SSO_REDIRECT_URI`（与 OIDC `redirect_uri` 术语一致），因为 `scripts/check_secrets.mjs` 把所有 `*_URL` 键视为必须指向 `/run/secrets/*` 的敏感变量，改名避免误判而不放宽门禁。
- 本文件上文历史条目中出现的 8 小时空闲超时、三条 `securityFlow` 等描述为当时事实，与本节冲突时以 ADR-032 与本节的现行规则为准。

## 2026-09-16 ADR-034 项目归档申请与任务归档说明

按用户确认的口径（项目归档保留「双方同意」，但审批权只归总管理员）把项目归档改为「申请—审核」，并同步确定任务归档与父级归档前置校验。实现细节与边界见 [ADR-034](./docs/adr/ADR-034.md)。

- 项目组长（LEADER）、项目管理员（PROJECT_ADMIN）与系统管理员可发起项目归档申请，普通成员 403；但只有系统管理员能批准真正归档或驳回申请，申请权与审批权分离。
- 拦截口径只针对任务，且以「已收尾」为准：项目归档的申请与批准、模块归档都要求作用域内不存在 `lifecycle_status = 'ACTIVE'` 且 `work_status = 'TODO'` 的任务（已完成、已取消与已归档都算收尾），否则分别 409 `PROJECT_ARCHIVE_TASKS_OPEN` 与 `MODULE_ARCHIVE_TASKS_OPEN`；功能不需要归档，也不作为任何一级的归档拦截条件。
- 任务新增归档/恢复命令（`archiveTask`/`restoreTask` 与模块级 `archiveModuleTask`/`restoreModuleTask`），只切换 `tasks.lifecycle_status`，权限为系统管理员、本项目组长或项目管理员，普通成员 403 `TASK_ARCHIVE_FORBIDDEN`；不写 `task_status_history`，不改变完成统计口径，同事务写审计、活动与搜索投影。
- 归档命令的父级口径：项目必须 ACTIVE；模块或功能已归档时**仍允许归档其任务**（收尾动作），否则「先归档功能→其任务无法归档→模块下永远存在 ACTIVE 任务」会锁死模块归档。恢复仍要求模块与功能父级链全部 ACTIVE。HTTP 幂等解析阶段与 `execute` 使用同一口径。
- 任务归档/恢复入口与模块、功能一致，只放在任务编辑弹窗底部（`data-testid=task-modal-lifecycle`，文案「归档」/「恢复」），普通成员不可见；409 文案带未收尾任务数量并指引到该入口。父级已归档、任务只读时该弹窗对有归档角色的用户仍可打开（表单只读）。
- 迁移 `0016_project_archive_requests.sql`（新表、枚举 CHECK、部分唯一索引、origin guard 触发器与 `app_runtime` 授权）；`docs/permissions.md` 已同步新增项目归档申请、批准、驳回与任务归档、恢复条目。
- 功能归档/恢复（界口语「删除功能」）与任务、模块归档同一口径，自 ADR-034 起由系统管理员、本项目组长或项目管理员执行，普通成员 403 `FEATURE_MANAGE_FORBIDDEN`；前端入口与模块弹窗一致，只放在「编辑功能」弹窗底部（文案「归档」/「恢复」），卡片与详情页头只对已归档功能保留「恢复功能」；功能不参与任务归档前置校验，归档功能只要求项目与父模块 ACTIVE。
- 本文件与三份基线设计文档中「项目归档由系统管理员单方执行」的历史描述为当时事实，与本节冲突时以 ADR-034 与本节的现行规则为准。
- 2026-09-17 前端改动免测试（项目负责人指示）：只改前端（`apps/web`）且不涉及后端、契约、权限与数据库时，不再运行任何测试与门禁命令（含定向 vitest、`pnpm test:web`、Playwright、`pnpm check` 等），改动完成即交付；是否补跑由项目负责人决定。
- 2026-09-17 测试数据必须清理（项目负责人指示）：每次跑完会落库的测试（Playwright E2E、真实 PostgreSQL 集成等）后必须删除测试数据，不得在本地或共享开发库留下夹具项目、夹具用户及派生数据。Playwright 的 `global-teardown` 已改为按 `e2e_` / `f03_` 账号前缀自动物理清理夹具（`apps/e2e/helpers/fixture-cleanup.ts`：按依赖序删除业务表、`PROJECT:` 审计链、悬空审计行与夹具账号，回退被清空的 SYSTEM 链头，并复核夹具残留为 0、项目 bootstrap 成员关系与每项目唯一 UNCLASSIFIED 模块不变量，断言失败即回滚）；运行被中断未触发 teardown 时用 `pnpm --filter @inpulse/e2e cleanup` 或 `node apps/e2e/helpers/fixture-cleanup.ts` 手动补跑（需要 `E2E_DATABASE_URL` / `TEST_DATABASE_URL` 的 bootstrap 角色）。清理以 `session_replication_role = replica` 关闭行级触发器执行（UNCLASSIFIED 禁删触发器会阻止删除夹具项目），该开关仅限测试夹具清理，业务代码不得使用；SYSTEM 链若在夹具记录之后已有真实写入会留下一个可检测的断点，清理报告会提示。

## 2026-09-18 ADR-036 登录入口调整说明

按用户要求把登录页默认入口从「自动整页跳转统一身份认证」改回「默认展示本地口令表单」，并在登录框下方并列提供「或以统一身份认证登录」图标入口（[ADR-036](./docs/adr/ADR-036.md) 修订 ADR-032 决策 7）。因此：

- `/login`（含 `?from=`、`?local=1`）默认渲染本地口令表单，不再自动跳转 `/api/v1/auth/sso/start`；点击登录框下方的单点登录图标才整页跳转 SSO（仍走 ADR-032 的 302 导航与 fail closed 回落）。
- `sso=disabled` 与 `sso_error=` 回落都保留本地口令表单：`sso=disabled` 时隐藏 SSO 入口并提示未启用；`sso_error=` 时错误提示置顶、SSO 入口保留可重试。
- 退出登录与未登录态的「前往登录」回到 `/login`，不再直接整页跳 SSO。
- ADR-032 的 OIDC 协议、两条 302-only 路由、`securityFlow` 五条 allowlist、用户映射、JIT 开通、会话与限流语义均不变；服务端路由与权限矩阵无改动。
- 本文件上文历史条目中出现的「`/login` 默认整页跳转 SSO」为当时事实，与本节冲突时以 ADR-036 与本节的现行规则为准。

## 2026-09-20 ADR-038 本地会话空闲时长调整说明

按用户要求把本地会话空闲有效期由 30 分钟调长为 2 小时（[ADR-038](./docs/adr/ADR-038.md) 修订 ADR-032 决策 6 的时长取值）。因此：

- 默认空闲有效期由 1800 秒改为 7200 秒（`apps/api/src/auth/session-ttl.policy.ts`），口令与 SSO 登录共用同一 `SESSION_TTL_POLICY`；`SESSION_IDLE_MAX_AGE_SECONDS` 仍可覆盖，非法取值继续启动失败。
- 失效机制不变：空闲超时仍自签发起固定计算、不随请求滑动续期；绝对超时仍为 7 天；`auth_version` 实时失效、停用即失效、Session 清理与备份排除语义均无改动。
- 部署配方同步为 2 小时：`deploy/.env.deploy.example` 与 `deploy/.env.deploy.test` 写入 `SESSION_IDLE_MAX_AGE_SECONDS=7200`，`deploy/compose.yaml` 注释同步。
- 路由、契约、权限矩阵与数据库迁移无改动；测试断言已同步（`session-ttl.policy.test.ts` 默认 7200 秒、`sso-login.integration.test.ts` 以 7200 秒签发并断言窗口），测试矩阵新增 2026-09-20 修订行。
- 本文件上文历史条目中出现的 30 分钟空闲超时为当时事实，与本节冲突时以 ADR-038 与本节的现行规则为准。

## 2026-09-23 ADR-043 / ADR-044 项目与模块归档下线说明

按用户 2026-09-23 连续两条指示整体下线「项目层」与「模块层」的归档：[ADR-043](./docs/adr/ADR-043.md) 把项目状态收窄为未开始 / 进行中 / 维护中三态，[ADR-044](./docs/adr/ADR-044.md) 让模块只剩 `ACTIVE`。因此：

- 项目不再有归档、恢复、归档申请与待审提示，六条项目归档路由与 `app.project_archive_requests` 的前后端实现全部删除；切换到维护中要求项目下不存在 `lifecycle_status = 'ACTIVE'` 且 `work_status NOT IN ('DONE','CANCELED')` 的任务，否则 409 `PROJECT_MAINTENANCE_TASKS_OPEN`。项目三态下都可写。
- 模块只有 `ACTIVE`：`archiveModule` / `restoreModule` 两条路由、`ModuleArchiveRequest`（原因）、`MODULE_ARCHIVE_TASKS_OPEN`、`FEATURE_MODULE_ARCHIVED`、`ModuleQueryPort.checkModuleForWrite` 的 `parent-not-active` 与 `ProjectWriteAccessFailure.module-not-active` 全部删除，`ModuleWriteCheckResult` 只有 `allowed | not-found`；`app.modules.status` 由 `modules_status_check` 锁定为 `ACTIVE`，`archived_at` 由 `modules_archived_at_null_check` 锁定为空。
- 功能、任务、迭代记录与遗留项的归档、恢复与父级归档前置校验**不变**：功能级 `parent-not-active`（`feature.status = 'ARCHIVED'`）当时仍在（该部分已由 [ADR-045](./docs/adr/ADR-045.md) 下线，见下文 2026-09-24 小节）；`archiveModuleTask` / `restoreModuleTask` 是「模块级任务」的归档命令，与模块归档无关，继续有效。
- 管理员高风险操作清单不再包含 `getProjectArchivePreview` / `archiveProject` / `restoreProject` / `archiveModule` / `restoreModule`（对应路由已不存在，调用返回 404）。
- 模块卡「进行中 / 未开始」标签继续由该模块已完成任务数派生，列表仍按派生档位分组（进行中在前），组内按 `sort_order`、`id` 升序；功能列表当时仍保留「已归档」档位（该表述已由 [ADR-045](./docs/adr/ADR-045.md) 修订，见下文 2026-09-24 小节）。
- 本文件上文 ADR-016 与 ADR-034 小节中把「项目归档申请—审核」「模块归档与恢复」写作现行规则的部分，以本节与 ADR-043 / ADR-044 为准。

## 2026-09-24 ADR-045 功能归档下线说明

按用户 2026-09-24 指示（承接功能卡上仍显示琥珀色「已归档」徽章的追问，答复「要继续」）把「功能层」归档一并下线（[ADR-045](./docs/adr/ADR-045.md)）。因此：

- 功能只有 `ACTIVE`：`archiveFeature` / `restoreFeature` 两条路由、`FeatureArchiveRequest`（原因）、`FeatureQueryPort.checkFeatureForWrite` 的 `parent-not-active`、`ProjectWriteAccessFailure.feature-not-active` 与 `FEATURE_STATE_CONFLICT` 全部删除，`FeatureWriteCheckResult` 只有 `allowed | not-found`；`app.features.status` 由 `features_status_check` 锁定为 `ACTIVE`，`archived_at` 由 `features_archived_at_null_check` 锁定为空。
- 功能下级的「父级已归档」分支整体删除：任务、聚合组、迭代记录、遗留项、外部链接、记录发布与聚合读不再有 `TASK_PARENT_ARCHIVED` / `TASK_IMPACT_ARCHIVED` / `TASK_MERGE_PARENT_ARCHIVED` / `LEFTOVER_PARENT_ARCHIVED` 与「排除归档影响功能」；功能创建 / 编辑 / 详情 / 列表 / 相似候选不再按状态过滤。任务自身的归档与恢复（`archiveTask` / `restoreTask` / `archiveModuleTask` / `restoreModuleTask`）不变。
- 功能卡「进行中 / 未开始」标签改由该功能已完成任务数（`stats.completedTaskCount`）派生，与模块同一口径；`featureItemSchema` 去掉 `status` / `archivedAt`，`createFeature` / `updateFeature` 幂等契约版本统一升 1.4.0。
- 管理员高风险操作清单不再包含 `archiveFeature` / `restoreFeature`（对应路由已不存在，调用返回 404）。
- 本文件上文 ADR-034 小节中把「功能归档 / 恢复」写作现行规则的部分、以及本节上一段（2026-09-23）中「功能列表保留「已归档」档位」的表述，以本节与 ADR-045 为准。
- 功能层下线归档的验证：`pnpm --filter @inpulse/e2e exec playwright test` 整包 56 例全绿（含 `features.spec.ts`「功能页不再有归档与恢复入口，功能始终可编辑（ADR-045）」）；同步运行树 `D:\InPulse` 后真机核对 `/projects/1/modules/3/features` 与 `/projects/2/modules/9/features` 无「已归档」文本、无归档 / 恢复动作按钮，页面内 `fetch` 实测 `POST .../features/{id}/archive` 与 `/restore` 均 404，`GET .../features` 的 item 无 `status` / `archivedAt`。E2E 侧同时修掉既有 spec 漂移与 `apps/e2e/global-setup.ts` 搜索夹具在 `search_projection_entity_unique` 上的唯一键冲突（夹具 `entity_id` 改为 `2_100_000` / `2_100_001`），并给 `playwright.config.ts` 补 `actionTimeout: 30_000` 以免定位器失配时静默等到用例超时；详见 `docs/test-matrix.md` 的 ADR-045 节。

## 2026-09-24 ADR-046 三层列表排序口径

按用户 2026-09-24 指示（「项目排序首先大体按照状态，进行中，未开始，维护中，细化按照创建时间排序。模块和功能按照创建时间从近到远」）统一三层列表的排序键（[ADR-046](./docs/adr/ADR-046.md)）：

- 项目列表：档位（`ACTIVE` 进行中 → `NOT_STARTED` 未开始 → `MAINTENANCE` 维护中）→ `created_at DESC` → `id DESC`，见 `apps/api/src/modules/projects/postgres-project-query-port.ts` 的 `list`。
- 模块列表与功能列表：派生档位（进行中 → 未开始）→ `created_at DESC` → `id DESC`，见 `apps/api/src/modules/modules/module-management.repository.ts` 与 `apps/api/src/modules/features/feature-management.repository.ts`。模块排序**不再使用** `sort_order`：该列应用内从不写入、恒为默认值 `0`，只有演示种子数据填了 1~8；列本身保留，不删列，也不为此新增迁移与索引（排序首键是相关子查询算出的 `CASE`，任何索引都满足不了）。
- 档位口径不变：项目读存储状态，模块与功能由 `stats.completedTaskCount` 派生；卡片档位徽章的文案与配色不变。本文件与 ADR-044 中「模块列表组内按 `sort_order`、`id` 升序」的表述以本节与 ADR-046 为准。
- `created_at` 相同时用 `id DESC` 兜底保证顺序稳定；演示数据里项目 1 的 8 个模块创建时间完全相同，因此它们现在按 ID 倒序显示。契约侧 `listProjects` / `listModules` / `listFeatures` 三条路由描述同步（顺手清掉 `listProjects` 描述里残留的「包含归档历史 / 已归档档位 / 待审归档申请摘要」过时文案）。
- 验证（2026-09-24 本地）：`apps/api` 单测 66 文件 367 例、真实 PostgreSQL 集成 49 文件 451 例（含三处新排序断言：`projects-read-api` 的后建「未开始」项目排在旧「未开始」之前且档位计数为 `[1, 0, 0, 0]`、`modules-api` 的未分类模块列表 `[module.id, project.moduleId]`、`features-api` 的 `[active.id, newerNotStarted.id, notStarted.id]`）、`apps/web` 单测 85 文件 553 例、Playwright E2E 整包 56 例全绿（4.9 分钟）；`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build`、`contract:drift`、`contract:validate`（98 条）、`permissions:check`（98 条）、`db:migrations:check`（26 条）、`check:docs`（92 个 Markdown）、`check:frontend:boundaries`（283 模块 / 1392 依赖）通过。`apps/web` 的 `src/app/router/app-router.test.tsx` 在全量批次下偶发 1 例失败，单独复跑 3/3 通过，与本次排序改动无关（既有偏差）。详见 `docs/test-matrix.md` 的 ADR-046 节。

## 2026-09-24 任务紧急桶：遗留问题来源改排到已逾期之后（该口径已于同日作废）

> 本节描述的「遗留问题来源并回紧急桶第 2 档、游标版本 6、载荷 7 段」已由同日文末的 [排序口径复核](#2026-09-24-排序口径复核遗留问题来源只在同优先级内提前) 撤销，现行口径以该节与 [ADR-037](./docs/adr/ADR-037.md) §3 修订 B 为准。本节仅保留为变更历史。

按用户 2026-09-24 指示（「这个排序稍微改一下，把遗留问题排到已经逾期后面」）重排未完成任务的紧急桶：**标记紧急(0) → 已逾期(1) → 遗留问题来源(2) → 今/明日截止(3) → 其余(4)**（此前遗留问题来源是第 0 桶）。

- 服务端唯一排序键在 `apps/api/src/modules/tasks/task-list-order.ts` 的 `urgency` 表达式，任务中心、任务列表端口与任务面板共用；`TASK_LIST_SORT_KEY_VERSION` 由 5 升到 6，旧游标整版拒绝（旧 0 = 遗留问题来源，新 0 = 标记紧急）。
- 前端 `apps/web/src/features/my-tasks/TaskCenterPageView.tsx` 的 `urgencyBucketOf` 必须与服务端同步重排：它让聚合组卡与任务卡共用同一把尺子（组卡「来源」不适用，「紧急」取未完成分支最高一档、「截止」取最早一条）。两处注释互相引用，改一处必须改另一处。
- 只改顺序，不改颜色：`task-tone.ts` / `design-system.css` 的卡片取色、优先级徽章、「遗留问题」棕色徽章与截止日期文案全部不变；任务看板四桶口径（[ADR-037](./docs/adr/ADR-037.md) §3）同样不变。
- ADR-037 §3 已补 2026-09-22 与 2026-09-24 两条修订（§1 / §3 表格里 2026-09-18 的原始桶序以这两条为准），并同步 `功能设计v1.1.md`、`docs/task-card-colors.md`、`docs/c-v1-alignment.md`、`docs/test-matrix.md`（TASK-URGENCY-ORDER-* 小节）与 `开发日志.md` 第二十一条。

## 2026-09-24 排序口径复核：遗留问题来源只在同优先级内提前

按用户 2026-09-24 指示（「为什么这里排序又被改动了，我要求遗留问题只会在同优先级里面高一点，以后不管是别人拉取还是，都要以这个为准」）复核并回退当日的紧急桶口径（[ADR-037](./docs/adr/ADR-037.md) §3 修订 B）。因此：

- **现行口径（唯一权威）**：任务列表排序键 = 状态分组 → 完成时间倒序 → 紧急桶（标记紧急 0 → 已逾期 1 → 今/明日截止 2 → 其余 3）→ 优先级 → **遗留问题来源**（同优先级内 0/1）→ 截止时间 → 任务 ID。遗留问题来源**不是紧急桶的一档**，它在优先级之后单独成一档，因此只会在同优先级任务内提前，不越过更高优先级的任务。
- 回退原因：当日两条并行开发线合并时采用了另一条线的口径（把遗留问题来源并回紧急桶第 2 档），于是「普通 + 遗留问题」的卡片压过了「高」优先级卡片；该口径已作废，见上文「任务紧急桶：遗留问题来源改排到已逾期之后」的作废注记。
- 固化要求：任何分支合并、端到端拉取、端口扩展或前端镜像实现都必须保留这一级的位置；确需改动必须新增 ADR-037 修订行并同步本文件，不得静默沿用其它分支的旧口径。
- 实现位置（三处必须同步，缺一即口径漂移）：`apps/api/src/modules/tasks/task-list-order.ts`（`urgency` / `leftover` 表达式、`taskListOrderBy`、`taskListKeysetPredicate`、`taskListSortKeyFor` 与游标编解码）、`apps/web/src/features/my-tasks/TaskCenterPageView.tsx`（`urgencyBucketOf` / `leftoverRankOf` 与六级排序键，聚合组卡与任务卡共用同一把尺子）、`apps/web/src/features/common/task-tone.ts`（只解释配色与桶序，不参与排序）。
- 游标：`TASK_LIST_SORT_KEY_VERSION` 升到 7，载荷 8 段（版本|状态分组|完成时间|紧急桶|优先级|遗留问题来源|截止|任务ID）；v5、v6 旧键整版拒绝，前端按既有 422 重新取第一页。版本号单调递增，不回收已用过的号。
- 只改顺序，不改颜色与看板：卡片取色、优先级徽章、「遗留问题」徽章与截止日期文案不变；任务看板 `listForBoard` 的四桶口径与其未完成桶「优先级 → 截止时间」排序不受影响（ADR-037 §3）。
- 回归防线：`apps/api/test/task-list-order.test.ts`（游标版本与段数）、`apps/api/test/aggregate-read-ports.integration.test.ts`（真库顺序矩阵，含「高优先级无遗留 vs 普通优先级有遗留」对照）、`apps/api/test/aggregate-read-api.integration.test.ts`（HTTP 层顺序与分页不重不漏）、`apps/web/src/features/my-tasks/TaskCenterPageView.test.tsx`（前端镜像顺序）。改动排序口径时必须同时跑这四处。

## 2026-09-28 ADR-053 项目组长唯一性与转移说明

按用户 2026-09-28 的三条指示（「只剩最后一个成员时他就是组长，且不能被移除，除非有其他的成员进来，一个项目至少得有一个成员」→ 撤回自动继任方案「还是改成需要先转移才能进行移除」→「组长应该也有转移身份的权限」）补齐组长不变量（[ADR-053](./docs/adr/ADR-053.md)）。因此：

- **有活跃成员 ⇒ 恰好一名 ACTIVE 组长**：迁移 `0029_project_leader_invariant.sql` 回填存量无组长项目（优先仍在任的创建者，否则最早加入者），并新增可延迟约束触发器 `project_members_leader_complete`（提交期调用 `app.assert_project_leader`）。**必须可延迟**：转移是「先降级原组长、再提升新组长」两步，中途必然零组长，而 `project_members_one_leader` 是不可延迟的部分唯一索引。
- **组长只能转移，不能撤销或移除**：`removeProjectMember` 对组长 409 `PROJECT_MEMBER_LEADER_PROTECTED`（含系统管理员）；`setProjectMemberRole` 把现任组长降级为 `MEMBER` 返回 409 `PROJECT_MEMBER_LEADER_REQUIRED`；「撤销组长」这条路径整体取消，没有「先撤销再指定」的替代流程。
- **组长本人可转交身份**（修订 [ADR-039](./docs/adr/ADR-039.md) 决策 4）：`roleSetterRole` 返回 `SYSTEM_ADMIN | LEADER | MEMBER | NOT_MEMBER`；组长仅当 `role = LEADER` 且目标不是自己时放行，自设与撤销组长的请求一律 403 `PROJECT_MEMBER_ROLE_FORBIDDEN`，普通成员 403、非成员 404。系统管理员保持完全能力。
- **零活跃成员的项目在数据库层保持合法**：夹具清理与历史数据的删除路径需要把成员关系标记 `REMOVED`；「一个项目至少有一名成员」由「唯一成员必然是组长」+「组长不可移除」隐含，**不新增** `PROJECT_MEMBER_LAST_MEMBER_PROTECTED` 之类的错误码（方案 A 下不可达）。将来若重新引入自动继任，必须新增 ADR 并同时补该码与门禁测试。
- **无组长项目的加入规则**：`addProjectMember` 在项目没有活跃组长时把首位加入者直接写成 `LEADER`（`resolveJoiningRole`），否则该写入会被数据库不变量在提交时拒绝。
- **幂等契约版本**：`setProjectMemberRole` 的 `idempotencyContractVersion` 由 `2.1.0` 升到 `2.2.0`（授权语义变化），旧 Key 在新契约下 409；`addProjectMember`（`1.2.0`）与 `removeProjectMember`（`1.3.0`）的请求/响应 Schema 与重放策略未变，版本保持。
- **夹具与种子**：`app.project_members` 的所有插入夹具必须显式给出 `role`（测试库、E2E `global-setup`、`apps/ops` 集成、`database/poc` 共 42 处已补齐）；移除成员必须走 `apps/api/test/database.helpers.ts` 的 `removeMember`（在事务内先把组长身份转移给其他活跃成员再标记 `REMOVED`），直接 `UPDATE … status='REMOVED'` 移除创建者/组长会在提交期被 `project_members_leader_complete` 拒绝；`database/seed/demo-data.sql` 的 `project_members` 已包含 `role` 列，修改种子列清单时必须同步 `scripts/export-demo-seed.mjs`。
- 本文件上文历史条目（ADR-033/ADR-039 小节，以及 2026-09-24 前后的相关表述）中出现的「每个项目至多一名组长」「组长转移与撤销仅系统管理员可为」「创建后可由系统管理员按普通成员规则移除（组长须先转移或撤销）」为当时事实，与本节冲突时以 ADR-053 与本节的现行规则为准。

## 2026-09-28 ADR-049 / ADR-050 项目删除与删除记录说明

> **已由 [ADR-062](./docs/adr/ADR-062.md) 取代（2026-10-09）**：项目删除已改为**物理删除**，软删除列、删除记录台账路由、删除动态可见性例外与「已删除项目」筛选已全部下线，本节以下内容仅作变更历史；替代规则见文末「2026-10-09 ADR-062 项目改为物理删除说明」。

按用户 2026-09-28 的连续指示（「在编辑项目里面增加一个删除项目的功能，只有组长和系统管理员有删除的权限」→「布局记得更改」→「然后删除项目也要在项目动态和审计日志里记载」→「项目动态要所有人能看到，审计日志管理员看到就行，要留有记录，记录谁删除了项目」）交付项目删除与删除记录可见性（[ADR-049](./docs/adr/ADR-049.md)、[ADR-050](./docs/adr/ADR-050.md)）。因此：

- **删除是软删除，不物理删除任何历史**：迁移 `0030_project_soft_delete.sql` 给 `app.projects` 加 `deleted_at` / `deleted_by`（`ON DELETE restrict` FK 到 `app.users`）与 `projects_deleted_state_check`（两列同时为空或同时有值）；不级联、不回收项目编码（`projects_code_unique` 不变）、不加「已删除」状态位（项目状态仍是 [ADR-043](./docs/adr/ADR-043.md) 的三态）。物理删除在本仓库不可行——`app.projects` 被 12 张表以 `RESTRICT` 外键引用，审计链按 [ADR-008](./docs/adr/ADR-008.md) 只追加。
- **权限**：只有系统管理员与本项目 ACTIVE 组长可删（在 [ADR-039](./docs/adr/ADR-039.md) 的权限下放上新增例外）；普通成员 403 `PROJECT_DELETE_FORBIDDEN`，非成员与已移除成员 404（不泄露存在性），组长用实时成员关系判定、转移或降级后立即失效。重放走专用 `projectDeleteReplayAuthorizer`（删除后项目必不在成员范围内，复用常规作者探测会把合法重放变成 404）。
- **删除后项目退出全部可见范围**，但**删除这件事要对全部登录用户可见**（ADR-050 修订 ADR-049 第 3 节的绝对表述），且必须**作为项目动态流里的普通一行**呈现、不得另起独立区块（2026-09-28 用户追加要求）：新增只读路由 `GET /api/v1/project-deletions`（`listProjectDeletions`，`session` 策略、无 CSRF / 幂等键 / `If-Match`、不写审计、`no-store`），条目只有 `projectId` / `code` / `name` / `deletedAt` / `deletedBy{id,name}`，不暴露任何下级数据也不提供恢复入口；签名游标（`TimeCursorService` 命名空间 `PROJECT_DELETION`、绑定操作者、TTL 15 分钟），`limit` 1～50、默认 20。动态读取的例外必须靠 `ProjectAccessQueryPort.isDeletedProject` 判定（不能用授权范围反推），并收窄到只下发 `activityType = PROJECT_DELETED`（删除前的历史与 `ADMIN_ONLY` 行不得借该例外回放），删除行不带「查看对象」；审计读取 `getAuditLogs` 保持 `adminSession` 不变，前端补齐已删除项目的 `PROJECT:<id>` 审计链入口并把项目名按记录还原。
- 删除的**写入侧从未缺失**：审计 `project.delete`（含项目编码与名称、操作者）与项目动态 `PROJECT_DELETED`（`visibilityScope: MEMBER`）早已在同一事务写入；缺口只在读取侧（项目级动态查询对被删除项目不可用、审计页只列活跃项目）。**刻意不发通知**——删除后项目深链必成死链，通知只能标记已读不能作废（[ADR-035](./docs/adr/ADR-035.md)）。
- 路由总数由 99 增至 **100**（`deleteProject` 与 `listProjectDeletions`）；`packages/api-contract/test/permissions.test.ts` 的真实 Controller 扫描期望清单必须随新增路由同步，否则该用例会以「扫描到的绑定数与清单不一致」失败。
- 前端口径：删除入口在「编辑项目」弹窗**页脚最左侧**（`danger-button footer-leading`），只在 `canDeleteProject(isAdmin, currentUserRole)` 为真时渲染，后果说明由二次确认承担；项目动态页把删除行与其它动态**混排在同一时间线**（已删除项目的 ID 与项目名由 `listProjectDeletions` 第一页补进取数范围与项目名映射，仅「全部项目」视图；锁定单项目时不请求也不出现删除行），渲染上共用日期分组 / 时间轴 / 头像 / 原始快照，且不给「查看对象」；原「项目删除记录」独立区块与 `activity-deletions-*` 样式已整体下线。
- 本文件与三份基线设计文档中「项目只能创建 / 编辑 / 切换状态」的历史描述，以及 ADR-049 第 3 节「删除后对所有人不可见（含管理员）」的绝对表述，与本节冲突时以 ADR-049 / ADR-050 与本节的现行规则为准。

## 2026-09-28 ADR-051 项目还原与彻底删除说明

> **已由 [ADR-062](./docs/adr/ADR-062.md) 取代（2026-10-09）**：`restoreProject` / `purgeProject` 两条路由已删除，`app.purge_project` 改由 `DELETE /api/v1/projects/{projectId}` 直接调用，本节以下内容仅作变更历史。

按用户 2026-09-28 指示（「给删除项目的动态的原始快照按钮边上加一个还原项目和彻底删除，还原项目就是把项目显示出来，彻底删除就是从硬性删除」）交付项目还原与彻底删除（[ADR-051](./docs/adr/ADR-051.md)），并附同批次的两项界面修订（删除行动作按钮横向对齐、动态文案中文化）。因此：

- **两条新命令**：`POST /api/v1/projects/{projectId}/restore`（`restoreProject`，200 `ProjectDetailResponse`）与 `POST /api/v1/projects/{projectId}/purge`（`purgeProject`，200 `ProjectPurgeResponse`）；`session` + CSRF + 数据库级幂等（`idempotencyContractVersion: 1.0.0`）、`versionPolicy: none`、`behaviorHeaders: []`（不接受 `If-Match`）。Route Registry 由 100 条增至 **102 条**。
- **权限分离**：还原与删除**同权**（系统管理员或本项目 ACTIVE 组长；普通成员与项目管理员 403 `PROJECT_RESTORE_FORBIDDEN`），彻底删除**只有系统管理员**（其余 403 `PROJECT_PURGE_FORBIDDEN`）；未删除项目一律 409 `PROJECT_NOT_DELETED`，非成员 / 不存在 404。重放前复核当前认证与角色，彻底删除走专用 `projectPurgeReplayAuthorizer`（只复核「当前仍是有效系统管理员」）。
- **彻底删除的数据库边界**：迁移 `0031_project_purge.sql` 新增 `SECURITY DEFINER` 函数 `app.purge_project(INTEGER)`，**不**逐表授予运行时 `DELETE`；函数内 `deleted_at IS NULL` 即 `RAISE EXCEPTION`（fail closed）；固定按叶子表到 `app.projects` 共 27 处删除并断言 `projects` 恰 1 行；`modules_protect_unclassified` 的豁免只能由该函数用事务级 `set_config(..., true)` 打开并在返回前复位；项目自己的 `PROJECT:<id>` 审计链随项目删除，**SYSTEM 链不受影响**（[ADR-008](./docs/adr/ADR-008.md) 的唯一例外，范围写死在函数内）。
- **还原不搬数据**：只清 `deleted_at` / `deleted_by` 并递增 `row_version`，条件带 `deleted_at IS NOT NULL`（并发还原只有一个成功）；编码、成员、模块、功能、任务、记录、审计链与通知原样保留，还原后立即恢复删除前的可见性，不重发通知，也不回收 / 复用编码。
- **前端**：两个动作就在删除记录行的「原始快照」旁（`restore-project-<id>` / `purge-project-<id>`，「彻底删除」必须二次确认 `confirm-purge-project-<id>`），入口由服务端下发的 `canRestore` / `canPurge` 决定，只作渲染提示、**不作为授权依据**；三个动作与「原始快照」并排在同一行（2026-09-29 用户指示修订：此前是「原始快照」一行、还原与彻底删除另起一行；`.activity-actions` / `.activity-actions-main` 两行堆叠基线删除，「还原项目」「彻底删除」移到「原始快照」左侧，`.activity-actions-slot` 保留为「原始快照」列的跨行对齐占位），窄屏由 `.audit-row > .audit-actions { display: none }`（≤700px）隐藏整个动作区；动态类型与角色值改为中文（`activity-labels.ts` 的 `PROJECT_STATUS_CHANGED` / `PROJECT_MEMBER_ROLE_CHANGED` / `record.leftover.add` / `ROLE_LABELS`），「原始快照」弹窗用中文描述、摘要区保留原始枚举。
- 本文件与 ADR-049 第 8 节、ADR-050 非目标第 1 条中「不提供恢复入口 / 不提供彻底删除」的历史表述，与本节冲突时以 ADR-051 与本节的现行规则为准。

## 2026-09-28 ADR-052 已删除项目的完整动态与删除操作唯一入口说明

> **已由 [ADR-062](./docs/adr/ADR-062.md) 取代（2026-10-09）**：物理删除后项目不再以「已删除」状态存在，活动读取的已删除项目例外、「已删除项目」筛选与删除行动作按钮已全部下线，本节以下内容仅作变更历史。

按用户 2026-09-28 指示（「有两个重复了，如果是被删除了的项目，就只有最晚的一个可以进行还原和彻底删除的操作，而且不要隐藏之前的创建和操作的动态过程，要有从创建到删除的完整过程，然后刷选的下拉框增加一个选项叫『已删除项目』」）修订 [ADR-050](./docs/adr/ADR-050.md) 第 5 节的服务端收窄（[ADR-052](./docs/adr/ADR-052.md)）。因此：

- **已删除项目下发整个项目链的 `MEMBER` 可见动态**：`ActivityQueryService.resolveAccess` 返回来源 `"scope" | "deleted-project"`，后者**不再**追加 `activityTypes` 过滤；`visibilityScopes` 仍固定 `["MEMBER"]`——`ADMIN_ONLY` 不随该例外回放，`includeAdminOnly: true` 对已删除项目无效（管理员与普通成员一致），「不存在 / 从未有权访问 / 已移除成员」仍是 404。`ActivityProjectionReader.read` 的可选 `activityTypes` 参数与 SQL 过滤连同唯一调用方一并删除，不得再以「只放行 `PROJECT_DELETED`」为由重新加回。
- **同一项目多次删除（删除 → 还原 → 再删除）只让最新一条可操作**：前端在已加载动态里取每个 `projectId` 时间序第一条 `PROJECT_DELETED`（`latestDeletionIdByProject`），只有该行渲染 `ProjectDeletionActions`；其余删除行保留为过程记录（时间 / 操作者 / 摘要 / 项目名 / 原始快照），不带任何动作。台账 `listProjectDeletions`（一项目一条当前状态）语义不变。
- **已删除项目链的所有行都不提供跳转**：抑制「查看对象」的条件由删除行扩大为「该行项目在删除台账里」，历史行同样不留死链。
- **项目筛选下拉新增「已删除项目」**：固定选项值 `"deleted"`，取数范围收窄为台账项目 ID 集合；台账为空时给「暂无已删除项目」空态且不发空请求；「全部项目」视图继续包含已删除项目的完整动态；台账读取时机为「全部项目或已删除项目」，锁定单项目视图仍不请求台账。
- 契约、Route Registry、权限矩阵与数据库**零改动**（`activityType` 是自由字符串，筛选是纯前端行为）。
- 放宽的理由与代价：项目一旦删除就不存在授权范围（ADR-049 / ADR-050），「删除前的过程」与「删除这件事」同属一条组织级事实，因此对**全部登录用户**可见；若将来改为「只有参加过该项目的人可见完整过程」，必须新增 ADR 并同步权限矩阵、`docs/test-matrix.md` 与本节。

## 2026-09-29 ADR-054 任务归档下线说明

按用户 2026-09-29 的三步反馈（「为什么编辑任务有个归档的功能，不是已经有完成任务和取消任务的功能了吗」→「我感觉这个任务的归档没有用处」→「那就把这个功能去除掉」）把「任务层」的归档一并下线（[ADR-054](./docs/adr/ADR-054.md)）。因此：

- `archiveTask` / `restoreTask` / `archiveModuleTask` / `restoreModuleTask` 四条路由与 `TaskArchiveRequest`（原因）整体删除，Route Registry 103 → 99 条；删除后 `POST .../tasks/{taskId}/archive`、`/restore` 与模块级同形路径均返回 404。
- 任务生命周期取值域收窄为 `ACTIVE | INVALID`：迁移 `0032_task_archive_removal.sql` 把存量 `ARCHIVED` 回填为 `ACTIVE`（不递增 `row_version`、不写审计），随后重建 `tasks_lifecycle_status_check`；**不删列、不物理删除任何历史**。`INVALID`（标记无效）语义与读写路径本次不动。
- 契约：`taskItemSchema`（含 `ModuleTaskItem`）与 R-3 `MyTaskItem`、R-5 `TaskGroupMembershipItem`、记录草稿来源任务的 `lifecycleStatus` 统一收窄为 `["ACTIVE","INVALID"]`；`createTask` / `updateTask` / `createModuleTask` / `updateModuleTask` 幂等契约版本升 `3.0.0`，`transitionTask` / `transitionModuleTask` 升 `4.0.0`（响应 Schema 收窄属破坏性变更，旧 Key 在新契约下 409）。
- 后端：`TasksManagementService` 的 `TaskOperation` 收窄为四个创建/编辑操作，`isTaskLifecycleOperation` / `changeTaskLifecycle` / `requireArchiveRole` 与 `reason` 入参删除，`TaskManagementRepository.setLifecycle` 删除；`ProjectsWritePort.countUnarchivedTasks` 更名 `countOpenTasks`（SQL 与 `lifecycle_status = 'ACTIVE'` 条件不变，409 `PROJECT_MAINTENANCE_TASKS_OPEN` 不变）——「先把任务归档再切维护中」的旁路随归档下线消失，这是本次唯一有用户可见影响的口径变化（[ADR-043](./docs/adr/ADR-043.md) 的「维护中」门禁本身不变）。
- 前端：任务编辑弹窗底部的「归档 / 恢复」入口（`task-modal-lifecycle`）与确认弹窗整体删除，「编辑任务」回到只由 `writable` 控制；任务详情不再有「已归档」只读提示；聚合组详情成员卡去掉「已归档」徽章。
- 保留项：`TASK_MERGE_PARENT_ARCHIVED` / `RECORD_PARENT_ARCHIVED` / `TASK_STATE_CONFLICT` 错误码与 `TaskStatusPanel` / `CompleteWithRecord` 的 `lifecycleStatus !== "ACTIVE"` 门禁保留，措辞按「已无效」表述；历史审计（`task.archive` / `task.unarchive`）、历史动态与对应中文标签保留为只读展示，不清理历史数据，历史迁移（`0000`–`0031`）不改写。
- 本文件上文 ADR-034 小节中把「任务归档与恢复」「归档命令可越过已归档父级」写作现行规则的部分、ADR-039 小节中「任务弹窗归档入口按角色显示」的描述，以及 2026-09-23 节中「先把任务归档再切维护中」的旁路说明，均以本节与 ADR-054 为准；`功能设计v1.1.md`、`系统设计文档v1.0.2.md`、`技术设计v1.2.2.md`、[权限矩阵](./docs/permissions.md) 与[测试矩阵](./docs/test-matrix.md) 已同步。

## 2026-09-29 F-33 迭代总结（规则版）接入正式站点

按用户 2026-09-29 指示（「可以，接入正式网站吧」）把 `/records` 的「年终总结」模拟页正式落库。用户明确不做模型接入（问过「有接入简单的ai吗」，答复「没有」并说明了接模型的代价），因此本轮是**规则版**：服务端只出事实（范围内 PUBLISHED 正式记录、未失效的已完成任务、遗留问题、以及「已完成但范围内没有任何记录」的缺口 + 计数），分节标题与正文措辞由前端按事实派生，与 R-7 聚合组「服务端只透传事实」同一口径；不新增依赖、不新增 ADR、不改数据库与迁移。

- 新增只读路由 `getRecordSummary`（`GET /api/v1/change-records/summary`）：契约 `packages/api-contract/src/contracts/record-summary.zod.ts`、路由 `packages/api-contract/src/record-summary-routes.ts`，Schema Registry / Route Registry / 权限矩阵 / OpenAPI / 生成客户端同步；三个端口方法为 `ChangeRecordReadPort.summaryRecords`、`summaryLeftovers` 与 `TaskQueryPort.summaryCompletedTasks`，聚合读落在 `apps/api/src/modules/aggregate-read/record-summary-query.service.ts`。
- 排障（2026-09-29，用户两次报「生成总结失败」）：三点均已修——① 本地 3000 端口跑的是未重建的旧 `dist`，总结路由 404，已 `node scripts/dev-start.mjs` 重建重启；② 端口 `assertLimit` 误用分页上限 `CHANGE_RECORD_READ_LIMIT_MAX`(100) 校验总结下发量（`RECORD_SUMMARY_ITEM_MAX` 2000 / `RECORD_SUMMARY_POINT_MAX` 300），真实链路必抛 `limit exceeds CHANGE_RECORD_READ_LIMIT_MAX (100)` 并 500，已新增 `assertSummaryLimit`（上限取契约常量）供 `summaryRecords` / `summaryLeftovers` 使用并补真实端口回归；③ 聚合读的项目名只按结果集（`pageProjectIds`）解析，授权范围内本期没有任何记录 / 任务的项目（如「LIINK市场管理系统-销售部门」）取名失败，`scope.projectNames` 抛 `AGGREGATE_READ_INCONSISTENT`「总结缺少项目 <id>」并 500（提交 `f5bf6f1`），已改为按整个授权范围 `projectIds` 取名并补真实 PostgreSQL 回归；三处均未改契约、分页口径与其它端口方法。单元层同时补覆盖：`apps/api/test/record-summary.service.test.ts` 的桩端口改为按传入 `projectIds` 过滤（此前无条件返回全部 `projectNames`，与真实端口不符、掩盖同类缺陷），并新增 2 例回归（该文件 8 → 10 例），修复前单元与真库回归均必红。
- 口径：`from` / `to` 为 Asia/Shanghai 自然日（含首尾），SQL 内换算日界；跨度上限 400 个自然日，起止倒置 / 格式 / `groupBy` 非法统一 422；`projectId` / `memberId` 只收窄服务端 `AuthorizedProjectScope`，越权项目静默排除（空结果，不返回 403 / 404）；空授权范围短路且不发 SQL；只读、不取锁；`truncated` 为真时不做缺口判定；作废记录与草稿不进总结。
- 前端：`/records` 筛选行最右端新增「生成总结」入口（原在页头，2026-09-29 移到筛选 toolbar 末位并靠右顶格），打开 `RecordSummaryModal`（时间 / 项目 / 按项目或按成员筛选 + 正文 / 明细切换 + 复制正文或明细 Markdown）；外部迭代记录界面不变。
- 验证（2026-09-29 本地）：`pnpm check` **exit 0**（lint、format:check、typecheck、test:unit（api 67 文件 **380 例** / web 87 文件 **595 例** / api-contract 16 文件 100 例 / ops 8 文件 52 例 / database 1 文件 15 例 / canonical-json 1 文件 5 例）、db:migrations:check 31、contract:drift、contract:validate **100 条路由**、build、check:deploy:test、check:deps **739** 源文件、check:frontend:boundaries 294 模块 1442 依赖、permissions:check **100 / 100**、deps:audit（`--audit-level=high` 通过）、check:secrets 1105 文件、check:docs 101 个 Markdown）；`TEST_DATABASE_URL=app_ci` 的 apps/api `test:integration` **52 文件 489 例**全绿（含 `record-summary.integration.test.ts` 8 例：真实端口 limit 口径回归 + 零记录项目取名回归），database 集成 2 文件 27 例通过；全量 `pnpm test:e2e` **62 passed (5.0m)**。以上为 rebase 到 `0c01ac0` 后重跑的结果。
- 本地环境与取数口径（2026-09-29 全面测试）：演示库 `app` 当时停在 `0025`（26 个迁移），而当前代码（ADR-049 起需要 `projects.deleted_at` 等）在未迁移的库上会让**全部项目级接口** 500；已按 README 用 `MIGRATION_DATABASE_URL=postgresql://cluster_bootstrap@127.0.0.1:55432/app pnpm db:migrate` 升到 `0032`（31 个迁移），迁移前留有 `pg_dump -Fc` 快照（`.data/backup/`，`.data` 被 gitignore），升级后单日窄区间与全年区间均实测正常。为避免同类问题再次以「服务器无法完成…」的兜底文案出现在全站，`scripts/dev-start.mjs` 第 1 步已增加迁移版本校验：比对 `database/migrations` 与本地库 `app.schema_migrations`，落后即 fail fast 并打印迁移命令，库中存在本地不存在的迁移记录时提示「当前代码可能落后于库」，`DATABASE_URL` 指向非本机默认库（host/port 不是 127.0.0.1:55432）时跳过并说明；用只到 `0017` 的 `app_e2e` 实测能拦住并给出命令。
- 明细可展开（2026-09-29，用户指示「我希望实现在点击明细里的迭代记录时可以展开看到更详细的内容」）：`RecordSummaryModal` 明细表新增首列展开箭头（`summary-detail-toggle` / `summary-detail-toggle-button`，`aria-expanded` + 中文 `aria-label`），**整行横向区域可点**即展开 / 收起（按钮 `stopPropagation` 防双触发），默认全部收起、弹窗重开重置；展开后在下一行 `colSpan={6}` 复用 `PublishedRecordDetail` 的**只读形态**——该组件新增 `readOnly` 入参（不渲染编辑 / 作废 / 遗留项转任务与追加 / GitHub 关联面板 / 「已转任务」说明，且 `listChangeRecordVersions` 的 `enabled` 加 `&& !readOnly` 不再发版本请求；与 `writable` 的分工是「只置灰」对「直接不渲染」），与记录页卡片共用 `["published-record", projectId, recordId]` 缓存。明细表改 `table-layout: fixed` + 六列百分比（2.5 / 11.5 / 20 / 40.5 / 12 / 13.5）：实测 auto 布局整表 1318px > 弹窗正文 1124px，整表横向溢出会把展开区遗留问题的「未闭环」徽章挤出可视区；又必须用百分比列而非 px 列，否则固定布局下 px 列会吸走剩余宽度、28px 展开列被撑到 46px，展开正文的 38px 左边距就再也对不上「编号」列。**同时回答用户第二问**：当前总结**没有**参考记录正文详述——`RecordSummaryPoint.detail` 只取 `resultVerification`（退 `changeSolution`，再退 `title`）并截断到 `DETAIL_MAX = 1000` 字，`ChangeRecordReadPort.summaryRecords` 的 SQL 不取 `contextProblem`、遗留问题正文与影响功能列表，正文措辞由前端按事实派生、未接模型；明细展开看正文即补齐这一缺口的直接手段。新增 `apps/web/src/features/records/RecordSummaryModal.test.tsx` 2 例（点行内文字就地展开四段正文 + 遗留问题，且 `listChangeRecordVersions` 未被调用、不出现「GitHub 关联 / 修订内容 / 作废记录」；首列箭头 `aria-expanded` 同步并能再点收起卸载）。（同日用户复核后补两处排版修正：表头 `th` 字号 12px → 13px；表体 `td` 显式 `white-space: normal` 覆盖 `design-system.css` 的全局 `td { white-space: nowrap }`——该全局规则会让长内容既不能换行又溢出压到右列标题上，只对编号 / 作者 / 发布日期保留单行，长路径按两行渲染。）该批已按用户「很好，推送」授权提交 `bf9fa69` 并推送 `origin/test`（`d301c83..bf9fa69`），由既有 PR [#146](https://github.com/256-code/InPulse/pull/146)（`test → main`）的 `pull_request` 事件触发 `CI / workspace` run [36543430865](https://github.com/256-code/InPulse/actions/runs/36543430865)（**success**，约 17m07s）与 `Documentation / docs` run [36543430874](https://github.com/256-code/InPulse/actions/runs/36543430874)（**success**，14s）。
- 明细复制修复（2026-10-10，用户报「这里负责明细markdown功能怎么和总结的负责正文是一样的」）：`RecordSummaryModal` 的复制回调此前不论正文 / 明细一律调用 `summaryDocumentToText(document)`；现已按 `detail` 分流——明细走 `record-summary-document.ts` 新增的 `buildSummaryDetailMarkdown`（与明细表同列：编号、项目模块功能、标题与效果、作者、发布日期；竖线与换行转义；空集与 `truncated` 提示），正文复制不变。一次性真机探针复核「明细 ≠ 正文」，**未新增 Playwright 用例**。详见 [开发日志](./开发日志.md) 第一百二十一条与 [测试矩阵](./docs/test-matrix.md) 的 F-33 小节。
- 未运行 / 已知偏差：apps/ops 备份集成 2 例需要本机注入 PostgreSQL 18 的 `INPULSE_BACKUP_PG_DUMP` / `INPULSE_BACKUP_PG_RESTORE`（按 A-1 等价设置指向本机 PostgreSQL 18.6 的 `pg_dump.exe` / `pg_restore.exe` 时 2 文件 7 例全通过，未注入时这 2 例以 `pg_dump exited with code null` 失败）；registry 现有 1 条 moderate（`multer` GHSA-3pph-fpjx-jg34，修复 `>=2.4.0`，当前锁 `2.3.0`）——`deps:audit` 在 `--audit-level=high` 下不阻断，依赖升级按本文件第 4 节只能走独立 PR 由人工确认；本批已按用户「上传 test」授权提交并推送到 `origin/test`（提交前 rebase 到 `aa193dc`，推送区间 `aa193dc..9c4a02b`）；GitHub Actions 已跑通——`test → main` 的 PR [#146](https://github.com/256-code/InPulse/pull/146) 为提交 `9c4a02b` 起了 `CI / workspace`（run [36528124797](https://github.com/256-code/InPulse/actions/runs/36528124797)，**success**，17m06s）与 `Documentation / docs`（run [36528124971](https://github.com/256-code/InPulse/actions/runs/36528124971)，**success**）；未新增 Playwright 用例，总结弹窗的浏览器关键路径待补；新增只读接口与前端产品代码需非作者人工评审。详见 [开发日志](./开发日志.md) 第五十三条与 [测试矩阵](./docs/test-matrix.md) 的 F-33 小节。
- 2026-09-29 本地开发新增局域网共享（`node scripts/dev-start.mjs --lan`，第五十七条记录见 [开发日志](./开发日志.md)）：Vite 以 HTTPS 监听 `0.0.0.0:5173`，自签证书由脚本调用 openssl 生成在 `.data/dev-certs`（SAN 覆盖 `localhost`、`127.0.0.1`、本机名与当前全部局域网 IPv4，地址变化时重建；openssl 依次取 `INPULSE_OPENSSL`、`PATH` 与 Git for Windows 自带版本），并使 API 经新增环境变量 `INPULSE_API_HOST` 只监听 `127.0.0.1:3000`（`apps/api/src/main.ts` 未设置时保持原行为），局域网流量统一经 Vite 同源代理进入。局域网必须走 HTTPS：会话与 CSRF Cookie 是 `__Host-` 加 `Secure`，浏览器拒绝在局域网明文 HTTP 保存；Vite 代理仅在启用 HTTPS 时追加 `xfwd: true`，把原始协议转发给 API 的同源校验。`--lan` 不改写 `SSO_REDIRECT_URI`（保持用户已登记的 Casdoor 地址），脚本在启用 SSO 时提示局域网设备走 SSO 需改配置并重新登记。联调修复 `apps/web/tools/vite-csp.ts` 的真实缺陷：Vite 8 的 `server.https` 走 `http2.createSecureServer`，Node 的 HTTP/2 兼容层在 `end()` 内部经 `this.write()` 写出 body，而 `rewriteHtmlBody` 的缓冲式 `write`/`end` 覆写会把整段 body 二次收集，HTTPS 下响应体为空（h1 不走该路径故此前未暴露）；修复为发送前恢复原型 `write`/`end` 并改用 `.call(response, …)`，新增回归用例并做鉴别性实验（去掉修复仅该用例红灯）。本地实测：`--lan` 启动后 `https://10.1.7.170:5173`（含主机名入口 `https://shaochenyu:5173`）HTTP 200，curl 与真实 Chromium 均完成 CSRF → 登录 → `/api/v1/me`（`__Host-session` 为 `secure=true`），HMR `wss://` 连接成功；`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`check:docs`、web 单测 87 文件 596 例（含新增回归用例）、api 单测 67 文件 378 例本地通过；`pnpm check` 整链、`test:integration` 与 GitHub Actions 未运行；本次未新增 Playwright 用例，改动仍需非作者人工评审。

## 2026-09-29 任务「截止时间」点击方框即展开日历并按「年」键入（⚠️ 已被 2026-09-30 的「自绘日历弹层」取代，保留作排障记录）

用户指示（原话）：「在新建任务的时候，选择截止时间，我希望在点击这个方框时就会展开日历，并且进入填写年份模式」。截止时间沿用原生 `datetime-local`——项目未引入 dayjs，antd `DatePicker` 需要新增生产依赖（按第 4 节只能走独立 PR），因此本轮不换控件，只补「点击即展开」与「年优先键入」两件事：

- 新增 `apps/web/src/features/common/native-date-picker.ts`：`nativeDateTimePickerClick` 在点击输入框时调 `input.showPicker()`——Chromium 原本只在点右侧日历图标时展开日历，点输入框本身只落光标；`nativeDateTimePickerMouseDown` 只在**空值**时 `preventDefault()`，使点击落不到「日」段，再由 `focus()` 把光标交给第一段（zh-CN 显示顺序为 年/月/日，即年份），可以直接键入年份。已有值时保留原生行为，点哪一段编辑哪一段。
- 接入三处同一字段：新建任务（`GlobalTaskCreateModal`，`#global-task-due`）、编辑任务（`TasksPanel`，`#task-due`）、遗留问题转跟进任务（`ConvertLeftoverTask`，`#leftover-task-due`）；值语义、`toISOString()` 换算与 E2E 的 `fill()` 用法均不变。
- `showPicker()` 需要用户手势，不支持或已展开时会抛错（jsdom 下该方法不存在），一律静默忽略；单测 `apps/web/src/features/common/native-date-picker.test.tsx` 5 例覆盖「调用展开」「空值先聚焦」「有值不重设光标」「不支持 / 被拒绝不抛错」「只有空值阻止默认落光标」。
- 验证边界（如实记录）：无头 Chromium 无法模拟原生日期框的逐段键入——对页面上新建的裸 `<input type="datetime-local">` 分别用 `keyboard.press` 逐键、`keyboard.insertText` 与 `ArrowUp` 实测，`value` 始终为 `""`，因此「光标落在年段」只有 `focus()` 行为与单测背书；真机探针只确认了「点击方框会调用 `showPicker()` 一次且无异常」。有头浏览器在本机启动失败（`browserType.launch: spawn UNKNOWN`），未能改为有头复核。

## 2026-09-29 重新打开「新建项目」时清掉上一次的成功卡片

用户指示（原话）：「还有如果没有保存新建项目那就一切清空，我发现再次点击会有上次残留」。先定位「残留」到底在哪：用一次性真机探针（Playwright，无头 Chromium，脚本用后删除、**只填不提交、未向数据库写入任何项目**）走「填写 → 取消 → 重新打开」，新建项目弹窗的名称 / 编码 / 描述回到空串、卡片简称回到 `—`、成员提示回到「已选择 0 位其他成员」；新建任务、新增模块、新增功能、新建迭代记录的表单本身也都会重置。**唯一能复现的「上次残留」是项目创建成功横幅**：创建成功后 `ProjectsPageView` 的 `createdProject` 卡片一直挂在项目页上，再次点「新建项目」时它仍在，显示的仍是上一个项目名。

- `ProjectsPageView` 新增可选入参 `onStartCreate?: (() => void) | undefined`，两个「新建项目」入口（页头 `data-testid="create-project-button"` 与空列表空态里的同名按钮）的 `onClick` 里先调 `onStartCreate?.()` 再 `setCreateOpen(true)`；`ProjectsPage` 用 `handleStartCreate = () => setCreatedProject(null)` 接上——成功卡片的真值在页面层，清理只能由页面层做，视图层因此不新增本地 state。
- `CreateProjectModal` 自己的重置逻辑（`useEffect([open])` 的 `reset(defaultValues)` + 清空成员选择）本来就对，没有改；服务端、契约与数据库本批未动。
- 新增单测 `apps/web/src/pages/projects/ProjectsPage.test.tsx` 第 2 例「clears the previous success card when the create form is reopened」覆盖「创建成功 → 再点新建项目 → 横幅消失」；同文件 3 处 `getByRole("button", { name: "新建项目" })` 改为 `getByTestId("create-project-button")`——空列表下页头与空态各有一个同名按钮，`getByRole` 会命中多个而报错。
- 测试环境限制（如实记录）：`AppModal` 靠 antd 过渡帧判定卸载，jsdom 里没有过渡帧，`open` 置 false 后节点仍留在 DOM（最小探针实测：`rerender(open=false)` 800ms 后仍有 `.ant-modal-wrap` 且无 `display:none`），所以在单测里断言「弹窗消失」会误报；真机里同一个「取消」是立即关闭的。该批单测因此直接断言用户看得见的结果（横幅消失），并在真机探针里补了「取消后 `visible=false`」这一条。
- 已知同类项（未处理，待用户确认）：`ProjectsPageView.managementSuccess`（编辑 / 删除项目后的成功语）同样会一直挂着。门禁：`pnpm check` → exit 0（web 单测 89 文件 603 例、`check:frontend:boundaries` 297 模块 1460 依赖、`check:deps` 735 源文件、`check:secrets` 1108 文件、`check:docs` 101 个 Markdown）；`pnpm --filter @inpulse/web typecheck` 与 8 个改动文件的 `prettier --check` 均通过。本批**未提交、未推送**。

## 2026-09-30 任务「截止时间」改为自绘日历弹层（原生弹层会压住输入框）

用户指示（原话）：「这个排版不太对，日历不可以把截止日期填写框盖住的」。根因是上一节（2026-09-29）那条路的固有上限：截图里的遮挡物是 Chromium **原生的 `datetime-local` 面板**，位置由浏览器决定——字段在居中弹窗里靠近窗口右侧时（实测 `#task-due` 右边缘 1112px / 窗口 1440px），Chrome 判定右侧放不下，就把面板摆到输入框**左侧**，直接压住输入框与左侧相邻字段；`showPicker()` 与点右侧日历图标两条路径位置完全相同，CSS / `position` 都改不了。因此本轮把日历换成自绘弹层，原生输入框只保留键入职责。

- 新增 `apps/web/src/features/common/components/CalmDateTimeInput.tsx` + `calm-date-picker.css`：`antd Popover`（触发器 `click`、默认 `placement=bottomLeft`、关箭头、`destroyOnHidden`）包住原生 `input`（`type=datetime-local`，只负责键入）与一枚 `pointer-events: none` 的装饰日历图标，并隐藏原生 `::-webkit-calendar-picker-indicator`。面板自绘「年 / 月 select + 周一开头网格 + 时 / 分 select + 清空 / 今天 / 完成」，值格式仍是本地 `YYYY-MM-DDTHH:mm`；日期断言一律用**本地时间**拼串，不走 `toISOString()`（它会按时区改掉日期）。不换 antd `DatePicker` 的原因与上一节相同：它需要 dayjs 生产依赖，按第 4 节只能走独立 PR。
- 弹层位置交给 rc-trigger 计算：默认贴在字段**正下方**（实测功能页 `bottomLeft`、间距 4.66px），下方空间不足时翻到字段**上方**（实测任务中心弹窗 `topLeft`、间距 4.29px，因为弹窗把下方视口空间压到低于面板高度）。两条路径都**不覆盖字段**（几何量测的 x/y 重叠量均为负值）。
- 两个必须知道的坑（已实测）：① antd `Popover` 的 `content` 不能是 `null`——Tooltip 会判定「无标题」并把打开状态压回 `false`，面板永远打不开；② `apps/web/src/styles/antd-adapter.css` 为原型里的账户 / 通知气泡把 `.ant-popover-container` 压成 1×1 透明盒、`.ant-popover-content` 绝对定位，日历继承后弹层变成 2×2 透明（`document.elementFromPoint` 能打到格子，但肉眼看不见）。已在 `calm-date-picker.css` 用 `div.ant-popover.calm-date-popover > div.ant-popover-container`（特异性 0,3,2）覆写回白色卡片 + `position: static`；因此组件**不再**通过 Popover 的内联 `styles` 下发外形（内联压不过该规则），全部走 CSS。
- 三处接入（`#global-task-due`、`#task-due`、`#leftover-task-due`）的原 `id` 与 `aria-describedby` 全部保留，调用方换算语义不变（`next === "" ? null : new Date(next).toISOString()`）；`native-date-picker.ts` 与其单测已删除，第五十九条的 `TASK-DUE-PICKER-*` 用例随之作废。
- 门禁与实测（本地）：`pnpm --filter @inpulse/web typecheck` exit 0；`pnpm --filter @inpulse/web exec vitest run` **89 文件 609 例全绿**（上批 603 例；删 5 例、增 11 例）；`pnpm check` **exit 0**（`check:deps` 735 源文件、`check:frontend:boundaries` 298 模块 1464 依赖、`check:secrets` 1109 文件、`check:docs` 101 个 Markdown、`permissions:check` 100 / 100）。真机复核（一次性 Playwright 无头 Chromium 脚本，用后删除）：两条页面路径的 `placement` / 间距 / 重叠见上，`containerSize` 260×316.5、`backgroundColor` `rgb(255,255,255)`、`contentPosition` `static`；选日期 → `2026-09-22T00:00`、再选时分 → `2026-09-22T09:30`，「完成」后面板卸载且值保留。未做的：键鼠可达性只覆盖点击路径（Tab 顺序 / Esc 关闭未做）、跨浏览器未复核、全量 E2E 未重跑。本批含前端产品代码，按 §8 需非作者人工评审；**未提交、未推送**。

## 2026-09-30 ADR-055 项目保留期自动彻底删除说明

> **已由 [ADR-062](./docs/adr/ADR-062.md) 取代（2026-10-09）**：保留期自动删除整体下线（项目已是物理删除，不存在待清理的软删除行），`ProjectAutoPurgeService` / `ProjectAutoPurgeScheduler` 与其测试已删除，本节以下内容仅作变更历史。

按用户 2026-09-30 指示（「我希望删除的项目30天后会被彻底删除，如果还原过，那就按最后一次删除来计算时间」）为 [ADR-051](./docs/adr/ADR-051.md) 的彻底删除补一条自动触发路径（[ADR-055](./docs/adr/ADR-055.md)）。因此：

- 保留期 30 天，从 `app.projects.deleted_at` 起算、由数据库时钟判断（`deleted_at <= now() - make_interval(days => $1::integer)`，避免多实例时钟偏差）；还原会清空 `deleted_at`、重新删除会写入新的删除时间，因此天然「按最后一次删除计时」，**不新增**任何状态列或计数器。
- 触发在服务端进程内：`ProjectAutoPurgeService` + `ProjectAutoPurgeScheduler`（启动 1 分钟后首跑，成功后每小时一次，抛错 60 秒后重试，定时器 `unref()`），随 `ProjectManagementModule` 注册；`NODE_ENV=test` 不启动（避免挂住 vitest），`PROJECT_AUTO_PURGE_ENABLED=false` 可整体关闭，`PROJECT_AUTO_PURGE_RETENTION_DAYS`（默认 30）与 `PROJECT_AUTO_PURGE_BATCH_SIZE`（默认 20）为可选覆盖，非正整数配置 fail closed。
- 执行语义：只读候选查询（`deleted_at ASC, id ASC` 取到期项目）→ 每个候选一个**独立事务**、`FOR UPDATE` 行锁内复核保留期 → `app.purge_project` → SYSTEM 链写一条 `project.purge`（`actorType: SYSTEM`、`actorId: null`、`trigger: AUTO_RETENTION`、`retentionDays`、`deletedAt` / `deletedBy` 快照与七项计数，与手工路径的 `actorRole: SYSTEM_ADMIN`、无 `trigger` 可区分）。复核未命中（已还原、已被并发彻底删除、删除时间被刷新）即跳过；单项目失败只回滚该项目并进 `failedProjectIds`，下一轮重试，不阻塞同批其它项目。
- 零契约面：不新增路由、契约、权限矩阵条目与生成客户端产物（Route Registry 仍 99 条），不改数据库与迁移（复用 `0031_project_purge.sql` 的窄口与角色授权），不改 `deploy/compose.yaml`（新环境变量都有默认值，与 `SESSION_CLEANUP_*` 同处理）。不发通知、不加保留期倒计时 UI、不回收项目编码，被自动删除后无恢复路径。
- 测试：`apps/api/test/project-auto-purge.service.test.ts` 5 例单测（候选为空时只读一次且不写审计、锁内复核未命中跳过、审计形状、单项目失败隔离、环境变量默认值与非法值 fail closed）与 `apps/api/test/project-auto-purge.integration.test.ts` 4 例真实 PostgreSQL（到期项目物理删除且项目行 / 模块 / 成员归零、`PROJECT` 审计链消失、SYSTEM 链恰好一条且 `records` 计数正确；删除 29 天不删；「删除 40 天前 → 还原 → 立刻重新删除」不删、「还原 → 再删除满 31 天」删除；活跃项目不进候选且复核谓词对活跃 / 刚删除 / 已到期三态正确）。
- 边界与例外：保留期是「满 30 天即删」，调度为一小时粒度，因此实际删除会落在到期后 0～1 小时内，批大小还会影响同一轮覆盖范围；要改成删除前提醒、可配置保留期或恢复路径，必须新增 ADR 并同步权限矩阵、测试矩阵与本小节。

## 2026-09-30 全站等待态改骨架屏 + 首屏 logo 补尺寸与重制位图（用户指示，本地落库）

用户看过原型页「质感改造 · 第一批」后回「可以改吧」，本批按已确认范围只做 §2（骨架屏）与 §3（首屏 logo）；§1 favicon / 标题、§4 动效 token、§5 统一状态条按用户口径不做。开工前先盘存量：全仓等待态 50 处 / 26 文件（另扣「加载更多」按钮文案 6 处，保持原样），`Skeleton` 用量 0、`Spin` 只在路由级用过 1 次，`.calm-state` + `.calm-spinner` 与 antd `Spin` 两套写法并存。

- 新增 `apps/web/src/features/common/components/CalmSkeleton.tsx` + `calm-skeleton.css`：五形态 `list` / `card` / `table` / `timeline` / `lines`，外加 `compact` 与 `tone="sidebar"`。容器尺寸刻意与它替换掉的 `.calm-state` 对齐（1px 边框 + 10px 圆角 + 白底 + `min-height:140px`，compact 82px），扫光动画在 `prefers-reduced-motion: reduce` 下关闭；`label` 渲染成 `.sr-only` 并由 `role="status"` 承载、骨架图形本身 `aria-hidden`，原等待态里的读屏文案不丢。
- 全站 49 处替换**只落在各页原有的 `isPending` 分支里**：`isFetching`（已有数据 + 后台刷新）继续显示旧数据，不新增判断，避免每次切筛选都闪一次骨架。覆盖面含应用级 `RequireAuth` / `RequireAdmin` / 路由懒加载兜底（`app/auth/auth-guard.tsx`、`app/router/AppRouter.tsx`），深色侧栏项目树用 `tone="sidebar"`（半透明白占位块、去卡片、去白底）。
- 「加载更多」按钮文案与名称回退文案（`xx ?? "加载中"`）保持原样，不在本批范围。
- 三张 logo 补 `width` / `height`（`LoginPage.tsx` 的 `login-logo` 560×226 与 `casdoor-logo` 251×251、`AppLayout.tsx` 的 joint 480×174），并把 `inpulse-joint-logo.png` 从 2086×754 / 317,124 B 重采样到 480×174 / 22,417 B（面积平均 + 预乘 alpha；用 Node `zlib` 手写 PNG 解码 / 编码，未引入图像库，`pnpm-lock.yaml` 无改动）。
- **改了一处既有单测的定位方式（未弱化断言）**：骨架屏也带 `role="status"`，`apps/web/src/features/task-board/TaskBoardPageView.test.tsx` 原来的 `findByRole("status")` 会先命中加载骨架，现改为按文案 `findByText(/任务超过 1000 条/)` 定位、再回查 `.tb-notice` 的 `role="status"`，断言强度不变。

验证（本地实际执行）：`pnpm --filter @inpulse/web typecheck` → exit 0；`pnpm typecheck`（全 workspace 8 个项目）→ exit 0；`pnpm --filter @inpulse/web exec vitest run` → **89 文件 609 例全绿**；`pnpm exec eslint apps/web/src` → exit 0；`pnpm exec prettier --check apps/web/src` → 全部符合；`pnpm check` → **exit 0**（`check:deps` 736 源文件、`check:frontend:boundaries` 300 模块 1498 依赖、`check:secrets` 1111 文件、`check:docs` 101 个 Markdown、`deps:audit` 仅 1 条 moderate，低于 `--audit-level=high`）。另有一次性 Playwright 无头探针（脚本用后删除）：给 `/api/v1/**` 加 8s 延迟并排除认证 / 会话端点后，`/projects` 出 `card` 骨架 ×3 + 侧栏 `sidebar` 骨架 ×1，`/tasks`、`/issues`、`/records` 各出 `list` 骨架，`/projects/1/modules` 出 `card` + `list` 骨架；登录页 `login-logo` 实测 300×121.06、侧栏 `joint-logo` 实测 163×46（换图后长宽比与裁切不变形）。**未运行**：`pnpm test:e2e`、`pnpm test:integration`（无服务端 / 数据库改动）。推送后 GitHub Actions：**CI run 36660346081**（18m42s）与 **Documentation run 36660346070**（49s）均成功。

遗留与偏差：① 骨架屏的 `role="status"` 让页面上多出一个 live region，§5「统一状态条 + 读屏可感知」按用户口径本轮不做，后续若要做需合并这两处播报；② `SimilarFeatures`、`TasksPanel`（两处）、`GlobalTaskCreateModal`、`SettingsPage` 原来只有一行 `<p>` 文案，换成 82px / 140px 骨架后弹窗与表单内高度会变化，属有意改动但需人工在真机确认不顶布局；③ 应用级守卫换成 4 行骨架是整页形态变化，需人工确认；④ 本批含前端产品代码与新增单测，按 §8 需非作者人工评审；⑤ 已推送 `test`（`e481908`），CI 成功。

## 2026-09-30 侧边导航收起 / 展开改为宽度过渡（隐藏动作不丝滑）

用户指示（原话）：「侧边导航栏隐藏动作不丝滑」。根因：桌面端（≥701px）收起态是 `.nav-collapsed .sidebar { display: none; }`——`display` 不可动画，点「收起导航」后侧栏瞬间消失；`.sidebar` 本身也没有 `transition`，而仓库既有动效范式（`ProjectTree` 折叠）是 `0.24s cubic-bezier(0.33, 1, 0.68, 1)`。

- `apps/web/src/styles/design-system.css`：新增 `--sidebar-width` 变量（`:root` 默认 236px，`@media (max-width: 1000px)` 覆盖为 200px，替换原先散落的 `.sidebar` 字面量）；`.brand` / `.nav-group` / `.sidebar-footer` 按整栏宽度固定排版，过渡中文字不折行；收起态为 `width: 0; opacity: 0; visibility: hidden`（`visibility` 延迟 0.24s 生效，动画结束才不可聚焦）；`.nav-collapsed .page-content` 的 `padding-left` 同节奏过渡；展开按钮 `sidebar-expand-in` 0.12s 延迟淡入；`@media (prefers-reduced-motion: reduce)` 关闭全部过渡 / 动画（必须写在媒体查询规则之后，媒体查询不提升特异性）。
- **裁切只在过渡期间与收起态开启**：`.app-shell.nav-animating .sidebar, .nav-collapsed .sidebar { overflow: hidden }`——常态必须保留 `.popover` 向右越出侧栏覆盖内容区的能力（底部通知 / 账户弹层宽 344px，常态裁切会切掉弹层右半）。
- `apps/web/src/app/layout/AppLayout.tsx`：新增 `navAnimating` 状态与 `handleToggleNav`（240ms 定时器 + 卸载清理；`NAV_COLLAPSE_MS` 与 CSS 过渡时长互相引用），收起 / 展开时给 `.app-shell` 加 `nav-animating` 类。
- 真机实测（本地 dev 页面，逐帧采样）：收起 `236 → … → 0px`（约 234ms，opacity 同步），展开 `0 → … → 236px`（约 240ms）；收起稳定态 `overflow: hidden` / `visibility: hidden`，展开后恢复可见；账户弹层越出侧栏右缘 46px 未被裁切、`elementFromPoint` 探针命中弹层；`≤700px` 移动抽屉规则不受影响。
- 按 2026-09-17 前端免测试指示未运行测试与门禁（仅改动文件 `prettier --check` 通过）；本批含前端产品代码，按 §8 需非作者人工评审；已本地提交（`906b9fe`），未推送。

## 2026-09-30 侧栏改为 fixed 定位（弹窗背景中不再随页面滚走）

用户报告（原话）：「背景里面的这个导航栏呈现有问题」（附弹窗截图）。根因：桌面端（≥701px）侧栏是 `position: sticky; top: 0; height: 100dvh`，antd 弹窗的滚动锁会给 `html` / `body` 写内联 `overflow: hidden`——此时没有滚动祖先，sticky 失去参照物、随文档一起滚走，弹窗背景里只剩半截深色栏。真机对照实验（Playwright）：解锁 overflow 后 `scrollTo(300 / 495)` 侧栏 `top` 恒 0，锁上后分别为 -300 / -495。

- `apps/web/src/styles/design-system.css`：桌面 `.sidebar` 改 `position: fixed; top: 0; left: 0`（保留 `z-index: 40` 与 `height: 100dvh`）。
- 文档流让位改由外壳承担：`.app-shell { padding-left: var(--sidebar-width); transition: padding-left 0.24s cubic-bezier(0.33, 1, 0.68, 1) }` 加 `.app-shell.nav-collapsed { padding-left: 46px }`。`nav-collapsed` 加在 `.app-shell` 自身而非祖先，因此必须用复合选择器（误写成后代选择器 `.nav-collapsed .app-shell` 时真机实测 padding 仍 236px）。
- 本文件上一小节（「侧边导航收起 / 展开改为宽度过渡」）中「`.nav-collapsed .page-content` 的 `padding-left` 同节奏过渡」的表述由本节修订为 `.app-shell` 的左内边距过渡；其余（宽度变量、过渡时长、裁切策略、移动抽屉）均不变。
- `prefers-reduced-motion: reduce` 的选择器列表同步加入 `.app-shell`，并移除原 `.nav-collapsed .page-content` 条目。
- 真机实测：弹窗滚动锁下侧栏 `position: fixed`、`sidebar.y = 0`（含 `scrollY = 495`）；正文 `x = 236` 与改前一致；收起态 `width 0 / opacity 0 / visibility hidden` 加外壳左内边距 46px；账户弹层越出侧栏右缘 46px 未被裁切。
- 缺陷为既有问题（`git log -S` 至少 2026-09-14 起存在），非收起 / 展开过渡批次引入；按 2026-09-17 前端免测试指示未运行测试与门禁（仅改动文件 `prettier --check` 通过）；本批含前端产品代码，按 §8 需非作者人工评审；已本地提交（`ce904a3`），未推送。

## 2026-09-30 任务看板卡片等高

用户指示（原话）：「把卡片的布局大小都统一一下」（附 `/projects/1/task-board` 看板截图）。真机量测（55 张卡片）：宽度本来就统一（253.6px），高度有 4 档（78 / 83 / 91 / 100）；逐行诊断定位到两处可变高度行——`.tb-card-top` 只有 ✓ 勾（14px）时 15px、带 `.badge`（24.5px）时 24.5px；`.tb-card-title` 1 行 16.9px、2 行 33.8px（`-webkit-line-clamp: 2`）。`.tb-card-meta` 恒 15.8px。

- `apps/web/src/styles/design-system.css`：`.tb-card-top { min-height: 25px }`（按 `.badge` 实测高度 24.5px 预留）；`.tb-card-title { min-height: 2.7em }`（标题最多 2 行，恒定预留 2 行位置；用 em 跟随自身字号）。
- 未选方案：`.tb-lane-cards` 加 `grid-auto-rows: 1fr` 会把卡片少的泳道卡片拉得极高；`.tb-lane-cards > li` 的拉伸只作用于行内、跨行不生效。
- 真机实测：改前 `distinctHeights: [100, 78, 91, 83]` 改为后 **55 张全部 100.5px 高 × 253.6px 宽**，7 个泳道逐张复核卡内三行（25 / 33.8 / 15.8）完全一致；`prettier --check` 通过。
- 按 2026-09-17 前端免测试指示未运行测试与门禁；≤1100px 窄断点未单独实测（未验证）；列表视图 `.tb-row` 不受影响；本批含前端产品代码，按 §8 需非作者人工评审；已本地提交（`89a1365`），未推送。

## 2026-09-30 维护中项目不产出任务中心卡片（R-3 / R-7 读取收窄）

用户指示（原话）：「项目进入维护中后，任务中心已完成未完成的任务卡片要求都不显示」。此前 R-3（我的任务）与 R-7（任务聚合组）读取链路只按 `AuthorizedProjectScope` 收窄，没有任何项目状态过滤：ADR-043 的 409 只在切换时校验任务已收尾，切维护中后项目仍可产生新任务，这些任务与聚合组卡照常出现在任务中心，并计入 `stats` 角标（演示库实测：维护中项目 `test`（project 118）的已完成任务仍出现在「已完成」列表，角标 17）。

- 新增只读端口 `ProjectQueryPort.listStatuses(projectIds)`（`apps/api/src/modules/projects/project-query.port.ts` 的 `ProjectStatusRef` + PostgreSQL 适配器；只查 id 与 status、空输入短路、未知 ID 不返回）与公共助手 `apps/api/src/modules/aggregate-read/maintenance-project-filter.ts` 的 `excludeMaintenanceProjects`（剔除 `status = MAINTENANCE` 的项目 ID；读不到状态的 ID 原样保留，避免放大范围）。
- R-3 `MyTasksQueryService.listMyTasks` 与 R-7 `TaskGroupQueryService.listTaskGroups` 在**分页、统计、遗留问题入口、聚合组列表之前**统一使用收窄后的 `projectIds`，避免「卡片消失但统计与角标仍计入」的不一致；授权范围内全部为维护中时复用既有空集合短路（不发 SQL，返回空页与零统计）。
- 这是**展示口径**，不是权限收窄：维护中项目仍可写（ADR-043「三态都可写」不变），项目内任务 / 迭代记录 / 任务看板不受影响；R-1 单组详情与 R-4 组内记录刻意**不**过滤（已打开的深链在项目转维护中后仍可读）；未开始 / 进行中项目不在剔除范围内。契约只更新 `listMyTasks` / `listTaskGroups` 两条路由 summary 描述，路由数不变（100 条）。
- 测试：单测 4 例（R-3 / R-7 各 2，含全维护中短路）+ 真实 PostgreSQL 集成 2 例（含「切回进行中后重新出现」与「R-1 详情仍可读」反证）；`docs/test-matrix.md` 新增「维护中项目不产出任务卡片」小节（`MAINT-FILTER-*` 6 条）。鉴别性验证：临时还原未过滤集合后集成用例转红，恢复后转绿。
- 本地验证：`pnpm check` 至 `deps:audit` 之前全部通过（contract 100 条、权限 100/100、typecheck 8 workspace、api 单测 68 文件 389 例、web 89 文件 610 例、真实 PostgreSQL 集成 53 文件 495 例、lint / 格式 / 依赖边界 / Secret / 文档门禁）；`deps:audit` 因新公布的 `brace-expansion` high 公告中断（与本批无关，按 §4 走独立 PR）；浏览器实测演示库「已完成」角标 17 → 16 且维护中项目任务不再出现。本批为 R-3 / R-7 语义收窄，需非作者人工评审；已本地提交（`c0d362c`），未推送。

## 2026-09-30 项目与功能页标题行内加入本地搜索框（用户指示，本地落库）

用户指示（原话）：先「项目与功能页面帮我画出来的地方加一个搜索框」（附标注截图），随后限定「我只需要在项目与功能的页面里面添加，然后是和标题并行的，其他页面不要添加」。因此搜索框只落在项目与功能页（`/projects`），且与标题同行：

- `ProjectsPageView.tsx`：新增 `search` state 与 `visibleProjects` 本地筛选（`toLocaleLowerCase().trim()` 后按 `name` / `code` / `(description ?? "")` 匹配，空关键词直通全部）；搜索框渲染在标题行 `.catalog-actions` 首位（`aria-label="搜索项目"`，占位「搜索项目名称、编码或描述」），仅在 `projects.length > 0` 时渲染；无匹配时显示「没有匹配的项目」空态与「清空搜索」按钮。不走全局搜索、不调 API，其余页面未添加搜索框。
- `design-system.css`：新增 `.catalog-heading { white-space: nowrap }`——900px 窄屏实测新搜索框把标题挤成两行（41px 单行 → 81px 两行），加此规则后标题保持单行，空间不足时由右侧工具组（`.catalog-actions`）先换行。
- 真机验证（本地 dev `/projects`，Playwright 探针 + 截图）：按名称（「3D」）/ 编码（「inspection」，大小写不敏感）/ 描述（「贯穿」）过滤、无匹配空态与「清空搜索」恢复、「层级说明」保留逐项通过；搜索框与 `h1` 垂直同心、header 高 56、网格 `y=115` 与改动前一致；宽度扫描 [1440, 1200, 1000, 900, 760] 标题保持单行（900 下 header 78、工具组换行为两行，第二行仅「新建项目」，可接受）。
- 按 2026-09-17 前端免测试指示未运行任何测试与门禁（仅对改动文件执行 `prettier --check` 通过，本次文档提交另跑 `pnpm check:docs` 通过）；本批含前端产品代码，按 §8 需非作者人工评审；已本地提交（`a009533`），未推送。

## 2026-10-08 任务中心两档卡片等高（用户指示，本地落库）

用户指示（原话）：「已完成和未完成任务卡片的布局也要一样大」（附 `/tasks` 两档截图：未完成档多数卡片没有页脚、已完成档多数带「记录 n 条」页脚）。只改前端，无 API / 契约 / 权限 / 迁移改动，沿用 2026-09-30 任务看板等高的既有手法（补齐可变高度行，而不是给网格或卡片写死高度）。

- 根因：`.task-card-footer` 原先只在 `item.publishedRecordCount > 0` 时渲染，于是同一张 `.calm-task-grid` 里无记录的卡片比有记录的矮一个页脚（31.5px）；「未完成」档无记录卡居多、「已完成」档几乎每张都有，并排看两档高度不齐。网格行高由行内最高卡决定（`stretch` 会拉齐同排），所以缺陷只在**整档页脚全为空**时才可见。
- 改动：`TaskCenterPageView.tsx` 的任务卡页脚改为**恒渲染**（有记录仍是「记录 n 条」，无记录为空占位盒）；`renderGroupCard` 末尾补一个空 `.task-card-footer` 占位，继续与任务卡逐行同构（组卡同时带 `.calm-task-card` 类）；`design-system.css` 新增 `.calm-task-card .task-card-footer { min-height: 31.5px }`（31.5px = `padding-top: 15px` + 11px × 1.5 行高，即满内容时的自然高度）。项目任务面板（`TasksPanel`）页脚本来就每卡必渲染，未改。
- 真机实测（一次性 Playwright 只读探针，1440×900，本地演示库、账号 `tege`，量测后删除、不入库）：未完成档 20 张全 `270px` / 页脚 `31.5px`，已完成档 19 张（15 张带计数 + 4 张空）同样 `270px` / `31.5px`，行内混合无高差；反事实注入 `min-height: 0 !important` 后未完成档塌回 `253.5px` / 页脚 `15px`，即改动前「未完成档比已完成档矮 16.5px」的缺陷形态；空页脚内注入「记录 99 条」后页脚仍 31.5px（占位不会把有记录的卡片撑高）。
- 探针排障留档：本机 Chromium 从 `http://127.0.0.1:5173` **不保存** `Secure` Cookie（`http://localhost:5173` 保存），且浏览器内登录在本机始终 401（`INVALID_AUTH_CREDENTIALS`），而同一口令经 curl 走同源完整流程 200 成功——服务端与代理链路已证清白，量测改用 curl 取回 `__Host-session` 后经 `context.setExtraHTTPHeaders({ Cookie })` 注入（CDP 拒绝向 http 源注入 Secure Cookie）。E2E 配置用的是 `http://127.0.0.1:${E2E_WEB_PORT}`，CI（Linux Chromium）登录正常，该差异只影响本机一次性探针，未改动任何仓库代码；是否影响本机浏览器登录未定论（用户日常浏览未复现）。
- 未运行：vitest / `pnpm test:web` / Playwright 套件 / `pnpm check`（按 2026-09-17 前端免测试指示）；组卡等高未做真机量测（量测当日该账号可见范围内 `groupCount: 0`，只由 DOM 断言与同一条 CSS 规则背书，未验证）；本批含前端产品代码与新增单测，按 §8 需非作者人工评审；测试矩阵 `docs/test-matrix.md` 末节「任务中心卡片等高」与 `docs/task-card-colors.md` 变更历史同日行已同步；已本地提交，未推送。

## 2026-10-08 聚合动态单一游标分页 + 服务端按日全量计数（用户指示，本地落库）

用户指示（原话）：「那这样有问题，包含管理员操作是默认的，动态过多是可以等加载更多再呈现出来但是日期边上那个动态数量是要有全部的而不是每次加载更多才会增加，并且动态是根据时间排好呈现出来的，而不是加载更多以后又在之前的时间里面加了动态」。三件事：**(a)** 「包含管理员操作」默认勾选；**(b)** 日期旁条数取服务端全量；**(c)** 时间线全局有序、「加载更多」只向更早追加。

- **(c) 的根因是取数方式**：旧实现按项目逐个分页（每项目一条游标）再在客户端全局归并排序，某个项目的下一页必然可能晚于其它项目已渲染的条目，所以「加载更多」一定回插。本轮改为**新增只读路由 `GET /api/v1/activity`（`listActivity`）**＋**一条 SQL 的跨项目键集分页**（`ORDER BY occurred_at DESC, id DESC`，游标 `(occurred_at, id)`），追加式由构造保证；客户端删除全局重排（`flattenActivityPages` 只拼接），「全部项目」不再逐项目 fan-out。Route Registry 由 100 条增至 **101 条**；该路由 `authPolicy: "session"`、其余策略显式 `none`、状态码 200/401/422/500（**无 404**）。
- 范围 = 实时 `AuthorizedProjectScope` ∪ **全部已删除项目**（新增 `ProjectAccessQueryPort.listDeletedProjectIds()`），保留 ADR-050 / ADR-052 的已删除项目公开动态链；`ADMIN_ONLY` 只对系统管理员在本人的活跃成员项目开放，已删除项目链永远只有 `MEMBER`。`projectIds`（逗号分隔 1..100 正整数、去重、显式空值 422）**只收窄**，越权 / 未知 ID 静默排除，全部越权返回空页且不发 SQL。**（2026-10-09 修订，[ADR-062](./docs/adr/ADR-062.md)）**：`listDeletedProjectIds()` 与已删除项目并入范围已删除，`listActivity` 只剩实时 `AuthorizedProjectScope`。
- **(b) 的实现**：`dayTotals` 由服务端在同一次请求内按与列表完全相同的条件（同一收窄后 `projectIds`、同一 `category`、同一 `includeAdminOnly`）单独全量统计；日界 **Asia/Shanghai 自然日**（SQL `occurred_at AT TIME ZONE 'Asia/Shanghai'`）；上限 `ACTIVITY_DAY_TOTALS_MAX = 400` 天，超出时 `dayTotalsTruncated = true`，前端提示「按日数量只统计最近 400 个自然日内的动态」，窗口外日期回退为已加载条数。`getProjectActivity` 同步新增 `dayTotals` / `dayTotalsTruncated` 与可选 `category`。
- `category`（all / task / record / feature / module / project / member / github）由 `ACTIVITY_CATEGORY_SQL` 下推到 SQL，前端筛选芯片经 `ACTIVITY_CHIP_CATEGORY` 映射为 `ActivityCategory`，不再只在客户端过滤。
- **(a) 的实现**：`ActivityWorkspace` 的 `includeAdminOnly` 初值改为 `true`（勾选框仍只对 `isAdmin` 渲染）。之前的「勾选后变少」纯属前端缓存现象——`queryKey` 含 `includeAdminOnly`，切换时无限查询被重置、已加载页全部丢弃（当时服务端 `ADMIN_ONLY` 行为 0）。
- 游标绑定：`TimeCursorService` 命名空间 `ACTIVITY`，载荷含 `projectId: number | null` 与 `filterKey`；`activityFilterKey` = `v1|scope=<project:{id}|feed>|category=…|projects=<升序 csv|all>|admin=0|1`，即游标绑定**路由身份 + 筛选 + 操作者**，跨路由（`/activity` ↔ `/projects/{id}/activity`）或筛选变化后继续翻页一律 422 `invalid-cursor`。
- 422 分层（本次联调确认）：Schema 层（Route Registry 请求校验，如 `projectIds: ""` / `"0"`、非法 `category` / `limit`）→ `VALIDATION_FAILED`；服务层（`invalid-cursor` / `invalid-project-ids` / `invalid-category`）→ `ACTIVITY_VALIDATION_FAILED`。契约侧同时修掉 `projectIds: ""` 被 preprocess 吞成 `undefined`（等于「全部项目」）的放行缺陷。
- 测试：新增 `apps/api/test/activity-query.service.test.ts` 14 例（范围 / 收窄 / 短路 / 游标绑定 / 操作者 / 按日截断）；`activity-query.integration.test.ts` 扩到 12 例（追加式三页 `[[203,104],[103,201],[102,101]]`、`15:30Z` / `16:30Z` 证明上海日界、分类等价表、已删除链与收窄）；`activity-notifications-api.integration.test.ts` 7 例（匿名 401、跨页 `dayTotals` 恒定、越权空页、分层 422）；Web 侧重写 `activity-query.test.tsx`（只追加不重排、只读第一页 `dayTotals`、单次 `listActivity`）并更新 `ActivityPageView.test.tsx`（默认勾选 + 「4 条动态」）与 `ActivityWorkspace.deletions.test.tsx`（改指 `listActivity`）。
- 本地验证：`contract:generate` / `contract:drift`（5 产物）/ `contract:validate`（**101 条**）/ api-contract 单测 16 文件 102 例；API 单测 **69 文件 403 例**、真实 PostgreSQL 集成 **53 文件 510 例**（`app_ci`）；Web 单测 **90 文件 629 例**、全 workspace typecheck、`lint`、`format:check`、`build`（web 1987 模块）、`check:deps`（305 模块 / 1510 依赖）、`check:frontend:boundaries`、`permissions:check`（**101 / 101**）、`db:migrations:check`（31）、`db:seed:check`（28 张表）通过；E2E 定向 `tests/activity.spec.ts` **2/2（11.0s）**，新增「聚合动态默认包含管理员操作，按日条数取服务端全量」用例。
- 未运行 / 已知偏差：① 整链 `pnpm check` 在 `pnpm deps:audit` 中断，报 **6 条**既有 registry 公告（`proxy-addr` critical GHSA-jqcg-44mw-7w3h、`brace-expansion` 两条 high、`source-map-js` high 等），与本批无关，按 §4 只能走独立依赖 PR 由人工确认，未夹带修改、未调低 `--audit-level`；其后的 `check:secrets`（1125 文件）与 `check:docs`（102 个 Markdown）单独补跑均 exit 0。② 未跑全量 `pnpm test:e2e`。③ 同日分组在后续页面的**下边界**仍可能追加更早条目（键集分页固有形态，不会回插到中间）。④ 按日计数是服务端范围口径，不随前端本地关键词搜索变化。⑤ 运行 E2E 前先清理了 `app_ci` 的历史遗留夹具（用户 2412 / 项目 1325 / 业务行 43379 / 审计行 2335），E2E `global-teardown` 又清掉本轮的 3 用户 / 4 项目 / 65 业务行 / 2 审计行。⑥ 本批含契约、服务端与前端产品代码，按 §8 需非作者人工评审；已本地提交（`630a01f`，34 个文件 `+2658 / -389`，其中包含活动页吸顶改动与共享钩子 `use-sticky-band-offset.ts`），未推送。

## 2026-10-08 活动 / 记录 / 审计三页吸顶页头与日期分组头（用户指示，本地落库）

用户三条指示（原话）：①「我要求页面滚动只滚动红线一下的区域」（附 `/activity` 截图圈出标题与筛选条）②「那在这个基础上先实现时间先不会被滚走，等里面的内容滚完了再收起来」③「将迭代记录和审计日记也根据以上两次更改进行更改」。只改前端（`apps/web`），无 API / 契约 / 权限 / 迁移改动。

- 吸顶块 `.sticky-page-band`（`apps/web/src/styles/inpulse-design.css`），仅 ≥701px 且 `:not(.is-embedded)` 生效：`position: sticky; top: 0; z-index: 5; padding-bottom: 18px; background: var(--background)`。容器自带不透明底色，否则行会从标题与筛选条后方透出；工具条原有的 `margin-bottom` 挪到容器内边距上（容器最后一个子级的外边距会坍出容器底部，那一截没有底色，滚动时会在吸顶块与列表之间露出内容）。
- 分组头吸顶：`.activity-day-head`（动态 / 审计共用）与 `.records-workspace .timeline-day-head`（记录页）为 `position: sticky; top: var(--sticky-band-height, 182px); z-index: 4`，底色不透明；「当天内容滚完自己收起来」由分组头所在包裹 `<section>`（`.activity-day` / `.timeline-block`）完成——被下一组顶走是纯 CSS 行为，不需要滚动监听。
- 偏移量实测：新增共享钩子 `apps/web/src/features/common/use-sticky-band-offset.ts` 的 `useStickyBandOffset(pageRef, bandRef, enabled)`——`useLayoutEffect` 量出吸顶块高度并**向下取整**写入页面根 `--sticky-band-height`（取整让分组头顶边微微压在吸顶块下面，避免子像素取整露出细缝），`ResizeObserver` 跟随工具条折行；变量落点是吸顶块与分组头的共同祖先（两者是兄弟节点）；卸载时移除变量，兜底值 `182px` 保证变量缺席时仍可用。
- 记录页细节：分组头只吸内容列（完整头比时间线左边界靠左 104px、会伸进左侧留白列，在项目主页弹窗里会顶出弹层卡片）；记录锚点 `scroll-margin-top: calc(var(--sticky-band-height, 0px) + 16px)` 跟随吸顶块高度；吸顶时分组头容器 `padding-bottom: 10px` 接管工具条下方原本的 10px 间隔。
- 审计页新增按自然日分组（此前是平铺列表）：`AuditLogPageView` 的 `auditDayKey` 取**浏览器本地时区**（与上方 `from` / `to` 和行内时刻同一口径，因此不复用项目动态那套按 Asia/Shanghai 换算的 helper），复用 `.activity-day` / `.activity-day-head` 类（零新增审计 CSS）；行内保留 `MM-DD` 短日期，组头给完整日期与 `N 条`，首个分组头跟随 `.audit-list` 卡片的 7px 顶圆角。
- `is-embedded`（记录视图装进项目主页弹窗）不吸顶也不量高度：弹层自带头部与独立滚动区。
- 真机实测（一次性 Playwright 探针，1118×875，用后删除）：`/activity` 变量 181px、吸顶块 0→182、分组头钉在 181；`/records` 变量 179px、吸顶块 0→179、分组头钉在 179（左 374 / 宽 702，与内容列对齐）、组尾交接（前一组 −170 / 后一组钉住）、首组折叠后可见行 20→17；`/audit` 变量 182px、吸顶块 0→183、3 个分组头 / 33 行、组头钉在 182、交接（前组 −323 / 后组钉在 182）、首组 7px 圆角、折叠 32→23 行、命中测试为 `activity-day-head`；项目主页弹窗内吸顶块类为 `sticky-page-band is-embedded`、吸顶块与分组头均为 `static`、变量未设置、内部滚动 320px 时吸顶块 132 → −188（随内容滚走，符合预期）。
- 按 2026-09-17 前端免测试指示未运行自动化测试与整链门禁（实际执行的是改动文件 `prettier --check`、`pnpm --filter @inpulse/web typecheck`（exit 0）与一次性探针）；全量 `pnpm test:e2e` 未运行，GitHub Actions 未执行。本批含前端产品代码，按 §8 需非作者人工评审；已本地提交（活动页与共享实现随 `630a01f`、记录与审计页为 `32e3c42`），未推送。

## 2026-10-08 全局搜索查询下限放宽到 1 个字符（单字可搜，用户指示，本地落库）

用户报告（原话）：「搜索栏只搜索一个字的时候无法搜索」。根因是同一语义的长度下限在四处各写一份：契约 `SEARCH_QUERY_MIN_LENGTH = 2`、服务端 `MIN_QUERY_LENGTH = 2`、前端 `SEARCH_MIN_LENGTH = 2`，以及 `MergeIntoMainTaskModal.tsx` 里复制的本地常量；前端 `isValidSearchQuery` 据此直接不发请求。只改前端（`apps/web`）之外还触及契约与 `apps/api` 校验，无迁移、无权限策略与依赖改动。

- 三处同源常量统一改为 1：`packages/api-contract/src/contracts/search.zod.ts`（`SEARCH_QUERY_MAX_LENGTH = 200` 不变）、`apps/api/src/modules/search/search-text.ts`、`apps/web/src/features/search/search-query.ts`；`MergeIntoMainTaskModal.tsx` 删除本地副本改为从 `@features/search/search-query` 导入。
- **连带放开**：`record-feed.zod.ts`（B-3b `listChangeRecords` 的 `q`）共用同一常量，记录清单全文过滤下限一并由 2 变 1——单一常量不能只改一处，否则两条路由同名字段出现不同下限。
- 归一化后为空的纯空白查询继续 422（服务端 `too-short` 分支保留，现在仅 0 字触发）；前端删除 `queryIsValid` / `queryIsTooShort` 死分支与「请输入 2～200 个字符进行搜索。」提示，`SearchPageView` 与 `CommandPalette` 仅在超长时提示「搜索词最多 200 个字符」。
- PGroonga 单字可行性实测（演示库 `app`，`search_projection` 435 行）：`'的'` 123 命中、`'审'` 38、`'一'` 113、`'a'` 170，全部走 `Bitmap Index Scan on idx_search_projection_pgroonga`，`Execution Time: 0.467 ms`；ADR-025「不保证任意英文/代码子串」的口径不变。
- 文档与契约同步：`技术设计v1.2.2.md` §9.3、`系统设计文档v1.0.2.md`、`功能设计v1.1.md` §24.1 与 Route Registry 的 `getSearch` summary 统一为「1～200 个字符（单字可搜）」；`pnpm contract:generate` 重生成 5 个产物（Route Registry 仍 101 条）。
- 验证（2026-10-08 本地）：契约 `generate` / `drift` / `validate`（101 条）、`permissions:check`（101 / 101）、`lint`、`format:check`、`typecheck`（8 workspace）、`test:unit`（api-contract 16 文件 102 例、api 70 文件 405 例、web 90 文件 630 例、ops 8 文件 52 例）、`pnpm test:web`（90 / 630）、真实 PostgreSQL 集成 53 文件 511 例、`test:search:db` 2 文件 19 例、定向 E2E `tests/search.spec.ts` 6 passed（含新增中文单字用例）全部通过；整链 `pnpm check` 仅在 `deps:audit` 中断（本机 npm 镜像缺 audit endpoint），公共 registry 复核为既有公告 2 moderate / 3 high / 1 critical（`proxy-addr`、`brace-expansion` 等，与本批无关，按 §4 走独立依赖 PR），其后的 `check:secrets`（1130 文件）与 `check:docs`（102 个 Markdown）另行补跑 exit 0。**未运行**：全量 `pnpm test:e2e`、生产镜像构建与 Trivy、GitHub Actions。
- 未改：`database/poc/search/normalize.ts`（独立 PoC 脚本，仍写 2）与 `docs/poc/nestjs-11-vs-12-v1-result.md` 的历史探针记录（`q=a → 422`）；本批需非作者人工评审，未提交、未推送。

## 2026-10-08 前端交互批次：回到顶部 / 组长置顶 / 看板吸顶 / 折叠动画 / 功能列表行链接（用户逐条指示，本地落库）

用户五条指示（原话）：①「现在需要给迭代记录项目动态审计日志滚动页面加一个回到最顶上的一个按钮」②「这里组长要放在第一位」③「画出来的部分滚动也做的和迭代记录一样，只不过时间变成了模块名，记得列表也要改」+「这些要固定住」④「我指的的看板里面模块展开任务卡车的动画」+「列表没改」⑤「这个预选定框没有框对」。只改前端（`apps/web`），无 API / 契约 / 权限 / 迁移改动；按 2026-09-17 前端免测试指示未运行自动化测试与整链门禁，证据为逐项一次性 Playwright 探针（用后删除）与静态检查。

- 回到顶部：新增 `apps/web/src/features/common/components/BackToTop.tsx` + `back-to-top.css`——右下角固定按钮，`SHOW_AFTER_PX = 400` 后才浮现；监听 `window` 滚动、回顶 `window.scrollTo({ behavior: reduced ? "auto" : "smooth" })`；隐藏态用 `visibility: hidden` 兜住「不可点击、不可聚焦、读屏跳过」；`InpulseIcon` 新增 `arrowUp`；挂载于 `ActivityWorkspace`、`AuditLogPageView`、`RecordsWorkspace`（`embedded` 弹窗模式不渲染）。
- 组长置顶：新增 `apps/web/src/features/projects/project-member-order.ts` 的 `orderMembersLeaderFirst`（`LEADER` 排首、其余保持服务端顺序；先拷贝再排序，不就地改 React Query 缓存引用），`ProjectMembersPageView` 与 `ActiveProjectMembers` 两处消费。
- 看板吸顶：`TaskBoardPageView` 的标题、概览卡与工具条整块加 `.sticky-page-band` + `useStickyBandOffset`，泳道头 `.tb-lane-head` 与列表分组头吸在其下（`top: var(--sticky-band-height, 182px)`）；该页实测变量为 **311px**（概览卡占位比活动 / 记录 / 审计页多）。
- 折叠动画：两视图共用 `.tb-fold` / `.tb-fold-clip`（`grid-template-rows` 过渡）与 `@keyframes tb-enter-in`（0.24s），条目按 `--tb-enter-i` 每档 16ms 错开（上限 12，序号由 `TaskBoardLanes` / `TaskBoardTable` 写在条目自身）；`prefers-reduced-motion: reduce` 关闭动画；列表视图分组头补 `:first-child` 顶边框去除。真机逐帧量测 4 轮（展开 / 收起为连续高度变化而非跳变、错开序号生效、reduced-motion 无动画）。
- 行链接：`FeaturesPageView` 列表首行「打开功能」由 antd `<Button href>` 改为原生 `<a className="feature-list-open">`（复用任务中心 / 任务面板既有类与样式）；DOM、计算样式与截图三重复核，`prettier` / `eslint` / `typecheck` 全部 exit 0。
- 已知缺口：五项均无 Playwright 用例进套件（只有一次性探针），是回归防线缺口；折叠动画未在 Firefox / Safari 复核；本批需非作者人工评审，未提交、未推送。

## 2026-10-08 ADR-056 维护中项目新建任务回到进行中说明

按用户 2026-10-08 指示（「我要求如果给一个维护中的项目创建了一个新的任务，那么那个项目要转换为进行中」）在 [ADR-035](./docs/adr/ADR-035.md) 的自动升级路径上补第二个触发点（[ADR-056](./docs/adr/ADR-056.md)），并修订 [ADR-043](./docs/adr/ADR-043.md) 第 7 节第 3 条「不改动 ADR-035 自动升级口径」的边界。因此：

- 维护中项目新建任务即在同一事务内回到进行中：`ProjectsWritePort.reopenMaintenanceProject`（原名 `reopenMaintenanceProjectOnTaskCreate`，经 [ADR-057](./docs/adr/ADR-057.md) 收敛为中性名；`PostgresProjectsWritePort` 用单条条件 UPDATE，`WHERE p.status = 'MAINTENANCE' AND p.deleted_at IS NULL`，未命中不取行锁）由 `TasksManagementService.execute()` 的创建分支调用，覆盖 HTTP 直连、联合创建、项目成员任务与遗留问题转任务四条入口；编辑任务、状态流转（**该部分经 ADR-057 修订**）、合并与记录发布都不触发。
- 同事务写审计 `project.status.change`（`automatic: true` / `trigger: "TASK_CREATED"` / `taskId` / `before` / `after`）、活动 `PROJECT_STATUS_CHANGED`（摘要「项目重新开工：{name} 由维护中回到进行中」）与搜索投影；不写通知（沿用 ADR-035「只有未开始 → 进行中通知全体成员」），不写 `first_task_completed_at`（该标记唯一来源仍是任务完成）。
- 并发面：非维护中项目不命中任何行、不推高 `row_version`；同一事务内由创建路径已持有的项目 `FOR SHARE` 升级为写锁，不跨事务、不改变父到子的取锁顺序；状态切换与任务创建、审计、活动、搜索投影同事务提交或一同回滚。
- 零数据库面与零契约面：无迁移、无新表 / 新列 / 新角色、无新路由，Route Registry 仍 101 条，`createTask` / `createModuleTask` 幂等契约版本保持 `3.0.0`（幂等重放返回原响应、不重复执行状态切换）；`docs/permissions.md` 无改动。
- 前端与 `docs/test-matrix.md` 已同步：`docs/test-matrix.md` 新增 `ADR056-*` 共 7 条（含鉴别性验证），三份设计文档各补一节；`apps/api/test/task-create-maintenance-reopen.integration.test.ts` 5 例真实 PostgreSQL。
- 已知偏差：并发创建只有一个事务能完成状态切换这一点由条件 UPDATE 与行锁语义保证，本批没有并发真库竞态用例；连带效果是维护中项目创建任务后回到进行中、按 2026-09-30 口径重新出现在任务中心；`pnpm test:e2e`、整链 `pnpm check` 与 GitHub Actions 未运行；本批未提交、未推送。

## 2026-10-08 ADR-057 任务重新变为未收尾即回到进行中说明

按用户 2026-10-08 反馈（「现在问题我重新打开任务，将任务变为进行中还是处于维护中」）把 [ADR-056](./docs/adr/ADR-056.md) 的触发面由「任务创建」扩为「任务重新变为未收尾」（[ADR-057](./docs/adr/ADR-057.md)），并修订 ADR-056 第 5 节非目标第 2 条。因此：

- 触发条件改为：命令执行前项目为 `MAINTENANCE`，且命令执行后任务的 `work_status` 由收尾态变回未收尾态——恰好是 `REOPEN`（`DONE → TODO`）与 `RESTORE`（`CANCELED → TODO`）。`COMPLETE` / `CANCEL`（减少未收尾任务）、编辑任务、合并 / 解除合并与记录发布仍不触发。用户先前观察到「重新打开任务后项目仍是维护中」符合 ADR-056 当时的明文边界，不是缺陷，本次是需求扩展。
- 实现位置：`TasksManagementService.transition()` 在通知块之后、返回之前复用私有 `reopenMaintenanceProject(tx, input, result, trigger)`，`trigger` 取 `TASK_REOPENED` / `TASK_RESTORED`；覆盖 `transitionTask` 与 `transitionModuleTask` 两条 HTTP 路由。端口方法更名为 `ProjectsWritePort.reopenMaintenanceProject`（SQL 与返回值不变）。
- 副作用与 ADR-056 一致：同事务写审计 `project.status.change`（`automatic: true` / `trigger` 逐动作区分）、活动 `PROJECT_STATUS_CHANGED`（`metadata.trigger` 同值）与搜索投影 `PROJECT` upsert；不发项目级通知，不写 `first_task_completed_at`；任务级通知（如 `task.reopen`）照旧发送。
- 零数据库面与零契约面：无迁移、无新路由，Route Registry 仍 101 条，`transitionTask` / `transitionModuleTask` 幂等契约版本不变（响应 `TaskItem` 未变，重放不重复执行状态切换）；`docs/permissions.md` 无改动。
- 前端修复必须项：`apps/web/src/features/tasks/TaskStatusPanel.tsx` 的 `onSuccess` 失效键补 `"projects"`，否则项目卡片读的 `["projects"]` 不失效，会出现「任务已回到未完成、项目卡片仍显示维护中」的观感（与用户报障描述一致）。
- 测试：`apps/api/test/task-create-maintenance-reopen.integration.test.ts` 由 5 例扩为 9 例（新增重新打开触发、恢复触发、进行中项目不触发、同事务回滚）；鉴别性验证为临时停用 `transition()` 中的触发后新增两例转红、其余 7 例保持绿；`docs/test-matrix.md` 新增 `ADR057-*` 共 6 条。
- 未运行：全量 `pnpm test:e2e`（本批无路由与前端行为改动，仅缓存失效键）、整链 `pnpm check` 与 GitHub Actions（尚未提交推送）；本批未提交、未推送，按 §8 需非作者人工评审。

## 2026-10-08 迭代记录弹窗吸顶、回到顶部 inset 与「新建迭代记录」并入筛选行说明

用户 2026-10-08 两条指示（原话）：①「这里弹窗没改」（项目主页「查看全部」弹窗内的迭代记录与独立页 `/records` 不一致：不吸顶、无日期分组头钉住、无回到顶部）；②「把新建迭代记录放在和搜索那些同一行里」。只改前端（`apps/web`），无 API / 契约 / 权限 / 迁移改动。

- 弹窗与独立页对齐：`RecordsWorkspace.tsx` 的 `useStickyBandOffset(pageRef, bandRef)` 去掉 `!embedded` 限制——弹窗正文是 `overflow-y: auto` 的独立滚动容器，吸顶与偏移量量测都在弹窗内生效（实测页 132px / 弹窗 87px）；`is-embedded` 的吸顶块与分组头底色用白色 `#ffffff` 覆写（弹窗是白色卡片表面）。
- 弹窗正文顶部内边距改由吸顶块承担：`.project-workspace-modal > .project-workspace-modal-body:has(> .records-workspace) { padding-top: 0 }` 必须与 `.project-workspace-modal .records-workspace.is-embedded .sticky-page-band { padding-top: 20px }` 成对存在，否则卡片会从吸顶块与正文之间的缝隙滑过；`TasksPage` 共用 `project-workspace-modal`，用 `:has` 把改动面收窄到记录视图容器。已无消费方的 `.page-header.embedded` 规则删除。
- 记录视图在弹窗内不渲染自己的页头（标题由弹窗承担）；独立页页头只保留标题与说明。「新建迭代记录」由独立页页头移入筛选工具条最右端，与「生成总结」同排（`.records-toolbar-actions`，原 `.records-toolbar-summary`，`margin-left: auto` + `gap: 10px`）。
- `BackToTop` 在弹窗内渲染 `inset` 变体（`position: sticky; right: auto; bottom: 4px; margin-left: auto`）；`nearestScroller` 向上探测最近的 `overflow-y: auto|scroll` 祖先作为滚动、监听与回顶目标，找不到时回退 `window`。
- 修订上文表述：本小节之前，「活动 / 记录 / 审计三页吸顶页头与日期分组头」小节中「仅 ≥701px 且 `:not(.is-embedded)` 生效」「`is-embedded`（记录视图装进项目主页弹窗）不吸顶、不量高度」与「项目主页记录弹窗内吸顶块与分组头均为 `static`、变量未设置、弹窗内滚动 320px 时吸顶块 132 → −188」，以及「前端交互批次」小节中「挂载三处…（记录视图装在项目主页弹窗时 `embedded` 不渲染）」均为当时事实，与本节冲突时以本节为准。
- 验证：一次性 Playwright 结构探针（用后删除、未入库）——独立页 `/records`：页头恰 1 个、搜索与动作组同一行（top 117 / bottom 152）且动作组右缘 = 工具条右缘（1398）、按钮次序 [生成总结 / 新建迭代记录] 不换行、`--sticky-band-height: 132px`；弹窗模式（项目主页「查看全部」）：无页头、吸顶块 `sticky-page-band is-embedded`、顶部 112 / 高度 88 / 变量 87px、搜索与动作组同排（top 153 / 高 35）、两按钮 enabled。改动文件 `prettier --check` 与 `pnpm --filter @inpulse/web typecheck` 通过；按 2026-09-17 前端免测试指示未运行 vitest / Playwright 套件 / 整链门禁。
- 未运行 / 已知偏差：弹窗内滚动矩阵（分组头钉住、回到顶部 `inset` 贴底）在页头移除后复跑探针未命中项目主页弹窗（「查看全部」未找到），**未取得量测**，列为未取证；本批无 Playwright 用例进套件；按 §8 需非作者人工评审；已本地提交、未推送。

## 2026-10-08 遗留问题卡片布局统一说明

用户 2026-10-08 指示（原话）：「遗留问题的布局也统一一下」（附 `/issues` 未闭环两张卡片截图：短标题与徽章、编号挤同一行，长标题独占一行，两卡不等高）。只改前端样式（`apps/web/src/styles/design-system.css`），无 API / 契约 / 权限 / 迁移改动。

- 根因：`.issue-head` 是 `flex-wrap: wrap`，标题（`strong`）只在放不下时才整块换行——短标题卡片是「徽章 + 编号 + 标题」同行，长标题卡片标题独占一行，同一列表两种版式；`.issue-origin` 还会因项目 / 模块 / 功能名长短不一而换行，再叠一层高差（实测 5 张卡片 90 / 120 / 90 / 109 / 90）。
- 统一手法与任务看板 `.tb-card-title`（2026-09-30）一致：`.issue-head strong` 加 `flex-basis: 100%`（标题恒独占一行）、`-webkit-line-clamp: 2` 封顶 2 行、`min-height: 3.2em` 恒预留 2 行（1.6 行高 × 2）；`.issue-origin` 同样封顶 2 行并 `min-height: 3.5em` 恒预留 2 行（1.75 行高 × 2）。
- 取舍：以「预留最大行数」换全列表等高，单行内容卡片会多出一行空白——与看板 / 任务中心两次等高的既有取舍一致；只改样式，DOM、文案与按钮行为均未动。
- 验证：一次性 Playwright 量测探针（同一共享页面，用后删除、不入库）——改动前 5 张卡片高 [90, 120, 90, 109, 90]；改动后全部 160px、每张标题独占一行（`strong.left` = 内容左缘）、标题盒 42px / 来源盒 39px（各 2 行预留）；截图肉眼复核两卡版式一致。`prettier --check` 通过；按 2026-09-17 前端免测试指示未运行 vitest / Playwright 套件 / 整链门禁。
- 未运行 / 已知偏差：本批无用例进 vitest / E2E 套件；等高以预留行实现，单行内容卡片存在一行空白（有意取舍）；按 §8 需非作者人工评审；已本地提交、未推送。

## 2026-10-08 项目列表同档位内改按「最近变更时间」排序说明

用户指示（原话）：「把同状态的项目根据最近的变更排序，最新变更的放在前面，变更指的是生成任务，完成任务等变更」，即 [ADR-046](./docs/adr/ADR-046.md) 的 2026-10-08 修订（只加不改原文）。因此：

- 项目列表第二排序键由 `created_at DESC` 改为**最近变更时间 DESC**，其后仍是 `created_at DESC`、`id DESC` 兜底；第一键（档位：进行中 → 未开始 → 维护中）以及模块 / 功能列表口径不变。
- 「最近变更时间」= 该项目动态投影（`app.activity_projection`）里最新一条业务事件的发生时间（`MAX(occurred_at) WHERE project_id = p.id`）；没有动态的项目回落 `p.created_at`。不要换回 `projects.updated_at` / `row_version`——生成与完成任务不会改项目行，只有项目动态能反映「最近有变更」。
- 实现位置：`apps/api/src/stats/card-stat-columns.ts` 的 `projectLastChangeExpression` + `apps/api/src/modules/projects/postgres-project-query-port.ts` 的 `list`；不新增索引（走既有 `activity_projection_project_cursor_idx`）与迁移。
- 契约：`listProjects` 的 Route Registry summary 已同步，改描述后必须重跑 `pnpm contract:generate` 与 `pnpm contract:drift`；路由仍 101 条。
- 回归防线：`apps/api/test/projects-read-api.integration.test.ts` 的「同状态项目按最近变更时间从近到远」（无动态回落 / 较新变更提前 / 更新变更反超 / 档位优先），改动排序键时必须跑该文件。

## 2026-10-08 GitHub 链接接受裸 commit SHA 说明

用户指示（原话）：「添加github链接能不能除了直接粘贴网址，还能在根仓库已经提交的情况下直接粘贴commits的SHA值来直接确定commit网址」。作为 [ADR-022](./docs/adr/ADR-022.md) 的 2026-10-08 修订落地（只加不改原文）：

- 识别只按形状 `^[0-9a-fA-F]{7,64}$`（裁剪首尾空白、统一小写；6 位及以下不识别，仍按 422 `EXTERNAL_LINK_INVALID_URL` 拒绝），与数据库 `external_sha` 的 CHECK 同形状。
- 补全必须发生在服务端：`ExternalLinkWorkflow.resolveSubmittedUrl` 用项目根仓库（`is_root_repository`）拼出 `https://github.com/<owner>/<repo>/commit/<sha>` 后再进入 `normalizeGitHubUrl` 与落库；前端只做预览提示、绝不拼 URL——`display_url` / `normalized_url` 都只存规范化结果，服务端校验是唯一安全边界。
- 未设置根仓库或根仓库 `repository` 无法解析为 `owner/repo` 时返回 **422 `EXTERNAL_LINK_SHA_REQUIRES_ROOT_REPOSITORY`**（前端文案「尚未设置项目根仓库，无法把 commit SHA 补全为链接；请先粘贴完整链接或设置项目根仓库。」），不得复用误导性的「链接无效」文案。
- 零数据库面：无迁移、无新表 / 列 / 角色、无新路由（Route Registry 仍 101 条），补全结果仍按既有 `COMMIT` 形状（`external_sha` + `repository`）落库，根仓库自身仍受「必须是仓库根地址」的既有规则保护（裸 SHA 永远不会成为根仓库）。
- 幂等契约版本 `addExternalLink` 由 `2.0.0` 升到 `2.1.0`（同一请求由必然 422 变为可成功写库，按 §6 必须升级），`removeExternalLink` 保持 `2.0.0`；改契约后必须重跑 `pnpm contract:generate` 与 `pnpm contract:drift`。
- 回归防线：`apps/api/test/github-url.test.ts`（形状识别与拼接）、`apps/api/test/external-links.integration.test.ts`（真库端到端补全、缺根仓库 422 与落库形状）、`apps/web/src/features/external-links/ExternalLinksPanel.test.tsx`（预览与 422 文案），改动该口径时必须跑这三处。
## 2026-10-09 完成任务可选沿用任务 GitHub 链接说明

用户指示（原话）：「那就做成如果这个任务有迭代记录或多条，可以让用户自己选择哪些要直接贴上去或者选择自己添加」。在「完成任务并生成迭代记录」流程里提供链接搬运的人工选择，**不**做服务端自动复制（[ADR-022](./docs/adr/ADR-022.md) 的链接归属规则不变）：

- 表单新增「GitHub 链接」区块（`apps/web/src/features/tasks/CompleteWithRecord.tsx`，`aria-label="GitHub 链接"`）：只读列出**任务自身**的链接（`listExternalLinks("TASK", taskId)`）并**默认全部勾选**——`excludedLinks` 只记「取消勾选」的 id，因此清单晚到时新出现的链接同样默认沿用；同一区块内可「自己添加」链接（复用 `previewLabel()` 校验外形，非 GitHub HTTPS 链接与重复项当场拦下）并逐条移除。发布后按 `attachmentUrls()` 合并去重结果逐条调用 `addExternalLink("CHANGE_RECORD", record.id, …)`。
- **当前范围只含任务自身的链接，不含该任务已有迭代记录上的链接**：`RecordListQuery` 没有 taskId 过滤，列出记录维度的链接需要先分页拉全记录再逐条查，代价超出该交互需要的范围。若产品改为需要，先扩契约再实现。
- 逐条关联的并发与幂等：认证 Session 的 CSRF **不是一次性的**（一次签发可多次使用），每条用上一条响应回填的 `rowVersion` 作 `If-Match`，`Idempotency-Key` 逐条新生成；`409 EXTERNAL_LINK_ALREADY_ASSOCIATED` 视为已关联成功而不报错。**改这条链路时必须保持「用响应回填 rowVersion」**，否则第二条起会因版本过期 409。
- 失败语义：记录已发布、部分链接没贴上时**不能重复发布**（提交按钮禁用），改由恢复区块列出未关联链接并提供「重试关联」/「先查看记录」；读取任务链接失败不阻塞完成流程。搜索文本容量触发的 422 `SEARCH_TEXT_CAPACITY_EXCEEDED` 当前并入该失败清单走重试，没有专门文案。
- 样式自建：`.completion-links*` 落在 `apps/web/src/styles/inpulse-design.css`，**不复用** `record-drafts.css` 的 `.record-github-*`（后者随记录页 chunk 加载，完成任务弹窗不保证已加载）；「移除」用全局 `.text-button`。
- 零数据库面与零契约面：无迁移、无新路由（Route Registry 仍 101 条）、无权限矩阵与生成物改动。
- 回归防线：`apps/web/src/features/tasks/CompleteWithRecord.test.tsx`（勾选沿用 / 取消勾选不带走、自己添加的校验与移除、发布后部分失败的重试与禁止重复提交）与 `apps/e2e/tests/task-completion.spec.ts` 的 `F22 任务上的 GitHub 链接可勾选沿用到新发布的迭代记录`（真实浏览器：默认勾选 → 追加新链接 → 发布 → 记录详情「GitHub 关联」两条都在），改动该交互时必须跑这两处。

## 2026-10-09 「记录一次迭代」入口同步可选沿用任务 GitHub 链接

用户指示（原话）：「我指的是实现之前说的任务已有链接可选择添加上去」。把上一条的能力扩到任务详情的「记录一次迭代」（草稿弹窗），并改为两个弹窗共用一份实现：

- 新增 `apps/web/src/features/external-links/TaskLinksPicker.tsx`（任务链接勾选默认全选、只记取消勾选的 id、就地添加与去重校验、待添加列表、`onSelectionChange` / `onPendingChange`），`CompleteWithRecord.tsx` 与 `RecordDraftEditorModal.tsx` 都渲染它；`taskId = 0`（独立草稿）退化为自己添加，编辑已保存记录仍用 `ExternalLinksPanel variant="inline"`。每次打开用 `key` 重置勾选。**不要再复制第三份实现**。
- 两个弹窗的逐条关联协议完全一致（CSRF 可复用、`If-Match` 用上一条响应回填、`Idempotency-Key` 逐条新生成、409 视为已关联、失败时草稿弹窗先 `switchToSaved` 再抛错）。
- 样式：`.completion-links*` 改为挂在 `.catalog-modal` 下（**不得**再加回 `.completion-flow` 容器前缀，否则草稿弹窗里看不到）；草稿弹窗的 `.record-github-add/-error/-pending/-url` 已删除，`record-github-links/-head/-title/-hint` 保留给已保存记录的链接卡片。
- 零数据库面与零契约面：无迁移、无新路由（Route Registry 仍 101 条）、无权限矩阵与生成物改动。
- 回归防线：`apps/web/src/features/tasks/TasksPanel.test.tsx`（草稿弹窗勾选沿用与就地添加后落到 `addExternalLink` 的 URL 清单）与 `apps/e2e/tests/task-completion.spec.ts` 的 `F22 记录一次迭代可勾选沿用任务上已有的 GitHub 链接`（真实浏览器：默认勾选 → 追加新链接 → 发布 → 记录详情「GitHub 关联」两条都在）；`apps/e2e/tests/external-links.spec.ts` 的暂存列表定位器已从 `.record-github-pending li` 改为 `.completion-links-pending li`。
- 本地验证（2026-10-09）：`TasksPanel.test.tsx` 26/26、`apps/web` 全量单测 90 文件 636 例、`--filter @inpulse/web typecheck` exit 0、全量 `pnpm test:e2e` **66 passed（5.4m）**、整链 `corepack pnpm check` **exit 0**；未运行 `pnpm test:integration`、镜像构建与 Trivy、GitHub Actions（2026-10-09 未提交、未推送）。

## 2026-10-09 项目面板聚合展示任务 / 功能 / 记录上的 GitHub 链接

用户提问「为什么我给任务关联的GitHub链接在项目那边不会添加」，确认属 [ADR-022](./docs/adr/ADR-022.md) 类型化关联的设计行为（任务上的链接写在 `task_external_links`，项目面板只读 `project_external_links`）后，用户选择「聚合展示：项目面板列出全部链接并标注来源」。本批是**读侧聚合**，写入模型与解除入口不变：

- `listExternalLinks` 在 `targetType = PROJECT` 时改走 `ExternalLinksRepository.listProjectLibrary()`：一条 `UNION ALL`（项目级 → 任务 → 功能 → 已发布记录）取回聚合行，JS 侧按链接去重并给出 `sources: [{ targetType, targetId, title }]`（标题取 `projects.name` / `tasks.title` / `features.name` / `change_records.title`，`left(..., 500)` 截断）。其他目标不返回 `sources`。
- 草稿与已作废记录**不**聚合（草稿属私域内容、作废在搜索与统计口径上已对成员隐藏）；如需管理员可见 VOID 来源须另行设计，不得直接去掉 `r.status = 'PUBLISHED'` 条件（`EXTERNAL-LINK-AGG-API-002` 会因此转红）。
- 前端 `apps/web/src/features/external-links/ExternalLinksPanel.tsx`：聚合条目显示一行来源标注（单行省略、完整文案走 `title`），`canRemoveExternalLink()` 只对**仍有项目级关联**的条目给「解除」，聚合条目到各自来源入口解除，列表尾部有对应提示。
- 零数据库面与零新路由：无迁移、Route Registry 仍 101 条、权限与幂等策略不变；`sources` 是可选字段，属读路由非破坏性扩展，`addExternalLink` / `removeExternalLink` 的幂等契约版本保持。
- 回归防线：`apps/api/test/external-links.integration.test.ts`（四类来源聚合、同 URL 双来源顺序、跨项目排除、草稿 / 作废排除）与 `apps/web/src/features/external-links/ExternalLinksPanel.test.tsx`（来源标注与解除入口收敛），改动该口径时必须跑这两处。
- 本地验证（2026-10-09）：集成 39/39、Web 单测 9/9、`pnpm typecheck` 8 workspace、`contract:drift` 5 产物、`contract:validate` 101 条、`permissions:check` 101 / 101、`pnpm lint`、`pnpm format:check` 通过；未运行全量 `pnpm test:e2e`（用户当日指示不跑）、全量 `test:integration` / `test:unit` / `test:web`、整链 `pnpm check`、镜像构建与 GitHub Actions（未提交、未推送）。

## 2026-10-09 项目面板聚合只含有效任务上的链接

用户指示（原话）：「取消任务以后项目那边链接要隐藏掉不显示」。在上一节的读侧聚合上收窄任务来源（[ADR-022](./docs/adr/ADR-022.md) 2026-10-09 修订二）：

- 任务分支只聚合**有效任务**——`t.lifecycle_status <> 'INVALID' AND t.work_status <> 'CANCELED'`，与 `apps/api/src/modules/tasks/task-query.port.ts` 的 `effectiveOnly`、`apps/api/src/stats/card-stat-columns.ts` 的 `effectiveTaskWhere` 同一表达式（没有新增独立口径）；`listExternalLinks` 的 summary 同步为「聚合其有效任务、功能与已发布记录上的关联」。
- 这是**读侧展示口径**，不是权限收窄或关联删除：`task_external_links` 关联行保留，任务自身面板（`targetType = TASK`）照常读取，任务从已取消恢复为待办后链接重新出现在项目面板。零数据库面、零新路由（Route Registry 仍 101 条）、零权限与幂等策略变化。
- 回归防线：`apps/api/test/external-links.integration.test.ts` 的「项目面板聚合排除已取消与无效任务上的链接，恢复后重新出现」（真实 PostgreSQL：`INVALID` 不进聚合、`CANCELED` 后消失、任务自身面板仍在、关联行保留、恢复后重新出现）；改动该口径时必须跑该文件。
- 本地验证（2026-10-09）：集成 40/40（文件内 39 → 40）、`contract:generate` / `contract:drift`（5 产物）/ `contract:validate`（101 条）、`permissions:check`（101 / 101）、`pnpm typecheck`（8 workspace）、`pnpm lint`、`pnpm format:check` 通过；鉴别性验证为临时去掉新增两行条件后新用例转红（`expected [ { id: 1259, … }, { id: 1260, … } ] to match object [ … ]`）、恢复后全绿；重建重启后浏览器复验项目 123 面板：commit 链接消失、只剩根仓库 `256-code/LibiaoLink`。未运行全量 `pnpm test:e2e`（用户当日已指示不跑）、全量 `test:unit` / `test:web` / `test:integration`、整链 `pnpm check`、镜像构建与 GitHub Actions（未提交、未推送）。

## 2026-10-09 ADR-058 取消任务改为「二次确认后删除任务」说明

> **2026-10-23 更新**：本节的任务软删除规则已由 [ADR-096](./docs/adr/ADR-096.md) 替代；现行规则为物理删除，见文末「2026-10-23 ADR-096 任务、功能与模块物理删除说明」。

按用户 2026-10-09 指示（原话「现在我需要更改取消任务，取消任务以后要变成先二次确认，确认后彻底删除这个任务，然后那些任务的github链接要取消关联，如果这个任务有迭代记录要作废，可以点击取消任务以后你刷新页面前还能点击恢复任务，但是刷新后就不行，而且就算取消任务，项目动态和审计日志里面也需要有保留取消任务的记录」，经四轮澄清收敛为「不要恢复入口 + 不做完整还原 + 记录自动作废 + 合并中自动解除后删除」）交付任务删除（[ADR-058](./docs/adr/ADR-058.md)）。因此：

- **任务删除是软删除，不是物理删除**（与 [ADR-049](./docs/adr/ADR-049.md) 的项目软删除同范式）：`app.tasks` 被 7 张表以 `ON DELETE RESTRICT` 引用（`change_records`、`task_status_history`、`task_external_links`、`task_group_members`、`task_feature_impacts`、`task_assignees`、`leftover_task_links`），其中状态历史与迭代记录是必须保留的业务历史，且审计链只追加（[ADR-008](./docs/adr/ADR-008.md)）；「刷新前可恢复」按字面与「彻底删除」不可并存，用户已明确放弃恢复入口，因此删除 = `deleted_at` / `deleted_by` 标记 + 退出全部可见与可写范围，业务历史原样保留。物理清除只随所属项目被物理删除（[ADR-062](./docs/adr/ADR-062.md)，2026-10-09 起；原写作「项目的彻底删除（ADR-051）或保留期自动清理（ADR-055）」，两条路径已随 ADR-062 下线）发生。
- **两条新路由**（与既有任务路径同构，模块级任务无功能段）：`POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/tasks/{taskId}/delete`（`deleteTask`）与 `POST /api/v1/projects/{projectId}/modules/{moduleId}/tasks/{taskId}/delete`（`deleteModuleTask`）；`session` + CSRF + 同源 + 数据库级幂等（`idempotencyContractVersion: 1.0.0`）+ `If-Match` 版本门禁，`auditAction: "task.delete"`，`lockOrder: ["project","module","feature","task","taskGroup"]`。Route Registry 由 101 条增至 **103 条**，权限矩阵同步 103/103。请求体 `DeleteTaskRequest { reason: string | null }`（1～10000 字符，空白回落「任务已被删除」），响应 `TaskDeletionResponse` 12 字段。
- **一个事务内完成全部编排**（`apps/api/src/workflows/task-deletion.workflow.ts`，跨域编排必须放 `workflows/`：`PublishedRecordsModule` 已依赖 `TasksManagementModule`，反向依赖成环）：软删除任务（条件 UPDATE + 行锁，未命中 409 `TASK_STATE_CONFLICT`）→ 解除该任务的 GitHub 链接关联（只删 `task_external_links` 关联行，`external_links` 链接本体保留）→ 聚合组处理（`SOURCE` 自动标记 `DETACHED`、最后一个来源关闭聚合组并解除 `MAIN`；`MAIN` 返回 409 `TASK_GROUP_MAIN_LOCKED`）→ 作废该任务的全部迭代记录（`RecordLifecycleService.voidByTaskDeletion`，绕过 `transition` 的系统管理员硬门禁，普通成员删除任务即可作废）→ 审计 `task.delete` → 动态 `updateEntityVisibility(sourceStatus: "DELETED")` + `TASK_DELETED`（`MEMBER` 可见）→ 移除搜索投影。
- **读写收窄**：25 处任务读路径（任务列表、任务中心 R-3、看板、聚合组 R-7、任务详情、成员任务、项目统计与完成率、搜索投影刷新等）统一补 `deleted_at IS NULL`；`work_status` / `lifecycle_status` 取值域不变（删除是第三维，不新增状态位，不污染 [ADR-054](./docs/adr/ADR-054.md) 与 [ADR-037](./docs/adr/ADR-037.md) 的看板口径）。
- **幂等重放的授权口径必须窄且不同**：任务行已软删除，重放**不能**再按任务可读性复核（会让合法重放变成 404）。带 `taskId` 的授权只允许出现在首次执行的 `execute` 中；`IdempotencyHttpService.run` 的 `actorId` 回调在执行与重放两条路径都会运行，把带任务可读性的授权放进去会让重放 404——本 ADR 实施过程中实测到的真实缺陷，回归防线为 TASK-DELETE-API-005。
- **数据库**：迁移 `0034_task_soft_delete.sql`（`deleted_at` / `deleted_by` + `tasks_deleted_by_users_id_fk` + `tasks_deleted_state_check` + 存量一致性校验）与 `0035_search_projection_delete_grant.sql`（`GRANT DELETE ON app.search_projection TO app_runtime`，**真实缺陷修复**：0001 的角色授权只给了该派生表 `SELECT/INSERT/UPDATE`，任何删除任务都会以 `permission denied for table search_projection` 500；只放开这一张派生缓存，业务表仍无 `DELETE`）。`app_runtime` 对 `app.tasks` 仍只有 `SELECT/INSERT/UPDATE`。
- **前端**：任务编辑弹窗页脚的「取消任务」改为「删除任务」（`tone="danger"` 二次确认弹窗，确认弹窗必须在编辑弹窗内部渲染），任务详情动作行的「恢复任务」按钮删除，`TaskStatusPanel` 的 `CANCEL` / `RESTORE` 分支保留为兼容历史深链的不可达代码，设置页权限说明改为「删除任务」；删除成功后失效任务 / 看板 / 聚合组 / 任务中心 / 项目 / 动态 / 通知 / 搜索 / 记录 / 链接缓存并调用 `invalidateShellCounters`。删除后的任务仍可在项目动态与审计日志中看到删除记录（`TASK_DELETED` / `task.delete`），历史标签（`task.cancel` / `task.restore`）保留用于渲染历史数据。
- **非目标**：不提供任务还原与彻底删除入口；不重建已解除的链接关联、不恢复已作废的记录；不改 `CANCEL` 流转本身（历史数据与既有深链仍可用）；不动项目层删除与记录作废 / 恢复的既有口径。
- 本文件上文 [ADR-054](./docs/adr/ADR-054.md) 小节中把「取消任务 / 重新打开」写作现行前端入口的部分，以本节与 ADR-058 为准。

## 2026-10-09 项目列表页：大标题改名 + 生命周期分档滑块 + 维护中排序

用户指示（原话）：「这个界面需要改，首先大标题改为项目列表，第二我希望这个项目也进行分层参考 p2 分类未完成和维护中，维护中状态下排序就按照进入维护的时间，越远越往后排，这个滑块放在和搜索同行左侧」。纯前端展示层改动，无契约 / Route Registry / 权限矩阵 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `/projects` 大标题由「项目与功能」改为「项目列表」：与侧栏导航项、面包屑早已使用的同名文案对齐（`AppLayout.tsx` 的导航项、命令面板、记录草稿里的「项目与功能」未动）。
- 新增生命周期分档滑块 `CalmSegmented`（与任务中心「未完成 / 已完成」同形态、带数量角标），位于搜索框**左侧同一行**：`未完成` = `ACTIVE` + `NOT_STARTED`，`维护中` = `MAINTENANCE`；计数按当前可见项目总量算、不随关键词跳动；默认停在「未完成」。归并规则是新导出 `apps/web/src/features/common/resource-lifecycle.ts` 的 `ProjectTier` / `projectTier()`，**只做展示层归并**，不改服务端三态，也不改 `projectLifecycleRankExpression`（该排序键仍是三档）。
- 维护中一档按「进入维护的时间」从近到远排。项目列表契约**没有**精确的「进入维护时间」字段，当前用 `updatedAt` 近似并在客户端重排（服务端 `list` 的「最近变更时间」含任务动态，在维护中一档会随任务动态漂移）；未完成一档保持服务端顺序（进行中 → 未开始，档内最近变更在前）。要精确化须在契约新增字段（`activity_projection` 已存 `PROJECT_STATUS_CHANGED` + `source_status`，可派生），属契约变更，须同 PR 同步 Schema / OpenAPI / 客户端 / 集成测试。
- 空态分两种：关键词没匹配 → 原有「没有匹配的项目」+「清空搜索」；当前档本身为空 → 「没有未完成的项目」/「没有维护中的项目」。底部「层级说明」六宫格与副标题按原样保留。
- 改动文件：`ProjectsPageView.tsx`、`resource-lifecycle.ts`、`design-system.css`（`.catalog-actions .segmented button` 收到 29px 条目高，滑块整体 35px 与同行控件对齐）、`ProjectsPageView.test.tsx`（新增 3 例 + 改写三态标签 1 例）、`apps/e2e` 的 `tests/auth|csp|project-create|visual-migration.spec.ts` 与 `helpers/project-create.ts`（标题断言改为「项目列表」）。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web test` **91 文件 649 例全绿**、`pnpm typecheck`（8 个 workspace）、`pnpm lint`、`pnpm build`、`prettier --check` 通过；定向 E2E `tests/project-create.spec.ts` 1 passed、`tests/auth.spec.ts tests/csp.spec.ts` 9 passed；全量 `pnpm test:e2e` **68 passed（5.5m）**；真实浏览器复验两档（截图 `.data/annotations/projects-list-tier-open.png` / `-maintenance.png`）。**未运行**：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、`test:integration` / `test:unit`（未改服务端）、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。

## 2026-10-09 侧栏「收起导航」按钮改用面板图标

用户指示（原话）：「这个图标换成 p2 样式呗」（p1 = 原左箭头，p2 = 圆角方块内一条左侧竖线的「面板」图标）。纯图形替换：

- `InpulseIcon` 新增 `panelLeft`（lucide `panel-left` 路径：`<rect width="18" height="18" x="3" y="3" rx="2" />` + `<path d="M9 3v18" />`）；`AppLayout.tsx` 的「收起导航」按钮由 `chevronLeft` 换成它，size 仍 18，`aria-label` / `title` / `aria-controls` / `aria-expanded` 不变。
- 未改：收起后的悬浮「展开导航」按钮（仍是 `menu` 汉堡）、`nav-collapsed` 过渡规则、其它页面里带返回语义的 `chevronLeft`（功能详情返回、模块任务返回、日期输入左右翻页等都不动）。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web typecheck` 与 `prettier --check`（两个改动文件）通过；真实 dev 浏览器复验按钮渲染为「圆角方块 + 左侧竖线」且收起 / 展开动作不变。**未做自动化断言**（纯图形替换，不断言 svg path），也**未跑**全量 `pnpm test:e2e` / `pnpm check` / `test:unit` / `test:integration`、镜像构建与 GitHub Actions（未提交、未推送）。

## 2026-10-09 删除遗留问题页 / 迭代记录页筛选框前的灰色文字标签

用户指示（原话）：遗留问题页「把这个灰色的项目两个字删掉」；迭代记录页「这里的项目和归属也删掉」。与任务中心 2026-09 已定的口径一致（下拉自身已显示「全部项目 / 项目名」，重复的文字标签删掉）：

- `IssuesPageView.tsx`：删掉包住项目筛选的 `<label className="issues-project-field">项目 …</label>` 外壳，`CalmSelect` 直接挂在 `.catalog-actions` 下；`design-system.css` 的 `.issues-project-field` 规则随之删除（仅此一处使用）。
- `RecordsWorkspace.tsx`：删掉「项目」（仅非 embedded 渲染的那个）与「归属」两处 `<label className="records-toolbar-field">` 外壳；`records-timeline.css` 的 `.records-toolbar-field`、`.records-toolbar-field select`（原生 select 已不用）与 `@media (max-width: 700px)` 中的同名规则一并删除。
- **可访问名必须继续由 `CalmSelect` 的 `ariaLabel` 提供**：删标签后 `getByLabelText` / Playwright `getByLabel` 仍按 aria-label 命中（两页的单测与 E2E 都是用这种方式定位的，改动这两个页面时不要依赖可见文字标签）。
- 未改：「生成总结」弹窗里的 `<span className="summary-filter-label">项目</span>`（需与同排「分组」下拉区分）、任务中心与项目动态页、任何筛选语义与 URL 参数。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web test` **91 文件 649 例全绿**、`pnpm --filter @inpulse/web typecheck`、`prettier --check`（4 个文件）通过；定向 E2E `tests/record-feed|issues|activity|aggregate-views.spec.ts` → **7 passed / 1 failed**，唯一失败 `record-feed.spec.ts:73`（「全部项目视图下『我的草稿』标题可见」）**在未改动的 HEAD 上 `git stash` 复跑同样失败**，属既有问题（空草稿箱整块不渲染，见 `RecordDraftsView.test.tsx` 的对应单测），未在本批修。**未跑**全量 `pnpm test:e2e`、整链 `pnpm check`、`test:unit` / `test:integration`、镜像构建与 GitHub Actions（未提交、未推送）。

## 2026-10-09 项目列表页删除「回到任务中心」按钮

用户指示（原话）：「这个回到任务中心按钮删掉」。纯展示层删除：

- `ProjectsPageView.tsx` 删除页头动作区里 `onBackToTasks` 条件渲染的「回到任务中心」按钮，并把 `onBackToTasks` 从 props 接口与解构中移除；`apps/web/src/pages/projects/ProjectsPage.tsx` 同步不再传该回调（`useNavigate` 仍被其它回调使用）。页头动作区只剩生命周期滑块 + 搜索框 + 「新建项目」。
- 不动 404 页自己的「回到任务中心」按钮（`NotFoundPage.tsx`）与侧栏「任务中心」导航项：项目页回任务中心改走侧栏。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web test` **91 文件 649 例全绿**、`pnpm --filter @inpulse/web typecheck`、`pnpm lint`、`prettier --check` 通过；真实 dev 浏览器复验 `/projects` 页头已无该按钮。**未跑** E2E（全仓 grep 确认无用例引用项目页该按钮，404 页的同名按钮与其单测不受影响）、全量 `pnpm test:e2e`、整链 `pnpm check`、`test:unit` / `test:integration`、镜像构建与 GitHub Actions（未提交、未推送）。

## 2026-10-09 草稿箱标题行删除说明文案 + 展开/收起箭头紧贴标题

用户指示（原话）：「p2删掉p3的展开收起标准放到我的草稿箱旁边，离得太远了」；第一版方钮落地后反馈「这个样式有点丑给我几个模拟的别的样式」，从 7 版模拟中定案 **C 版**（箭头紧贴标题、整组「标题 + 箭头」可点、无按钮容器）。纯前端展示与交互改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `RecordDraftsView.tsx`：三档 `hint` 副标题（「来源草稿 / 我的草稿 / 项目草稿」各自的说明小字）整条删除；展开/收起由 26px 白底描边方钮改为「`<InpulseIcon name="chevronDown" className="draft-box-caret" />` + 覆盖整组的透明按钮 `.draft-box-hit`」，放进 `CalmSectionTitle` 的新插槽。
- `Calm.tsx`：`CalmSectionTitle` 新增 `titleSuffix?: React.ReactNode`，非 collapsible 分支的标题改包进 `.calm-section-title-head`（flex、gap 6px）；`hint` prop 保留（其它页面仍在用），`design-system.css` 同步该规则。
- `record-drafts.css`：`.draft-box-toggle` 整套方钮规则删除，换成 `.draft-box-caret` / `.draft-box-hit`（`inset: -2px -4px -2px -6px`）；收起态箭头旋转用 `:has(.draft-box-hit[aria-expanded="false"])`（`.record-drafts-page` 作用域内），悬停整组转 `#2472c3`。
- **标题行上下留档**：`.record-drafts-page .calm-section-title` 从设计系统默认的 `0 0 18px` 改为 `8px 0 20px`（标题距筛选行 10px → 18px、距草稿卡 18px → 20px），命中层上下外扩由 4px 收到 2px，键盘焦点环不再贴到相邻元素（用户当日追加「请调整上下间距」）。
- **焦点环左右留白 + 左边缘对齐**（用户同日追加「这个几个字稍微往右有点感觉没对其」→ 再澄清「纵向这三个该对齐，我的草稿往右移动」）：① 命中层右侧外扩由 6px 收到 4px——箭头 14px 图标盒左右各约有 3px 余量，右边再留 6px 会让环内右留白比左多 2.6px（实测左 9.5px / 右 12.1px），收到 4px 后两侧各约 9.5px；② `.record-drafts-page .calm-section-title-head` 加 `margin-left: 8.7px`（= 命中层左外扩 6px + 焦点环描边 2px + `outline-offset` 0.67px），整组「我的草稿 ⌄」右移后焦点环外沿落在 **270.03px**，与上方搜索框、下方草稿卡片左边缘（270px）纵向对齐。代价：未获得键盘焦点时标题文字比内容列右 8.7px——「环外沿贴齐内容列」与「文字贴齐内容列」不可兼得（环的左内边距必须为正），本轮按用户指示取前者。
- **可访问性与既有选择器不变**：标题仍是 `h3`（`getByRole("heading")` 与 `.calm-section-title h3` 断言继续有效），按钮保留 `aria-expanded`、收起时的 `aria-controls="record-draft-list"` 与 `title`/`aria-label`（「收起草稿箱 / 展开草稿箱」）；来源任务视图（`taskId > 0`）不渲染箭头，行尾仍是「新建来源草稿」。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web test` **91 文件 649 例全绿**、`pnpm lint`、`pnpm typecheck`（8 workspace）、`pnpm build`、`prettier --check .`、`pnpm check:docs` 通过；定向 E2E `tests/record-drafts.spec.ts tests/module-tasks.spec.ts`（`E2E_DATABASE_URL=…/app_ci`）**7 passed (48.7s)**；真实 dev 浏览器复验标题行「我的草稿 ⌄」，点标题与点箭头都能折叠 / 展开（截图 `.data/annotations/draft-toggle-c-open.png`、`draft-toggle-c-closed.png`）。**未运行**：全量 `pnpm test:e2e`、整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、`test:unit` / `test:integration`（未改服务端）、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。

## 2026-10-09 全站时间展示统一按北京时间（Asia/Shanghai）

用户报障（原话）：「这个是我刚刚创建的但是时间对不上」——功能详情页头显示「更新 2026-10-09 06:23」，而该功能创建于北京时间同日 14:23（项目动态页同一事件显示 14:23），即把服务端下发的 UTC ISO 串当北京时间显示；随后用户追加「都统一成北京时间」。前端多处直接切 ISO 字符串或按浏览器本地时区渲染，在非 +8 环境（CI、海外同事）会显示成另一天/另一时刻。本批新增**唯一时间展示口径** `apps/web/src/features/common/beijing-time.ts`（`Intl` 固定 `timeZone: "Asia/Shanghai"`；北京无夏令时，日历日按固定 +8 换算），并把下列渲染点全部改到该模块：

- `features/features/FeaturesPageView.tsx`：`formatStamp` 原为 `value.replace("T"," ").slice(0, 16)`（**报障根因**），改为 `formatBeijingMinute`；功能列表「最近更新」列与详情页头「更新 …」徽章同时修正。
- `tasks/TasksPanel.tsx`：`formatDate` / `formatDay` 加 `timeZone`；`dueLabel` 的「已逾期 N 天 / 今天截止 / N 天后截止」日历日差改由 `beijingTodayStart` 计算。
- `tasks/TaskStatusPanel.tsx`、`notifications/NotificationsPageView.tsx`、`notifications/NotificationBell.tsx`、`projects/ActiveProjectMembers.tsx`、`projects/ProjectMembersPageView.tsx`、`records/PublishedRecordCard.tsx`、`published-records/PublishedRecordDetail.tsx`、`published-records/RecordDetailModal.tsx`：`toLocale*` 补 `timeZone: BEIJING_TIME_ZONE`（形状不变）。`NotificationBell` 的「x 分钟/小时/天前」是按时间差推导，不随时区变化。
- `record-drafts/RecordDraftsView.tsx`（`formatDraftTime`）、`issues/issues-format.ts`（`formatIssueDate`）、`project-overview/ProjectOverviewPageView.tsx`（`formatPublishedAt`）、`task-groups/task-groups-format.ts`（`formatDay` / `formatDateTime`）、`my-tasks/my-tasks-time.ts`（`formatDayIso` / `formatDateTimeIso` 与 `isTodayIso` 等「今天/本周/本月」判断）：改走 `beijing-time`，不再是本地时区。
- **按北京日历日归组**（原先部分按 UTC 日、部分按 +8 日，口径不一致）：`records/record-timeline.ts` 的 `recordDateKey` 原为 `publishedAt.slice(0, 10)`（UTC 日，跨日会归错组），`activity/activity-day-groups.ts` 与 `audit/AuditLogPageView.tsx` 的日键与组头/行内文案统一走 `beijingDayKey` / `formatDayKeyCn` / `formatDayKeySlash`；`records/record-summary-document.ts` 与 `records/RecordSummaryModal.tsx` 的日期、以及 `presetRange` 的「本年/本季度/本月」改由 `beijingTodayParts` 推导。
- **审计筛选按北京时间解析**：`audit/audit-query.ts` 的 `toQueryIsoString` 原用 `new Date(trimmed)`（浏览器本地时区），改为 `beijingWallClockToIso`（严格 `YYYY-MM-DDTHH:mm[:ss]` + 真实日历日校验）；否则在非 +8 环境里用户按界面看到的北京时间填范围会与列表错位。
- **有意保留的例外**：`common/components/CalmDateTimeInput.tsx`、`published-records/ConvertLeftoverTask.tsx`、`tasks/GlobalTaskCreateModal.tsx` 里的 `datetime-local` 仍是浏览器本地墙上时间——它与输入框往返自洽（写回 `new Date(next).toISOString()` 用的是同一套本地语义），本轮不动，避免把「选择器显示」与「选择器取值」拆成两套口径。
- 未改：`task-board/task-board-format.ts`（本来就是 `Asia/Shanghai`，本批以它为准）、`features/features` 的 `toLocaleLowerCase` 搜索、各处只用于排序 / 比较的时间戳运算。
- 本地验证（2026-10-09）：新增 `apps/web/src/features/common/beijing-time.test.ts`（5 例，期望值全部硬编码，避免测试机时区不是 +8 时对本地时区实现假通过）与 `FeaturesPageView.test.tsx` 的更新时间回归用例；`pnpm --filter @inpulse/web test` **92 文件 655 例全绿**（基线 91 文件 649 例），`pnpm --filter @inpulse/web typecheck`、`pnpm exec prettier --check`（本批 26 个文件）通过；真实 dev（Vite 5173）`/projects/3/modules/3843/features/6491` 复验页头显示「更新 2026-10-09 14:23」，与项目动态页同一事件的 14:23 一致。`audit/audit-query.test.tsx` 与 `audit/AuditLogPageView.test.tsx` 里两处「表单 08:00 → `new Date(...).toISOString()`」的期望改为显式 `2026-09-01T00:00:00.000Z`。**未运行**：全量 `pnpm test:e2e`、整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、`test:unit` / `test:integration`（未改服务端）、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。

## 2026-10-09 ADR-059 模块与功能软删除说明

> **2026-10-23 更新**：本节模块与功能的软删除规则已由 [ADR-096](./docs/adr/ADR-096.md) 替代；现行规则为物理删除，见文末「2026-10-23 ADR-096 任务、功能与模块物理删除说明」。

按用户 2026-10-09 指示（原话「现在先本地保存，然后给模块和功能增加删除按钮，如果里面有功能或者任务，要提醒操作者是否删除，如果真的删除那就一起删」，随后限定入口形态「把删除按钮放入模块和功能各自的编辑页面里，像任务那种一样一样」）交付模块与功能删除（[ADR-059](./docs/adr/ADR-059.md)）。因此：

- **删除是软删除，不物理删除**（与 [ADR-049](./docs/adr/ADR-049.md) / [ADR-058](./docs/adr/ADR-058.md) 同范式）：迁移 `0036_module_feature_soft_delete.sql` 给 `app.modules` 与 `app.features` 各加 `deleted_at` / `deleted_by`（`ON DELETE restrict` FK 到 `app.users`）与 `*_deleted_state_check`（两列同空或同非空）；删除 = 打标 + `row_version` 递增 + 退出全部可见与可写范围，**不提供模块 / 功能的还原入口**。物理清除只随所属项目被物理删除（[ADR-062](./docs/adr/ADR-062.md)，2026-10-09 起；原写作「项目的彻底删除（ADR-051）或保留期自动清理（ADR-055）」，两条路径已随 ADR-062 下线）发生。`app_runtime` 的表级 `DELETE` 授权面不变（软删除只需 `UPDATE`）。
- **两条新路由**：`POST /api/v1/projects/{projectId}/modules/{moduleId}/delete`（`deleteModule`）与 `POST /api/v1/projects/{projectId}/modules/{moduleId}/features/{featureId}/delete`（`deleteFeature`）；`session` + 同源 + CSRF + 数据库级幂等（`idempotencyContractVersion: "1.0.0"`）+ `If-Match` 版本门禁，`lockOrder: ["project","module","feature","task","taskGroup"]`，`auditAction` 为 `module.delete` / `feature.delete`。Route Registry 由 103 条增至 **105 条**，权限矩阵同步 105 / 105。请求体 `reason` 可空 1～10000 字符（空白回落「模块已被删除」/「功能已被删除」）。
- **未分类模块一律不可删除**：`deleteModule` 对 `kind = 'UNCLASSIFIED'` 返回 409 `MODULE_UNCLASSIFIED_PROTECTED`，前端同样不渲染删除入口。这是对既有规则的**政策追加**——`0001` 的 `modules_protect_unclassified` 物理删除禁令原样保留，新增的只是软删除禁令；`docs/permissions.md` 已同步并保留 2026-09-09 人工确认的出处。
- **权限是 [ADR-039](./docs/adr/ADR-039.md) 授权下放的第五处例外**：只有系统管理员与本项目 ACTIVE 组长（LEADER）可删；普通成员与项目管理员 403（`MODULE_DELETE_FORBIDDEN` / `FEATURE_DELETE_FORBIDDEN`），非成员、已移除成员与不存在统一 404（`MODULE_NOT_FOUND` / `FEATURE_NOT_FOUND`，不泄露存在性）；版本不符 409（`MODULE_VERSION_CONFLICT` / `FEATURE_VERSION_CONFLICT`）；重放前由 `moduleDeleteReplayAuthorizer` / `featureDeleteReplayAuthorizer` 重新复核当前认证与实时 `scopeDeleterRole`。
- **级联在一个事务内完成**（`apps/api/src/workflows/scope-deletion.workflow.ts`，跨域编排放 `workflows/`）：按 项目 → 模块 → 功能 → 任务 的父到子顺序取锁，级联软删除所含功能与任务——任务**逐条复用** `TaskDeletionWorkflow.deleteWithinTransaction`（[ADR-058](./docs/adr/ADR-058.md) 的解除链接 → 作废记录 → 聚合组处理全链；ADR-058 的单任务路径已重构到同一方法，其集成套件复跑 9/9 证明行为未变），功能与模块自身再补软删除、链接解除、范围内记录作废（`RecordScopeVoidPort.voidScopeRecords`，模块级递归覆盖模块级记录与各功能记录，功能级只作废该功能记录）与投影维护；**聚合组主任务门禁先于任何删除**（`TaskDeletionCommandPort.listActiveMainTaskIds` 命中即 409 `TASK_GROUP_MAIN_LOCKED` 整体回滚）。审计 `module.delete` / `feature.delete`（模块级联为每个被删功能各写一条、以 `cascadeFromModuleId` 区分来源）、动态 `MODULE_DELETED` / `FEATURE_DELETED`（`MEMBER` 可见）与搜索投影移除同事务，**不发通知**。
- **读侧收窄**：21 处读路径统一补 `deleted_at IS NULL`（模块与功能的列表 / 详情 / 名称映射、卡片统计、任务与记录读写、聚合读、外部链接聚合、搜索投影与影响功能子查询）；存活任务与记录的 `impactFeatureIds` 会静默丢弃指向已删除功能的引用（依 ADR-059 有意为之）。
- **确认弹窗的计数口径**：不新增预览接口，直接复用编辑弹窗已有的 `stats`（模块用 `activeFeatureCount` / `openTaskCount` / `completedTaskCount`，功能用 `openTaskCount` / `completedTaskCount`）提示影响面；删除入口放在模块与功能**各自的「编辑」弹窗页脚最左侧**（`footer-leading` + `tint-danger-button`，与任务编辑弹窗同款），确认弹窗必须作为编辑弹窗的**同级兄弟节点**渲染（rc-dialog 会 memo 化嵌套 children，[ADR-058](./docs/adr/ADR-058.md) 的实施教训）。
- 回归防线：`apps/api/test/scope-deletion.integration.test.ts`（10 例，真实 PostgreSQL）、`apps/api/test/scope-deletion-http.service.test.ts`（13 例）、`apps/api/test/scope-deletion.workflow.test.ts`（8 例）、`apps/web/src/features/common/components/CatalogItemDeletionConfirm.test.tsx`、`apps/web/src/features/modules/ModuleEditorModal.test.tsx`、`apps/web/src/features/features/FeaturesPageView.test.tsx`；改动该口径时必须跑这六处。
- 本文件上文 [ADR-044](./docs/adr/ADR-044.md) / [ADR-045](./docs/adr/ADR-045.md) 小节中「模块与功能的生命周期只有 `ACTIVE`、归档路由已删除」的表述仍然成立——删除是第三个独立维度（`deleted_at`），不复活归档态，也不改 `work_status` / 看板与统计口径；与本节冲突的历史描述以本节与 ADR-059 为准，`docs/permissions.md` 中 2026-09-09「未分类模块…不能物理删除」的人工确认仍然有效，本节在其上追加了软删除禁令。

## 2026-10-09 ADR-060 审计读取不写留痕说明

按用户 2026-10-09 指示（「审计日志不需要记录读取留痕，把记录读取留痕去除掉，既然没用读取留痕了那也没必要隐藏」）把审计读取留痕整体下线（[ADR-060](./docs/adr/ADR-060.md)，替代 [ADR-042](./docs/adr/ADR-042.md)）。因此：

- `GET /api/v1/audit-logs` 不再写 `AUDIT_LOG_READ`：`AuditQueryService` 删除 `AuditWritePort` / `PostgresUnitOfWork` 依赖与整段留痕写入，`AuditLogController` 删除客户端 IP / UA 提取辅助，`AuditLogReadModule` 去掉仅为留痕写入而挂载的 `AuditModule` 导入；读取、筛选、重置、重试、分页与切换审计对象都不再产生审计行，「留痕写失败即整体失败」的失败面随之消失。
- 契约删除 `readTrail` 参数并保持 `.strict()`，继续携带旧参数的请求返回 422 `VALIDATION_FAILED`（旧客户端不会静默降级）；Route Registry 的 `getAuditLogs.auditAction` 改为 `none`，summary 注明「读取不写审计（ADR-060）」。路由总数不变（105 条），无迁移、无新表 / 列 / 角色。
- 前端删除「隐藏读取留痕」机制（`AuditLogPageView` 的 `hideReadTrail` state 与勾选框、「本页已隐藏 N 条读取留痕」提示、空态「本页记录均为读取留痕」与「显示读取留痕」按钮、`inpulse-design.css` 的 `.audit-trail-bar` 规则），页头说明与两处快照页脚去掉「读取已留痕」措辞；历史 `AUDIT_LOG_READ` 行保留在数据库中并按普通行渲染，`audit-labels.ts` 的标签与筛选下拉项保留用于渲染历史行。
- 读取取证改由部署层访问日志与远端 WORM 归档（F-08 步骤 6，**仍未交付**）承担；在归档交付前，读取行为不再有应用层审计记录。E2E 的确定性锚点由 SYSTEM 链留痕改用测试自建项目的 `PROJECT:<id>` 链（`project.create`）。
- 本文件上文把「读取留痕」写作现行规则的历史条目，以本节与 ADR-060 为准。

## 2026-10-09 ADR-061 原始审计读取「全部记录（所有链）」与死码候选清理说明

按用户 2026-10-09 指示（原话「将不会产生的去除掉，然后动态审计加一个有全部记录的，以后默认就是这个」，经二选一澄清确定为跨链读取）交付审计读取范围扩展与动作码候选清理（[ADR-061](./docs/adr/ADR-061.md)，扩展 [ADR-060](./docs/adr/ADR-060.md) 的读取范围）。因此：

- **读取范围三选一**：不传 `projectId` 与 `chain` 读 `SYSTEM` 链（缺省语义不变，服务端默认仍是 SYSTEM 链）；`projectId=<id>` 读 `PROJECT:<id>` 链；新增 `chain=all` 读**全部链**并按 `occurred_at DESC, chain_id DESC, sequence_no DESC` 键集分页。`chain` 与 `projectId` **互斥**（同传 422 `invalid-chain`），`chain` 只接受 `"all"`（其余取值 Schema 层 422）。**前端初始状态改为 `chain=all`**（页面默认「全部记录（所有链）」），服务端缺省不变。
- **跨链分页与签名游标**：各链 `sequence_no` 互相独立，不能单序号跨链定位，因此跨链谓词是三段式（`occurred_at < $t OR (occurred_at = $t AND chain_id < $c) OR (occurred_at = $t AND chain_id = $c AND sequence_no < $seq)`）；`AuditCursorPayload` 新增可选 `c`（`chain_id`）与 `t`（`occurred_at` UTC ISO，正则校验），二者**必须成对**；`decode` 返回 `AuditCursorPosition | null`（无游标返回 `null`）；签名域仍 `inpulse.audit-cursor.v1:`，把单链游标拿到 `chain=all` 下翻页返回 422 `invalid-cursor`。
- **迁移 `0037_audit_logs_cross_chain_idx.sql`**：`CREATE INDEX audit_logs_occurred_at_chain_seq_idx ON app.audit_logs (occurred_at DESC, chain_id DESC, sequence_no DESC);`，只加索引、不改结构与历史迁移；`EXPLAIN (ANALYZE, BUFFERS)` 证明跨链首页走 `Index Only Scan`（无 Sort 节点），单链仍走主键。
- **权限面不变**：`getAuditLogs` 仍 `adminSession`，CSRF / 幂等 / 版本 / 并发全 `none`；跨链读取等价于管理员一次读他本就有权读的全部链，**不新增授权**；路由总数不变（105 条），无新增 / 删除路由。
- **动作码候选过滤（不删标签）**：`apps/web/src/features/audit/audit-labels.ts` 新增 `RETIRED_ACTION_CODES`（11 个死码：`project.archive` / `project.archive.request` / `project.archive.reject` / `module.archive` / `module.restore` / `feature.archive` / `feature.restore` / `task.archive` / `task.unarchive` / `AUDIT_LOG_READ` / `SYSTEM_TEST`），`AUDIT_ACTION_OPTIONS` 由其过滤 `ACTION_LABELS` 后按中文排序；`ACTION_LABELS`（53 条）与 `ACTION_PREFIX_LABELS`（`AUDIT_SEED_*`）**必须保留**（历史行与快照渲染依赖）。`project.restore` 当时**不是**死码（[ADR-051](./docs/adr/ADR-051.md) 项目还原当时仍活）——**2026-10-09 起已连同 `project.purge` 进入 `RETIRED_ACTION_CODES`**（共 **13 个**死码，[ADR-062](./docs/adr/ADR-062.md)）；本文件上文 ADR-060 小节中「筛选下拉项保留用于渲染历史行」的表述，以本节为准（候选已过滤、渲染仍保留）。
- **测试与验证（2026-10-09 本地）**：API 真库集成 `apps/api/test/audit-logs.integration.test.ts` **10/10**（跨链并列时间排序稳定且分页不重不漏、互斥与游标不跨模式复用、缺省与 `projectId` 语义不变；首跑因新夹具撑大既有断言而失败一例，改为显式 `action` 过滤而非放宽断言）；Web 审计单测 **2 文件 21 例**（默认跨链、切回单链、死码过滤与历史行渲染）；迁移在 `app_ci` 与 `app` 均 `Applied 0037`；定向 E2E `tests/audit.spec.ts` **2 passed（11.5s）**（**改服务端后必须先 `pnpm build`**，E2E 的 API 跑 `node dist/main.js`——首跑即因陈旧 `dist` 失败）；契约 5 产物已重生成。**未运行**：整链 `pnpm check`（本机 npm 镜像缺 audit endpoint）、全量 `test:e2e` / `test:unit` / `test:web` / `test:integration`、镜像构建与 Trivy、GitHub Actions（未提交未推送）。
- 本批含契约、服务端、迁移与前端产品代码，按 §8 需非作者人工评审；迁移 `0037` 为评审重点。

## 2026-10-09 ADR-062 项目改为物理删除说明

按用户 2026-10-09 指示（「现在项目是软删除，我想把他改成硬删除，把一切与之相关的都要更改，你先分析然后找我确认」）把项目删除从软删除改为**物理删除**（[ADR-062](./docs/adr/ADR-062.md)），并确认六项口径：「D1② D2① D3② D4提醒操作员，如果还是要删就也一起删除干净 D5管理员看的是「删除项目」 D6按表中来 然后还有之前那个软删除30天彻底删除也用不到了」。因此：

- **[ADR-049](./docs/adr/ADR-049.md) / [ADR-050](./docs/adr/ADR-050.md) / [ADR-051](./docs/adr/ADR-051.md) / [ADR-052](./docs/adr/ADR-052.md) / [ADR-055](./docs/adr/ADR-055.md) 整体被取代**：软删除列、删除记录台账、还原、独立彻底删除命令与保留期自动清理全部下线；`listProjectDeletions` / `restoreProject` / `purgeProject` 三条路由删除，Route Registry 105 → **102 条**，权限矩阵 `102 / 102`。
- **`DELETE /api/v1/projects/{projectId}` 直接物理删除**：同一事务内调用 `app.purge_project(INTEGER)`（迁移 `0038_project_delete_contract_soft_delete_removal.sql` 重建，`SECURITY DEFINER`、存在性守卫由 `deleted_at IS NULL` 改为「行必须存在」且必须恰好删中 1 行）级联清空 25 张项目域表与项目自己的 `audit_logs` / `audit_chain_heads`；同一迁移删除 `deleted_at` / `deleted_by` 与 `projects_deleted_state_check`、`projects_deleted_by_users_id_fk`。文件名的 `_contract_` 段是 `database/src/migrations.ts` 对破坏性 DDL 的显式放行标记，**必须保留**。
- **留痕只有一条 SYSTEM 链记录**：`project.delete`（`projectId: null`，payload 含 `code` / `name` / `status` / `rowVersion` / `actorRole` 与七项计数），**仅系统管理员**在 `/audit`「全部记录（所有链）」可见（前端中文标签保留为「删除项目」）；**不写**项目动态、通知与搜索投影。
- **权限与编码**：系统管理员或本项目 ACTIVE 组长可删（`ProjectRoleGateService.projectDeleterRole`；项目管理员与普通成员一样归入 `MEMBER` 返回 403 `PROJECT_DELETE_FORBIDDEN`），非成员 / 已移除成员 / 不存在统一 404 `PROJECT_NOT_FOUND`；项目行删除后 `projects_code_unique` 释放，编码可被后续项目复用（D3②）。迁移 `0038` 先把历史上被软删除的存量行恢复为活跃行（`deleted_at = NULL` + `row_version + 1`）再收窄约束，不物理删除任何存量业务数据。
- **幂等重放只复核认证**：项目行已消失，`replayAuthorizationPolicy` 为 `{ version: "2.0.0", actorOnly: true }`，**禁止**在 `actorId` 回调里加资源可读性检查（会让合法重放变 404，[ADR-058](./docs/adr/ADR-058.md) 同类教训）；HTTP 层仍复核 `auth_version` / `row_version`，认证失效后重放 401。
- **前端**：删除入口仍在「编辑项目」弹窗页脚最左侧，二次确认升级为**级联后果警告**（逐项列出将删除的模块 / 功能 / 任务 / 迭代记录 / GitHub 链接 / 通知 / 项目动态 / 项目审计链，并说明编码可复用与 SYSTEM 链留痕）；`ProjectDeletionActions.tsx`、`project-deletion-query.ts`、活动页「已删除项目」筛选与 `ActivityWorkspace.deletions.test.tsx` 已删除。
- **任务 / 模块 / 功能软删除不受影响（历史口径，2026-10-23 起由 ADR-096 改为物理删除）**：`app.tasks`（[ADR-058](./docs/adr/ADR-058.md)）与 `app.modules` / `app.features`（[ADR-059](./docs/adr/ADR-059.md)）的 `deleted_at` 保留，其物理清除路径改由本节承接；`RETIRED_ACTION_CODES` 增至 **13 个**（新增 `project.restore` / `project.purge`），历史行仍按中文渲染。
- **验证（2026-10-09 本地）**：契约 `generate` / `drift` / `validate`（102 条）与 `permissions:check`（102 / 102）；`project-delete-api.integration.test.ts` **6/6**（级联清空与唯一留痕、权限矩阵与失败零副作用、幂等重放与摘要绑定、重放只复核认证、版本与参数校验分支、编码复用）；API 真库集成 **54 文件 528 例**、API 单测 **72 文件 430 例**、Web 定向单测 **22 文件 158 例**、`pnpm build` 8 个 workspace；定向 E2E `tests/project-delete.spec.ts` **2/2**，全量 E2E **69 / 70**（唯一失败为既有波动用例 `external-links.spec.ts`，单跑 3/3）；迁移 `0038` 在 `app_ci` 与 `app` 均 Applied。**未运行**：整链 `pnpm check`（本机 npm 镜像缺 audit endpoint）、全量 `test:web`、镜像构建与 Trivy、GitHub Actions（未提交未推送）。
- 本文件上文 ADR-049 / ADR-050 / ADR-051 / ADR-052 / ADR-055 小节，以及 [ADR-058](./docs/adr/ADR-058.md)、[ADR-059](./docs/adr/ADR-059.md) 中「物理清除只随 ADR-051 / ADR-055 发生」的表述，与本节冲突时以 ADR-062 与本节的现行规则为准。
## 2026-10-09 项目列表生命周期分档与侧栏项目树联动

用户指示（原话）：「这边项目导航栏要改一下，点进项目列表后默认显示未完成的项目，左侧导航栏也只显示未进入维护中状态的项目，切换到维护中状态后左侧导航栏显示维护中的项目」（附侧栏截图：「项目」分组下列「验证 K123」「项目1 K1235」）。当天上一批刚给项目列表页加了「未完成 / 维护中」滑块，但档位只存在页面 `useState` 里，侧栏项目树始终罗列全部项目；从维护中档点进维护中项目后侧栏会立刻退回未完成档，正在看的项目反而从树上消失。纯前端展示与导航改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- 新增 `apps/web/src/features/common/project-tier-context.tsx`（`ProjectTierProvider` + `useProjectTier`，默认档 `"open"` 未完成）；`apps/web/src/app/router/AppRouter.tsx` 的根路由元素改为 `<ProjectTierProvider><AppLayout /></ProjectTierProvider>`（根路由元素不随子路由切换重挂，档位因此跨页面存活）。
- `apps/web/src/features/projects/ProjectsPageView.tsx`：删掉页面内的 `useState<ProjectTier>("open")`，改读共享档位（`const { tier, selectTier } = useProjectTier()`，滑块 `onChange={selectTier}`）；滑块位置、两档计数、默认档、维护中档按 `updatedAt` 的客户端重排均不变。
- `apps/web/src/features/project-tree/ProjectTree.tsx`：项目行按 `projectTier(item.status) === tier || item.id === activeProjectId` 过滤——未完成档只列进行中 / 未开始，维护中档只列维护中项目；**当前所在项目始终保留**（分档是浏览过滤器，不该把正在看的项目从树上摘掉）。空态文案按档位区分：库里没有项目仍是「暂无项目」，这一档没有项目显示「暂无未完成的项目」/「暂无维护中的项目」。
- `apps/web/src/app/layout/AppLayout.tsx`：读同一档位，侧栏「项目」分组标题在维护中档显示「维护中项目」（项目上下文内仍是「当前项目」）。
- **降级**：没有 Provider 时 `useProjectTier` 回落到组件内 `useState("open")`，`AppLayout.test.tsx` 直接挂载 `AppLayout`、侧栏或列表页单独渲染时行为与改动前一致。
- **未改动**：项目卡与卡片页脚、列表搜索、排序口径、服务端 `apps/api/src/stats/card-stat-columns.ts` 的三档排序键、其它页面的项目选择器（仍是全量项目）、项目树只在 `/projects` 与项目路由内渲染这一既有行为。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web test` **93 文件 660 例全绿**（基线 91 文件 649 例），新增 `apps/web/src/features/projects/project-tier-sync.test.tsx`（列表页滑块 ↔ 侧栏项目树同步）与 `ProjectTree.test.tsx`《ProjectTree 分档过滤》4 例；`typecheck`、`eslint`、`prettier`、`check:boundaries`（316 模块 / 1578 依赖无违规）通过。**未运行**：全量 `pnpm test:e2e`、整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、`test:unit` / `test:integration`（未改服务端）、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。

## 2026-10-09 侧栏项目树改为严格手风琴（只展开当前项目）

用户指示（原话）：「侧边栏还是默认收起，进入项目后默认打开，点开另一个项目后默收起前一个，侧边项目展开至多一个」。纯前端导航行为改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `apps/web/src/features/project-tree/ProjectTree.tsx`：展开态改为**由路由推导**——`expandedKeys` 只放行 `projectOwnerOf(key) === activeProjectId` 的键，`activeProjectId` 为 `null`（项目列表页）时整棵树收起；为便于 `expandedKeys` 引用，`activeProjectId` 的声明提前到 `chainKeys` 之前。
- 进入 / 离开 / 切换项目的副作用：只保留当前项目的展开键（其它项目的残留键删除），并把 `collapsed` 清空——重新进入某个项目总是「默认打开」，而不是继承上一次在树上把它收起的状态。
- 行为结果：项目列表页整棵树收起（不再保留刚离开项目的展开态）；点进项目后当前项目默认铺开（停在 `/projects/:id/modules` 时链路还会展开「模块与功能」）；点开另一个项目时前一个立即收起，任何时刻至多一个项目铺开。
- **未改动**：`chainKeys` 的链路语义（当前项目 + 模块与功能 + 模块）、`extraExpanded` / `collapsed` 对子级（子页行、模块行）的开合与保留、`useRetainedMount` 的收起延迟卸载与 CSS 过渡、项目行「点自己开合且始终导航」的行为。
- 测试同步（展开态改由路由推导后，旧用例「点击项目行但不导航也展开」的前置不再成立）：`ProjectTree.test.tsx` 新增 `RoutedTree` / `mountRouted` 壳让 `activeScope` 跟随路径变化（与真实路由一致），用例 1–5 改挂该壳并去掉冗余的「模块与功能」点击；新增《collapses every project branch back on the project list page》；`ProjectTree.accordion.test.tsx` 补「列表页进来整棵树收起」断言。
- 本地验证（2026-10-09）：`pnpm --filter @inpulse/web test` **93 文件 661 例全绿**；`typecheck`（8 workspace）、`lint`、`build`、`prettier --check .`、`check:boundaries` 通过；真实 dev（Vite 5173）实测三态——`/projects` 侧栏「验证 K123」收起 → 点进项目「当前项目 · 验证」铺开（任务看板 / 模块与功能 / 校验）→ 回 `/projects` 再次收起；维护中档（项目1）表现一致。**未运行**：全量 `pnpm test:e2e`、整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、服务端 `test:unit` / `test:integration`（未改服务端）、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。

## 2026-10-09 项目列表未完成档内统一按最近变更时间排序（ADR-063）

用户指示（原话）：「我希望在项目未完成状态下，每次当项目中有更新，则将项目排序排到最前面」。原排序第一键是「生命周期档位（进行中 → 未开始 → 维护中）」，于是「未开始」项目永远排在「进行中」项目之后——未开始项目无论怎么更新都挤不到前面。本批把第一键收窄为两档（未完成 = 进行中 + 未开始；维护中），未完成档内统一按最近变更时间从近到远。改 SQL 排序与注释、契约描述与生成物、集成测试断言，无契约结构 / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动（[ADR-063](./docs/adr/ADR-063.md)）：

- 服务端：`apps/api/src/stats/card-stat-columns.ts` 的 `projectLifecycleRankExpression` 更名为 `projectTierRankExpression`，CASE 由 `ACTIVE → 0 / NOT_STARTED → 1 / MAINTENANCE → 2 / ELSE 3` 改为 `ACTIVE → 0 / NOT_STARTED → 0 / MAINTENANCE → 1 / ELSE 2`；`apps/api/src/modules/projects/postgres-project-query-port.ts` 的 import 与 `ORDER BY` 同步更名（其余排序键「最近变更时间 → 创建时间 → ID」不变）。这是 [ADR-046](./docs/adr/ADR-046.md) 决策 1 项目行的修订：**只动项目列表**，模块与功能两层仍是「进行中 → 未开始 → 创建时间从近到远」。
- 未完成档内「一有更新就排最前」：`ACTIVE` 与 `NOT_STARTED` 在同一档内竞争第二键「最近变更时间」（该项目动态里最新一条业务事件的发生时间，`projectLastChangeExpression`），没有动态的项目回落 `created_at`。`MAINTENANCE` 仍整档垫底。
- 标签不变：项目仍是 `ACTIVE` / `NOT_STARTED` / `MAINTENANCE` 三态，前端 `resource-lifecycle.ts` 的 `projectLifecycleLabel` 仍按三态渲染；只有排序档位与展示层归并的 `projectTier` 收窄为两档（`apps/web/src/features/common/resource-lifecycle.ts`、`apps/web/src/features/projects/ProjectsPageView.tsx` 仅改注释）。
- 契约与生成物：`packages/api-contract/src/route-registry.ts` 的 `listProjects` summary 同步；`pnpm contract:generate` 重生成 5 产物，仅 `openapi.json` 变更 1 行，`contract:drift` 通过，`contract:validate` 105 条通过。
- 不新增索引与迁移（沿用 ADR-046 决策 3 的结论）：第一键仍是相关子查询算出的 `CASE`，索引无法满足；`MAX(occurred_at)` 走既有 `activity_projection_project_cursor_idx`。
- 回归防线：`apps/api/test/projects-read-api.integration.test.ts` 两个列表顺序用例（真实 HTTP + 真实 PostgreSQL）；改动该口径时必须跑 `pnpm --filter @inpulse/api test:integration`。本地实测 56 文件 545 例全绿；真实 dev 实测未完成档内 `OPS_DASH`（未开始）排在 `AGV_SCHED`（进行中）之前，向 `K123`（进行中）写入一个任务后它从第 3 位跃到第 1 位。
- 本地验证（2026-10-09）：`pnpm typecheck`（8 workspace）、`pnpm lint`、`pnpm format:check` 通过。**未运行**：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、`pnpm test:web`、全量 `pnpm test:e2e`、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。

## 2026-10-10 新项目搭建引导（模块 → 功能 → 任务）

用户指示（原话）：先问「现在这个项目管理系统重建项目模块功能任务还是有点繁琐，怎么改进，先说明不要改代码」，看过第一档方案后指示「先做第一档的引导」。纯前端（`apps/web`）引导 + E2E 断言 / 注释同步，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- 新增 `apps/web/src/features/project-overview/ProjectSetupGuide.tsx`（三步清单 + `isProjectSetupComplete`）：建立模块 / 添加功能 / 创建任务三步各带直达动作，当前步主按钮（`primary-button`）、已完成步显示计数、无模块时后两步显示「先完成第 1 步」，三步齐备整块隐藏；引导不新增 API 请求，计数复用模块列表既有 stats（`activeFeatureCount` 求和、`openTaskCount + completedTaskCount` 求和）。
- `apps/web/src/features/modules/ModulesPageView.tsx`：列表读取成功且未齐备时把引导传给 `ProjectOverviewPageView`（指标条下方渲染）；空项目不再叠加「暂无模块」空态；「添加功能」带 `state: { createFeature: true }` 跳到第一个模块的功能页（模块列表按创建时间从近到远，首个即最近创建）。「添加模块」到达信号（`state.createModule`，由 `apps/web/src/pages/projects/ProjectsPage.tsx` 下发）用 `useRef` 只消费一次并 `navigate(..., { replace: true, state: null })` 清除，刷新 / 后退不重复弹出。
- `apps/web/src/features/features/FeaturesPageView.tsx` 消费 `state.createFeature` 落地自动打开「新增功能」弹窗；`apps/web/src/features/project-overview/ProjectOverviewPageView.tsx` 新增可选 `setupGuide`，任务步复用既有 `GlobalTaskCreateModal`；`apps/web/src/features/projects/ProjectsPageView.tsx` 创建成功横幅「管理模块」改「添加模块」（`data-testid="add-module-after-create"`），缺 `onAddModule` 时退化为 `onOpenModules`；`apps/web/src/styles/design-system.css` 新增 `.project-setup-guide` 系列样式（含 700px 媒体查询）。
- 测试：`apps/web` 新增 16 例（`ProjectSetupGuide.test.tsx` 5 例；`ProjectOverviewPageView.test.tsx` +2；`ModulesPageView.test.tsx` +4，既有重试用例改为断言引导；`FeaturesPageView.test.tsx` +2；`ProjectsPageView.test.tsx` +2；`ProjectsPage.test.tsx` +1）→ `pnpm --filter @inpulse/web test` **97 文件 695 例全绿**（基线 96 文件 679 例）；`apps/e2e/tests/tasks.spec.ts` 空项目断言改为 `project-setup-guide` 可见，`apps/e2e/tests/record-feed.spec.ts` 注释同步。
- 本地验证（2026-10-10）：`pnpm typecheck`（7 个 workspace）、`pnpm build`、`pnpm lint`、`pnpm format:check`、`pnpm --filter @inpulse/web check:boundaries`（321 模块 / 1608 依赖无违规）、`pnpm --filter @inpulse/e2e typecheck` 通过；`E2E_DATABASE_URL` 指向 `app_ci` 的全量 `pnpm test:e2e` **70 例全绿（7.0 分钟）**。**未运行**：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、`test:unit` / `test:integration`（未改服务端）、镜像构建与 Trivy、GitHub Actions（未提交、未推送）。
- 已知既有问题（与本批无关、未修）：`apps/e2e/tests/record-feed.spec.ts` 约第 73 行的「我的草稿」标题断言依赖 `record-drafts.spec.ts` 先跑并留下未发布草稿，单独运行该文件会失败；全量顺序（CI 形态）通过。

## 2026-10-10 生产反向代理信任链与网关注入修复（用户指示，本地落库）

用户在方案 B（客户端请求元数据采集）后追问「以后是要部署到服务器的，那现在能修复吗」，对修复给出合意。修复两个只在生产拓扑下出现的缺口，改动三文件（`deploy/compose.yaml`、`deploy/docker/nginx.conf`、`scripts/check_deploy_refs.mjs`），无契约 / 路由 / 权限 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- **审计 IP 与登录/SSO IP 限流失真**：`TRUSTED_PROXY_CIDRS` 未配置时默认只信 loopback，而 api 经 internal `backend` 网络被 web(Nginx) 访问 → Express 5 `trust proxy` 不采信 `X-Forwarded-For`，`request.ip` 记成网关容器地址，`resolveClientIp` 的 IP 维度限流在生产塌成全部用户共享一个桶。修复：`backend` 网络固定静态子网 `172.30.0.0/24`（Docker 动态分配无法稳定配置信任链），api 服务新增 `TRUSTED_PROXY_CIDRS: "172.30.0.0/24"`；`trusted-proxy.ts` 只接受 `loopback` 字面量 / IP / CIDR，容器名或通配会被拒并使 API 启动失败。
- **`client_request_id` 恒空**：`deploy/docker/nginx.conf` 顶层新增 `map $http_x_request_id $inpulse_audit_request_id`（合法客户端值透传，否则 `default $request_id`），`location /api/v1/` 新增 `proxy_set_header X-Request-Id $inpulse_audit_request_id;`；map 正则与 `apps/api/src/audit/request-audit-context.ts` 的 `CLIENT_REQUEST_ID_PATTERN` 逐字一致。
- **静态门禁**：`scripts/check_deploy_refs.mjs` 新增 8 条断言（backend 子网恰好一个非空、`TRUSTED_PROXY_CIDRS` 非空且不含 `loopback` / `0.0.0.0/0` / `::/0`、必须包含 backend 子网、nginx.conf 必须含 map 与注入行、正则与 API 源码逐字一致）。改动 `backend` 子网或 `TRUSTED_PROXY_CIDRS` 时必须重跑 `pnpm check:deploy:test`。
- 验证（2026-10-10 本地）：`pnpm check:deploy:test` exit 0；两条鉴别性验证各转红一次（改 `172.31.0.0/24` 且删注入行 → `TRUSTED_PROXY_CIDRS must include the backend subnet`；仅删注入行 → `/api/v1 proxy must set X-Request-Id`）后恢复；真实 Nginx 容器探针四项断言全过（无头回退 32 hex、合法值原样透传、含空格非法值回退、65 字符非法值回退），探针已清理；Express trust proxy 三组对照实验实证缺陷与修复。
- **H5 标注**：① 未在真实生产栈实测，证据止于配置级静态校验 + 对照实验 + 容器探针（上游为回显容器，非真实 API）；② 若将来在最外层再加一层 LB / CDN，其地址段必须追加进 `TRUSTED_PROXY_CIDRS`，否则 IP 采集与 IP 限流又会退化；③ 本批只覆盖 Nginx 直连 API 的现有拓扑，dev / E2E 走 loopback 覆盖不到该路径（CI 盲区）。按 §8 需非作者人工评审；未提交、未推送。

## 2026-10-10 遗留问题来源迭代入口、加号追加与记录详情版式

用户指示（原话）：「这个界面的排版布局要不这样，p2 放到最上面去，p3 放到和修订内容按钮一行，修订内容按钮改到最右侧，注意是查看迭代弹窗一起更改，不是仅仅从遗留问题进入的弹窗更改」「这个按钮我要更改，首先功能改成跳转来源迭代，字直接写来源迭代，跳转的时候链接这个来源迭代的弹窗」「这个追加遗留问题可不可以简洁一点放在遗留问题这行右侧」「不是我想简化追加遗留问题，就改为一个加号按钮即可」「这个加号按钮加一点底色吧」「这个字能不能上下居中，下面这根线往上一点」「这个背景怎么这样」。纯前端（React/CSS）、E2E 断言与文档改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- 来源行：`apps/web/src/features/issues/IssuesPageView.tsx` 行首接 `ProjectLogo className=tiny`，项目名提到行首加粗单独成段；`issues-format.ts` 的 `issueOriginText` 改为 `issueOriginParts(item)` 返回 `{ projectName, detail }`（项目名与记录之间用「 · 」，模块 / 功能仍用 ` / ` 表示父子层级）。`projectId → code` 复用页面已有的 `useProjects` 数据；契约上 `LeftoverListItem` 不带项目编码，项目不在可见列表时降级为只渲染项目名。新增 `.project-logo.tiny`（inline-grid、18px）与 `.issue-origin .origin-project` 配色（`design-system.css`）。
- 删除未闭环分档标题：移走 `CalmSectionTitle`，`openItems.length` 条数与「按发布时间倒序」不再渲染；已闭环那档标题是折叠区开关，保留。
- 「来源迭代」入口：`IssuesPageView.tsx` 删除原「来源任务 <编号>」跳转，改为固定文案「来源迭代」（图标 `fileText`）；点击后按 `recordId` 二次调用 `getChangeRecord`（列表项契约不含记录状态，弹窗作废回退依赖状态），读取完成且 `id` 对得上之前不渲染弹层，避免先闪上一条记录的旧数据；就地把 `recordDetailTarget` 交给 `RecordDetailModal`。`RecordDetailModal.tsx` 把原先 `LeftoverTaskSource` 里的局部 `targetOf` 提为导出函数 `recordDetailTarget(record)`，`LeftoverTaskSource.tsx` 改用之。
- 「追加遗留问题」收成图标加号按钮：`AppendLeftoverForm.tsx` 收起态复用全站 `.icon-button`（16px `plus`，文案进 `aria-label` / `title`）；`PublishedRecordDetail.tsx` 把它放到「遗留问题」`<h4>` 同一行的 `.leftover-section-head`（flex + wrap，标题 `flex:1`），展开面板 `flex: 1 0 100%` 整行换行；`design-system.css` 删除 `.leftover-append` / `.leftover-append-trigger` 规则，加浅蓝底（常态 `#e6f2ff` / `#cfe4fa` / `#2472c3`，悬停 `#d7e9fd` / `#b7d2ef` / `#1d5fa8`，禁用 `#f4f7fa`），只覆盖这一处。
- 记录详情版式：`PublishedRecordDetail.tsx` 把事实区 `dl.record-facts`（归属 / 影响功能 / 作者与时间）上移到标题下第一位；「查看来源任务」并入底部 `.record-actions`，与「修订内容」「作废 / 恢复」同一行（来源贴左 `margin-right: auto`、动作贴右 `justify-content: flex-end`）；动作行渲染条件放宽为「有来源任务 或（非只读且（已发布或管理员））」，只读语境保留来源任务这条只读导航。
- 连带修掉两处样式冲突：`inpulse-design.css` 与 `record-summary.css` 的 `.record-expanded > :first-child` 收窄为 `> section:first-child`，并新增 `.record-expanded > .record-facts:first-child { margin-top: 0 }`——否则事实区作为第一个子元素会被清掉上内边距、浅蓝底顶死在文字上沿；折叠态「GitHub 关联」标题行按 `githubOpen` 拼 `collapsed` 类，`.record-github-toggle.collapsed { margin-bottom: 0 }` 让其上下居中、下分隔线上移。
- 卡片底部留白：`design-system.css` 的 `.calm-task-card .task-card-footer { min-height: 31.5px }` 改为 `.calm-task-card .task-card-footer:empty { display: none }`，空页脚不再占高、未完成档卡片矮约 32px（同行等高交给网格 `align-items: stretch`）；`TaskCenterPageView.tsx` 组卡空占位盒保留但同样不占高，仅注释同步。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **96 文件 679 例全绿**；`pnpm --filter @inpulse/web exec vitest run src/features/published-records` 4 文件 20 例；`tsc --noEmit`、改动的 `eslint`、`prettier --check`（TSX + CSS + docs）、`check:docs`（110 个 Markdown）通过；真实 PostgreSQL 浏览器 E2E（`app_ci`）`record-publishing.spec.ts` + `issues.spec.ts` **4 passed (43.3s)**，夹具清理删除用户 2、项目 2、业务行 183、审计行 21；dev（Vite 5173）实测加号按钮 `rgb(230, 242, 255) / rgb(207, 228, 250) / rgb(36, 114, 195)`、30×30，弹窗内 `.record-facts` `padding: 16px 18px`，折叠态「GitHub 关联」`margin-bottom: 0`。“未运行”：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、全 workspace `typecheck` / `build`、`test:unit` / `test:integration`（未改服务端）、其余 Playwright 用例、`contract:*`（未动契约）、镜像构建与 Trivy、GitHub Actions（提交推送后由 CI 执行，不在本文预判结果）。
## 2026-10-10 记录详情来源任务就地打开

用户指示（原话）：「这个界面中查看来源问题时，我希望仅仅是任务弹窗，而不是跳转到项目里打开任务，也就是说，点进任务后，点叉叉，回到的是当前图片界面」。纯前端（React）、测试与文档改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `apps/web/src/features/published-records/PublishedRecordDetail.tsx` 新增可选 `onOpenTask?: (location: TaskLocation) => void`，来源任务位置提成 `const sourceTask`；缺省仍是深链 `<a href={taskDetailPath(sourceTask)}>`，传了就渲染成同文案同图标的按钮、点击调 `onOpenTask(sourceTask)`（不写地址栏）。
- `apps/web/src/features/published-records/RecordDetailModal.tsx` 新增同名 prop 并透传；`apps/web/src/features/issues/IssuesPageView.tsx` 把页面本就接收的 `onOpenTask`（`TaskDetailOverlay` 宿主）交给「来源迭代」弹窗，于是 `IssuesPage`、`TasksPage` 内嵌与项目主页弹窗三条入口都就地开任务弹窗，关掉任务弹窗回到记录弹窗。
- 未接就地宿主的入口保持深链语义：`/records` 卡片展开与 `?publishedId=` 深链、功能档案任务详情里的记录弹窗（`TasksPanel`）、聚合组详情（`TaskGroupDetailPanels`）。
- 回归防线：`apps/web/src/features/published-records/PublishedRecordDetail.test.tsx` 的《opens the source task in place when the host passes onOpenTask》+ 既有深链用例，`apps/web/src/features/issues/IssuesPageView.test.tsx` 的弹窗桩断言，`apps/e2e/tests/issues.spec.ts` 的「查看来源任务 → 任务弹窗且 URL 仍 /issues → 关闭回到记录弹窗」；E2E `record-publishing.spec.ts` 反向锁定 /records 仍是 link。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **96 文件 680 例全绿**；定向 `published-records + issues + tasks` 10 文件 81 例；`tsc --noEmit`、改动的 `eslint`、`prettier --check` 通过；真实 PostgreSQL E2E（`app_ci`）`tests/issues.spec.ts` **1 passed (14.9s)**、`tests/record-publishing.spec.ts` **3 passed (25.8s)**。「未运行」：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、全 workspace `typecheck` / `build`、`test:unit` / `test:integration`（未改服务端）、其余 Playwright 用例、`contract:*`（未动契约）、镜像构建与 Trivy；GitHub Actions 本轮推送后不会触发（工作流只在 `main` 与 `dev/*` 上跑）。
## 2026-10-10 任务卡片归属行加项目标识

用户指示（原话）：「接下来改任务卡片，这个任务的来源项目太模糊了我想加入项目图标，项目名称稍微加大加粗」。纯前端（React / CSS）、测试与文档改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `apps/web/src/features/my-tasks/TaskCenterPageView.tsx` 新增 `projectCodes` 映射，任务卡片与聚合组卡片的 `.task-belonging` 行首渲染 `<ProjectLogo className="tiny" />`（项目编码前两位，与项目列表页、遗留问题来源行同一个组件），项目名包进 `<strong className="belonging-project">`；R-3 任务项不带项目编码，编码一律取自页面注入的 `projects` 端口，项目不在列表里时只渲染项目名、不造图标。
- `apps/web/src/styles/design-system.css` 新增 `.task-belonging > .project-logo { margin-right: 6px }` 与 `.task-belonging > .belonging-project { font-size: 13px }`（原 12px，`<strong>` 自带加粗）；颜色不写死，由卡片色调规则作用在 `<p>` 上、`<strong>` 继承，五档卡片保持原文字色。
- 未改：`/tasks` 列表视图的项目列、项目任务面板（`TasksPanel`）的归属行 / 任务介绍行。
- 回归防线：`apps/web/src/features/my-tasks/TaskCenterPageView.test.tsx` 的《marks the source project with an icon and a bolder name on the card》与《falls back to the plain project name when the project is not in the port》（`renderView` 新增 `projects` 覆盖项），聚合组用例追加标识断言。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **96 文件 682 例全绿**（定向 my-tasks 5 文件 109 例）；`tsc --noEmit`、改动 `eslint`、`prettier --check` 通过；真实 PostgreSQL E2E（`app_ci`）`tests/tasks.spec.ts` **1 passed (19.5s)**；dev（Vite 5173）实测金黄卡归属行 = `span.project-logo.blue.tiny`（18×18、`title=AGV_SCHED`）+ `strong.belonging-project`（13px / 700 / 继承 `rgba(63, 45, 0, 0.8)`），行高 19.9px 单行不折。「未运行」：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、全 workspace `typecheck` / `build`、`test:unit` / `test:integration`（未改服务端）、其余 Playwright 用例、`contract:*`（未动契约）、镜像构建与 Trivy；GitHub Actions 在 `test` 分支不触发。
## 2026-10-10 任务卡片项目标识改成卡片水印

用户指示（原话）：「如果将项目的字母像水印一样成为背景的一部分呢，比如黄色卡片背景增加水印用浅黄色」→「请运用到网站上」；同日追加范围约束「这个水印只在任务中心实行，项目里面不用添加」。本批替换同日上一批《任务卡片归属行加项目标识》的做法（归属行行首 18px 小贴纸）。纯前端（React / CSS）、测试与文档改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `apps/web/src/features/my-tasks/TaskCenterPageView.tsx`：任务卡与组卡把 `<ProjectLogo className="watermark" />` 插到 `<h3>` 之前（编码取自页面注入的 `projects` 端口，项目不在列表里时整枚水印不渲染、不凭空造字母）；归属行只留 `<strong className="belonging-project">` + 「 · 模块 · 功能」。
- `apps/web/src/styles/design-system.css`：删除 `.task-belonging > .project-logo { margin-right: 6px }`；`.calm-task-card` 补 `isolation: isolate`（水印用 `z-index: -1`，负层级必须留在卡内）；新增 `.calm-task-card > .project-logo.watermark`（`position:absolute; z-index:-1; right:-16px; bottom:-34px; font-size:148px; font-weight:900; line-height:1; letter-spacing:-.07em; border-radius:0; background:none; pointer-events:none`）与五档配色（高 `#fedd76` / 紧急 `#de7670` / 普通 `#dbe8f8` / 已完成 `#cbe7e7` / 已取消 `#dfe5ec`）；标题上边距规则由 `h3:first-child` 扩到 `.project-logo.watermark + h3`。
- 未改：`/tasks` 列表视图的项目列、项目详情里的任务面板（`TasksPanel`，产品明确不加）。
- 回归防线：`apps/web/src/features/my-tasks/TaskCenterPageView.test.tsx` 的《fills the card with a project watermark and a bolder name on the belonging line》《falls back to the plain project name when the project is not in the port》，聚合组用例断言水印与 `:scope > h3`。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **96 文件 682 例全绿**（定向 my-tasks 5 文件 109 例）；`tsc --noEmit`、改动 `eslint`、`prettier --check` 通过；真实 PostgreSQL E2E（`app_ci`）`tests/tasks.spec.ts` **1 passed (23.6s)**；dev（Vite 5173）实测未完成档 12 张卡水印 `rgb(254, 221, 118)`（高）、`/tasks?status=done` 5 张 `rgb(203, 231, 231)`（已完成），卡片 `isolation: isolate`、标题 `margin-top: 8px`。「未运行」：整链 `pnpm check`（本地 npm 镜像无 audit endpoint）、全 workspace `typecheck` / `build`、`test:unit` / `test:integration`（未改服务端）、其余 Playwright 用例、`contract:*`（未动契约）、镜像构建与 Trivy；GitHub Actions 在 `test` 分支不触发。

## 2026-10-10 切换过渡：所有跳转与弹窗统一「缓冲后呈现」

用户指示（原话）：「好接下来我们优化所有切换效果，我发现经常会闪，我希望像之前改点开任务弹窗那样，可以增加一个缓冲，准备好了再呈现，所有跳转，弹窗我都要实现这个效果」。承接 2026-10-08《弹窗打开「闪一下」》（antd 弹窗遮罩 + 面板 160ms 同步淡入），把同一口径铺到页面跳转与自绘浮层。纯前端（React / CSS）、测试与文档改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `calm-skeleton.css`：`.calm-skeleton` 加 140ms 延迟 + 160ms 淡入（`animation: calm-skeleton-in 160ms linear 140ms both`）。实测「项目列表 → 任务中心」数据 44ms 就绪，改前骨架可见 1–3 帧（约 44ms）、随后硬替换；加延迟后骨架从未上屏，延迟期间容器照旧占位、页面高度不变。
- `design-system.css`：`.page-content > *` 180ms 淡入（**只动 opacity**，不加 transform——否则页内 fixed 元素会在动画期间改以该节点为包含块而跳位）；`.overlay` / `.palette` 160ms 淡入；`.popover` 140ms 淡入 + 4px 上浮。三者都受 `prefers-reduced-motion` 约束，静止外观与改前一致。
- `app/router/route-preload.ts`（新增）：构建期把 `pages` 下每个 route.ts 与同目录页面组件配对、URL path 编译成正则（支持 `:id?` 可选段、跳过 not-found 的 `*`），导出 `preloadRoutePath` / `routePreloadHandlers`。冷 chunk 下「遗留问题 → 审计日志」改前中间态 339ms（通用骨架「正在加载页面…」），悬停预取后降到 0ms。
- `app/layout/AppLayout.tsx` + `features/project-tree/ProjectTree.tsx`：侧栏导航与项目树行的 `onPointerEnter` / `onPointerDown` / `onFocus` 预取目标页 chunk；ProjectTree 用文件内局部 context 接 app 层注入的 `onPreloadPath`，因为 features 不得反向依赖 app（`check:boundaries` 保持 0 违规）。
- 未消除：不悬停直接点击、键盘直达或程序化跳转仍会走 339ms 的通用骨架路径。
- 回归防线：本批以抓帧实测为主（`docs/test-matrix.md` 的 `TRANSITION-BUFFERED-REVEAL-*`），未新增单测——改动全是 CSS 动效与预取时序，jsdom 无法验收。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **97 文件 699 例全绿**；`tsc --noEmit` 无输出、`check:boundaries` 0 违规、改动文件 `eslint` / `prettier --check` 通过；Playwright 全量 **70 passed / 1 failed (6.0m)**，唯一失败 `tests/project-delete.spec.ts:59` 在 `git stash` 掉本批改动后的干净 HEAD 上同样失败（本地 `app_ci` 的 SYSTEM 审计链有断点导致删除事务失败），与本批无关。

## 2026-10-10 项目间切换不再闪：同路由换参数改为原地换数据

用户反馈（原话）：「项目与项目之间的切换好像还是会闪」（浏览器停在 `/projects/8/modules`）。承接同一天《切换过渡：所有跳转与弹窗统一「缓冲后呈现」》：`.page-content > *` 已有 180ms 淡入，但页面组件自带「按路由参数生成」的 `key`，同一条路由换参数时整棵页面 DOM 会卸载重挂，淡入跟着整块重放，中间还夹 1–2 帧全透明（骨架自身带 140ms 延迟，同帧不可见）。纯前端（React / React Query）、测试与文档改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- 去掉页面组件上按路由参数生成的 `key`：`pages/modules`、`pages/task-board`、`pages/project-members`、`pages/features`，以及 `pages/module-tasks` 里 `TasksPanel` 的 `key`。换项目不再重建页面 DOM。
- 项目级查询改用 `placeholderData: keepPreviousData`（`useModules`、`useProjectDetail`、`useProjectOverviewQuery`、`useFeatures`、`useTaskBoardQuery`、`useProjectMembers`）：新数据到位前保留上一份，切换＝原地换数据，不再先空一帧、也不先塌成骨架再撑回。`useProjectDetail` 只在 `projectId !== null` 时给占位（条件展开 + 显式泛型：本仓库开了 `exactOptionalPropertyTypes`，三元素里的 `undefined` 不能当缺省），避免非项目路由的面包屑残留上一个项目的名字。侧栏项目树的 `ModuleList` 每个项目各持一个 `useModules` 实例、`projectId` 不变，命不中这条占位。
- `ModuleTasksPage`：换项目时旧模块列表里查不到新模块，只要仍在取数就按等待态处理，不再误判「模块不存在」。
- 保留原设计：跨页跳转（路由元素类型变化 → DOM 确实重建）仍是整页 180ms 淡入；骨架 140ms 延迟不变。
- 实测（dev Vite 5173、Chromium、逐帧记 `.page-content` 首子节点 opacity）：`/projects/4/modules → /projects/8/modules` 改前 `op=1 → 0`（空白 1–2 帧）`→ 0.15 → … → 1`；改后全程 `op=1`、无骨架帧、单帧换文本。功能目录模块间切换（`/…/12574/features → /…/12573/features`）同样全程 `op=1`。
- 权衡：占位窗口内页面显示上一份数据（本地约 55–110ms，即用户要的「缓冲」，接口变慢则等比变长）；页面组件内部状态（功能目录搜索词与展示方式、模块级任务筛选）换参数时不再重置；弹窗状态不受影响（弹层打开时侧栏被遮罩挡住）。
- 回归防线：本批仍以抓帧实测为主（`docs/test-matrix.md` 的 `ROUTE-PARAM-SWITCH-KEEP-DATA-*`），未新增单测——改动是挂载时机与缓存占位时序，jsdom 无法验收；既有 97 文件 699 例保持全绿。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **97 文件 699 例全绿**；全 workspace `pnpm typecheck` 通过（8 个带脚本的工程，含 web 与 api）、`pnpm lint`、`pnpm check:docs`（110 个 Markdown 文件）通过；`tsc --noEmit` 无输出、`check:boundaries` 0 违规、改动文件 `eslint` / `prettier --check` 通过；Playwright 全量 **70 passed / 1 failed (5.9m)**，唯一失败仍是 `tests/project-delete.spec.ts:59`（本地 `app_ci` 的 SYSTEM 审计链断点，上一批已用 `git stash` 在干净 HEAD 上复现同样失败），与本批无关。

## 2026-10-10 审计日志时间范围筛选改版：方案 B + 操作人文案简化

用户提议「审计日志这个起始时间和结束时间制作的 UI 美化」，并在三版对照预览页（`.data/annotations/audit-time-range-options.html`，工作树外、不进仓库）中选定「方案 B · 精修双字段」，随后又要求把操作人占位文案简化并选定「全员（可勾选多人）」。纯前端视觉与文案改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `apps/web/src/features/audit/AuditLogPageView.tsx`：时间字段的可视标签由「开始时间 / 结束时间」缩成「开始 / 结束」，各带一条 1px 分隔线（`<i className="audit-time-divider" aria-hidden="true" />`；用 `<i>` 而不是 `<span>` 是为了避开 `.audit-toolbar span { margin-left: auto }` 的贴右规则）；`aria-label` 仍是完整的「开始时间 / 结束时间」，既有用例的 `getByLabelText` 不受影响；操作人 `placeholder` 与底部说明文字里的「可搜索多选」同步改成「可勾选多人」。
- `apps/web/src/styles/design-system.css`：`.audit-time-field` 从「裸 flex」升级为带边框的字段盒（35px 高、8px 圆角、`--border` 边框、白底），`focus-within` 时切 `--ring` 边框加 3px 光晕；新增 `.audit-time-label`（11px、`#8b9aab`，显式 `margin-left: 0` 覆盖工具栏贴右规则）与 `.audit-time-divider`；≤700px 档原来的 `.audit-toolbar span { display: none }` 只藏得住标签，分隔线是 `<i>`，因此单独补一条隐藏规则。
- `apps/web/src/styles/inpulse-design.css`：把原先 `.audit-toolbar input[type="number"], input[type="datetime-local"]` 的合并规则拆开——`number` 保持原样，时间输入退成盒内无边框内容（33px 高、138px 宽、透明底、12px `#33465c`），边框与圆角交由 `.audit-time-field` 承担；并按 Chromium 扩展把 `::-webkit-calendar-picker-indicator` 的默认黑色日历图标换成主题浅灰 SVG（`data:image/svg+xml`，stroke `#7d8b9c`）。
- 实测（dev Vite 5173 + API 3000，登录 `tege`，Chromium 1440×900 / 640×900 两档）：单个时间字段实测 196px（等效旧样式覆盖后测得改前约 199px，基本持平），「查询」按钮坐标改前改后一致，筛选条换行位置未变；1440 档显示「开始 | 年/月/日 --:-- 日历图标」，填入 2026/10/08 00:00 与 2026/10/10 23:59 均不裁切；640 档标签与分隔线隐藏，只剩盒内输入。
- 回归防线：`apps/web/src/features/audit/AuditLogPageView.test.tsx` 新增 1 例「labels the time fields concisely and shortens the actor hint」——断言可视文本出现「开始 / 结束」、`aria-label` 仍是「开始时间 / 结束时间」、占位文案为「全员（可勾选多人）」且页面不再出现「可搜索多选」（旧占位文案下该用例必红）。`apps/e2e/tests/audit.spec.ts` 两处旧占位断言同步更新，`playwright test tests/audit.spec.ts` **2 passed (10.7s)**。
- 后续微调①：操作人 `CalmSelect` 宽度 `200 → 160 → 176`。真机量到空态占位「全员（可勾选多人）」在 <164px 会被省略号裁切、选中两人时 <172px 会掉成两行（框高 32 → 60），取 176 兼顾「更短」与「不换行」（当前最长用户名「邵晨宇」加「+ 1 …」仍单行）。
- 后续微调②：聚焦一律改成「整盒描边」。时间输入补 `outline: none`——输入不再画框后 Chromium 仍会在盒内套一圈 UA 轮廓，与 `.audit-time-field:focus-within` 的整盒描边叠成「外圈 + 内框」。动作码输入同病同因：全站 `input:focus-visible { outline: 2px solid #1467d8; outline-offset: 3px }` 与 `.task-search input { outline: none }` 特异性相同、但前者在 `design-system.css` 里更靠后，实际盖过后者，于是在 `.task-search` 的灰框里又画一圈蓝框；改用 `.audit-toolbar .task-search input:focus-visible { outline: none }` 加 `.audit-toolbar .task-search:focus-within` 的整盒描边。两处实测输入均 `outline-style: none`，盒上取到 `border-color rgb(45, 132, 230)` 与 `box-shadow rgba(45, 132, 230, 0.13) 0 0 0 3px`。
- 已知偏差：`::-webkit-calendar-picker-indicator` 只有 Chromium 系支持，Firefox / Safari 仍是各自的默认图标；时间输入宽度写死 138px，非 zh-CN 语言下原生占位串可能更长而裁切。 操作人框宽度 176px 是按当前演示账号的用户名长度量的：名字更长（4 字以上）时「标签 + 并列数量」仍可能掉成两行。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **97 文件 706 例全绿**（较上一批 +1 例）；全 workspace `pnpm typecheck` 通过；`pnpm lint`、`check:boundaries`（322 modules / 1620 dependencies，0 违规）、改动文件 `prettier --check` 通过。未跑全量 E2E 与整链 `pnpm check`。

## 2026-10-10 原始审计快照弹窗优化：分组卡片化与长值一键复制

用户反馈「优化一下这个界面」（审计日志「原始审计快照」弹窗）。原版把四个分组各排成一条长字段列表：行距松、分区弱；请求 ID 与两条 64 位哈希只能手选复制；事件载荷是裸 `pre`，没有类型标注与复制入口。纯前端视觉与交互改动，无契约 / Route Registry / 权限矩阵 / 数据库 / 迁移 / 鉴权 / 幂等 / 依赖改动：

- `apps/web/src/features/audit/AuditLogPageView.tsx`：新增 `copiedField` 状态与 `copySnapshotField(field, text)`（`navigator.clipboard.writeText`，成功置位、1.6 秒后复位）；请求 ID、客户端请求 ID、前一条哈希、本条哈希四行的 `dd` 改成 `.snapshot-copyable`（值 + 「复制 / 已复制」按钮），事件载荷加 `.snapshot-payload` 外壳与顶部工具条（左侧 `JSON` 标注、右侧复制按钮）。既有 `data-testid="audit-snapshot-payload"` 与各字段文本未变，老用例照常命中。
- `apps/web/src/styles/design-system.css`：`.snapshot-group` 由「有间距的区块」改成浅色卡片（`#fbfcfe` 底、`#eef3f8` 描边、10px 圆角、`16px 14px` 内边距），组间距 24px → 9px；字段网格列宽 104px → 92px、行间距 12px → 6px；哈希与请求 ID 改等宽（`var(--font-mono)`）；新增 `.snapshot-copyable` / `.snapshot-copy-button`（默认 `opacity .5`，悬停整组或键盘聚焦才提到 1）与 `.snapshot-payload` / `.snapshot-payload-bar` / `.snapshot-payload-kind`；`pre` 的底色与描边交给载荷外壳、正文改等宽；正文内边距 `22px 26px 26px` → `14px 26px 18px`，与头部 26px 左右对齐。
- 回归防线：`AuditLogPageView.test.tsx` 新增 1 例「copies the record hash and the raw payload from the snapshot modal」——断言弹窗内共 5 个「复制」按钮，点「本条哈希」那行后 `writeText` 收到 64 位哈希且按钮变「已复制」，点载荷工具条后收到含 `"loginName": "bob"` 的 JSON（去掉复制按钮或改错写入内容该用例必红）。
- 实测（dev Vite 5173 + API 3000，登录 `tege`，Chromium 1440×980、授予 clipboard 权限）：弹窗 840×924；点本条哈希后剪贴板读回 64 字符、点载荷后读回 434 字符，两处按钮均显示「已复制」。
- 后续微调（二次反馈「每一块距离上方和底部空间都有点太大了」）：四张卡片先收紧一轮——`.snapshot-group` 内边距 `14px 16px 15px` → `11px 14px 10px`（单卡 273px → 247px）、组间距 `12px` → `9px`、字段行间距 `12px 15px` → `6px 14px`、正文内边距 `18px 26px 24px` → `14px 26px 18px`；随后按反馈（「247 改为 258」）把卡片内边距回调到 `16px 14px`（单卡 258px）。根因是标题规则 `.snapshot-group-title`（特异性 0,1,0）被上方的 `.snapshot-body h3`（0,1,1）盖过，标题一直吃着 `h3` 的 `margin: 22px 0 10px` 与 12px 字号，只调卡片内边距收不掉顶部空白；改为 `.snapshot-body .snapshot-group-title`（`margin: 0 0 7px`）后单卡高度最终 258px、标题到首个字段行 7px，弹窗仍 840×924。
- 已知偏差：复制依赖 `navigator.clipboard`，只在安全上下文（https 或 localhost）可用，失败时按钮不置位、未做降级提示；复制按钮默认半透明常显（触屏无 hover 时的兜底），未单独写 `@media (hover: none)`；只改了快照弹窗，其它弹窗的字段排版未动。
- 本地验证（2026-10-10）：`pnpm --filter @inpulse/web test` **97 文件 707 例全绿**（较上一批 +1 例）；全 workspace `pnpm typecheck` 与 `pnpm lint` 通过；`playwright test tests/audit.spec.ts` **2 passed (10.8s)**。二次反馈的间距复调后重跑 `pnpm --filter @inpulse/web test` 仍 **97 文件 707 例全绿**，全 workspace `pnpm typecheck`、`pnpm lint`、`pnpm check:docs`（110 个 Markdown 文件）与改动文件 `prettier --check` 通过。未跑全量 E2E 与整链 `pnpm check`。
## 2026-10-10 文档导入（ADR-064）

用户要求「通过导入固定的文档来直接将项目的模块功能任务那些建立好」，并逐项确认：接受固定 Markdown 模板、要能导入整个项目、负责人自动加入成员、项目编码强制必填、防同一文档重复建、可导入多个模块和功能、没填写的内容不影响创建时按默认值跳过（跳过字段、不跳过对象）。按 [ADR-064](./docs/adr/ADR-064.md) 落库 F-32（契约 + 迁移 + API + 前端 + 测试，均为常规路径，无旁路写法）：

- **模板（版本 1）**：`# 项目：` / `## 模块：` / `### 功能：` / `#### 任务：` 四级标题 + `- 字段：值`（全角 / 半角冒号均可）；未知标题 / 字段、层级错配、空文档、任务缺负责人等 422 且任何 ERROR 整笔不落库；超长字段截断并回显问题；限额：原文 200000 字符、模块 100、功能 500、任务 500、实体总量 1000、项目成员 300、单任务负责人 20、单功能标签 50。
- **双模式 4 条路由（总数 102 → 106）**：模式 A `POST /api/v1/projects/{projectId}/document-imports[/preview]`（沿用「项目可写」：活跃成员或系统管理员；负责人必须是目标项目当前活跃成员，否则 422 `ASSIGNEE_NOT_MEMBER`，导入不隐式改成员关系）；模式 B `POST /api/v1/project-imports[/preview]`（任何登录用户；单事务创建项目与全部下级；负责人与项目成员自动加入、去重、排除创建者，发起者按 ADR-033 自动成为 LEADER；项目编码强制必填 `^[A-Z][A-Z0-9_]{1,31}$`）。执行带 `expectedDigest`（预览后改文档再执行 409 `DOCUMENT_IMPORT_STALE`）、CSRF 与一次性 `Idempotency-Key`；预览只读（`csrfPolicy: none` / `idempotencyPolicy: none`）；执行路由为常规数据库级幂等 `idempotencyContractVersion 1.0.0`，不进入 ADR-023 `securityFlow` 清单。
- **防重复**：摘要为规范化文档文本（去 BOM、CRLF→LF）的 SHA-256；A 在项目内查重、B 全局查重；重复执行 409 `DOCUMENT_IMPORT_DUPLICATE`（唯一约束兜底并发）；批次行含操作人 / 时间 / 各层创建与复用计数，不保存原文与解析正文。
- **复用与默认值**：模块 / 功能按规范化名称在项目 / 所属模块内精确复用、不覆盖任何字段（差异只发 WARNING `MODULE_REUSE_DIFFERS` / `FEATURE_REUSE_DIFFERS`）；任务一律新建；未填字段按默认值（优先级 `NORMAL`、截止 `null`、描述 `""`、标签 `[]`、验收标准 `null`、影响功能 `[]`）。
- **数据库**：迁移 `0039_document_import_runs.sql` 新增 `app.document_import_runs`（`UNIQUE (project_id, document_digest)`、摘要 / 模板版本 / 计数 CHECK、`app_runtime` 仅 `SELECT/INSERT`、显式补 `app_backup` 只读授权）并重写 `app.purge_project` 先清批次行（清理项 27 → 28 处），项目物理删除后同一文档可重新导入。
- **前端**：项目列表「从文档导入整项目」（成功跳转模块页）、模块页「从文档导入」与空项目搭建引导头部入口；双阶段弹窗（粘贴模板 / 下载模板 → 预览计划与问题清单 → 确认导入）；全部经生成客户端，执行前签发 CSRF 与一次性幂等键，错误按契约错误码映射固定中文提示。
- **收尾修复（本轮）**：`apps/e2e/helpers/fixture-cleanup.ts` 补 `app.document_import_runs` 夹具删除与历史孤儿兜底删除，并在收尾断言加入 `remaining_import_runs` / `orphan_import_runs` 必须为 0；此前 `session_replication_role = replica` 路径漏删批次行，`apps/ops` 逻辑备份恢复演练的 `pg_restore` 重建 `document_import_runs_project_fk` / `document_import_runs_actor_fk` 报错；`app_ci` 既有孤儿行已清理，`pnpm test:integration` 全量重跑通过。另修 `DocumentImportModal.test.tsx` 一处 8 字符 `token` 字面量触发 `check:secrets` 的问题（值改短，不放宽门禁）。
- **本地验证（2026-10-10）**：`pnpm check` 整链全绿（lint、format、typecheck 8 workspace、test:unit、db:migrations:check 38 个、db:seed:check、contract:drift、contract:validate 106 条、build、check:deploy:test、check:deps 786 源文件、check:frontend:boundaries、permissions:check 106、deps:audit、check:secrets 1192 文件、check:docs 111 文件）；真实 PostgreSQL（`app_ci`）`pnpm test:integration` 全量重跑：database 27 例 + ops 7 例 + api 56 文件 538 例全绿（含文档导入 5 例；`project-delete-api` 回归在列）；前端 98 文件 714 例（含 `DocumentImportModal.test.tsx` 6 例）；Playwright 本轮重跑 `tests/document-import.spec.ts` **2 passed（9.4s）**，上一轮 E2E 全量 73 passed / 6.0m。
- **未运行 / 已知偏差**：GitHub Actions 未执行（`test` 分支不触发，工作流只在 `main` 与 `dev/*`）；E2E 全量本轮未重跑（只重跑文档导入 2 例）；生产镜像构建与 Trivy 未跑；`.md` 文件上传、模板版本迁移工具与多文档批量导入属 ADR-064 非目标。本批含 API / 契约 / 迁移 / 前端产品代码与新增用例，按 §8 需非作者人工评审。工作树含全部改动；已本地提交（`28531ba`），未推送。

## 2026-10-10 文档导入模板自带格式说明（ADR-065）

用户指示（原话）：「模板那边要说明清楚格式，以为可能以后有人会用其他 ai 来把项目填写进入这个模板，怕 ai 乱写导致匹配不上」。按 [ADR-065](./docs/adr/ADR-065.md) 修订 ADR-064 的行处理口径（模板版本仍为 1，路由仍 106 条，无契约 / 权限 / 数据库 / 迁移改动）：

- `apps/api/src/modules/document-import/document-template.parser.ts`：解析循环忽略 trim 后以 `>` 开头（说明行）或以三个反引号 / `~~~` 开头（代码围栏）的行——不计入文档内容、不产生问题、不参与字段解析；只有说明行 / 围栏行的文档仍按 `EMPTY_DOCUMENT`；`LINE_UNRECOGNIZED` 文案同步更新。
- `apps/web/src/features/document-import/DocumentImportModal.tsx`：`DOCUMENT_IMPORT_TEMPLATE` 顶部新增 20+ 行 `>` 说明（三类行规则、逐字段名清单、必填与格式、两种导入范围差异、「不要自创、不要改名」），其后保留原示例结构；粘贴区上方新增「必填要素」区块（`document-import-format-guide`，2026-10-14 由「格式速查」改名并把正文换成必填要素总结）。
- `apps/web/src/styles/design-system.css`：新增 `.import-format-guide` 样式（左竖线 + 淡底 + 行内 code）。
- 回归防线：`apps/api/test/document-import-parser.test.ts` 新增 3 例（忽略行、空文档、直接读取前端 `DOCUMENT_IMPORT_TEMPLATE` 喂解析器的一致性用例——模板或解析器任一先行修改都会让该用例变红）；`DocumentImportModal.test.tsx` 新增 1 例。
- 本地验证（2026-10-10）：解析器 21 例、API 单测 74 文件 458 例、前端 98 文件 715 例、`pnpm lint` / `pnpm typecheck` / `pnpm format:check` 通过；真实 dev 浏览器实测三项（模板全文预览、真实用户名预览、代码围栏包裹预览）全部成功，未点「确认导入」。「未运行」：GitHub Actions（`test` 分支不触发）；集成测试与 Browser E2E 本轮未重跑（契约与服务端行为未变）。

## 2026-10-10 文档导入支持选择文件（ADR-066）

用户指示（原话）：「那除了粘贴能不能做个直接上传文件导入的」。按 [ADR-066](./docs/adr/ADR-066.md) 修订 ADR-064 非目标第 1 条——支持浏览器本地读取 `.md` / `.markdown` / `.txt` 文件内容填入导入文本；不引入 multipart 上传、服务端文件接收与附件存储（路由仍 106 条，无契约 / 权限 / 数据库改动）：

- `apps/web/src/features/document-import/DocumentImportModal.tsx`：INPUT 阶段新增「选择文件」按钮与隐藏 `<input type="file">`；`File.text()` 读取（剔除 BOM）后填入文本框并显示「已读取文件：…」；本地校验扩展名白名单、1 MiB 字节上限与 20 万字符上限，全部不发请求；空内容提示改为「请粘贴内容或选择文件后再预览。」
- `apps/web/src/features/common/components/InpulseIcon.tsx`：新增 `upload` 图标；`design-system.css` 新增 `.import-file-hint` 样式。
- 回归防线：`DocumentImportModal.test.tsx` 新增 3 例（.md 读取与 BOM 剥离并预览、.pdf 拒绝、超 1 MiB 拒绝）。
- 本地验证（2026-10-10）：前端 98 文件 718 例、`pnpm lint` / `pnpm typecheck` / `pnpm format:check` 通过；真实 dev 浏览器实测选择 `.md` 文件 → 预览成功、选择 `.pdf` 被本地拒绝。「未运行」：GitHub Actions（`test` 分支不触发）；集成测试与 Browser E2E 本轮未重跑（无服务端与契约改动）。

## 2026-10-12 导入弹窗矮窗口页脚裁切修复

用户反馈（原话）：「页面没全屏的时候布局有问题」（截图为非全屏窗口下「从文档导入整项目」弹窗底部「取消 / 预览」被裁掉）。纯前端呈现层修复 + E2E 回归用例，无契约 / 权限 / 数据库 / 迁移 / 依赖改动：

- `apps/web/src/styles/design-system.css`：新增 `.surface-modal > .dialog-form { min-height: 0; overflow-y: auto; }`——正文直接挂在弹层下、没有 `.catalog-form` 包裹的弹窗（当前仅从文档导入整项目）此前 flex 子项 `min-height:auto` 把内容撑出 `max-height: calc(100dvh - 56px)` 的盒子，被 `.surface-modal` 的 `overflow:hidden` 裁掉页脚；选择器只命中直接子级，走 `.catalog-form` 滚动链的其它弹窗不受影响。
- `apps/web/src/styles/design-system.css`：新增 `.catalog-modal .dialog-form { grid-auto-rows: max-content; }`——行轨不再随容器高度收缩，14 行文本框不被压扁，溢出交给滚动容器。
- 回归防线：`apps/e2e/tests/document-import.spec.ts` 新增「F-32 文档导入弹窗在矮窗口下页脚不被裁切、正文可滚动（布局回归）」——`1280×620` 视口下断言「预览」按钮可见且底边 ≤620、`.dialog-form` `scrollHeight > clientHeight`、文本框高度 >200、`scrollIntoViewIfNeeded` 后「选择文件」进入视口；修复前该用例失败（按钮完整裁出），修复后通过。
- 本地验证（2026-10-12）：`document-import.spec.ts` **3 例**、`modules + features + project-create` **4 例**通过；`pnpm test:web` **98 文件 718 例全绿**；`pnpm lint`、`pnpm typecheck`（8 workspace）、`pnpm format:check` 通过；E2E 清单 74 例 / 29 文件（全量未重跑）。「未运行」：整链 `pnpm check`（本机 npm 镜像无 audit endpoint）、`test:unit` / `test:integration`（未改服务端）、`contract:*`（未动契约）、镜像构建与 Trivy；GitHub Actions 在 `test` 分支不触发。未提交、未推送。

## 2026-10-12 功能标签改为胶囊输入

用户指示（原话）：「新建功能的标签能不能改成这样形式的」（示例为胶囊 + 虚线「＋ 新分类」按钮），随后「颜色不要黑色改成这样的颜色」（指向功能卡上的淡紫标签徽章 `badge-violet`）。纯前端控件与样式 + 单测 / E2E + 文档，无契约 / 权限 / 数据库 / 迁移 / 依赖改动：

- 新增 `apps/web/src/features/features/FeatureTagsInput.tsx`：受控胶囊控件——已有标签为淡紫胶囊（`#eeeaff` 底 / `#6b58c4` 字，与 `.badge-violet` 同色）、内置 × 移除；虚线「＋ 新标签」展开行内输入，回车或失焦提交、Esc 取消、重复值去重、50 个上限就地拒绝并提示；表单值仍是换行分隔字符串，冲突合并与幂等摘要比较不变。
- `FeaturesPageView.tsx` 标签字段由 `Input.TextArea` 换为 `FeatureTagsInput`，label 改为「标签（最多 50 个）」，RHF 的 ≤50 校验保留为兜底；`design-system.css` 新增 `.feature-tags` / `.feature-tag-row` / `.feature-tag-pill` / `.feature-tag-remove` / `.feature-tag-add` / `.feature-tag-entry` / `.feature-tag-limit`。
- 回归防线：`FeatureTagsInput.test.tsx` 5 例（回车提交与去重、失焦提交与 Esc 取消、× 移除、50 上限拒绝、禁用）；`FeaturesPageView.test.tsx` 新增 1 例锁定数组提交；`apps/e2e/tests/features.spec.ts` 改走新控件（添加两枚胶囊 → 保存 → 编辑弹窗预填断言）。弹窗内 jsdom 断言用 `toBeInTheDocument`：antd 弹窗停在 `ant-zoom-appear-prepare` 的 `opacity: 0` 首帧，`toBeVisible` 在弹窗内不可用。
- 本地验证（2026-10-12）：`pnpm test:web` **99 文件 724 例全绿**；`pnpm lint`、`pnpm typecheck`（8 workspace）、`pnpm format:check` 通过；`features.spec.ts` **2 例全绿**（真实 PostgreSQL + 生产构建）；抓帧人工检查空态与填充态样式。「未运行」：整链 `pnpm check`（本机 npm 镜像无 audit endpoint）、`test:unit` / `test:integration`（未改服务端）、`contract:*`（未动契约）、其余 Playwright 用例（清单仍 74 例 / 29 文件）、镜像构建与 Trivy；GitHub Actions 在 `test` 分支不触发。未提交、未推送。

## 2026-10-12 本地测试环境补齐：ops 备份集成认 POSTGRES_BIN + 一键 test:integration:local

用户要求「解决环境问题」。本批消除两处**本地**环境缺口，并修复一处被本地环境暴露出来的**生产路径缺陷**；不改 CI 行为，不改契约 / 迁移 / 权限：

- `apps/ops/test/backup.integration.test.ts`：`pgDumpPath()` 在显式 `INPULSE_BACKUP_PG_DUMP` 之外增加 `POSTGRES_BIN` 兜底（`join(bin, 平台对应的 pg_dump)`），`pgRestorePath()` 继续由同一目录派生 `pg_restore`。此前只有 `db:test:local` 认 `POSTGRES_BIN`，备份集成测试必须手工注入两个环境变量，否则 2 例以 `pg_dump exited with code null` 失败（旧条目已把它记为「既有环境缺口」）；现在按 CONTRIBUTING 的同一个开关即可通过，CI 仍显式注入、行为不变。实测：只设 `POSTGRES_BIN=D:\PostgreSQL\18\pgsql\bin` 与 `TEST_DATABASE_URL` → ops **2 文件 7 例通过**。
- 新增 `scripts/test-integration-local.mjs` 与根脚本 `test:integration:local`（本地专用，不加入 `pnpm check` 与 CI 链路）：默认把 `TEST_DATABASE_URL` / `MIGRATION_DATABASE_URL` 指向 docker `inpulse-pg`（55432）的 `app_ci`，TCP 探测可连后先跑 `pnpm db:migrate` 补齐迁移，再按 `POSTGRES_BIN` 注入 pg_dump/pg_restore 后执行 `pnpm test:integration`；取值优先级「进程环境变量 > `deploy/.env.dev.local` > 内置默认」，支持 `--skip-migrate` / `--env-file` / `-h`。这样拉取到新迁移后不必再手工迁移 `app_ci`——database 集成的「迁移幂等」用例要求测试库已迁到当前 HEAD，滞后时首跑会把待应用迁移写进库并因此报红。
- 新增 `scripts/test-e2e-local.mjs` 与根脚本 `test:e2e:local`（本地专用，不加入 `pnpm check` 与 CI）：E2E 夹具会直接写进数据库（§8 因此禁止指向演示库 `app`），脚本按同一优先级解析 `E2E_DATABASE_URL`（回落 `TEST_DATABASE_URL`）后显式注入，解析出演示库时**拒绝运行**，跑前补齐 `app_ci` 迁移，缺 `apps/api/dist/main.js` 时提示先 `pnpm build`；其余参数原样转发给 Playwright。自检：`pnpm test:e2e:local tests/search.spec.ts` 6 例通过（17.0 s），`E2E_DATABASE_URL` 指向 `app` 时拒绝运行。
- 顺带修复 **1 例偶发红灯**（全量集成里 `apps/api/test/preauth-session.integration.test.ts`「同一预认证 Session 只能原子消费一次」报 `preauth_sessions_consumed_at_check`，约束 `consumed_at IS NULL OR consumed_at >= created_at`，见 `database/migrations/0000_initial.sql:275`）。它表面像本地 Docker VM 时钟漂移，实为**跨时钟域比较的生产缺陷**：`PostgresPreauthSessionRepository.consumeOnce` 用 API 进程时钟 `new Date()` 写 `consumed_at`，而 `created_at` 取数据库 `now()`（事务起点）——生产环境 API 与 PostgreSQL 也是不同主机，只要 DB 时钟领先 API 进程几毫秒，写库就报 `23514` 并让登录接口 500。修法对齐既有先例 `apps/api/src/auth/sso/sso-login-attempt.repository.ts`：`consumed_at` 一律取数据库 `now()`，第三个参数由 `consumedAt: Date = new Date()` 改名 `now?: Date` 且只覆盖过期判定时刻、不落库（生产调用方 `login.service.ts` 仍只传两个参数）。新增确定性回归用例「消费时间戳取自数据库时钟，不受应用进程时钟偏差影响」：传入落后 5 秒的「当前时刻」，改前必报同一条 `23514`、改后通过。
- 本地验证（2026-10-12）：`pnpm test:integration:local` 全量跑通 database 2 文件 27 例 + ops 2 文件 7 例 + api 56 文件 539 例（含新增回归用例，全绿）；`pnpm check`（非数据库全量门禁）exit 0；`pnpm test:e2e`（`E2E_DATABASE_URL` → `app_ci`）73 passed（6.3 分钟）；新增脚本自检 `pnpm test:e2e:local tests/search.spec.ts` 6 例通过（17.0 s）。

## 2026-10-12 弹窗内容 chunk 未就绪不再先闪空壳（项目主页 / 任务中心）

用户反馈（原话）：「我发现这种点击查看全部会先闪到无记录界面再呈现内容，不要这样如果加载略慢就慢一点跳转不要闪出不该存在的界面」。`ProjectWorkspaceModals` 与 `TasksPage` 的遗留问题弹窗此前把 `<Suspense fallback={null}>` 放在 `<Modal>` **内部**，而内容视图是 `React.lazy`；弹层同步上屏、内容后到，于是先出现「只有标题、正文空白」的空壳（本机实测 129px、约 330ms）再跳成骨架与内容。

- `apps/web/src/features/project-overview/project-workspace-chunks.ts`（新增）：5 个装载函数（成员视图 / 活跃成员 / 迭代记录 / 遗留问题 / 任务详情）+ `preloadProjectWorkspaceChunk(kind)` + `projectWorkspacePreloadHandlers(kind)`（悬停 / 按下 / 键盘聚焦预热，失败只吞异常）；`lazy()` 与预热共用同一份 `import()`，与 `route-preload.ts` 同口径。
- `ProjectWorkspaceModals.tsx` / `pages/tasks/TasksPage.tsx`：`Suspense` 提到 `<Modal>` 外层——chunk 没到位时整个弹层不渲染；`ProjectOverviewPageView.tsx` 的 4 个入口按钮挂上 `projectWorkspacePreloadHandlers`。
- 回归防线：`ProjectWorkspaceModals.test.tsx` 用 `vi.hoisted` 的 promise 闸门卡住 chunk，断言未就绪时 `queryByRole("dialog")` 为 `null`、释放后才出现；把 Suspense 放回弹层内部该用例变红。
- 本地验证（2026-10-12）：逐帧抓帧改后为 `null → 骨架 → 内容`、空壳帧 0 帧（改前 129px 空壳约 330ms）；悬停「查看全部」后 44ms 内发起 chunk 请求、2s 内 15 个模块请求完成；`pnpm --filter @inpulse/web typecheck` exit 0；`pnpm test:web` **99 文件 721 例全绿**；`pnpm test:e2e:local tests/aggregate-views.spec.ts tests/tasks.spec.ts tests/issues.spec.ts` **4 passed (43.0s)**。「未运行」：整链 `pnpm check`、`test:integration`、全量 Browser E2E、`pnpm build`、契约 / 权限 / 依赖审计；GitHub Actions（`test` 分支不触发）。

## 2026-10-12 死代码清理：antd 适配层 4 段永不生效 + 零引用组件

用户指示（原话）：「检查一下代码有没有无用的可以删除的」→「可以」。清理范围只到 `apps/web`，不改任何运行时行为：

- `apps/web/src/styles/antd-adapter.css`：删掉 message / Tabs / Dropdown / Tooltip 四段永不生效的适配（255 行，419 → 161 行）。web 端从 antd 只导入 Alert / Badge / Button / Card / Checkbox / ConfigProvider / Divider / Empty / Form / Input / Modal / Popover / Result / Select / Space / Switch / Tag / Typography；真实 DOM 里 `.ant-tabs*` / `.ant-dropdown*` / `.ant-tooltip*` / `.ant-message*` 从未出现。保留仍生效的 Modal 段与 Popover 段（`.ant-popover` 由 `CalmDateTimeInput` 实测渲染）。
- 同批删除：`design-system.css` 的 `.toast` 与 `.surface-modal.task-side-modal`（后者也没有调用方给 `AppModal` 传 `className="task-side-modal"`）、`record-drafts.css` 的 `.draft-project-selector`、`inpulse-design.css` 的 `.placeholder-note`、`features/common/components/WorkspacePlaceholder.tsx`（40 行，全仓零引用）、`app/theme/theme.ts` 里 Segmented / DatePicker / Tabs / Tooltip / Dropdown 五组 token。
- 同批收口：`project-workspace-chunks.ts` 的 `preloadProjectWorkspaceChunk` 去掉多余 `export`（仅同文件使用）；`pages/tasks/TasksPage.tsx` 的任务详情弹窗复用 `loadTaskDetailOverlay`，不再第二次写 import 路径。
- 本地验证（2026-10-12）：删除前拍 9 张基准图、删除后逐像素比对（`features-page` / `modal-records` 字节完全一致，其余 17–123 像素差异与「同版本连拍两次」的 17–60 像素噪声同区域）；删除前后逐页 DOM 类名一致（`records` 97 / `tasks` 76 / `issues` 62 / `project-modules` 89 / `modal-records` 148）；`pnpm test:web` 99 文件 721 例、`pnpm lint` / `pnpm format:check` / `pnpm check:docs`（113 个 Markdown）/ `pnpm check:frontend:boundaries`（0 违规）/ `pnpm --filter @inpulse/web typecheck` 全通过；`pnpm test:e2e:local`（8 个 spec）16 passed (1.8m)。「未运行」：整链 `pnpm check`、`test:integration`、全量 Browser E2E、`pnpm build`、契约 / 权限 / 依赖审计；GitHub Actions（`test` 分支不触发）。
- `apps/api` 与 `packages` 的同类扫描因 NestJS 装饰器/模块图与 barrel 导出误报过多，未纳入结论；另开一轮时建议引入 knip。

## 2026-10-12 全局测试：非数据库整链门禁 + 真实数据库集成 + 全量浏览器 E2E 补跑

用户指示（原话）：「全局测试一下」。在第一百三十二条、第一百三十三条的改动之上补跑其标注为「未运行」的门禁，本轮无代码改动：

- `pnpm check` exit 0：lint / format:check / typecheck（8 workspace）/ test:unit / db:migrations:check（38 个）/ db:seed:check / contract:drift / contract:validate（106 条）/ build（含 `apps/web`）/ check:deploy:test（5 个 image ref）/ check:deps（788 源文件）/ check:frontend:boundaries（326 modules / 1645 dependencies，0 违规）/ permissions:check（106 / 106）/ deps:audit（No known vulnerabilities found）/ check:secrets（1199 文件）/ check:docs（113 个 Markdown）。
- `POSTGRES_BIN=D:/PostgreSQL/18/pgsql/bin pnpm test:integration:local`（`app_ci`，迁移 0 applied / 38 already present）exit 0：database 27 例 + `apps/ops` 7 例 + `apps/api` 56 文件 539 例全绿。
- `pnpm test:e2e:local`（生产构建 + vite preview，`E2E_DATABASE_URL` → `app_ci`）**73 passed (6.2m)** exit 0；夹具清理删除用户 825、项目 474、业务行 16054、审计行 1110（SYSTEM 审计链在夹具之后已有真实写入，按既有行为留下断点）。
- 「未运行」：GitHub Actions（`test` 分支不触发，推送后由 CI 在 `main`/`dev/*` 执行）、生产镜像构建与 Trivy 镜像扫描。
- `docs/test-matrix.md` 同步新增《全局测试》小节的 `GLOBAL-CHECK-GATE-001` / `GLOBAL-INTEGRATION-DB-001` / `GLOBAL-E2E-BROWSER-001` 行。

## 2026-10-13 文档导入内嵌 AI 辅助转换（ADR-067）

用户指示（原话要点）：「现在是通过外部的ai才能转换，我能不能嵌入一个内部的ai，我有自己的api密钥」→「我有的是中转站api」→「『整项目 + 项目内』两种模式都做，额度先不管」→「但我想的是导入自己的文档，然后AI自己分析出来」→「我需要纯文本类（`.txt` / `.md` / `.markdown`）和Word（`.docx`）或 PDF 都要考虑」，随后「开始进行」。按 [ADR-067](./docs/adr/ADR-067.md) 落库（Proposed → 接受并实施），F-32 文档导入新增可选 AI 辅助（只出草稿、永不直接写库）；契约、服务端、前端、E2E、运维接线与三份设计文档同批完成：

- **契约（107 条路由）**：`packages/api-contract/src/contracts/document-import.zod.ts` 新增 `DocumentImportAssistRequest` / `DocumentImportAssistResponse`（`text` 1～200000、`issues` 复用 `DocumentImportIssue`）；`document-import-routes.ts` 新增 `assistDocumentImport`（`POST /api/v1/document-imports/assist`，`securityFlow` none / `csrfPolicy` none / `idempotencyPolicy` none，走 ADR-019 纯校验 allowlist）；`pure-validation.ts`、`permission-matrix.ts`、`artifacts.ts`、OpenAPI 与生成客户端（含 `document-import-template.ts` 模板常量迁入契约）同步；`ADMIN` 边界不变。
- **服务端**：`apps/api/src/modules/document-import/` 新增 `ai-assist.config.ts`（fail-closed：关闭 / 缺端点 / 缺模型 / 缺密钥 / 非 https / Secret 越界；test 逃生需 `NODE_ENV=test` + `AI_ASSIST_API_KEY_TEST_PATH=1`）、`ai-assist.client.ts`（OpenAI 兼容出站适配器：最小字段、无 Cookie / CSRF、无自动重试、错误分类 auth / rate-limited / timeout / network / context-limit / invalid-response、`finish_reason: length` 截断附 ERROR）、`ai-assist.prompt.ts`（模板全文 + 模式约束 + 用户资料独立 message）；`document-import-http.service.ts` 的 `assist()` 只在短事务内解析身份，上游调用、解析器预检与响应组装都在事务之外；`document-import-assist.controller.ts` 只绑定 `@Operation("assistDocumentImport")`。无数据库改动、无迁移。
- **前端**：新增 `document-text-extraction.ts`（`.txt` / `.md` / `.markdown` 直读剥 BOM；`.docx` 走 `mammoth`；`.pdf` 走 `pdfjs-dist` + 同源 module Worker（`?url` 资产）逐页抽取；20 MiB 与 200000 字符上限、100000 字符非阻断提醒、固定中文错误码文案）；`document-import-query.ts` 新增 `useAssistDocumentImport` 与 503 错误文案映射；`DocumentImportModal.tsx` 新增 AI 区块（选择文档自动分析一次 / 粘贴原文分析、草稿覆盖前平级二次确认、ERROR 问题清单、未启用时入口不隐藏但提示）；两个依赖都懒加载（主包 215 KB 不变，`mammoth` 308 KB、`pdf` 431 KB 独立 chunk）。
- **实施发现与修复（CSP，ADR-021 不放宽）**：E2E 零违规断言抓出 zod v4 对象 Schema JIT 变体在首个 Schema 构造时用 `Function("")` 探测 eval——严格 CSP 下探测被静默捕获但浏览器仍记录 `script-src: eval` 违规（生产上报噪声，与 pdf.js / WebAssembly 无关）。修复：新增 `apps/web/src/app/zod-strict-csp.ts` 写 zod `jitless`（不 import zod，避免入口包体；行为与探测失败后的回退一致），`main.tsx` 首行导入；`zod-strict-csp.test.ts` 2 例锁定。
- **E2E**：新增 `apps/e2e/helpers/office-fixtures.ts`（运行时生成最小 docx 与文本型 pdf）、`apps/e2e/helpers/ai-assist-stub.mjs`（本机回环 stub 上游，读 `messages[]`，整项目 / 项目内两种模式）、`apps/e2e/tests/document-import-ai.spec.ts` 2 例；`playwright.config.ts` 增加 stub webServer 与 `AI_ASSIST_*` 注入（密钥文件在临时目录动态生成）。
- **运维**：`deploy/compose.yaml` 增加 `AI_ASSIST_*`（默认 `AI_ASSIST_ENABLED=0`）与 `/run/secrets/ai_assist_api_key` 只读挂载（禁用时可放空占位文件，Compose 要求文件存在；ADR 的「启用时挂载」按此口径落地）；`deploy/.env.deploy.example` / `.env.deploy.test` / `.env.dev.example` 同步说明（`AI_ASSIST_MAX_TOKENS` 名字含 TOKEN，会被 `check:secrets` 视为敏感键，示例文件必须留空，由 compose 默认值兜底）；新增 `apps/ops/src/ai-assist-check-cli.ts`（`pnpm --filter @inpulse/ops ai-assist:check`，最小请求探测端点 / 密钥 / 模型；不新增根级命令、不纳入 CI）。
- **文档**：ADR-067 转 Accepted 并写入实际验证结果；`docs/adr/README.md` 索引、`docs/permissions.md`（`assistDocumentImport` 行）、`docs/test-matrix.md`（`DOC-IMPORT-AI-*` 9 行）、功能设计 / 系统设计 / 技术设计增补去草案标注、本小节与开发日志同批更新。
- **本地验证（2026-10-13）**：API 单测 76 文件 476 例、Web 101 文件 750 例、Ops 9 文件 60 例、真实 PostgreSQL assist 集成 9 例、Playwright 全量 **76 例通过（6.1 分钟）**、`contract:validate` 107 条 / `contract:drift` 无漂移 / `permissions:check` 107 条、`lint` / `format:check` / `typecheck`（8 workspace）/ `build` / `db:migrations:check`（38 个）/ `db:seed:check` / `check:deps` / `check:frontend:boundaries` / `check:deploy:test` / `check:secrets` / `check:docs` 通过；公共 registry 审计在 high 阈值通过（1 个 moderate：`mammoth > argparse > sprintf-js` GHSA-hp3w-g68c-fv3c，上游暂无 >=1.1.4 修复版本，用法路径不可达）。
- **未运行 / 偏差**：GitHub Actions（`test` 分支不触发）、真实中转站上游（E2E 只用本机 stub）、镜像构建与 Trivy（未改 Dockerfile）；`mammoth@1.13.0` 与 `pdfjs-dist@6.4.299` 为新增生产依赖，按第 4 节仍须独立依赖 PR 由人工确认（含上述 moderate 通告与 sprintf-js 处置决策）。
- 阶段 0 企微机器人绑定（阶段一）已本地落库（ADR-069，2026-10-13）：账户菜单「绑定企业微信」+ 三条自助路由（`getWecomBinding` / `createWecomBindingCode` / `deleteWecomBinding`，路由 110 → 113）+ 迁移 `0041`（`app.wecom_binding_codes`、`app.user_wecom_bindings`、`SECURITY DEFINER` 兑换函数 `app.redeem_wecom_binding_code`（WBC01–WBC06）；`createWecomBindingCode` 加入 ADR-023 allowlist 走 `securityFlow`，解绑走数据库级幂等与 `actorOnly` 重放授权）；前端 `WecomBindingModal`（三态、倒计时、复制、每 5 秒轮询、Popconfirm 解绑）；真实 PostgreSQL 集成 `wecom-binding.integration.test.ts` 14 例、Web `WecomBindingModal.test.tsx` 6 例；`db:migrations:check` 40 个迁移；契约 113 条 / `permissions:check` 113 条 / `contract:drift` 无漂移；数据库集成测试的已应用迁移清单同步补登记 `0040`（ADR-068 遗漏）与 `0041`。阶段二（长连接桥接投递任务指派等通知）未实现，不得描述为已交付。
- 阶段 0 企微机器人凭据管理员在线配置已本地落库（ADR-070，2026-10-13）：管理员在「成员与设置 → 企业微信机器人」在线更换机器人，新增 `getWecomRobotConfig` / `updateWecomRobotConfig` 两条 admin 路由（路由 113 → 115，`adminSession`；PUT 走 CSRF + 数据库级幂等 + `admin.wecomRobot.update` 审计）+ 迁移 `0042`（单行表 `app.wecom_robot_config`：`bot_id` 与 AES-256-GCM 密文 Secret（信封 nonce‖tag‖ciphertext、AAD 常量）、密钥尾 4 位提示、更新人、`row_version`；运行时无 DELETE、backup 只读、`DO $` 部署断言）；主密钥只从 `WECOM_ROBOT_ENCRYPTION_KEY_FILE`（`/run/secrets/wecom_robot_encryption_key`，可选 `WECOM_ROBOT_ENCRYPTION_KEY_VERSION`）读取，缺失 / 非法 fail closed（GET 分类 `ENCRYPTION_KEY_UNAVAILABLE`，需加密新密钥的 PUT 503 `WECOM_ROBOT_CONFIG_KEY_UNAVAILABLE`）；明文 Secret 不落库 / 不进审计与幂等物化；修订 ADR-069 §2.4（投递凭证不再只由桥接侧持有）。真实 PostgreSQL 集成 `wecom-robot.integration.test.ts` 10 例、keyring 单测 8 例、Web `WecomRobotSettingsPanel.test.tsx` 5 例；契约 115 条 / `permissions:check` 115 / 115 / `contract:drift` 无漂移 / `db:migrations:check` 41 个；契约包真实扫描清单同步新增 2 条。桥接进程读取数据库凭据与配置变化重连、以及阶段二投递仍未实现，不得描述为已交付；桥接改造落地前更换机器人仍须人工同步桥接本地配置。2026-10-13 扩展（迁移 `0043`）：单行配置新增可空 `bot_profile_url`（机器人链接，展示到成员「绑定企业微信」弹窗、含待用码状态；非敏感展示字段，https、1–512、CHECK 兜底），`updateWecomRobotConfig` 请求 / 响应与重放安全字段新增 `botProfileUrl`（缺省保持、null 清空），幂等契约 1.0.0 → 1.1.0；`WecomBindingStatus` 响应新增 `botProfileUrl`（未配置为 null）；Web 测试扩至弹窗 8 例、面板 7 例。
- 阶段 0 文档导入工作台（ADR-071）前端纵切片已本地落库（2026-10-13）：F-32 文档导入的分析态改为左右分栏工作台——`apps/web/src/features/document-import/document-draft.ts`（文本与结构化草稿双向往返、`insertDocumentDraftField` 补缺字段、无法归属的行记入 `looseLineIndexes` 不丢）与 `document-assignee-match.ts`（成员名字精确且唯一才命中，同名 / 相近给候选、查不到给 UNKNOWN，候选点选与「从成员里挑」都以补充说明重调同一路由），`DocumentImportModal.tsx` 左栏「内容梳理 / 预览文档」页签 + 右栏 AI 助手对话；补充说明不新增接口、不做服务端会话状态（修订 ADR-067 非目标第 2 条），原始文档与逐轮补充拼成一段后重调同一条 `assistDocumentImport`；成员匹配复用既有 `GET /api/v1/users`，不自动猜人 / 建用户；无新增路由（仍 110 条）、无迁移、无新依赖、无权限变化。本地验证：Web 单测 105 文件 786 例（`document-import` 4 文件 59 例）、`pnpm typecheck` / `lint` / `format:check` / `build` / `contract:validate`（110 条）/ `contract:drift` / `permissions:check` / `check:frontend:boundaries` / `check:secrets` / `check:deploy:test` / `db:migrations:check`（39 个）/ `db:seed:check` / `check:deps` / `check:docs` 通过，E2E `tests/document-import.spec.ts` 与 `tests/document-import-ai.spec.ts` 5 例通过；GitHub Actions 未执行（`test` 分支不触发）。同批修掉上一批遗留的两处红门禁（11 个文件未过 prettier、`AiAssistSettingsPanel.test.tsx` 给 `apiKey` 赋字面量），并记录 ADR-068 的文档同步缺口：本文件与三份设计、权限矩阵、测试矩阵仍写「107 条路由 / 38 个迁移」，未同步 110 条与迁移 `0040`。
- 阶段 0 AI 辅助转换管理员在线配置（ADR-068）文档同步与实测已补记（2026-10-13）：代码、契约（`ai-assist-settings-routes.ts` / `contracts/admin-ai-assist.zod.ts`）、迁移 `0040_ai_assist_settings.sql`、前端设置页（`AdminUsersPageView.tsx` 页签 + `AiAssistSettingsPanel.tsx`）与 ops 自检脚本随 `c4ec412` 落库，但当时的文档同步只覆盖了 ADR-067；本批补记功能设计 / 系统设计 / 技术设计、权限矩阵（+3 行）、测试矩阵、`docs/adr/ADR-068.md` 与本节，并实测：API 单元 4 文件 38 例（config 10 / client 9 / keyring 9 / runtime 10）、Web 单元 2 文件 15 例（`AiAssistSettingsPanel` 6 / `AdminUsersPageView` 9）、真实 PostgreSQL `document-import-assist.integration.test.ts` 9 例、`contract:validate` 110 条 / `contract:drift` 无漂移 / `permissions:check` 110 条 / `db:migrations:check` 39 个 / `check:deploy:test` / `check:secrets` 通过。**未落库的缺口**（与 ADR-068 第 2.7 条的差异）：① `getAiAssistSettings` / `updateAiAssistSettings` / `testAiAssistSettings` 无真实 PostgreSQL 集成用例；② 设置页无 E2E；③ `deploy/compose.yaml` 未挂载 `ai_assist_encryption_key` 与 `AI_ASSIST_ENCRYPTION_KEY_*`（仅 `scripts/dev-start.mjs` 与 `.env.dev.example` 有本地路径），Compose 部署下保存密钥会因缺主密钥 fail closed。上文 ADR-067 小节里的「107 条路由 / 38 个迁移」是当时状态，当前为 110 条 / 39 个。
- 阶段 0 AI 辅助转换管理员在线配置（ADR-068）三条缺口已补齐（2026-10-13，同一 `test` 分支本地工作区）：① 新增真实 PostgreSQL 集成用例 `apps/api/test/admin-ai-assist-api.integration.test.ts` **11 例通过**（三条管理员路由的鉴权 / CSRF / 幂等重放 / 审计不含明文 / 数据库行优先 / 急停优先 / 主密钥不可用与密文不可认证分类 / 测试连接 AUTH；与 `document-import-assist.integration.test.ts` 合跑 **2 文件 20 例**，均指向 `app_ci`）；② 新增设置页 E2E `apps/e2e/tests/settings-ai-assist.spec.ts` **2 例通过**（管理员保存配置 → 测试连接 → 普通成员文档导入经数据库配置完成转换），全量 Playwright **78 例通过（6.2 分钟）**；③ `deploy/compose.yaml` 接线主密钥（api 新增 `AI_ASSIST_ENCRYPTION_KEY_FILE` / `AI_ASSIST_ENCRYPTION_KEY_VERSION`、只读 Secret 挂载与顶层 `secrets.ai_assist_encryption_key`，`deploy/.env.deploy.example` 增补 `AI_ASSIST_ENCRYPTION_KEY_VERSION`）。门禁：`pnpm lint` / `format:check` / `typecheck`（8 workspace）/ `test:unit` / `db:migrations:check`（39 个）/ `db:seed:check` / `contract:drift` / `contract:validate`（110 条）/ `build` / `check:deploy:test` / `check:deps`（821 文件）/ `check:frontend:boundaries`（344 模块）/ `permissions:check`（110 条操作 / 110 条路由）/ `check:secrets`（1242 文件）/ `check:docs` 通过；`deps:audit` 仅剩 1 个 moderate（`mammoth > argparse > sprintf-js`，ADR-067 已记录）且无 high；GitHub Actions 未执行（`test` 分支不触发）。

- 阶段 0 文档导入（ADR-072）整项目导入的项目成员名单校验已本地落库（2026-10-14）：模式 B（整项目导入）的 `- 项目成员：` 由「可省略 + 负责人自动并入」改为**必填且必须含创建者本人与全部任务负责人**，预览即 422 裁决（空名单 `MEMBER_REQUIRED`、缺创建者 `MEMBER_CREATOR_MISSING`、缺负责人 `ASSIGNEE_NOT_INITIAL_MEMBER`），判据是解析后的账号而非字面令牌，「负责人自动并入成员集合」退化为兜底；AI 整项目提示词带上本次导入人姓名（`buildSystemPrompt(mode, creatorName?)`，姓名只进提示词不进日志，取不到时不编造），工作台用同一口径做本地预检（`checkDocumentMemberCoverage`，只报本地能确定的三类，读到读不懂的登录名时整块不报缺口）；`DOCUMENT_IMPORT_TEMPLATE` 说明行同步、生成物无漂移，模板版本仍为 1，无新增路由 / 迁移 / 依赖 / 权限变化（仍 110 条路由 / 39 个迁移）。本地实测：真实 PostgreSQL `document-import.integration.test.ts` 6 例、`document-import-assist.integration.test.ts` 9 例，`pnpm test:unit` 通过（web 105 文件 815 例、api 78 文件 499 例、contract 16 文件 102 例、ops 9 文件 60 例、database 15 例、canonical-json 5 例），E2E 两个 spec 11 例（30.0 秒），`node scripts/test-integration-local.mjs --skip-migrate` exit 0（database 27 例 / ops 7 例 / api 58 文件 560 例）。整链 `pnpm check` exit 0（117 个 Markdown；`deps:audit` 仅 1 个 moderate，不阻断）。同批补齐 `database/test/integration/database.test.ts` 里缺 `0040_ai_assist_settings.sql` 的「迁移不可变清单」（ADR-068 遗留漂移，与本 ADR 无关），并修正 `技术设计v1.2.2.md` / `docs/test-matrix.md` 各一行历史写入残留的字面 `\n`。「未运行」：全量 Browser E2E、生产镜像构建与 Trivy 镜像扫描、GitHub Actions（`test` 分支不触发工作流）。

- 阶段 0 文档导入工作台的助手去重（第一百七十二条，2026-10-14）：用户问「这句话为什么一直重复？」——每次发言时立刻推的那条本地确定性缺口结论（`buildAssistReply`）在缺口没变时逐字相同，连着几轮看起来就是复读。改为按缺口签名去重（`document-import/DocumentImportModal.tsx` 的 `announcedGapReplyRef` + `announceGapsOnce`，与 ADR-071 落地汇报的 `announcedImportRef` 同一思路）：同一缺口状态只念一次、缺口一变立刻再报、弹窗重开复位；本轮改了什么仍由 `describeDraftChange` 的落地汇报说清。本地实测：`document-import` 4 文件 89 例、Web 全量 105 文件 816 例、E2E 两个 spec 11 例（31.4 秒）通过。同批纠正上一批写错的例数（ADR-072 / 技术设计 / 测试矩阵里的「4 文件 82 例」应为 88 例）。整链 `pnpm check` 除 `deps:audit` 外一次跑通（`deps:audit` 首次因 npm registry 连接被重置失败、单独重试通过，1 个 moderate 无 high，不阻断；`check:secrets` 1242 文件与 `check:docs` 117 个 Markdown 随后单独跑通过）。「未运行」：全量 Browser E2E、生产镜像构建与 Trivy 镜像扫描、GitHub Actions（`test` 分支不触发工作流）。

- 阶段 0 文档导入（ADR-071）成员字段的账号搜索建议已本地落库（2026-10-14）：用户「和成员相关的可不可以做到简单的搜索，比如我打名字的其中一个字然后会筛选出来和这个字有关的名字账号做成 p2 这样+」——成员字段（`负责人` / `初始成员` / `成员`）的编辑态包一层 Popover，按姓名子串筛既有 `GET /api/v1/users` 目录（前缀命中排前、同长度保持目录顺序、最多 8 条），点一条只替换正在输入的那一段；已写定、或与正在输入一字不差的名字不再建议，当前段为空时给整份目录；名单以已知成员的名字结尾时末尾接着打字会自动补顿号（`continueMemberList`，否则「林雨、陈昊」后面打「小」会拼成筛不出人的「陈昊小」）。弹层样式在 `design-system.css`（照 `calm-date-picker.css` 还原被适配层压成 1×1 的 `.ant-popover-container`，z-index 显式抬到 1080 以压过 z-index 1000 的弹窗）；目录里没有登录名，所以只按姓名筛，写登录名仍手打。无新增路由 / 迁移 / 依赖 / 权限变化（仍 110 条路由 / 39 个迁移 / 模板版本 1）。本地实测：`document-import` 4 文件 103 例、Web 全量 105 文件 830 例、E2E 两个 spec 12 例（32.7 秒），整链 `pnpm check` exit 0（117 个 Markdown；`deps:audit` 仅 1 个 moderate，不阻断）。「未运行」：全量 Browser E2E、生产镜像构建与 Trivy 镜像扫描、GitHub Actions（`test` 分支不触发工作流）。
- 阶段 0 文档导入（ADR-071）成员字段改成标签化编辑已本地落库（2026-10-14，第一百七十四条）：用户「这个下拉框要在选中的时候一直存在，方便添加下一个人还有输入法也有问题，第二个人名字打不出来中文字也不好搜索，一个名字选中后形成一个单独小标签吧，分割开」——成员字段（`负责人` / `初始成员` / `成员`）的编辑态由第一百七十三条的「单行文本 + `continueMemberList` 末尾自动补顿号」改为「标签行 + 窄输入框」：进入编辑按半角逗号 / 全角逗号 / 顿号拆成独立标签（各带 × 可摘掉），末尾输入框只装「正在输入的那一段」；点候选 = 加一个标签 + 清空输入框，**候选列表在编辑期间恒开**、点完不收起（空输入时给整份目录减去已成标签的人），提交时用顿号拼回一个值（`memberTagsFromValue` / `serializeMemberTags`，同名只留一遍）。`continueMemberList` 与 `insertDocumentMemberToken` 删除（会改写正在输入的中文、打断输入法组合，正是「第二个人打不出中文」的根因），`suggestDirectoryMembers` 改为 `(directory, typedToken, settledNames)`；键盘改用共用 `draftEditorKeyDown`，`event.nativeEvent.isComposing` 为真时回车 / Esc 不提交也不退出编辑。本地实测：`document-import` 4 文件 102 例、Web 全量 105 文件 829 例、E2E 两个 spec 12 例（35.1 秒）、整链 `pnpm check` exit 0；浏览器实测（真实 dev 栈 + 演示库）逐步核对标签与常驻候选。已知偏差：改中间的名字要先摘标签、候选列表在编辑期间一直挡在下面、目录没有登录名所以仍只按姓名筛、全量 Browser E2E 未跑。

- 阶段 0 文档导入「创建者默认算初始成员 + 草稿锁定标签」已本地落库（ADR-073，第一百七十五条，2026-10-14）：用户「创建者名字不能直接写入固定吗？」——`document-import.workflow.ts` 的 `NEW_PROJECT` 分支不再排除创建者（`UserReadPort` 在同一个事务里取姓名，创建者排在成员第一位），整条 `MEMBER_CREATOR_MISSING` 报错删除，`memberIds` / `members` / `memberAddCount` 口径统一为含创建者；AI 提示词的 `creatorName` 参数退场，契约模板说明行 / 工作台「必填要素」/ 右栏追问三处同口径（模板常量改动已跑 `pnpm contract:generate`，`contract:drift` 无漂移，模板版本仍 1）。前端 `DocumentImportModal.tsx` 只在整项目导入时，在项目段「初始成员 / 成员」字段行上渲染一枚 `.import-draft-tag.is-locked` 锁定标签（创建者姓名 + `InpulseIcon name="lock"`，无删除按钮，`data-testid="document-import-creator-lock"`）：**纯显示、不改 `documentText`**——写进正文会让粘贴路径的「预览文档」跟着变（`assistSourceText` 为空时该文本区直接绑 `documentText`），破坏 ADR-071「预览文档只对照原版」的语义，成员行落库仍由服务端负责。同批把必填 / 可选的入口配色分开：`.import-draft-addbtn.is-required` 由暖黄虚线改为淡红实线加粗（可选仍是暖黄虚线），并给了 4 套对照页待用户定案，**配色尚未定案**。本地实测：`document-import` 4 文件 107 例、`pnpm test:web` 105 文件 834 例、`pnpm typecheck` 8 workspace、`pnpm lint` 通过；服务端一侧 `document-import.integration.test.ts` 6 例、`document-import-assist.integration.test.ts` 9 例（真实 PostgreSQL）、两个 E2E spec 12 例通过，整链 `pnpm check` 在本批改动前 exit 0。「未运行」：全量 Browser E2E、生产镜像构建与 Trivy 扫描、GitHub Actions（`test` 分支不触发工作流）。ADR-073 §5 明确列出**已拍板但尚未实现**的四项（负责人不在成员里的就地软提示、按负责人汇聚写回草稿、删成员后就地提示、成员字段只认登录名 + `loginName` 进 `GET /api/v1/users`），不得当成已实现能力。

- 阶段 0 文档导入助手回执去噪已本地落库（第一百七十六条，2026-10-14）：用户「这个可选择性的补充重复次数太多了，不要每一次我和 ai 讲话就提醒我一下那些可以选择增加」——`DocumentImportModal.tsx` 的 `buildAssistReply` 只点名**必填**缺口（必填齐了就说「我重新核对了一遍：必填都齐了。」），建议补齐清单交给顶部常驻结论（`buildAssistGapReport`，随草稿实时更新）与右栏标签；`announceGapsOnce` 的去重指纹由全量 `gapSignature` 换成只看 ERROR 的 `requiredGapSignature`，只动建议项时不再开口。同批修显示重复：新增 `memberValueHasCreator(value, name, loginName)`，名单里已经写了创建者（姓名或登录名，用 `document-assignee-match` 的 `normalizeName`（私有改导出）规整后比对）就不再挂锁定标签，删掉后标签会自己回来。本地实测：`document-import` 4 文件 110 例、`pnpm test:web` 105 文件 837 例、`pnpm typecheck` 8 workspace、`pnpm lint` 与整链 `pnpm check` exit 0；浏览器实测连发两句补充只回执「必填都齐了」与落地汇报。E2E 按新口径复跑：`node scripts/test-e2e-local.mjs --skip-migrate tests/document-import.spec.ts tests/document-import-ai.spec.ts` **12 例通过（34.6 秒）**——旧断言「回执含截止时间 ×1 / 任务描述 ×1」改成「含『必填都齐了』、不含『建议补齐』/『截止时间』」，并追加第二句去重断言。「未运行」：全量 Browser E2E、生产镜像构建与 Trivy 扫描、GitHub Actions。注意本地 dev 里正在运行的 API 进程仍是启动时那份 `dist`（提示词要重启进程才换），本批已 `pnpm build` 重建 `dist` 并用重建产物跑通 E2E。

- 阶段 0 文档导入整项目 AI 草稿必须写出创建者已本地落库（第一百七十七条，2026-10-14，修订 ADR-073）：用户「可以初始成员里模型把创建者（林雨妍）也写了，因为她同时是任务负责人；UI 没有重复挂锁定标签。提示词可以说得更准：『创建者不是任何任务负责人』时也要写。」——`ai-assist.prompt.ts` 重新接入可选 `creatorName`（`buildAiAssistMessages` / `buildSystemPrompt` / `modeRules`，并新增 `creatorRule`）：整项目导入时创建者必须写进「- 初始成员：」，**与 TA 是不是任务负责人无关**；姓名由 `document-import-http.service.ts` 的 `resolveCreatorName`（短只读事务 `users.listByIds`）从当前 Session 读出后注入 system message，读不到姓名时只要求「不要编造姓名」（不写日志、不落库）。服务端兜底（文档写不写创建者都放行、都会落库，ADR-073 §2.1）不变；ADR-073 §2.2 的旧口径由新增的 §6 取代。三处用户可见文案同口径（契约模板说明行、工作台「必填要素」、`MEMBER_REQUIRED`）均为「须包含创建者本人与全部任务负责人」；生成物已按 `pnpm contract:generate` 更新，`contract:drift` 无漂移，模板版本仍 1；无新增路由 / 迁移 / 依赖 / 权限变化（仍 110 条路由 / 39 个迁移 / 模板版本 1）。本地实测：`ai-assist.client.test.ts` 12 例、`document-import` 4 文件 110 例、真实 PostgreSQL 集成（apps/api 58 文件 560 例、database 27 例、apps/ops 7 例）、`pnpm build` 后两个文档导入 spec 12 例（34.9 秒）通过，整链 `pnpm check` exit 0（821 个源文件 / 110 条路由 / 1243 文件 Secret 扫描 / 118 个 Markdown）。同批修四处上一批缺陷：E2E 用例解构成空对象导致 `browser` 未定义、集成夹具 `sessionActor` 漏 `login_name AS "loginName"` 别名、`ai-assist.client.test.ts` 主用例没传 `creatorName`、契约里 `members` / `memberAddCount` 注释仍写「不含创建者」。真实上游实机复测（dev 栈 + 演示库，只读核对、未导入任何数据）：把「创建者不是任何任务负责人、文档里也完全没提到她」的需求稿粘进「从文档导入整项目」→「交给 AI 整理」（约 40 秒出稿）→ 草稿「- 初始成员：」第一位就是「林雨妍」（5 模块 / 8 功能 / 9 任务，结论只报 2 条建议、不提成员缺口）→ 预览（只读）得「AIDEMO2 · 编码可用 · 成员：林雨妍、小邵、小潘、小吴、邵晨宇」、issues 为 0 → 关闭预览 + 取消，未落库。「未运行」：全量 Browser E2E、生产镜像构建与 Trivy 扫描、GitHub Actions（`test` 分支不触发工作流）。

- 阶段 0 文档导入「必填 / 可选」入口配色已定案（第一百七十八条，2026-10-14）：用户看过 4 套对照页（`.data/annotations/required-chip-colors.html`，静态站 `http://127.0.0.1:5599/`，B/C/D 只留作本机参考）后回「现在这个状态挺好的」——**定案方案 A = 当前线上**：必填 `.import-draft-addbtn.is-required` 保持淡红实线加粗（`#e8a9a3` / `#fdecea` / `#b03a2e`）、可选保持暖黄虚线（`#e3c98a` / `#fffaf0` / `#8a6512`）。本批无任何代码改动，只把「配色未定案」的记录改成已定案；单测只断言 `is-required` 这个 class、不断言颜色，因此换色不需要动测试。此前对照页「打不开」已澄清为入口写错：模拟稿在 5599 的 `.data/annotations` 静态站，不是 5173 的 Vite（未知路径落 SPA 兜底，看着就是空白页）。

- 阶段 0 「跳转 / 弹窗缓冲」复查与补齐已本地落库（第一百七十九条，2026-10-14）：用户「检查一下所有操作跳转或者弹窗都有做缓冲吗？」→ 按 2026-10-10 的口径逐类复查（路由内容 `.page-content > *` 180ms 淡入、骨架 140ms 延迟闪现、`AppModal` 遮罩 160ms + 面板 `@starting-style`、侧栏 `.popover` 140ms、命令面板 `.overlay`/`.palette` 160ms、`CalmSelect` 的 `animated`、懒加载弹层把 `Suspense` 提到弹层外、`route-preload` 的 chunk 预取），补齐三类缺口：① `RecordSummaryModal.tsx` 的「总结项目」「总结成员」两个 `CalmSelect` 漏传 `animated`（全局 `token.motion: false` 下不传就是硬蹦；其余 43 处都已传）；② `CalmDateTimeInput` 的日期面板（`calm-date-picker.css`）与 `DocumentImportModal` 的成员候选（`design-system.css`）这两个 antd `Popover` 完全没有出现动画，各加 150ms 纯 opacity 淡入（`animation-name` 用 `!important` 接管，**只动 opacity、不动 transform**，否则 rc-align 会在缩放尺寸上完成首帧测量而错位；`destroyOnHidden` / 编辑态挂载保证每次打开都重播；`prefers-reduced-motion` 下关闭）；③ 预取实现从 `app/router/route-preload.ts` 移到 `shared/routing/route-preload.ts`（pages / features 层的跳转入口也要用，分层规则禁止它们反向依赖 app；`import.meta.glob` 的相对路径 `../../pages/**` 在两处同深度、指向同一批文件，无需改动），旧路径保留同名 re-export，并给项目卡片、卡片「管理成员」、创建成功横幅 4 个按钮、通知气泡与通知页条目、搜索结果链接、命令面板每个命令（新增 `path`，光标一动就预热）接上 `routePreloadHandlers` / `preloadRoutePath`。本地实测：`pnpm typecheck` 8 workspace、`pnpm --filter @inpulse/web test:unit` 105 文件 837 例、`check:frontend:boundaries` 0 违规（345 模块 / 1713 依赖）全绿；dev 5173 实测 `div.ant-popover.calm-date-popover` 的 computed style 为 `calm-date-popover-in / 0.15s / ease-out / fill: both`；一次性 E2E 探针（跑完即删、未入库）证明悬停项目卡片会把 `ModulesPage` chunk 从 0 次拉到 1 次；E2E 定向 6 个 spec **21 例通过（1.1 分钟）**；整链 `pnpm check` 除 `deps:audit` 外全部通过，`deps:audit` 因 `registry.npmjs.org` ECONNRESET / `fetch failed` 未完成（单独重试同样失败，本机网络问题、与改动无关），`check:secrets` 与 `check:docs` 随后单独跑通过。「未运行」：全量 Browser E2E（31 个 spec 里只跑 6 个）、生产镜像构建与 Trivy 扫描、GitHub Actions（`test` 分支不触发工作流）。仍未接预取的入口：任务中心 → 任务详情弹窗（`TaskDetailOverlay` 为 lazy，靠 `Suspense fallback={null}` 不闪空壳、只慢一拍）、弹窗内深链（`?taskId=`）与页面内按钮；弹窗**关闭**仍是瞬时（本批只补「出现」）。

- 2026-10-14 合并 `origin/test` 后的仓库状态（一次性对齐）：远端企业微信三批（ADR-069 绑定 / ADR-070 凭据在线配置 / 迁移 `0043` 机器人链接 / 审计页中文标签）与本地的文档导入工作台、整项目成员规则、AI 辅助管理员配置、跳转与弹层缓冲合并到同一 `test` 分支。合并后当前总量为 **115 条路由**（`pnpm contract:validate` 115 条、`pnpm permissions:check` 115 条操作 / 115 条路由）与 **42 个迁移**（`pnpm db:migrations:check`，含 `0041`–`0043`）；本地三条文档导入 ADR 因与远端撞号顺延为 [ADR-071](./docs/adr/ADR-071.md)（工作台）/ [ADR-072](./docs/adr/ADR-072.md)（项目成员名单必填）/ [ADR-073](./docs/adr/ADR-073.md)（创建者默认算成员），仓库内引用同批更新；开发日志条号按既有合并先例把较新一侧（本地第一百三十八至一百七十四条）整体上移为第一百四十三至一百七十九条，远端 5 条保留第一百三十八至一百四十二条。此前各条 AGENTS 记录与本文件里写的「110 条路由 / 39 个迁移」是各自当时的数字，按不改历史条目的惯例保留；未运行的门禁仍按各条自述（生产镜像构建、Trivy、GitHub Actions 等）。

- 阶段 0 「生成总结」内嵌 AI 改写已本地落库（[ADR-076](./docs/adr/ADR-076.md)，2026-10-14，第一百九十条）：`/records` 的「生成总结」弹窗按用户选定做法落地为**非对话式**——标题栏右上角「✦ AI 助手」按钮 + 按需拉出的浮层（`AppModal` 新增 `headerActions` 插槽），一句话要求（500 字上限、`Ctrl` / `⌘ + Enter` 生成）+ 5 个快捷词，生成成功后浮层收起、正文按标题 / 段落 / 列表切成可编辑单元（改过的段落橙点、悬停「回退这句」、底栏「已手动改 N 处」+「撤销手动修改」，复制 / 导出取编辑后文本）。服务端新增 `assistRecordSummary`（`POST /api/v1/record-summaries/assist`，路由 **115 → 116**）：事实由前端当前范围的确定性正文给出（`summaryDocumentToText`），服务端只做一次出站改写、**不查库 / 不写库 / 不写审计 / 不开事务 / 不解自然语言筛选意图**，未启用 503 `AI_ASSIST_DISABLED`、上游失败 503 `AI_ASSIST_UPSTREAM_FAILED`（`details.reason` 为固定枚举）；复用 [ADR-067](./docs/adr/ADR-067.md) / [ADR-068](./docs/adr/ADR-068.md) 的运行时配置与 `/run/secrets/*` 密钥通道（`AI_ASSIST_ENABLED` 仍是急停），走 ADR-019 纯校验 allowlist（csrf / idempotency none）；无迁移（仍 42 个）、无新依赖、无权限变化、无契约模板改动。门禁：`contract:generate` / `contract:drift` / `contract:validate` 116 条 / `permissions:check` 116 条操作 116 条路由 / `lint` / `format:check` / `typecheck`（8 workspace）/ `test:unit`（web 108 文件 865 例、api 79 文件 508 例、contract 102 例、ops 60 例、database 15 例、canonical-json 5 例）/ `test:web` / `test:integration`（api 61 文件 594 例、database 27 例、ops 7 例）/ `db:migrations:check` 42 个 / `check:deploy:test` / `check:deps` 848 个源文件 / `check:frontend:boundaries` 0 违规 / `deps:audit` / `check:secrets` 1280 个文件 / `check:docs` 121 个 Markdown 全绿（`pnpm check` **exit 0**）；dev 栈 + 演示库实机跑通真实上游（约 33 秒出稿、79 段可编辑、编辑与回退生效，只读核对未导入数据）。「未运行」：全量 Playwright（本批未新增 E2E 用例）、生产镜像构建与 Trivy 扫描、GitHub Actions（`test` 分支不触发工作流）。**该功能已于 2026-10-15 随开发日志第一百九十一条同一提交本地落库（`test` 分支），随合并提交 `fe74e36` 推送到 `origin/test`；同日第一百九十一条修复拖选误关弹窗。**

- 「生成总结」底栏按钮层级已本地落库（第一百九十二条，2026-10-15）：用户先提「这个按钮排序和颜色我需要进行更改，复制正文按钮永远要在最右侧」，首版把「撤销手动修改」做成 antd `danger` 红按钮排进底栏第四位，用户看到后否掉（「还是丑，这个撤销键很必要吗」）。最终定案：**底栏右侧固定三枚按钮「查看明细 → 重新生成 → 复制正文」，「复制正文」永远是最后一个**（代码里加注释钉住，新增动作一律排它左侧）；「撤销手动修改」**不占底栏按钮位、不用警示色**，降级成左侧状态行「已归纳 N 条迭代记录」末尾的浅色链接（`type="link" size="small"`，`padding: 0`，hover 下划线），只在有手动改动时出现。第三轮：用户指出「现在状态是手动更改的部分本来就会显示出来」，于是删掉状态行里重复的「已手动改 N 处」计数文案——改过的段已由橙点（`data-edited="true"`）标出，编辑态改由「橙点 + 撤销入口的有无」表示。功能本身保留：它是唯一能零成本、不重跑上游就回到模型原文的出口（「重新生成」会重新请求 AI 且正文可能变）。行为零变化（文案、`disabled` / `loading`、明细态「复制明细 Markdown」、复制反馈原样），无路由 / 契约 / 迁移 / 依赖 / 权限变化（仍 116 条 / 42 个）。门禁：`RecordSummaryModal.test.tsx` 15 例通过（改写 `RECORD-SUMMARY-FOOTER-001`：未编辑时 `.calm-action-footer > button` 逐字等于「查看明细 / 重新生成 / 复制正文」且无「撤销手动修改」；改一句后它出现、`closest(".summary-footer-count")` 命中、class 不含 `ant-btn-dangerous`、底栏直接子级按钮仍是那三枚且最后一个仍是「复制正文」；计数文案删除后，编辑态改断言段落橙点——两段改动 → 两段 `data-edited="true"`，单句回退 → 该段转 `false` 而第二段仍 `true`、入口仍在，全量撤销 → 入口消失）、`pnpm test:web` 109 文件 874 例、`pnpm check` **exit 0**。「未运行」：全量 Playwright（本批纯样式与层级，dev 栈人工核对）、生产镜像构建与 Trivy、GitHub Actions（`test` 分支不触发）。**该条已本地提交（`test` 分支），随合并提交 `fe74e36` 推送到 `origin/test`；同分支 `ad5de24`（ADR-076 主体）、`4ff364c`（合并 origin/test）随该次推送一并上传。**

- 「AI 辅助转换」设置面板布局优化已本地落库（第一百九十三条，2026-10-15，用户「这个界面的 ui 优化」+「这个删掉」）：`/settings → AI 辅助转换` 原用 `.form-row`（`grid-template-columns: 1fr 1fr`）排字段，导致标签与控件相距半屏、字段级 `.form-hint` / 错误行落进左列与输入框错位、底部操作按钮与表单不对齐、表单正文没有内边距，且 antd `Switch` 作为网格子项被 `stretch` 拉伸成整行蓝色胶囊。改为与 ADR-070 企业微信面板同一口径的单列堆叠：新增 `.ai-assist-body`（`padding: 16px 20px 20px`）/ `.ai-assist-form`（`gap: 18px`）/ `.ai-assist-field`（标签在上、控件全宽、提示紧随）/ `.ai-assist-field-pair`（两个数值字段并排，`≤700px` 回落单列）/ `.ai-assist-actions`；`Switch` 先移进 flex 行（`.ai-assist-switch-row`）以免被网格拉伸并补 `id` + `htmlFor`，随后按用户「这个按钮直接放到整个第一行右侧吧」再上移到面板标题行右端——用 `CalmSectionTitle` 的 `children`（`.calm-section-title` 本就是 `justify-content: space-between`，children 即第二个 flex 子级），新增 `.ai-assist-master` 承载该组并删掉 `.ai-assist-switch-row`；随后按「去掉」「这个也去掉啊」两条反馈把该组里的说明行与可见「启用」标签一并删除，标题行右端只留一个开关（可访问名用 `aria-label="启用 AI 辅助转换"` 保留，避免无名控件）；实测开关右边缘距卡片右边 20px、与标题带内缩一致；状态条从一句话拆为「当前状态 + 徽章」与三项元信息（`·` 分隔），启用态复用 `.note-success`；加载态与错误态同样套 `.ai-assist-body`，错误态重试按钮由 `Space` 换成 `.ai-assist-actions`。另按用户要求删除标题带副标题「成员在文档导入弹窗中用 AI 把自由文档转换为固定模板草稿」（`CalmSectionTitle` 的 `hint`，三个分支共 3 处，该 prop 本就可选）。**前七轮未改任何字段、校验规则、错误文案与请求行为**；末轮按用户「这个关闭就直接显示关闭吧，不用再点击保存了」把主开关改成**拨动即保存**——仍走既有 `PUT /api/v1/admin/ai-assist` 的整体替换语义，请求体以服务端已保存的 `endpoint / model / timeoutMs / maxTokens` 为基准、`apiKey` 传 `null`（表单里未保存的编辑不会被顺手提交），成功后用 PUT 响应直接写 React Query 缓存使状态卡与开关同帧一致，失败则回落到已保存状态，无数据库行（密钥未配置）时开关只改本地草稿并提示先补密钥；无契约 / 迁移 / 依赖 / 权限变化（仍 116 条 / 42 个）。门禁：`src/features/settings` + `src/features/users` **8 文件 47 例**（含 `AiAssistSettingsPanel.test.tsx` 6 → **10 例**：原 6 例在状态条拆 DOM 与开关改造后仍绿，新增 4 例覆盖拨动即保存 / 失败回退 / 首次配置拦截）、`eslint` 该文件无告警、`pnpm test:web` **109 文件 878 例**、整链 `pnpm check` **exit 0**（含 123 个 Markdown 文档门禁）。定向 Playwright `apps/e2e/tests/settings-ai-assist.spec.ts` **3 例通过（17.2 秒）**（新增用例：不点保存直接拨开关 → 刷新后仍为关闭 → 再拨回启用）。全量 Playwright `pnpm test:e2e` **86 例通过（6.7 分钟）**；「未运行」：生产镜像构建与 Trivy、GitHub Actions（`test` 分支不触发工作流）。**本条已本地提交（`test` 分支），随合并提交 `fe74e36` 推送到 `origin/test`（合并远端 `6474e20` / `d7407c7` / `6f23ab4`）：远端 `6f23ab4` 的并行早期布局版以本条目实现为准、删掉失去引用的 `.ai-assist-field--switch`；远端 ADR-075（SSO 首管理员）保留原号，本功能的记录总结 ADR 顺延为 ADR-076；日志条号错开（远端占第一百八十二至一百八十九条，本批四条为第一百九十至一百九十三条）；一并上传此前未推送的 `ad5de24` / `4ff364c` / `0f785bb`。**合并后复跑：整链 `pnpm check` **exit 0**（docs **124** 个 Markdown、Secret 1287 个文件）；`pnpm test:integration:local` 下 database 27 例、apps/ops 7 例通过，apps/api 62 文件 597 例中 1 例为既有偶发的 `search-api.integration.test.ts` 单字查询（与本批无关）；`pnpm test:e2e:local` **86 例通过（7.2 分钟）**。本地 `app_ci` 里的悬空夹具行（10 行 `user_wecom_bindings` + 20 行 `wecom_binding_codes`）已清理——它们是既有夹具缺口（清理时用 replica 角色跳过外键但未删这两张表），会让 apps/ops 备份 / 恢复演练报 FK 违反，留待单独跟进，详见开发日志第一百九十三条风险 ⑦。

- 「成员与角色」页本地成员搜索已本地落库（第二百零八条，2026-10-16）：用户「这里需要加一个成员搜索栏」（附「成员与角色」页截图）——在 `AdminUsersPageView` 成员面板标题行右侧（`CalmSectionTitle` 的 `children`，即 `.calm-section-title` 本就是 `justify-content: space-between` 的第二个 flex 子级）加本地搜索框，复用 `.task-search` + `InpulseIcon name="search"` + 原生 input（`aria-label="搜索成员"`、占位「搜索姓名、登录名或邮箱」）；按姓名、登录名或邮箱子串过滤（`toLocaleLowerCase` 大小写不敏感、trim 空串显示全部），列表渲染改用 `visibleMembers`；标题 hint 仍显示成员总数、不随搜索跳动（沿用项目列表页口径）；搜索无结果给「没有匹配的成员」空态 + 「清空搜索」按钮；无数据（加载中 / 空库 / 错误）不渲染搜索框；窄屏（≤700px）在既有媒体查询给 `.settings-panel .calm-section-title` 加 `flex-wrap: wrap; row-gap: 10px;`，搜索框整行换行不挤压标题。纯前端本地过滤，无请求 / 路由 / 契约 / 迁移 / 依赖 / 权限变化。门禁：`AdminUsersPageView.test.tsx` **10 例通过**（新增 1 例：姓名「孟杰」/ 登录名「wmj」/ 邮箱大小写 / 无匹配空态 + 清空恢复）、`pnpm test:web` **112 文件 908 例**、`pnpm --filter @inpulse/web typecheck`、Prettier 与 `eslint`（改动文件）通过。「未运行」：Playwright E2E、`pnpm check` 整链、生产镜像构建与 Trivy、GitHub Actions（`test` 分支不触发工作流）。

- 合并远端 `test` 与「成员与角色」页成员搜索栏一并推送（第二百零八、二百零九条，2026-10-16）：远端 `b176e5d`（含 `9281251`：E2E 夹具清理补齐 4 张 RESTRICT 引用表 + 接入网站图标 favicon）已占用日志第一百九十六、一百九十七、第二百零五至二百零七条，本地成员搜索条目因此由第二百零五条顺延为**第二百零八条**（`开发日志.md` 与本节同步改号）；冲突仅 `开发日志.md` 顶部新增条目，取并集（远端条目在前）。合并后复跑 `AdminUsersPageView.test.tsx` 10 例、`pnpm --filter @inpulse/web typecheck`、改动文件 Prettier/`eslint`、`node scripts/check_docs.mjs` 通过；「未运行」：`pnpm check` 整链、Playwright E2E、集成测试、生产镜像构建与 Trivy、GitHub Actions（`test` 分支不触发工作流）。

## 2026-10-15 ADR-075 空库首个 SSO 账号自动成为系统管理员说明

按用户要求，空库首次部署时第一个完成单点登录（JIT 开通）的账号自动成为系统管理员（[ADR-075](./docs/adr/ADR-075.md)，修订 ADR-032 决策 5 的「JIT 一律 `is_admin=false`」）。因此：

- 判定以 `app.users` 是否有行为准：任何一行（含停用账号）存在即不授予；判定与 INSERT 在同一事务内用固定键 `pg_advisory_xact_lock` 串行化，并发首登只有先提交的事务成为管理员。
- 已绑定映射（`sso_subject` 命中、登录名绑定）路径不受影响；Casdoor 的任何 claim 仍不得影响 InPulse 权限。
- 审计 `auth.sso_account_provisioned` payload 增加 `grantedAdmin: true|false`；离线预置管理员仍可行，且预置后 SSO 不再授予。
- 无新增路由、数据库迁移、依赖与权限矩阵结构变化；测试见 `apps/api/test/sso-first-admin.integration.test.ts`（临时库全量迁移 + 桩 IdP）。
- 开发日志等历史记录中更早批次的「JIT 开通一律 `is_admin=false`」为各自当时的事实；与 ADR-075 冲突时以 ADR-075 与本节的现行规则为准。

## 2026-10-15 本地先行、测试 VM 跟随（同步纪律）

用户要求：**一切改动先在本地工作区完成并通过门禁，再同步到测试 VM；不允许在 VM 上直接改代码、脚本或配置**。约定如下：

- 应用与部署编排（镜像、`deploy/compose.yaml`、`.env.deploy`）：本地改完后跑 `deploy/test-vm/update.ps1` 同步；细则见 `deploy/test-vm/README.md`。
- 测试 VM 企业微信桥接：唯一源是 `deploy/test-vm/wecom-bridge/`（本批已从 VM 侧归档进仓库），用 `deploy/test-vm/update-bridge.ps1` 同步：上传 → 远端 sha256 校验 → 备份源码 → 远端构建镜像 → 按固定安全参数重建容器并等「订阅成功」；同内容同 Tag（`0.1.0-<日期>-bridge<内容哈希前 7 位>`）。`-SkipRestart` 只更新镜像；`-RollbackTo <旧 Tag>` 用历史镜像重建容器回滚。
- 数据同步走 `deploy/test-vm/README.md` 的 pg_dump/pg_restore 手册流程，不引入双向或定时同步。
- VM 侧只在排障时允许临时热修；热修后必须立即把改动回灌本地（以本地为唯一源重建），并在开发日志写明，不得把 VM 临时状态当作正式状态。
- 2026-10-15 核对事实：桥接源码在本地 staging 与 VM `/home/libiao/inpulse-deploy/wecom-bridge/` 两侧哈希一致；此前「不同步」的根源是源码未进仓库、更新靠手工复制。本批归档 15 个文件（`README.md` 只在仓库、不上传 VM；`node_modules` 不入库）并新增同步脚本。

## 2026-10-16 登录页直达单点登录说明

用户要求「以后只用单点登录，登录页面呈现的直接就是单点登录的登录页」，经 [ADR-080](./docs/adr/ADR-080.md) 修订 ADR-036：`/login`（含 `?from=`）在匿名态立即整页跳转 `/api/v1/auth/sso/start`（跳转期间展示品牌加载态），不再默认渲染本地口令表单；`?local=1`（管理员应急）与服务端 fail closed 回落的 `?sso=disabled` 分支渲染本地口令表单且都不自动跳转；`?sso_error=` 只显示错误与手动「重新登录」，不自动重跳。退出登录与「前往登录」仍回 `/login`，随后自动进入统一身份认证（IdP 会话有效时无感重登属预期）。本地口令登录路由、`PasswordService`、`securityFlow` 五条 allowlist 与两条 302-only 路由均保留不变；ADR-036 及本文件上文历史条目中「默认展示本地口令表单」为当时事实，与本节冲突时以 ADR-080 与本节的现行规则为准。

## 2026-10-16 组织（部门）成员管理说明

用户要求「管理员在成员设置可通过建立组织或部门把成员分开，成员能看同一组织的其他成员，指派成员时可选整个组织或组织内选人」「拉取成员进入组织必须支持批量」「不要默认显示勾选框，点按钮进入选择模式才有」「相同部门的成员要放一块」。经 [ADR-081](./docs/adr/ADR-081.md)（Accepted，2026-10-16）落库：新增迁移 `0046`（`app.organizations` + `app.users.organization_id`，一名成员至多归属一个组织、可未分配）与 6 条路由（`listOrganizations` / `createOrganization` / `updateOrganization` / `deleteOrganization` / `assignUsersOrganization` / `getMyOrganizationMembers`），路由总数 119 → 125（`permissions:check` 125 条操作 / 125 条路由，2026-10-16 实测）。「成员与设置」页对全体登录用户开放：系统管理员可建立组织（部门）、改名、删除（成员回到未分配）与在成员列表批量归属（默认保持纯浏览、不显示勾选框，点「批量管理」才进入选择模式，含全选当前搜索结果与加入 / 移出组织），成员列表按组织分组显示（当前账号所在组织置顶、其余按组织 id 升序、未分配最后）；普通成员只读查看同组织成员（脱敏：不含登录名、邮箱与停用状态），未分配给出提示（2026-10-16 修正：首批声明入口对全体开放但 `/settings` 路由仍带 `requiresAdmin`，已改为登录守卫，普通成员不再被「无权访问」拦截）。指派选择器的「一键选中整个组织」：2026-10-16 第二批（部分）已落地于新建项目「初始项目成员」选择器——`getUserDirectory` 增加只读 `organizationId` / `organizationName`（未分配为 `null`），下拉按组织分组并有整组全选 / 取消按钮（仍受 1～20 人与项目成员约束）；任务创建 / 改派选择器的同类能力仍为后续批次。2026-10-16 第三轮修订（用户三条指示）：管理员「成员与角色」取消「批量管理」入口，工具条只保留「组织管理」；组织管理由弹窗改为在该页内就地展开（同一按钮切换「组织管理 / 收起组织管理」，收起时清空勾选），且不再复制成员清单——勾选框直接出现在既有成员列表行上（仅展开时可见），工具条随之提供「全选当前结果 / 已选 N 人 / 清空选择」；「加入组织」（已有组织或新建组织）与「组织维护」（改名 / 删除 / 成员数与成员一览）作为两段区块置于成员列表下方，「移出组织」并入其中并保留二次确认（结果同为未分配），不提供只建空组织的独立入口。

## 2026-10-19 账号停用现行口径

用户要求「停用的状态是账户隐藏而不是分两个」「隐藏按钮去掉」「停用状态下账号也显示在全部账号里，只是状态停用，列表灰色并放在最后」「企业微信的问题先不用管」。因此账号只有 `ACTIVE` / `DISABLED` 一种生命周期状态，不单独引入「隐藏」状态或企业微信删除标记：

- 「停用账号」即撤销该账号全部 Session、递增 `auth_version`，账号不可登录；用户目录与项目成员候选只返回 `ACTIVE`，停用账号不能再被选为新任务负责人或导入成员；历史任务、迭代记录、审计与活动引用全部保留，不做物理删除或级联。
- 有未完成任务时，`disableUser` 必须在同一事务内先完成交接：多负责人任务默认摘掉待停用账号并保留其他负责人；唯一负责人任务必须指定一名或多名接手人或标记删除，否则 422，账号保持 `ACTIVE` 且不撤销会话。全部任务清理后才停用、撤销 Session 并写审计（[ADR-084](docs/adr/ADR-084.md)）。
- 前端成员列表把停用账号保留在「全部」里，整行灰色、状态显示「停用」，并统一排在列表最后；不提供单独的「停用 / 已隐藏」标签页，行内只保留「编辑」，停用与启用都在编辑弹窗的「账号状态」区。
- `forceLogoutUser` 已按 [ADR-083](docs/adr/ADR-083.md) 整体移除：路由、Controller、Service、Repository、权限矩阵、OpenAPI、生成客户端与前端入口均不存在；管理员撤销目标会话只能通过停用账号完成。历史审计中的 `admin.user.force_logout` 动作码仍保留中文展示标签。


## 2026-10-23 ADR-096 任务、功能与模块物理删除说明

用户于 2026-10-23 明确删除规则，落 [ADR-096](./docs/adr/ADR-096.md)（Accepted），部分替代 [ADR-058](./docs/adr/ADR-058.md) 与 [ADR-059](./docs/adr/ADR-059.md) 的软删除条款。

- **任务**：物理删除任务本体、状态历史、负责人、影响关系、聚合组关系、外部链接关联，以及该任务的全部迭代记录、版本、遗留项和搜索投影；只保留审计、项目动态与顶层 `task.delete`。`app.external_links` 主表保留。
- **功能**：物理删除功能本体、功能下全部任务及其全部记录/版本/遗留项，以及归属于该功能的全部记录和链接关联；所属模块与其他功能保留；只写一条顶层 `feature.delete`。模块级任务若只通过影响关系关联该功能，不删除任务本身，只清理影响关系。
- **模块**：物理删除模块本体、模块下全部功能与任务，以及这些实体的全部记录、版本、遗留项、影响关系、聚合组关系、链接关联和搜索投影；只写一条顶层 `module.delete`。未分类模块继续由接口与数据库触发器双重保护，返回 409 `MODULE_UNCLASSIFIED_PROTECTED`。
- **聚合组**：MAIN 任务允许直接删除；任何包含被删任务的活跃聚合组关闭，未删除的 ACTIVE 成员转 `DETACHED` 并记录解除原因与操作者；组内无剩余成员时删除组行。`detachedGroupId` 在删除成员关系前捕获，修正迁移为 `0060`。
- **留痕**：级联删除不逐条伪造下级删除事件；同事务追加顶层审计与项目动态，并把原实体历史动态可见性更新为 `DELETED`。审计、项目动态与通知行不删除；删除不发新通知，避免死链。
- **数据库**：迁移 `0059_contract_hard_delete_task_feature_module.sql` 新增 `app.hard_delete_business_scope`、`app.hard_delete_task`、`app.hard_delete_feature`、`app.hard_delete_module`；`0060_fix_hard_delete_task_detached_group.sql` 修正聚合组 ID 返回。仅三个入口授予 `app_runtime`，业务表不开放 `DELETE`。
- **契约与前端**：四条删除路由路径不变，幂等契约升至 2.0.0；响应以 `deletedTaskCount` / `deletedFeatureCount` / `deletedRecordCount` / `removedLinkCount` 回述影响面。删除确认文案明确永久删除、不可恢复、只保留审计与项目动态；成功后失效任务、模块、功能、记录、草稿、遗留项、链接、动态、通知、搜索与侧栏计数缓存。
- **不变项**：记录自身的显式作废/恢复生命周期仍按 [ADR-024](./docs/adr/ADR-024.md) 执行；项目删除仍按 [ADR-062](./docs/adr/ADR-062.md) / [ADR-085](./docs/adr/ADR-085.md)，账号删除仍按 [ADR-088](./docs/adr/ADR-088.md)，三者范围不变。
- **死代码清理**：删除工作流不再调用 `TaskRecordVoidPort` / `RecordScopeVoidPort`，两个端口、其实现、模块注册及专用 `listPublishedByTaskId` / `listPublishedByScope` 查询已移除；记录显式生命周期服务保留。
- **验证**：迁移 0059/0060 在真实 PostgreSQL 执行；删除相关 API 单测、真实 PostgreSQL 集成、前端目标与全量测试、契约生成/漂移、权限、格式与文档门禁以本轮实测结果为准；不声称未运行的 CI 或浏览器 E2E 已通过。

## 2026-10-26 ADR-097 SSO 群组组织同步说明

用户要求单点登录时读取 Casdoor 账号群组，自动生成对应组织并把人员分类进去，且组织口径必须与 Casdoor 对齐。经 [ADR-097](./docs/adr/ADR-097.md)（Accepted，2026-10-26）落库：

- **Casdoor 配置**：application 必须使用 `JWT-Custom` Token format，Token fields 至少包含 `Groups`，Token group format 为 `Path`。只有该组合会在 id_token 中提供完整路径形式的 `groups` claim；未使用 `JWT-Custom` 时可能没有该 claim 或只有非完整路径，不能作为生产对齐依据。
- **同步口径**：绑定 `sso_subject` 的账号，组织关系由最近一次成功 SSO 登录的 `groups` 全量对账。缺失 `groups` 时登录成功且不改组织；`groups: []` 清空全部组织关系；非法路径按 `token-invalid` 拒绝登录并回滚整个事务。只同步直接群组，祖先组织只用于建立层级，不会把用户自动加入祖先群组。
- **数据模型**：迁移 `0061_contract_sso_casdoor_organizations.sql` 为 `app.organizations` 增加 `source` / `sso_owner` / `sso_group_path` / `sso_parent_path` / `parent_id`，新增 `app.user_organizations` 多对多关系；本地账号原有的 `users.organization_id` 转为 `MANUAL` 成员关系后删除该列。CASDOOR 组织以完整路径唯一，同名不同路径可并存。
- **只读边界**：CASDOOR 组织只能由 SSO 同步写入；管理员改名、删除、把本地账号加入 CASDOOR 组织或手工调整 SSO 用户组织时返回 409 `ORGANIZATION_SSO_MANAGED`。已消失的 Casdoor 群组只移除成员关系，不按单次 Token 自动删除组织行。
- **权限边界**：`groups`、Casdoor `isAdmin`、roles 与 permissions 均不映射为 InPulse 项目成员、组长或系统管理员权限；组织只用于分类与选择器分组。
- **契约与前端**：`OrganizationItem` 增加 `source` / `groupPath` / `parentId`；用户目录和管理员用户改为 `organizations` 数组，管理员条目增加 `managedBySso`；CASDOOR 组织按末级名称展示，完整路径作为悬停提示并继续作为同步唯一身份；同组织成员接口返回全部所属组织及去重成员，项目成员选择器按全部组织分组并按并集整组选择。路由总数保持 129，`permissions:check` 129 条操作 / 129 条路由通过；组织契约幂等升至 2.0.0，用户创建 / 编辑重放契约升至 1.4.0。
- **迁移基础设施**：`database/bootstrap/000_roles.sql` 将 `app_migrator` 的数据库级 `search_path` 改为 `RESET search_path`，避免 `app` 可见时 `pg_get_triggerdef()` 省略函数 schema 导致历史迁移 `0047` 的部署断言误判；未修改任何历史迁移。
- **本地验证**：SSO 与组织真实 PostgreSQL 集成 `sso-login.integration.test.ts`、`organizations-api.integration.test.ts` 共 23 例通过；空库首管理员 `sso-first-admin.integration.test.ts` 3 例通过；全新库从 `000_roles.sql` / `020_pgroonga.sql` 起应用 60 条迁移全部成功；Web 用户页单测 35 例与 Web 类型检查通过；全量 Playwright 89/89 本地通过（含管理员用户页组织区与状态列对齐）。未连接真实 Casdoor 生产实例，不声称生产联调或 CI 已通过。

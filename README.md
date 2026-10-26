# InPulse

软件研发功能迭代记录与任务协作系统，用于统一管理项目、模块、功能、任务、迭代记录及其历史关系。

> 当前状态：阶段 0 实施中。PostgreSQL 数据库、`0000-0005` 显式迁移（含 PGroonga 索引与旧 `pg_trgm` contract 清理）、角色隔离和真实数据库集成测试基线已落地；阶段 0 CI 最小链路已按[技术设计 §12.4](./技术设计v1.2.2.md#124-ci-门禁)顺序落库（安装、lint、format check、typecheck、单测、空库迁移、真实 PostgreSQL 集成测试、契约漂移与完整性、生产构建、Playwright 浏览器 E2E 基座、Compose/镜像 ref 预检、依赖边界、权限矩阵、依赖/Secret 扫描），CI 用仓库内探针 Dockerfile 基于 digest 固定的 `postgres:18.6` 构建带 PGroonga 的测试库；API 契约生成链路已落库，生成工具决策见 [ADR-027](./docs/adr/ADR-027.md)（`Accepted`，2026-09-07）；PGroonga V1 搜索 PoC 已在 PostgreSQL 18.6 探针镜像上通过语义、Recall@20、边界、跨项目隔离、默认查询计划和逻辑恢复，ADR-025 已记录；SearchQueryService 服务层与生产 `ProjectAccessQueryPort` 适配器、通用 `SessionAuthService` 已落地；`GET /api/v1/search` 契约纵切片已落地 Schema、Route Registry、OpenAPI、生成客户端、最小 Controller、服务端签名游标与真实 `hasMore`，C-006 已由 A 于 2026-09-08 正式确认；认证纵切片已包含 `GET /auth/csrf`、`POST /auth/login`、`POST /auth/logout`、`GET /me`，并已加入登录限流与 Session 统一失效。真实 HTTP API 集成测试已落库并在本机真实 PostgreSQL 上通过，搜索相关 PR #68 GitHub Actions 已通过；搜索页面最小纵切片已通过生成客户端接入真实 `GET /api/v1/search`，支持关键词、分类展示与签名游标分页，搜索边界、F-27/F-28 项目动态与通知状态 Playwright E2E 已本地 16/16（含 F-13 功能档案）；F-27 项目动态与 F-28 站内通知的 API 契约、读写端口和前端页面已落地；F-04 项目创建后端 Workflow 与前端纵切片已落地，并通过真实 E2E 验证创建 → 动态 → 搜索 → 站内通知；创建表单已接入 `GET /api/v1/users` 选择项目成员，公共应用壳、项目页、全局命令面板、通知弹层与活动页已按设计师最新视觉迁移，通知可直达项目动态；生产容器镜像（API/Migration/Web/DB-bootstrap/Ops，`deploy/docker/*.Dockerfile`）与 Nginx 生产配置、镜像构建/Trivy 扫描门禁已落库，基础镜像 digest 已按 [ADR-017](./docs/adr/ADR-017.md) 固定；真实镜像 Tag/digest 绑定与签名发布清单仍由发布环节完成；任务完成、记录作废/恢复、合并/解除任务组、遗留项转任务等业务事件已接入活动/通知写端口；其余 Playwright 完整关键路径 E2E 仍待补齐；Playwright 浏览器测试基座、Compose 稳态拓扑与镜像 ref 预检已落库，但仅校验结构与格式，不代表可启动生产部署。

## 项目目标

InPulse 面向国内单企业、单实例的软件研发团队，目标规模为 10～300 名用户，重点保证：

- 任务、迭代记录、合并关系和操作历史可追溯；
- 核心业务操作保持事务一致，不丢失数据、不串项目、不产生半完成状态；
- 权限、并发冲突和数据库不变量可由自动化检查验证；
- 1～3 人、以 AI 编码代理为主要生产力的团队可以长期维护。

候选系统采用 React SPA、NestJS 模块化单体和单一 PostgreSQL 数据库。完整业务范围、业务规则、架构边界、版本候选项和非目标以功能设计、系统设计与技术设计为准，README 不重复维护这些清单。

## 当前仓库状态

| 状态 | 内容 |
|---|---|
| 已完成 | 候选设计与 ADR；PostgreSQL 18 Schema、九条显式迁移（`0000-0008`，含 `0003_search_pgroonga.sql` 索引、`0004/0005` 旧 `pg_trgm` contract 清理与 `0008` 跨项目记录读索引）、最小权限角色、迁移器与 100 并发真实数据库门禁；阶段 0 工程基座骨架（pnpm workspace、Prettier 格式基线、根级 typecheck/lint/build）与按 §12.4 顺序执行的 CI 链路；API 契约双真相（Schema Registry/Zod + Route Registry）、OpenAPI 3.1 与 TypeScript 客户端生成、漂移与完整性检查、可执行权限矩阵；Nest 运行期契约绑定与统一错误模型（[ADR-029](./docs/adr/ADR-029.md)）、F-01 Session 分批清理、审计 HMAC 惰性轮换与同事务回滚；依赖边界与 Secret 扫描；F-30 前端基座（路由、鉴权守卫、错误边界、Ant Design 主题与 Provider、`@app/@pages/@features/@shared/@generated` 路径别名、jsdom 单测与 dependency-cruiser 边界规则）；PGroonga V1 PoC、15 组语义探针、200 条冻结金标（phase4-v1）Recall@20=100%、跨项目/边界、PostgreSQL 18.6 探针镜像构建、`EXPLAIN (ANALYZE, BUFFERS)`、`0000-0002 -> 0003-0006` 升级/逐迁移回滚与逻辑恢复验证；SearchQueryService 服务层、`ProjectAccessQueryPort` 契约草案与 8 个真实 PostgreSQL 搜索集成用例；生产 `ProjectAccessQueryPort` 适配器与通用 `SessionAuthService`；`GET /api/v1/search` 契约纵切片（Schema、Route Registry、权限矩阵、OpenAPI、生成客户端、最小 Controller、服务端签名游标与真实 `hasMore`）与 8 个真实 HTTP API 集成用例；搜索页面最小纵切片（`/search` 页面、`features/search`、顶部全局搜索框、`useInfiniteQuery` 签名游标分页与前端单测）；F-27 项目动态与 F-28 站内通知（活动/通知写端口、`AuthorizedProjectScope` 动态读取、通知已读/未读/全部已读、前端页面与铃铛）；F-31 Playwright 浏览器测试基座（真实 UI 登录、匿名保护页、全局搜索与站内通知冒烟、API Session 复用、Vite 代理与 CI 接入）；F-12 模块管理创建/编辑/归档/恢复与审计/活动/搜索同事务，含 100 真实业务命令同链并发证据；F-04 项目创建前端纵切片（`/projects` 登录保护、RHF + Zod 表单、生成客户端 CSRF/幂等调用、创建后动态/搜索/通知 E2E）；用户目录 `GET /api/v1/users` 与创建项目成员选择；设计师最新公共应用壳/项目页/全局命令面板/通知弹层/活动页视觉迁移；生产 API/Migration/Web/DB-bootstrap/Ops 镜像与 Nginx 配置（基础 digest 见 [ADR-017](./docs/adr/ADR-017.md)）、镜像构建与 Trivy 扫描门禁（2026-09-11 main CI [run 34620173140](https://github.com/256-code/InPulse/actions/runs/34620173140) 已实际构建 API/Migration/Web/DB-bootstrap/Ops 五个镜像并完成扫描通过，Browser E2E 50 passed）；`operations` profile 的 `backup` 备份服务本体（F-10.3：`pg_dump --format=custom` + AES-256-GCM + SHA-256/签名清单 + 异机 WORM 上传，入口 `deploy/docker/ops.Dockerfile`）与宿主调度接线；`/records` 记录工作区完成 B-3a 单页重构与 B-3b 跨项目读切片（跨项目正式记录清单 + 全局「我的草稿」+ 名称回填 + 跨项目索引 + `q` 检索，「全部项目」已打开，[PR #131](https://github.com/256-code/InPulse/pull/131) / [PR #132](https://github.com/256-code/InPulse/pull/132)）；ADR-025 替代 ADR-010 |
| 下一步 | 剩余事项均为上线门禁与发布环节：其余 Playwright 完整关键路径 E2E（`/audit` 审计页已由 C 于 2026-09-12 补齐）、真实全新主机恢复演练与备份调度启用（备份服务本体已交付，见 [备份与恢复 Runbook](./docs/runbooks/backup-restore.md)）、真实镜像 Tag/digest 签名发布清单，以及把 §12.4 门禁设为 required checks（以仓库设置为准）。已完成基线：C-006 于 2026-09-08 关闭后，搜索页面、F-27/F-28、F-04 项目创建、用户目录、设计师最新视觉迁移、活动页拆分与任务完成/记录作废恢复/合并解除/遗留转任务等业务事件的活动/通知接线均已落库；生产 Dockerfile、五个镜像的 CI 构建与扫描（[run 34620173140](https://github.com/256-code/InPulse/actions/runs/34620173140)）与基础镜像 digest（[ADR-017](./docs/adr/ADR-017.md)）已落地；Playwright 测试基座、Compose 渲染与 ref 预检已作为阶段 0 门禁落库，首次建库 `compose.init` 一次性覆盖与[灾难恢复离线 Runbook](./docs/runbooks/disaster-recovery.md) 已提供 |
| 已提供 | pnpm workspace、严格 TypeScript、格式检查、数据库类型检查/迁移/集成测试、应用 typecheck/lint/build、前端单元测试（`pnpm test:web`）与 dependency-cruiser 边界检查、契约生成与漂移检查、权限矩阵检查、依赖边界与 Secret 扫描、依赖漏洞审计、搜索服务真实 PostgreSQL 集成测试、搜索 API 真实 HTTP 集成测试、搜索 API 稳定正式契约（C-006 已确认）、搜索页面最小纵切片、Playwright 浏览器测试基座（`pnpm test:e2e`）、PGroonga 与原 pg_trgm 搜索 PoC 工具链，以及文档检查 |
| 尚未提供 | 其余 Playwright 完整关键路径 E2E（`/audit` 审计页已由 C 于 2026-09-12 补齐）、真实全新主机恢复演练（备份服务本体已交付，演练与启用属上线门禁）、真实镜像 Tag/digest 签名发布清单；生产容器镜像与镜像扫描已提供，Playwright 测试基座、Compose 稳态拓扑与镜像 ref 预检已提供，备份调度宿主配置与备份/恢复、升级/回滚 Runbook 已提供（`backup` 服务本体与 `audit-archive` 归档 CLI、compose operations 服务、宿主调度均已交付，见 [备份与恢复 Runbook](./docs/runbooks/backup-restore.md) 与 [审计归档 Runbook](./docs/runbooks/audit-archive.md)） |

> 2026-09-09 更新：登录页已接入 TOTP 注册、验证与恢复码，管理员账户菜单提供密码 + 当前 TOTP 重认证；受限 MFA Session 仅在内存保留，注册/验证/恢复码成功后立即轮换 CSRF Token；前端单测 Web 25 文件 63 例，Playwright 16/16（含真实 TOTP 挑战与重认证；本分支新增搜索边界：跨项目隔离、空态、签名游标分页、中文短词与特殊标识符，并新增项目动态专属路径与通知已读/未读/全部已读联动；rebase 后包含 F-13 功能档案），PR #68 GitHub Actions 已通过（workspace 10m14s，docs 通过）；PR #67 首次 CI 已通过（workspace 9m58s，docs 通过），rebase 后 CI 已通过（workspace 11m7s，docs 通过），API 单测 47 文件 224 例；[PR #63](https://github.com/256-code/InPulse/pull/63) 的 GitHub Actions 已通过（workspace 10m2s，docs 通过）；生产仍需 TOTP KEK 相关 Secret。

> 2026-09-09 补充：F-01 Session 分批清理、F-08 审计密钥惰性轮换与同事务回滚、F-11 Nest 运行期契约绑定和统一错误模型均已本地落库；`pnpm check` 全绿，真实 PostgreSQL 集成 API 124 例、数据库 13 例通过，Playwright 8/8；GitHub Actions 仍在 PR 阶段复核。

> 2026-09-09 F-12 已合入主线；模块创建/编辑/归档/恢复已接入审计、活动与搜索投影，新增 100 个真实 `createModule` 并发业务事务同项目审计链证据，F-12 API 集成 10/10 本地通过。

> 2026-09-09 阶段 1 A 域 F-03 用户管理已本地落库：新增管理员用户列表与创建/编辑/停用/启用/强制退出，写操作要求管理员密码+当前 TOTP 5 分钟双因子重认证、CSRF 与幂等键，停用同事务递增 `auth_version` 并撤销 Session（2026-10-19 更新：强制退出已按 ADR-083 移除）；已合并 `origin/main` `8386b29` 到 F-03 交付分支，本地 API 单测 256 例、真实 PostgreSQL 集成 152 例、Web 单测 87 例、Playwright 18/18 通过；GitHub Actions 尚未执行。

> 2026-09-10 阶段 1 F-05 项目成员管理 Playwright E2E 已补齐：新增 `apps/e2e/tests/project-members.spec.ts` 两个用例（普通成员访问 `/projects/:id/members` 被 `RequireAdmin` 拦截显示 403 空态；管理员登录后完成 5 分钟重认证，经页面添加与移除成员并校验不存在项目的读取失败边界）。分支 rebase 到 `origin/main` `5020c0a` 后本地 `pnpm test:e2e` 29/29 通过（4.7m），`pnpm lint`、`pnpm format:check`、`pnpm --filter @inpulse/e2e typecheck` 均通过；分支 `codex/c-member-e2e` 尚未推送，GitHub Actions 待运行。

> 2026-09-11 备份调度生效时机已定（A）：定时备份（宿主每 12 小时加密备份、排除 Session、SHA-256/签名清单、异机保留与失败告警）是生产上线门禁项，上线时才启用；上线前不部署、不运行定时备份任务，`deploy/compose.yaml` 的 `operations` profile 保持未发布，研发阶段数据安全由开发库自身快照承担。同步把技术设计 §1.3 与系统设计中的每日备份表述统一为与 ADR-020 一致的至少每 12 小时，未改动 ADR-020 决策；本轮仅文档变更，未改代码、迁移、契约源或生成物。

> 2026-09-11 更新：上述上线门禁的宿主侧配置与 Runbook 已本地落库——`deploy/backup/`（`backupctl.sh`、5 个 systemd 单元、非敏感配置示例）、[备份与恢复 Runbook](./docs/runbooks/backup-restore.md) 与 [升级与回滚 Runbook](./docs/runbooks/upgrade-rollback.md)，并由 `pnpm check:deploy:test` 静态校验调度节奏、并发锁、go-live 门禁与凭据文件化；`audit-archive` 归档 CLI、compose 服务与宿主调度已本地落库（F-08 步骤 6，见 [审计归档 Runbook](./docs/runbooks/audit-archive.md)）。

> 2026-09-11 阶段 1 A-1 已本地落库：`operations` profile 新增 `backup` 备份服务本体（`apps/ops` 编译入口 `dist/backup-cli.js backup`：流式 `pg_dump --format=custom` → AES-256-GCM 加密 → SHA-256 与 HMAC 签名清单 → 原子重命名 → 异机 WORM 上传 + 本机 7 天保留）与 `deploy/docker/ops.Dockerfile` 生产镜像（PostgreSQL 18.6 客户端、非 root `10002:10002`、CI 构建与 Trivy 扫描）；迁移 `0007` 为 `app_backup` 补齐 `pg_dump` 所需的表级 SELECT 与序列只读授权（会话表数据仍由 `--exclude-table-data` 排除，角色无写权限）；修复生产镜像 deploy 运行树不自包含的缺陷（`--config.node-linker=hoisted`）；真实全新主机恢复演练与调度启用仍属上线门禁。

> 2026-09-12 登录入口与登录页视觉（C）：匿名访问不再显示「需要登录」提示页，任何受保护入口（含 `/`）都会直达登录页并携带 `from` 回跳参数，登录成功后回到原目标；登录页按设计师稿重做为独立全屏品牌页（Libiao Robotics 标志、图标药丸输入框、黄色主按钮与卡片底部品牌条），品牌样式经 `LoginForm` 的 `variant="brand"` 与 `apps/web/src/pages/login/login-page.css` 隔离，`RequireAdmin` 403 与登录状态异常的 500 空态语义未变。本片仅前端入口与视觉，未改后端、契约、迁移、角色、权限行与 CI；[PR #134](https://github.com/256-code/InPulse/pull/134)。

> 2026-09-15 移除 TOTP（用户要求，[ADR-031](./docs/adr/ADR-031.md) 取代 ADR-016）：登录只做密码验证，成功后直接签发自 `AUTHENTICATED` 的完整 Session 与新 CSRF；删除 MFA 注册/验证/恢复码与管理员密码 + TOTP 重认证共 7 条路由与全部前后端实现，管理员高风险操作（用户管理、成员管理、归档/恢复、原始审计、记录作废/恢复）只要求当前有效的完整管理员 Session、`is_admin`、写操作 CSRF 与幂等；最后一名保护改为「最后一名可用管理员」（`LAST_ACTIVE_ADMIN_REQUIRED`）。数据库本期只停用不删除（保留 `user_totp_factors`、`mfa_recovery_codes` 与 `user_sessions` 历史列），TOTP KEK Secret 不再挂载；上文 2026-09-09 的 TOTP 条目为当时事实，已被本条取代。

> 2026-09-15 接入立镖 Casdoor OIDC 单点登录（用户要求，[ADR-032](./docs/adr/ADR-032.md)）：`/login` 默认整页跳转到 `GET /api/v1/auth/sso/start`，回调 `GET /api/v1/auth/sso/callback` 先校验一次性 `state`（URL 与 `__Host-sso-state` Cookie 双绑定）与 id_token（RS256/JWKS，含 `iss`/`aud`/`exp`/`nbf`/`iat`/`nonce`），再复用与口令登录同一实现签发本地 Session；首次登录 JIT 开通账号（`is_admin=false`、`password_hash=NULL`、无项目权限），映射优先级为 `users.sso_subject` → 登录名命中且邮箱一致时绑定 → JIT，邮箱不一致或被占用一律按冲突拒绝，Casdoor 的 `isAdmin` 等 claim 不影响 InPulse 权限；`SSO_ENABLED` 未配置或配置非法时 fail closed，`/login` 回落 `?local=1&sso=disabled`，管理员应急入口为隐藏的 `/login?local=1`。迁移 `0013_sso_login.sql` 新增 `users.sso_subject`（部分唯一索引 + 绑定不可改写触发器）、允许 `password_hash` 为空并新增 `app.sso_login_attempts`；本地会话空闲有效期由 8 小时收紧为 30 分钟（口令与 SSO 共用，`SESSION_IDLE_MAX_AGE_SECONDS` 可覆盖）；`securityFlow` allowlist 由三条扩为五条，Route Registry 97 条路由；生产 Secret 为 `/run/secrets/sso_client_secret`；迁移 `0014_sso_backup_grants.sql` 为 `app_backup` 补齐 `app.sso_login_attempts` 的 pg_dump 只读授权，并把该表数据加入备份排除清单（只保留结构）。 联调另修复三处真实缺陷：`AppModule` 经 `audit/index.js` barrel 引入 `AuditWritePort` 造成的循环依赖（Nest 扫描时 `process.abort()`，已由 `pnpm check:deps` 的 `[circular-dependency]` 覆盖）、`vite preview` 的 CSP 中间件短路 `/api/**` 使 SSO 回落在本地预览里自跳转成环（新增 `isApiPath`）、以及 `SSO_REDIRECT_URL` 更名 `SSO_REDIRECT_URI` 以符合 Secret 扫描门禁。

> 2026-09-18 登录页默认入口调整（用户要求，[ADR-036](./docs/adr/ADR-036.md) 修订 ADR-032 决策 7）：`/login` 默认展示既有本地口令表单，不再自动整页跳转统一身份认证；登录框下方新增「或以统一身份认证登录」分隔文案与单点登录图标，点击后整页跳转 `GET /api/v1/auth/sso/start`（302 导航与 fail closed 回落不变：未启用时回落到 `/login?local=1&sso=disabled` 并提示、隐藏入口）。`?sso_error=` 回落保留本地表单与可重试的 SSO 入口；退出登录与「前往登录」回到 `/login`。服务端路由、契约与权限矩阵无改动。

> 2026-10-15 空库首个 SSO 账号自动成为系统管理员（用户要求，[ADR-075](./docs/adr/ADR-075.md) 修订 ADR-032 决策 5）：平台此前没有任何账号（`app.users` 无行）时，第一个完成单点登录并 JIT 开通的账号自动获得 `is_admin=true`；此后任何情况（含仅剩停用账号）维持 `is_admin=false`。判定与 INSERT 由固定键 `pg_advisory_xact_lock` 在同一事务内串行化，并发首登只有先提交者成为管理员；审计 `auth.sso_account_provisioned` payload 增加 `grantedAdmin`。已绑定映射、Casdoor claim 映射、会话、路由、契约、迁移与权限矩阵均无改动；离线预置管理员仍可行且优先于 SSO 首登。验证：新增 `apps/api/test/sso-first-admin.integration.test.ts` 3 例（真实 PostgreSQL 临时库全量迁移 + 桩 IdP）定向通过；未提交、未推送。

> 2026-10-16 组织（部门）成员管理（用户要求，[ADR-081](./docs/adr/ADR-081.md)）：「成员与设置」对全体登录用户开放——系统管理员可建立组织（部门）、改名、删除（成员回到未分配），并在成员列表批量归属（默认无勾选框，点「批量管理」进入选择模式，含全选当前搜索结果与加入 / 移出组织）；成员列表按组织分组显示（相同部门放一块，当前账号所在组织置顶、其余按组织 id 升序、未分配最后）；普通成员只读查看同组织成员（脱敏：不含登录名、邮箱与停用状态）。新增迁移 `0046` 与 6 条路由（`listOrganizations` / `createOrganization` / `updateOrganization` / `deleteOrganization` / `assignUsersOrganization` / `getMyOrganizationMembers`），路由总数 119 → 125（`permissions:check` 125/125）；指派选择器的「一键选中整个组织」为第二批。

下列根级命令已真实可运行，并与 GitHub Actions 的 `CI / workspace` job 按[技术设计 §12.4](./技术设计v1.2.2.md#124-ci-门禁)顺序执行同一组命令；五个生产容器镜像（API/Migration/Web/DB-bootstrap/Ops）的构建与 Trivy 扫描已在 main CI（[run 34620173140](https://github.com/256-code/InPulse/actions/runs/34620173140)）实际通过，基础镜像 digest 已按 [ADR-017](./docs/adr/ADR-017.md) 固定；§12.4 中其余 Playwright 完整关键路径 E2E（`/audit` 审计页已补齐，见[测试矩阵](./docs/test-matrix.md)）、真实镜像 Tag/digest 绑定与签名发布清单、以及生产加密备份的真实全新主机恢复演练与启用仍未落库，补齐前请勿假设这些检查已执行。

当前可运行的根级命令（§12.4 顺序）：

```shell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm db:migrations:check
pnpm db:migrate            # 需要 PostgreSQL 18 + PGroonga
pnpm test:integration      # 需要 PostgreSQL 18 + PGroonga
pnpm contract:drift
pnpm contract:validate
pnpm build
pnpm test:e2e              # 需要 PostgreSQL 18 + PGroonga；先执行 pnpm build
pnpm check:deploy:static    # 本地静态检查，不需要 Docker
pnpm check:deploy:test      # CI/发布严格模式：需要 Docker，渲染 compose 结构
pnpm check:deps
pnpm check:frontend:boundaries
pnpm permissions:check
pnpm deps:audit            # 需要访问 registry
pnpm check:secrets
pnpm check:docs
```

辅助命令：

```shell
pnpm check             # 一次跑完上述全部非数据库门禁（本地静态部署校验，不依赖 Docker）
pnpm format            # 用 Prettier 写入格式
pnpm contract:generate # 重新生成 OpenAPI 与 TypeScript 客户端
pnpm test:web          # 只运行 apps/web 单元测试
pnpm db:seed:demo      # 把仓库内的演示种子数据载入本地库（已有数据时加 -- --force）
pnpm db:seed:check     # 校验 database/seed/demo-data.sql 与导出规则一致
pnpm check:deploy:static # 不需要 Docker：ref、Dockerfile、备份资产静态检查
pnpm check:deploy:test # CI/发布：Compose 渲染 + exact-tag@sha256 + 结构不变量
pnpm check:deploy      # 真实发布 ref 的严格检查，需要 deploy/.env.deploy 与 Docker
pnpm test:integration:local # 本地一键跑集成测试：先补齐 app_ci 迁移，再执行 test:integration
pnpm test:e2e:local    # 本地一键跑浏览器 E2E：默认指向 app_ci，解析出演示库 app 时拒绝运行
```

`test:integration:local` 只服务本地开发（不参与 CI 门禁）：默认把 `TEST_DATABASE_URL` /
`MIGRATION_DATABASE_URL` 指向本机原生 PostgreSQL 18（55432）上的测试库 `app_ci`。首次运行会
自动检测 PostgreSQL + PGroonga，必要时初始化并启动 `.data/pg-dev`，创建 `app_ci`、执行 bootstrap
与迁移；随后按现有 `POSTGRES_BIN` 注入备份集成测试需要的 `pg_dump` / `pg_restore` 并运行测试。
取值优先级为「进程环境变量 > `deploy/.env.dev.local` > 内置默认」，`--skip-migrate` 可跳过迁移步骤。
可用 `POSTGRES_BIN` 指向本机 PostgreSQL 18 的 `bin` 目录，或用 `INPULSE_LOCAL_PG_PORT` /
`INPULSE_LOCAL_PG_DATA` 调整本地集群；不需要 Docker Desktop。

`test:e2e:local` 同样只服务本地：它把 `E2E_DATABASE_URL` 默认指向同一套原生集群上的 `app_ci`
（取值优先级相同），自动启动数据库、补齐测试库迁移，并在解析出演示库 `app` 时直接拒绝运行——
E2E 夹具会直接写进数据库，写进演示库会污染演示数据。其余参数原样转发给 Playwright，例如
`pnpm test:e2e:local tests/search.spec.ts` 只跑单个 spec。

以下命令已落库，但需要已初始化 PostgreSQL 18 + PGroonga 的实例
（`max_connections >= 150`），当前未纳入 CI：

```powershell
pnpm test:search:db
pnpm test
```

`pnpm test:search:db` 运行搜索服务层与真实 HTTP API 集成测试；`pnpm test`
同时运行数据库与搜索服务测试套件。两者都要求先按[数据库说明](./database/README.md)初始化
角色、PGroonga 和迁移，并设置 `MIGRATION_DATABASE_URL` 与
`TEST_DATABASE_URL`。

> 这个 Docker 探针链只用于 CI、发布证据和可选 PoC，不是本地日常开发、集成测试或 E2E 的前置；日常本地链路使用本机 PostgreSQL 18 + PGroonga，不需要 Docker Desktop。VM 部署仍在 VM 上使用 Docker，不受本机限制影响。

PGroonga 搜索 PoC 使用仓库内 Dockerfile 构建 PostgreSQL 18.6 探针镜像，
执行迁移、现有数据库测试、V1 语义探针、200 条冻结金标召回、跨项目隔离、查询
计划验证、旧 `pg_trgm` GIN 索引与扩展的 contract 清理，以及排除 Session
数据的逻辑备份恢复与恢复后索引烟雾测试。完整结论见
[PGroonga PoC 说明](./database/poc/search-pgroonga/README.md)。

```powershell
docker build `
  -f database/poc/search-pgroonga/Dockerfile.pgroonga-pg18.6 `
  -t inpulse/pgroonga-pg18.6:repro `
  database/poc/search-pgroonga
powershell -NoProfile -ExecutionPolicy Bypass `
  -File database/scripts/poc-search-pgroonga-local.ps1 `
  -Image inpulse/pgroonga-pg18.6:repro `
  -Port 55436 -RestorePort 55437
```

旧的 `pnpm db:poc:search:pgroonga:local` 仍保留为快速复现入口，但其默认
镜像不是 18.6 探针镜像。

原 `pg_trgm` PoC 作为决策证据保留，命令会因 GIN 默认计划门禁失败而非零
退出，见[原搜索 PoC 说明](./database/poc/search/README.md)：

```powershell
pnpm db:poc:search:local
```

数据库迁移和测试需要 PostgreSQL 18；Windows 可设置 `POSTGRES_BIN` 后运行
`pnpm db:test:local` 自动创建并销毁 loopback 临时实例。环境变量、生产
Secret、角色和功能开发事务契约见[数据库说明](./database/README.md)。

仓库内的 `database/seed/demo-data.sql` 是真实演示环境的业务数据快照（账号、
项目、模块、功能点、任务、迭代记录、外部链接、项目动态、审计链与站内通知），
可直接灌进空库得到完整可点的演示环境；导出与校验规则、口令说明见
[数据库说明的演示种子数据章节](./database/README.md#演示种子数据)。

基线冻结的剩余事项只在[仓库开发规则](./AGENTS.md#13-基线冻结剩余事项)维护；实施顺序和验收条件见[技术设计第 14 章](./技术设计v1.2.2.md#14-实施顺序)。

## 本地开发启动

本地开发使用本机原生 PostgreSQL 18 + PGroonga，不需要 Docker Desktop。首次运行会自动检测安装
（可用 `POSTGRES_BIN` 指向 `bin` 目录），必要时初始化并启动 `.data/pg-dev`（只监听
`127.0.0.1:55432`），创建本地 `app` 库并执行角色、PGroonga bootstrap 与迁移；已有集群会直接复用。
仓库提供一键启动脚本，按「准备原生数据库 -> 构建 API -> 启动 API -> 启动 Vite」的顺序拉起开发环境，
并在启动后探测统一身份认证跳转；脚本只服务本地开发，不参与 CI 门禁。
`DATABASE_URL` 指向其它主机或端口时按外部数据库处理，脚本不会启动本机集群，也不会代跑迁移。

```powershell
node scripts/dev-start.mjs                # 按配置启动，默认启用统一身份认证
node scripts/dev-start.mjs --skip-build   # 跳过 API 构建（dist 已是最新时）
node scripts/dev-start.mjs --local-only   # 强制关闭 SSO，按本地口令登录
node scripts/dev-start.mjs --lan          # 让同一局域网的设备以 HTTPS 访问
```

### 局域网共享（--lan）

`--lan` 让同一局域网的其他设备直接访问本机开发环境：

- 前端以 HTTPS 监听 `0.0.0.0:5173`，证书是脚本用 openssl 生成的自签证书，存放在 `.data/dev-certs/`，
  SAN 覆盖 `localhost`、`127.0.0.1`、本机名与当前全部局域网 IPv4；地址变化（DHCP）时自动重建。
  脚本优先使用 `PATH` 里的 `openssl`，否则回退 Git for Windows 自带的 openssl，也可以用
  `INPULSE_OPENSSL` 指定可执行文件路径；
- API 在该模式下只监听 `127.0.0.1:3000`（`INPULSE_API_HOST`），局域网流量统一经 Vite 同源代理进入，
  3000 端口不直接暴露；数据库仍只监听 `127.0.0.1:55432`；
- HTTPS 是硬性要求：会话与 CSRF Cookie 是 `__Host-` 前缀且必须 `Secure`，浏览器会拒绝在明文 HTTP
  的局域网地址上保存它们，因此不能改成 http 访问；
- 其他设备首次访问会提示证书不受信任，点击「高级」->「继续前往」即可；如需消除警告，可把
  `.data/dev-certs/lan-cert.pem` 导入访问设备的受信任根证书；
- Windows 首次共享需要以管理员身份放行入站端口，命令是
  `netsh advfirewall firewall add rule name="InPulse Dev" dir=in action=allow protocol=TCP localport=5173`；
- 局域网地址随 DHCP 变化，以脚本每次启动输出的 `https://<局域网地址>:5173` 为准；其他设备用本地
  账号登录（演示账号与口令见[数据库说明的演示种子数据章节](./database/README.md#演示种子数据)）；
  统一身份认证的回调地址由 `SSO_REDIRECT_URI` 固定，局域网设备如需走 SSO，要把它换成局域网地址
  并在 Casdoor 应用登记（此时本机也要改用该地址访问；未登记时局域网设备用本地口令登录）。

### 本地启用统一身份认证

[ADR-032](./docs/adr/ADR-032.md) 的统一身份认证默认 fail closed，本地启用步骤：

1. 复制模板 `deploy/.env.dev.example` 为 `deploy/.env.dev.local`（该文件名被 `.gitignore` 忽略，不进入仓库）；
2. 向 Casdoor 应用负责人索取 `SSO_CLIENT_ID` 与 Client Secret，把 Client Secret 保存到仓库外的本地文件，
   并在 `SSO_CLIENT_SECRET_FILE` 中填写该文件的绝对路径；
3. 在 Casdoor 的 `INPulse` 应用中登记本地回调地址 `http://127.0.0.1:5173/api/v1/auth/sso/callback`，并把 Token format 设为 `JWT-Custom`、Token fields 至少包含 `Groups`、Token group format 设为 `Path`；否则登录 Token 可能没有 `groups`，或无法得到可对齐的完整群组路径；
4. 重新运行 `node scripts/dev-start.mjs`，打开登录页即自动跳出到统一身份认证（管理员应急口令入口为 `/login?local=1`）。

本地读取 `/run/secrets/` 之外的 Secret 文件时，脚本会同时设置 `NODE_ENV=test` 与
`SSO_CLIENT_SECRET_TEST_PATH=1`，这是仓库规则允许的本地/集成测试路径；生产只从
`/run/secrets/sso_client_secret` 读取。配置缺失或非法时按 fail closed：访问登录页回落到
`/login?local=1&sso=disabled` 并提示未启用；管理员应急口令入口为 `/login?local=1`。

## 部署

稳态拓扑、镜像与发布门禁见[技术设计第 11 章](./技术设计v1.2.2.md#11-部署与运维)，
升级与回滚步骤见[升级与回滚 Runbook](./docs/runbooks/upgrade-rollback.md)。
部署默认启用统一身份认证（`deploy/.env.deploy.example` 中 `SSO_ENABLED=1`），上线前必须完成：

- 用正式取值替换 `SSO_ISSUER`、`SSO_CLIENT_ID`、`SSO_REDIRECT_URI` 与全部 `REPLACE_ME_*` 占位；
- 把 Casdoor 应用签发的 Client Secret 写入 `deploy/secrets/sso_client_secret`
  （compose 以只读 Secret 挂载到 `/run/secrets/sso_client_secret`，禁止用环境变量代替）；
- 在 Casdoor 应用中登记 `SSO_REDIRECT_URI` 指向的正式回调地址；
- 把 Casdoor application 的 Token format 设为 `JWT-Custom`、Token fields 至少包含 `Groups`、Token group format 设为 `Path`，确保 id_token 提供完整路径形式的 `groups` claim。

配置非法或缺失时 API 按 fail closed 以本地登录模式启动，访问登录页回落到 `/login?local=1&sso=disabled`；`/login?local=1` 仍作为管理员应急口令入口可用。
决策与回滚边界见[单点登录 ADR](./docs/adr/ADR-032.md)、[登录入口 ADR](./docs/adr/ADR-036.md)与[直达登录 ADR](./docs/adr/ADR-080.md)。

测试环境（单机 Docker Compose + 本地 registry）的一键更新、迁移与回滚步骤见[测试 VM 更新手册](./deploy/test-vm/README.md)。正式环境固定走 `deploy/prod/update.ps1 -ConfirmProduction`，基座、发布门禁与当前上线缺口见[正式环境部署入口](./deploy/prod/README.md)。

## 文档导航

- [系统设计文档 V1.0.2](./系统设计文档v1.0.2.md)：范围、技术选型、模块划分与安全机制；
- [技术设计 V1.2.2](./技术设计v1.2.2.md)：实施级架构、数据库、事务、安全、测试、部署与阶段验收；
- [功能设计 V1.1](./功能设计v1.1.md)：业务范围、业务规则、角色与核心验收标准；
- [ADR 索引](./docs/adr/README.md)：架构决策的唯一编号、状态和正式记录；
- [权限矩阵](./docs/permissions.md)：身份、操作与资源级授权规则；
- [测试矩阵](./docs/test-matrix.md)：规则到自动化验收的覆盖关系；
- [任务卡片配色规范](./docs/task-card-colors.md)：五种程度（紧急 / 高 / 普通 / 已完成 / 已取消）的卡片实色、对比度、下拉圆点色，以及列表行保持浅色的差异（「低」档位已于 2026-09-23 下线，见 [ADR-041](./docs/adr/ADR-041.md)）；
- [AGENTS.md](./AGENTS.md)：人工开发者与编码代理都必须遵守的仓库规则；
- [CONTRIBUTING.md](./CONTRIBUTING.md)：分支、提交、Pull Request、评审和发布规则。
- [开发日志](./开发日志.md)：每次推送前记录代码变更、功能、优化、测试验证和后续事项。
- [备份与恢复 Runbook](./docs/runbooks/backup-restore.md)：上线门禁下的加密备份调度、启用/停用、全新主机恢复与演练证据；
- [升级与回滚 Runbook](./docs/runbooks/upgrade-rollback.md)：生产升级顺序、迁移失败处理与代码回滚边界。
- [PGroonga V1 PoC 结果](./docs/poc/search-pgroonga-v1-result.md)：V1 范围、15 组语义探针、Recall@20 与 ADR-025；
- [PGroonga PoC](./database/poc/search-pgroonga/README.md)：复现命令、策略矩阵、索引证据与限制；
- [原 pg_trgm PoC](./database/poc/search/README.md)：原门禁失败证据、数据规模、GIN 计划结论。

功能、系统与技术设计及正式 ADR 同步构成候选开发基线。发现冲突时，应先通过 ADR 或同步修订消除歧义，不得由实现者自行选择。

## 许可证

本仓库目前未发布开源许可证，请勿将其视为可自由使用、修改或分发的开源项目。


### 2026-09-14 项目与任务流程修订

见 [ADR-030](docs/adr/ADR-030.md)。新项目从零模块开始；模块使用项目内业务编号，任务创建可同时创建模块和功能。普通成员可查看同项目成员，任务中心提供项目全员/管理员全部任务及分页前逾期筛选。功能可编辑验收标准，草稿详情改为弹窗与名称展示，聚合组提供详情/解除合并入口，项目概览可直达明确设置的根仓库。

部署前执行新增迁移 `0010`–`0012`，再部署配套 API/Web。历史未分类模块保留，迁移包含历史编号回填；`0012` 只为 runtime 增加根仓库标记列的 UPDATE 权限。无新增生产依赖。

本轮使用 Node 24、独立 PostgreSQL 18.6 + PGroonga 测试库完成相关服务层、HTTP/数据库与前端交互回归，并验证 `0000`–`0009` 历史数据升级后名称/ID/kind 保留、编号连续及空项目可提交。按用户要求未执行全量构建、静态检查或依赖审计；浏览器全量 E2E 未运行，不能将本轮定向测试视为完整 CI 通过。

### 2026-10-16 登录页直达单点登录

见 [ADR-080](docs/adr/ADR-080.md)。`/login`（含 `?from=`）默认直达统一身份认证（匿名访问即整页跳转 `/api/v1/auth/sso/start`），本地口令表单退居 `/login?local=1` 与 `sso=disabled` 回落的隐藏应急入口，`?sso_error=` 回落只显示错误与手动重试；服务端路由、契约与权限矩阵不变。

### 2026-10-26 SSO 群组自动对齐 Casdoor（ADR-097）

统一身份认证登录时，InPulse 会读取已验签 id_token 中的 `groups`，按 Casdoor 的 `owner/parent.../name` 完整路径自动建立组织层级，并把 SSO 用户分类到其直接群组。一人可同时属于多个群组；祖先组织会作为层级建立，但不会自动把用户加入祖先群组。

- Casdoor application 必须使用 `JWT-Custom` Token format，Token fields 至少包含 `Groups`，Token group format 为 `Path`；不满足时 `groups` 可能缺失或不是完整路径，InPulse 会分别表现为跳过同步或拒绝非法路径。
- 每次成功 SSO 登录在同一事务内全量对账：缺失 `groups` 不修改组织，`groups: []` 清空组织，合法数组替换全部直接群组关系；任何组织写入失败都会回滚 Session。
- CASDOOR 组织在 InPulse 中只读，管理员手工改名、删除或调整 SSO 用户组织会返回 409 `ORGANIZATION_SSO_MANAGED`；已消失的群组只移除成员关系，不自动删除本地组织行。
- `groups`、Casdoor `isAdmin`、roles 与 permissions 不授予任何 InPulse 权限。本地口令账号仍由管理员维护单个 LOCAL 组织。
- 迁移 `0061_contract_sso_casdoor_organizations.sql` 新增 `app.user_organizations` 等结构；部署前按既有顺序执行 bootstrap 与迁移。真实 Casdoor 生产联调尚未在本轮执行。

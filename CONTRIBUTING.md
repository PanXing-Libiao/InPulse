# InPulse 贡献指南

本指南规定人工开发者使用 Git、Pull Request 和发布标签的方式。具体架构、安全与实现约束见 [AGENTS.md](./AGENTS.md)。

## 开始之前

- 阅读 [README.md](./README.md)、[功能设计 V1.1](./功能设计v1.1.md)、[系统设计文档 V1.0.2](./系统设计文档v1.0.2.md)、[技术设计 V1.2.2](./技术设计v1.2.2.md)和[相关 ADR](./docs/adr/README.md)。
- 先确认变更的用户结果、范围、非目标、不变量、接口、数据库影响和验收方式。
- 设计内容不等于已实现能力；不得编造不存在的命令、接口、测试结果或运行状态。
- 架构、核心依赖、数据库不变量、权限、安全或运维策略变化必须先形成 ADR，并同步受影响文档与测试。
- 开始编辑前检查 `git status`，保留工作区中不属于本任务的改动。

## Git 工作流

- 采用“`main` 发布主线 + 三条岗位长期工作分支 + 临时交付分支”模型；`main` 始终保持可发布，禁止直接推送。
- `dev/a`、`dev/b`、`dev/c` 分别是 A、B、C 岗位的长期工作分支；每个岗位只推送自己的 `dev/<role>`。
- 正式交付时，先将自己的 `dev/<role>` 同步到最新 `main`，再创建短生命周期交付分支；交付分支一个 PR 只承载一个逻辑变更或业务纵切片。
- 不得把 `dev/<role>` 直接作为进入 `main` 的 PR 来源，也不得把未交付的 WIP 混入交付 PR；交付分支合并并删除后，再把最新 `main` 同步回自己的 `dev/<role>`。
- 分支名称使用小写 ASCII 与 kebab-case；Issue 编号存在时放在简短描述前。

推荐前缀：

| 变更 | 格式 | 示例 |
|---|---|---|
| 功能 | `feature/<issue>-<description>` | `feature/42-task-completion` |
| 修复 | `fix/<issue>-<description>` | `fix/51-session-rotation` |
| 文档 | `docs/<description>` | `docs/repository-rules` |
| 重构 | `refactor/<description>` | `refactor/task-query-port` |
| 测试 | `test/<description>` | `test/audit-concurrency` |
| 构建/维护 | `chore/<description>` 或 `ci/<description>` | `ci/api-contract-check` |

没有 Issue 时可以省略编号，例如 `feature/task-search`。PR 合并后删除交付分支，不删除岗位长期工作分支。

### A/B/C 推送与合并矩阵

三名开发人员按业务域纵向分工，每条工作流由一名开发人员加一个 AI 编码代理负责。每个岗位使用固定的长期工作分支，正式交付分支仍使用上文推荐前缀；负责人必须写入任务记录。

| 岗位 | GitHub 账号 | 固定工作分支 |
|---|---|---|
| A：平台与访问域 | `@shaoxiaoyu-D` | `dev/a` |
| B：内容与任务执行域 | `@suikiiovo` | `dev/b` |
| C：聚合与发现域 | `@256-code` | `dev/c` |

账号是分支推送主体；A/B/C 必须使用自己的 GitHub 账号推送对应 `dev/<role>`，不得借用其他岗位账号或由他人代推。

| 岗位 | 独立推送范围 | 推送与合并限制 | 非作者评审 |
|---|---|---|---|
| A：平台与访问域 | Identity、Projects、Audit、Workflow 公共基建；auth/projects/members/admin 前端；用户、会话、审计、序列与迁移管理；部署、备份与恢复 | 只推送 `dev/a` 及其交付分支；禁止推送 `main`；作为迁移主理人协调迁移 | B 或 C |
| B：内容与任务执行域 | Modules、Features、Tasks、TaskGroups、ChangeRecords、ExternalLinks；模块、功能、任务、记录与链接前端 | 只推送 `dev/b` 及其交付分支；禁止推送 `main`；迁移草案经 A 协调后提交 | C 或 A |
| C：聚合与发现域 | Search、Activity、Notifications 读模型；search/notifications/activity/dashboard/me 前端；`app/`、`shared/`、`generated/api/`；浏览器自动化测试基座 | 只推送 `dev/c` 及其交付分支；禁止推送 `main`；A/B 修改其管辖的 `app/`、`shared/` 时必须由其评审 | A 或 B |

任何岗位的 AI 编码代理均只允许推送所属岗位的固定工作分支或该岗位交付分支，不得直接合并代码；所有进入 `main` 的变更必须通过 PR、squash merge 和非作者评审。高风险变更必须至少一名非作者人工批准，作者不得自批。

共享区域的推送与合并要求：

| 区域 | 主理人 | 推送与合并要求 |
|---|---|---|
| `packages/api-contract` | 谁修改谁提交 | 契约 PR 先行，至少由另一岗位评审；OpenAPI 与生成客户端必须由工具生成，禁止手改 |
| `database/migrations` | A 为迁移主理人 | 按模块编写草案，由 A 统一编号、顺序与冲突处理；每条迁移独立 PR，且必须非作者人工评审 |
| `app/`、`shared/`、`generated/api/` | C | 其他岗位修改时必须由 C 评审；`generated/api/` 禁止手工修改 |
| `compose.yaml`、根 `package.json`、CI 配置 | 对应负责人 | 单独 PR，不混入业务功能；高风险变更必须人工评审 |

多人并行时的推荐合入顺序：

1. 契约与数据库迁移先合；
2. 后端领域与 Workflow 后合；
3. 前端基于最新 `main` 合入；
4. 部署、CI 与共享配置最后单独合入；
5. 文档单独提交，不与功能改动混在一起。

## 提交与 PR 标题

进入 `main` 的最终 squash commit 和 PR 标题采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)：

```text
<type>[optional scope][!]: <description>
```

其中 optional scope 和 `!` 均为可选部分；scope 存在时写成 `(<scope>)`，`!` 必须紧邻冒号之前。

允许的主要类型：

- `feat`：新增用户可见能力；
- `fix`：修复缺陷；
- `docs`：仅文档；
- `refactor`：不改变外部行为的重构；
- `test`：测试；
- `build`：构建或依赖；
- `ci`：持续集成；
- `chore`：其他维护；
- `perf`：性能改进；
- `revert`：回退既有变更。

推荐 scope：`web`、`api`、`contract`、`db`、`infra`、`docs`、`repo`。

示例：

```text
feat(api): add task completion workflow
fix(db): prevent cross-project task links
docs(repo): define contribution workflow
feat(contract)!: change task response schema
```

不兼容变化使用可选的 `!`，在 footer 中写 `BREAKING CHANGE: ...`；迁移方式和回滚路径写在正文。

分支中的临时提交不强制全部符合 Conventional Commits，但必须清晰且不得包含无关变化。阶段 0 应增加 PR 标题或最终提交的自动校验；在此之前由评审人工检查。

## 开发日志

- 每次向远端推送功能分支或创建/更新 Pull Request 前，必须更新 [开发日志](./开发日志.md)。
- 每条记录写明做了什么、新增功能、修复/重构或优化、实际测试与验证、文档同步、风险与后续事项。
- 不得编造测试或 CI 结果；未执行的检查必须写明“未运行”。日志不能替代 PR 描述、提交说明、测试报告或 ADR。
- PR 合并后，已合入的日志条目视为历史记录；补充内容新增记录，不重写已合入事实。

## Pull Request

每个 PR 必须：

- 说明为什么修改、用户结果、范围和明确非目标；
- 列出 API、数据库、权限、安全、依赖、部署和生成物影响；
- 更新 [开发日志](./开发日志.md)，并说明本次推送/PR 的变更事实与实际验证结果；
- 包含新增/更新的测试及实际验证结果；
- 同步受影响的 ADR、设计、权限矩阵、测试矩阵和 Runbook；
- 保持可审查，不夹带格式化全仓、无关重命名或顺手重构；
- 使用仓库的 [Pull Request 模板](./.github/pull_request_template.md)。

数据库迁移、数据库角色、业务不变量、鉴权、权限、Secrets、API 契约、Dockerfile、Compose 和 GitHub workflow 必须重点人工审查。

## 评审与合并

团队流程要求：

- 只使用 squash merge；PR 标题作为最终提交标题。
- 合并前必须解决全部 review conversation，并通过所有已配置且适用于该变更的状态检查。
- 2～3 名维护者时，至少由一名非作者维护者批准最新可评审提交；这是当前团队规则，不代表 GitHub 已通过 ruleset 强制执行。
- 仅有一名维护者时，低风险文档、测试和非生产脚手架变更可以由维护者通过 PR 完成结构化自审；数据库迁移、数据库角色、业务不变量、鉴权、权限、Secrets、API 契约、Dockerfile、Compose 和 GitHub workflow 等高风险变更必须取得另一名合格人工审查者批准后才能合并。
- 在服务端保护规则完成前，维护者不得直接推送、强制推送或删除 `main`，也不得绕过失败检查。
- 合并者应删除交付源分支；在自动删除设置启用前需手工删除。禁止在已 squash 的交付分支上继续开发下一项变更；合并后把最新 `main` 同步回对应岗位的 `dev/<role>`。

截至 2026-09-04 可核验的仓库设置为：同时允许 squash merge、merge commit 和 rebase merge，未开启合并后自动删除源分支；本次评审时也没有状态检查被标记为 required。分支保护与 ruleset 接口返回 403，因此无法核验 `main` 的服务端保护状态。在管理员确认并提供可见的规则或门禁结果前，上述要求按人工流程执行，不得描述为已由 GitHub 强制执行。

管理员待完成的目标配置：

- 仅保留 squash merge，关闭 merge commit 和 rebase merge；
- 将默认 squash commit message 设为 PR title；
- 开启合并后自动删除源分支；
- 在当前 GitHub 方案支持时为 `main` 建立 ruleset 或分支保护，并将本节的人工审查规则落为服务端门禁。

目标 `main` 规则至少包括：

- require a pull request before merging；
- require status checks；
- require conversation resolution；
- require linear history；
- block force pushes and deletions；
- disable bypass by default。

当前凭据访问私有仓库保护规则接口时返回 403，无法据此判断是权限、方案限制还是规则状态。管理员必须在仓库 Settings 中核验并记录实际配置；若当前方案不支持所需 ruleset/分支保护，则继续执行人工门禁，不得宣称保护已经启用。阶段 0 建立其余稳定 CI job 后，再把技术设计第 12.4 节的门禁设为 required checks。责任人确定后再添加 `CODEOWNERS`，不要使用虚构账号占位。

## 验证

阶段 0 CI 最小链路已落库。GitHub Actions 的 `CI / workspace` job 按[技术设计 §12.4](./技术设计v1.2.2.md#124-ci-门禁)顺序执行下列根级命令，`Documentation / docs` job 只执行 `check:docs`：

`CI / workspace` 在同一 ref 上取消被新推送取代的在运行流水线（`main` 上的运行不取消，保证每个已合并提交都留下完整结果）；取消只改变耗时，不改变上列门禁的顺序、内容和判定标准。曾试把 `apps/api` 的 `test:unit` 改为并行执行单元测试文件，但 CI 实测反而略慢（`apps/api test:unit` Duration 35.99s -> 40.14s；该套件在 4 vCPU runner 上受模块导入与 worker 启动开销支配），已回退为原串行方式；共享真实 PostgreSQL 的集成测试继续在 `vitest.config.mjs` 与 `vitest.integration.config.ts` 中串行执行。2026-09-10 用 `gh run view` 读到单次运行约 16 分钟，其中 `pnpm install --frozen-lockfile` 仅约 13 秒，因此没有为 pnpm store 引入缓存步骤；当前主要耗时项是 Browser E2E、生产镜像构建与 Trivy 扫描。PR #80 实测运行 16.60~16.68 分钟（同代码基线 `main` `ad6476b` 为 17.58 分钟），Playwright 缓存命中后 Install Playwright browser 由 23s 降到 14s。

为 Playwright 的 Chromium 增加 `actions/cache` 步骤缓存 `~/.cache/ms-playwright`（action 固定到 `v5.1.0` 的提交，键绑定 `pnpm-lock.yaml`），因为实测 Install Playwright browser 在两条运行间为 25s 与 116s，波动明显；Trivy 漏洞库已由 `trivy-action` 自带缓存，未再重复配置。

生产镜像的 builder 改为先复制依赖清单（根 manifest、各 workspace 包 `package.json`、lockfile、`.npmrc`）再执行 `pnpm install --frozen-lockfile`，之后才 `COPY . .`，使依赖层不随源码失效；CI 的镜像构建改用 container driver 的 buildx 并带 `type=gha` 层缓存（每个镜像独立 cache scope 与 `ignore-error=true`），对应 `.github/workflows/ci.yml` 的 Set up Docker Buildx with GHA layer cache 步骤。新增 workspace 包时必须同步 `deploy/docker/{api,migration,web}.Dockerfile` 的依赖清单，否则 `--frozen-lockfile` 会因 lockfile 与 manifests 不一致而失败。

```shell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm db:migrations:check
pnpm db:migrate            # CI 内连接 digest 固定的 postgres:18.6
pnpm test:integration      # 同上
pnpm contract:drift
pnpm contract:validate
pnpm build
pnpm check:deploy:static   # 本地无需 Docker
pnpm check:deploy:test     # CI/发布严格模式（需要 Docker）
pnpm check:deps
pnpm check:frontend:boundaries
pnpm permissions:check
pnpm deps:audit
pnpm check:secrets
pnpm check:docs
```

各命令的含义与前置条件：

- `lint`：ESLint 检查全部工作区源码；
- `format` / `format:check`：Prettier 写入或校验格式，`.prettierignore` 排除 Markdown、lockfile、迁移与生成物；
- `typecheck`：覆盖 database 包、api-contract 包与 api/web 应用，`apps/api` 另含 `tsconfig.test.json`；
- `test:unit`：database 配置与生产 Secret fail-closed 校验、api-contract 契约与生成器单元测试，不需要数据库；
- `db:migrations:check`：校验迁移文件的顺序、命名与内容哈希一致性；
- `db:migrate`：以 `MIGRATION_DATABASE_URL`（`app_migrator` 角色）对空库执行 `0000-0005` 显式迁移，需要已安装 PGroonga 的 PostgreSQL 18；
- `test:integration`：以 `TEST_DATABASE_URL`（`cluster_bootstrap` 角色）对真实 PostgreSQL 验证约束、事务、锁、100 并发审计链、PGroonga bootstrap 与索引、以及数据库角色/权限探针，需要已安装 PGroonga 的 PostgreSQL 18，不得用 mock 替代；
- `test:integration:local`：本地一键封装（不参与 CI）。默认把 `TEST_DATABASE_URL` / `MIGRATION_DATABASE_URL` 指向本机原生 PostgreSQL 18（55432）的测试库 `app_ci`；首次运行自动启动 `.data/pg-dev`、创建测试库、执行 bootstrap 与迁移，再按 `POSTGRES_BIN` 注入 `INPULSE_BACKUP_PG_DUMP` / `INPULSE_BACKUP_PG_RESTORE` 后运行 `pnpm test:integration`；`--skip-migrate` 跳过迁移，`--env-file` 换配置文件（默认 `deploy/.env.dev.local`）。不需要 Docker Desktop；
- `test:e2e:local`：本地一键封装（不参与 CI）。默认把 `E2E_DATABASE_URL` 指向本机原生 PostgreSQL 18（55432）上的测试库 `app_ci`；首次运行自动启动集群、创建测试库并补齐迁移，解析出演示库 `app` 时直接拒绝运行（E2E 夹具会直接写进数据库，写进演示库会污染演示数据）；`--skip-migrate` 跳过迁移，`--env-file` 换配置文件（默认 `deploy/.env.dev.local`），其余参数原样转发给 Playwright。不需要 Docker Desktop；
- `test:search:db`：运行 `apps/api` 的搜索服务层与真实 HTTP API 集成测试，需要已初始化 PGroonga 且 `max_connections >= 150` 的 PostgreSQL 18 实例，按既定决定未纳入 CI；
- `contract:generate`：由 Schema Registry/Zod 与 Route Registry 生成 OpenAPI 3.1、契约指纹与 TypeScript 客户端，生成物禁止手工修改；
- `contract:drift`：逐字节比对已提交生成物与 Registry 的生成结果，并拒绝生成目录内出现非生成器产出的文件；
- `check:deploy:static`：不需要 Docker，对 `deploy/.env.deploy.test` 的合成 ref、Dockerfile、Nginx/健康检查资产与备份调度做静态校验；
- `check:deploy:test`：CI/发布用的严格模式，使用 `deploy/.env.deploy.test` 的合成镜像 ref 渲染 `docker compose config`，校验 exact-tag@sha256 格式、PostgreSQL 18 命名卷、非 root/只读、资源限制、独立迁移、健康检查与仅 Nginx 暴露端口；需要 Docker，不代表生产镜像已构建或 digest 来自受信仓库；
- `contract:validate`：Route Registry 策略完整性、幂等重放与重放授权策略的字段边界、响应 Schema 一致性以及 Controller operationId 绑定检查；
- `build`：api（`tsc`）与 web（`vite`）生产构建；
- `check:deps`：前端分层（`app -> pages -> features -> shared/generated`）、跨模块内部访问、循环依赖、Controller 直连数据库与前端裸 `fetch` 检查；后端跨模块只允许访问目标模块的公开表面（`public/**`、模块 `index.ts`、`*.port.ts`），对应第 3 节的 Domain/Public Port；
- `check:frontend:boundaries`：`apps/web` 的 dependency-cruiser 分层复核，与 `check:deps` 同属 §12.4 的依赖边界门禁；
- `test:web`：只运行 `apps/web` 的 jsdom 单元测试，等价于 `pnpm test:unit` 中的 web 部分；
- `permissions:check`：可执行权限矩阵与 `docs/permissions.md` 的双向一致性，以及每条路由的允许/拒绝用例登记；
- `deps:audit`：`pnpm audit --audit-level=high`，需要访问 registry；曾因 `ansi-regex@5.0.0`（high，来自 `origin/main` PR #16 的 `@testing-library` 依赖链）失败，已由 `pnpm-workspace.yaml` 的 `overrides` 固定到 `^5.0.1` 解决；2026-09-09 另因 `multer@2.2.0` 的 3 个 high（GHSA-wc9g-mqfw-jrwm、GHSA-qfvm-cv95-jqjf、GHSA-535w-7cp7-47q4，来自 `@nestjs/platform-express@11.2.3`）失败，已在同一文件固定到 `2.3.0` 并由公共 registry 审计零漏洞；2026-10-08 main CI 的 `Dependency audit` 又因 6 条公告转红（1 critical `proxy-addr@2.0.7` GHSA-jqcg-44mw-7w3h；3 high：`brace-expansion@5.0.9` 的 GHSA-qhr7-859c-m2p7 与 GHSA-6j4f-fj2g-mc7p、`source-map-js@1.2.1` GHSA-68fv-2mgg-jv7q；2 moderate：`multer@2.3.0` GHSA-3pph-fpjx-jg34、`brace-expansion` GHSA-q2hr-2g5m-vwhr），已由同一文件把 `proxy-addr` 固定到 `2.0.8`、`brace-expansion` 固定到 `5.0.12`、`source-map-js` 固定到 `1.2.2`、`multer` 收紧到 `2.4.0` 并由公共 registry 审计恢复零漏洞；上述依赖变更均须按 `AGENTS.md` 第 4 节作为独立依赖升级 PR 由人工确认，不得调低阈值；
- `check:secrets`：对受版本控制与待提交文件执行 Secret 扫描；
- `check:docs`：使用 Node.js 内置模块，检查 HEAD、暂存区、工作区与未忽略的新文件，并校验仓库内 Markdown 相对链接、引用式链接和标题锚点；
- `check`：按上述顺序一次跑完全部非数据库门禁，不含 `db:migrate`、`test:integration` 与 `test:search:db`；本地无 Docker 时使用 `check:deploy:static`，CI/发布仍单独执行严格 `check:deploy:test`。

本机运行数据库门禁：Windows 设置 `POSTGRES_BIN` 指向**已安装 PGroonga** 的 PostgreSQL 18 `bin` 目录后运行 `pnpm db:test:local`，它会创建 loopback 临时实例，依次执行 `000_roles.sql`、`020_pgroonga.sql`、空库迁移与 database 包全部测试后销毁实例；脚本检测不到 PGroonga 时直接失败，因此不含 PGroonga 的官方 PostgreSQL 18.6 安装无法满足该门禁。同一个 `POSTGRES_BIN` 也覆盖 `apps/ops` 的备份/恢复集成测试：未注入 `INPULSE_BACKUP_PG_DUMP` / `INPULSE_BACKUP_PG_RESTORE` 时，测试按 `POSTGRES_BIN` 解析 `pg_dump` / `pg_restore`，两者都没有才回落到 PATH 上的 `pg_dump`。CI 改为用 `database/poc/search-pgroonga/Dockerfile.pgroonga-pg18.6` 基于 digest 固定的 `postgres:18.6` 构建探针镜像，并在容器内执行同一组步骤。

`CI / workspace` 尚未被配置为 required check。按验收标准，先让门禁在真实 PR 上稳定通过，再由管理员把 §12.4 门禁设为 required checks；在此之前合并者必须人工确认该 job 成功。设计、README、AGENTS 和贡献规则的语义一致性仍需人工审查。

阶段 0 搜索 PoC 附加命令（需要 Docker 与对应镜像）：

```shell
pnpm db:poc:search:pgroonga:local
pnpm db:poc:search:local
```

PostgreSQL 18.6 探针镜像上的 PGroonga PoC 已通过构建、扩展安装、迁移、
V1 语义、90 条金标 Recall@20、边界、跨项目隔离、默认查询计划和逻辑恢复；
`search_projection` PGroonga bootstrap 与 `0003-0005` 显式迁移已通过真实
PostgreSQL 集成测试；旧 `pg_trgm` GIN 索引和扩展在 `0004/0005` 的
contract 验证后清理，`object_inspect` 用于记录 Groonga 索引磁盘占用。
SearchQueryService 服务层、参数化查询与权限过滤测试已落地并通过真实
PostgreSQL 验证；生产 `ProjectAccessQueryPort` 适配器与通用
`SessionAuthService` 已落地，其真实 PostgreSQL 集成测试待 CI 探针镜像执行；
`GET /api/v1/search` 契约纵切片已落地 Schema、Route Registry、
OpenAPI、生成客户端、最小 Controller、服务端签名游标与真实 `hasMore`；
A 已确认 envelope 与不透明游标方向并关闭 C-006；搜索页面与真实 HTTP API
集成已落库，完整 Playwright 关键路径 E2E 与生产加密备份恢复仍未完成。
`pnpm db:poc:search:local` 作为原 `pg_trgm` 门禁失败证据仍会非零退出，
不得据此宣称生产搜索已通过。

阶段 0 仍待建立并记录真实可运行的根级入口：

- Playwright 完整关键路径 E2E（F-31 基座已落库，业务场景待补）；
- 生产加密备份恢复（F-10.2）演练、真实镜像 Tag/digest 签名发布清单（备份服务本体、升级/回滚规程、首次建库 `compose.init` 一次性覆盖与灾难恢复离线 Runbook 均已交付）；
- 镜像漏洞扫描。

截至 2026-09-07，§12.4 中 frozen lockfile 安装、lint、format check、typecheck、unit tests、空库迁移、真实 PostgreSQL 集成测试（含数据库角色/权限探针）、OpenAPI/客户端漂移检查、Route Registry/权限/响应 Schema 完整性、Web/API 生产构建、依赖边界检查、权限矩阵检查与依赖/Secret 扫描已落库并纳入 `CI / workspace`。非数据库门禁已在本地实测通过；空库迁移与数据库集成测试曾在 `0000-0002` 上本地实测通过，合并 `0003-0005` 后二者要求已安装 PGroonga 的 PostgreSQL 18 实例，本机 PostgreSQL 18.6 已内置 PGroonga 4.0.8，`db:test:local` 与 API `test:integration` 已在本地通过；GitHub Actions 尚未执行，CI 的 PGroonga 探针镜像仍用于可复现隔离验证。`pnpm test:search:db` 与 `pnpm test` 按既定决定仍未纳入 CI。仓库尚无生产 Dockerfile 与 `compose.yaml`，因此生产容器镜像构建、Compose 渲染与 digest 格式校验、镜像扫描无法落库，且 [ADR-017](./docs/adr/ADR-017.md) 要求的 Nginx 1.30.x 补丁与镜像 digest 仍需人工定案；契约生成工具链见 [ADR-027](./docs/adr/ADR-027.md)（状态 `Accepted`）。

脚本落库前不要在 README、PR 或交付说明中声称这些检查已通过。

## 生成物、迁移和 lockfile

- `pnpm-lock.yaml` 必须随依赖清单提交。
- OpenAPI 3.1 和 TypeScript 客户端必须提交，但只能由 Schema + Route Registry 的生成流程更新；源定义和生成结果必须在同一 PR。
- `database/migrations/**` 属于不可重写历史，必须提交并人工评审；不得用 `.gitignore` 隐藏。
- 构建输出、覆盖率、测试报告、本地数据库、备份、审计导出和临时文件不提交。
- 首次启用或实质修改 `.gitattributes` 后，应在独立变更中执行 `git add --renormalize .` 并审查结果，避免把全仓换行变化混入功能 PR。

## Secrets 与敏感数据

- 不提交 `.env`、凭据、Token、私钥、生产数据、数据库 dump 或真实 Secret 文件。
- `.env.example` 只列非敏感变量名，不放 Secret 示例值或占位值；项目级 `.npmrc` 如需提交，只能引用环境变量，不得包含明文 Token。
- `.gitignore` 不是安全边界。发现 Secret 进入提交后，应先撤销或轮换，再评估历史清理；不能只在后续提交中删除。
- 阶段 0 应启用依赖、镜像和 Secret 扫描；GitHub 能力允许时启用 secret scanning 与 push protection。

## 发布与标签

- 软件发布版本与设计文档版本分开管理。设计文档的 V1.2.2 不等于软件已经发布 v1.2.2。
- 软件开始发布后采用 [Semantic Versioning 2.0.0](https://semver.org/)；首次稳定公共契约前使用 `v0.y.z`，稳定后使用 `vMAJOR.MINOR.PATCH`。
- 发布标签只能指向 `main` 上通过门禁的 commit SHA，使用 annotated tag；签名流程验证完成后优先使用签名标签。
- 已发布标签不可移动、复用或删除。GitHub 能力允许时为 `v*` 配置 tag ruleset。
- 每次发布记录版本、commit SHA、镜像 RepoDigest、SBOM、数据库升级/回滚要求和构建时间。

## 规范来源

本项目结合以下公开规范，并以本仓库设计约束为最终项目规则：

- [OpenAI Docs：使用 AGENTS.md 自定义指令](https://learn.chatgpt.com/zh-Hans/docs/agent-configuration/agents-md)
- [GitHub：About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [GitHub：Contribution guidelines](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)
- [GitHub：Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub：Pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges)
- [GitHub：Node.gitignore 模板](https://github.com/github/gitignore/blob/main/Node.gitignore)
- [Git：gitignore](https://git-scm.com/docs/gitignore)
- [Git：gitattributes](https://git-scm.com/docs/gitattributes)
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [Semantic Versioning 2.0.0](https://semver.org/)

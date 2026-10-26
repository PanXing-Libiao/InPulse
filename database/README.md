# InPulse 数据库

本目录是 InPulse 的数据库唯一实现基线。当前锁定 PostgreSQL 18.x、
Drizzle ORM 0.45.2 和 Postgres.js 3.4.9。API 进程只能使用
`app_runtime`，不得启动时迁移；迁移只能由独立的
`app_migrator` 任务执行。

## 目录与真相来源

- `schema/**`：Drizzle 类型模型，供 Repository 编译期使用；
- `migrations/*.sql`：数据库行为的权威、只追加迁移历史；
- `bootstrap/000_roles.sql`：首次建库的角色、所有权和默认权限；
- `bootstrap/010_passwords.sql`：仅初始化容器读取五个独立密码
  Secret（路径与稳态 compose secret 同名，`db_*_password`）；
  仓库和命令行都不出现密码；
- `bootstrap/020_pgroonga.sql`：由 `cluster_bootstrap` 预装非 trusted 的
  `pgroonga` 扩展，并撤销非运行时角色的扩展函数 EXECUTE；
- `src/migrate.ts`：带全局 advisory lock 和 SHA-256 历史校验的迁移器；
- `test/database.integration.test.ts`：真实 PostgreSQL 约束、权限与并发门禁。

表、可由 Drizzle 表达的约束及 SQL 迁移必须在同一变更中同步。函数、
约束触发器、扩展、对象所有权和 GRANT 只以显式 SQL 迁移表达。已经在任一
环境应用的迁移绝不修改；后续修复必须追加新序号。迁移器发现历史文件哈希
变化会立即失败。

## 首次建库

生产初始化顺序如下（可执行入口为 [`deploy/compose.init.yaml`](../deploy/compose.init.yaml)
一次性覆盖与 [灾难恢复离线 Runbook](../docs/runbooks/disaster-recovery.md)）：

1. PostgreSQL 官方镜像以 `cluster_bootstrap` 创建 `app` 数据库；
2. 以该一次性超级用户依次执行 `000_roles.sql`、`010_passwords.sql`
   和 `020_pgroonga.sql`；
3. 停止初始化配置，日常数据库容器不再挂载 bootstrap 密码；
4. 独立迁移任务以 `app_migrator` 执行 `pnpm db:migrate`；
5. 迁移成功后 API 才以 `app_runtime` 启动。

PGroonga 不是 trusted extension，不能由普通 `app_owner` 首次安装；
因此 `020_pgroonga.sql` 必须在迁移前由一次性超级用户执行。正式
`0003_search_pgroonga.sql` 只保留幂等守卫与 schema 限定的索引定义，并在
缺少扩展时 fail closed。`0004_search_projection_contract_pg_trgm_index.sql`
确认 PGroonga 索引存在后才删除旧 GIN 索引；
`0005_search_projection_contract_pg_trgm_extension.sql` 确认旧 GIN 索引已
删除且 `pg_trgm` 没有扩展外依赖后才删除扩展，避免把索引和扩展清理与
PGroonga 迁移合并在同一迁移中。

生产环境不接受明文 URL 环境变量。迁移和运行进程分别使用
`MIGRATION_DB_PASSWORD_FILE`、`RUNTIME_DB_PASSWORD_FILE`，并配合
`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_SSLMODE`。完整键名见
`.env.example`。

日常本地开发、集成测试与 E2E 不需要 Docker Desktop：`node scripts/dev-start.mjs`、`pnpm test:integration:local` 与 `pnpm test:e2e:local` 会检测本机 PostgreSQL 18 + PGroonga，必要时初始化并启动 `.data/pg-dev`（127.0.0.1:55432），并自动创建 `app` / `app_ci`、执行 bootstrap 与迁移。可用 `POSTGRES_BIN` 指定 `bin` 目录，`INPULSE_LOCAL_PG_PORT` / `INPULSE_LOCAL_PG_DATA` 覆盖端口和数据目录。VM 上的 Docker 部署不受影响。

本地已有安装 PGroonga 的 PostgreSQL 18 时，可一次性创建隔离集群、迁移、
测试并停止：

```powershell
$env:POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
pnpm db:test:local
```

该脚本先检查 `pg_available_extensions`，执行 `020_pgroonga.sql`；若本机
未安装 PGroonga，会明确失败。请安装匹配版本的 PGroonga，或在 CI/VM 上使用探针镜像；
日常本地开发与测试不需要 Docker。脚本只在系统
临时目录创建 `InPulse-PgTest-<uuid>`，只监听
`127.0.0.1`，使用仅限该临时实例的 trust 认证，并将
`max_connections` 设为 150 以执行 100 并发审计门禁。成功后自动停止并
删除测试目录；失败时保留日志路径供排查。可传 `-KeepData` 保留成功实例
的数据目录。

## 日常命令

```powershell
pnpm install --frozen-lockfile
pnpm db:migrations:check

$env:MIGRATION_DATABASE_URL = 'postgresql://app_migrator:...@127.0.0.1:5432/app'
pnpm db:migrate

$env:TEST_DATABASE_URL = 'postgresql://cluster_bootstrap@127.0.0.1:55432/app'
pnpm db:test
```

`TEST_DATABASE_URL` 的角色派生只适用于 loopback trust 测试库。CI 使用独立
密码时必须显式提供 `TEST_MIGRATOR_DATABASE_URL`、
`TEST_RUNTIME_DATABASE_URL`、`TEST_BACKUP_DATABASE_URL`、
`TEST_AUDIT_READER_DATABASE_URL` 和
`TEST_AUDIT_ARCHIVE_DATABASE_URL`。

搜索服务真实 PostgreSQL 集成测试复用同一套角色和迁移：

```powershell
$env:MIGRATION_DATABASE_URL = 'postgresql://app_migrator@127.0.0.1:55432/app'
$env:TEST_DATABASE_URL = 'postgresql://cluster_bootstrap@127.0.0.1:55432/app'
pnpm test:search:db
```

该命令要求目标实例已执行 `000_roles.sql`、`020_pgroonga.sql`，且
`max_connections >= 150`；它不在当前 CI 的 `CI / workspace` job 中执行。

## 演示种子数据

`seed/demo-data.sql` 是从真实运行中的演示库导出的**业务数据快照**，用于让
全新的空库一次性得到与演示环境一致的账号、项目、模块、功能点、任务、迭代
记录、外部链接、项目动态、审计链和站内通知。它是版本化数据资产，参与
`pnpm db:seed:check` 漂移检查，不进入迁移历史、也不修改任何表结构。

种子只包含业务数据：

- 含项目审计链（`audit_logs` 与 `audit_chain_heads`）——项目动态的来源外键
  指向审计记录，缺了会直接载入失败；导出时已剔除测试痕迹行；
- 不含登录会话、CSRF 材料、幂等记录、限流桶、MFA 恢复码和 TOTP 因子等
  运行痕迹，这些表在载入时会被清空；
- 不含演示账号的口令哈希：口令列在种子中是固定占位值，载入时由
  `db:seed:demo` 统一重置为演示口令，并回读校验一次。

在已迁移到最新版本的空库上载入：

```powershell
# 新库必须先跑角色与 PGroonga bootstrap，再跑迁移
$env:MIGRATION_DATABASE_URL = 'postgresql://app_migrator@127.0.0.1:55432/app'
pnpm db:migrate

# 载入种子（默认连 127.0.0.1:55432/app，可用 SEED_DATABASE_URL 覆盖）
pnpm db:seed:demo

# 已有数据时需显式确认覆盖
pnpm db:seed:demo -- --force
```

`db:seed:demo` 在单个事务内清空业务表、按父到子顺序载入种子、重置演示账号
口令并打印各表行数；任一步失败即整体回滚。导出与校验命令：

```powershell
# 从演示库重新导出（需要 INPULSE_SEED_SOURCE_URL 指向演示库）
$env:INPULSE_SEED_SOURCE_URL = 'postgresql://cluster_bootstrap@127.0.0.1:55432/app'
node scripts/export-demo-seed.mjs

# 校验已提交的种子与导出规则一致（CI 与 pnpm check 使用）
pnpm db:seed:check
```

## 阶段 0 搜索 PoC

PostgreSQL 18.6 PGroonga V1 PoC（可选；需要 Docker，仅用于 CI/VM 探针复现，不是本地日常开发前置）：

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

脚本创建一次性源/目标容器，执行 `000_roles.sql` 与 `020_pgroonga.sql`、
显式迁移、现有数据库测试、搜索 PoC，并执行排除 Session 数据的
`pg_dump`/`pg_restore` 烟雾验证；成功时自动删除容器，也可传
`-KeepContainer` 保留。结果写入
`poc/search-pgroonga/artifacts/pgroonga-report.json`、
`poc/search-pgroonga/artifacts/pgroonga-backup-restore-report.json` 与
`poc/search-pgroonga/artifacts/pgroonga-migration-report.json`。
18.6 探针镜像上的 V1 语义、200 条冻结金标（phase4-v1）Recall@20、边界、跨项目隔离、默认
查询计划的 `ANALYZE/BUFFERS` 证据、`0000-0002 -> 0003-0006` 升级/逐迁移
回滚、旧 `pg_trgm` GIN/扩展清理和逻辑恢复均通过；旧
`pnpm db:poc:search:pgroonga:local` 仍保留为非 18.6 快速复现入口。

原 `pg_trgm` PoC 保留为决策证据：

```powershell
pnpm db:poc:search:local
```

该脚本使用 `postgres:18.6`；`Recall@20`、无结果、边界和跨项目隔离通过，
但参数化中文短查询的默认查询计划未使用 GIN trigram 索引，因此当前仍会
非零退出。完整结论见 [PGroonga PoC 说明](./poc/search-pgroonga/README.md)
与 [原 pg_trgm PoC 说明](./poc/search/README.md)。

## 功能开发必须遵守的事务契约

- 创建项目时，同一事务必须插入项目、创建者成员历史和唯一
  `kind='UNCLASSIFIED'` 模块；否则提交失败。三者使用数据库
  `now()` 默认值，不由客户端伪造时间；
- 新建任务时同一事务插入第一条 `task_status_history`。每次完成、重开、
  取消或恢复都追加连续历史；重开行保存上次完成时间与完成说明快照；
- 核心聚合每次更新必须令 `row_version = row_version + 1`，并在
  `WHERE` 中匹配调用方的期望版本；
- DRAFT 记录没有版本；发布时同一事务插入 v1，已发布编辑插入连续的新版本。
  当前标题和 payload 必须与 `current_version` 快照一致。VOID 期间不可编辑，
  恢复只能修改状态、并发控制字段 `row_version` 和更新时间；业务版本
  `current_version` 必须保持不变，并保留作废快照；
- ACTIVE 任务组在提交时必须恰有一个 ACTIVE MAIN 和至少一个 ACTIVE
  SOURCE；CLOSED 组不得有 ACTIVE 成员。解除最后一个 SOURCE 时，同一事务
  关闭组并解除 MAIN；
- 任务/记录影响功能只允许 MODULE scope。所有跨层关系携带
  `project_id` 并由复合外键拒绝跨项目串联；
- 编号只通过 `code_sequences` 的原子 UPSERT 分配。编号唯一、单调但不承诺
  无空洞；
- 审计先按 UTF-8 chain ID 顺序调用
  `audit_lock_head(chainId, projectId, initialKeyVersion)`，应用按 JCS-1
  信封计算 HMAC-SHA-256，再调用 `audit_append_locked(...)`。业务写、
  审计、通知、活动和搜索投影必须共用同一个事务；
- `app_runtime` 对原始审计表没有任何直接权限；审计查询使用独立
  `audit_reader` 连接，备份使用 `app_backup`，Session、CSRF、预认证和
  限流桶明确不授予备份读取权限。

应用 Repository 不得使用数据库级级联删除清理业务历史，也不得绕过
Workflow 的锁序与父级 ACTIVE 检查。当前数据库触发器负责最终结构防线，
授权、归档可写性、JCS/HMAC 密钥和跨域命令语义仍由应用层按技术设计执行。

## ADR-097 SSO 群组组织数据

迁移 `migrations/0061_contract_sso_casdoor_organizations.sql` 将组织来源与 SSO 群组路径纳入数据库：

- `app.organizations` 增加 `source`（`LOCAL` / `CASDOOR`）、`sso_owner`、`sso_group_path`、`sso_parent_path` 与自引用 `parent_id`。LOCAL 组织保留原名称唯一与管理员 CRUD；CASDOOR 组织以 `(sso_owner, sso_group_path)` 唯一，完整路径是同步身份。
- 新增 `app.user_organizations` 多对多成员表，主键为 `(user_id, organization_id)`，`source` 只允许 `MANUAL` / `CASDOOR`。本地账号旧的 `app.users.organization_id` 值迁移为 `MANUAL` 关系后删除该列；SSO 账号的旧归属不迁移，由下一次成功 SSO 登录按 `groups` 全量重建。
- 触发器保证 CASDOOR 组织本地只读、组织来源不可改写、成员关系来源与用户 / 组织来源一致；用户或组织删除时成员关系级联清理。`app_runtime` 获得成员表所需 DML 权限，`app_backup` 只读。
- `database/bootstrap/000_roles.sql` 把 `app_migrator` 的数据库级 `search_path` 设为 `RESET search_path`。迁移名均已用 `app.` 限定；若 `app` 可见，`pg_get_triggerdef()` 会省略函数 schema，令历史迁移 `0047_user_deletion_tombstone.sql` 的只读部署断言误判。该修改未触碰任何历史迁移。

本地验证：在全新数据库从 `000_roles.sql`、`020_pgroonga.sql` 开始由 `app_migrator` 执行迁移，全部迁移成功；`database/test/integration/database.test.ts` 覆盖多成员关系、CASDOOR 形状、来源错配、只读触发器与最小授权。

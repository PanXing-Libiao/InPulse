# Browser E2E

Playwright E2E 纵切片由 F-31 建立，当前覆盖 API 健康探针、真实认证
（登录、登出与 CSRF 生命周期）、F-03 用户管理（普通成员 403、
管理员编辑/停用/启用/强制删除）、项目创建关键路径
（登录 → 创建项目 → 项目动态 → 搜索 → 站内通知）、全局搜索边界
（跨项目隔离、空态、签名游标分页与中文短词/特殊标识符）、项目动态专属路径、
F-13 功能档案、F-14 功能级任务创建/分配/编辑、F-08 `/audit` 审计页（普通成员 403 与管理员读取）和站内通知已读/未读/全部已读联动等
可直接验证的路径。

## 前置条件

1. 已执行 `pnpm install --frozen-lockfile`。
2. 已准备 PostgreSQL 18 + PGroonga 实例，并完成 `000_roles.sql`、
   `020_pgroonga.sql` 与 `0000-0008` 迁移。
3. 已执行 `pnpm build`，使 `apps/api/dist/main.js` 可用。
4. 设置可写测试数据的 bootstrap URL，例如：

```powershell
$env:E2E_DATABASE_URL = "postgresql://cluster_bootstrap@127.0.0.1:55432/app"
```

5. 首次运行或机器未安装 Chromium 时，执行：

```powershell
pnpm --filter @inpulse/e2e exec playwright install chromium
```

可选端口通过 `E2E_API_PORT`、`E2E_WEB_PORT` 覆盖，默认分别为 3100 与 4173。

## 运行

```powershell
pnpm test:e2e
```

Playwright `webServer` 先启动已构建的 API（`node dist/main.js`，使用
`NODE_ENV=test`、`app_runtime` 数据库 URL 和临时 Session/幂等 keyring），再启动
Vite dev server，并把 `/api/v1` 代理到 API；`webServer` 会从 `E2E_DATABASE_URL` 派生并注入
`AUDIT_DATABASE_URL`（`audit_reader` 只读账号，`helpers/runtime.ts` 的 `auditDatabaseUrl()`），供
`/audit` 审计读取用例使用。`global-setup` 在服务就绪后创建唯一
E2E 用户、可见项目、无当前成员关系的隐藏项目与搜索投影并签发 Session；API 启动探针验证
`GET /api/v1/health`。失败时保留截图、trace 与 video。
需要管理员身份的用例通过 `admin-fixture` 为每个测试创建独立的临时管理员
（`is_admin = true` 与 Argon2id 口令），登录后即持有完整管理员 Session；
ADR-031 起高风险操作不再要求 TOTP 重认证，夹具因此不再注册 TOTP 因子。
该逻辑只作用于 E2E 夹具，不改变生产认证行为。

`global-teardown` 调用 `helpers/fixture-cleanup.ts` 物理删除 E2E 夹具：按
`e2e_` / `f03_`（Playwright）与 `user_` / `sso_` / `login_` / `invalidate_` /
`csrf_` / `backup_` / `archive_`（集成测试）账号前缀识别夹具用户，再按其
`created_by` 识别夹具项目，按依赖顺序删除全部业务数据、`PROJECT:` 审计链与
夹具账号，并在删除后用断言复核
夹具残留为 0、审计无悬空 actor、项目 bootstrap 成员关系完整、每个项目恰好一个
UNCLASSIFIED 模块，任一断言失败即回滚。数据库触发器禁止物理删除任何项目的
未分类模块，清理只在清理会话内以 `session_replication_role = replica` 关闭
行级触发器与外键检查；该开关只用于测试夹具清理，业务代码不得使用。

SYSTEM 链中夹具账号产生的记录会一并删除并把链头回退到剩余的最后一条记录；
若夹具记录之后已有真实用户写入，链上会留下一个可检测的断点并打印提示（删除
链中段无法在保持哈希链完整的前提下完成）。运行被中断（如 Ctrl+C）未触发
`globalTeardown` 时，用 `pnpm --filter @inpulse/e2e cleanup` 或
`node apps/e2e/helpers/fixture-cleanup.ts` 手动补跑；两者都需要
`E2E_DATABASE_URL` / `TEST_DATABASE_URL` 指向 bootstrap 角色。

## CI

GitHub Actions 的 `CI / workspace` job 在 `pnpm build` 之后、`pnpm check:deps`
之前安装 Chromium 并执行 `pnpm test:e2e`，此时 PostgreSQL 探针实例仍在运行。
无论成功或失败都会上传 Playwright HTML 报告、截图、trace 与 video 作为 CI
artifact。当前为 54 个用例、27 个 spec 文件，已覆盖
F-03 用户管理、F-05 项目成员管理（普通成员 403、管理员添加/移除与不存在项目读取
边界）、项目创建关键路径、F-13 功能档案、F-14 功能级任务、F-16 任务状态闭环、
F-08 `/audit` 审计页（普通成员 403、管理员读取与筛选）、F-17 独立草稿、
F-18 记录发布、搜索边界、F-27 项目动态专属路径与 F-28 通知状态联动；本地全量
`pnpm test:e2e` 53/53 通过（9.3m），CI 见 [PR #133](https://github.com/256-code/InPulse/pull/133) 检查记录。

`pnpm test:e2e` 以 `node dist/main.js` 启动 API，本地复跑前必须先执行
`pnpm build`：本次曾用陈旧 `apps/api/dist` 跑出两条既有 F-18 用例失败（旧产物
缺少发布端点），重新构建后全绿；仍不等同于完整业务关键路径。

## 范围说明

当前意图是建立可重复的浏览器自动化基座，不等同于完整业务关键路径。任务完成、
合并/解除合并等场景需要在对应业务模块交付后逐条加入。

## 新增业务场景

新增场景时复制 `templates/business-critical-path.template.ts` 到
`tests/<domain>.spec.ts`，再替换用例名称与断言。模板已经包含真实登录上下文、
唯一 fixture 复用、失败截图/trace 配置和上下文清理示例；不要把模板直接作为
已交付用例运行，也不得用 `test.skip` 或 `test.fixme` 掩盖未完成行为。写场景时
应使用生成客户端访问 API，并为写操作补齐 409/422 与幂等重放断言。

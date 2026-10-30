# Modules 项目初始化 CommandPort

## F-12 模块管理本地交审（2026-09-09）

新增独立 `ModulesManagementModule` 装配列表、创建、编辑、归档、恢复 HTTP 纵切片；保留下面的项目初始化 Port 与下级写前 QueryPort 原边界。

2026-09-23 [ADR-044](../../../../../docs/adr/ADR-044.md) 起模块层面归档整体下线：`ModulesManagementModule` 只剩列表 / 创建 / 编辑，`archiveModule`、`restoreModule`、`ModuleArchiveRequest` 与 `MODULE_ARCHIVE_TASKS_OPEN` 已删除，`app.modules.status` 只有 `ACTIVE`；下文与 [F-12 本地交审](../../../../../docs/f12-local-handoff.md) 中「归档 / 恢复 / 管理员重认证」的描述为当时事实。
完整接口、未分类可编辑规则、单事务/重放授权、前端入口与实际验证记录见 [F-12 本地交审](../../../../../docs/f12-local-handoff.md)。
当前针对性单元验证通过，真实数据库/HTTP 集成和 Playwright 已写用例但未运行，不能据此宣称完整验收通过。

以下为原 Port 的历史接入说明。

本模块提供事务内模块写前检查；`createUnclassifiedModule` Port 为兼容保留——ADR-030（2026-09-14）起项目创建不再写入任何模块，生产路径已无调用方，仅模块命令集成测试使用。

## 事务内 ModuleQueryPort（数据库 CI 通过，待人工评审）

公开入口 `./index.ts` 导出 `ModuleQueryPort`、`CheckModuleForWriteInput`、
`ModuleForWriteResource`、`ModuleWriteCheckResult`；`ModulesModule` 导出抽象类注入 token。
调用方在 Nest imports 中加入 `ModulesModule`，使用 `@Inject(ModuleQueryPort)` 注入。

```typescript
checkModuleForWrite(
  tx: TransactionContext,
  input: { projectId: number; moduleId: number },
): Promise<ModuleWriteCheckResult>;
```

结果为 `{ kind: 'allowed', resource }` 或 `{ kind: 'not-found' }`（ADR-044 起模块无归档态，
原来的 `parent-not-active` 已删除）。摘要仅含 `moduleId`、`projectId`、`rowVersion`，
ID 与版本沿用 Schema 的 integer/number；不存在或项目归属不匹配时不返回摘要。

适配器只查询 `app.modules`，按 ID 与项目归属取得 `FOR SHARE` 后确认存在性；
锁随调用方事务提交或回滚释放。无事务创建、全局 Client、认证或成员查询。
数据库错误原样向事务调用方传播，由外层决定安全的 HTTP 映射，禁止泄露数据库错误文本。
此接口只用于事务内写前检查，不能用于普通详情读取（模块自 ADR-044 起已无归档操作）。
调用方必须先通过 A 的身份解析和项目授权，按项目 → 模块顺序持锁；
多资源同层按 ID 升序，任一步非 allowed 必须停止后续业务写入。

完整调用顺序见本模块 ModuleQueryPort 与项目侧 ProjectAccessQueryPort。
新增 `write-query-ports.integration.test.ts` 的 6 个真实数据库用例已在提交 `58acbe7` 的 CI 中实际通过（334 ms），
证据见 [本次数据库日志](https://github.com/256-code/InPulse/actions/runs/34210258609/job/102009300977?pr=42#step:17:28)。本地 Nest 注入验证已通过；待 A/C 人工评审。

当前验证状态：2026-09-08，提交 `e826483` 的
[CI / workspace](https://github.com/256-code/InPulse/actions/runs/34200874889)
通过；PostgreSQL 18.6 + PGroonga 隔离库的
[数据库测试日志](https://github.com/256-code/InPulse/actions/runs/34200874889/job/101979120660?pr=34#step:17:29)
确认 `modules-command.integration.test.ts` **5/5 实际通过，155 ms**，未使用 Mock。
CI 通过根级 `pnpm test:integration` 调用 API 的相同 Vitest 集成配置执行该文件。
本机依然没有数据库环境；下文保留本地失败历史。PR [#34](https://github.com/256-code/InPulse/pull/34)
已由维护者 `256-code` 合并为 `22c6248`，代理未执行合并。

依据：[ADR-013](../../../../../docs/adr/ADR-013.md)、
[数据库事务契约](../../../../../database/README.md#功能开发必须遵守的事务契约)。

公开入口为 `apps/api/src/modules/modules/index.ts`。WorkflowModule 在 Nest
`imports` 中加入 `ModulesModule`，Workflow 用 `@Inject(ModulesCommandPort)`
注入同名抽象类 token。Repository 和 Service 不从公开入口导出，根 AppModule 未接入。

```typescript
createUnclassifiedModule(
  tx: TransactionContext,
  input: CreateUnclassifiedModuleInput,
): Promise<CreateUnclassifiedModuleResult>;
// input: { projectId: number; createdBy: number }
// result: { moduleId: number }
```

ID 类型取自现有 modules Schema；`createdBy` 由受信任 Workflow 传入。
名称固定为“未分类模块”，身份固定为 `UNCLASSIFIED`；数据库默认值提供
空描述、ACTIVE、排序 0、版本 1、空归档时间以及 `now()` 创建/更新时间。
已有 fixture 中的“未分类”并非名称约束，技术设计以不可变 kind 判定身份。ADR-030 起项目创建流程不再调用该 Port，新项目允许零模块，Port 与未分类数据仅为兼容与回归测试保留。

以下是位于 `apps/api/src/workflows/` 的**接入示意**，其中项目创建、成员写入和后续步骤
仍由 A 实现；不是已交付 Workflow：

```typescript
import { ModulesCommandPort, ModulesModule } from "../modules/modules/index.js";

// Nest: @Module({ imports: [ModulesModule], ... })
// Workflow constructor: @Inject(ModulesCommandPort) private readonly modules: ModulesCommandPort
await this.unitOfWork.run(async (tx) => {
  // A 在此使用同一 tx 创建项目、创建者及项目成员，得到 projectId、creatorId。
  const { moduleId } = await this.modules.createUnclassifiedModule(tx, {
    projectId,
    createdBy: creatorId,
  });
  // A 继续以同一 tx 写审计、通知与投影；任一步失败必须向外抛出。
  return { moduleId };
});
```

事务所有权只在调用方。Port 和 Repository 只使用传入的 `tx.sql`，不创建
UnitOfWork、不提交、不使用全局客户端。项目与创建者成员历史必须同事务写入并
保留数据库 `now()` 默认值，确保延迟初始化约束通过。授权、项目成员有效性、
项目可写性和外层幂等仍由 Workflow 负责；此 Port 不作为普通模块创建入口。

重复创建不视为幂等成功。PostgreSQL `23505` 且约束为
`modules_one_unclassified_unique` 或 `modules_name_project_unique` 时，抛出公开的
`UnclassifiedModuleConflictError`（`status=409`、`code=UNCLASSIFIED_MODULE_CONFLICT`、
固定安全消息）。其他错误原样向 Workflow 传播；不存在项目由
`modules_project_fk` 拒绝（`23503`）。不得捕获后继续提交，必须使外层 UoW 回滚。
HTTP 错误信封、requestId、外键错误映射和未知异常脱敏由 A 的外层处理，
不得直接向用户返回数据库异常文本。本次没有 HTTP 路由或认证链路改动。

复用现有 PostgreSQL 测试基座，仅在已 bootstrap、已迁移全部历史的隔离测试库执行：

```powershell
pnpm --filter @inpulse/api exec vitest run --config vitest.integration.config.ts test/modules-command.integration.test.ts
pnpm --filter @inpulse/api exec vitest run test/modules-module.test.ts
```

数据库测试用 `app_runtime` 写入并在事务结束后独立查询，覆盖成功、后续失败回滚、
同事务重复回滚、已提交项目重复拒绝和不存在项目。fixture 使用随机编码，
不禁用触发器、不删除业务历史；成功 fixture 随隔离测试实例整体销毁。
2026-09-08 本地 Nest 注入测试 1/1 通过；数据库套件因缺少
`TEST_DATABASE_URL` 在 beforeAll 失败，5 个行为断言均未执行，仍需在具备
PostgreSQL 18 + PGroonga 的隔离实例或 CI 验证。

2026-09-08 14:29 +08:00 按上述数据库命令再次执行，退出码 1：
beforeAll 仍因缺少 `TEST_DATABASE_URL` 失败，5 例均未实际执行，状态保持**待验证**。
环境复查：`POSTGRES_BIN` 未配置；PATH 未找到 docker、podman、psql、postgres，
默认 PostgreSQL/Docker 安装位置未发现工具；`wsl --list --quiet` 返回 1，提示 WSL 未安装。
未连接未知数据库、未用 Mock 或 Nest 注入测试替代数据库验证。

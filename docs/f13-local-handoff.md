# F-13 功能档案本地交审

> 2026-09-15 注：[ADR-031](adr/ADR-031.md) 已移除全部 TOTP 验证与管理员高风险重认证；本文件是当时交付事实的历史交审记录，其中「密码/TOTP 重认证」「`AdminReauthenticateModal`」「双时间戳门禁」等描述不再代表现行行为（现行门禁为有效完整管理员 Session + `is_admin` + 写操作 CSRF/幂等）。
>
> 2026-09-24 注：功能归档与恢复已由 [ADR-045](adr/ADR-045.md) 整体下线（功能只有 `ACTIVE`，`archiveFeature` / `restoreFeature` 两条路由与 `FeatureArchiveRequest` 已从契约删除，功能卡与编辑弹层不再有归档入口）；项目归档、模块归档此前已分别由 [ADR-043](adr/ADR-043.md)、[ADR-044](adr/ADR-044.md) 下线。下文「七个接口」的路由表、`ACTIVE / ARCHIVED` 状态语义与「归档后只读 / 恢复」描述均为 2026-09-09 交审时的事实，现行只有 `listFeatures` / `getFeature` / `findSimilarFeatures` / `createFeature` / `updateFeature` 五个接口。
2026-09-09，B，分支 `dev/b`。本地实现完成，等待非作者审核；没有提交、推送、开 PR 或合并。开工 HEAD、origin/dev/b、origin/main 的本地引用均为 `58abb407a958c3e09d129b8ea0e1086727847d2f`；本轮没有 fetch 或改变分支基线。

## PR 交付准备（2026-09-09）

本地审核已通过，未发现阻断项；审核对话独立复跑真库 21/21、契约/权限 16/16、前端 16/16、Edge E2E 2/2，均通过。以上为已执行的审核证据，本次交付未重复运行。默认 Playwright Chromium 与本 PR CI 尚未验证。

fetch 后将 dev/b 从 `58abb40` 快进至实际 origin/main `8b895e1`，创建 `codex/f13-feature-management`。完整目录备份与 include-untracked stash 均保留；恢复无冲突，F-13 源码、测试、生成物哈希一致，业务行为未变。主线新增 F-12 审计并发和搜索 E2E fixtures，组合结果由既有 CI 验证。本次只提交 F-13，README 原导航与未跟踪协作方案继续留在原工作区，排除出 PR。

交付后重点请 A 审查 ProjectCodePort 编号分配及 ProjectsModule 装配；B/C 审查 ModuleReadPort、FeatureCandidatesQueryPort、应用装配及生成客户端。完成 CI 后交由 A/C 非作者人工评审，不自行合并，不宣称后续任务/记录/链接/遗留问题及关联统计已实现。

以下为本地交审时点的实现与验证记录。

## 用户流程与入口

- `/projects/:projectId/modules` 的模块卡片新增“功能列表”。
- `/projects/:projectId/modules/:moduleId/features` 提供列表、加载/空态/失败重试、新建、编辑和管理员状态操作；“查看详情”进入 `.../features/:featureId`。
- 创建表单填写名称、当前说明、标签；350ms 防抖查询当前项目最多 10 个关键词候选，可打开已有功能或继续保存。查询使用取消信号和名称独立缓存，输入变化后不显示旧结果；候选存在或查询失败不阻止合法创建，同名功能允许。
- 详情显示编号、真实项目/模块归属、创建人、状态、当前说明及标签；普通成员可编辑，身份字段不可改。说明修改保存前后快照到不可变审计，不自动生成迭代记录。
- 管理员填写原因，复用密码/TOTP 安全验证弹窗执行归档/恢复；归档保留历史且禁止本功能编辑和下级写前检查，恢复仅恢复功能自身，要求项目和模块 ACTIVE。
- F-12 三方合并语义保留：编辑前快照、草稿、最新数据分别保存；未修改字段取最新，双方修改同字段且值不同时必须选择。冲突解决后才使用最新 If-Match；归档/失权时保留草稿并拒绝保存。成功刷新功能列表/详情、候选、活动和搜索缓存；同语义不确定失败复用 Key，语义改变或成功后换 Key。
- 任务、迭代记录、GitHub 链接、遗留问题的关联业务及统计仍由后续功能交付，本轮没有假数据、虚假 0 统计或无效业务入口。没有业务接收人规则，因此不新增通知事件。

## 七个接口与契约

统一前缀 `/api/v1`，集合路径记作 `/projects/{projectId}/modules/{moduleId}/features`。成功均 200；读取返回 `Cache-Control: no-store`，写响应也不缓存。错误统一 ErrorResponse，并返回匹配的 X-Request-Id。

| operationId | method / path | 成功 Schema | 主要门禁 |
|---|---|---|---|
| listFeatures | GET 集合 | FeatureListResponse | 当前项目可读、模块归属正确，含归档，id 升序 |
| getFeature | GET 集合/{featureId} | FeatureItem | 完整真实归属，含归档 |
| findSimilarFeatures | GET 集合/similar?q=... | FeatureListResponse | 当前项目可读；q 为 2–200 字；最多 10 个关键词候选 |
| createFeature | POST 集合 | FeatureItem | 项目/模块 ACTIVE、CSRF、幂等；服务端分配编号/创建者 |
| updateFeature | PATCH 集合/{featureId} | FeatureItem | 父级及自身 ACTIVE、If-Match、CSRF、幂等 |
| archiveFeature | POST 集合/{featureId}/archive | FeatureItem | 管理员五分钟双因子重认证、原因、ACTIVE → ARCHIVED |
| restoreFeature | POST 集合/{featureId}/restore | FeatureItem | 同上、ARCHIVED → ACTIVE；不恢复下级 |

创建/编辑只接受 `name/currentBehavior/tags`，分别遵守 500 字、50000 字和 50 个标签上限。状态操作只接受 `reason`（1–2000 字）。不存在、非成员、已移除成员或完整归属不符统一 404；匿名/停用 Session 401；普通成员管理员操作 403；版本、状态或编号冲突 409；字段错误 422。

`features.zod.ts`、`feature-routes.ts`（ADR-109 已移除）、可执行权限矩阵和 Controller 绑定同步；OpenAPI、客户端、指纹只通过 `pnpm contract:generate` 生成，5 个生成物漂移检查通过。

## 数据库、事务和公开能力

没有新增迁移，没有修改历史迁移、约束、数据库权限、生产依赖或 lockfile。现有 features 已有 tags/created_by/archived_at/row_version，项目内编号唯一、完整归属复合 FK、身份不可变和版本触发器；名称没有唯一约束。

编号冲突 F13-001 已由用户定案：按现有 `features_code_check` 使用 `SHOP-F-3`，不补零，并同步功能设计示例。最初误判 tags 不存在，实际迁移和 Drizzle Schema 均有；以后一次澄清为准，本轮实现标签。功能设计 §27.6 补齐 tags 摘要。

- A 现有 ProjectAccessQueryPort 提供实时成员/管理员授权及父项目 FOR SHARE。新增 [ProjectCodePort](../apps/api/src/modules/projects/project-code.port.ts) / [适配器](../apps/api/src/modules/projects/postgres-project-code-port.ts) 是项目编号基础设施公开入口：从真实项目取前缀，复用 code_sequences 的事务内原子 UPSERT。它不创建事务、不改变项目业务状态；编号碰撞返回安全 409，整个命令回滚，由管理员核对导入历史与序列表。
- B 复用 ModuleQueryPort 获取父模块 FOR SHARE；新增 [ModuleReadPort](../apps/api/src/modules/modules/module-read.port.ts) 查询历史归属，不施加 ACTIVE 写门禁。既有 FeatureQueryPort 不变；Tasks/ChangeRecords 可继续使用其归档拒绝能力。
- C 复用 AuditWritePort、ActivityWritePort、SearchProjectionWritePort；新增 `FeatureCandidatesQueryPort`（ADR-109 已移除） 在 SQL LIMIT 前按服务端授权的当前项目、FEATURE/MEMBER 过滤，使用规范化文本与转义 PGroonga 查询，不提供模糊语义或正则匹配。
- 一个命令由 IdempotencyHttpService 创建一个外层 UnitOfWork；同一 tx 传到 Session/CSRF、授权、编号、功能行、审计、活动、搜索及幂等。项目 → 模块 → 功能依次加锁；功能 UPDATE 使用 FOR UPDATE 与条件 row_version 并递增。没有事务内网络请求，也没有访问其他领域内部 Repository。
- 重放重查 Session/CSRF、当前权限、结果真实归属、父级可写性及必要重认证；重复归档的原成功可以重放，不重复执行状态迁移。活动使用审计链来源去重；搜索索引编号、名称和当前说明，标签保存展示但不纳入本轮搜索承诺。投影状态随归档/恢复更新，历史仍可读。

## 实际验证

最终针对性结果：

| 实际命令 | 结果 |
|---|---|
| `pnpm --filter @inpulse/api exec vitest run --config vitest.integration.config.ts test/features-api.integration.test.ts test/write-query-ports.integration.test.ts` | 2 文件 **21/21**，其中 F-13 **15/15**，公开 Port 回归 **6/6** |
| `pnpm --filter @inpulse/api-contract exec vitest run test/features.test.ts test/permissions.test.ts` | 2 文件 **16/16**，含七路由显式 Controller 扫描断言 |
| `pnpm --filter @inpulse/web exec vitest run src/features/features/FeaturesPageView.test.tsx src/features/features/SimilarFeatures.test.tsx src/features/modules/ModulesPageView.test.tsx` | 3 文件 **16/16**，F-13 **9** 例、F-12 回归 **7** 例 |
| `pnpm --filter @inpulse/e2e exec playwright test tests/features.spec.ts --config .e2e-runtime/playwright.edge.config.ts` | 本机 **Edge 2/2**；最终合跑 34.7 秒，成员/管理员两条完整 UI 路径 |
| `pnpm contract:generate`、`pnpm contract:drift`、`pnpm contract:validate` | 5 个生成物一致，35 条路由策略/绑定通过 |
| `pnpm --filter @inpulse/api-contract exec tsc -p tsconfig.build.json`；`pnpm --filter @inpulse/database exec tsc -p tsconfig.build.json`；`pnpm --filter @inpulse/api exec tsc -p tsconfig.json` | 仅 E2E 必要的依赖包/API 局部编译通过，没有执行根级或 Web 生产构建 |
| API `tsc -p tsconfig.test.json --noEmit`；Web `tsc -p tsconfig.json --noEmit`；E2E `tsc --noEmit` | 局部包类型检查通过 |

仅格式化本轮改动的 TS/TSX 文件。未运行全量构建、全仓静态检查、无关审计、全量测试、默认 Playwright Chromium 或 GitHub Actions；以上结果不代表 CI 或人工审核通过。

真库覆盖：七接口、同名继续创建、12 请求跨模块并发编号、跨项目/跨模块/非成员/被移除/匿名/停用、CSRF/Key、管理员及重认证过期、项目/模块/功能归档拒绝、恢复不改变归档任务、同 Key/输入变化/If-Match 变化/失权重放、旧版本 409、不可变说明审计且无记录、审计/活动/搜索失败业务/序列/幂等整体回滚、项目和模块真实锁等待后重查 ACTIVE。E2E 包含两真实页面不同字段自动合并与同字段明确选择，刷新证明持久化。

失败与修复记录：契约和前端首测分别因缺少新 Schema/组件失败，再实现；编号碰撞回归先得到 500，再补精确约束 409 映射。数据库 fixture 曾遗漏用户版本递增和任务初始状态历史，按既有约束补齐，未禁用触发器或削弱断言。Controller 扫描最初仍预期 28 条路由，补入七条精确绑定后通过。首次真库命令遗漏 TEST_DATABASE_URL 导致 beforeAll 失败，没有业务测试执行。前端 jsdom 有既有伪元素 getComputedStyle 提示，不影响断言。

管理员 E2E 初次失败是启动环境问题：误把 NODE_ENV=test 同时传给 Vite，Ant Design 弹窗共用测试 ID，影响 accessible name；移除父进程该环境变量（现有配置仍单独给 API 设置 test）后完整 2/2 通过。临时诊断输出已移除，没有以放宽定位断言或修改公共弹窗绕过。

## 环境与审核关注

复用用户指定的 `$env:TEMP\inpulse-f12-pg18` 已知隔离库，PostgreSQL 18.6 + PGroonga 4.0.8；仅监听 127.0.0.1:55432、数据库 app、max_connections=150，业务测试使用 app_runtime 和 audit_reader。未连接来源不明数据库，也未读取生产 Secret。交审前已用 pg_ctl fast stop 停止临时实例，未删除测试数据或工具。复跑先以原路径 pg_ctl -D data -l postgresql.log -o "-h 127.0.0.1 -p 55432 -c max_connections=150" -w start 启动，真库测试设置 TEST_DATABASE_URL，E2E 设置 E2E_DATABASE_URL；两者指向该已知本地 app 库。启动 E2E 的父进程不要设置 NODE_ENV=test，API 的测试环境由现有配置单独提供。沿用既有 Edge 临时配置，未改共用 E2E 配置。E2E keyring/截图/trace 留在既有忽略目录，不提交。

审核重点：

1. `FeaturesManagementService` 与 `features-http.service.ts`（ADR-109 已移除）：锁序、错误优先级、重放门禁、快照和投影整体回滚。
2. A 审查新增项目编号公开基础设施和 ProjectsModule 装配；无数据库迁移待审。
3. C 审查搜索公开候选端口、AppModule 装配、生成客户端以及 `features.spec.ts` 浏览器路径（ADR-109 已移除）；没有公共布局或设计系统重构。
4. `FeaturesPageView.tsx` / `feature-query.ts`（ADR-109 已移除）：三方冲突、标签保留、幂等 Key 与状态操作；`SimilarFeatures.tsx` 相似提示（ADR-109 已移除） 的过期请求隔离。
5. 当前列表沿用全列表返回，未引入分页或规模性能承诺；关联统计/任务/记录/链接/遗留业务和对应 E2E 仍由后续功能完成。

原用户修改 `README.md`（仍为原 1 行导航增量）与 `docs/three-person-ai-delivery-plan-v2.md`（原未跟踪文件）没有改写。所有 F-13 修改仍未暂存、未提交，等待审核对话接手。

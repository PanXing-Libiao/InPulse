# F-16 任务状态与历史本地交审（2026-09-10）

工作区 `C:\Users\10348\.codex\worktrees\610b\InPulse`，分支 `codex/f16-task-status`，从 fetch 确认的 `origin/main bce3337` 创建。基线包含 F-14/F-15、项目和成员管理以及最新视觉，不重放先前已 squash 的本地提交。本批仅本地提交交审，不自行推送、创建 PR 或合并。

代码提交：`125ea8f9307e01eacf04d3204cf596a9eeb6d515`。文档提交跟随代码单独提交；最终 HEAD 以交审消息为准。

## 范围与 F-19 边界

FEATURE 和 MODULE 共用四条状态迁移：TODO→DONE（COMPLETE）、DONE→TODO（REOPEN）、TODO→CANCELED（CANCEL）、CANCELED→TODO（RESTORE）。其他迁移及非 ACTIVE 生命周期返回 409；不删除任务、既有关联或记录。MODULE 影响功能不是父级，既有归档影响可以随任务状态保留，功能引用页仍引导到真实模块任务入口。

服务端严格 Schema 和 Application Service 都校验完成命令：仅 `mode: WITHOUT_RECORD`，完成原因只接受功能设计 §15.4 的测试验证、技术调研、文档补充、环境配置、沟通协调、其他。可附加说明，组合成“原因，不涉及功能变化：说明”并保存。取消、恢复、重开的原因可选；空输入规范为 null。

实际功能变化选择不发送完成命令、不伪造发布/跳转，界面说明此能力尚未开放，任务保持 TODO。该边界已获协调认可。F-17 合入后接真实草稿保存路径，保存仍不得完成任务；WITH_RECORD 发布与完成的组合事务留给 F-19。当前 WITHOUT_RECORD 完成通知创建人与全部负责人，重开通知负责人和创建人并去重；有关记录作者的发布/组合通知在记录域接入后实现。

## 接口、事务与历史

新增 `transitionTask` / `transitionModuleTask`：真实 FEATURE/MODULE 资源路径下 POST `/{taskId}/status`。请求使用 TaskStatusRequest，响应复用 TaskItem/ModuleTaskItem。新增 `getTaskStatusHistory` / `getModuleTaskStatusHistory`：GET `/{taskId}/status-history`，按数值历史 ID 正序返回初始状态及所有后续迁移、操作者、变更时间、完成时间/说明快照和原因。所有响应 no-store。

新写路由要求 Session、同源、CSRF、Idempotency-Key、If-Match，契约版本 1.0.0；原创建/编辑请求、响应和已提交的幂等指纹没有改变。幂等重放先检查当前身份、权限、真实归属、父级可写性，MODULE 还检查已存结果中的影响资源可读性，再返回缓存成功结果。Schema/Route Registry、Controller、权限矩阵和生成物同步。

沿用一个 UnitOfWork/TransactionContext。项目→模块→FEATURE 父级 FOR SHARE 后任务 FOR UPDATE；MODULE 复用当前影响集合升序锁、任务锁后重读和最多三次 savepoint 重试，既有归档影响不作为不可写父级。锁内验证版本和状态；Repository 只执行条件更新和历史持久化。状态、row_version、不可变历史、审计 `task.status`（payload 含具体命令）、活动、搜索和适用通知同事务提交或回滚。状态更新不修改负责人，失效成员可继续作为历史负责人保留。

完成时在数据库内生成时间；重开清空当前 completed_at/completion_note，但把上一轮完成时间和说明写入本次历史快照，changed_at 即重开时间。再次完成追加新快照。SQL CTE 保持数据库时间精度，锁后 clock_timestamp 与原 updated_at 取较晚值，避免先开始、后获得锁的事务使用旧 now() 造成历史时间倒退。沿用既有 deferred 历史连续性/完成快照约束和只插入权限；无新迁移、历史迁移修改、数据库权限或核心依赖变更。

前端详情提供状态操作和完整状态历史，默认列表为 TODO，可切换 DONE/CANCELED/全部；本批不展示或计算完成率。当前列表包含无效任务且 DTO 无历史来源分支身份；未来正式统计必须按功能设计 §29.2 排除取消、无效及历史来源分支，不能用当前列表比例代替。完成/取消不会失去详情和搜索入口。409 后保留说明和选择，加载最新任务后明确确认，最新状态不支持原命令时阻止提交；不确定失败沿用同语义幂等 Key。

## 实际验证

独享 PostgreSQL 18/PGroonga 为 `127.0.0.1:55424/inpulse_f14`，数据目录 `%TEMP%\inpulse-f14-610b\data`。恢复启动时发现未传端口而落到 5432，读取实际 data_directory 确认为本任务目录后仅停止自己的实例，以 `-o "-p 55424"` 重启；未操作其他数据库。E2E 使用 API 3114/Web 4184，进程由 Playwright 管理。

验证完成后再次核对 data_directory，仅停止本任务 55424 实例；端口已无监听，数据保留供复核，未清理测试目录或其他服务。

| 命令或范围 | 实际结果 |
|---|---|
| API `vitest run --config vitest.integration.config.ts test/tasks-api.integration.test.ts` | 41/41：F-16 13 例及 F-14/F-15 28 例 |
| Web `vitest run src/features/tasks/TasksPanel.test.tsx src/features/modules/ModulesPageView.test.tsx src/features/features/FeaturesPageView.test.tsx` | 25/25（任务9 + 模块/功能16），包含实际变化禁止提交、409 保留输入/新版本、状态筛选与历史保留（完成率展示已按增量审核移除） |
| api-contract `vitest run test/tasks.test.ts test/module-tasks.test.ts test/permissions.test.ts` | 18/18 |
| `contract:generate`、`contract:validate`、`contract:drift`、`permissions:check` | 5 个生成物由工具生成且无漂移，61 路由/操作策略通过 |
| Edge `playwright test --config .e2e-runtime/playwright.edge.config.ts --project=edge tests/task-status.spec.ts` | 2/2，1.1 分钟；FEATURE/MODULE 状态闭环、6 条历史、刷新和搜索 |
| api-contract/API 的 E2E 必要局部 tsc 编译；API 测试、Web、E2E 局部类型检查 | 通过 |

新增真库覆盖连续完成→重开→再次完成、取消/恢复原因、历史不可更新/删除、非法状态/模式/字段、匿名/CSRF/错误归属/父级归档、重放和权限撤销、并发完成/取消只成功一方、MODULE 历史影响保留、完成/取消搜索投影、四类副作用失败完整回滚后同 Key 重试、先开始后重开的时间单调性、通知收件人和已移除历史负责人。原 F14/F15 锁竞争与影响关系用例同时回归。

仅定向验证；未运行全仓静态检查、全量构建、全量测试、依赖审计、本批 CI 或默认 Chromium。Web 测试使用带字段标签的对话框定位，避开 Ant Design 在 NODE_ENV=test 下嵌套弹层重复 test-id 的已知限制；真实 Edge 按对话框名称断言通过。新增长 Controller 装饰器保持单行字面量，以兼容既有绑定扫描器。没有弱化断言或跳过失败用例。

待非作者审核状态与快照、锁序、MODULE 归属、结果重放权限及新增 API/界面。交审后冻结本批，收到合并通知并同步最新 main 后才启动 F-17。


## 增量审核修复：撤下不完整完成率（2026-09-10）

协调指出原比例只过滤 CANCELED，仍计入 INVALID，且 TaskItem 不含历史来源分支身份。已移除计算和展示，保留状态筛选、全部生命周期历史读取；未来正式统计必须排除取消、无效和历史来源分支，本批不扩展跨域查询或后续统计。

新增无效历史 fixture 和无完成率展示断言，先复现原错误67%显示，修复后任务面板9/9通过，git diff --check通过。仅前端定向回归，未重复真库。协调独立复核反馈：tasks-api.integration.test.ts 41/41、4.20秒；核对实际 data_directory 为本任务目录后正常停止其恢复的55424实例，数据保留。此为协调复核证据，本增量修复没有操作数据库。

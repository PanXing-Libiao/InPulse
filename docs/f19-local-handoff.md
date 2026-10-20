# F-19 本地交审说明

## 范围与基线

分支 `codex/f19-task-completion` 开工时工作区干净，成功 fetch 后从 `origin/main` `5020c0a732a7b63d869f9ff418f5bd779dd951e0` 新建。该主线已包含 F-18 PR #82、F-23 TaskReadModel/TaskGroup 及 CI 提速；保留 F-18 通过公共 index 导入投影模块的修正，没有重放旧 F-18 提交。

收尾再次 fetch 因 443 连接超时失败；协调随后成功 fetch 并确认远端 main 仍为上述基线，无待同步交集。

本批只实现 F-19 完成任务并发布记录：WITHOUT_RECORD 沿用 F-16 六类原因和补充说明；WITH_RECORD 明确选择内联记录或一条已有草稿，不可同时提交。F-20 转任务入口尚未实现，F-21 不在范围；F-19 审核/PR/CI/合并前不启动 F-20。

F-18 最终事实补记：PR #82 merge 5020c0a，最终 head ab96562d6222d2cd75bbdecbf95dd1fb95a0bbc5；[workspace](https://github.com/256-code/InPulse/actions/runs/34443392933) 成功 12m35s，E2E 步骤 5m1s（未获取精确用例数）；[docs](https://github.com/256-code/InPulse/actions/runs/34443393028) 成功 7s。由维护者合并，PR 任务没有点击合并或修改保护。

## 契约、端口和事务

新增 `POST /api/v1/tasks/{taskId}/complete`（completeTask），按 taskId 解析真实项目/模块/功能并实时授权。请求包含 expectedRowVersion，If-Match 必须与其一致；WITHOUT_RECORD 传 completionReason/note，WITH_RECORD 传 record 或 recordDraftId/recordExpectedRowVersion。新路由完整登记同源、CSRF、幂等摘要/安全重放和实时授权策略；返回 task 与可空 record，null 对象分支纳入白名单。

TaskCompletionWorkflow 只调用稳定公开端口：新增 TaskCompletionCommandPort、TaskBranchQueryPort，以及 RecordDraftCommandPort.bindForCompletion、RecordDraftQueryPort.lockDraft/authorsForTask；复用 RecordPublicationCommandPort.publish/replay。Controller 调用组合 Use Case，IdempotencyRunner 创建唯一 UnitOfWork，所有调用显式传同一 TransactionContext，没有独立 HTTP 发布请求或跨域内部 Repository 访问。

预读任务、草稿和组身份，完整锁定 project→module→排序功能并集→task→当前 taskGroup→record，再逐项重读；变化时回滚 savepoint 并从头最多重试三次。功能并集包括任务当前影响、草稿历史影响及重放暴露影响；记录绑定/新建及发布端口再校验的全部前序资源已经持锁，不引入新的前序锁。组仅读身份并锁定，不改成员或其他任务；合并/解除按既有约定先持相关任务锁再持组锁，因此此命令不需要锁全部组成员任务。真库通过实际等功能锁时另事务 FOR UPDATE NOWAIT 成功取得任务锁，验证功能锁在任务锁之前。

任务必须 ACTIVE/TODO 且版本匹配；草稿必须 DRAFT、同 project/module/scopeType，FEATURE 同 feature，task_id 为 NULL 或本任务。独立草稿只做 NULL→当前来源绑定，作者/处理人/归属/影响快照不变；绑定其他任务拒绝。MODULE 历史已归档影响可保留，不迁移为任务当前影响；内联按锁后任务快照推导身份/影响。已有多条草稿/正式记录不阻止本次新记录。

先绑定/创建本次记录并收集全部相关作者，随后条件完成任务和状态历史；同事务调用发布端口时来源已 DONE，再生成正式编号、v1、稳定遗留项与版本快照。所有审计、活动、搜索、通知及幂等结果共用该事务，任何异常离开 UnitOfWork 回滚。任务完成和记录发布为两种业务事件，各自去重且实时过滤收件人权限；完成通知任务创建人、全部相关记录作者（包括本次）与全部任务负责人，发布集合沿用 F-18 已批准口径。

依据功能 §18.7，MAIN 和活动 SOURCE 可继续完成/生成记录；历史 SOURCE 提示转主任务。已发布历史后来任务重开的修订/重放规则保留；F-18 遗留 10000/草稿 50000、完整搜索容量 422、整段稳定项和 CONVERTED 关联保留等规则未变。无新增核心依赖、迁移、约束、数据库角色或权限。

## 前端

F-16 完成入口中无变化模式改走组合接口；有变化支持内联五项内容或明确草稿选择，不隐式挑选第一条。候选只展示同真实 scope 且未关联其他任务的草稿，选择后显示全文，可打开原草稿继续编辑。成功刷新任务/历史/记录列表与详情及相关读模型，并提供正式记录链接。

输入不完整时不可提交；在途禁止重复提交和关闭弹窗，错误保留输入/选择及同语义幂等键。409 可加载最新任务；引用草稿变化时展示最新全文，用户明确确认后使用新的任务/草稿版本和新语义 Key 重试。发布容量失败不改变任务或草稿，用户修正草稿后可重新完成。

## 实际定向验证

| 范围 | 命令/测试文件 | 结果 |
| --- | --- | --- |
| F-19 组合及旧接口真实数据库/HTTP | API integration 配置 task-completion.integration.test.ts | 30/30 |
| 相邻回归及旧状态兼容 | 上述文件 + record-drafts / published-records / record-publication / task-groups-merge + tasks-api | 六文件累计 111/111：前五文件 70/70，旧 tasks-api 装配补齐后独立 41/41（5.01 秒） |
| 前端组合与任务/记录回归 | CompleteWithRecord / TasksPanel / RecordDraftsView / PublishedRecordsView / EditPublishedRecord | 五文件 20/20（6.26 秒） |
| 契约/权限/严格 DTO | task-completion / published-records / record-drafts / permissions / validate | 五文件 46/46 |
| 路由、权限、漂移 | contract:validate / permissions:check / contract:drift | 80 路由/操作通过，5 生成物一致 |
| 受影响应用类型及必要编译 | API/契约 E2E 所需编译，API 测试/Web/E2E 类型检查 | 通过 |
| 跨域导入与前端依赖 | check:deps / check:frontend:boundaries | 469 源文件无循环/越界；144 前端模块通过 |
| Edge | task-completion / task-status / record-drafts / record-publishing | 兼容收口前四文件 10/10（2.0 分钟）；收口后 F16/F19 两文件 5/5（1.1 分钟），实际应用装配通过 |

组合测试原 23 条覆盖两模式/两范围、独立草稿绑定和身份快照、空结果及已有多正式历史、错项目/范围/来源、撤权/版本、同 Key 并发和不同 Key 竞争、后续重开合法重放、八种任务阶段及发布后期副作用失败整体回滚、完整搜索超限、活动/历史 SOURCE 与 MAIN、合并/记录编辑/任务修改/归档真实锁等待、独立发布竞争及 MODULE 历史影响锁序。

首轮契约测试因目标尚未实现而失败；随后修正错误的 module-tasks 导入与新路由对象缺括号，生成及验证通过。新增 Controller 的扫描清单未同步曾导致 44/45，补入新路由后 45/45。HTTP 测试 JSON unknown 类型已改为 Schema 解析。新前端测试曾在加载动画尚未消失时查询按钮失败，使用现有测试约定关闭 Ant Design 动效后通过，没有弱化业务断言。

首轮草稿失败路径 E2E 返回列表 URL 时未带 taskId，因此未打开任务详情而超时；测试改为从页面真实来源链接提取任务 ID 构造详情 URL，回归通过。随后 F-17 旧用例仍断言有变化时旧完成按钮/草稿提示入口，相关适配与最终合跑结果见补记。所有失败如实保留，不声称此前全绿。

最终合跑补记：F17两条用例仅将“实际变化但内容未填完整时不可提交”的定位从旧“确认完成任务”改为新“发布并完成任务”，保留两草稿保存、继续编辑/刷新、返回任务仍可完成且历史仅创建一条的全部断言；界面保留“选择或新建草稿”直达入口。最终四文件 10/10，无跳过或降低业务断言。局部格式检查发现新前端测试排版未完成，运行对应文件 formatter 修正；文档链接检查覆盖 62 个 Markdown 文件，git diff --check 通过。

## 交付状态与限制

代码已提交为 a69c610220d846084b6da2c7f639a5bfa3648a6f，文档独立提交；未推送、建 PR 或执行本批 GitHub CI。未运行全仓静态、全量构建、全量测试、无关审计或默认 Chromium；只运行必要的受影响范围。草稿列表沿用当前项目全量读取，暂无分页。真实数据库使用本任务独占测试实例，已核对目录后停止，确认端口释放并保留数据。最终本地提交交协调复核，F-20 等本批合并通知。

协调确认后已关闭旧兼容 API 绕行：transitionTask/transitionModuleTask 保留原 TaskStatusRequest 与 TaskItem/ModuleTaskItem，COMPLETE/WITHOUT_RECORD 也进入同一个 TaskCompletionWorkflow，执行 SOURCE 资格、完整事务与所有相关作者通知。Controller 迁到 Workflow 层且只调用一个兼容 Use Case；REOPEN/CANCEL/RESTORE 经 Tasks 公开 TaskStatusCommandPort 保持原业务，领域没有反向依赖 Workflow。两旧 operation 的幂等及重放授权升级 2.0.0，原 1.0.0 指纹完整保留，旧 Key 409；完成重放按当前组身份和全部保存资源重新授权，其他状态沿用原门禁。

新增 7 条兼容真库用例覆盖旧接口两范围及作者通知、原响应、历史 SOURCE 当前/重放拒绝、MAIN/ACTIVE SOURCE、旧契约 Key 409、其余三种状态及重放、新旧接口竞争和副作用回滚。首轮 29/30 因测试查询 change_record_versions 不存在的 id 列，修为 SELECT 1 后通过；原 tasks-api 13 条状态测试曾因测试模块没有装迁移后的 Controller 返回 404，补入真实兼容装配后 41/41，保留全部业务断言。Controller 扫描预期移位曾重复保留旧位置，移除重复后 46/46。以上修正均未弱化断言或跳过用例。

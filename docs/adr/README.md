# 架构决策记录索引

本目录是 InPulse 架构决策的唯一权威来源。技术设计和系统设计只引用 ADR 编号与本索引，不再各自维护决策全文。

## 状态约定

- `Accepted`：当前基线，实施与评审必须遵守。
- `Proposed`：仍在评审，不得作为实现前提。
- `Superseded`：已被新 ADR 替代，保留历史但不得用于新实现。

修改已接受决策时必须新增 ADR，并在旧记录中标明替代关系；不得复用或重排编号。

## 决策索引

| ADR | 状态 | 决策 |
|---|---|---|
| [ADR-001](ADR-001.md) | Accepted | 采用模块化单体 |
| [ADR-002](ADR-002.md) | Accepted | 前端采用 React SPA |
| [ADR-003](ADR-003.md) | Superseded | NestJS 11.x 基线与 12.x 阶段 0 门禁，由 ADR-026 替代 |
| [ADR-004](ADR-004.md) | Accepted | Zod Schema Registry 与 Route Registry 共同生成契约 |
| [ADR-005](ADR-005.md) | Accepted | PostgreSQL 18、Drizzle 与显式迁移 |
| [ADR-006](ADR-006.md) | Accepted | PostgreSQL hash-only Session Store |
| [ADR-007](ADR-007.md) | Accepted | TaskGroupMember 是任务组归属唯一真相 |
| [ADR-008](ADR-008.md) | Accepted | 分 scope 串行审计哈希链与角色隔离 |
| [ADR-009](ADR-009.md) | Accepted | 本期不实现通用 Outbox |
| [ADR-010](ADR-010.md) | Superseded | pg_trgm 与搜索投影的双阶段门禁，由 ADR-025 替代 |
| [ADR-011](ADR-011.md) | Accepted | Argon2id 与服务端 Session 认证 |
| [ADR-012](ADR-012.md) | Superseded | 两类角色与创建者成员关系语义，由 ADR-033 扩展为项目内角色模型 |
| [ADR-013](ADR-013.md) | Accepted | WorkflowModule 与显式 UnitOfWork |
| [ADR-014](ADR-014.md) | Accepted | 使用脱敏 ActivityProjection |
| [ADR-015](ADR-015.md) | Accepted | 同步 CSRF Token 与有限重签 |
| [ADR-016](ADR-016.md) | Superseded | 系统管理员 TOTP MFA 与重认证，由 ADR-031 替代 |
| [ADR-017](ADR-017.md) | Accepted | 固定版本、补丁与镜像 digest |
| [ADR-018](ADR-018.md) | Accepted | PostgreSQL 数据卷与数据库角色分离 |
| [ADR-019](ADR-019.md) | Accepted | Route Registry、权限矩阵与写接口幂等默认值 |
| [ADR-020](ADR-020.md) | Accepted | 加密逻辑备份与全新主机恢复验证 |
| [ADR-021](ADR-021.md) | Accepted | 逐响应 nonce CSP |
| [ADR-022](ADR-022.md) | Accepted | ExternalLinks 类型化关联模型；2026-10-08 修订：接受裸 commit SHA 并用项目根仓库补全为 commit 链接；2026-10-09 修订：项目视图读侧聚合任务 / 功能 / 已发布记录上的关联并标注来源；2026-10-09 修订二：聚合只含有效任务（已取消 / 已无效任务的链接不进项目面板） |
| [ADR-023](ADR-023.md) | Accepted | 一次性认证安全流程的幂等例外（allowlist 经 ADR-031 收缩、ADR-032 调整为 `issueCsrfToken`、`login`、`logout`、`startSsoLogin`、`completeSsoLogin`） |
| [ADR-024](ADR-024.md) | Accepted | 迭代记录作废与可审计恢复状态机 |
| [ADR-025](ADR-025.md) | Accepted | V1 采用 PGroonga 实现中文与标识符搜索 |
| [ADR-026](ADR-026.md) | Accepted | NestJS 基线锁定 11.2.3 并延后 12.x 升级 |
| [ADR-027](ADR-027.md) | Accepted | 契约生成链路使用 Zod 4 JSON Schema 与仓库内生成器 |
| [ADR-028](ADR-028.md) | Accepted | apps/api 迁移至 ESM/NodeNext 以消费共享 ESM 包 |
| [ADR-029](ADR-029.md) | Accepted | Nest 运行期采用自研 Zod Pipe 与响应 Serializer |
| [ADR-030](ADR-030.md) | Accepted | 空项目、模块业务编号与任务就地创建归属 |
| [ADR-031](ADR-031.md) | Accepted | 移除 TOTP 两步验证与管理员高风险重认证 |
| [ADR-032](ADR-032.md) | Accepted | 接入立镖 Casdoor OIDC 单点登录（SSO）；前端默认入口经 ADR-036、ADR-080 修订、会话空闲时长经 ADR-038 修订 |
| [ADR-033](ADR-033.md) | Accepted | 项目内角色（组长与项目管理员），扩展 ADR-012；项目管理员与授权口径经 ADR-039 修订 |
| [ADR-034](ADR-034.md) | Accepted | 任务与功能归档及父级归档前置校验；角色口径经 ADR-039 修订，**项目归档申请—审核部分由 [ADR-043](ADR-043.md) 替代，模块归档部分由 [ADR-044](ADR-044.md) 替代，功能归档部分由 [ADR-045](ADR-045.md) 替代，任务归档部分由 [ADR-054](ADR-054.md) 替代** |
| [ADR-035](ADR-035.md) | Accepted | 项目生命周期、粘性标记与项目写入口口径；角色口径经 ADR-039 修订，**状态口径由 [ADR-043](ADR-043.md) 修订为三态** |
| [ADR-036](ADR-036.md) | Accepted | 登录页默认展示本地口令表单，统一身份认证改为并列入口（2026-10-16 由 ADR-080 修订：`/login` 恢复默认直达 SSO，本地表单退居隐藏应急入口） |
| [ADR-037](ADR-037.md) | Proposed | 任务列表排序口径统一（紧急度优先 + 状态分组）与多列 keyset 游标 |
| [ADR-038](ADR-038.md) | Accepted | 本地会话空闲有效期由 30 分钟调整为 2 小时 |
| [ADR-039](ADR-039.md) | Accepted | 移除项目管理员角色，项目内管理权限下放给全体活跃成员（修订 ADR-033/034/035） |
| [ADR-040](ADR-040.md) | Accepted | 任务支持平权多负责人（关联表取代单一负责人列） |
| [ADR-041](ADR-041.md) | Accepted | 删除任务优先级的「低」（LOW）档位（修订 ADR-037 的排序键与游标版本） |
| [ADR-042](ADR-042.md) | Superseded | 原始审计读取留痕按「查看」计数（进入与切换对象各一条），由 [ADR-060](ADR-060.md) 替代 |
| [ADR-043](ADR-043.md) | Accepted | 项目层面下线归档，生命周期收窄为未开始 / 进行中 / 维护中三态（替代 ADR-034 项目归档部分、修订 ADR-035） |
| [ADR-044](ADR-044.md) | Accepted | 模块层面下线归档，模块只有 ACTIVE（替代 ADR-034 模块归档部分、修订 ADR-033/ADR-039 的模块归档授权口径；功能档位表述经 ADR-045 修订，模块列表排序键经 ADR-046 修订） |
| [ADR-045](ADR-045.md) | Accepted | 功能层面下线归档，功能只有 ACTIVE（替代 ADR-034 功能归档部分、修订 ADR-039 的项目内管理操作清单与 ADR-044 的功能档位表述） |
| [ADR-046](ADR-046.md) | Accepted | 三层列表排序统一为「档位优先 + 创建时间从近到远」（修订 ADR-044 的模块列表排序表述）；2026-10-08 修订：项目列表同档位内改为按「最近变更时间」从近到远 |
| [ADR-047](ADR-047.md) | Accepted | 迭代记录发布与任务完成解耦（修订功能设计 F-18 / F-19 与技术设计 §6.3 的发布门禁） |
| [ADR-048](ADR-048.md) | Accepted | 迭代记录草稿支持物理删除（`SECURITY DEFINER` 函数 + `record.draft.delete` 审计；明确 ADR-024 `DRAFT` 一档的删除语义） |
| [ADR-049](ADR-049.md) | Accepted | 项目删除为软删除（保留全部历史、退出可见范 围），只有系统管理员与本项目组长可删除（在 ADR-039 的权限下放上新增例外）；**第 3 节的可见性绝对表述由 [ADR-050](ADR-050.md) 修订，第 8 节「不提供彻底删除与恢复」由 [ADR-051](ADR-051.md) 修订** ；**本 ADR 整体由 [ADR-062](ADR-062.md) 替代（项目删除改为不可逆物理删除）** |
| [ADR-050](ADR-050.md) | Accepted | 项目删除记录对全部登录用户可见：作为动态流 内的普通一行（服务端只放行 `PROJECT_DELETED` 行）并在审计页补齐已删除项目的审计 链入口，记录删除人（修订 ADR-049 第 3 节的可见性表述；非目标第 1 条由 [ADR-051](ADR-051.md) 修订，**第 5 节的服务端 收窄由 [ADR-052](ADR-052.md) 修订**）；**本 ADR 整体由 [ADR-062](ADR-062.md) 替代** |
| [ADR-051](ADR-051.md) | Accepted | 项目还原与彻底删除：删除记录行同时提供「还 原项目」（系统管理员或本项目组长，清空软删除标记）与「彻底删除」（仅系统管理员，经 `app.purge_project` 窄口物理删除全部下级数据与该项目审计链，只留 SYSTEM 链一 条 `project.purge`）（修订 ADR-049 第 8 节与 ADR-050 非目标第 1 条）；**本 ADR 整体由 [ADR-062](ADR-062.md) 替代（`app.purge_project` 窄口与 SYSTEM 链留痕保留，删除改为一步到位）** |
| [ADR-052](ADR-052.md) | Accepted | 已删除项目的完整动态过程与删除操作唯一入口：已删除项目下发整个项目链的 `MEMBER` 可见动态（不含 `ADMIN_ONLY`），同一项目多次删除只让最新一条保留还原与彻底删除，项目筛选下拉新增「已删除项目」（修订 ADR-050 第 5 节的服务端收窄）；**本 ADR 整体由 [ADR-062](ADR-062.md) 替代（不再有「已删除项目」档位与完整动态回放）** |
| [ADR-053](ADR-053.md) | Accepted | 项目组长唯一性与转移：有活跃成员则恰好一名组长，组长只能转移不能撤销/移除，组长本人可转交身份（修订 ADR-033/ADR-039 的组长授权口径） |
| [ADR-054](ADR-054.md) | Accepted | 任务层面下线归档，任务生命周期只剩 ACTIVE / INVALID（替代 ADR-034 任务归档部分、修订 ADR-043「维护中」门禁的实现口径） |
| [ADR-055](ADR-055.md) | Accepted | 项目保留期到期自动彻底删除：软删除满 30 天（按最后一次删除计时）由服务端后台经 `app.purge_project` 物理删除并在 SYSTEM 链留 `project.purge`（`trigger = AUTO_RETENTION`）（扩展 ADR-051 的触发路径）；**本 ADR 整体由 [ADR-062](ADR-062.md) 替代（保留期与后台自动删除一并取消）** |
| [ADR-056](ADR-056.md) | Accepted | 维护中项目新建任务即回到进行中：任务创建与项目状态切换同事务，写审计（`trigger = TASK_CREATED`）、活动与搜索投影但不发通知，`first_task_completed_at` 不动（扩展 ADR-035 的自动升级路径、修订 ADR-043 第 7 节第 3 条的边界）；**触发面由 [ADR-057](ADR-057.md) 扩展为「任务重新变为未收尾」** |
| [ADR-057](ADR-057.md) | Accepted | 任务重新变为未收尾即让维护中项目回到进行中：重新打开（`REOPEN`）与恢复（`RESTORE`）与新建任务同口径（`trigger = TASK_REOPENED` / `TASK_RESTORED`、端口更名 `reopenMaintenanceProject`、前端补 `projects` 缓存失效），`COMPLETE` / `CANCEL` 不触发（扩展 ADR-056 的触发面、修订其非目标第 2 条） |
| [ADR-058](ADR-058.md) | Accepted | 取消任务改为「二次确认后删除任务」：任务层软删除（`deleted_at` / `deleted_by`，保留编号、状态历史、迭代记录与审计）、同事务解除 GitHub 链接关联、作废该任务的迭代记录、聚合组 SOURCE 自动解除 / MAIN 拒绝（409 `TASK_GROUP_MAIN_LOCKED`）、写 `task.delete` 审计与 `TASK_DELETED` 动态并移除搜索投影；不提供恢复入口（修订 ADR-054 的「取消」语义、扩展 ADR-049 的软删除范式；补 `0035` 的 `search_projection` DELETE 授权缺陷） |
| [ADR-059](ADR-059.md) | Accepted | 模块与功能增加删除：两者均为软删除（`deleted_at` / `deleted_by`，迁移 `0036`），删除模块级联软删除其全部功能与全部任务（任务按 ADR-058 语义处理）、删除功能只级联其自身任务，模块 / 功能自身的已发布记录一并作废、影响关系行保留；未分类模块不可删除（409 `MODULE_UNCLASSIFIED_PROTECTED`）；权限为系统管理员或本项目组长（ADR-039 的第五处例外）；读路径补 `deleted_at IS NULL`（修订 ADR-039 管理操作清单、扩展 ADR-049 / ADR-058 的软删除范式） |
| [ADR-060](ADR-060.md) | Accepted | 审计读取不写留痕：`GET /api/v1/audit-logs` 不再写 `AUDIT_LOG_READ`（`AuditQueryService` 删除留痕写入路径、Route Registry `auditAction` 改为 `none`），契约删除 `readTrail` 参数（仍携带者 422）；历史留痕行保留在链中并按普通审计行可读，前端「隐藏读取留痕」机制整体删除；读取取证由远端 WORM 归档与部署层日志承担；无迁移、路由仍 105 条（替代 ADR-042） |
| [ADR-061](ADR-061.md) | Accepted | 原始审计读取新增「全部记录（所有链）」并设为默认：契约加可选 `chain=all`（与 `projectId` 互斥，同传 422 `invalid-chain`，缺省仍读 SYSTEM 链），跨链按 `occurred_at DESC, chain_id DESC, sequence_no DESC` 键集分页、签名游标加成对链坐标（`c` / `t`，缺坐标 422 `invalid-cursor`），迁移 `0037` 新增 `audit_logs_occurred_at_chain_seq_idx`；审计页动作码候选过滤 11 个已下线动作码（标签表保留供历史行渲染）；权限仍 `adminSession`、路由仍 105 条（扩展 ADR-060 的读取范围） |
| [ADR-062](ADR-062.md) | Accepted | 项目删除改为不可逆物理删除（替代 ADR-049 / ADR-050 / ADR-051 / ADR-052 / ADR-055）：`DELETE /api/v1/projects/{projectId}` 经 `app.purge_project` 窄口在同一事务内清空项目全部下级数据与该项目审计链，只在 SYSTEM 链留一条 `project.delete`（仅管理员可见、不写动态与通知）；项目编码随之释放可复用；幂等契约版本升 `2.0.0` 且重放授权降为 `actorOnly`；删除路由 `restoreProject` / `purgeProject` / `listProjectDeletions` 与 ADR-055 保留期自动彻底删除一并下线，路由 105 → 102，迁移 `0038`（任务与模块 / 功能软删除不受影响） |
| [ADR-063](ADR-063.md) | Accepted | 项目列表「未完成」档内统一按最近变更时间排序：第一排序键档位由三档收窄为两档（未完成 = 进行中与未开始同属一档、维护中），未完成档内「一有更新就排最前」（修订 ADR-046 决策 1 的项目列表行与 2026-10-08 修订的档位口径；模块与功能两层不变） |
| [ADR-064](ADR-064.md) | Accepted | 固定模板 Markdown 文档导入（新增 F-32）：两种模式——项目内导入（`POST /api/v1/projects/{projectId}/document-imports`，项目可写门禁）与整项目导入（`POST /api/v1/project-imports`，任何已登录用户，单事务创建项目与全部下级）；固定模板语法（标题 + `- 字段：值`），项目编码整项目导入强制必填；负责人 / 项目成员按登录名或姓名解析，整项目导入自动加入（项目内导入要求已是活跃成员）；同名模块 / 功能精确复用不覆盖，任务一律新建；`digest`（规范化文本 SHA-256）+ 迁移 `0039` `app.document_import_runs` 拒重复导入（409），摘要过期 409、行级问题 422；预览只读、执行数据库级幂等；路由 102 → 106 |
| [ADR-065](ADR-065.md) | Accepted | 文档导入模板自带格式说明与解析器忽略行 / 围栏行（修订 ADR-064 2.1 的行处理口径）：模板顶部以 `>` 引用行写入字段名清单、必填与两种模式约束并保留示例结构；解析器忽略以 `>` 开头的说明行与三个反引号 / `~~~` 代码围栏行（只有说明行 / 围栏行的文档仍按空文档处理），其余未知行仍 422 `LINE_UNRECOGNIZED`；弹窗新增「格式速查」区块，`DOCUMENT_IMPORT_TEMPLATE` 与解析器一致性测试锁定不漂移；路由 106 条、权限、数据库与模板版本号不变 |
| [ADR-066](ADR-066.md) | Accepted | 文档导入支持选择文件（修订 ADR-064 非目标第 1 条）：弹窗新增「选择文件」，浏览器本地读取 .md / .markdown / .txt 内容（剔除 BOM）填入导入文本并提示，仍走既有「预览 → 确认导入」；本地校验扩展名白名单、1 MiB 字节与 20 万字符上限，全部不发请求；不引入 multipart、服务端文件接收与附件存储，路由 / 契约 / 权限 / 数据库与模板版本号不变 |
| [ADR-067](ADR-067.md) | Accepted | 文档导入内嵌 AI 辅助转换：新增 `assistDocumentImport`（`POST /api/v1/document-imports/assist`，`IN_PROJECT` / `WHOLE_PROJECT` 双模式）——粘贴或选择自己的文档（`.txt` / `.md` / `.markdown` / `.docx` / `.pdf`，浏览器本地抽取、文件不上传），服务端转发到管理员配置的 OpenAI 兼容端点（中转站或自建），AI 仅产出模板草稿 + 解析器预检 issues、永不直接入库；密钥仅 `/run/secrets/*` fail closed、`AI_ASSIST_ENABLED` 默认关闭；新增两个懒加载前端依赖走独立依赖 PR；走纯校验 allowlist（csrf / idempotency none）、路由 106 → 107、无迁移；**配置来源与密钥管理由 [ADR-068](ADR-068.md) 修订：管理员在线配置（含密钥信封加密落库），环境变量保留急停与遗留回退** |
| [ADR-068](ADR-068.md) | Accepted | AI 辅助转换改为管理员在线配置：新增 `getAiAssistSettings` / `updateAiAssistSettings` / `testAiAssistSettings` 三条 admin 路由（GET / PUT / POST test，107 → 110），配置与 AES-256-GCM 加密的密钥落库（单行表 `app.ai_assist_settings`，迁移 `0040`，主密钥仍只从 `/run/secrets/ai_assist_encryption_key` 读取），`AI_ASSIST_ENABLED` 保留为急停开关，无数据库行时回退 ADR-067 的环境变量模式（修订 ADR-067 §2.2 / §2.5；扩展纯校验 allowlist 与 AGENTS.md 第 7 节的 Secret 边界） |
| [ADR-069](ADR-069.md) | Accepted | 企业微信机器人绑定（阶段一）：账户菜单自助绑定——`getWecomBinding` / `createWecomBindingCode` / `deleteWecomBinding` 三条自助路由（110 → 113），一次性绑定码（Crockford Base32 16 位 / 80 bit / 10 分钟 / 只存 SHA-256 / 重新签发即作废旧码，加入 ADR-023 allowlist 的 securityFlow）；迁移 `0041`（`app.wecom_binding_codes` + `app.user_wecom_bindings` + `SECURITY DEFINER` 兑换函数 `app.redeem_wecom_binding_code`，WBC01–WBC06）；解绑为 REVOKED 状态流转；阶段二投递（长连接桥接推送）另立 ADR、未实现 |
| [ADR-070](ADR-070.md) | Accepted | 企业微信机器人凭据的管理员在线配置：新增 `getWecomRobotConfig` / `updateWecomRobotConfig` 两条 admin 路由（113 → 115），凭据密文落库单行表 `app.wecom_robot_config`（迁移 `0042`，AES-256-GCM、主密钥只从 `/run/secrets/wecom_robot_encryption_key` 读取），管理员在「成员与设置 → 企业微信机器人」在线更换机器人；修订 ADR-069 §2.4（投递凭证不再只由桥接侧持有），桥接侧读取解密与投递改造另批实现；2026-10-13 扩展：迁移 `0043` 新增可空 `bot_profile_url`（机器人链接，展示到成员「绑定企业微信」弹窗），`updateWecomRobotConfig` 幂等契约 1.0.0 → 1.1.0 |
| [ADR-071](ADR-071.md) | Accepted | 文档导入工作台（修订 ADR-067 非目标第 2 条）：把输入态改造为左右分栏工作台——左栏「内容梳理 / 预览文档」页签 + 结构化草稿（点哪改哪、「＋字段」补缺、确定性缺失项与计数），右栏 AI 助手对话（逐轮补充说明拼成一段后重调同一条 `assistDocumentImport`，不做服务端多轮会话状态）+ 成员名字「精确且唯一」才命中的确定性匹配与候选 / 从成员里挑追问（不自动猜人、不自动建用户，最终由服务端解析器定案）；无新增路由、无迁移、无新依赖、无权限变化 |
| [ADR-072](ADR-072.md) | Accepted | 整项目（模式 B）文档导入的项目成员名单必填且必须含创建者与全部任务负责人（修订 ADR-064 的成员语义：「负责人自动并入成员」退化为兜底，名单里没有创建者 / 少写负责人转为预览 422 `MEMBER_CREATOR_MISSING` / `ASSIGNEE_NOT_INITIAL_MEMBER`、空名单 `MEMBER_REQUIRED`），判据是解析后的账号而非字面；AI 整项目提示词带上本次导入人姓名，工作台用同一口径做本地预检（只报本地能确定的三项），模板说明行同步；无新增路由 / 迁移 / 依赖 / 权限变化 |
| [ADR-073](ADR-073.md) | Accepted | 整项目导入（模式 B）的创建者默认算项目成员并在工作台显示为锁定标签（修订 ADR-072：删除 `MEMBER_CREATOR_MISSING`、AI 提示词去掉 `creatorName`、契约模板说明行 / 工作台必填要素 / 右栏追问三处同口径；工作台只在整项目导入渲染一枚带锁图标、无删除按钮的标签，且不改文档正文，「预览文档」仍是一字不改的原版）；无新增路由 / 迁移 / 依赖 / 权限变化 |
| [ADR-074](ADR-074.md) | Accepted | api 容器增加仅出站 `egress` 网络（Casdoor SSO 与 AI 辅助的外联前提，测试环境拓扑并入仓库基线） |
| [ADR-075](ADR-075.md) | Accepted | 空库首个 SSO 登录账号自动成为系统管理员（修订 ADR-032 决策 5 的 JIT 默认权限：判定以 `app.users` 是否有行为准、事务级 advisory lock 串行化、审计 payload 增加 `grantedAdmin`）；无新增路由 / 迁移 / 依赖 / 权限矩阵变化 |
| [ADR-076](ADR-076.md) | Accepted | 迭代记录「生成总结」内嵌 AI 改写：新增 `assistRecordSummary`（`POST /api/v1/record-summaries/assist`）——不是对话式，而是「一句话要求 → 生成 → 生成后逐段手改」（改过的段落橙点 + 单句回退 + 全量撤销）；事实由前端当前范围的确定性正文给出，服务端只转发一次改写、不查库不写库、不写审计、不解析筛选意图、不建会话状态；复用 ADR-067 / ADR-068 的配置与密钥通道（`AI_ASSIST_ENABLED` 仍是急停）；走纯校验 allowlist（csrf / idempotency none）、路由 115 → 116、无迁移、无新依赖、无权限变化 |
| [ADR-077](ADR-077.md) | Accepted | 企业微信项目群绑定（项目 ↔ 群，第一批）：新增 `getProjectWecomGroup` / `createProjectWecomGroupCode` / `deleteProjectWecomGroup` 三条项目级路由（116 → 119），组长 + 系统管理员签发一次性绑定码 / 解绑（`wecomGroupBinderRole`，ADR-039 例外清单扩展；签发加入 ADR-023 allowlist securityFlow 第七条）；迁移 `0044`（`app.project_wecom_binding_codes` + `app.project_wecom_groups` 一项目一群 / 一群一项目 + `app.wecom_group_deliveries` 投递去重表 + `SECURITY DEFINER` 兑换函数 `app.redeem_project_wecom_binding_code`，PWG01–PWG08），群推送与个人单聊并存、默认投递「任务派发 + 全部 MEMBER 可见动态」；长连接桥接 `chat_type:2` 投递改造为第二批 |
| [ADR-078](ADR-078.md) | Accepted | 更换机器人（botId 变化）时自动解除全部企业微信绑定：`updateWecomRobotConfig` 在同一事务内经迁移 `0045` 新增的 `SECURITY DEFINER` 函数 `app.revoke_wecom_bindings_on_robot_change()` 把 `app.user_wecom_bindings` 与 `app.project_wecom_groups` 的 ACTIVE 行全部置 REVOKED（保留历史、计数返回、PUBLIC 回收与部署断言），响应新增可空 `revokedUserBindings` / `revokedProjectGroups`（未更换为 null、更换为计数含 0、GET 恒 null），幂等契约 1.1.0 → 1.2.0，审计增加 `robotChanged` 与两计数；仅轮换 Secret / 修改机器人链接不触发；不改桥接、路由数不变（119） |
| [ADR-079](ADR-079.md) | Accepted | 未绑定企业微信的提醒弹窗（忽略 / 不再提醒）与机器人可用标记：`WecomBindingStatus` 新增 `robotConfigured`（机器人是否已配置，未配置不提示绑定）；已登录且 UNBOUND 时弹「绑定企业微信，及时收到任务提醒」——「去绑定」打开既有绑定弹窗、忽略按会话记 sessionStorage、不再提醒按账号记 localStorage（均只存浏览器本地，不入库不写审计）；PENDING / BOUND / 未配置 / 读取失败静默不弹；无新增路由（119）、无迁移 |
| [ADR-080](ADR-080.md) | Accepted | 登录页直达单点登录（修订 ADR-036 / ADR-032 决策 7 的前端入口）：`/login`（含 `?from=`）匿名态立即整页跳转 `/api/v1/auth/sso/start?returnTo=...`，`?local=1` 管理员应急与服务端 fail closed 回落的 `?sso=disabled` 渲染本地口令表单且不自动跳转，`?sso_error=` 只显示错误与手动重试；退出登录仍回 `/login` 后自动进入 SSO；服务端路由 / 契约 / 迁移 / 依赖 / 权限矩阵不变 |
| [ADR-081](ADR-081.md) | Accepted | 组织（部门）成员分组：管理员建立组织、成员至多归属一个组织（可未分配）、批量归属（1～200 人）、同组织成员只读可见；新增 6 条路由（119 → 125）与迁移 `0046`；指派选择器组织视图为第二批 |
| [ADR-082](ADR-082.md) | Accepted | 离职账号墓碑化删除：成员页默认只显示启用账号并可切换到已停用/离职；新增 deleteUser（125 → 126）与迁移 0047；删除仅限已停用且无活跃项目成员关系的账号，保留主键与历史引用，清除个人资料并把历史业务显示名解析为「删除用户」，审计列表保留事件姓名；墓碑账号不进入成员列表；其中「强制退出行为不变」条款由 ADR-083 替代 |
| [ADR-083](ADR-083.md) | Accepted | 移除管理员强制退出 `forceLogoutUser`：删除前端入口之后继续删除路由、Controller、HTTP 编排、Service、Repository、权限矩阵、OpenAPI 与生成客户端（126 → 125）；历史审计动作码保留中文展示但不产生新事件；停用是撤销目标会话的唯一管理员操作 |
| [ADR-084](ADR-084.md) | Accepted | 停用账号前的任务交接：新增 `getAdminUserOffboarding`（125 → 126），`disableUser` 改为接收任务交接请求体并把幂等契约升至 2.0.0；多负责人任务默认保留其他负责人，唯一负责人任务必须指定一名或多名接手人或标记删除，全部清理后同事务停用、撤销 Session 与写审计；前端采用 D 方案弹窗，无迁移 |

## 关联基线

- [功能设计 V1.1](../../功能设计v1.1.md)
- [技术设计 V1.2.2](../../技术设计v1.2.2.md)
- [系统设计 V1.0.2](../../系统设计文档v1.0.2.md)
- [权限矩阵](../permissions.md)
- [测试矩阵](../test-matrix.md)

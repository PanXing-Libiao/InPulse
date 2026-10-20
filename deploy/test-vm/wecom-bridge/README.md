# 测试 VM 企业微信桥接（本地唯一源）

本目录是测试 VM `inpulse-wecom-bridge` 容器脚本的**本地唯一源**：先改这里，再用
`deploy/test-vm/update-bridge.ps1` 同步到 VM。它属于测试环境 PoC，**不是生产实现**：
不进 `deploy/compose.yaml`、不进 `apps/`、不参与生产镜像与 CI 门禁。

## 目录

- `app/`：桥接脚本。`runner.mjs` 拉起两个子进程——`long-conn.mjs`（企业微信长连接：绑定码兑换、
  主动推送、项目群投递消费）与 `bridge.mjs`（轮询 `app.notifications` 推送个人通知并物化项目群投递）。
- `Dockerfile`：`FROM` 本地 registry 的 api 镜像（复用其 node 24）；`COPY app /opt/wecom-bridge`。
- `bridge.env`、`app/bridge-config.json`、`app/config.json`、`test-bridge-config.json`：运行配置
  （不含任何 Secret；密钥与密码由 VM 上只读挂载）。
- `node_modules` 不入库：VM 侧 `app/node_modules` 是上一次安装的结果；仅当 `package.json`
  变化时，同步脚本会在 VM 上用固定 Node 镜像
  `node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`
  执行 `npm install --omit=dev` 刷新（挂 `egress` 网络，不依赖桥接运行镜像里的 npm）。

## 进入会话欢迎语与限频（2026-10-16）

- `enter_chat` 按绑定状态发欢迎语：未绑定 → 绑定引导（默认 10 分钟最多一条）；已绑定/未知 →
  一句话简短欢迎（默认 24 小时最多一条）。普通文本消息（不是绑定码）同样按绑定状态回复指引。
- 限频时间戳存 `welcomeStateFile`，默认取命令文件同目录的 `*-welcome.json`（容器内为 `/state/`，
  tmpfs，容器重启即清空，最多重启后多发一条）。绑定状态查 `app.user_wecom_bindings` 的 ACTIVE 行。
- `config.json` 可选键：`welcomeUnboundThrottleMs`、`welcomeBoundThrottleMs`（毫秒，0 = 该类用户
  不再自动发）、`welcomeStateFile`。

## 项目群消息投递（2026-10-16 本地实现，2026-10-20 已同步到 VM）

- 范围（ADR-077 第二批）：`app.notifications` 的 `task.assigned`（同一次指派事件的多个
  收件人只占一行，正文聚合「指派给」姓名）与 `app.activity_projection` 中
  `visibility_scope = 'MEMBER'` 的项目动态；`ADMIN_ONLY` 动态不进群；个人单聊推送
  不受影响，两条通道并存。
- 项目级开关（ADR-090，2026-10-20）：项目成员页「通知选项」保存到
  `app.project_wecom_group_notification_options`，五个开关分别对应 `task.assign` /
  `task.status` / `record` / `project.member` / `scope.delete`。`bridge.mjs` 每轮
  物化前读取开关并按 `notification-categories.mjs` 的固定映射过滤通知与 MEMBER
  动态；缺行（从未保存）与未识别的新事件默认放行，显式 FALSE 才阻断。
- 生效边界：开关只影响此后新写入的 PENDING 行；关闭期间游标照常前进，重新开启
  不补发，历史、已排队和已发送消息都不回溯。个人单聊与个人通知偏好不受影响。
- 两级分工：`bridge.mjs` 按独立游标物化——在「该项目当前 ACTIVE 群绑定」下插入
  `app.wecom_group_deliveries` 的 `PENDING` 行（按「绑定行 + 来源类型 + 来源 id」去重；
  只物化绑定时间之后发生的来源）；`long-conn.mjs` 消费 PENDING 队列，按 id 升序用
  `aibot_send_msg` + `chat_type:2` 发送 markdown，发送结果以响应帧 `errcode` 为准回写：
  成功 -> `SENT` + `sent_at`（并清空绑定行 `last_delivery_error`），失败 -> `FAILED` +
  `attempts` + `last_error`（同时截断回写绑定行 `last_delivery_error`，≤500 字符）。
- 限速与重试：投递侧 30 条/分钟、1000 条/小时（内存窗口，超限自动退避并限频打日志）；
  识别为限速/临时错误的响应保持 `PENDING` 并退避 60 秒重试；15 秒无响应按超时保持
  `PENDING` 稍后重试（响应迟到时可能重复，PoC 取舍）；其余错误直接 `FAILED` 不自动重试；
  解绑后残留的 `PENDING` 行按「群绑定已解绑」置 FAILED；重启后从 PENDING 断点续传。
- 游标与配置：`bridge-config.json` 的状态文件新增 `lastGroupNotificationId` /
  `lastActivityId`，首次运行从当前最大 id 之后开始（不回补历史）；可选键
  `groupDeliveries=false` 关闭物化、`groupNotificationTypes` 覆盖通知类型清单、
  `startFromGroupNotificationId` / `startFromActivityId` 指定游标初值。`config.json`
  可选键 `groupDeliveries=false`、`groupDeliveryPollMs`、`groupDeliveriesPerMinute`、
  `groupDeliveriesPerHour`。
- 分类单元测试：`node --test deploy/test-vm/wecom-bridge/app/notification-categories.test.mjs`
  覆盖五类映射、未识别事件默认放行、缺行全开与显式 FALSE 关闭。
- 本地实测（2026-10-16，真实群绑定：项目 1）：任务指派与 MEMBER 动态各 1 条真实送达
  （errcode=0，投递行 `SENT`）；同批 ADMIN_ONLY 动态未产生投递行；假 chatid 绑定验证
  失败回写（`errcode 93006 invalid chatid` -> `FAILED` + 绑定行 `last_delivery_error`）；
  long-conn 停机期间 PENDING 行保留、重启后续传送达。联调合成数据已清理。

## 项目封箱彩蛋（ADR-091，2026-10-20）

- 来源：项目第一次从进行中进入维护中、存在有效完成任务且没有未收尾任务时，API 在状态变更事务内写一次 `app.project_wraps` 冻结快照，并写 `project.wrapped` 个人通知与 `PROJECT_WRAPPED` / MEMBER 项目动态。重复进入维护中不重复生成。
- 个人单聊：`bridge.mjs` 读取快照和收件人姓名，先发 Markdown「这一箱，有你的名字。」，再发带署名的 1080 × 1350 JPEG 海报。海报失败时只保留文字；快照缺失时降级为普通通知卡片。
- 项目群：`long-conn.mjs` 消费 `PROJECT_WRAPPED` 动态，发送「叮——最后一盏灯灭了。」与无个人署名的海报。该动态归入 `project.member`，受项目群「项目与成员变化」开关控制。
- 图片协议：图片先经 `aibot_upload_media_init` → `aibot_upload_media_chunk` → `aibot_upload_media_finish` 取得 `media_id`，再以 `aibot_send_msg` 的 `msgtype=image` 发送；不使用普通 HTTP 素材上传接口。
- 分段续传：`app.wecom_group_deliveries.delivered_step_count` 记录已成功的文字 / 图片段数。图片失败或进程重启后从下一段继续，两段都成功才置 `SENT`。
- 渲染依赖：`app/wrap-poster.mjs` 使用 `@napi-rs/canvas`；海报字体在 `app/assets/fonts`（Noto Sans SC Regular / Black，SIL OFL 1.1），Windows 与容器加载同一组文件，避免微软雅黑、黑体或 Arial 的许可风险。Dockerfile 仍安装 `fonts-noto-cjk` 作为系统兜底；字体资产缺失时海报渲染 fail closed，桥接只发文字。
- 测试：`npm test` 同时运行通知分类与海报用例；海报测试会实际生成 JPEG 并校验尺寸、文件头和 MD5 / base64 一致性。

## 同步到 VM

```powershell
$env:INPULSE_VM_PASSWORD=''
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update-bridge.ps1
```

脚本流程：上传 → 远端逐文件 `sha256sum -c` 校验 → 构建 `inpulse-wecom-bridge:0.1.0-<日期>-bridge<内容哈希>` →
推送本地 registry → 按原安全参数重建容器并等待「订阅成功」。`-SkipRestart` 只更新镜像、不动容器。

## 约束与回滚

- 同一机器人只允许一条长连接：本地跑 PoC 前先停 VM 桥接（`sudo docker stop inpulse-wecom-bridge`）。
- 历史 bridge 镜像与 VM 上脚本 `*.bak-*` 留档可回滚；回滚 = 用旧 tag 重建容器（完整参数见 `update-bridge.ps1` 内 `docker run`）。
- 运行细节、排障与常用命令见 `deploy/test-vm/README.md`「企业微信机器人桥接」。

# 正式环境企业微信桥接

本目录只服务正式环境 `10.1.103.45`，公开站点为 <https://inpulse.libiaorobot.com/>。
它不是测试 VM 配置的副本：正式环境使用独立主密钥、正式域名、当前正式 API 镜像 digest 和正式数据库。
禁止把测试环境的 Secret、收件人 ID、状态文件或数据库密文带入本目录。

## 组成

- `app/long-conn.mjs`：企业微信智能机器人长连接、个人绑定码兑换、个人推送，以及项目群 Webhook 投递消费。
- `app/wecom-webhook.mjs`：企业微信 Webhook 消息体、URL 解密、HTTP 发送与每目标 20 条/分钟限速。
- `app/bridge.mjs`：轮询正式库通知、把个人通知转换为命令，并物化项目群投递。
- `app/runner.mjs`：同时拉起上述两个子进程，任一异常退出则让容器重启。
- `Dockerfile`：通过 `API_IMAGE_REF` 构建参数复用与正式 API 完全一致的 Node 运行时镜像。
- `bridge.env`、`app/config.json`、`app/bridge-config.json`：不含 Secret 的正式运行配置。
- `../update-bridge.ps1`：上传、校验、构建、推送并重建正式桥接容器。

正式 PostgreSQL 仅在容器内部 `backend` 网络暴露且未启用 TLS，桥接因此显式使用 `DB_SSLMODE=disable`；不得把数据库端口发布到公网。

正式配置中：

- 个人收件人只来自 `app.user_wecom_bindings`，静态 `recipients` 故意留空。
- `commandFile` 与 `long-conn` 共用 `/state/commands.txt`。
- 首次通知游标为 `0`；不存在的历史通知不会被补发。
- `cardActionUrl` 固定为 <https://inpulse.libiaorobot.com/>。

## 一次性准备

正式 API 与桥接必须共用同一把企微机器人主密钥：

```text
/home/libiao/inpulse-deploy/secrets/wecom_robot_encryption_key
权限 0400，owner 10001:10001，内容格式 1:<64 位十六进制>
```

更新脚本只在文件为空时生成一次，绝不覆盖已有密钥，也不会回显内容。
同一密钥由 Compose 挂载给 API 和桥接容器；如果两边不一致，管理员保存的机器人 Secret 无法解密。

机器人凭据必须由管理员在正式站点「成员与设置 / 系统设置 → 企业微信机器人」保存。
正式数据库当前没有 `app.wecom_robot_config` 行时，容器会保持运行并记录：

```text
数据库中尚无机器人配置（等待管理员在设置页保存）
```

这表示部署已就绪、等待管理员填写，不代表企业微信订阅已建立。

## 项目群 Webhook（ADR-106）

- 项目组长或系统管理员可在正式站点项目成员页添加企业微信官方群机器人 Webhook；每个项目最多 20 个 ACTIVE 目标，同一规范化 URL 全局只允许一个 ACTIVE 目标。
- API 使用同一把 `wecom_robot_encryption_key` 加密完整 Webhook URL，AAD 独立为 `app.project_wecom_groups.webhook_url`。数据库只保存密文、密钥版本、URL 指纹和 Key 尾号；页面、审计、日志与错误体不得出现完整 URL。
- Webhook 不依赖智能机器人长连接订阅；桥接从同一 PENDING 队列只读取 `channel_type = WEBHOOK` 的 ACTIVE 目标，每个目标独立限速 20 条/分钟。管理员更换机器人只撤销个人单聊绑定，Webhook 保持绑定。
- 同一项目的全部 ACTIVE Webhook 共用项目级五类通知开关。项目群不再接受新的智能机器人 BOT 目标；历史 BOT 行只保留审计与追溯，不参与投递。
- 发布 API 后必须同时发布包含 `wecom-webhook.mjs` 的正式桥接；否则旧桥接无法发送 Webhook 目标。

## 发布

前置条件：

1. 正式 Compose 栈已通过 `deploy/prod/update.ps1 -ConfirmProduction` 发布；
2. `.env.deploy` 中 `API_IMAGE_REF` 是带 `@sha256:` 的正式镜像；
3. `.env.deploy` 的 `WECOM_ROBOT_ENCRYPTION_KEY_VERSION` 与 keyring 当前版本一致；
4. SSH 部署密钥 `~/.ssh/inpulse_deploy_ed25519` 可免密登录 `libiao@10.1.103.45`。

执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction
```

脚本会逐文件 SHA-256 校验，备份正式源码，使用固定 Node 镜像执行 `npm ci --omit=dev`，
从正式 `.env.deploy` 读取 API 镜像引用并构建桥接镜像，然后按以下边界重建容器：

- 用户 `10001:10001`、只读根文件系统、`/tmp` tmpfs；
- `--cap-drop ALL`、`no-new-privileges`、256 MiB 内存上限；
- 初始连接 `inpulse-deploy_egress`，随后连接 `inpulse-deploy_backend`；
- 仅只读挂载数据库口令、企微主密钥、两份配置和可写状态目录。

## 验证

```bash
sudo docker ps --filter name=inpulse-wecom-bridge
sudo docker logs --tail 100 inpulse-wecom-bridge
sudo docker network inspect inpulse-deploy_backend --format '{{json .Containers}}'
sudo docker exec inpulse-wecom-bridge sh -c 'stat -c "%a %u:%g %s" /run/secrets/wecom_robot_encryption_key'
```

日志出现「订阅成功」才可证明企业微信长连接已建立；没有机器人配置时只能确认
「容器运行、数据库可达、主密钥可读、等待管理员配置」。不要把 waiting 状态描述为已可用。

## 回滚

先确认历史镜像 Tag：

```bash
sudo docker images --format '{{.Repository}}:{{.Tag}}' | grep inpulse-wecom-bridge
```

再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction -RollbackTo <历史 Tag>
```

源码备份位于 `/home/libiao/inpulse-deploy/backups/wecom-bridge-src-*.tgz`。

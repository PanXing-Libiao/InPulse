# 正式环境部署入口

本目录只服务正式环境 `10.1.103.45`，公开入口为 <https://inpulse.libiaorobot.com/>。
测试 VM `10.1.104.45` 继续使用 `deploy/test-vm/update.ps1`，两者不得混用。

> 当前实现是单机 Docker Compose + 本地 registry 的受控源码上传与 VM 构建链：本机只打包源码，镜像构建、推送和 Compose 更新都在正式机执行，本机不需要 Docker Desktop。它解决“代码提交后如何可靠更新正式机”的问题，但不替代技术设计第 12 章要求的 CI 签名发布清单、异机备份和恢复演练门禁。

## 当前正式基座

| 项目 | 值 |
| --- | --- |
| 主机 | `10.1.103.45`（Ubuntu，部署账户 `libiao`） |
| 域名 | `inpulse.libiaorobot.com`，DNS 已指向 `10.1.103.45` |
| 部署目录 | `/home/libiao/inpulse-deploy` |
| 镜像目录 | `/home/libiao/inpulse-images` |
| 本地 registry | `127.0.0.1:5000`，容器 `inpulse-registry`，`unless-stopped` |
| 当前镜像 | api / web / migrate / ops 均为 `0.1.0-20261030-70a94a36`；db-bootstrap 保持 `0.1.0-20261023-132ad0c2` |
| Git 基线 | `70a94a36f19548344c8f8ca39805f16146981523` |
| 数据库 | 1 个项目、3 个模块、4 个任务、84 名用户；迁移 64 条，PGroonga 4.0.8 |
| SSO | 正式 Casdoor `https://auth.libiaorobot.com` |
| AI 辅助 | 急停已解除（`AI_ASSIST_ENABLED=1`）；正式库已有 1 条在线配置，本轮未重新验证模型调用 |
| 企业微信桥接 | 已部署 `0.1.0-20261030-prod-bridgede58b78`；容器运行，长连接订阅成功，真实收件人投递仍需业务验收 |

首轮初始化已经建立七类数据库角色、TLS Secret、keyring 和正式 `.env.deploy`。两个正式账号已经完成 Casdoor SSO 登录并具有系统管理员权限；空库首个 SSO 用户自动获得管理员身份，第二个账号由首位管理员显式提升。后续人员按 SSO JIT 流程开通，但不应默认授予管理员。

## AI 辅助转换

2026-10-23 已把正式 `.env.deploy` 从急停值 `AI_ASSIST_ENABLED=0` 改为 `1`，并重建 API。
正式环境已具备：

- `/run/secrets/ai_assist_api_key` 固定挂载点（当前为空占位）；
- `/run/secrets/ai_assist_encryption_key` 在线配置信封加密主密钥（`0400 / 10001:10001`）；
- `GET/PUT /api/v1/admin/ai-assist` 与测试连接接口；匿名访问返回 401。

正式库 `app.ai_assist_settings` 当前已有 1 条在线配置。管理员可通过 Casdoor SSO 进入
「成员与设置 → AI 辅助转换」，填写正式端点、模型和 API Key，先执行“测试连接”再保存；
保存后数据库配置优先于环境变量，API Key 仅以 AES-256-GCM 密文落库。
本轮正式环境同步未重新执行 AI 模型调用，不能仅凭配置行存在声称 AI 入口已通过上线验收。
不要把测试 VM 的 API Key、密文或主密钥复制到正式环境。

## 企业微信桥接

正式桥接是独立于 Compose 的 `inpulse-wecom-bridge` 容器，不是测试 VM 配置的复制。当前状态：

- 镜像 `inpulse-wecom-bridge:0.1.0-20261030-prod-bridgede58b78@sha256:d70c6b3ef0e03929e92e815bde1d3e58ce2ba04aee47e88d8a57cd69a5cea3cb`，基座固定到正式 API 的
  `tag@sha256` 引用；
- 用户 `10001:10001`、只读根、`cap-drop ALL`、`no-new-privileges`、256 MiB 内存；
- 同时接入 `inpulse-deploy_backend` 与 `inpulse-deploy_egress`；
- 正式独立主密钥 `secrets/wecom_robot_encryption_key`（`0400 / 10001:10001`），API 与桥接共用；
- 数据库连接与项目群 Webhook 物化已启动，桥接按持久化游标继续消费；
- 正式库 `app.wecom_robot_config` 已有机器人配置；2026-10-30 更新日志显示 WebSocket 握手与 `aibot_subscribe` 返回 `errcode=0`，长连接已就绪。

管理员通过 Casdoor SSO 进入「成员与设置 → 企业微信机器人」保存 Bot ID 与 Secret 后，
桥接会自动轮询到配置并连接；只有日志出现「订阅成功」才可确认长连接已建立。
机器人配置完成后，项目成员可用个人绑定码完成单聊绑定；项目群由组长或系统管理员添加
企业微信 Webhook。个人单聊与项目群 Webhook 是独立通道，任一未配置时只有对应通道没有可验收的真实收件人。

桥接日常更新：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction
```

详细配置、验证和回滚见 [正式桥接说明](./wecom-bridge/README.md)。

## 2026-10-30 发布记录

- 发布提交 `70a94a36f19548344c8f8ca39805f16146981523`，主栈 Tag `0.1.0-20261030-70a94a36`，更新范围为 `api,web,migrate,ops`；按用户要求不更新 `db-bootstrap`。
- 镜像摘要：API `sha256:928d830a7d5d81a55ab238c2cfb26ea402da614a0a25851fa544bdbd8476d5b6`、Web `sha256:46c7cce500a480ebeb188419e8e898bb6cdce8bf15726585fa8a2a140ff6be94`、Migration `sha256:278e6fb50df7a241f880dc4e62eb4b597f0166dec3910c16f3dd60bb5e9b525c`、Ops `sha256:e3186cf19d2d2750401fa49ed6558859fff5e0b59978f4db58abd74a9f4d5bc4`。
- 数据库迁移前备份 `backups/pre-sync-20261030-171624.dump`（444,912 字节、791 项）；`migrate` 退出码 0，`0065` 应用成功（`1 applied, 63 already present`），迁移总数 64。
- 数据核验：保留 1 个项目、3 个模块、4 个任务、84 名用户；功能表、功能列、功能搜索投影与功能序列均为 0，历史 `FEATURE` 审计 23 行、项目动态 7 行保留。
- 桥接更新为 `0.1.0-20261030-prod-bridgede58b78@sha256:d70c6b3ef0e03929e92e815bde1d3e58ce2ba04aee47e88d8a57cd69a5cea3cb`，逐文件校验通过，长连接订阅返回 `errcode=0`。
- 入口探针：`/health/ready`、`/`、`/login` 均返回 200；匿名搜索返回 401；SSO start 返回 302 到正式 Casdoor。
- 发布前门禁：全 workspace 单元测试、类型检查、契约校验与漂移、构建、前端边界、权限矩阵、lint、格式、部署静态检查、迁移检查和 Secrets 检查通过；未运行 Playwright、完整集成/E2E、Trivy 或 GitHub Actions。

## 日常更新

正式更新必须在干净 Git 工作区执行，且必须显式确认：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update.ps1 -ConfirmProduction
```

只更新部分镜像时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update.ps1 -ConfirmProduction -Targets api,migrate
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update.ps1 -ConfirmProduction -Targets web
```

脚本会拒绝未提交工作区，并固定以下正式参数：

- 主机 `10.1.103.45`、站点 `inpulse.libiaorobot.com`；
- 本机只需 Node.js 24、Git、ssh、scp，按 Git 文件清单上传源码；正式机在隔离构建目录执行 `docker build`；
- 镜像 Tag 使用短 SHA，`BACKUP_GIT_SHA` 使用完整 40 位 SHA；
- 远端更新前备份 `.env.deploy` 并强制权限 `0600`；
- 使用 `tag@sha256` 固定镜像引用；
- 更新后执行 `/health/ready` 与首页探针。

首次配置部署密钥时可使用共享执行器一次性完成；已配置的 `~/.ssh/inpulse_deploy_ed25519` 可直接复用。若 sudo 需要密码，优先在当前交互会话中提示输入，不把密码写入脚本或文件。

## 发布前门禁

每次正式发布前至少完成：

1. `git status --porcelain` 为空，发布内容由提交固定；
2. `pnpm check:deploy:static`、`pnpm db:migrations:check`、`pnpm check:secrets` 通过；CI 的严格 `pnpm check:deploy:test` 已通过（该命令需要 Docker，不在无 Docker 的本地环境执行）；
3. 含迁移时先按[备份与恢复 Runbook](../../docs/runbooks/backup-restore.md)完成可解密备份；
4. 镜像扫描按 CI 口径执行 `CRITICAL,HIGH` 且 `ignore-unfixed=true`；
5. 更新后核对容器健康、TLS、`/health/ready`、匿名保护接口和 SSO 302；
6. 记录发布 Tag、镜像 digest、迁移结果、观察窗口与回滚点。

`deploy/prod/update.ps1` 只负责源码上传、VM 构建与 Compose 更新，`deploy/prod/update-bridge.ps1` 单独更新企业微信桥接；发布审批和发布清单归档仍由人工完成。

## 正式机常用检查

```bash
cd /home/libiao/inpulse-deploy
sudo docker compose --env-file .env.deploy -f compose.yaml ps
curl -fsS https://inpulse.libiaorobot.com/health/ready
curl -sS -I http://inpulse.libiaorobot.com/
curl -sS -I https://inpulse.libiaorobot.com/api/v1/auth/sso/start
```

数据库基线检查：

```bash
sudo docker exec -it inpulse-deploy-db-1 psql -U cluster_bootstrap -d app -c "select count(*) from app.users;"
sudo docker exec -it inpulse-deploy-db-1 psql -U cluster_bootstrap -d app -c "select count(*) from app.schema_migrations;"
```

## 尚未完成的上线门禁

站点和正式数据面已经可用，但在以下事项完成前不得标记为完整 Go-Live：

- `backupctl.sh enable --confirm-go-live` 尚未启用：缺少 S3 兼容异机存储凭据、对象锁策略、备份告警 Webhook 和可解密恢复演练证据；
- `audit-archivectl.sh enable --confirm-go-live` 尚未启用：缺少 WORM 审计存储凭据与归档签名材料托管方案；
- 正式数据库口令、keyring、备份加密密钥和 TLS 私钥目前只在正式机，尚无离机离线托管；
- `/etc/ssl` 下的通配符证书当前有效期至 `2026-12-01`；正式机 ALLinSSL SSH reload 路径已自测通过，但 ALLinSSL 平台工作流是否已指向正式机仍需确认；
- AI 辅助与企业微信桥接的上线验收仍未完成：本轮未验证正式 AI 模型调用或真实收件人投递；企业微信机器人配置已存在且桥接长连接订阅成功，但个人单聊与项目群 Webhook 的真实收件仍需业务侧验收。

完成上述门禁前，可把当前状态描述为“正式环境已部署并通过基础可用性验证”，不要描述为“生产备份与恢复已验收”。

# 测试 VM 更新手册

本目录的 `update.ps1` 用于把仓库当前代码更新到测试 VM。它面向单机 Docker
Compose + 本地 registry 的测试环境，不是生产发布流程：生产镜像 Tag/digest 绑定
与签名发布仍按技术设计第 12 章由人工完成，生产升级与回滚口径见
`docs/runbooks/upgrade-rollback.md`。

## 测试环境现状

| 项目          | 值                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| VM            | `10.1.104.45`（Ubuntu + Docker + Compose v2；SSH 账户 `libiao`，docker 命令需 sudo）                           |
| 访问入口      | `https://test-inpulse.libiaorobot.com/`（DNS 指向同一台 VM；HTTPS 请用域名访问，用 IP 会出现证书不匹配告警）   |
| 部署目录      | `/home/libiao/inpulse-deploy`（`compose.yaml`、`.env.deploy`、`secrets/`）                                     |
| 镜像目录      | `/home/libiao/inpulse-images`                                                                                  |
| 本地 registry | `127.0.0.1:5000`（容器 `inpulse-registry`，镜像 `registry:2`）                                                 |
| 运行服务      | `db`（PostgreSQL 18 + PGroonga）、`migrate`（一次性）、`api`、`web`（Nginx）                                   |
| 对外端口      | 22、80（308 跳转到 443）、443                                                                                  |
| SSO           | Casdoor 测试环境 `https://authtest.libiaorobot.com`                                                            |
| TLS           | 公司 ALLinSSL 下发 `*.libiaorobot.com` 通配符（DigiCert，2026-10-15 生效，自动续签；文件 `secrets/tls_*.pem`） |
| 部署目录补充  | `backups/`（同步前的 pg_dump）、`compose.yaml.bak-*`、`.env.deploy.bak-*`（回滚用）                            |
| 企业微信桥接  | 独立容器 `inpulse-wecom-bridge`（非 compose 管理；源码 `deploy/test-vm/wecom-bridge/` 为本地唯一源，用 `deploy/test-vm/update-bridge.ps1` 同步；个人绑定码自助绑定与项目群绑定兑换均已实现，见「企业微信机器人桥接」） |
| AI 辅助转换   | 已启用（`AI_ASSIST_ENABLED=1`）；API Key 已于 2026-10-15 在设置页重填并确认可用（见「AI 辅助转换启用」） |
| 当前版本      | api 为 `0.1.0-20261022-3e9d5970`，migrate 为 `0.1.0-20261021-4ce04902`，db-bootstrap 为 `0.1.0-20261021-secfix1`，web 为 `0.1.0-20261023-sec1`，ops 为 `0.1.0-20261022-1d0ca6b`；桥接为 `0.1.0-20261021-bridge7cddf14`；`BACKUP_GIT_SHA=1d0ca6b5`（2026-10-23 09:53 最新同步） |

## 一次性准备

1. 配置免密登录（只需做一次）。脚本会生成一把无 passphrase 的部署密钥
   `~/.ssh/inpulse_deploy_ed25519`，并把公钥追加到 VM 的 `~/.ssh/authorized_keys`，
   过程中只要求输入一次 VM 密码：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -SetupKey
   ```

   不配置也能更新，只是上传镜像、执行远端脚本会分别提示输入 VM 密码（约 4 次）。
   脚本不会覆盖你已有的密钥；想用自己的密钥就加 `-SshKey <私钥路径>`。

2. 让脚本能自动应答远端 sudo：在当前 PowerShell 会话里把 VM 登录密码放进环境变量
   `INPULSE_VM_PASSWORD`（脚本只通过 stdin 把它交给远端 `sudo -S`，不写入文件、
   不出现在命令行）。不设置也可以，远端 sudo 会在终端交互提示密码。

3. 确认 Docker Desktop 已启动，且本机能连通 VM 的 22 端口。

4. 本机执行策略是 `Restricted` 时，`powershell -File` 会被拦下；统一按上面的
   `-NoProfile -ExecutionPolicy Bypass` 形式调用即可（只对本次调用生效，不改系统设置）。

## 日常更新

在仓库根目录执行，默认构建并更新全部 5 个镜像：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1
```

只改了一部分时用 `-Targets` 省时间：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -Targets web
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -Targets api,migrate
```

脚本依次完成：构建镜像 → 导出 tar → 上传 → VM 上 load/tag/push 到
`127.0.0.1:5000` → 以 `tag@sha256` 更新 `.env.deploy` 的 `*_IMAGE_REF` →
`docker compose up -d`（`migrate` 先执行数据库迁移）→ 健康检查 → 清理 tar。
构建日志留在本机 `%TEMP%\inpulse-update-<tag>\build-<target>.log`。
2026-10-15 已分三次实测跑通整条链路（`-Targets web`、`-Targets api,web,migrate -FixEol`、
`-Targets ops`、`-Targets db-bootstrap`），5 个镜像统一到 `0.1.0-20261015-277fb89`：
migrate 报 `0 applied, 42 already present`，api/web/db 全部 healthy，`/health/ready` 与
`/` 返回 200，匿名访问受保护接口 401，`/api/v1/auth/sso/start` 302 跳到 Casdoor 测试环境，
api 容器内访问 Casdoor discovery 返回 200（`egress` 生效）。

2026-10-15 18:00 再次实测（`-Targets api,web,migrate -FixEol`，Tag `0.1.0-20261015-8e97c8b`，含企业微信项目群绑定第一批）：EOL 预检零漂移；migrate 报 `0 applied, 43 already present`（迁移 `0044` 已随此前数据同步在库，账本校验和按注释级改动定点修正，见 FAQ）；api/web/db 全部 healthy，探针与 `egress` 校验同上；桥接同步到内容哈希 Tag `0.1.0-20261015-bridgedd2084d` 并订阅成功。

2026-10-15 19:35 同步 `-Targets api,web,migrate -FixEol` 到 `0.1.0-20261015-7f4d28e`（ADR-078 更换机器人自动解绑，含迁移 `0045`）：migrate 报 `1 applied, 43 already present`。2026-10-16 11:02 补齐 `-Targets web` 到 `0.1.0-20261016-1498026`（ADR-080 登录页直达 SSO），桥接同步到 `0.1.0-20261016-bridge525a07f`（欢迎语/限频、项目群投递 PENDING 队列 + 限速）：migrate 重跑报 `0 applied, 44 already present`，api/web/db 全部 healthy，探针同上，桥接订阅 errcode=0。本次未改迁移，未另做数据库备份（前一次为 `pre-sync-20261015-193456.dump`）。2026-10-16 12:13 再同步 `-Targets web` 到 `0.1.0-20261016-6bfbd56`（设置页权限矩阵说明表跨历史补齐）：migrate 重跑 `0 applied, 44 already present`，探针同上。2026-10-16 15:27 再同步 `-Targets api,web` 到 `0.1.0-20261016-a12322e`（AI 辅助端点只填根地址时自动补全 `/chat/completions`）：migrate 顺带重跑报 `0 applied, 44 already present`（本次增量无迁移，migrate 镜像仍为 `0.1.0-20261015-7f4d28e`），api/web/db 全部 healthy，探针：`/health/ready`、`/`、`/login` 200，匿名 `/api/v1/users` 401、`/api/v1/auth/sso/start` 302；本次未改迁移，未另做数据库备份。2026-10-20 13:58 再同步 `-Targets api,web,migrate -FixEol` 到 `0.1.0-20261020-7ab34e4`（ADR-081～088：组织分组、停用收敛、墓碑化删除、项目审计保留、身份快照、离职账号物理删除等，含迁移 `0046`～`0053`）：同步前落 `backups/pre-sync-20261020-135335.dump`（709 项 / 46 张表，`pg_restore --list` 校验通过）；首次 `compose up` 时 migrate 在 `0047_user_deletion_tombstone.sql` 校验失败（`users_immutable_columns must use app.enforce_users_immutable_columns`，根因与处置见 FAQ），修正 VM 的 `app_migrator` 会话 `search_path` 后重跑：`7 applied, 45 already present`（累计 52），api/web/db 全部 healthy，探针：`/health/ready`、`/`、`/login` 200，匿名 `/api/v1/users` 401、`/api/v1/auth/sso/start` 302；数据抽查 users 14、projects 6、audit_logs 1657、organizations 0（新表）。

2026-10-20 16:20 再同步 `-Targets api,web,migrate -FixEol -NoMirror` 到 `0.1.0-20261020-a0966c4a`（ADR-089/090：停用账号前项目组长移交、项目企业微信群通知策略服务端化，含迁移 `0054_user_notification_suppressions.sql` 与 `0055_project_wecom_group_notification_options.sql`）：同步前落 `backups/pre-sync-20261020-1606.dump`（734 项，`pg_restore --list` 校验通过）；迁移账本增至 54 条，api/web/db 全部 healthy，`/health/ready` 与 `/` 返回 200；数据保持 users 14、projects 6、audit_logs 1662。桥接源同步到 `0.1.0-20261020-bridge459c176` 并订阅 `errcode=0`；首次因依赖刷新误用桥接运行镜像而报 npm 不存在，现改为固定 Node 镜像（本次 `package.json` 未变化，依赖刷新未触发）。工作区仍有未提交改动，镜像 Tag 仅标明 HEAD，后续重建不要复用同名 Tag。

2026-10-21 10:33 再同步 `-Targets api,web,migrate -FixEol -NoMirror` 到 `0.1.0-20261021-4ce04902`（ADR-091/092：项目封箱海报、成功气泡、权限矩阵整合与项目状态版本解耦，含迁移 `0056_project_wraps.sql`、`0057_project_status_version_semantics.sql`）：同步前落 `backups/pre-sync-20261021-101754.dump`（`pg_restore --list` 747 项）；migrate 报 `2 applied, 54 already present`（账本 56 条），api/web/db 全部 healthy，`/health/ready`、`/`、`/login` 返回 200，匿名 `/api/v1/users` 401，`/api/v1/auth/sso/start` 302；数据为 users 14、projects 6、audit_logs 1665（部署新增 1 条审计）、库 186 MB，`app.project_wraps` 已存在且当时为 0 行。桥接同步到 `0.1.0-20261021-bridge7cddf14`：`package.json` 变化触发依赖刷新（新增 2 个包），镜像安装 `fonts-noto-cjk`，容器内通知分类与海报自检 `10/10`，日志 `通知桥 v7`、`errcode=0` 与「订阅成功」。本次构建期间工作区出现另一任务的未提交 Web 星标排序改动，因此镜像 Tag 只标明 HEAD、不能唯一证明镜像内容；`ops`/`db-bootstrap` 未重建。

2026-10-21 10:48 再同步 `-Targets web -FixEol -NoMirror` 到 `0.1.0-20261021-2c2be247`（星标排序同步到侧栏，对应提交 `2c2be247`）：本次只重建 web，api/migrate 保持 `0.1.0-20261021-4ce04902`；migrate 重跑报 `0 applied, 56 already present`，web 转为 healthy，`/health/ready`、`/`、`/login` 返回 200，匿名 `/api/v1/users` 401，`/api/v1/auth/sso/start` 302；本次无迁移，未另做数据库备份。

2026-10-21 11:12 再同步 `-Targets web -FixEol -NoMirror` 到 `0.1.0-20261021-9abf8bfb`（组织批量操作条移至成员列表上方，对应提交 `9abf8bfb`）：本次仍只重建 web，api/migrate 保持 `0.1.0-20261021-4ce04902`；migrate 重跑报 `0 applied, 56 already present`，web 转为 healthy，`/health/ready`、`/`、`/login` 返回 200，匿名 `/api/v1/users` 401，`/api/v1/auth/sso/start` 302；本次无迁移，未另做数据库备份。

2026-10-21 17:34 域名发布前安全加固同步：先用 `-Targets api,web`、再用 `-Targets db-bootstrap` 更新到 `0.1.0-20261021-secfix1`（API/web digest 分别 `bb9934317d68`/`461ba74f6c8d`，db `227f4224df92`），未重建 migrate。同步前落 `backups/pre-sync-20261021-172814.dump`（`pg_restore --list` 758 项，`pg_data` 仍挂 `/var/lib/postgresql`）；VM `compose.yaml` 先备份为 `compose.yaml.bak-secfix1-20261021-172645`，仅给 web 健康检查补 `Host: test-inpulse.libiaorobot.com`，`egress` 保持不变。内容包含 Vite 8.2.4（修复 `GHSA-587h-7wmj-h5pm`）、API 关闭 `X-Powered-By`、Nginx `server_tokens off`、Host 白名单（未知 Host 421）、隐藏/部署路径 404，以及 web `libexpat1`、db `libcurl4t64` 安全升级。结果：migrate `0 applied, 56 already present`；api/web/db 全部 healthy；`/health/ready`、`/`、`/login` 200，匿名 `/api/v1/users` 401，`/api/v1/auth/sso/start` 302；恶意 Host 421 且无恶意 `Location`，隐藏路径均 404，`Server: nginx` 无版本号；api 容器访问 Casdoor discovery 200（`egress` 生效）；数据为 users 14、projects 7、audit_logs 1687、sessions 148，库 186 MB，PGroonga 4.0.8，`libcurl4t64 8.14.1-2+deb13u7`。Trivy 按 CI 口径（CRITICAL/HIGH、忽略未修复）扫描 api/web/db-bootstrap 均为 0；公共 registry `pnpm audit --audit-level=high` 只剩 1 个 moderate（`mammoth -> argparse -> sprintf-js`，上游暂无修复）。本次工作区仍有未提交改动，Tag 只表示安全修复批次，不代表已提交内容。

2026-10-22 10:10 同步远端 Web 三批与本地 web/ops 镜像：`-Targets web,ops -Tag 0.1.0-20261022-1d0ca6b`；未改 api/migrate/db；`.env.deploy.bak-20261022-101020` 已保留；migrate exit=0，api/web/db 全部 healthy；公网 `/health/ready`、`/`、`/login` 200，SSO start 302，恶意 Host 421，`Server: nginx` 无版本。

2026-10-23 09:53 修复 Web 安全回归并同步 `0.1.0-20261023-sec1`：最新 Trivy 库发现旧 web 镜像 `libexpat1 2.8.3` 的 5 个可修复 High，同时实际响应暴露 `Server: nginx/1.30.4` 且恶意 Host 返回 200。重建后 web digest 为 `8e5aedb18d50`，CI 口径 5/5 通过；域名入口复测 `/health/ready` 200、`/` 200、`/login` 200、匿名 `/api/v1/users` 401、SSO start 302、恶意 Host 421、HTTP 首页 308、隐藏路径 404。

常用参数：

| 参数                                              | 作用                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `-Repo`                                           | 要构建的工作区，默认脚本所在仓库根                            |
| `-Targets`                                        | `api`/`web`/`migrate`/`db-bootstrap`/`ops`，或 `all`（默认） |
| `-Tag`                                            | 镜像 Tag，默认 `0.1.0-<yyyyMMdd>-<git 短 sha>`                |
| `-SetupKey`                                       | 一次性配置免密部署密钥后退出                                  |
| `-SshKey`                                         | 指定 SSH 私钥；留空时自动挑第一把能免密登录的候选密钥         |
| `-VmPassword`                                     | VM 密码，只喂给远端 `sudo -S`；推荐改用 `INPULSE_VM_PASSWORD` |
| `-Mirror`                                         | 基础镜像源，默认 `docker.1ms.run`                            |
| `-NoMirror`                                       | 不走镜像源，直接用 Dockerfile 里的原始地址                    |
| `-FixEol`                                         | 构建 migrate 前把漂移成 CRLF 的迁移文件按字节转回 LF          |
| `-SkipBuild`                                      | 跳过构建与上传，用 VM 上已有 tar 重跑远端更新                 |
| `-KeepTar`                                        | 保留两端 tar（默认清理）                                      |
| `-VmHost`/`-VmUser`/`-RemoteDir`/`-ImageDir`        | 覆盖默认连接信息与目录                                        |

## 基础镜像与镜像源

公司网络直连不了 Docker Hub，`docker build` 会卡在 `FROM` 阶段。脚本默认先用镜像源
`docker.1ms.run` 把 Dockerfile 里 `FROM` 与 `# syntax=` 引用的基础镜像拉到本地、重打回
原始名字，然后才开始构建：

- 带 `@sha256:...` 的引用会在拉取后逐个校验 digest，不匹配立即失败，避免镜像源掉包；
- 本地已缓存全部基础镜像时加 `-NoMirror` 跳过这一步，更快；
- 换源用 `-Mirror <host>`。`docker.1ms.run` 于 2026-10-15 实测可拉取 `node`、`postgres`；
  `docker.m.daocloud.io` 对 `library/*` 返回 502。

基础镜像清单直接从 `deploy/docker/*.Dockerfile` 解析，改 Dockerfile 不用改脚本。

## 改了什么就更新什么

| 改动范围                              | Targets                     | 说明                                       |
| ------------------------------------- | --------------------------- | ------------------------------------------ |
| `apps/web`、`deploy/docker/nginx.conf`  | `web`                         | 前端产物与反向代理配置都打在 web 镜像里    |
| `apps/api`、`packages/*`                | `api`                         |                                            |
| `database/migrations/*`               | `migrate`（通常连 `api`）        | 迁移由 migrate 服务执行                    |
| `database/bootstrap/*`              | `db-bootstrap`              | 只在数据卷为空、首次初始化数据库时生效     |
| `apps/ops`、`deploy/backup/*`           | `ops`                         | 备份与审计归档                             |
| `deploy/compose.yaml`、`.env.deploy`    | 不走镜像                    | 见下一节                                   |
| `deploy/test-vm/wecom-bridge/*`      | 不走 compose 镜像             | 跑 `deploy/test-vm/update-bridge.ps1`，见「企业微信机器人桥接」 |

## compose.yaml / .env.deploy 改动怎么同步

脚本只改 `.env.deploy` 里的 `*_IMAGE_REF` 与 `BACKUP_GIT_SHA`，**不会**覆盖 VM 上的
`compose.yaml`：VM 侧有测试环境专属适配，直接覆盖会打断服务。改了仓库里的
`deploy/compose.yaml` 后按下面三步手工同步。

### 第一步：补齐 compose 新引用的 Secret 文件

compose 声明了 `file:` 型 Secret 而 VM 上没有对应文件时，`compose up` 会直接失败。
ADR-068 起 api 需要 `secrets/ai_assist_encryption_key`（一行 `版本:64 位十六进制`，
属主 `10001:10001`、权限 `400`）。在 VM 上执行，**不要把内容打印或贴进任何文档**：

```bash
cd /home/libiao/inpulse-deploy/secrets
sudo install -m 400 -o 10001 -g 10001 /dev/null ai_assist_encryption_key
printf '1:%s\n' "$(openssl rand -hex 32)" | sudo tee ai_assist_encryption_key > /dev/null
stat -c '%n %U:%G %a %s' ai_assist_encryption_key
```

`AI_ASSIST_ENABLED=0` 时 api 不会去读它，但文件必须存在。这把主密钥用于信封加密
管理员在线填写的 AI 端点密钥：**丢了就无法解密已存密钥**，只能在管理页重新填写。

### 第二步：比对差异，只合并新增部分

```powershell
scp libiao@10.1.104.45:/home/libiao/inpulse-deploy/compose.yaml $env:TEMP\vm-compose.yaml
git diff --no-index -- $env:TEMP\vm-compose.yaml deploy/compose.yaml
```

2026-10-15 起 `egress` 已按 [ADR-074](../../docs/adr/ADR-074.md) 并入仓库
`deploy/compose.yaml`；同日 VM 侧新增企业微信接线（见「企业微信机器人桥接」），
这是当前仓库与 VM 的 compose 唯一差异——仓库 `deploy/compose.yaml` 后续变更时，
按本节流程比对合并并保留该差异。下列适配不能丢
（`tmpfs` 写法与 `DB_SSLMODE` 已进仓库工作区）：

- `api` 服务的 `networks: [backend, egress]` 与 `networks` 段的 `egress` 定义。
  `backend` 是 internal 网络、没有外网出口，api 靠 `egress` 访问 Casdoor 与 AI 端点；
  丢掉它 SSO 会回跳 `/login?sso_error=internal`。
- `api` 服务的 `WECOM_ROBOT_ENCRYPTION_KEY_FILE` / `WECOM_ROBOT_ENCRYPTION_KEY_VERSION`
  环境变量、`wecom_robot_encryption_key` 只读 Secret 挂载项，与顶层
  `secrets.wecom_robot_encryption_key: file: ./secrets/wecom_robot_encryption_key`
  （2026-10-15 加；丢它管理员「企业微信机器人」设置页会报 `ENCRYPTION_KEY_UNAVAILABLE`）。

`.env.deploy` 侧要保留：`DB_SSLMODE=prefer`（VM 的 PostgreSQL 未启用服务端 TLS，
postgres.js 在 `require` 下会直接连接失败）、指向 Casdoor 测试环境的 `SSO_*`
（回调地址须已在 Casdoor 应用里登记）。

### 第三步：备份、上传、校验、重启

```bash
cd /home/libiao/inpulse-deploy
sudo cp -p compose.yaml compose.yaml.bak-$(date +%Y%m%d-%H%M%S)
# 本机把合并后的文件 scp 覆盖上来，然后在 VM 上：
sudo docker compose --env-file .env.deploy -f compose.yaml config --quiet
sudo docker compose --env-file .env.deploy -f compose.yaml up -d
```

`config --quiet` 只应打印 `uid/gid/mode is not supported outside Swarm mode` 这类无害
告警；出现其它报错就不要 `up`，先用 `compose.yaml.bak-*` 还原。

另外，`compose.yaml` 的 tmpfs 必须写成块式列表或单字符串；写成
`tmpfs: [/tmp:size=64m, noexec, nosuid, nodev]` 会被 YAML 解析成 4 个挂载项。

2026-10-15 已按上述流程把 ADR-068 的 `AI_ASSIST_ENCRYPTION_KEY_FILE` /
`AI_ASSIST_ENCRYPTION_KEY_VERSION`、只读 Secret 挂载与顶层
`secrets.ai_assist_encryption_key` 合入 VM 侧 `compose.yaml`
（备份 `compose.yaml.bak-20261015-113910`），`egress` 适配保留。

## 证书下发（公司 ALLinSSL，2026-10-15 接入）

公司用 ALLinSSL 统一管理 SSL 证书（`*.libiaorobot.com` 通配符、DNS 校验、自动续签），
VM 按官方「SSH 下发」方式接入，不需要自行申请证书；2026-10-15 已首次下发生效
（DigiCert RapidSSL 签发，主体 `*.libiaorobot.com`，有效期至 2026-12-01，到期前自动续签）：

- 低权限账号 `allinssl`（不加入 sudo 组）只能覆盖
  `/etc/ssl/libiaorobot.com.pem` 与 `/etc/ssl/libiaorobot.com.key` 两个文件；
- 后置命令固定为 `sudo /usr/local/bin/allinssl-reload`（脚本 root 所有）：校验两个文件
  非空 → 覆盖 `secrets/tls_cert.pem` / `secrets/tls_key.pem`（原地写、保 inode，
  web 容器内立即可见）→ `chown 101:101`、`chmod 600` →
  `docker exec inpulse-deploy-web-1 nginx -t && nginx -s reload`，无需重启容器；
- 连接信息与账号密码见 `/home/libiao/inpulse-deploy/allinssl-ssh-info.txt`（600），
  在 ALLinSSL「授权 API 管理 → SSH」按该文件添加主机；工作流部署节点填：证书路径
  `/etc/ssl/libiaorobot.com.pem`、私钥路径 `/etc/ssl/libiaorobot.com.key`、后置命令
  `sudo /usr/local/bin/allinssl-reload`，建议开启「重复部署跳过」；
- 手动自测（任意能连到 VM 的机器）：

  ```bash
  ssh allinssl@10.1.104.45 'test -w /etc/ssl/libiaorobot.com.pem && test -w /etc/ssl/libiaorobot.com.key && sudo -n /usr/local/bin/allinssl-reload && echo OK'
  ```

- 注意：通配符只覆盖一级子域名（`test-inpulse.libiaorobot.com` 可以）；不要手删
  `/etc/ssl` 下这两个文件（`allinssl` 无法重建，需重跑初始化）。

## 同步前给数据库做备份

镜像能按 `.env.deploy.bak-*` 回滚，但迁移**只能向前**：新镜像跑过的迁移不会因为回滚
镜像而撤销。所以涉及 `migrate` 的更新前先落一份 dump（102 MB 的测试库约 1 秒）：

```bash
cd /home/libiao/inpulse-deploy
mkdir -p backups
sudo docker exec inpulse-deploy-db-1 pg_dump -U cluster_bootstrap -d app -Fc \
  > backups/pre-sync-$(date +%Y%m%d-%H%M%S).dump
sudo chown libiao:libiao backups/pre-sync-*.dump
sudo chmod 600 backups/pre-sync-*.dump
sudo docker exec -i inpulse-deploy-db-1 pg_restore --list < backups/<文件名>.dump | wc -l
```

最后一条用来确认 dump 可读（应输出几百行条目；2026-10-15 那份是 677 行、43 张表）。
恢复用 `pg_restore --clean --if-exists`，属于破坏性操作，执行前先确认没人在用这台 VM。

## 把本地演示数据同步到测试 VM（2026-10-15 实作）

目标：把本机演示库（`app` @ `127.0.0.1:55432`）的行数据整体搬到 VM。表结构跟随
镜像迁移，不在本流程内。全程约 1 分钟；执行前先按上一节落一份 VM 备份。

1. 本地导出（PowerShell）：

   ```powershell
   & "D:\PostgreSQL\18\pgsql\bin\pg_dump.exe" -Fc -f $env:TEMP\inpulse-demo-app.dump `
     "postgresql://cluster_bootstrap@127.0.0.1:55432/app"
   ```

2. 干净性预检：本地演示库可能残留历史 E2E 夹具的悬空行（外键孤儿），直接恢复会在
   加约束阶段失败。推荐在 VM 上建一个 scratch 演练库空跑一次恢复（`create database
   app_scratch` → `pg_restore` 不加 `--single-transaction` 收集全部 `ERROR` →
   `drop database app_scratch`），按报告清干净再重新导出。2026-10-15 实测只报出 4 行
   `change_record_version_leftovers` 孤儿（对应记录本体早已删除），删除后通过。

3. 上传并恢复（破坏性操作，确认没人在用 VM 时执行）：

   ```bash
   cd /home/libiao/inpulse-deploy
   sudo docker compose --env-file .env.deploy -f compose.yaml stop api
   sudo docker exec -i inpulse-deploy-db-1 pg_restore -U cluster_bootstrap -d app \
     --clean --if-exists --single-transaction < /tmp/inpulse-demo-app.dump
   sudo docker compose --env-file .env.deploy -f compose.yaml up -d
   ```

   `--single-transaction` 保证失败整体回滚、原数据完好（2026-10-15 实际演练过一次）。

4. 迁移账本：dump 会连同本机的 `app.schema_migrations` 一起恢复。本机账本只要存在
   行尾漂移，`migrate` 就会 checksum fail closed、连带 api 不启动（2026-10-15 实测
   13 条漂移直接炸停）。处理二选一：优先修好本机账本（把 checksum 对齐到文件的 LF
   形态，已修，此后本机与 VM 账本逐字节一致）；或恢复后用 pre-restore dump 的原账本
   替换：

   ```bash
   docker exec -i inpulse-deploy-db-1 pg_restore -f - --data-only -t schema_migrations \
     < backups/pre-restore-<时间戳>.dump > /tmp/mig-rows.sql
   { echo "delete from app.schema_migrations;"; cat /tmp/mig-rows.sql; } | \
     docker exec -i inpulse-deploy-db-1 psql -v ON_ERROR_STOP=1 -1 -U cluster_bootstrap -d app
   ```

   注意 `-t` 不要带 `app.` 前缀（带 schema 限定会匹配不到任何条目）。

5. 收尾：清理 dump 带入的本机残留扩展（如 `drop extension if exists pg_trgm`，0005
   契约迁移早已移除，本机属开发调试残留），再按「更新后验证」核对行数与站点探针。

两处跨环境绑定差异（演示用途可接受）：审计链 HMAC 由各自环境的
`secrets/audit_hmac_keyring` 签发，跨环境的审计链全量校验/归档任务会报不匹配；
`ai_assist_settings` 的密钥密文由本地主密钥加密，VM 当前 `AI_ASSIST_ENABLED=0`
不读取——要在 VM 试用 AI 助手，在管理页重新填写一次即可。
### 在测试环境站点内直接录入演示内容（2026-10-16 实作，VM 独有）

用户要求在系统自有的「InPulse 研发交付平台」（项目 1）里，把 2026-10-13 以来的真实交付变化
整理成新的模块 / 功能 / 任务 / 迭代记录并指派成员。本次没有走「本地导出 → VM 恢复」链路，
而是以邵晨宇的 SSO 账号登录 `https://test-inpulse.libiaorobot.com/` 后经站点 API 直接录入
（登录 → CSRF → 带 `Idempotency-Key` 的写接口，全链路走正规审计 / 通知 / 投影）：

- 新增模块：企业微信集成、AI 辅助；并在既有「平台与访问」「前端与体验」下新增 3 个功能（共 7 个功能）。
- 新增任务 21 个（19 个完成、2 个待办）；邵晨宇出现在 10 个任务、林雨妍出现在 12 个任务（其中 1 个为双负责人）。
- 发布迭代记录 `INPULSE-CR-139` ~ `INPULSE-CR-145` 共 7 条。
- 录入脚本为临时工具（只在 `%TEMP%` 下，未入仓库）：按「同名即复用、缺失才创建」实现，可安全重跑；实测重跑全部 exists、无重复。

执行前备份 `backups/pre-entry-20261016-1440.dump`（`pg_restore --list` 709 项）。录入产生的
48 条站内通知由桥接容器按既有链路推送企业微信（errcode=0）。

注意：本次只改了 VM 数据，本地演示库不含这批内容；且 VM 的用户 / 绑定状态（SSO JIT 账号、
管理员标记、个人与项目群绑定等）此前已领先本地。两边要完全一致，需要另行做一次 VM → 本地的
镜像恢复（破坏性，执行前先备份两边）。
## 企业微信机器人桥接（2026-10-15 部署）

测试 VM 的企业微信通知推送由一个**独立于 compose 栈**的桥接容器完成：轮询
`app.notifications`，把新通知经企业微信智能机器人长连接（`aibot_send_msg`）推给
已映射的成员；2026-10-16 起同一桥接把新的 `task.assigned` 通知与 `MEMBER` 可见项目动态物化后
投递到已绑定的项目群（2026-10-16 已同步到 VM，见下）。桥接源码已归档进本仓库 `deploy/test-vm/wecom-bridge/`（本地唯一源，
用 `deploy/test-vm/update-bridge.ps1` 同步到 VM）；它属于测试环境 PoC，不进
`deploy/compose.yaml`、不参与生产镜像与 CI 门禁。

- 容器 `inpulse-wecom-bridge`：`--restart unless-stopped`、`10001:10001`、只读根 +
  tmpfs；创建时接 `egress` 出网，再 `docker network connect` 到 `backend` 连库。
  镜像 `inpulse-wecom-bridge:0.1.0-<日期>-bridge<内容哈希前 7 位>`（同内容同 Tag；
  `FROM` 固定 api 镜像 `d7407c7`，复用其 node 24；pg/ws 与脚本一起打进镜像，已推入
  本地 registry；历史 Tag 均保留可回滚）。
- 部署目录 `/home/libiao/inpulse-deploy/wecom-bridge/`（`app/` 脚本与配置、
  `bridge.env`、`state/` 状态）。机器人凭据从数据库 `app.wecom_robot_config` 读取并
  用主密钥 `secrets/wecom_robot_encryption_key`（0400 / 10001:10001，与本地 keyring 同源）
  解密；管理员在「成员与设置 → 企业微信机器人」保存的新凭据会被桥接自动感知并重连。
  `app_runtime` 无 `audit_logs` 读权限，桥接查询已去掉该 join，操作人回落显示「系统」。
- 收件人映射以数据库 `app.user_wecom_bindings`（`status = 'ACTIVE'`）为唯一来源——用户在
  「账户菜单 → 绑定企业微信」里自助绑定/解绑即时生效（解绑后不再推送，即使
  `bridge-config.json` 里残留旧映射）。`bridge-config.json` 的 `recipients` 只作为「数据库里
  从未出现过该用户记录」时的过渡兜底，日常无需再手工维护。状态在
  `state/bridge-state.json`（lastId），只推新通知、不补发历史。
- **同一机器人同时只允许一条长连接**：VM 桥接与本地 PoC 不能同时在线，否则互相踢线。
  本地要跑 PoC 时先停 VM 侧，用完再启动。
- 进入会话欢迎语（2026-10-16）：用户进入机器人会话时按绑定状态回欢迎语——未绑定给「把绑定码发
  给我」的引导（默认 10 分钟最多一条），已绑定/未知只发一句简短欢迎（默认 24 小时最多一条）；
  普通文本消息（非绑定码）也按绑定状态回复指引，不再回显 PoC 调试文案。限频时间戳写在
  `welcomeStateFile`（默认与命令文件同目录），可用 `config.json` 的 `welcomeUnboundThrottleMs` /
  `welcomeBoundThrottleMs` 调整（毫秒，0 = 该类用户不再自动发）。
- 项目群消息投递（2026-10-16 本地实现并同步到 VM）：`bridge.mjs` 把新的 `task.assigned`
  通知与 `MEMBER` 可见项目动态物化为 `app.wecom_group_deliveries` 的 `PENDING` 行，
  `long-conn.mjs` 按 id 升序经 `chat_type:2` 将项目动态作为 `text_notice` 模板卡片投递到该项目绑定的群，并以响应 errcode
  回写 `SENT` / `FAILED` 与绑定行 `last_delivery_error`；限速 30 条/分钟、1000 条/小时，
  重启后从 PENDING 断点续传；`ADMIN_ONLY` 动态不进群；个人单聊与群推送并存。
  本地联调（真实群）已验证成功投递 / 失败回写 / 停机续传三条路径，合成数据已清理。

常用命令（VM 上执行，需 sudo）：

```bash
sudo docker logs --tail 50 inpulse-wecom-bridge   # 日志：订阅 errcode / 推送 / 心跳
sudo docker restart inpulse-wecom-bridge          # 重启（排查用；收件人映射改数据库即时生效）
sudo docker stop inpulse-wecom-bridge             # 暂停（本地要用 PoC 时）
sudo docker start inpulse-wecom-bridge            # 恢复
```

改脚本或重建镜像：**先改本地 `deploy/test-vm/wecom-bridge/`（唯一源，不要在 VM 上直接改）**，
再在仓库根目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update-bridge.ps1`：
上传 -> 远端 sha256 校验 -> 备份源码 -> 构建并推 registry -> 按固定安全参数重建容器并等「订阅成功」。
`-SkipRestart` 只更新镜像；`-RollbackTo <旧 Tag>` 用历史镜像重建容器回滚。

绑定码自助绑定（2026-10-15 已实现，镜像 bridge3）：用户在「账户菜单 → 绑定企业微信」生成一次
性绑定码（10 分钟有效），把它发送给企业微信里的 InPulse 机器人即可自动落库；桥接以 `app_runtime`
角色调用 `app.redeem_wecom_binding_code`（SECURITY DEFINER，单事务消费），成功后回复「绑定成功」，
失败按 WBC01/02/04/05/06 分类回复。`smoke-redeem.mjs`（镜像内 `/opt/wecom-bridge/`）
可在临时容器自检兑换链路（全程事务、结束回滚，不产生历史数据残留）。

项目群绑定兑换（2026-10-15 已实现，镜像 bridge4）：项目组长/系统管理员在「项目成员页 → 企业微信项目群」
生成一次性项目绑定码（10 分钟有效；发送者需已完成个人绑定，系统管理员豁免成员校验）。在目标群里
@机器人 发送该码（形如「@内部研发项目管理系统 XXXX-XXXX-XXXX-XXXX」）即完成群绑定；桥接从群消息文本中
提取绑定码（容忍「@机器人 」前缀），调用 `app.redeem_project_wecom_binding_code`（SECURITY DEFINER，
单事务消费），结果用 `chat_type:2` 主动推送回该群，失败按 PWG01～PWG08 分类回复；群里的非绑定码消息保持
安静，不再触发私聊回声。`smoke-project-group-redeem.mjs`（镜像内 `/opt/wecom-bridge/`）自检 16 项
（提取 / 首次绑定 / 幂等 / 换绑 / PWG01～PWG06）。**群消息投递**（任务派发与项目动态推送进项目群）已按 ADR-077 第二批在本地实现并通过真实群联调（成功投递 / 失败回写 / 停机续传），**已于 2026-10-16 同步到 VM**。

当前部署 Tag 为内容哈希 `0.1.0-20261021-bridge7cddf14`（2026-10-21 10:33 同步；源码以仓库 `deploy/test-vm/wecom-bridge/` 为唯一源，个人绑定、项目群绑定、欢迎语/限频、群投递、ADR-090 通知开关与项目封箱海报均含）。历史 Tag（bridge1～bridge4、`bridgee7cda2f`、`bridgedd2084d`）都保留在 registry，可用 `-RollbackTo` 回滚。

## AI 辅助转换启用（2026-10-15）

`.env.deploy` 的 `AI_ASSIST_ENABLED` 已置 1 并重建 api（备份
`.env.deploy.bak-20261015-145032`）。VM 侧 `secrets/ai_assist_encryption_key` 是
2026-10-15 11:38 在 VM 上生成的主密钥（与本地不同），从本地同步来的 API Key 密文
解不开；2026-10-15 14:47 管理员已在「系统设置 → AI 辅助转换」重填 API Key（当时保存
完整 chat/completions 地址），用户确认可用。2026-10-16 15:27 同步的 api
（`0.1.0-20261016-a12322e`）起，端点只填根地址（如 `https://xxx/v1`）也会在保存 /
测试连接时自动补全 `/chat/completions`（口径见 `docs/adr/ADR-067.md`）。

## 数据库迁移

- `compose up -d` 时 `migrate` 先执行（`api` 依赖 `service_completed_successfully`）；
  迁移失败则 api 不启动，脚本会打印 migrate 退出码与 api 最近日志。
- 查看迁移日志：

  ```powershell
  ssh libiao@10.1.104.45 "sudo docker logs --tail 80 inpulse-deploy-migrate-1"
  ```

- 历史迁移不可修改。回滚 `.env.deploy` 只能回滚镜像版本，**不能**回滚数据库结构；
  含破坏性迁移的版本要按迁移自身的兼容窗口处理。

## 回滚

脚本每次更新前都会把 `.env.deploy` 备份成 `.env.deploy.bak-<时间戳>`，旧镜像 Tag
也仍留在本地 registry 中：

```powershell
ssh libiao@10.1.104.45
cd /home/libiao/inpulse-deploy
ls -t .env.deploy.bak-*
sudo cp -p .env.deploy.bak-<时间戳> .env.deploy
sudo docker compose --env-file .env.deploy -f compose.yaml up -d
```

## 更新后验证

```powershell
curl.exe -k https://test-inpulse.libiaorobot.com/health/ready
curl.exe -k -o NUL -w "%{http_code}" "https://test-inpulse.libiaorobot.com/api/v1/search?q=hello"
curl.exe -k -I https://test-inpulse.libiaorobot.com/api/v1/auth/sso/start
```

期望依次是 200、401（匿名访问受保护接口）、302 跳转到 Casdoor 测试环境；
这三条已于 2026-10-15 实测通过。注意 `/api/v1/search` 不带 `q` 时会先返回 422
（查询参数校验先于鉴权），验证时必须带上 `q`。

## 磁盘与清理

- VM 根分区 40G；每次更新会在 registry 里新增一个 Tag，旧 Tag 保留用于回滚。
- 脚本默认删除两端 tar 并执行 `docker image prune -f`。
- 确认不再需要回滚后，可手工清理旧镜像：

  ```powershell
  ssh libiao@10.1.104.45 "sudo docker images 'inpulse/*' --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}'"
  ssh libiao@10.1.104.45 "sudo docker rmi <镜像 ID>"
  ```

  registry 内的旧 Tag 需要按 digest 调 `DELETE /v2/<name>/manifests/<digest>`，再跑
  `registry garbage-collect`；测试环境一般在磁盘吃紧时再处理。

## 常见问题

- 构建时 OOM（Out Of Memory，进程因内存不足被系统杀掉）：关掉占内存的程序，或用
  `-Targets` 只构建需要的镜像；Docker Desktop 的内存上限在 Settings → Resources 调整。
- 反复提示 `libiao@10.1.104.45's password`：说明没有可用的免密密钥（旧密钥可能带
  passphrase）。执行一次 `-SetupKey` 生成 `~/.ssh/inpulse_deploy_ed25519` 即可；
  脚本会按 `inpulse_deploy_ed25519` → `inpulse_test_deploy` → `id_ed25519` 的顺序
  自动挑选第一把真正能免密登录的密钥。
- migrate 退出 1、日志报 `Applied migration "00xx_....sql" was modified`：几乎都是
  **行尾漂移**，不是迁移被改动。`database/src/migrations.ts` 按文件原始字节算 sha256，
  工作区里 CRLF 的迁移文件会让校验和对不上数据库账本，于是 `compose up` 时 migrate
  失败、api/web 不启动、站点直接不可用。脚本在构建 migrate 前会用
  `git ls-files --eol` 预检并列出问题文件，加 `-FixEol` 可按字节转回 LF
  （只改行尾、不改内容，git 也不会产生变更）。已经炸了就按「回滚」一节还原
  `.env.deploy`。2026-10-15 曾因 13 个迁移文件漂移成 CRLF 触发过一次。
- migrate 报 `Applied migration "00xx_....sql" was modified` 但 EOL 预检零漂移时：校验和按文件原始字节计算，**注释级改动**（例如合并时 ADR 改号）同样会翻转校验和。2026-10-15 实例：合并把迁移 `0044` 注释里的 ADR-076 改成 ADR-077（仅 3 行注释、25902 字节等长、DDL 逐句全等），而本地/VM 账本仍记旧值，migrate fail closed。处置：先用 `git show <应用时的提交>:<文件>` 与当前文件逐行比对、证明差异仅为注释，再对两库执行定点 `UPDATE app.schema_migrations SET checksum=<新值> WHERE name=... AND checksum=<旧值>`（各影响 1 行），结论与取值须人工复核；不要用重跑迁移、删账本行或把文件改回旧字节来绕过。
- migrate 报 `users_immutable_columns must use app.enforce_users_immutable_columns`（2026-10-20 实测）：`0047` 的部署校验用 `pg_get_triggerdef()` 判断触发器函数名，而该函数名是否带 `app.` 前缀取决于**当前会话的 `search_path`**。VM 的 migrate 以 `app_migrator` 连接，角色级 `search_path = app, pg_catalog`（见 `database/bootstrap/000_roles.sql`），函数被渲染成不带前缀的 `enforce_users_immutable_columns()`，校验误判并回滚整条迁移；本地 `pnpm db:migrate` 用 `cluster_bootstrap`（`"$user", public`）所以不触发。处置：`sudo docker exec -u postgres inpulse-deploy-db-1 psql -U cluster_bootstrap -d app -c "ALTER ROLE app_migrator IN DATABASE app SET search_path = pg_catalog, public"` 后重跑 `sudo docker compose --env-file .env.deploy -f compose.yaml up -d`（2026-10-20 已执行并保留该设置，使 VM 迁移会话与本地一致）。注意：全新环境按 `000_roles.sql` 建出的 `app_migrator` 仍带 `app`，仓库侧仍需把迁移会话的 `search_path` 固定下来（runner 或 bootstrap 二选一，待评审），否则新环境会复现。
- 根因是仓库 `.gitattributes` 规定 `* text=auto eol=lf`，但本机
  `core.autocrlf=true`（来自 `D:/Git/etc/gitconfig`）会在工作区留下 CRLF。
  自查：`git ls-files --eol | Where-Object { $_ -notmatch '\sw/lf\s' }`。
- 构建卡在 `pnpm install`、日志刷 `registry.npmjs.org ... ETIMEDOUT`：公司网络到
  npmjs 不稳定。依赖层缓存命中时不需要联网；一旦 `pnpm-lock.yaml` 或任何
  `package.json` 变了就会重新解析，pnpm 会重试几分钟（实测最终能成，但很慢）。
  `registry.npmmirror.com` 本机可直连，必要时临时在 `.npmrc` 加 `registry=`，
  用完还原、不要提交。
- 基础镜像 digest 校验失败：镜像源上的 tag 可能指向与 Dockerfile 固定值不同的
  manifest（`docker.1ms.run` 的 `postgres:18.6` 就与固定的 `4ef4dbc9…` 不一致），
  所以脚本按 `名字@digest` 拉取而不是按 tag 拉。
- api 起不来、日志报模块找不到：确认 `deploy/docker/api.Dockerfile` 里包含
  `packages/canonical-json` 的 COPY 与 build，漏掉会让镜像内缺少 dist。
- 数据库角色密码不生效：`database/bootstrap/010_passwords.sql` 读 secret 文件时必须
  用 `btrim(..., E' \r\n\t')`，否则文件尾换行会进入密码。
- SSO 回跳 `/login?sso_error=internal`：多为 api 出不了网（检查 api 是否挂在 `egress`
  网络），或 `SSO_ISSUER` 与 discovery 返回的 issuer 不一致。可在容器内直接验证：
  `sudo docker exec inpulse-deploy-api-1 node -e "fetch(process.env.SSO_ISSUER + '/.well-known/openid-configuration').then(r => console.log(r.status))"`。
- 浏览器证书警告：证书由公司 ALLinSSL 统一下发并自动续签（`*.libiaorobot.com`，
  2026-10-15 首次下发生效），正常情况无需任何导入。排查顺序：① 确认访问的是
  域名 `https://test-inpulse.libiaorobot.com/` 而不是 IP（证书不含 IP，用
  `https://10.1.104.45/` 必然告警）；② 换**无痕窗口**重开：正常则问题在那台电脑的
  浏览器扩展（注入 http 资源会被拦成「连接不安全」，而证书仍显示有效；2026-10-15
  已实测同事案例为无痕正常、扩展导致），逐个禁用扩展排查；③ 以上排除后确认
  ALLinSSL 工作流「部署成功」且 `openssl s_client -connect
  test-inpulse.libiaorobot.com:443 -servername test-inpulse.libiaorobot.com`
  主体为 `*.libiaorobot.com`。
- 首个管理员：空库时首个 SSO 登录账号自动成为系统管理员（[ADR-075](../../docs/adr/ADR-075.md)，
  2026-10-15 起）；库非空时 JIT 开通仍为 `is_admin=false`、无项目成员关系，需要人工
  在数据库里提升。管理员权限定义见 `docs/permissions.md`。

## 安全约束

- 不要把 VM 密码、Casdoor client secret、数据库口令写进仓库文件，
  `pnpm check:secrets` 会拦截。Secret 只保存在 VM 的
  `/home/libiao/inpulse-deploy/secrets/`（权限 600、属主为对应容器内 uid）。
- 更新只操作 `/home/libiao` 下的目录与自建 Docker 对象，不改 VM 的系统配置、
  防火墙或其他用户。

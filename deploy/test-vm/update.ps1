<#
.SYNOPSIS
    InPulse 单机 VM 一键更新：本机上传源码 -> VM 构建镜像 -> 推入 VM 本地 registry -> 更新 Compose 栈。

.DESCRIPTION
    适用于单机 Docker Compose + 本地 registry 的测试 VM 与受控正式机。正式发布必须
    通过 deploy/prod/update.ps1 进入；镜像签名、发布清单审批和上线备份门禁仍按
    技术设计第 12 章由人工完成。

    本机不要求安装或启动 Docker Desktop；打包使用 Node.js 与 Git，上传使用 ssh 与 scp。

    执行顺序：
      1. 用 git 文件清单打包当前源码（包含未提交但未被忽略的改动）；
      2. scp 上传源码包，VM 上解压到隔离构建目录；
      3. 按需从镜像源补齐基础镜像，在 VM 上 docker build；
      4. tag / push 到 VM 本地 127.0.0.1:5000；
      5. 以 tag@sha256 形式更新 .env.deploy 的 *_IMAGE_REF（先备份，便于回滚）；
      6. docker compose up -d（migrate 服务先执行数据库迁移）；
      7. 健康检查：api healthy 且 /health/ready 返回 200；
      8. 清理本机临时文件与 VM 源码包（-KeepTar 可保留源码包和构建目录）。

.PARAMETER Repo
    要打包的仓库工作区，默认取脚本所在仓库根目录。

.PARAMETER Targets
    要更新的镜像：api、web、migrate、db-bootstrap、ops，或 all（默认）。
    多个用逗号分隔（-Targets api,migrate）。powershell -File 调用不会把逗号解析成数组，
    脚本内部会再按逗号切一次，所以这种写法可以直接用。

.PARAMETER Tag
    镜像 Tag，默认为 Version-yyyyMMdd-git 短 sha。

.PARAMETER PublicHost
    本机回环探针使用的 Host 与完成后展示的公开域名，默认测试域名。
    正式环境由 deploy/prod/update.ps1 固定为 inpulse.libiaorobot.com。

.PARAMETER RequireClean
    Git 工作区有未提交改动时直接失败；正式发布固定启用。

.PARAMETER SetupKey
    一次性生成无 passphrase 的部署密钥（默认 ~/.ssh/inpulse_deploy_ed25519）并把公钥装到 VM，
    之后每次更新全程免密，不再反复要求输入 SSH 密码。

.PARAMETER SshKey
    指定 SSH 私钥路径。留空时按 inpulse_deploy_ed25519 -> inpulse_test_deploy -> id_ed25519
    的顺序自动挑选第一把真正能免密登录的密钥。

.PARAMETER VmPassword
    VM 密码，只用于远端 sudo；也可用环境变量 INPULSE_VM_PASSWORD。留空则在终端交互输入。

.PARAMETER Mirror
    VM 拉取基础镜像用的 Docker 镜像源，默认 docker.1ms.run（公司网络无法直连 Docker Hub）。
    镜像源只在 VM 上使用，不要求本机 Docker。

.PARAMETER NoMirror
    跳过镜像源；若有基础镜像缓存则直接使用，否则由 VM 上的 docker build 按原始地址解析。

.PARAMETER SkipBuild
    不上传源码、不构建，直接使用 VM 上已有的 inpulse/<target>:<Tag> 重新推送并更新 Compose。
    必须同时提供 -Tag；VM 上不存在对应本地镜像时立即失败。

.PARAMETER KeepTar
    保留本机源码包、VM 源码包与构建目录（默认在成功后清理源码包和构建目录以省磁盘）。

.PARAMETER FixEol
    构建 migrate 前，把 database/migrations 下行尾漂移成 CRLF 的文件按字节转回 LF。
    只改行尾不改内容，git 不会产生变更；不加该开关时脚本直接报错并列出文件。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -SetupKey

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -Targets web

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -Targets api,migrate -Tag 0.1.0-hotfix1
#>
[CmdletBinding()]
param(
  [string]$Repo,
  [string]$VmHost,
  [string]$VmUser,
  [string]$VmPassword,
  [string]$SshKey,
  [string]$Mirror,
  [string]$CorepackRegistry,
  [switch]$NoMirror,
  [string]$Version = '0.1.0',
  [string]$Tag,
  [string]$PublicHost,
  [string[]]$Targets = @('all'),
  [string]$RemoteDir,
  [string]$ImageDir,
  [switch]$SkipBuild,
  [switch]$SetupKey,
  [switch]$KeepTar,
  [switch]$FixEol,
  [switch]$RequireClean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Get-Default {
  param([string]$Value, [string]$EnvName, [string]$Fallback)
  if (-not [string]::IsNullOrWhiteSpace($Value)) { return $Value }
  $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { return $fromEnv }
  return $Fallback
}

function Test-ExitCode {
  param([int]$Code, [string]$What)
  if ($Code -ne 0) { throw "$What 失败（exit $Code）" }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoFallback = (Resolve-Path (Join-Path $scriptRoot '..\..')).Path

$Repo = Get-Default $Repo 'INPULSE_REPO' $repoFallback
$VmHost = Get-Default $VmHost 'INPULSE_VM_HOST' '10.1.104.45'
$VmUser = Get-Default $VmUser 'INPULSE_VM_USER' 'libiao'
$RemoteDir = Get-Default $RemoteDir 'INPULSE_VM_REMOTE_DIR' "/home/$VmUser/inpulse-deploy"
$ImageDir = Get-Default $ImageDir 'INPULSE_VM_IMAGE_DIR' "/home/$VmUser/inpulse-images"
$PublicHost = Get-Default $PublicHost 'INPULSE_PUBLIC_HOST' 'test-inpulse.libiaorobot.com'
if ($PublicHost -notmatch '^[A-Za-z0-9.-]+$') { throw "公开域名不合法：$PublicHost" }
if ([string]::IsNullOrWhiteSpace($VmPassword)) {
  $VmPassword = [Environment]::GetEnvironmentVariable('INPULSE_VM_PASSWORD')
}
$Mirror = Get-Default $Mirror 'INPULSE_DOCKER_MIRROR' 'docker.1ms.run'
$CorepackRegistry = Get-Default $CorepackRegistry 'INPULSE_COREPACK_REGISTRY' 'https://registry.npmjs.org'

if ($RemoteDir -notmatch "^/[A-Za-z0-9._/-]+$") { throw "远端部署目录不合法：$RemoteDir" }
if ($ImageDir -notmatch "^/[A-Za-z0-9._/-]+$") { throw "远端镜像目录不合法：$ImageDir" }
if ($Mirror -notmatch "^[A-Za-z0-9._:/-]+$") { throw "镜像源不合法：$Mirror" }
if ($CorepackRegistry -notmatch "^https?://[A-Za-z0-9._:/-]+$") { throw "Corepack registry 不合法：$CorepackRegistry" }

$imageMap = [ordered]@{
  'api'          = @{ Dockerfile = 'deploy/docker/api.Dockerfile';          Image = 'inpulse/api';          EnvKey = 'API_IMAGE_REF' }
  'web'          = @{ Dockerfile = 'deploy/docker/web.Dockerfile';          Image = 'inpulse/web';          EnvKey = 'WEB_IMAGE_REF' }
  'migrate'      = @{ Dockerfile = 'deploy/docker/migration.Dockerfile';    Image = 'inpulse/migrate';      EnvKey = 'MIGRATE_IMAGE_REF' }
  'db-bootstrap' = @{ Dockerfile = 'deploy/docker/db-bootstrap.Dockerfile'; Image = 'inpulse/db-bootstrap'; EnvKey = 'DB_IMAGE_REF' }
  'ops'          = @{ Dockerfile = 'deploy/docker/ops.Dockerfile';          Image = 'inpulse/ops';          EnvKey = 'OPS_IMAGE_REF' }
}

$requestedTargets = @($Targets | ForEach-Object { $_ -split ',' } |
  ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($requestedTargets -contains 'all') {
  $targetList = @($imageMap.Keys)
} else {
  $targetList = $requestedTargets
}
foreach ($t in $targetList) {
  if (-not $imageMap.Contains($t)) {
    throw "未知 target：$t（可选：$($imageMap.Keys -join ', ') 或 all）"
  }
}
if ($targetList.Count -eq 0) { throw '没有要更新的 target' }

$sshTarget = "$VmUser@$VmHost"
if ([string]::IsNullOrWhiteSpace($SshKey)) {
  $SshKey = [Environment]::GetEnvironmentVariable('INPULSE_VM_SSH_KEY')
}
$sshOptions = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')
$deployKeyDefault = Join-Path $HOME '.ssh\inpulse_deploy_ed25519'
$explicitSshKey = -not [string]::IsNullOrWhiteSpace($SshKey)
if ($explicitSshKey) {
  $keyCandidates = @($SshKey)
} else {
  $keyCandidates = @($deployKeyDefault, (Join-Path $HOME '.ssh\inpulse_test_deploy'), (Join-Path $HOME '.ssh\id_ed25519'))
}

function Test-SshKeyAuth {
  param([string[]]$Options)
  & ssh @Options -o BatchMode=yes $sshTarget 'echo SSH-KEY-OK' *> $null
  return ($LASTEXITCODE -eq 0)
}

function Install-SshKey {
  param([bool]$Managed)
  $sshDir = Join-Path $HOME '.ssh'
  if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }
  $keyPath = $SshKey
  if ((Test-Path $keyPath) -and (Test-SshKeyAuth ($sshOptions + @('-i', $keyPath)))) {
    Write-Host "免密登录已可用，无需重新配置：$keyPath" -ForegroundColor Green
    return
  }
  if (Test-Path $keyPath) {
    if (-not $Managed) {
      throw "密钥 $keyPath 无法免密登录；脚本不会覆盖你显式指定的密钥。改用 -SshKey 指向一个尚不存在的路径（例如 $deployKeyDefault）即可生成新部署密钥。"
    }
    Write-Warning "已有部署密钥 $keyPath 无法免密登录（可能带 passphrase），重新生成一把。"
    Remove-Item -LiteralPath $keyPath -Force
    if (Test-Path "$keyPath.pub") { Remove-Item -LiteralPath "$keyPath.pub" -Force }
  }
  Write-Host "生成本机 SSH 密钥（无 passphrase）：$keyPath" -ForegroundColor Cyan
  & ssh-keygen -t ed25519 -N '""' -C "inpulse-deploy@$env:COMPUTERNAME" -f $keyPath
  Test-ExitCode $LASTEXITCODE 'ssh-keygen'
  $pub = (Get-Content "$keyPath.pub" -Raw).Trim()
  Write-Host "把公钥装到 $sshTarget（提示密码时输入一次 VM 密码即可）" -ForegroundColor Cyan
  $remote = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys && echo KEY-INSTALLED"
  & ssh ($sshOptions + @('-i', $keyPath)) $sshTarget $remote
  Test-ExitCode $LASTEXITCODE '安装 SSH 公钥'
}

if ($SetupKey) {
  $managedKey = -not $explicitSshKey
  if ($managedKey) { $SshKey = $deployKeyDefault }
  Install-SshKey -Managed $managedKey
  if (Test-SshKeyAuth ($sshOptions + @('-i', $SshKey))) {
    Write-Host "SSH 免密已生效（$SshKey），后续更新不再要求输入 SSH 密码。" -ForegroundColor Green
  } else {
    Write-Warning '公钥已写入，但免密验证未通过；检查 VM 的 sshd 是否允许公钥登录。'
  }
  return
}

Write-Host "仓库      : $Repo" -ForegroundColor Cyan
Write-Host "目标主机  : $sshTarget" -ForegroundColor Cyan
Write-Host "部署目录  : $RemoteDir" -ForegroundColor Cyan
$keyAuthReady = $false
foreach ($candidate in $keyCandidates) {
  if (-not (Test-Path $candidate)) { continue }
  if (Test-SshKeyAuth ($sshOptions + @('-i', $candidate))) {
    $SshKey = $candidate
    $sshOptions += @('-i', $candidate)
    $keyAuthReady = $true
    Write-Host "SSH 密钥  : $candidate（免密可用）" -ForegroundColor Cyan
    break
  }
  Write-Warning "密钥 $candidate 无法免密登录（可能带 passphrase 或未装到 VM），改用密码认证。"
}
if (-not $keyAuthReady) {
  Write-Warning "本次没有可用的免密密钥：源码上传与远端执行会多次要求输入 VM 密码。"
  Write-Warning "想全程免密，先执行一次：powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -SetupKey"
}

if (-not (Test-Path (Join-Path $Repo 'deploy\compose.yaml'))) {
  throw '找不到 deploy/compose.yaml；请确认 -Repo 指向仓库工作区'
}
if ($SkipBuild -and [string]::IsNullOrWhiteSpace($Tag)) {
  throw "SkipBuild 必须同时提供 -Tag，以便引用 VM 上已有的镜像"
}
$localCommands = @("ssh", "scp", "git")
if (-not $SkipBuild) { $localCommands += "node" }
foreach ($c in $localCommands) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "缺少命令：$c" }
}
$toolText = "Git / ssh / scp"
if (-not $SkipBuild) { $toolText = "Node.js / $toolText" }
Write-Host "本机工具  : $toolText（不调用本机 Docker）" -ForegroundColor Cyan

$gitSha = (& git -C $Repo rev-parse --short HEAD).Trim()
Test-ExitCode $LASTEXITCODE 'git rev-parse --short HEAD'
$gitShaFull = (& git -C $Repo rev-parse HEAD).Trim()
Test-ExitCode $LASTEXITCODE 'git rev-parse HEAD'
if ($gitShaFull -notmatch '^[0-9a-f]{40}$') { throw "完整 Git SHA 不合法：$gitShaFull" }
if ([string]::IsNullOrWhiteSpace($Tag)) {
  $Tag = '{0}-{1}-{2}' -f $Version, (Get-Date -Format 'yyyyMMdd'), $gitSha
}
if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "镜像 Tag 不合法：$Tag" }

$dirty = & git -C $Repo status --porcelain
if ($dirty) {
  if ($RequireClean) {
    throw "工作区有未提交改动；正式发布要求先用提交固定版本。"
  }
  Write-Warning "工作区有未提交改动：VM 构建会包含这些改动，但 Tag 里的 $gitSha 只对应最后一次提交"
}

if (($targetList -contains 'migrate') -and (-not $SkipBuild)) {
  $badEol = @(& git -C $Repo ls-files --eol -- database/migrations |
    Where-Object { $_ -and ($_ -notmatch '\sw/lf\s') } |
    ForEach-Object { ($_ -split "`t")[-1] })
  if ($badEol.Count -gt 0) {
    if (-not $FixEol) {
      $names = $badEol -join ', '
      throw @"
database/migrations 下有 $($badEol.Count) 个文件行尾不是 LF：$names

migrate 镜像按文件原始字节算 sha256（database/src/migrations.ts），CRLF 会让已应用迁移的
校验和对不上：compose up 时 migrate 退出 1，api/web 不启动，站点直接不可用。
仓库 .gitattributes 规定 '* text=auto eol=lf'，所以这是工作区行尾漂移，不是迁移被改动。

加 -FixEol 让脚本按字节把这些文件转回 LF（只改行尾、不改内容，git 也不会产生变更），
或用编辑器把行尾改成 LF 后重试。
"@
    }
    foreach ($rel in $badEol) {
      $full = Join-Path $Repo ($rel -replace '/', '\')
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $kept = New-Object System.Collections.Generic.List[byte]
      for ($i = 0; $i -lt $bytes.Length; $i++) {
        if (($bytes[$i] -eq 13) -and (($i + 1) -lt $bytes.Length) -and ($bytes[$i + 1] -eq 10)) { continue }
        $kept.Add($bytes[$i])
      }
      [System.IO.File]::WriteAllBytes($full, $kept.ToArray())
    }
    & git -C $Repo add -- $badEol
    Write-Host "已把 $($badEol.Count) 个迁移文件转回 LF（内容与索引一致，只刷新 git stat）" -ForegroundColor Green
  }
}

Write-Host "镜像 Tag  : $Tag" -ForegroundColor Cyan
Write-Host "更新范围  : $($targetList -join ', ')" -ForegroundColor Cyan

$workDir = Join-Path $env:TEMP "inpulse-update-$Tag"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$sourceTarName = "inpulse-source-$Tag.tar.gz"
$sourceTar = Join-Path $workDir $sourceTarName
$sourceFileList = "$sourceTar.files"
$remoteSourceTar = "$ImageDir/$sourceTarName"
$remoteSourceDir = "$RemoteDir/.source-$Tag"

if ($SkipBuild) {
  Write-Host "源码包    : 跳过（-SkipBuild，使用 VM 上已有 inpulse/<target>:$Tag）" -ForegroundColor Cyan
} else {
  & ssh @sshOptions $sshTarget "mkdir -p '$RemoteDir' '$ImageDir'"
  Test-ExitCode $LASTEXITCODE "在 VM 上创建 $RemoteDir 与 $ImageDir"

  $sourceArchiveScript = Join-Path $Repo "scripts\pack-source.mjs"
  if (-not (Test-Path $sourceArchiveScript)) { throw "找不到源码打包助手：$sourceArchiveScript" }

  Write-Host ""
  Write-Host "=== 打包源码（包含未提交但未忽略改动）===" -ForegroundColor Cyan
  $archiveJson = & node $sourceArchiveScript --repo $Repo --output $sourceTar
  Test-ExitCode $LASTEXITCODE "打包源码"
  try {
    $archiveInfo = $archiveJson | ConvertFrom-Json
  } catch {
    throw "源码打包助手返回了无法解析的结果：$archiveJson"
  }
  if ($null -eq $archiveInfo -or $archiveInfo.fileCount -lt 1) { throw "源码包文件清单为空，拒绝上传空包" }
  if (-not (Test-Path $sourceTar)) { throw "源码包未生成：$sourceTar" }
  if ($archiveInfo.skippedMissing -gt 0) {
    Write-Warning "打包时跳过了 $($archiveInfo.skippedMissing) 个工作区已删除的跟踪文件"
  }
  Write-Host "包含 $($archiveInfo.fileCount) 个文件" -ForegroundColor Cyan
  $sizeMb = [math]::Round((Get-Item $sourceTar).Length / 1MB, 1)
  Write-Host "=== 上传源码包（$sizeMb MB）===" -ForegroundColor Cyan
  & scp -q @sshOptions $sourceTar "${sshTarget}:$remoteSourceTar"
  Test-ExitCode $LASTEXITCODE "上传源码包"
}

$remoteTemplate = @'
#!/usr/bin/env bash
set -euo pipefail

TAG="__TAG__"
REMOTE_DIR="__REMOTE_DIR__"
IMAGE_DIR="__IMAGE_DIR__"
SOURCE_TAR="__SOURCE_TAR__"
SOURCE_DIR="__SOURCE_DIR__"
GIT_SHA="__GIT_SHA__"
PUBLIC_HOST="__PUBLIC_HOST__"
KEEP_TAR="__KEEP_TAR__"
BUILD="__BUILD__"
MIRROR="__MIRROR__"
NO_MIRROR="__NO_MIRROR__"
COREPACK_REGISTRY="__COREPACK_REGISTRY__"
REGISTRY="127.0.0.1:5000"

cd "$REMOTE_DIR"
COMPOSE="docker compose --env-file .env.deploy -f compose.yaml"

STAMP="$(date +%Y%m%d-%H%M%S)"
cp -p .env.deploy ".env.deploy.bak-$STAMP"
chmod 600 .env.deploy
echo "[env] 已备份 .env.deploy -> .env.deploy.bak-$STAMP"

mirror_pull() {
  local reference="$1"
  local name remote pinned got
  name="$(printf "%s" "$reference" | sed "s/@.*//")"
  pinned=""
  if printf "%s" "$reference" | grep -Eq "@sha256:[0-9a-f]{64}$"; then
    pinned="$(printf "%s" "$reference" | sed "s/.*@//")"
  fi
  if printf "%s" "$name" | grep -q "/"; then
    remote="$MIRROR/$name"
  else
    remote="$MIRROR/library/$name"
  fi
  if [ -n "$pinned" ]; then remote="$remote@$pinned"; fi
  echo "[base] 拉取 $remote"
  docker pull "$remote"
  if [ -n "$pinned" ]; then
    got="$(docker image inspect "$remote" --format "{{range .RepoDigests}}{{println .}}{{end}}" | sed -n "s/.*@//p" | sort -u)"
    if ! printf "%s\n" "$got" | grep -qx "$pinned"; then
      echo "[FAIL] digest 不匹配：$name 期望 $pinned，实际 $got"
      exit 1
    fi
  fi
  docker tag "$remote" "$name"
  echo "[base] 已就绪：$name"
}

ensure_base_images() {
  local reference frontend
  for reference in $(grep -hE "^[[:space:]]*FROM[[:space:]]+" "$SOURCE_DIR"/deploy/docker/*.Dockerfile | sed -E "s/^[[:space:]]*FROM[[:space:]]+([^[:space:]]+).*/\1/" | sort -u); do
    if docker image inspect "$reference" >/dev/null 2>&1; then continue; fi
    if [ "$NO_MIRROR" = "1" ]; then
      echo "[base] 未缓存 $reference；-NoMirror 下交由 docker build 直接解析"
    else
      mirror_pull "$reference"
    fi
  done
  for frontend in $(grep -hE "^#[[:space:]]*syntax=" "$SOURCE_DIR"/deploy/docker/*.Dockerfile | sed -E "s/^#[[:space:]]*syntax=([^[:space:]]+).*/\1/" | sort -u); do
    if docker image inspect "$frontend" >/dev/null 2>&1; then continue; fi
    if [ "$NO_MIRROR" = "1" ]; then
      echo "[base] 未缓存 $frontend；-NoMirror 下交由 docker build 直接解析"
    else
      mirror_pull "$frontend"
    fi
  done
}

dockerfile_for() {
  case "$1" in
    api) echo "deploy/docker/api.Dockerfile" ;;
    web) echo "deploy/docker/web.Dockerfile" ;;
    migrate) echo "deploy/docker/migration.Dockerfile" ;;
    db-bootstrap) echo "deploy/docker/db-bootstrap.Dockerfile" ;;
    ops) echo "deploy/docker/ops.Dockerfile" ;;
    *) echo "[FAIL] 未知镜像：$1" >&2; return 1 ;;
  esac
}

if [ "$BUILD" = "1" ]; then
  case "$SOURCE_DIR" in
    "$REMOTE_DIR"/.source-*) ;;
    *) echo "[FAIL] 拒绝清理非预期源码目录：$SOURCE_DIR"; exit 1 ;;
  esac
  if [ ! -f "$SOURCE_TAR" ]; then echo "[FAIL] 源码包不存在：$SOURCE_TAR"; exit 1; fi
  rm -rf "$SOURCE_DIR"
  mkdir -p "$SOURCE_DIR"
  echo "[source] 解压 $SOURCE_TAR -> $SOURCE_DIR"
  tar -xzf "$SOURCE_TAR" -C "$SOURCE_DIR"
  for required in deploy/compose.yaml deploy/docker/api.Dockerfile pnpm-lock.yaml package.json; do
    if [ ! -f "$SOURCE_DIR/$required" ]; then echo "[FAIL] 源码包缺少 $required"; exit 1; fi
  done
  ensure_base_images
fi

update_image() {
  local name="$1" envkey="$2" dockerfile local_image registry_image digest ref log
  local_image="inpulse/$name:$TAG"
  registry_image="$REGISTRY/inpulse/$name:$TAG"
  if [ "$BUILD" = "1" ]; then
    dockerfile="$(dockerfile_for "$name")"
    log="$SOURCE_DIR/build-$name.log"
    echo "[build] $local_image <- $dockerfile"
    docker build --progress plain --build-arg "COREPACK_NPM_REGISTRY=$COREPACK_REGISTRY" -f "$SOURCE_DIR/$dockerfile" -t "$local_image" "$SOURCE_DIR" 2>&1 | tee "$log"
  else
    if ! docker image inspect "$local_image" >/dev/null 2>&1; then
      echo "[FAIL] -SkipBuild 需要 VM 上已有 $local_image"
      exit 1
    fi
    echo "[image] 复用 VM 本地镜像 $local_image"
  fi
  docker tag "$local_image" "$registry_image"
  echo "[push] $registry_image"
  docker push "$registry_image" >/dev/null
  digest="$(docker inspect --format "{{ index .RepoDigests 0 }}" "$registry_image" | sed "s/.*@//")"
  if ! printf "%s" "$digest" | grep -Eq "^sha256:[0-9a-f]{64}$"; then
    echo "[FAIL] $registry_image 的 RepoDigest 不合法：$digest"
    exit 1
  fi
  ref="$registry_image@$digest"
  sed -i "s|^$envkey=.*|$envkey=$ref|" .env.deploy
  echo "[env] $envkey=$ref"
}

for pair in "$@"; do
  name="$(printf "%s" "$pair" | cut -d: -f1)"
  envkey="$(printf "%s" "$pair" | cut -d: -f2)"
  update_image "$name" "$envkey"
done

if grep -q "^BACKUP_GIT_SHA=" .env.deploy; then
  sed -i "s|^BACKUP_GIT_SHA=.*|BACKUP_GIT_SHA=$GIT_SHA|" .env.deploy
  echo "[env] BACKUP_GIT_SHA=$GIT_SHA"
fi

if [ "$BUILD" = "1" ]; then
  echo "[logs] 构建日志：$SOURCE_DIR/build-*.log"
fi

echo "[up] docker compose up -d（migrate 会先执行数据库迁移）"
$COMPOSE up -d

mig_id="$($COMPOSE ps -q migrate 2>/dev/null || true)"
if [ -n "$mig_id" ]; then
  echo "[migrate] $(docker inspect -f "{{.State.Status}} exit={{.State.ExitCode}}" "$mig_id")"
fi

api_id="$($COMPOSE ps -q api)"
status="unknown"
for _ in $(seq 1 60); do
  status="$(docker inspect -f "{{.State.Health.Status}}" "$api_id" 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then break; fi
  sleep 3
done
echo "[health] api=$status"
$COMPOSE ps --format "{{.Name}} | {{.Status}}"
curl -sk -H "Host: $PUBLIC_HOST" -o /dev/null -w "[probe] /health/ready -> %{http_code}\n" https://127.0.0.1/health/ready
curl -sk -H "Host: $PUBLIC_HOST" -o /dev/null -w "[probe] / -> %{http_code}\n" https://127.0.0.1/

if [ "$status" != "healthy" ]; then
  echo "[FAIL] api 未达到 healthy，最近日志："
  docker logs --tail 40 "$api_id" 2>&1 || true
  exit 1
fi

if [ "$KEEP_TAR" != "1" ]; then
  if [ "$BUILD" = "1" ]; then
    rm -f "$SOURCE_TAR"
    rm -rf "$SOURCE_DIR"
    echo "[clean] 已清理 VM 源码包与构建目录"
  fi
  docker image prune -f >/dev/null || true
else
  echo "[keep] 保留 VM 源码包：$SOURCE_TAR"
  if [ "$BUILD" = "1" ]; then echo "[keep] 构建目录：$SOURCE_DIR"; fi
fi

rm -f "$REMOTE_DIR/.update-$TAG.sh"
echo "[done] TAG=$TAG"
'@

$pairs = ($targetList | ForEach-Object { '{0}:{1}' -f $_, $imageMap[$_].EnvKey }) -join ' '
$lf = [string][char]10
$crlf = [string][char]13 + [string][char]10
$keepTarFlag = "0"
if ($KeepTar) { $keepTarFlag = "1" }
$buildFlag = "1"
if ($SkipBuild) { $buildFlag = "0" }
$noMirrorFlag = "0"
if ($NoMirror) { $noMirrorFlag = "1" }
$remoteScript = $remoteTemplate
$remoteScript = $remoteScript.Replace("__TAG__", $Tag)
$remoteScript = $remoteScript.Replace("__REMOTE_DIR__", $RemoteDir)
$remoteScript = $remoteScript.Replace("__IMAGE_DIR__", $ImageDir)
$remoteScript = $remoteScript.Replace("__SOURCE_TAR__", $remoteSourceTar)
$remoteScript = $remoteScript.Replace("__SOURCE_DIR__", $remoteSourceDir)
$remoteScript = $remoteScript.Replace("__GIT_SHA__", $gitShaFull)
$remoteScript = $remoteScript.Replace("__PUBLIC_HOST__", $PublicHost)
$remoteScript = $remoteScript.Replace("__KEEP_TAR__", $keepTarFlag)
$remoteScript = $remoteScript.Replace("__BUILD__", $buildFlag)
$remoteScript = $remoteScript.Replace("__MIRROR__", $Mirror)
$remoteScript = $remoteScript.Replace("__NO_MIRROR__", $noMirrorFlag)
$remoteScript = $remoteScript.Replace("__COREPACK_REGISTRY__", $CorepackRegistry)
$remoteScript = $remoteScript.Replace($crlf, $lf)
$localSh = Join-Path $workDir 'remote-update.sh'
[System.IO.File]::WriteAllText($localSh, $remoteScript, (New-Object System.Text.UTF8Encoding($false)))
$remoteSh = "$RemoteDir/.update-$Tag.sh"
& scp -q @sshOptions $localSh "${sshTarget}:$remoteSh"
Test-ExitCode $LASTEXITCODE '上传远端更新脚本'

Write-Host ''
Write-Host '=== VM 上执行更新（sudo）===' -ForegroundColor Cyan
if (-not [string]::IsNullOrWhiteSpace($VmPassword)) {
  $remoteCmd = "tr -d '\r' | sudo -S -p '' bash '$remoteSh' $pairs"
  $VmPassword | & ssh @sshOptions $sshTarget $remoteCmd
} else {
  Write-Host '未提供 VM 密码：sudo 将在终端提示输入。' -ForegroundColor Yellow
  & ssh -t @sshOptions $sshTarget "sudo bash '$remoteSh' $pairs"
}
$remoteExit = $LASTEXITCODE
Test-ExitCode $remoteExit 'VM 侧更新'

if (-not $KeepTar) {
  foreach ($tempFile in @($sourceTar, $sourceFileList, $localSh)) {
    if (Test-Path $tempFile) { Remove-Item -LiteralPath $tempFile -Force }
  }
  Remove-Item -LiteralPath $workDir -Force -ErrorAction SilentlyContinue
} elseif (-not $SkipBuild) {
  Write-Host "  本机包  : $sourceTar" -ForegroundColor Green
  Write-Host "  VM 包   : $remoteSourceTar" -ForegroundColor Green
  Write-Host "  VM 构建 : $remoteSourceDir" -ForegroundColor Green
}

Write-Host ""
Write-Host "更新完成：$Tag" -ForegroundColor Green
Write-Host "  站点    : https://$PublicHost/" -ForegroundColor Green
Write-Host "  构建机  : $sshTarget（Docker 只在 VM 运行）" -ForegroundColor Green
Write-Host "  回滚    : 把 $RemoteDir/.env.deploy 恢复为同目录最新的 .env.deploy.bak-*，" -ForegroundColor Green
Write-Host "            再执行 sudo docker compose --env-file .env.deploy -f compose.yaml up -d" -ForegroundColor Green

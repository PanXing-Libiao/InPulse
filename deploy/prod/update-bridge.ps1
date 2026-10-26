<#
.SYNOPSIS
    InPulse 正式环境企业微信桥接同步：本地唯一源 -> 正式机校验 -> 远端构建 -> 重建容器。

.DESCRIPTION
    同步正式环境 10.1.103.45 上独立于 Compose 栈的桥接容器 inpulse-wecom-bridge。
    本地唯一源是 deploy/prod/wecom-bridge/；所有改动先落本地仓库，再用本脚本同步。
    正式发布必须显式传入 -ConfirmProduction，固定主机为 10.1.103.45，不读取测试机配置。

.PARAMETER ConfirmProduction
    正式环境安全闸门，缺失时拒绝执行。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction -SkipRestart

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction -RollbackTo 0.1.0-20261023-prod-bridgeabcdef0
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [switch]$ConfirmProduction,
  [string]$Repo,
  [string]$VmHost,
  [string]$VmUser,
  [string]$VmPassword,
  [string]$SshKey,
  [string]$RemoteDir,
  [string]$Tag,
  [string]$RollbackTo,
  [switch]$SkipRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

if (-not $ConfirmProduction) { throw "正式发布必须显式传入 -ConfirmProduction。" }

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

function Test-SshKeyAuth {
  param([string[]]$Options)
  & ssh @Options -o BatchMode=yes $sshTarget 'echo SSH-KEY-OK' *> $null
  return ($LASTEXITCODE -eq 0)
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoFallback = (Resolve-Path (Join-Path $scriptRoot '..\..')).Path

$Repo = Get-Default $Repo 'INPULSE_REPO' $repoFallback
$VmHost = Get-Default $VmHost 'INPULSE_VM_HOST' '10.1.103.45'
$VmUser = Get-Default $VmUser 'INPULSE_VM_USER' 'libiao'
$RemoteDir = Get-Default $RemoteDir 'INPULSE_VM_REMOTE_DIR' "/home/$VmUser/inpulse-deploy"
if ($VmHost -ne '10.1.103.45') { throw "正式桥接只允许主机 10.1.103.45，拒绝：$VmHost" }
if ($VmUser -ne 'libiao') { throw "正式桥接只允许部署账户 libiao，拒绝：$VmUser" }
if ($RemoteDir -ne '/home/libiao/inpulse-deploy') { throw "正式桥接部署目录必须固定为 /home/libiao/inpulse-deploy，拒绝：$RemoteDir" }
if ([string]::IsNullOrWhiteSpace($VmPassword)) {
  $VmPassword = [Environment]::GetEnvironmentVariable('INPULSE_VM_PASSWORD')
}

$bridgeLocal = Join-Path $Repo 'deploy\prod\wecom-bridge'
if (-not (Test-Path (Join-Path $bridgeLocal 'Dockerfile'))) {
  throw "找不到桥接源码（$bridgeLocal\Dockerfile）；请确认 -Repo 指向仓库工作区"
}
foreach ($c in @('ssh', 'scp')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "缺少命令：$c" }
}

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
  $keyCandidates = @($deployKeyDefault, (Join-Path $HOME '.ssh\id_ed25519'))
}

Write-Host "仓库      : $Repo" -ForegroundColor Cyan
Write-Host "正式主机  : $sshTarget" -ForegroundColor Cyan
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
  Write-Warning "密钥 $candidate 无法免密登录，跳过。"
}
if (-not $keyAuthReady) {
  Write-Warning '没有可用免密密钥：上传与远端执行会要求输入 VM 密码。'
  Write-Warning '请确认 ~/.ssh/inpulse_deploy_ed25519 已由运维配置；脚本不读取测试机密钥。'
}

$lf = [string][char]10

$rollbackMode = -not [string]::IsNullOrWhiteSpace($RollbackTo)
if ($rollbackMode -and ($RollbackTo -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')) {
  throw "RollbackTo Tag 不合法：$RollbackTo"
}

$allFiles = @(Get-ChildItem -Recurse -File -LiteralPath $bridgeLocal |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Where-Object { $_.Name -ne 'README.md' } |
  Sort-Object FullName)
if ($allFiles.Count -eq 0) { throw "桥接源码目录为空：$bridgeLocal" }

$sumRows = New-Object System.Collections.Generic.List[string]
$aggRows = New-Object System.Collections.Generic.List[string]
foreach ($f in $allFiles) {
  $rel = $f.FullName.Substring($bridgeLocal.Length + 1).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
  $sumRows.Add($hash + '  ' + $rel)
  $aggRows.Add($rel + ':' + $hash)
}
$sumsText = ($sumRows -join $lf) + $lf
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $aggBytes = [System.Text.Encoding]::UTF8.GetBytes(($aggRows -join $lf))
  $aggHex = ([System.BitConverter]::ToString($sha256.ComputeHash($aggBytes)) -replace '-', '').ToLower()
} finally {
  $sha256.Dispose()
}
$contentHash = $aggHex.Substring(0, 7)

if ([string]::IsNullOrWhiteSpace($Tag)) {
  $Tag = '0.1.0-{0}-prod-bridge{1}' -f (Get-Date -Format 'yyyyMMdd'), $contentHash
}
if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "镜像 Tag 不合法：$Tag" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$workDir = Join-Path $env:TEMP "inpulse-prod-bridge-$stamp"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$sumsFile = Join-Path $workDir 'SHA256SUMS'
[System.IO.File]::WriteAllText($sumsFile, $sumsText, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "内容哈希  : $contentHash" -ForegroundColor Cyan
Write-Host "文件数    : $($allFiles.Count)（不含 node_modules 与 README.md）" -ForegroundColor Cyan
if ($rollbackMode) {
  Write-Host "回滚模式  : 用历史镜像 inpulse-wecom-bridge:$RollbackTo 重建容器" -ForegroundColor Yellow
} else {
  Write-Host "镜像 Tag  : $Tag" -ForegroundColor Cyan
}

$stagingDir = ''
if (-not $rollbackMode) {
  $stagingDir = "$RemoteDir/.bridge-upload-$stamp"
  $relPaths = @($allFiles | ForEach-Object { $_.FullName.Substring($bridgeLocal.Length + 1).Replace('\', '/') })
  $relDirs = @($relPaths | ForEach-Object { if ($_ -match '/') { $_.Substring(0, $_.LastIndexOf('/')) } } | Sort-Object -Unique)
  $mkdirTargets = @("$stagingDir/files") + @($relDirs | ForEach-Object { "$stagingDir/files/$_" })
  $mkdirCmd = 'mkdir -p ' + (($mkdirTargets | ForEach-Object { "'" + $_ + "'" }) -join ' ')
  Write-Host ''
  Write-Host '=== 上传正式桥接源码 ===' -ForegroundColor Cyan
  & ssh @sshOptions $sshTarget $mkdirCmd
  Test-ExitCode $LASTEXITCODE '在正式机上创建临时上传目录'
  for ($i = 0; $i -lt $allFiles.Count; $i++) {
    & scp -q @sshOptions $allFiles[$i].FullName "${sshTarget}:$stagingDir/files/$($relPaths[$i])"
    Test-ExitCode $LASTEXITCODE "上传 $($relPaths[$i])"
  }
  & scp -q @sshOptions $sumsFile "${sshTarget}:$stagingDir/SHA256SUMS"
  Test-ExitCode $LASTEXITCODE '上传 SHA256SUMS'
  Write-Host "已上传 $($allFiles.Count) 个文件 -> $stagingDir" -ForegroundColor Green
}

$remoteTemplate = @'
#!/usr/bin/env bash
set -eu

MODE="__MODE__"
TAG="__TAG__"
ROLLBACK_TAG="__ROLLBACK_TAG__"
REMOTE_DIR="__REMOTE_DIR__"
STAGING="__STAGING__"
SKIP_RESTART="__SKIP_RESTART__"
BRIDGE_DIR="$REMOTE_DIR/wecom-bridge"
CONTAINER="inpulse-wecom-bridge"
REGISTRY="127.0.0.1:5000"
LOCAL_IMAGE="inpulse-wecom-bridge:$TAG"
REG_IMAGE="$REGISTRY/inpulse-wecom-bridge:$TAG"
NET_EGRESS="inpulse-deploy_egress"
NET_BACKEND="inpulse-deploy_backend"
KEY_FILE="$REMOTE_DIR/secrets/wecom_robot_encryption_key"

echo "[bridge] 正式环境 模式=$MODE 目标=$TAG"

if ! docker network inspect "$NET_EGRESS" > /dev/null 2>&1; then
  echo "[FAIL] 缺少正式网络：$NET_EGRESS"
  exit 1
fi
if ! docker network inspect "$NET_BACKEND" > /dev/null 2>&1; then
  echo "[FAIL] 缺少正式网络：$NET_BACKEND"
  exit 1
fi

if [ ! -s "$KEY_FILE" ]; then
  echo "[secret] 生成正式企微机器人主密钥（内容不回显）"
  mkdir -p "$REMOTE_DIR/secrets"
  ( umask 077; printf '1:%s\n' "$(openssl rand -hex 32)" > "$KEY_FILE" )
fi
chown 10001:10001 "$KEY_FILE"
chmod 0400 "$KEY_FILE"

if [ "$MODE" = "update" ]; then
  echo "[check] 逐文件 sha256 校验"
  ( cd "$STAGING/files" && sha256sum -c "$STAGING/SHA256SUMS" )

  NEW_PKG="$(sha256sum "$STAGING/files/app/package.json" | awk '{print $1}')"
  OLD_PKG=""
  if [ -f "$BRIDGE_DIR/app/package.json" ]; then
    OLD_PKG="$(sha256sum "$BRIDGE_DIR/app/package.json" | awk '{print $1}')"
  fi
  DEPS_CHANGED="0"
  if [ "$NEW_PKG" != "$OLD_PKG" ]; then DEPS_CHANGED="1"; fi

  STAMP="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$REMOTE_DIR/backups" "$BRIDGE_DIR"
  if [ -n "$(find "$BRIDGE_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    tar czf "$REMOTE_DIR/backups/wecom-bridge-src-$STAMP.tgz" -C "$BRIDGE_DIR" --exclude=node_modules --exclude=state --exclude='*.bak-*' .
    echo "[backup] $REMOTE_DIR/backups/wecom-bridge-src-$STAMP.tgz"
  fi

  cp -a "$STAGING/files/." "$BRIDGE_DIR/"
  echo "[copy] 正式桥接源码已更新（node_modules 与 state 保持不动）"

  if [ "$DEPS_CHANGED" = "1" ] || [ ! -d "$BRIDGE_DIR/app/node_modules" ]; then
    echo "[deps] 刷新正式依赖（npm ci --omit=dev）"
    NPM_IMAGE="docker.1ms.run/library/node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
    docker run --rm --network "$NET_EGRESS" --entrypoint npm -v "$BRIDGE_DIR/app:/work" -w /work "$NPM_IMAGE" ci --omit=dev --no-audit --no-fund
    chown -R 10001:10001 "$BRIDGE_DIR/app/node_modules"
    if [ -f "$BRIDGE_DIR/app/package-lock.json" ]; then chown 10001:10001 "$BRIDGE_DIR/app/package-lock.json"; fi
    echo "[deps] 依赖已刷新"
  fi

  mkdir -p "$BRIDGE_DIR/state"
  chown -R 10001:10001 "$BRIDGE_DIR/state"
  chmod 750 "$BRIDGE_DIR/state"

  API_IMAGE_REF="$(grep '^API_IMAGE_REF=' "$REMOTE_DIR/.env.deploy" | cut -d= -f2-)"
  case "$API_IMAGE_REF" in
    *@sha256:*) ;;
    *)
      echo "[FAIL] .env.deploy 的 API_IMAGE_REF 必须固定为 tag@sha256:digest"
      exit 1
      ;;
  esac
  echo "[build] 基座 API 镜像：$API_IMAGE_REF"
  docker build --build-arg "API_IMAGE_REF=$API_IMAGE_REF" -t "$LOCAL_IMAGE" "$BRIDGE_DIR"
  docker tag "$LOCAL_IMAGE" "$REG_IMAGE"
  docker push "$REG_IMAGE" > /dev/null
  echo "[push] $REG_IMAGE"
fi

if [ "$MODE" = "rollback" ]; then
  LOCAL_IMAGE="inpulse-wecom-bridge:$ROLLBACK_TAG"
  if ! docker image inspect "$LOCAL_IMAGE" > /dev/null 2>&1; then
    echo "[FAIL] 历史镜像不存在：$LOCAL_IMAGE"
    echo "       现存桥接镜像："
    docker images --format '  {{.Repository}}:{{.Tag}}' | grep -i bridge || true
    exit 1
  fi
  echo "[rollback] 使用历史镜像 $LOCAL_IMAGE"
fi

if [ "$SKIP_RESTART" = "1" ]; then
  echo "[skip] SkipRestart：容器未动；如需重建，重跑不带 -SkipRestart 的 update-bridge.ps1"
else
  echo "[restart] 重建容器 $CONTAINER"
  OLD_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  docker stop -t 5 "$CONTAINER" > /dev/null 2>&1 || true
  docker rm "$CONTAINER" > /dev/null 2>&1 || true

  docker run -d --name "$CONTAINER" \
    --restart unless-stopped \
    --network "$NET_EGRESS" \
    --user 10001:10001 \
    --read-only \
    --tmpfs /tmp:size=32m,noexec,nosuid,nodev \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --memory 256m \
    --env-file "$BRIDGE_DIR/bridge.env" \
    -v "$REMOTE_DIR/secrets/db_runtime_password:/run/secrets/db_runtime_password:ro" \
    -v "$KEY_FILE:/run/secrets/wecom_robot_encryption_key:ro" \
    -v "$BRIDGE_DIR/state:/state" \
    -v "$BRIDGE_DIR/app/bridge-config.json:/opt/wecom-bridge/bridge-config.json:ro" \
    -v "$BRIDGE_DIR/app/config.json:/opt/wecom-bridge/config.json:ro" \
    "$LOCAL_IMAGE" > /dev/null

  docker network connect "$NET_BACKEND" "$CONTAINER"
  echo "[net] 已连接 $NET_EGRESS 与 $NET_BACKEND"

  BRIDGE_STATE="starting"
  for _ in $(seq 1 30); do
    if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
      BRIDGE_STATE="failed"
      break
    fi
    LOGS="$(docker logs --tail 200 "$CONTAINER" 2>&1 || true)"
    case "$LOGS" in
      *"订阅成功"*) BRIDGE_STATE="subscribed"; break ;;
      *"数据库中尚无机器人配置"*) BRIDGE_STATE="waiting_config"; break ;;
    esac
    sleep 3
  done

  if [ "$BRIDGE_STATE" = "failed" ]; then
    echo "[FAIL] 桥接容器已退出，最近日志："
    docker logs --tail 80 "$CONTAINER" 2>&1 || true
    if [ -n "$OLD_IMAGE" ]; then
      echo "[hint] 原镜像：$OLD_IMAGE；可用 -RollbackTo <旧Tag> 回滚"
    fi
    exit 1
  fi
  if [ "$BRIDGE_STATE" = "waiting_config" ]; then
    echo "[waiting] 桥接容器已运行，正式库尚无企业微信机器人配置；等待管理员在设置页保存。"
    docker logs --tail 12 "$CONTAINER" 2>&1
  elif [ "$BRIDGE_STATE" = "subscribed" ]; then
    echo "[ok] 企业微信长连接订阅成功，最近日志："
    docker logs --tail 12 "$CONTAINER" 2>&1
  else
    echo "[FAIL] 90 秒内桥接未进入可判定状态，最近日志："
    docker logs --tail 80 "$CONTAINER" 2>&1 || true
    if [ -n "$OLD_IMAGE" ]; then
      echo "[hint] 原镜像：$OLD_IMAGE；可用 -RollbackTo <旧Tag> 回滚"
    fi
    exit 1
  fi
fi

if [ "$MODE" = "update" ] && [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
  rm -rf "$STAGING"
  echo "[clean] 已清理 $STAGING"
fi
rm -f "__REMOTE_SCRIPT__"
echo "[done] $TAG"
'@

$mode = 'update'
$rollbackArg = ''
if ($rollbackMode) { $mode = 'rollback'; $rollbackArg = $RollbackTo }
$skipFlag = '0'
if ($SkipRestart) { $skipFlag = '1' }

$remoteSh = "$RemoteDir/.update-bridge-$stamp.sh"
$remoteScript = $remoteTemplate.Replace('__MODE__', $mode).Replace('__TAG__', $Tag).Replace('__ROLLBACK_TAG__', $rollbackArg).Replace('__REMOTE_DIR__', $RemoteDir).Replace('__STAGING__', $stagingDir).Replace('__SKIP_RESTART__', $skipFlag).Replace('__REMOTE_SCRIPT__', $remoteSh)
$crlf = [string][char]13 + [string][char]10
$remoteScript = $remoteScript.Replace($crlf, $lf)
$localSh = Join-Path $workDir 'remote-bridge.sh'
[System.IO.File]::WriteAllText($localSh, $remoteScript, (New-Object System.Text.UTF8Encoding($false)))
& scp -q @sshOptions $localSh "${sshTarget}:$remoteSh"
Test-ExitCode $LASTEXITCODE '上传远端同步脚本'

Write-Host ''
Write-Host '=== 正式机上执行（sudo）===' -ForegroundColor Cyan
if (-not [string]::IsNullOrWhiteSpace($VmPassword)) {
  $remoteCmd = "tr -d '\r' | sudo -S -p '' bash '$remoteSh'"
  $VmPassword | & ssh @sshOptions $sshTarget $remoteCmd
} else {
  Write-Host '未提供 sudo 密码：将在终端提示输入。' -ForegroundColor Yellow
  & ssh -t @sshOptions $sshTarget "sudo bash '$remoteSh'"
}
$remoteExit = $LASTEXITCODE
Test-ExitCode $remoteExit '正式机侧同步'

Write-Host ''
if ($rollbackMode) {
  Write-Host "回滚完成：inpulse-wecom-bridge:$RollbackTo" -ForegroundColor Green
} else {
  Write-Host "桥接同步完成：inpulse-wecom-bridge:$Tag" -ForegroundColor Green
}
Write-Host '  容器    : inpulse-wecom-bridge（正式机 sudo docker logs -f inpulse-wecom-bridge）' -ForegroundColor Green
Write-Host '  回滚    : powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update-bridge.ps1 -ConfirmProduction -RollbackTo <旧 Tag>' -ForegroundColor Green
Write-Host "  源码备份: $RemoteDir/backups/wecom-bridge-src-*.tgz" -ForegroundColor Green
Write-Host "  本地临时: $workDir" -ForegroundColor Green

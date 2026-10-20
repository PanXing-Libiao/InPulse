<#
.SYNOPSIS
    InPulse 测试 VM 企业微信桥接同步：本地唯一源 -> VM 校验 -> 远端构建 -> 重建容器。

.DESCRIPTION
    同步测试 VM 上独立于 compose 栈的桥接容器 inpulse-wecom-bridge，不是生产发布流程。
    本地唯一源是 deploy/test-vm/wecom-bridge/：所有改动先落本地仓库，再用本脚本同步到 VM；
    不要在 VM 上直接改脚本或配置，否则下次同步会被覆盖。

    执行顺序：
      1. 本地计算文件清单、SHA256SUMS 与内容哈希 Tag（同内容同 Tag，重复同步不产生新镜像）；
      2. scp 逐文件上传到 VM /home/<user>/inpulse-deploy/.bridge-upload-<时间戳>/；
      3. VM 上 sha256sum -c 逐文件校验，不通过立即停止；
      4. 备份 VM 现有 wecom-bridge/ 源码为 backups/wecom-bridge-src-<时间戳>.tgz；
      5. app/package.json 变化时，用固定 Node 镜像执行 npm install --omit=dev 刷新依赖；
      6. docker build inpulse-wecom-bridge:<Tag> 并推入本地 registry 127.0.0.1:5000；
      7. 按固定安全参数重建容器（只读根、cap-drop ALL、tmpfs、10001，先接 egress 再 connect backend），
         等待日志出现「订阅成功」；失败时打印回滚命令；
      8. 清理 VM 临时上传目录。

.PARAMETER Repo
    仓库工作区，默认脚本所在仓库根目录。

.PARAMETER VmHost
    测试 VM 地址，默认 10.1.104.45。

.PARAMETER VmUser
    SSH 账户，默认 libiao。

.PARAMETER VmPassword
    VM 密码，只喂给远端 sudo -S；推荐改用环境变量 INPULSE_VM_PASSWORD。

.PARAMETER SshKey
    指定 SSH 私钥路径；留空时按 inpulse_deploy_ed25519 -> inpulse_test_deploy -> id_ed25519
    的顺序自动挑第一把能免密登录的密钥。

.PARAMETER RemoteDir
    VM 部署目录，默认 /home/<VmUser>/inpulse-deploy。

.PARAMETER Tag
    镜像 Tag，默认 0.1.0-<日期>-bridge<内容哈希前 7 位>。

.PARAMETER SkipRestart
    只上传、构建并推 registry，不重建容器。

.PARAMETER RollbackTo
    用指定的历史 Tag 重建容器（不上传、不构建、不推 registry）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update-bridge.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update-bridge.ps1 -SkipRestart

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update-bridge.ps1 -RollbackTo 0.1.0-20261015-bridge4
#>

[CmdletBinding()]
param(
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
$VmHost = Get-Default $VmHost 'INPULSE_VM_HOST' '10.1.104.45'
$VmUser = Get-Default $VmUser 'INPULSE_VM_USER' 'libiao'
$RemoteDir = Get-Default $RemoteDir 'INPULSE_VM_REMOTE_DIR' "/home/$VmUser/inpulse-deploy"
if ([string]::IsNullOrWhiteSpace($VmPassword)) {
  $VmPassword = [Environment]::GetEnvironmentVariable('INPULSE_VM_PASSWORD')
}

$bridgeLocal = Join-Path $Repo 'deploy\test-vm\wecom-bridge'
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
  $keyCandidates = @($deployKeyDefault, (Join-Path $HOME '.ssh\inpulse_test_deploy'), (Join-Path $HOME '.ssh\id_ed25519'))
}

Write-Host "仓库      : $Repo" -ForegroundColor Cyan
Write-Host "测试 VM   : $sshTarget" -ForegroundColor Cyan
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
  Write-Warning '想全程免密，先跑一次：powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -SetupKey'
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
  $Tag = '0.1.0-{0}-bridge{1}' -f (Get-Date -Format 'yyyyMMdd'), $contentHash
}
if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "镜像 Tag 不合法：$Tag" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$workDir = Join-Path $env:TEMP "inpulse-bridge-$stamp"
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
  Write-Host '=== 上传桥接源码 ===' -ForegroundColor Cyan
  & ssh @sshOptions $sshTarget $mkdirCmd
  Test-ExitCode $LASTEXITCODE '在 VM 上创建临时上传目录'
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

echo "[bridge] 模式=$MODE 目标=$TAG"

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
  mkdir -p "$REMOTE_DIR/backups"
  tar czf "$REMOTE_DIR/backups/wecom-bridge-src-$STAMP.tgz" -C "$BRIDGE_DIR" --exclude=node_modules --exclude=state --exclude='*.bak-*' .
  echo "[backup] $REMOTE_DIR/backups/wecom-bridge-src-$STAMP.tgz"

  cp -a "$STAGING/files/." "$BRIDGE_DIR/"
  echo "[copy] 源码已更新（node_modules 与 state 保持不动）"

  if [ "$DEPS_CHANGED" = "1" ]; then
    echo "[deps] app/package.json 有变化，刷新依赖（npm install --omit=dev）"
    NPM_IMAGE="node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
    docker run --rm --network "$NET_EGRESS" --entrypoint npm -v "$BRIDGE_DIR/app:/work" -w /work "$NPM_IMAGE" install --omit=dev --no-audit --no-fund
    chown -R 10001:10001 "$BRIDGE_DIR/app/node_modules"
    if [ -f "$BRIDGE_DIR/app/package-lock.json" ]; then chown 10001:10001 "$BRIDGE_DIR/app/package-lock.json"; fi
    echo "[deps] 依赖已刷新"
  fi

  echo "[build] docker build -t $LOCAL_IMAGE $BRIDGE_DIR"
  docker build -t "$LOCAL_IMAGE" "$BRIDGE_DIR"
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
    -v "$REMOTE_DIR/secrets/wecom_robot_encryption_key:/run/secrets/wecom_robot_encryption_key:ro" \
    -v "$BRIDGE_DIR/state:/state" \
    -v "$BRIDGE_DIR/app/bridge-config.json:/opt/wecom-bridge/bridge-config.json:ro" \
    -v "$BRIDGE_DIR/app/config.json:/opt/wecom-bridge/config.json:ro" \
    "$LOCAL_IMAGE" > /dev/null

  docker network connect "$NET_BACKEND" "$CONTAINER"
  echo "[net] 已连接 $NET_EGRESS 与 $NET_BACKEND"

  SUBSCRIBED="0"
  for _ in $(seq 1 40); do
    if docker logs --tail 200 "$CONTAINER" 2>&1 | grep -q '订阅成功'; then SUBSCRIBED="1"; break; fi
    sleep 3
  done
  if [ "$SUBSCRIBED" != "1" ]; then
    echo "[FAIL] 120 秒内未见「订阅成功」，最近日志："
    docker logs --tail 40 "$CONTAINER" 2>&1 || true
    if [ -n "$OLD_IMAGE" ]; then
      echo "[hint] 回滚：跑 update-bridge.ps1 -RollbackTo <旧Tag>（原镜像 $OLD_IMAGE）"
    fi
    exit 1
  fi
  echo "[ok] 订阅成功，最近日志："
  docker logs --tail 8 "$CONTAINER" 2>&1
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
Write-Host '=== VM 上执行（sudo）===' -ForegroundColor Cyan
if (-not [string]::IsNullOrWhiteSpace($VmPassword)) {
  $remoteCmd = "tr -d '\r' | sudo -S -p '' bash '$remoteSh'"
  $VmPassword | & ssh @sshOptions $sshTarget $remoteCmd
} else {
  Write-Host '未提供 VM 密码：sudo 将在终端提示输入。' -ForegroundColor Yellow
  & ssh -t @sshOptions $sshTarget "sudo bash '$remoteSh'"
}
$remoteExit = $LASTEXITCODE
Test-ExitCode $remoteExit 'VM 侧同步'

Write-Host ''
if ($rollbackMode) {
  Write-Host "回滚完成：inpulse-wecom-bridge:$RollbackTo" -ForegroundColor Green
} else {
  Write-Host "桥接同步完成：inpulse-wecom-bridge:$Tag" -ForegroundColor Green
}
Write-Host '  容器    : inpulse-wecom-bridge（VM 上 sudo docker logs -f inpulse-wecom-bridge）' -ForegroundColor Green
Write-Host '  回滚    : powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update-bridge.ps1 -RollbackTo <旧 Tag>' -ForegroundColor Green
Write-Host "  源码备份: $RemoteDir/backups/wecom-bridge-src-*.tgz" -ForegroundColor Green
Write-Host "  本地临时: $workDir" -ForegroundColor Green

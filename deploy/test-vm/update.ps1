<#
.SYNOPSIS
    InPulse 测试 VM 一键更新：本机构建镜像 -> 上传 -> 推入 VM 本地 registry -> 更新 Compose 栈。

.DESCRIPTION
    适用于单机 Docker Compose + 本地 registry 的测试 VM，不是生产发布流程。
    生产镜像 Tag/digest 绑定与签名发布仍按技术设计第 12 章由人工完成。

    执行顺序：
      1. docker build 构建选中的镜像（context = 仓库根）；
      2. docker save 导出 tar，scp 上传到 VM 镜像目录；
      3. VM 上 docker load / tag / push 到 127.0.0.1:5000；
      4. 以 tag@sha256 形式更新 .env.deploy 的 *_IMAGE_REF（先备份，便于回滚）；
      5. docker compose up -d（migrate 服务先执行数据库迁移）；
      6. 健康检查：api healthy 且 /health/ready 返回 200；
      7. 清理两端 tar 与悬空镜像（-KeepTar 可保留）。

.PARAMETER Repo
    要构建的仓库工作区，默认取脚本所在仓库根目录。

.PARAMETER Targets
    要更新的镜像：api、web、migrate、db-bootstrap、ops，或 all（默认）。
    多个用逗号分隔（-Targets api,migrate）。powershell -File 调用不会把逗号解析成数组，
    脚本内部会再按逗号切一次，所以这种写法可以直接用。

.PARAMETER Tag
    镜像 Tag，默认为 Version-yyyyMMdd-git 短 sha。

.PARAMETER SetupKey
    一次性生成无 passphrase 的部署密钥（默认 ~/.ssh/inpulse_deploy_ed25519）并把公钥装到 VM，
    之后每次更新全程免密，不再反复要求输入 SSH 密码。

.PARAMETER SshKey
    指定 SSH 私钥路径。留空时按 inpulse_deploy_ed25519 -> inpulse_test_deploy -> id_ed25519
    的顺序自动挑选第一把真正能免密登录的密钥。

.PARAMETER VmPassword
    VM 密码，只用于远端 sudo；也可用环境变量 INPULSE_VM_PASSWORD。留空则在终端交互输入。

.PARAMETER Mirror
    拉取基础镜像用的 Docker 镜像源，默认 docker.1ms.run（公司网络无法直连 Docker Hub）。

.PARAMETER NoMirror
    跳过镜像源，直接按 Dockerfile 里的原始地址拉取基础镜像（本地已缓存全部基础镜像时更快）。

.PARAMETER SkipBuild
    跳过构建与上传，直接用 VM 上已有的 tar 执行远端更新（配合 -Tag）。

.PARAMETER KeepTar
    保留本机构建的 tar 与 VM 上的 tar（默认两端都清理以省磁盘）。

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
  [switch]$NoMirror,
  [string]$Version = '0.1.0',
  [string]$Tag,
  [string[]]$Targets = @('all'),
  [string]$RemoteDir,
  [string]$ImageDir,
  [switch]$SkipBuild,
  [switch]$SetupKey,
  [switch]$KeepTar,
  [switch]$FixEol
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
if ([string]::IsNullOrWhiteSpace($VmPassword)) {
  $VmPassword = [Environment]::GetEnvironmentVariable('INPULSE_VM_PASSWORD')
}
$Mirror = Get-Default $Mirror 'INPULSE_DOCKER_MIRROR' 'docker.1ms.run'

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

function Get-DockerfileFromRefs {
  param([string]$Repo)
  $pattern = Join-Path $Repo 'deploy\docker\*.Dockerfile'
  return @(Select-String -Path $pattern -Pattern '^\s*FROM\s+(\S+)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique)
}

function Invoke-MirrorPull {
  param([string]$Reference, [string]$Mirror)
  $name = ($Reference -split '@')[0]
  $pinnedDigest = ''
  if ($Reference -match '@(sha256:[0-9a-f]{64})$') { $pinnedDigest = $Matches[1] }
  if ($name -match '/') { $remote = "$Mirror/$name" } else { $remote = "$Mirror/library/$name" }
  if ($pinnedDigest) { $remote = "$remote@$pinnedDigest" }
  Write-Host "本地缺少 $Reference，从 $remote 拉取" -ForegroundColor Yellow
  & docker pull $remote 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ } } | Select-Object -Last 2
  if ($LASTEXITCODE -ne 0) { throw "拉取失败：$remote（换一个 -Mirror，或恢复 docker.io 直连后加 -NoMirror）" }
  & docker tag $remote $name
  if ($LASTEXITCODE -ne 0) { throw "打 tag 失败：$remote -> $name" }
  if ($pinnedDigest) {
    $got = @((& docker image inspect $remote --format '{{ range .RepoDigests }}{{ . }}|{{ end }}') -split '\|') |
      Where-Object { $_ } | ForEach-Object { ($_ -split '@')[-1] }
    if ($got -notcontains $pinnedDigest) {
      throw "digest 不匹配：$name 期望 $pinnedDigest，实际 $($got -join ', ')；已停止，请人工确认镜像来源"
    }
    Write-Host "已就绪并校验 digest：$name" -ForegroundColor Green
  } else {
    Write-Host "已就绪：$name" -ForegroundColor Green
  }
}

function Ensure-BaseImages {
  param([string]$Repo, [string]$Mirror)
  foreach ($ref in (Get-DockerfileFromRefs -Repo $Repo)) {
    & docker image inspect $ref *> $null
    if ($LASTEXITCODE -ne 0) { Invoke-MirrorPull -Reference $ref -Mirror $Mirror }
  }
  $pattern = Join-Path $Repo 'deploy\docker\*.Dockerfile'
  $frontends = @(Select-String -Path $pattern -Pattern '^#\s*syntax=(\S+)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique)
  foreach ($frontend in $frontends) {
    & docker image inspect $frontend *> $null
    if ($LASTEXITCODE -ne 0) { Invoke-MirrorPull -Reference $frontend -Mirror $Mirror }
  }
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
  Write-Warning "密钥 $candidate 无法免密登录（可能带 passphrase 或未装到 VM），改用密码认证。"
}
if (-not $keyAuthReady) {
  Write-Warning '本次没有可用的免密密钥：上传镜像与远端执行会多次要求输入 VM 密码。'
  Write-Warning '想全程免密，先执行一次：powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test-vm/update.ps1 -SetupKey'
}

if (-not (Test-Path (Join-Path $Repo 'deploy\compose.yaml'))) {
  throw '找不到 deploy/compose.yaml；请确认 -Repo 指向仓库工作区'
}
foreach ($c in @('docker', 'ssh', 'scp', 'git')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "缺少命令：$c" }
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop 不可用，请先启动它' }

$gitSha = (& git -C $Repo rev-parse --short HEAD).Trim()
Test-ExitCode $LASTEXITCODE 'git rev-parse'
if ([string]::IsNullOrWhiteSpace($Tag)) {
  $Tag = '{0}-{1}-{2}' -f $Version, (Get-Date -Format 'yyyyMMdd'), $gitSha
}
if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "镜像 Tag 不合法：$Tag" }

$dirty = & git -C $Repo status --porcelain
if ($dirty) {
  Write-Warning "工作区有未提交改动：镜像会包含这些改动，但 Tag 里的 $gitSha 只对应最后一次提交"
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

if (-not $SkipBuild) {
  & ssh @sshOptions $sshTarget "mkdir -p '$ImageDir'"
  Test-ExitCode $LASTEXITCODE "在 VM 上创建 $ImageDir"
  if (-not $NoMirror) {
    Write-Host ''
    Write-Host "=== 检查基础镜像（镜像源：$Mirror）===" -ForegroundColor Cyan
    Ensure-BaseImages -Repo $Repo -Mirror $Mirror
  }
  foreach ($t in $targetList) {
    $m = $imageMap[$t]
    $localImage = '{0}:{1}' -f $m.Image, $Tag
    $tarPath = Join-Path $workDir "$t.tar"
    $logPath = Join-Path $workDir "build-$t.log"
    Write-Host ''
    Write-Host "=== 构建 $localImage ===" -ForegroundColor Cyan
    & docker build --progress plain -f (Join-Path $Repo $m.Dockerfile) -t $localImage $Repo 2>&1 |
      ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ } } | Tee-Object -FilePath $logPath
    Test-ExitCode $LASTEXITCODE "构建 $t（完整日志：$logPath）"
    Write-Host "=== 导出 $t.tar ===" -ForegroundColor Cyan
    & docker save -o $tarPath $localImage
    Test-ExitCode $LASTEXITCODE "导出 $t"
    $sizeMb = [math]::Round((Get-Item $tarPath).Length / 1MB, 1)
    Write-Host "=== 上传 $t.tar（$sizeMb MB）===" -ForegroundColor Cyan
    & scp -q @sshOptions $tarPath "${sshTarget}:$ImageDir/$t.tar"
    Test-ExitCode $LASTEXITCODE "上传 $t"
    if (-not $KeepTar) { Remove-Item -LiteralPath $tarPath -Force }
  }
}

$remoteTemplate = @'
#!/usr/bin/env bash
set -euo pipefail

TAG="__TAG__"
REMOTE_DIR="__REMOTE_DIR__"
IMAGE_DIR="__IMAGE_DIR__"
GIT_SHA="__GIT_SHA__"
KEEP_TAR="__KEEP_TAR__"
REGISTRY="127.0.0.1:5000"

cd "$REMOTE_DIR"
COMPOSE="docker compose --env-file .env.deploy -f compose.yaml"

STAMP="$(date +%Y%m%d-%H%M%S)"
cp -p .env.deploy ".env.deploy.bak-$STAMP"
echo "[env] 已备份 .env.deploy -> .env.deploy.bak-$STAMP"

load_push() {
  local name="$1" envkey="$2"
  local tar_path="$IMAGE_DIR/$name.tar"
  if [ ! -f "$tar_path" ]; then
    echo "[skip] $name：$tar_path 不存在"
    return 0
  fi
  echo "[load] $name"
  docker load -i "$tar_path" > /dev/null
  docker tag "inpulse/$name:$TAG" "$REGISTRY/inpulse/$name:$TAG"
  echo "[push] $name:$TAG"
  docker push "$REGISTRY/inpulse/$name:$TAG" > /dev/null
  local digest ref
  digest="$(docker inspect --format '{{ index .RepoDigests 0 }}' "$REGISTRY/inpulse/$name:$TAG" | sed 's/.*@//')"
  ref="$REGISTRY/inpulse/$name:$TAG@$digest"
  sed -i "s|^B{envkey}=.*|B{envkey}=B{ref}|" .env.deploy
  echo "[env] B{envkey}=B{ref}"
}

for pair in "$@"; do
  load_push "B{pair%%:*}" "B{pair##*:}"
done

if grep -q '^BACKUP_GIT_SHA=' .env.deploy; then
  sed -i "s|^BACKUP_GIT_SHA=.*|BACKUP_GIT_SHA=B{GIT_SHA}|" .env.deploy
  echo "[env] BACKUP_GIT_SHA=B{GIT_SHA}"
fi

echo "[up] docker compose up -d（migrate 会先执行数据库迁移）"
$COMPOSE up -d

mig_id="$($COMPOSE ps -q migrate 2>/dev/null || true)"
if [ -n "$mig_id" ]; then
  echo "[migrate] $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$mig_id")"
fi

api_id="$($COMPOSE ps -q api)"
status="unknown"
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$api_id" 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then break; fi
  sleep 3
done
echo "[health] api=$status"
$COMPOSE ps --format '{{.Name}} | {{.Status}}'
curl -sk -H 'Host: test-inpulse.libiaorobot.com' -o /dev/null -w '[probe] /health/ready -> %{http_code}\n' https://127.0.0.1/health/ready
curl -sk -H 'Host: test-inpulse.libiaorobot.com' -o /dev/null -w '[probe] / -> %{http_code}\n' https://127.0.0.1/

if [ "$status" != "healthy" ]; then
  echo "[FAIL] api 未达到 healthy，最近日志："
  docker logs --tail 40 "$api_id" 2>&1 || true
  exit 1
fi

if [ "$KEEP_TAR" != "1" ]; then
  rm -f "$IMAGE_DIR"/*.tar
  docker image prune -f > /dev/null
  echo "[prune] 已清理 $IMAGE_DIR/*.tar 与悬空镜像"
fi

rm -f "$REMOTE_DIR/.update-$TAG.sh"
echo "[done] TAG=$TAG"
'@

$pairs = ($targetList | ForEach-Object { '{0}:{1}' -f $_, $imageMap[$_].EnvKey }) -join ' '
$lf = [string][char]10
$crlf = [string][char]13 + [string][char]10
$keepTarFlag = '0'
if ($KeepTar) { $keepTarFlag = '1' }
$remoteScript = $remoteTemplate.Replace('__TAG__', $Tag).Replace('__REMOTE_DIR__', $RemoteDir).Replace('__IMAGE_DIR__', $ImageDir).Replace('__GIT_SHA__', $gitSha).Replace('__KEEP_TAR__', $keepTarFlag).Replace('B{', '${').Replace($crlf, $lf)
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

Write-Host ''
Write-Host "更新完成：$Tag" -ForegroundColor Green
Write-Host '  站点    : https://test-inpulse.libiaorobot.com/' -ForegroundColor Green
Write-Host "  回滚    : 把 $RemoteDir/.env.deploy 恢复为同目录最新的 .env.deploy.bak-*，" -ForegroundColor Green
Write-Host '            再执行 sudo docker compose --env-file .env.deploy -f compose.yaml up -d' -ForegroundColor Green

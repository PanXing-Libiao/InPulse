<#
.SYNOPSIS
    InPulse 正式环境单机更新入口。
.DESCRIPTION
    对 10.1.103.45 上的正式 Compose 栈执行受控更新。必须显式传入
    -ConfirmProduction；脚本要求 Git 工作区干净，并复用共享的单机 VM
    源码上传与远端构建执行器；本机只需 Node.js、Git、ssh、scp，不需要 Docker Desktop。它不替代技术设计第 12 章的镜像签名、发布清单审批
    和上线备份/恢复演练门禁。
.PARAMETER ConfirmProduction
    正式环境安全闸门，缺失时拒绝执行。
.PARAMETER Targets
    要更新的镜像：api、web、migrate、db-bootstrap、ops，或 all（默认）。
.PARAMETER Tag
    可选镜像 Tag；默认由共享执行器按提交和日期生成。
.PARAMETER FixEol
    构建 migrate 前按字节修复迁移文件行尾漂移。
.PARAMETER KeepTar
    保留本机源码包、VM 源码包与构建目录（默认成功时清理）。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy/prod/update.ps1 -ConfirmProduction
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [switch]$ConfirmProduction,
  [string[]]$Targets = @("all"),
  [string]$Tag,
  [switch]$FixEol,
  [switch]$KeepTar
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$updateScript = (Resolve-Path (Join-Path $scriptRoot "../test-vm/update.ps1")).Path
$repo = (Resolve-Path (Join-Path $scriptRoot "../..")).Path

if (-not $ConfirmProduction) { throw "正式发布必须显式传入 -ConfirmProduction。" }

$status = (& git -C $repo status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "无法读取 Git 工作区状态。" }
if ($status) { throw "正式发布要求 Git 工作区干净；请先提交或处理未提交改动。" }

$head = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -notmatch "^[0-9a-f]{40}$") {
  throw "无法解析完整 Git commit SHA。"
}

$targetLabel = $Targets -join ","
Write-Host ""
Write-Host "=== InPulse 正式环境更新 ===" -ForegroundColor Yellow
Write-Host "主机      : 10.1.103.45" -ForegroundColor Yellow
Write-Host "站点      : https://inpulse.libiaorobot.com/" -ForegroundColor Yellow
Write-Host "Git SHA   : $head" -ForegroundColor Yellow
Write-Host "更新范围  : $targetLabel" -ForegroundColor Yellow
Write-Host ""

$params = @{
  Repo = $repo
  VmHost = "10.1.103.45"
  VmUser = "libiao"
  PublicHost = "inpulse.libiaorobot.com"
  RemoteDir = "/home/libiao/inpulse-deploy"
  ImageDir = "/home/libiao/inpulse-images"
  Targets = $Targets
  RequireClean = $true
}
if (-not [string]::IsNullOrWhiteSpace($Tag)) { $params.Tag = $Tag }
if ($FixEol) { $params.FixEol = $true }
if ($KeepTar) { $params.KeepTar = $true }

& $updateScript @params

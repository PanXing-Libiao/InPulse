[CmdletBinding()]
param(
  [string]$PostgresBin = $env:POSTGRES_BIN,
  [ValidateRange(1024, 65535)]
  [int]$Port = 55432,
  [switch]$KeepData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PostgresBin)) {
  throw 'Set POSTGRES_BIN or pass -PostgresBin with the PostgreSQL 18 bin directory.'
}

$resolvedBin = (Resolve-Path -LiteralPath $PostgresBin).Path
$requiredPrograms = @('initdb.exe', 'pg_ctl.exe', 'createdb.exe', 'psql.exe')
foreach ($program in $requiredPrograms) {
  $programPath = Join-Path $resolvedBin $program
  if (-not (Test-Path -LiteralPath $programPath -PathType Leaf)) {
    throw "Missing PostgreSQL program: $programPath"
  }
}

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase (
  'InPulse-PgTest-' + [System.Guid]::NewGuid().ToString('N')
)
$resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
if (
  -not $resolvedTestRoot.StartsWith(
    $tempBase,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -or
  -not (Split-Path -Leaf $resolvedTestRoot).StartsWith('InPulse-PgTest-')
) {
  throw "Refusing unsafe temporary path: $resolvedTestRoot"
}

$dataDirectory = Join-Path $resolvedTestRoot 'data'
$logPath = Join-Path $resolvedTestRoot 'postgresql.log'
$repositoryRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..\..')
)
$rolesScript = Join-Path $repositoryRoot 'database\bootstrap\000_roles.sql'
$pgroongaScript = Join-Path $repositoryRoot 'database\bootstrap\020_pgroonga.sql'
$serverStarted = $false
$serverStopped = $false
$succeeded = $false

New-Item -ItemType Directory -Path $resolvedTestRoot | Out-Null

try {
  $initArguments = @(
    '-D', $dataDirectory,
    '--username=cluster_bootstrap',
    '--encoding=UTF8',
    '--locale=C',
    '--auth=trust'
  )
  & (Join-Path $resolvedBin 'initdb.exe') @initArguments
  if ($LASTEXITCODE -ne 0) {
    throw "initdb failed with exit code $LASTEXITCODE"
  }

  $serverOptions = "-p $Port -h 127.0.0.1 -c max_connections=150"
  $startArguments = @(
    '-D', $dataDirectory,
    '-l', $logPath,
    '-o', $serverOptions,
    '-w', 'start'
  )
  & (Join-Path $resolvedBin 'pg_ctl.exe') @startArguments
  if ($LASTEXITCODE -ne 0) {
    throw "pg_ctl start failed with exit code $LASTEXITCODE"
  }
  $serverStarted = $true

  $createArguments = @(
    '-h', '127.0.0.1',
    '-p', $Port,
    '-U', 'cluster_bootstrap',
    'app'
  )
  & (Join-Path $resolvedBin 'createdb.exe') @createArguments
  if ($LASTEXITCODE -ne 0) {
    throw "createdb failed with exit code $LASTEXITCODE"
  }

  $psqlArguments = @(
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1',
    '-p', $Port,
    '-U', 'cluster_bootstrap',
    '-d', 'app',
    '-f', $rolesScript
  )
  & (Join-Path $resolvedBin 'psql.exe') @psqlArguments
  if ($LASTEXITCODE -ne 0) {
    throw "database role bootstrap failed with exit code $LASTEXITCODE"
  }

  # pg_available_extensions exposes the extension name as "name"; "extname"
  # belongs to pg_extension and would make this probe fail on every server.
  $pgroongaProbe = @(
    & (Join-Path $resolvedBin 'psql.exe') `
      -X `
      -At `
      -h '127.0.0.1' `
      -p $Port `
      -U 'cluster_bootstrap' `
      -d 'app' `
      -c "SELECT count(*)::INTEGER FROM pg_available_extensions WHERE name = 'pgroonga'"
  )
  $pgroongaProbeExit = $LASTEXITCODE
  $pgroongaAvailable = if ($pgroongaProbe.Count -gt 0) {
    "$($pgroongaProbe[-1])".Trim()
  } else {
    ''
  }
  if ($pgroongaProbeExit -ne 0 -or $pgroongaAvailable -ne '1') {
    throw 'The PostgreSQL 18 installation must provide the PGroonga extension; install the matching PGDG PGroonga package, or run the probe in CI/VM. Local development does not require Docker Desktop.'
  }

  $pgroongaArguments = @(
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1',
    '-p', $Port,
    '-U', 'cluster_bootstrap',
    '-d', 'app',
    '-f', $pgroongaScript
  )
  & (Join-Path $resolvedBin 'psql.exe') @pgroongaArguments
  if ($LASTEXITCODE -ne 0) {
    throw "PGroonga bootstrap failed with exit code $LASTEXITCODE"
  }

  $env:NODE_ENV = 'test'
  $env:MIGRATION_DATABASE_URL =
    "postgresql://app_migrator@127.0.0.1:$Port/app"
  $env:TEST_DATABASE_URL =
    "postgresql://cluster_bootstrap@127.0.0.1:$Port/app"

  Push-Location $repositoryRoot
  try {
    & pnpm db:migrations:check
    if ($LASTEXITCODE -ne 0) {
      throw "migration validation failed with exit code $LASTEXITCODE"
    }
    & pnpm db:migrate
    if ($LASTEXITCODE -ne 0) {
      throw "database migration failed with exit code $LASTEXITCODE"
    }
    & pnpm db:test
    if ($LASTEXITCODE -ne 0) {
      throw "database tests failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  $succeeded = $true
} finally {
  if ($serverStarted) {
    $stopArguments = @('-D', $dataDirectory, '-m', 'fast', '-w', 'stop')
    & (Join-Path $resolvedBin 'pg_ctl.exe') @stopArguments
    $serverStopped = $LASTEXITCODE -eq 0
  }

  if ($succeeded -and $serverStopped -and -not $KeepData) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  } else {
    Write-Host "PostgreSQL test files retained at $resolvedTestRoot"
  }
}

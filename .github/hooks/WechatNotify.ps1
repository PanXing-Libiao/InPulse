# Stop hook：agent 轮次结束时推送企业微信通知。
# 由 .github/hooks/WechatNotify.json 调用，输入从 stdin 读，stdout 必须保持为空。

$ErrorActionPreference = 'Stop'

# 脚本版本（语义化）。扩展拿它和内置模板比对，判断工作区副本是否为旧版。
# 改动本脚本的行为后请同步递增此版本号，否则升级提醒会错判。
$ScriptVersion = '1.2.7'

$StateFile = Join-Path $env:TEMP 'libiao-copilot-wechatnotify.state'
$LogFile = Join-Path $env:TEMP 'libiao-copilot-wechatnotify.log'

# 扩展在把企微消息注入对话前，会把 prompt 的 SHA-256 追加到这里（只存哈希，不存原文）。
# 命中就说明这一轮的回复已经原路发回企微了，不要再推群通知。
$BridgePromptLedgerFile = Join-Path $env:TEMP 'libiao-copilot-bridge-prompts.jsonl'
$BridgePromptLedgerTtlSeconds = 1800

function Write-WechatNotifyLog([string] $Message) {
	try {
		Add-Content -LiteralPath $LogFile -Value ('[{0}] {1}' -f (Get-Date -Format 'o'), $Message) -Encoding utf8
	} catch { }
}

# 扩展侧用 SHA-256 over UTF-8（先 Trim）计算，两边必须保持一致，否则去重静默失效。
function Get-BridgePromptHash([string] $Text) {
	if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
	$sha = [System.Security.Cryptography.SHA256]::Create()
	try {
		$hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text.Trim()))
	} finally {
		$sha.Dispose()
	}
	return [System.BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
}

# 命中台账 = 这一轮是从企微发起的，回复已经回给企微，不必再推群通知。
function Test-BridgeInjectedPrompt([string] $Prompt) {
	if ([string]::IsNullOrWhiteSpace($Prompt)) { return $false }
	if (-not (Test-Path -LiteralPath $BridgePromptLedgerFile)) { return $false }
	$target = Get-BridgePromptHash $Prompt
	if ([string]::IsNullOrEmpty($target)) { return $false }
	$now = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds()
	$ttlMs = [long] $BridgePromptLedgerTtlSeconds * 1000
	try {
		foreach ($line in [System.IO.File]::ReadLines($BridgePromptLedgerFile)) {
			if ([string]::IsNullOrWhiteSpace($line)) { continue }
			try { $record = $line | ConvertFrom-Json } catch { continue }
			if ($null -eq $record -or $record.h -ne $target) { continue }
			$at = [long] 0
			if (-not [long]::TryParse([string] $record.at, [ref] $at)) { $at = 0 }
			if (($now - $at) -le $ttlMs) { return $true }
		}
	} catch { }
	return $false
}

# ---- 可调参数 ----
# 实际值从同目录的 WechatNotify.local.psd1 读取；该文件不入库，缺失时用下列默认值。
# 默认关闭，因此其他成员克隆仓库后不配置也不会发出通知。
$Enabled = $false
$Webhook = ''
$MinDurationSeconds = 600
$SessionSummaryChars = 60

$configFile = Join-Path $PSScriptRoot 'WechatNotify.local.psd1'
if (Test-Path -LiteralPath $configFile -PathType Leaf) {
	try {
		$localConfig = Import-PowerShellDataFile -LiteralPath $configFile -ErrorAction Stop
		if ($localConfig.ContainsKey('Enabled')) { $Enabled = [bool] $localConfig.Enabled }
		if ($localConfig.ContainsKey('Webhook')) { $Webhook = [string] $localConfig.Webhook }
		if ($localConfig.ContainsKey('MinDurationSeconds')) { $MinDurationSeconds = [int] $localConfig.MinDurationSeconds }
		if ($localConfig.ContainsKey('SessionSummaryChars')) { $SessionSummaryChars = [int] $localConfig.SessionSummaryChars }
	} catch {
		Write-WechatNotifyLog ('读取本地配置失败，已回退默认值：{0}' -f $_.Exception.Message)
	}
}
# ------------------

function Format-Duration([int] $Seconds) {
	# 按时/天分档，否则长耗时会被压成三位数分钟，读的人还得自己换算；
	# 低位为 0 时省略（"3小时" 而不是 "3小时0分"）。
	if ($Seconds -ge 86400) {
		$days = [int][math]::Floor($Seconds / 86400)
		$hours = [int][math]::Floor(($Seconds % 86400) / 3600)
		if ($hours -eq 0) { return '{0}天' -f $days }
		return '{0}天{1}小时' -f $days, $hours
	}
	if ($Seconds -ge 3600) {
		$hours = [int][math]::Floor($Seconds / 3600)
		$minutes = [int][math]::Floor(($Seconds % 3600) / 60)
		if ($minutes -eq 0) { return '{0}小时' -f $hours }
		return '{0}小时{1}分' -f $hours, $minutes
	}
	if ($Seconds -ge 60) {
		$minutes = [int][math]::Floor($Seconds / 60)
		$remSeconds = $Seconds % 60
		if ($remSeconds -eq 0) { return '{0}分' -f $minutes }
		return '{0}分{1}秒' -f $minutes, $remSeconds
	}
	return '{0}秒' -f $Seconds
}

function Get-ModelName($SelectedModel) {
	# selectedModel 形如 { identifier, metadata: { name } }，优先显示名
	if ($null -eq $SelectedModel) { return '' }
	if (-not [string]::IsNullOrWhiteSpace($SelectedModel.metadata.name)) { return [string] $SelectedModel.metadata.name }
	if (-not [string]::IsNullOrWhiteSpace($SelectedModel.identifier)) { return [string] $SelectedModel.identifier }
	return ''
}

function Get-LastCredits($Session) {
	if ($null -eq $Session.requests -or $Session.requests.Count -eq 0) { return $null }
	$value = $Session.requests[-1].copilotCredits
	if ($value -is [valuetype] -and $value -isnot [bool] -and [double]::IsFinite([double] $value) -and $value -ge 0) { return [double] $value }
	return $null
}

function Read-SessionState([string] $LogPath) {
	if ([System.IO.Path]::GetExtension($LogPath) -eq '.json') {
		$text = [System.IO.File]::ReadAllText($LogPath, [System.Text.Encoding]::UTF8)
		return ($text.TrimStart([char] 0xFEFF) | ConvertFrom-Json -AsHashtable)
	}

	$session = $null
	foreach ($line in [System.IO.File]::ReadLines($LogPath)) {
		try { $entry = $line.TrimStart([char] 0xFEFF) | ConvertFrom-Json -AsHashtable } catch { continue }
		if ($entry.kind -eq 0) { $session = $entry.v; continue }
		if ($null -eq $session -or $entry.k -isnot [array]) { continue }
		if ($entry.k.Count -eq 0) {
			if ($entry.kind -eq 1) { $session = $entry.v }
			continue
		}
		$parent = $session
		for ($index = 0; $index -lt $entry.k.Count - 1; $index++) {
			$parent = $parent[$entry.k[$index]]
		}
		$key = $entry.k[-1]
		switch ($entry.kind) {
			1 { $parent[$key] = $entry.v }
			2 {
				$items = [System.Collections.Generic.List[object]]::new()
				$items.AddRange([object[]] $parent[$key])
				if ($entry.Contains('i')) {
					$offset = [int] $entry.i
					$items.RemoveRange($offset, $items.Count - $offset)
				}
				if ($entry.Contains('v')) { $items.AddRange([object[]] $entry.v) }
				$parent[$key] = $items.ToArray()
			}
			3 { $parent.Remove($key) }
		}
	}
	return $session
}

function Get-SessionInfo([string] $TranscriptPath, [string] $SessionId) {
	try {
		# 会话日志与 transcript 同在 <workspaceStorage>/<hash>/ 下，向上找到 chatSessions/<id>.jsonl
		$directory = [System.IO.DirectoryInfo]::new((Split-Path $TranscriptPath -Parent))
		$logPath = $null
		while ($null -ne $directory) {
			$storage = Join-Path $directory.FullName 'chatSessions'
			$candidate = Join-Path $storage ($SessionId + '.jsonl')
			if (Test-Path -LiteralPath $candidate -PathType Leaf) { $logPath = $candidate; break }
			$candidate = Join-Path $storage ($SessionId + '.json')
			if (Test-Path -LiteralPath $candidate -PathType Leaf) { $logPath = $candidate; break }
			$directory = $directory.Parent
		}
		if ($null -eq $logPath) { return $null }

		$session = Read-SessionState $logPath
		return [pscustomobject]@{
			title = [string] $session.customTitle
			selectedModel = Get-ModelName $session.inputState.selectedModel
			credits = Get-LastCredits $session
		}
	} catch {
		Write-WechatNotifyLog ('读取会话信息失败：{0}' -f $_.Exception.Message)
		return $null
	}
}

try {
	# 未启用或未配置 webhook 时静默退出：这是没建本地配置的团队成员的正常状态
	if (-not $Enabled) { exit 0 }
	if ([string]::IsNullOrWhiteSpace($Webhook)) { exit 0 }

	# 调用方按 UTF-8 写 stdin，但 pwsh 在 Windows 下默认按系统代码页（如 936）解码 Console.In。
	# 路径含中文时 transcript_path 会乱码，必须显式用 UTF-8 流读取。
	$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
	$stdin = $reader.ReadToEnd()
	$reader.Dispose()
	if ([string]::IsNullOrWhiteSpace($stdin)) { exit 0 }

	$evt = $stdin.TrimStart([char] 0xFEFF) | ConvertFrom-Json
	if ($evt.hook_event_name -ne 'Stop') { exit 0 }

	$transcriptPath = [string] $evt.transcript_path
	if ([string]::IsNullOrWhiteSpace($transcriptPath)) { exit 0 }
	if (-not (Test-Path -LiteralPath $transcriptPath)) { exit 0 }

	# 只关心 user.message：第一条当会话摘要，最后一条当本轮起点与去重依据
	$firstUserContent = $null
	$lastUserContent = $null
	$lastUserTimestamp = $null
	foreach ($line in [System.IO.File]::ReadLines($transcriptPath)) {
		if ($line -notmatch '"type"\s*:\s*"user\.message"') { continue }
		try { $entry = $line | ConvertFrom-Json } catch { continue }
		if ($entry.type -ne 'user.message') { continue }
		if ($null -eq $firstUserContent) { $firstUserContent = [string] $entry.data.content }
		$lastUserContent = [string] $entry.data.content
		$lastUserTimestamp = ([datetimeoffset] $entry.timestamp).ToString('o')
	}

	if ($null -eq $lastUserTimestamp) { exit 0 }

	if (Test-BridgeInjectedPrompt $lastUserContent) {
		Write-WechatNotifyLog '该轮由企微对话发起，回复已原路返回，跳过群通知'
		exit 0
	}

	$startTime = [datetimeoffset]::Parse($lastUserTimestamp)
	$endTime = [datetimeoffset] $evt.timestamp
	$durationSeconds = [int] ($endTime - $startTime).TotalSeconds

	if ($durationSeconds -lt $MinDurationSeconds) { exit 0 }

	# 同一个 session 的同一轮只通知一次（autopilot 会连续触发多次 Stop）
	$stateKey = '{0}|{1}' -f $evt.session_id, $lastUserTimestamp
	if (Test-Path -LiteralPath $StateFile) {
		try {
			$previous = (Get-Content -LiteralPath $StateFile -Raw -ErrorAction Stop).Trim()
			if ($previous -eq $stateKey) { exit 0 }
		} catch { }
	}
	Set-Content -LiteralPath $StateFile -Value $stateKey -Encoding utf8 -ErrorAction SilentlyContinue

	# 工作区名：脚本位于 <工作区>/.github/hooks/，往上两级即根目录
	$workspaceName = '工作区'
	try {
		$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
		if ($root) { $workspaceName = Split-Path $root -Leaf }
	} catch { }

	$summary = ''
	if (-not [string]::IsNullOrWhiteSpace($firstUserContent)) {
		$summary = ($firstUserContent -replace '\s+', ' ').Trim()
		if ($summary.Length -gt $SessionSummaryChars) {
			$summary = $summary.Substring(0, $SessionSummaryChars) + '…'
		}
	}

	$sessionInfo = Get-SessionInfo $transcriptPath ([string] $evt.session_id)
	if (-not [string]::IsNullOrWhiteSpace($sessionInfo.title)) {
		$summary = ($sessionInfo.title -replace '\s+', ' ').Trim()
	}
	$modelName = '未知'
	if (-not [string]::IsNullOrWhiteSpace($sessionInfo.selectedModel)) {
		$modelName = $sessionInfo.selectedModel -replace '\s+', ' '
	}
	# 拿不到 Credits 时留空，不在消息里刷一行无信息量的「Credits：未知」
	$credits = ''
	if ($null -ne $sessionInfo.credits) {
		$credits = [math]::Truncate([double] $sessionInfo.credits).ToString('0', [System.Globalization.CultureInfo]::InvariantCulture)
	}

	$lines = @(
		'⏱️ 本轮对话已结束'
		'耗时：{0}' -f (Format-Duration $durationSeconds)
		'项目：{0}' -f $workspaceName
		'会话：{0}' -f $summary
		'模型：{0}' -f $modelName
	)
	if ($credits) {
		$lines += ('Credits：{0}' -f $credits)
	}
	$lines += ('时间：{0}' -f $endTime.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))
	$content = $lines -join "`n"

	$body = @{ msgtype = 'text'; text = @{ content = $content } } | ConvertTo-Json -Depth 5 -Compress
	$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

	$response = Invoke-RestMethod -Uri $Webhook -Method Post -ContentType 'application/json; charset=utf-8' `
		-Body $bytes -TimeoutSec 10 -ErrorAction Stop
	if ($response.errcode -eq 0) {
		Write-WechatNotifyLog ('已发送：会话={0} 耗时={1}秒' -f $evt.session_id, $durationSeconds)
	} else {
		Write-WechatNotifyLog ('企业微信返回 errcode={0} errmsg={1}' -f $response.errcode, $response.errmsg)
	}
} catch {
	# hook 报错会污染 stdout 甚至阻塞 agent，一律静默
	Write-WechatNotifyLog ('异常：{0}' -f $_.Exception.Message)
}

exit 0

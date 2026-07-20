[CmdletBinding()]
param(
    [string]$StatePath = (Join-Path (Get-Location) '.planning\STATE.md'),
    [switch]$RequireCompleted
)

$ErrorActionPreference = 'Stop'

function Stop-Gate {
    param([string]$Message)

    [Console]::Error.WriteLine("终验门禁失败：$Message")
    exit 1
}

function Read-IntegerField {
    param(
        [hashtable]$Fields,
        [string]$Name,
        [int]$Minimum
    )

    if (-not $Fields.ContainsKey($Name)) {
        Stop-Gate "STATE.md 的 finalization 缺少字段，字段=$Name。"
    }

    $parsed = 0
    if (-not [int]::TryParse($Fields[$Name], [ref]$parsed)) {
        Stop-Gate "STATE.md 的 finalization 字段必须是整数，字段=$Name，实际值=$($Fields[$Name])。"
    }

    if ($parsed -lt $Minimum) {
        Stop-Gate "STATE.md 的 finalization 字段超出允许范围，字段=$Name，实际值=$parsed，最小值=$Minimum。"
    }

    return $parsed
}

try {
    $fullStatePath = [System.IO.Path]::GetFullPath($StatePath)
}
catch {
    Stop-Gate "STATE.md 路径无效，传入值=$StatePath，原因=$($_.Exception.Message)。"
}

if (-not [System.IO.File]::Exists($fullStatePath)) {
    Stop-Gate "STATE.md 不存在，路径=$fullStatePath。"
}

try {
    $content = [System.IO.File]::ReadAllText($fullStatePath)
}
catch {
    Stop-Gate "无法读取 STATE.md，路径=$fullStatePath，原因=$($_.Exception.Message)。"
}

$frontMatterMatch = [System.Text.RegularExpressions.Regex]::Match(
    $content,
    '\A---\r?\n(?<yaml>.*?)\r?\n---(?:\r?\n|\z)',
    [System.Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $frontMatterMatch.Success) {
    Stop-Gate "STATE.md 缺少合法的 YAML 前置区，路径=$fullStatePath。"
}

$lines = $frontMatterMatch.Groups['yaml'].Value -split '\r?\n'
$finalizationIndexes = @()
for ($index = 0; $index -lt $lines.Length; $index++) {
    if ($lines[$index] -match '^finalization:\s*$') {
        $finalizationIndexes += $index
    }
}

if ($finalizationIndexes.Count -eq 0) {
    Stop-Gate "STATE.md 的 YAML 前置区缺少 finalization，路径=$fullStatePath。"
}
if ($finalizationIndexes.Count -gt 1) {
    Stop-Gate "STATE.md 的 YAML 前置区存在重复 finalization，数量=$($finalizationIndexes.Count)，路径=$fullStatePath。"
}

$fields = @{}
for ($index = $finalizationIndexes[0] + 1; $index -lt $lines.Length; $index++) {
    $line = $lines[$index]
    if ($line -match '^\S') {
        break
    }
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }
    if ($line -notmatch '^  (?<name>[a-z_]+):\s*(?<value>.*?)\s*$') {
        Stop-Gate "finalization 包含无法识别的行，行内容=$line。"
    }

    $name = $Matches['name']
    if ($fields.ContainsKey($name)) {
        Stop-Gate "finalization 包含重复字段，字段=$name。"
    }
    $fields[$name] = $Matches['value']
}

$changeGeneration = Read-IntegerField -Fields $fields -Name 'change_generation' -Minimum 0
$reviewedGeneration = Read-IntegerField -Fields $fields -Name 'reviewed_generation' -Minimum -1
$blockingFindings = Read-IntegerField -Fields $fields -Name 'blocking_findings' -Minimum 0
$finalVerifiedGeneration = Read-IntegerField -Fields $fields -Name 'final_verified_generation' -Minimum -1
$finalVerificationRuns = Read-IntegerField -Fields $fields -Name 'final_verification_runs' -Minimum 0

if (-not $fields.ContainsKey('scope_frozen')) {
    Stop-Gate 'STATE.md 的 finalization 缺少字段，字段=scope_frozen。'
}
$scopeFrozen = $false
if (-not [bool]::TryParse($fields['scope_frozen'], [ref]$scopeFrozen)) {
    Stop-Gate "STATE.md 的 finalization 字段必须是 true 或 false，字段=scope_frozen，实际值=$($fields['scope_frozen'])。"
}

if ($reviewedGeneration -ne $changeGeneration) {
    Stop-Gate "阻断级审查尚未在当前变更代际收敛，change_generation=$changeGeneration，reviewed_generation=$reviewedGeneration。"
}
if (-not $scopeFrozen) {
    Stop-Gate "当前范围尚未冻结，scope_frozen=$scopeFrozen。"
}
if ($blockingFindings -ne 0) {
    Stop-Gate "仍有未关闭的阻断项，blocking_findings=$blockingFindings。"
}

if ($RequireCompleted) {
    if ($finalVerifiedGeneration -ne $changeGeneration) {
        Stop-Gate "最终验收代际不是当前变更代际，change_generation=$changeGeneration，final_verified_generation=$finalVerifiedGeneration。"
    }
    if ($finalVerificationRuns -lt 1) {
        Stop-Gate "尚无形成有效结果的最终验收，final_verification_runs=$finalVerificationRuns。"
    }
}

$mode = if ($RequireCompleted) { '完成门禁' } else { '终验前门禁' }
Write-Host "$mode 通过：STATE=$fullStatePath，change_generation=$changeGeneration，scope_frozen=true，blocking_findings=0。"

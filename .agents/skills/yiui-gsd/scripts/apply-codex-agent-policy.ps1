[CmdletBinding()]
param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }),
    [string]$GsdDefaultsPath = $(Join-Path $HOME '.gsd\defaults.json'),
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

function ConvertTo-Hashtable {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $table = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $table[$key] = ConvertTo-Hashtable $Value[$key]
        }
        return $table
    }

    if ($Value -is [pscustomobject]) {
        $table = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $table[$property.Name] = ConvertTo-Hashtable $property.Value
        }
        return $table
    }

    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-Hashtable $_ })
    }

    return $Value
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Set-TomlString {
    param(
        [string]$Content,
        [string]$Key,
        [string]$Value,
        [string]$Eol
    )

    $line = "$Key = `"$Value`""
    $pattern = '(?m)^' + [regex]::Escape($Key) + '\s*=.*$'
    if ([regex]::IsMatch($Content, $pattern)) {
        return [regex]::Replace($Content, $pattern, $line, 1)
    }

    $developerPattern = '(?m)^developer_instructions\s*='
    if (-not [regex]::IsMatch($Content, $developerPattern)) {
        throw "Agent TOML missing developer_instructions: $Key"
    }
    return [regex]::Replace($Content, $developerPattern, $line + $Eol + 'developer_instructions =', 1)
}

$defaultsDirectory = Split-Path -Parent $GsdDefaultsPath
$agentsDirectory = Join-Path $CodexHome 'agents'
$catalogPath = Join-Path $CodexHome 'gsd-core\bin\shared\model-catalog.json'

if (-not (Test-Path -LiteralPath $catalogPath)) {
    throw "GSD model catalog not found: $catalogPath"
}
if (-not (Test-Path -LiteralPath $agentsDirectory)) {
    throw "Codex GSD agents directory not found: $agentsDirectory"
}

$defaults = [ordered]@{}
if (Test-Path -LiteralPath $GsdDefaultsPath) {
    $rawDefaults = Get-Content -LiteralPath $GsdDefaultsPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($rawDefaults)) {
        $defaults = ConvertTo-Hashtable ($rawDefaults | ConvertFrom-Json)
    }
}

$defaults['resolve_model_ids'] = 'omit'
$defaults['runtime'] = 'codex'
$defaults['model_profile'] = 'adaptive'
$defaults['subagent_timeout'] = 1800000
$profileOverrides = if ($defaults.Contains('model_profile_overrides') -and $defaults['model_profile_overrides'] -is [System.Collections.IDictionary]) {
    $defaults['model_profile_overrides']
} else {
    [ordered]@{}
}
$profileOverrides['codex'] = [ordered]@{
    opus = 'gpt-5.6-sol'
    sonnet = 'gpt-5.6-sol'
    haiku = 'gpt-5.6-sol'
}
$defaults['model_profile_overrides'] = $profileOverrides

$existingEffort = if ($defaults.Contains('effort') -and $defaults['effort'] -is [System.Collections.IDictionary]) {
    $defaults['effort']
} else {
    [ordered]@{}
}
$existingAgentOverrides = if ($existingEffort.Contains('agent_overrides')) {
    $existingEffort['agent_overrides']
} else {
    [ordered]@{}
}
$existingEffort['default'] = 'high'
$existingEffort['routing_tier_defaults'] = [ordered]@{
    light = 'medium'
    standard = 'high'
    heavy = 'high'
}
$existingEffort['agent_overrides'] = $existingAgentOverrides
$defaults['effort'] = $existingEffort

$expectedDefaults = ($defaults | ConvertTo-Json -Depth 20) + [Environment]::NewLine
$currentDefaults = if (Test-Path -LiteralPath $GsdDefaultsPath) {
    Get-Content -LiteralPath $GsdDefaultsPath -Raw
} else {
    ''
}
$defaultsChanged = $currentDefaults -ne $expectedDefaults

$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$agentFiles = @(Get-ChildItem -LiteralPath $agentsDirectory -Filter 'gsd-*.toml' -File)
if ($agentFiles.Count -eq 0) {
    throw "No GSD Codex agent TOML files found in: $agentsDirectory"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $CodexHome "gsd-user-files-backup\agent-policy-$timestamp"
$agentChanges = @()
$flexRemoved = 0
$violations = @()

foreach ($file in $agentFiles) {
    $agentName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $catalogProperty = $catalog.agents.PSObject.Properties | Where-Object { $_.Name -eq $agentName } | Select-Object -First 1
    $routingTier = if ($null -ne $catalogProperty) { [string]$catalogProperty.Value.routingTier } else { 'standard' }
    $expectedEffort = if ($routingTier -eq 'light') { 'medium' } else { 'high' }

    $content = [System.IO.File]::ReadAllText($file.FullName)
    $eol = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $hadFlex = $content -match '(?m)^service_tier\s*=\s*"flex"\s*$'
    $updated = [regex]::Replace($content, '(?m)^service_tier\s*=\s*"flex"\s*\r?\n', '')
    $updated = Set-TomlString -Content $updated -Key 'model' -Value 'gpt-5.6-sol' -Eol $eol
    $updated = Set-TomlString -Content $updated -Key 'model_reasoning_effort' -Value $expectedEffort -Eol $eol

    if ($updated -ne $content) {
        $agentChanges += [ordered]@{ agent = $agentName; tier = $routingTier; effort = $expectedEffort }
        if ($hadFlex) {
            $flexRemoved++
        }
        if (-not $VerifyOnly) {
            $agentBackupDirectory = Join-Path $backupRoot 'agents'
            New-Item -ItemType Directory -Path $agentBackupDirectory -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $agentBackupDirectory $file.Name)
            Write-Utf8NoBom -Path $file.FullName -Content $updated
        }
    }

    $verificationContent = if ($VerifyOnly) { $content } else { $updated }
    if ($verificationContent -notmatch '(?m)^model\s*=\s*"gpt-5\.6-sol"\s*$') {
        $violations += "$agentName model"
    }
    if ($verificationContent -notmatch ('(?m)^model_reasoning_effort\s*=\s*"' + [regex]::Escape($expectedEffort) + '"\s*$')) {
        $violations += "$agentName effort"
    }
    if ($verificationContent -match '(?m)^service_tier\s*=\s*"flex"\s*$') {
        $violations += "$agentName flex"
    }
}

if ($defaultsChanged -and -not $VerifyOnly) {
    New-Item -ItemType Directory -Path $defaultsDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $GsdDefaultsPath) {
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        Copy-Item -LiteralPath $GsdDefaultsPath -Destination (Join-Path $backupRoot 'defaults.json')
    }
    Write-Utf8NoBom -Path $GsdDefaultsPath -Content $expectedDefaults
}

$result = [ordered]@{
    mode = if ($VerifyOnly) { 'verify' } else { 'apply' }
    defaults_path = $GsdDefaultsPath
    defaults_changed = $defaultsChanged
    agents_checked = $agentFiles.Count
    agents_changed = $agentChanges.Count
    flex_removed = $flexRemoved
    backup_path = if ((-not $VerifyOnly) -and (Test-Path -LiteralPath $backupRoot)) { $backupRoot } else { $null }
    violations = $violations
}

$result | ConvertTo-Json -Depth 10
if ($VerifyOnly -and ($defaultsChanged -or $agentChanges.Count -gt 0 -or $violations.Count -gt 0)) {
    exit 1
}

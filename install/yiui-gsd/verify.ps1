# Verify yiui-gsd + GSD global runtime after install / checkout.
[CmdletBinding()]
param(
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) {
    $Root = (Resolve-Path (Join-Path $ScriptDir '../..')).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

$Fail = 0
function Ok([string]$m) { Write-Host "  [ok] $m" }
function Bad([string]$m) { Write-Host "  [FAIL] $m"; $script:Fail = 1 }

Write-Host "verify yiui-gsd @ $Root"

$skillMd = Join-Path $Root '.agents/skills/yiui-gsd/SKILL.md'
if (Test-Path $skillMd) { Ok 'project skill .agents/skills/yiui-gsd/SKILL.md' }
else { Bad 'missing .agents/skills/yiui-gsd/SKILL.md' }

$claudeSkill = Join-Path $Root '.claude/skills/yiui-gsd'
if (Test-Path $claudeSkill) {
    $resolvedSkill = Join-Path $claudeSkill 'SKILL.md'
    if (Test-Path $resolvedSkill) { Ok 'claude skill entry resolves: .claude/skills/yiui-gsd' }
    else { Bad "claude skill entry present but SKILL.md not readable: $claudeSkill" }
} else {
    Bad 'missing .claude/skills/yiui-gsd'
}

$claudeMd = Join-Path $Root '.claude/CLAUDE.md'
if ((Test-Path $claudeMd) -and (Select-String -Path $claudeMd -Pattern 'yiui-gsd' -Quiet)) {
    Ok '.claude/CLAUDE.md pins yiui-gsd'
} else {
    Bad '.claude/CLAUDE.md missing or does not mention yiui-gsd'
}

$vendor = Get-ChildItem -Path (Join-Path $Root '.agents/skills') -Directory -Filter 'gsd-*' -ErrorAction SilentlyContinue
if ($vendor -and $vendor.Count -gt 0) {
    Bad 'project .agents/skills has official gsd-* copies (should only keep yiui-gsd)'
} else {
    Ok 'no official gsd-* under project .agents/skills'
}

$coreVer = Join-Path $HOME '.codex/gsd-core/VERSION'
if (Test-Path $coreVer) {
    $ver = (Get-Content $coreVer -Raw).Trim()
    Ok "GSD core VERSION=$ver ($HOME/.codex/gsd-core)"
} else {
    Bad "missing $coreVer (run install.ps1)"
}

$skillRoot = Join-Path $HOME '.agents/skills'
$skillCount = 0
if (Test-Path $skillRoot) {
    $skillCount = @(Get-ChildItem -Path $skillRoot -Directory -Filter 'gsd-*' -ErrorAction SilentlyContinue).Count
}
if ($skillCount -ge 5) { Ok "global gsd-* skills count=$skillCount" }
else { Bad "global gsd-* skills too few (count=$skillCount); expected under ~/.agents/skills" }

$agentRoot = Join-Path $HOME '.codex/agents'
$agentCount = 0
if (Test-Path $agentRoot) {
    $agentCount = @(Get-ChildItem -Path $agentRoot -File -Filter 'gsd-*' -ErrorAction SilentlyContinue).Count
}
if ($agentCount -ge 5) { Ok "codex gsd-* agents count=$agentCount" }
else { Bad "codex gsd-* agents too few (count=$agentCount); expected under ~/.codex/agents" }

$gsdGit = Join-Path $Root '.gsd/.git'
$gsdDir = Join-Path $Root '.gsd'
if (Test-Path $gsdGit) { Ok '.gsd local git present' }
elseif (Test-Path $gsdDir) { Ok '.gsd present (no .git yet — run install -InitGsd)' }
else { Ok '.gsd not initialized (optional; use -InitGsd or first GSD task)' }

if ($Fail -ne 0) {
    Write-Host 'verify FAILED'
    exit 1
}
Write-Host 'verify OK'
exit 0

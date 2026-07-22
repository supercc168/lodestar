# Install GSD global runtime + ensure yiui-gsd project wiring after checkout.
# Usage (from lodestar root or any cwd):
#   pwsh -NoProfile -File install/yiui-gsd/install.ps1
#   pwsh -NoProfile -File install/yiui-gsd/install.ps1 -Channel next -InitGsd
[CmdletBinding()]
param(
    [ValidateSet('latest', 'next')]
    [string]$Channel = 'latest',
    [switch]$SkipCore,
    [switch]$InitGsd,
    # Kept for command-line compatibility; policy is now applied by default.
    [switch]$ApplyAgentPolicy,
    [switch]$SkipAgentPolicy,
    [string]$Project = '',
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
    Write-Host "==> $Message"
}

function Die([string]$Message) {
    Write-Error $Message
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir '../..')).Path
$SkillSrc = Join-Path $Root '.agents/skills/yiui-gsd'
$ClaudeMdSrc = Join-Path $Root '.claude/CLAUDE.md'
$Helper = Join-Path $SkillSrc 'scripts/yiui-gsd.mjs'

if (-not (Test-Path (Join-Path $SkillSrc 'SKILL.md'))) {
    Die "not a lodestar checkout? missing $SkillSrc/SKILL.md"
}
if (-not (Test-Path $Helper)) {
    Die "missing $Helper"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die 'missing command: node (Node.js >= 18 required)'
}

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Wire-Project([string]$ProjectRoot) {
    if (-not (Test-Path $ProjectRoot)) {
        Die "project path not found: $ProjectRoot"
    }

    $skillDst = Join-Path $ProjectRoot '.agents/skills/yiui-gsd'
    $claudeSkill = Join-Path $ProjectRoot '.claude/skills/yiui-gsd'
    $claudeMd = Join-Path $ProjectRoot '.claude/CLAUDE.md'

    Ensure-Dir (Join-Path $ProjectRoot '.agents/skills')
    Ensure-Dir (Join-Path $ProjectRoot '.claude/skills')

    if ($ProjectRoot -ne $Root) {
        if ((Test-Path $skillDst) -and -not ((Get-Item $skillDst).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Log "project skill exists (not link): $skillDst (leave as-is)"
        } else {
            if (Test-Path $skillDst) { Remove-Item $skillDst -Force -Recurse }
            if ($IsWindows -or $env:OS -match 'Windows') {
                cmd /c "mklink /J `"$skillDst`" `"$SkillSrc`"" | Out-Null
            } else {
                New-Item -ItemType SymbolicLink -Path $skillDst -Target $SkillSrc -Force | Out-Null
            }
            Write-Log "linked project skill -> $skillDst"
        }
    } else {
        if (-not (Test-Path (Join-Path $SkillSrc 'SKILL.md'))) {
            Die "missing skill at $SkillSrc"
        }
    }

    if (-not (Test-Path $claudeSkill)) {
        $linkTarget = Join-Path $ProjectRoot '.agents/skills/yiui-gsd'
        if ($IsWindows -or $env:OS -match 'Windows') {
            cmd /c "mklink /J `"$claudeSkill`" `"$linkTarget`"" | Out-Null
        } else {
            New-Item -ItemType SymbolicLink -Path $claudeSkill -Target '../../.agents/skills/yiui-gsd' -Force | Out-Null
        }
        Write-Log "created claude skill link: $claudeSkill"
    } else {
        Write-Log "claude skill entry ok: $claudeSkill"
    }

    if (-not (Test-Path $claudeMd)) {
        Ensure-Dir (Split-Path $claudeMd -Parent)
        if (Test-Path $ClaudeMdSrc) {
            Copy-Item $ClaudeMdSrc $claudeMd -Force
        } else {
            @'
# Project rules (Claude)

## GSD / 长任务规划
- 多阶段、长任务、需要 TRACKER/阶段推进时，**必须**使用项目 skill `yiui-gsd`（路径 `.agents/skills/yiui-gsd`，Claude 入口 `.claude/skills/yiui-gsd`）。
- 任何 GSD 操作前先读 `.gsd/TRACKER.md`；目标任务 STATE 位于 `.gsd/<slug>/.planning/STATE.md`，底层命令显式带 `--ws <slug>`。
- 根 `.planning/` 是稳定 workstream 路由目录；当前会话选择不写入 TRACKER，也不暂停其他运行中任务。
- **禁止**使用 superpowers / oh-my-claudecode(OMC) / ralplan / ralph / ultrawork / “plan this” 作为规划入口。
'@ | Set-Content -Path $claudeMd -Encoding UTF8
        }
        Write-Log "wrote $claudeMd"
    } else {
        Write-Log "claude rules present: $claudeMd"
    }
}

function Install-Core {
    if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
        Die 'missing command: npx (Node.js >= 18 required)'
    }
    Write-Log "installing @opengsd/gsd-core@$Channel --codex --claude --global"
    & npx --yes "@opengsd/gsd-core@$Channel" --codex --claude --global
    if ($LASTEXITCODE -ne 0) {
        Die "npx gsd-core install failed with exit $LASTEXITCODE"
    }
}

Write-Log "lodestar root: $Root"
Wire-Project $Root

if ($Project) {
    $extra = (Resolve-Path $Project).Path
    Write-Log "wiring extra project: $extra"
    Wire-Project $extra
}

if (-not $SkipCore) {
    $codexVersionPath = Join-Path $HOME '.codex/gsd-core/VERSION'
    $claudeVersionPath = Join-Path $HOME '.claude/gsd-core/VERSION'
    $shouldInstall = $true
    if ((Test-Path $codexVersionPath) -and (Test-Path $claudeVersionPath) -and -not $Yes) {
        $codexCur = (Get-Content $codexVersionPath -Raw).Trim()
        $claudeCur = (Get-Content $claudeVersionPath -Raw).Trim()
        Write-Log "existing GSD core codex=$codexCur claude=$claudeCur (channel=$Channel)"
        $ans = Read-Host "Re-run installer for channel $Channel? [Y/n]"
        if ($ans -match '^[nN]') { $shouldInstall = $false }
    } elseif (-not $Yes) {
        Write-Log 'one or both GSD runtime roots are missing; installing Codex + Claude'
    }
    if ($shouldInstall) {
        Install-Core
    } else {
        Write-Log 'skip core reinstall'
    }
} else {
    Write-Log 'SkipCore: not installing @opengsd/gsd-core'
}

if ($InitGsd) {
    & node $Helper 'init-gsd-repo' '--project-root' $Root
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not $SkipAgentPolicy) {
    & node $Helper 'apply-agent-policy' '--runtime' 'codex'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node $Helper 'apply-agent-policy' '--runtime' 'codex' '--verify-only'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node $Helper 'apply-agent-policy' '--runtime' 'claude'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node $Helper 'apply-agent-policy' '--runtime' 'claude' '--verify-only'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Log 'SkipAgentPolicy: not applying Codex/Claude agent policies'
}

Write-Log 'running verify'
& node $Helper 'verify-install' '--project-root' $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Log "done. Next: bun install && bun run build (for Lodestar daemon); use group command 'gsd' after daemon restart."

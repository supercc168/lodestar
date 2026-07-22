[CmdletBinding()]
param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }),
    [string]$GsdDefaultsPath = $(Join-Path $HOME '.gsd\defaults.json'),
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

$nodeArgs = @(
    $helper,
    'apply-agent-policy',
    '--runtime', 'codex',
    '--codex-home', $CodexHome,
    '--gsd-defaults-path', $GsdDefaultsPath
)
if ($VerifyOnly) { $nodeArgs += '--verify-only' }

& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

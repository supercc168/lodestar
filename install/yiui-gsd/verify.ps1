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

$Helper = Join-Path $Root '.agents/skills/yiui-gsd/scripts/yiui-gsd.mjs'
if (-not (Test-Path $Helper)) {
    throw "missing $Helper"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to verify yiui-gsd.'
}

& node $Helper 'verify-install' '--project-root' $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

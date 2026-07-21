[CmdletBinding()]
param(
    [string]$StatePath = (Join-Path (Get-Location) '.planning\STATE.md'),
    [switch]$RequireCompleted
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

$nodeArgs = @($helper, 'assert-finalization-gate', '--state-path', $StatePath)
if ($RequireCompleted) { $nodeArgs += '--require-completed' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

[CmdletBinding()]
param(
    [string]$StatePath = '',
    [string]$TaskSlug = '',
    [string]$ProjectRoot = (Get-Location).Path,
    [switch]$RequireCompleted
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

$nodeArgs = @($helper, 'assert-finalization-gate', '--project-root', $ProjectRoot)
if ($StatePath) { $nodeArgs += @('--state-path', $StatePath) }
if ($TaskSlug) { $nodeArgs += @('--task-slug', $TaskSlug) }
if ($RequireCompleted) { $nodeArgs += '--require-completed' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

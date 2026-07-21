[CmdletBinding()]
param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$WorkingTaskSlug = '',
    [switch]$CommittedOthers,
    [switch]$LockAlreadyHeld
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

$nodeArgs = @($helper, 'update-gsd-tracker', '--project-root', $ProjectRoot)
if ($WorkingTaskSlug) { $nodeArgs += @('--working-task-slug', $WorkingTaskSlug) }
if ($CommittedOthers) { $nodeArgs += '--committed-others' }
if ($LockAlreadyHeld) { $nodeArgs += '--lock-already-held' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

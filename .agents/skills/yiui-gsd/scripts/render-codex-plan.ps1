[CmdletBinding()]
param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$TaskSlug = ''
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

$nodeArgs = @($helper, 'render-codex-plan', '--project-root', $ProjectRoot)
if ($TaskSlug) { $nodeArgs += @('--task-slug', $TaskSlug) }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

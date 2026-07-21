[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug,
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [string]$UserBrief = '',
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

$nodeArgs = @(
    $helper,
    'bootstrap-autoui-task',
    '--project-root', $ProjectRoot,
    '--task-slug', $TaskSlug,
    '--task-name', $TaskName,
    '--user-brief', $UserBrief
)
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

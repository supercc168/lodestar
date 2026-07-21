[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug,
    [Parameter(Mandatory = $true)]
    [ValidateSet('已暂停', '已完成')]
    [string]$Status,
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

& node $helper 'set-gsd-task-status' '--project-root' $ProjectRoot '--task-slug' $TaskSlug '--status' $Status
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

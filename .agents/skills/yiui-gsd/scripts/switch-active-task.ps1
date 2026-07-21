[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug,
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

& node $helper 'switch-active-task' '--project-root' $ProjectRoot '--task-slug' $TaskSlug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

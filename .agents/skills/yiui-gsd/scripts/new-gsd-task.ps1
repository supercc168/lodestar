[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug,
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$Summary,
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

& node $helper 'new-gsd-task' '--project-root' $ProjectRoot '--task-slug' $TaskSlug '--task-name' $TaskName '--summary' $Summary
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

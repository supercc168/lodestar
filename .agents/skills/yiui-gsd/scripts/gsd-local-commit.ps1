[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'yiui-gsd.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 18 is required to run yiui-gsd helpers.'
}

& node $helper 'gsd-local-commit' '--project-root' $ProjectRoot '--message' $Message
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

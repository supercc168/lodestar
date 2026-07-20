param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug
)

$ErrorActionPreference = 'Stop'

$projectRoot = Get-Location
$planningCanonical = Join-Path $projectRoot ".gsd\$TaskSlug\.planning"
$planningLink = Join-Path $projectRoot '.planning'

if (-not (Test-Path (Join-Path $projectRoot ".gsd\$TaskSlug"))) {
    throw "Task dir missing: .gsd/$TaskSlug"
}

if (-not (Test-Path $planningCanonical)) {
    New-Item -ItemType Directory -Path $planningCanonical -Force | Out-Null
}

if (Test-Path $planningLink) {
    $item = Get-Item $planningLink -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        cmd /c rmdir "$planningLink" 2>$null
        if (Test-Path $planningLink) {
            throw 'Failed to remove existing .planning junction'
        }
    } else {
        throw '.planning exists and is not a junction'
    }
}

New-Item -ItemType Junction -Path $planningLink -Target $planningCanonical | Out-Null
Write-Host "Switched active task: $TaskSlug"

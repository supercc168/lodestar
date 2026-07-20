param(
    [Parameter(Mandatory = $true)]
    [string]$Message
)

$ErrorActionPreference = 'Stop'

$gsdRoot = Join-Path (Get-Location) '.gsd'
if (-not (Test-Path $gsdRoot)) {
    throw '.gsd missing, run init-gsd-repo.ps1 first'
}

Push-Location $gsdRoot
try {
    if (-not (Test-Path '.git')) {
        throw '.gsd git missing, run init-gsd-repo.ps1 first'
    }

    git add -A
    $status = git status --porcelain
    if (-not $status) {
        Write-Host 'No changes to commit'
        return
    }

    git commit -m $Message
    Write-Host "Committed: $Message"
}
finally {
    Pop-Location
}

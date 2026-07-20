param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Get-Location).Path
$planningCanonical = Join-Path $projectRoot (Join-Path '.gsd' (Join-Path $TaskSlug '.planning'))
$planningLink = Join-Path $projectRoot '.planning'
$isWindows = ($env:OS -eq 'Windows_NT') -or ($IsWindows -eq $true)

if (-not (Test-Path (Join-Path $projectRoot (Join-Path '.gsd' $TaskSlug)))) {
    throw "Task dir missing: .gsd/$TaskSlug"
}

if (-not (Test-Path $planningCanonical)) {
    New-Item -ItemType Directory -Path $planningCanonical -Force | Out-Null
}

function Remove-PlanningBridgeOnly {
    param([string]$LinkPath)

    if ($isWindows) {
        if (Test-Path -LiteralPath $LinkPath) {
            $item = Get-Item -LiteralPath $LinkPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                # Junction/symlink only — never Remove-Item -Recurse (would wipe canonical).
                cmd /c rmdir "$LinkPath" 2>$null
                if (Test-Path -LiteralPath $LinkPath) {
                    throw 'Failed to remove existing .planning junction/link'
                }
                return
            }
            throw '.planning exists and is not a symlink/junction/link'
        }
        return
    }

    # Darwin / Linux: remove symlink only; never rm -rf (would wipe canonical).
    $listing = & /bin/ls -ld -- "$LinkPath" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($listing)) {
        return
    }
    if ($listing -match '^l') {
        & /bin/rm -f -- "$LinkPath"
        $stillThere = & /bin/ls -ld -- "$LinkPath" 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($stillThere)) {
            throw 'Failed to remove existing .planning symlink'
        }
        return
    }
    throw '.planning exists and is not a symlink/junction/link'
}

Remove-PlanningBridgeOnly -LinkPath $planningLink

if ($isWindows) {
    New-Item -ItemType Junction -Path $planningLink -Target $planningCanonical | Out-Null
} else {
    # Prefer relative target for portability (matches src/gsd-bridge.ts).
    $relativeTarget = Join-Path '.gsd' (Join-Path $TaskSlug '.planning')
    $created = $false
    try {
        New-Item -ItemType SymbolicLink -Path $planningLink -Target $relativeTarget -ErrorAction Stop | Out-Null
        $created = $true
    } catch {
        $created = $false
    }
    if (-not $created) {
        # Fallback: absolute target via ln -sfn (atomic replace semantics).
        & /bin/ln -sfn -- $planningCanonical $planningLink
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create .planning symlink to $planningCanonical"
        }
    }
}

Write-Host "Switched active task: $TaskSlug"

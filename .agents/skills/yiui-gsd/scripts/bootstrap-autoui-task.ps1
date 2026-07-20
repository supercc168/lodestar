param(
    [Parameter(Mandatory = $true)]
    [string]$TaskSlug,

    [Parameter(Mandatory = $true)]
    [string]$TaskName,

    [string]$UserBrief = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Get-Location).Path
$gsdRoot = Join-Path $projectRoot '.gsd'
$taskDir = Join-Path $gsdRoot $TaskSlug
$planningDir = Join-Path $taskDir '.planning'
$pyScript = Join-Path $PSScriptRoot 'bootstrap_autoui_task.py'
$commitScript = Join-Path $PSScriptRoot 'gsd-local-commit.ps1'

if (-not (Test-Path $gsdRoot)) {
    $initScript = Join-Path $projectRoot '.agents\skills\yiui-gsd\scripts\init-gsd-repo.ps1'
    if (-not (Test-Path $initScript)) {
        throw '.gsd missing and init-gsd-repo.ps1 not found'
    }
    & $initScript
}

if (Test-Path $taskDir) {
    throw "Task already exists: .gsd/$TaskSlug"
}

New-Item -ItemType Directory -Path $planningDir -Force | Out-Null

$pyArgs = @(
    $pyScript,
    '--task-slug', $TaskSlug,
    '--task-name', $TaskName,
    '--user-brief', $UserBrief,
    '--project-root', $projectRoot
)
& python @pyArgs
if ($LASTEXITCODE -ne 0) {
    throw 'bootstrap_autoui_task.py failed'
}

$switchScript = Join-Path $projectRoot '.agents\skills\yiui-gsd\scripts\switch-active-task.ps1'
& $switchScript -TaskSlug $TaskSlug

& $commitScript -Message "gsd($TaskSlug): 创建 autoui 任务"

Write-Host "Bootstrapped autoui task: $TaskSlug"
Write-Host "  TASK.md, notes/PATHS.md, milestones/MILESTONES.md, .planning/PROJECT.md"
Write-Host "  TRACKER updated, junction switched, .gsd committed"

# init .gsd local git repo
# Run from project root:
#   powershell -ExecutionPolicy Bypass -File ".agents/skills/yiui-gsd/scripts/init-gsd-repo.ps1"

$ErrorActionPreference = 'Stop'

$projectRoot = Get-Location
$gsdRoot = Join-Path $projectRoot '.gsd'

if (-not (Test-Path $gsdRoot)) {
    New-Item -ItemType Directory -Path $gsdRoot | Out-Null
}

$gitignoreContent = @'
# GSD sensitive config (may contain API keys)
**/.planning/config.json
'@

$trackerLines = @(
    '# GSD 任务跟踪',
    '',
    '## 当前活跃任务',
    '',
    '- 状态：无任务',
    '- task_slug：',
    '- 任务名称：',
    '- 当前阶段：unknown',
    '- 最后更新：',
    '- planning_path：',
    '- 备注：',
    '',
    '## 任务索引',
    '',
    '| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |',
    '|-----------|------|------|----------|----------|'
)
$trackerContent = $trackerLines -join [Environment]::NewLine

Set-Content -Path (Join-Path $gsdRoot '.gitignore') -Value $gitignoreContent -Encoding UTF8 -NoNewline
Add-Content -Path (Join-Path $gsdRoot '.gitignore') -Value '' -Encoding UTF8
Set-Content -Path (Join-Path $gsdRoot 'TRACKER.md') -Value $trackerContent -Encoding UTF8

Push-Location $gsdRoot
try {
    if (-not (Test-Path '.git')) {
        git init | Out-Null
        Write-Host 'Initialized .gsd local git repo'
    } else {
        Write-Host '.gsd git already exists, skip init'
    }

    $ErrorActionPreference = 'Continue'
    git add .gitignore TRACKER.md 2>&1 | Out-Null
    $status = git status --porcelain 2>&1
    $ErrorActionPreference = 'Stop'
    if ($status) {
        git commit -m 'init gsd task repo' 2>&1 | Out-Null
        Write-Host 'Committed initial TRACKER.md'
    } else {
        Write-Host 'No changes to commit'
    }
}
finally {
    Pop-Location
}

Write-Host 'Done: .gsd is ready'

[CmdletBinding()]
param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$TaskSlug = ''
)

$ErrorActionPreference = 'Stop'

function Stop-Projection {
    param([string]$Message)

    [Console]::Error.WriteLine("GSD Codex 计划投影失败：$Message")
    exit 1
}

function Read-NamedField {
    param(
        [string]$Content,
        [string]$Name
    )

    $pattern = '(?m)^-\s*' + [Regex]::Escape($Name) + '[：:]\s*(?<value>.*?)\s*$'
    $match = [Regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        return ''
    }

    return $match.Groups['value'].Value.Trim()
}

function Read-StateScalar {
    param(
        [string]$Content,
        [string]$Name
    )

    $pattern = '(?m)^-\s*' + [Regex]::Escape($Name) + ':\s*(?<value>.*?)\s*$'
    $match = [Regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        return ''
    }

    return $match.Groups['value'].Value.Trim()
}

function Read-ProgressInteger {
    param(
        [string]$FrontMatter,
        [string]$Name
    )

    $progressMatch = [Regex]::Match(
        $FrontMatter,
        '(?ms)^progress:\s*\r?\n(?<block>(?:[ \t]+.*(?:\r?\n|\z))*)')
    if (-not $progressMatch.Success) {
        return $null
    }

    $fieldMatch = [Regex]::Match(
        $progressMatch.Groups['block'].Value,
        '(?m)^\s+' + [Regex]::Escape($Name) + ':\s*(?<value>\d+)\s*$')
    if (-not $fieldMatch.Success) {
        return $null
    }

    return [int]$fieldMatch.Groups['value'].Value
}

function Read-PlanTitle {
    param(
        [string]$PlanPath,
        [int]$PlanNumber
    )

    if (-not [IO.File]::Exists($PlanPath)) {
        return "Plan $($PlanNumber.ToString('00'))（计划文件缺失）"
    }

    foreach ($line in [IO.File]::ReadLines($PlanPath)) {
        if ($line -match '^#\s+(?<title>.+?)\s*$') {
            $title = $Matches['title'].Trim()
            $title = [Regex]::Replace(
                $title,
                '^Plan\s*\d+\s*[：:]?\s*',
                '',
                [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if (-not [string]::IsNullOrWhiteSpace($title)) {
                return $title
            }
        }
    }

    $content = [IO.File]::ReadAllText($PlanPath)
    $objectiveMatch = [Regex]::Match(
        $content,
        '(?ms)<objective>\s*(?<objective>.*?)\s*</objective>')
    if ($objectiveMatch.Success) {
        $objective = [Regex]::Replace($objectiveMatch.Groups['objective'].Value, '\s+', ' ').Trim()
        if (-not [string]::IsNullOrWhiteSpace($objective)) {
            if ($objective.Length -gt 96) {
                return $objective.Substring(0, 96) + '...'
            }
            return $objective
        }
    }

    return "Plan $($PlanNumber.ToString('00'))"
}

function Read-CurrentCursor {
    param([string]$StateContent)

    $sectionMatch = [Regex]::Match(
        $StateContent,
        '(?ms)^##\s+单向执行游标\s*\r?\n(?<body>.*?)(?=^##\s+|\z)')
    if (-not $sectionMatch.Success) {
        return $null
    }

    $rowMatches = [Regex]::Matches(
        $sectionMatch.Groups['body'].Value,
        '(?m)^\|\s*(?<cursor>[^|]+?)\s*\|\s*(?<item>[^|]+?)\s*\|\s*(?<status>[^|]+?)\s*\|')
    foreach ($rowMatch in $rowMatches) {
        $cursor = $rowMatch.Groups['cursor'].Value.Trim()
        $item = $rowMatch.Groups['item'].Value.Trim()
        $status = $rowMatch.Groups['status'].Value.Trim()
        if ($cursor -eq '游标' -or $cursor -match '^-+$') {
            continue
        }
        if ($status -notin @('GREEN', '已验证')) {
            return [ordered]@{
                cursor = $cursor
                item = $item
                status = $status
            }
        }
    }

    return $null
}

try {
    $resolvedProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
}
catch {
    Stop-Projection "项目根路径无效，传入值=$ProjectRoot，原因=$($_.Exception.Message)。"
}

$trackerPath = Join-Path $resolvedProjectRoot '.gsd\TRACKER.md'
if (-not [IO.File]::Exists($trackerPath)) {
    Stop-Projection "TRACKER.md 不存在，路径=$trackerPath。"
}

$trackerContent = [IO.File]::ReadAllText($trackerPath)
$taskStatus = Read-NamedField -Content $trackerContent -Name '状态'
$activeTaskSlug = Read-NamedField -Content $trackerContent -Name 'task_slug'
$taskName = Read-NamedField -Content $trackerContent -Name '任务名称'
$currentPhase = Read-NamedField -Content $trackerContent -Name '当前阶段'

if (-not [string]::IsNullOrWhiteSpace($TaskSlug)) {
    $activeTaskSlug = $TaskSlug.Trim()
    $taskPath = Join-Path $resolvedProjectRoot ".gsd\$activeTaskSlug\TASK.md"
    if (-not [IO.File]::Exists($taskPath)) {
        Stop-Projection "指定任务缺少 TASK.md，task_slug=$activeTaskSlug，路径=$taskPath。"
    }

    $taskContent = [IO.File]::ReadAllText($taskPath)
    $taskStatus = Read-NamedField -Content $taskContent -Name '状态'
    $taskHeadingMatch = [Regex]::Match($taskContent, '(?m)^#\s+(?<name>.+?)\s*$')
    $taskName = if ($taskHeadingMatch.Success) {
        $taskHeadingMatch.Groups['name'].Value.Trim()
    } else {
        $activeTaskSlug
    }
}

if ([string]::IsNullOrWhiteSpace($activeTaskSlug) -or $taskStatus -eq '无任务') {
    [ordered]@{
        schema_version = 1
        active = $false
        task_slug = ''
        task_name = ''
        task_status = $taskStatus
        source = $trackerPath
        explanation = '当前没有活跃 GSD 任务。'
        plan = @()
        diagnostics = @()
    } | ConvertTo-Json -Depth 6
    exit 0
}

$planningPath = Join-Path $resolvedProjectRoot ".gsd\$activeTaskSlug\.planning"
$statePath = Join-Path $planningPath 'STATE.md'
if (-not [IO.File]::Exists($statePath)) {
    Stop-Projection "任务缺少 STATE.md，task_slug=$activeTaskSlug，路径=$statePath。"
}

$stateContent = [IO.File]::ReadAllText($statePath)
$frontMatterMatch = [Regex]::Match(
    $stateContent,
    '\A---\r?\n(?<yaml>.*?)\r?\n---(?:\r?\n|\z)',
    [Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $frontMatterMatch.Success) {
    Stop-Projection "STATE.md 缺少合法 YAML 前置区，路径=$statePath。"
}

$frontMatter = $frontMatterMatch.Groups['yaml'].Value
$totalPlans = Read-ProgressInteger -FrontMatter $frontMatter -Name 'total_plans'
$completedPlans = Read-ProgressInteger -FrontMatter $frontMatter -Name 'completed_plans'
if ($null -eq $totalPlans -or $null -eq $completedPlans) {
    Stop-Projection "STATE.md progress 缺少 total_plans 或 completed_plans，路径=$statePath。"
}
if ($totalPlans -lt 0 -or $completedPlans -lt 0 -or $completedPlans -gt $totalPlans) {
    Stop-Projection "STATE.md progress 计数非法，completed_plans=$completedPlans，total_plans=$totalPlans。"
}

$currentPlan = Read-StateScalar -Content $stateContent -Name 'current_plan'
$nextAction = Read-StateScalar -Content $stateContent -Name 'next_action'
$statePhase = Read-StateScalar -Content $stateContent -Name 'current_phase'
if (-not [string]::IsNullOrWhiteSpace($statePhase)) {
    $currentPhase = $statePhase
}
$currentCursor = Read-CurrentCursor -StateContent $stateContent
$currentPlanId = ''
if ($currentPlan -match '(?<id>\d+(?:-\d+)?)-PLAN\.md') {
    $currentPlanId = $Matches['id']
}
elseif ($currentPlan -match '^(?<id>\d+(?:-\d+)?)\b') {
    $currentPlanId = $Matches['id']
}

$diagnostics = @()
$planInfos = @(Get-ChildItem -LiteralPath $planningPath -Recurse -File -Filter '*-PLAN.md' |
    ForEach-Object {
        if ($_.Name -notmatch '^(?<id>\d+(?:-\d+)?)-PLAN\.md$') {
            return
        }

        $id = $Matches['id']
        $sortKey = (($id -split '-') | ForEach-Object { ([int]$_).ToString('D8') }) -join '-'
        [pscustomobject]@{
            Id = $id
            SortKey = $sortKey
            Path = $_.FullName
            Title = Read-PlanTitle -PlanPath $_.FullName -PlanNumber ([int](($id -split '-')[-1]))
        }
    } |
    Sort-Object SortKey)
if ($planInfos.Count -ne $totalPlans) {
    $diagnostics += "PLAN 文件数量与 STATE 不一致：files=$($planInfos.Count)，STATE.total_plans=$totalPlans。"
}

$currentPlanIndex = $null
if (-not [string]::IsNullOrWhiteSpace($currentPlanId)) {
    for ($index = 0; $index -lt $planInfos.Count; $index++) {
        if ($planInfos[$index].Id -eq $currentPlanId) {
            $currentPlanIndex = $index
            break
        }
    }
}
if ($completedPlans -lt $totalPlans -and $null -ne $currentPlanIndex -and
    $currentPlanIndex -ne $completedPlans) {
    $expectedId = if ($completedPlans -lt $planInfos.Count) { $planInfos[$completedPlans].Id } else { 'unknown' }
    $diagnostics += "STATE.current_plan 与进度计数不一致：current_plan=$currentPlan，期望计划=$expectedId。"
}
if (-not [string]::IsNullOrWhiteSpace($currentPlanId) -and $currentPlan -match '待创建') {
    $declaredPlan = $planInfos | Where-Object { $_.Id -eq $currentPlanId }
    if ($null -ne $declaredPlan) {
        $diagnostics += "STATE.current_plan 仍标记待创建，但计划文件已存在：$($declaredPlan.Path)。"
    }
}

$activePlanIndex = if ($completedPlans -ge $totalPlans) {
    $null
}
elseif ($null -ne $currentPlanIndex -and $currentPlanIndex -ge $completedPlans) {
    $currentPlanIndex
} else {
    $completedPlans
}
$plan = @()

for ($planIndex = 0; $planIndex -lt $totalPlans; $planIndex++) {
    if ($planIndex -lt $planInfos.Count) {
        $planId = $planInfos[$planIndex].Id
        $title = $planInfos[$planIndex].Title
    }
    else {
        $planId = ($planIndex + 1).ToString('00')
        $title = "Plan $planId（计划文件缺失）"
    }

    if ($planIndex -eq $activePlanIndex -and $null -ne $currentCursor) {
        $cursorTitle = [Regex]::Replace(
            $currentCursor.item,
            '^Plan\s*\d+(?:-\d+)?\s*[：:]?\s*',
            '',
            [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not [string]::IsNullOrWhiteSpace($cursorTitle)) {
            $title = $cursorTitle
        }
    }
    $labelId = $planId
    if ($planIndex -eq $activePlanIndex -and $null -ne $currentCursor) {
        $labelId = "$labelId/$($currentCursor.cursor)"
    }

    $status = 'pending'
    if ($planIndex -lt $completedPlans) {
        $status = 'completed'
    }
    elseif ($planIndex -eq $activePlanIndex -and $taskStatus -eq '运行中') {
        $status = 'in_progress'
    }

    $plan += [ordered]@{
        step = "[GSD $labelId] $title"
        status = $status
    }
}

$cursorSummary = ''
if ($null -ne $currentCursor) {
    $cursorSummary = "，游标=$($currentCursor.cursor)（$($currentCursor.status)）"
}

[ordered]@{
    schema_version = 1
    active = $true
    task_slug = $activeTaskSlug
    task_name = $taskName
    task_status = $taskStatus
    current_phase = $currentPhase
    source = $statePath
    current_plan = $currentPlan
    current_cursor = $currentCursor
    next_action = $nextAction
    explanation = "GSD $activeTaskSlug：已完成 $completedPlans/$totalPlans，当前计划=$currentPlan$cursorSummary。"
    plan = $plan
    diagnostics = $diagnostics
} | ConvertTo-Json -Depth 6

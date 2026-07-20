# .planning Junction 桥接

GSD hooks 与 workflow 硬编码项目根 `.planning/`。多任务 canonical 数据在 `.gsd/{task-slug}/.planning/`。

## 目标

项目根 `.planning/` → Junction → `.gsd/{active-task-slug}/.planning/`

## Windows（推荐脚本）

使用本 skill 的 `scripts/switch-active-task.ps1`，在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File ".agents/skills/yiui-gsd/scripts/switch-active-task.ps1" -TaskSlug "client-quest-system"
```

## 手动步骤（PowerShell，项目根）

```powershell
$slug = "client-quest-system"
$target = Join-Path (Get-Location) ".gsd\$slug\.planning"
if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

$link = Join-Path (Get-Location) ".planning"
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir "$link"
  } else {
    throw ".planning 存在且不是 junction，请先手动处理"
  }
}
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
```

## 验证

```powershell
Get-Item .planning | Select-Object LinkType, Target
Test-Path .planning/STATE.md   # GSD 启动后可能出现
```

## 解除 junction（无活跃任务时可选）

```powershell
if (Test-Path .planning) {
  $item = Get-Item .planning -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir ".planning"
  }
}
```

## 注意

- 只对 junction 使用 `rmdir`，不要 `Remove-Item -Recurse`（会删 canonical 目录）
- projectx 主仓库 `.gitignore` 已忽略 `.planning/` 与 `.gsd/`
- 切换任务前确保目标 `.gsd/{slug}/.planning/` 已存在

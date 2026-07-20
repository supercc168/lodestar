# Planning bridge (symlink / junction)

GSD hooks 与 workflow 硬编码项目根 `.planning/`。多任务 canonical 数据在 `.gsd/{task-slug}/.planning/`。

跨平台语义与 Lodestar daemon 的 `src/gsd-bridge.ts` 对齐：

- **macOS / Linux**：项目根 `.planning` → **symlink** → `.gsd/{active-task-slug}/.planning/`
- **Windows**：项目根 `.planning` → **junction** → `.gsd/{active-task-slug}/.planning/`

## 目标

项目根 `.planning/` → symlink（Unix）或 junction（Windows）→ `.gsd/{active-task-slug}/.planning/`

## 推荐脚本

使用本 skill 的 `scripts/switch-active-task.ps1`，在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File ".agents/skills/yiui-gsd/scripts/switch-active-task.ps1" -TaskSlug "client-quest-system"
```

脚本会按平台选择 symlink 或 junction，并拒绝覆盖真实的非链接 `.planning` 目录。

## Darwin / Linux（手动）

```bash
slug="client-quest-system"
target=".gsd/${slug}/.planning"
mkdir -p "$target"

# 仅移除链接本身，禁止 rm -rf（会删 canonical）
if [ -L .planning ]; then
  rm -f .planning
elif [ -e .planning ]; then
  echo ".planning 存在且不是 symlink，请先手动处理" >&2
  exit 1
fi

ln -sfn "$target" .planning
ls -ld .planning
test -e .planning   # 目标存在时应成功
```

## Windows（手动，PowerShell，项目根）

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
    throw ".planning 存在且不是 junction/link，请先手动处理"
  }
}
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
```

## 验证

```powershell
# Windows
Get-Item .planning | Select-Object LinkType, Target
Test-Path .planning/STATE.md   # GSD 启动后可能出现
```

```bash
# Darwin / Linux
ls -ld .planning
test -f .planning/STATE.md   # GSD 启动后可能出现
```

## 解除 bridge（无活跃任务时可选）

```powershell
# Windows — 只对 junction/link 使用 rmdir
if (Test-Path .planning) {
  $item = Get-Item .planning -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    cmd /c rmdir ".planning"
  }
}
```

```bash
# Darwin / Linux — 只删 symlink
if [ -L .planning ]; then rm -f .planning; fi
```

## 注意

- **只移除链接本身**：Unix 用 `rm`/`unlink` 链接；Windows 对 reparse point 用 `rmdir`。**禁止** `Remove-Item -Recurse` / `rm -rf .planning`（会删进 canonical `.gsd/<slug>/.planning`）
- 若 `.planning` 是真实目录（非 link），必须拒绝覆盖，先手动迁移
- projectx 主仓库 `.gitignore` 已忽略 `.planning/` 与 `.gsd/`
- 切换任务前确保目标 `.gsd/{slug}/.planning/` 已存在（脚本会自动创建空目录）
- 与 daemon 共用语义：实现源为仓库 `src/gsd-bridge.ts`

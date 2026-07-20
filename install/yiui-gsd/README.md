# yiui-gsd 安装（跨设备）

其它机器 `git clone` / `git pull` lodestar 后，**仓库里的** `yiui-gsd` skill 会跟着来，但 **GSD 全局运行时**（`~/.codex/gsd-core`、`~/.agents/skills/gsd-*`、`~/.codex/agents/gsd-*`）不会。本目录提供一键安装与校验。

## 装什么

| 层级 | 路径 | 来源 |
|------|------|------|
| 项目 skill（白话入口） | `.agents/skills/yiui-gsd` | 随仓库 checkout |
| Claude 发现入口 | `.claude/skills/yiui-gsd` → 上者 | 随仓库；安装脚本会补 symlink |
| 项目硬规则 | `.claude/CLAUDE.md` | 随仓库；缺失时脚本写入 |
| GSD Core | `~/.codex/gsd-core` | `npx @opengsd/gsd-core --codex --global` |
| 原生 skills | `~/.agents/skills/gsd-*` | 同上安装器 |
| Codex agents | `~/.codex/agents/gsd-*` | 同上安装器 |
| 任务状态仓 | 各项目 `.gsd/` | **不进主仓**；可选 `--init-gsd` 初始化 |

## 前置

- Node.js ≥ 18（`npx` 可用）
- 网络可访问 npm
- macOS / Linux：`bash`
- Windows：PowerShell 5+ 或 `pwsh`；可选装 PowerShell 以便跑 agent policy 脚本

## 用法

在 **lodestar 仓库根** 执行：

```bash
# macOS / Linux
bash install/yiui-gsd/install.sh

# 仅校验（不改系统）
bash install/yiui-gsd/verify.sh
```

```powershell
# Windows（或任意平台的 pwsh）
pwsh -NoProfile -File install/yiui-gsd/install.ps1
pwsh -NoProfile -File install/yiui-gsd/verify.ps1
```

### 常用参数

| 参数 | 含义 |
|------|------|
| `--channel latest` | 稳定通道（默认） |
| `--channel next` | 预发布 / 1.7 RC 通道 |
| `--skip-core` | 不跑 `@opengsd/gsd-core`，只补项目入口 |
| `--init-gsd` | 在 lodestar 根初始化 `.gsd` 本地任务仓 |
| `--apply-agent-policy` | 安装后重放 Codex 子 agent 策略（需 `pwsh`） |
| `--project <path>` | 额外把 `yiui-gsd` 接到另一个项目目录 |
| `--yes` / `-y` | 非交互（已有 core 时仍会按通道重装/更新） |

示例：

```bash
# 对齐本机曾用的 1.7 next 通道，并初始化任务仓
bash install/yiui-gsd/install.sh --channel next --init-gsd --apply-agent-policy

# 只把 skill 接到 ~/work/foo（不重装全局 core）
bash install/yiui-gsd/install.sh --skip-core --project ~/work/foo
```

## 装完后

1. **Lodestar 本体**仍要：`bun install && bun run build`，再按你的部署方式装 daemon 并重启。
2. **飞书 GSD 卡**依赖 daemon；**phase 规划**依赖本安装的全局 GSD + 项目 `yiui-gsd`。
3. 群里发 `gsd` 开状态卡；聊天里用白话「开新任务 / 继续 gsd」走 yiui-gsd。
4. 任务进度在各项目 `.gsd/`（独立 git），跨设备需自行同步，不会随 lodestar 主仓带走。

## 校验通过标准（verify）

- `~/.codex/gsd-core/VERSION` 存在
- `~/.agents/skills` 下有多个 `gsd-*`
- `~/.codex/agents` 下有 `gsd-*`
- 项目存在 `.agents/skills/yiui-gsd/SKILL.md`
- `.claude/skills/yiui-gsd` 可解析到该 skill
- 项目 `.agents/skills` **没有**官方 `gsd-*` 副本

## 与文档关系

- skill 正文：`.agents/skills/yiui-gsd/SKILL.md`
- 飞书面板：`docs/开发与调试指南.md` §2.5
- 设计：`docs/archive/specs/2026-07-20-yiui-gsd-feishu-stable-design.md`

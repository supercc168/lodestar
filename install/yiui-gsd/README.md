# yiui-gsd 安装（跨设备）

其它机器 `git clone` / `git pull` lodestar 后，**仓库里的** `yiui-gsd` skill 会跟着来，但 Codex/Claude 的 **GSD 全局运行时**不会。本目录提供一键安装与校验。

## 装什么

| 层级 | 路径 | 来源 |
|------|------|------|
| 项目 skill（白话入口） | `.agents/skills/yiui-gsd` | 随仓库 checkout |
| Claude 发现入口 | `.claude/skills/yiui-gsd` → 上者 | 随仓库；安装脚本会补 symlink |
| 项目硬规则 | `.claude/CLAUDE.md` | 随仓库；缺失时脚本写入 |
| Codex GSD Core | `~/.codex/gsd-core` | `npx @opengsd/gsd-core --codex --claude --global` |
| Claude GSD Core | `~/.claude/gsd-core` | 同上安装器 |
| 原生 skills | Codex=`~/.agents/skills/gsd-*`；Claude=`~/.claude/skills/gsd-*` | 同上安装器 |
| GSD agents | Codex=`~/.codex/agents/gsd-*`；Claude=`~/.claude/agents/gsd-*` | 同上安装器 |
| 任务状态仓 | 各项目 `.gsd/` | **不进主仓**；可选 `--init-gsd` 初始化 |

## 前置

- Node.js ≥ 18（`npx` 可用）
- 网络可访问 npm
- macOS / Linux：`bash` + Node.js ≥ 18
- Windows：Node.js ≥ 18；若使用 `.ps1` 安装入口还需要 PowerShell 5+ 或 `pwsh`
- agent policy、任务生命周期、TRACKER 聚合、计划投影和 workstream 路由的实际逻辑由 `scripts/yiui-gsd.mjs` 提供，不依赖 PowerShell

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
| `--channel next` | 最新预发布通道 |
| `--skip-core` | 不跑 `@opengsd/gsd-core`，只补项目入口 |
| `--init-gsd` | 在 lodestar 根初始化 `.gsd` 本地任务仓 |
| `--apply-agent-policy` | 兼容旧命令；策略现在默认自动重放 |
| `--skip-agent-policy` | 跳过策略重放（仅在明确需要时使用） |
| `--project <path>` | 额外把 `yiui-gsd` 接到另一个项目目录 |
| `--yes` / `-y` | 非交互（已有 core 时仍会按通道重装/更新） |

示例：

```bash
# 安装最新预发布版本，并初始化任务仓
bash install/yiui-gsd/install.sh --channel next --init-gsd

# 只把 skill 接到 ~/work/foo（不重装全局 core）
bash install/yiui-gsd/install.sh --skip-core --project ~/work/foo
```

## 装完后

1. **Lodestar 本体**仍要：`bun install && bun run build`，再按你的部署方式装 daemon 并重启。
2. **飞书 GSD 卡**依赖 daemon；**phase 规划**依赖本安装的全局 GSD + 项目 `yiui-gsd`。
3. 群里发 `gsd` 开状态卡；聊天里用白话「开新任务 / 继续 gsd」走 yiui-gsd。
4. 任务进度在各项目 `.gsd/`（独立 git），跨设备需自行同步，不会随 lodestar 主仓带走。

## 校验通过标准（verify）

- `~/.codex/gsd-core/VERSION` 与 `~/.claude/gsd-core/VERSION` 都存在
- Codex/Claude 两侧都有全局 `gsd-*` skills 和 agents
- Codex agent TOML 与 catalog 对齐（Sol、tier effort、无 `service_tier="flex"`）
- Claude agent Markdown 都是 `model: inherit`，由 Lodestar 当前飞书模型 alias 决定真实模型
- 全局 GSD 默认关闭 pattern mapper、非阻断 post-planning gap scan、plan bounce、plan convergence、cross-AI execution、外部 code-review command 和 GSD 1.8 Claude orchestration，减少重复分析、嵌套编排和旧配置绕过同 provider 策略
- `workflow.inline_plan_threshold=2`：单个 PLAN 不超过两个任务时由当前 agent 原地执行，不再支付 executor 子 agent 的启动、等待和报告回传开销；更复杂计划保留隔离执行
- 项目存在 `.agents/skills/yiui-gsd/SKILL.md`
- `.claude/skills/yiui-gsd` 可解析到该 skill
- 项目 `.agents/skills` **没有**官方 `gsd-*` 副本
- `extra-planning-efficiency.md`、三个新任务命令包装层和 Node helper 均存在
- AutoUI bootstrap 不依赖 Python，所有 `.ps1` 只转发到 Node helper

## 与文档关系

- skill 正文：`.agents/skills/yiui-gsd/SKILL.md`
- 飞书面板：`docs/开发与调试指南.md` §2.5
- 设计：`docs/archive/specs/2026-07-20-yiui-gsd-feishu-stable-design.md`

## 跨平台 helper

日常 GSD 操作统一使用：

```bash
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs <command> [options]
```

支持 `init-gsd-repo`、`new-gsd-task`、`switch-active-task`、`set-gsd-task-status`、
`update-gsd-tracker`、`gsd-local-commit`、`render-codex-plan`、`apply-agent-policy`、
`assert-finalization-gate`、`bootstrap-autoui-task` 和 `verify-install`。
同名 `.ps1` 文件保留为 Windows/旧提示词的转发包装层。这样 macOS 上即使 PowerShell 启动缓存损坏，也不影响安装、策略校验或 GSD 状态操作。

Lodestar 会在子进程边界设置 `GSD_RUNTIME`：GPT/Codex=`codex`，Claude/GLM/Grok=`claude`。Claude 路径还会把 Fable/Opus/Sonnet/Haiku 四种 alias 全部锁到飞书当前选择的真实模型，所以 GSD 子 agent 不会跨 provider 或按 tier 偷换模型。

初始化后的根 `.planning/` 是稳定目录；每个 `.planning/workstreams/<slug>` 在 Unix 使用 symlink、Windows 使用 junction 指向 `.gsd/<slug>/.planning/`，共享 `.planning/PROJECT.md` 与 `.gsd/PROJECT.md` 是同一硬链接文件。TRACKER 只列未完成任务，不保存当前会话选择。

---
name: yiui-gsd
description: 用白话驱动通用 GSD 多任务工作流；负责 .gsd 任务仓库、TRACKER 跟踪、.planning bridge（symlink/junction）切换，以及白话到 gsd-* 命令的路由。用户说启动、切换、进度、继续任意 GSD 任务时必须触发，AutoUI 只是其上的一个专用分支。
---

# yiui-gsd - GSD 白话入口

## 何时使用

- 用户用白话描述 GSD 任务：启动、切换、暂停、完成、查进度、继续、列出任务
- 用户说「gsd 任务」「开新任务」「当前 gsd 到哪了」等，不要求用户记 `$gsd-*` 命令
- 新对话或上下文压缩后需要恢复 GSD 状态时（配合 AGENTS.md GSD 会话引导）
- 任何会创建、修改 `.gsd/`、`TRACKER.md`、项目根 `.planning/` bridge 的操作
- 用户说「用 AUTOUI 做…」「UI 全自动…」「继续 AutoUI」等（见 `extra-phrase-map.md` AutoUI 段）

## 固定认知

- Codex 官方 `gsd-*` skills 由 GSD 安装器统一管理在 `~/.agents/skills/gsd-*`；项目 `.agents/skills/` 只保留 `yiui-gsd`、`yiui-auto-ui` 等项目定制 skill
- GSD Core workflow、reference、template 与 CLI 固定从 `~/.codex/gsd-core/` 加载；Codex Agent 配置固定在 `~/.codex/agents/gsd-*`
- 当前安装版本以 `~/.codex/gsd-core/VERSION` 为准；稳定通道使用 `$gsd-update`，1.7 RC/next 通道使用 `$gsd-update --next`
- 禁止把全局 `gsd-*` 复制回项目 `.agents/skills/`，也禁止继续引用旧的 Claude GSD2 安装路径
- GSD 原生 workflow 只认**项目根** `.planning/`；多任务 canonical 存储在 `.gsd/{task-slug}/.planning/`
- 活跃任务运行时：项目根 `.planning/` 必须是 **bridge**（macOS/Linux symlink，Windows junction），指向 `.gsd/{active-task-slug}/.planning/`；脚本语义必须与 `src/gsd-bridge.ts` 一致
- Feishu/Lodestar daemon 在使用 GSD 面板时拥有 `TRACKER.md` 变更所有权；脚本与 skill 不得与面板写路径冲突
- `.gsd/` 是**独立本地 git 仓库**，不进 projectx 主仓库 git
- 全局跟踪入口：`.gsd/TRACKER.md`（新对话必须先读）
- 同时只允许 **1 个**「运行中」任务；切换前将旧任务标为「已暂停」
- 不采用 GSD 原生 `$gsd-workstreams`；本 skill 自建多任务模型，底层仍调用标准 `$gsd-discuss-phase` 等命令
- Codex 主任务模型与推理强度始终由用户当前会话决定；本 skill 只固定 GSD 子 agent 的质量策略

## 优先级

```text
et-* / yiui-* 硬规则 > yiui-gsd 流程编排 > 原生 gsd-* 执行
```

## 默认流程

1. **首次使用前**：若不存在 `.gsd/.git`，在项目根执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs init-gsd-repo --project-root .`。PowerShell 文件仅是兼容包装层。
2. **每次 GSD 相关操作前**：读取 `.gsd/TRACKER.md`，确认当前活跃任务与状态。
   - 当前会话暴露 `update_plan` 时，紧接着执行“Codex App 原生计划镜像”同步；App 计划栏不得成为第二状态源。
3. **识别用户白话意图**：对照本 skill 同目录下 `extra-phrase-map.md` 路由到具体动作。
4. **需要切换活跃任务时**：在项目根执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs switch-active-task --task-slug <slug> --project-root .`。
5. **执行底层 GSD 命令**：由 agent 内部调用对应 `$gsd-*` skill，**禁止**要求用户手写 `$gsd-*`；向用户用中文回报阶段名（如「正在进入计划阶段」）。
6. **变更 TRACKER / TASK.md 后**：在项目根执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs gsd-local-commit --message "<message>" --project-root .` 提交到 `.gsd` 本地 git。

## Codex 子 agent 质量与存活策略

- 首次执行 GSD 子 agent 前，读取并执行 `extra-codex-agent-policy.md`。
- GSD 子 agent 统一使用 `gpt-5.6-sol`：light 使用 `medium`，standard / heavy 使用 `high`；无法判断复杂度时使用 `high`。
- 不限制子 agent 数量；独立任务尽量并行，禁止重复派发同一范围。顺序执行仍必须使用最小上下文启动，让子 agent 自行读取指定文件并只返回紧凑结论。
- 等待超时只触发存活性检查，不代表子 agent 失败；仍在工作的 agent 必须继续等待，禁止仅因超时重启或重复派发。
- 禁止 30-60 秒短轮询。正常等待窗口为 10-15 分钟；复杂任务可等待到全局 30 分钟诊断点，之后按状态和进展证据决定继续等待或处理卡死。
- GSD 更新后必须重新应用并验证本 skill 的 Codex agent 策略；不得把安装器生成的 TOML 当作长期事实源。

## 会话恢复（与 AGENTS.md 一致）

| 场景 | 行为 |
|------|------|
| **新对话开始** | 读 `TRACKER.md`；若状态为「运行中」或「已暂停」且有 `task_slug`，**询问**用户是否继续（展示任务名、阶段、简述） |
| **同会话上下文压缩后** | 读 `TRACKER.md` + `.gsd/{active}/.planning/STATE.md`，**自动继续**当前 GSD，不再重复询问 |
| **无活跃任务** | 不主动跑 GSD，正常对话 |

## Codex App 原生计划镜像

Codex App 的计划栏是 GSD 状态的**只读镜像**，不属于 GSD canonical 状态。GSD 的唯一事实源仍是：

```text
.gsd/TRACKER.md -> 活跃 TASK.md -> 活跃 .planning/STATE.md -> PLAN/SUMMARY/验证证据
```

### 固定同步流程

1. 在项目根执行本 skill 同目录下：

   ```bash
   node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs render-codex-plan --project-root .
   ```

2. 解析脚本输出的 JSON；若当前会话存在 `update_plan`，将 `plan` 数组原样传给 `update_plan`，并使用输出的 `explanation`。
3. 若输出 `diagnostics` 非空，先报告并修复 GSD 磁盘状态漂移；禁止通过重排 App 计划掩盖漂移。
4. `update_plan` 不可用时继续执行 GSD；禁止为了显示进度修改、降级或重建 GSD 状态。

### 映射规则

- `STATE.md progress.completed_plans` 之前的计划映射为 `completed`。
- 当前未完成计划映射为唯一 `in_progress`；任务暂停时所有未完成计划映射为 `pending`。
- 后续计划映射为 `pending`。
- 当前计划步骤追加 `STATE.md` 单向执行游标中第一个非 `GREEN / 已验证` 的固定游标 ID，例如 `[GSD 04/F]`。
- App 只显示当前 GSD 任务的 Plan 层；RED/GREEN/已验证子项和完整证据继续只保存在 `STATE.md`。
- 固定 Plan 编号不得因上下文压缩而重新编号、合并或删除。新增计划只能先写入 GSD 计划文件与 STATE，再重新投影。

### 强制同步时机

- 创建、切换、恢复或继续 GSD 任务后。
- 每次 `STATE.md` / `TRACKER.md` 更新并完成 `.gsd` 本地提交后。
- 每个 Plan 完成、phase 推进、暂停、恢复或任务完成后。
- **同会话上下文压缩后：必须先从磁盘重建 App 计划栏，再执行唯一下一动作。**

只有主编排 agent 可以更新 App 计划栏。Planner、executor、reviewer 等子 agent 禁止调用 `update_plan`；它们只返回结果，由主编排 agent 持久化 GSD 状态后统一同步。活跃 GSD 期间禁止创建独立于 GSD 的原生计划。

## 创建新任务（概要）

1. 从用户白话提取任务名称，生成 `task-slug`（小写 kebab-case；冲突追加 `-2`、`-3`…）。规则见 `extra-tracker-schema.md`。
2. 创建 `.gsd/{task-slug}/TASK.md` 与空目录 `.gsd/{task-slug}/.planning/`。
3. 若已有「运行中」任务，先将其 TASK.md 与 TRACKER 索引标为「已暂停」。
4. 运行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs switch-active-task --task-slug <slug> --project-root .` 指向新任务。
5. 更新 `TRACKER.md`（状态=运行中，阶段=unknown 或 discuss）。
6. `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs gsd-local-commit --message "gsd(<slug>): 创建任务" --project-root .` 提交。
7. 成熟老项目首次建立 GSD planning workspace 时优先执行 `$gsd-onboard`；只需要刷新代码图谱时执行 `$gsd-map-codebase`；已有完整 planning 基线时进入 `$gsd-discuss-phase 1` 并附带用户描述。

## 创建 AutoUI 任务（GSD 专用分支）

用户触发 `yiui-auto-ui` 时：

> AutoUI 不是独立于 GSD 的另一套编排，而是 GSD 上叠加的 UI 专用规则；只要用户说“执行 AutoUI / 用 AUTOUI 做 / 做这个 UI”，即使没有明确说“长任务”或“注意上下文压缩”，也按长任务处理。

1. 生成 `task-slug`（建议含 `-autoui`）。
2. **仅**执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs bootstrap-autoui-task --task-slug … --task-name … --user-brief … --project-root .`（命令原子完成：暂停旧运行中任务、TASK、evidence/milestones/notes、PROJECT 种子、TRACKER、planning bridge、`.gsd` commit）。
3. 叠加 [`yiui-auto-ui`](../yiui-auto-ui/SKILL.md)：**discuss 必须先跑完 [`extra-ui-spec-intake.md`](../yiui-auto-ui/extra-ui-spec-intake.md)**，再读 strategies / learnings。
4. `$gsd-discuss-phase 1`。

**禁止**用 generic 创建流程替代 bootstrap；禁止只建 TASK 不写 TRACKER。

调用顺序：`yiui-gsd` 先接住通用 GSD 入口 → AutoUI 任务再走 bootstrap → `yiui-auto-ui` 规范 → `gsd-*` 执行。

## 进度查询（概要）

1. 读 `TRACKER.md` 与 `.gsd/{active}/.planning/STATE.md`（若存在）。
2. 按“Codex App 原生计划镜像”同步 `update_plan`（当前会话可用时）。
3. 用中文摘要：任务名、当前 phase、下一步建议、最后更新时间。
4. 用户要求继续时，先确认 TRACKER 与 planning bridge，再使用 `$gsd-progress --next` 推进；用户只要求查看可选动作时使用 `$gsd-next`。
5. 若无活跃任务，明确回答「当前没有进行中的 GSD 任务」。

## 终验代际门禁

1. 固定收口顺序：实现完成 → 阻断级审查收敛 → 冻结范围 → 最终验收一次 → 完成。
2. 进入收口前，按 `extra-finalization-gate.md` 在活跃 `STATE.md` 维护 `finalization`；缺字段不得靠聊天上下文补猜。
3. 最终验收前执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs assert-finalization-gate --state-path .planning/STATE.md`。只有审查代际等于变更代际、范围已冻结且阻断项为零才允许继续。
4. 一个单调子游标内的交付物变更批次只增加一次 `change_generation`。产生新变化后，旧审查与旧终验自动失效；修复终验失败也必须进入新代际。
5. 只有违反当前 `TASK.md` 完成标准的 Critical / Important 才阻断。Moderate / Minor、额外强化与范围外改进进入延后清单。
6. GREEN / 已验证只能凭新鲜、可复现失败证据重开，并记录 `reopen_reason`。一次最终审查新增超过 3 个独立阻断项时，暂停当前收口并拆分新 GSD。
7. 同一代际的有效最终验收只运行一次；未形成测试结果的基础设施故障不计次数，但必须记录原因。验收失败后的修复属于新代际，不得直接重跑旧代际。

## 跨设备首次安装（Lodestar 仓库）

其它机器 checkout lodestar 后，项目 skill 已在 `.agents/skills/yiui-gsd`，但全局 GSD 运行时不会随主仓 git 走。在 **lodestar 仓库根** 执行：

```bash
bash install/yiui-gsd/install.sh
bash install/yiui-gsd/verify.sh
```

Windows / pwsh：`install/yiui-gsd/install.ps1` 与 `verify.ps1`。可选 `--channel next`、`--init-gsd`、`--apply-agent-policy`、`--project <其它工程>`。说明见 `install/yiui-gsd/README.md`。

## GSD 更新

1. 读取 `~/.codex/gsd-core/VERSION` 和 npm dist-tag，区分稳定版 `latest` 与预发布版 `next`。
2. 首次安装或全局 `$gsd-update` 不存在时，优先用仓库 `install/yiui-gsd/install.sh`（或 `.ps1`）；也可直接 `npx --yes @opengsd/gsd-core@next --codex --global`（稳定版把 `@next` 改为 `@latest`）。
3. 已安装时，稳定版执行 `$gsd-update`；用户明确要求 1.7 RC/最新版预发布时执行 `$gsd-update --next`。
4. 更新后验证 `~/.agents/skills/gsd-*`、`~/.codex/gsd-core/`、`~/.codex/agents/gsd-*` 和 hooks，确认项目 `.agents/skills/` 下没有官方 `gsd-*`；也可用 `bash install/yiui-gsd/verify.sh`。
5. 执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy`，再用 `--verify-only` 复验模型、推理强度与 Flex 清理结果；生成文件只允许由该命令幂等重放，禁止手工逐个维护。
6. 对照新版命令更新本 skill 的白话映射；不得直接维护安装器生成的官方 `gsd-*` 文件。
7. Codex 需要在新任务中重新发现全局 skills；当前任务只做文件与配置验证，不把“文件已安装”等同于“当前任务已热加载”。

## 按需补读

- 白话意图与 `$gsd-*` 映射：读取本 skill 同目录下的 `extra-phrase-map.md`
- `TRACKER.md` / `TASK.md` 字段与更新规则：读取本 skill 同目录下的 `extra-tracker-schema.md`
- 终验字段、代际推进和收口门禁：读取本 skill 同目录下的 `extra-finalization-gate.md`
- Planning bridge 切换步骤（symlink / junction）：读取本 skill 同目录下的 `extra-junction-bridge.md`
- Codex 子 agent 模型、等待、上下文边界与更新重放：读取本 skill 同目录下的 `extra-codex-agent-policy.md`

## 禁止事项

- 禁止把 `.gsd/` 提交进 projectx 主仓库
- 禁止修改原生 `gsd-*` skill 文件；只在本 skill 层编排
- 禁止在项目 `.agents/skills/` 保留原生 `gsd-*` 副本
- 禁止让用户记忆或手写 `$gsd-*` 命令
- 禁止在未更新 `TRACKER.md` 的情况下切换活跃任务
- 禁止同时标记多个任务为「运行中」
- 禁止把 App 原生计划栏当作 GSD 状态源，或让子 agent 独立重建/改写该计划栏
- 禁止最终验收后再做常规设计终审，或在同一代际重复运行最终验收

---
name: yiui-gsd
description: 用白话驱动通用 GSD 多任务工作流；负责 .gsd 任务仓库、未完成任务 TRACKER、.planning workstream 路由，以及白话到 gsd-* 命令的映射。用户说创建、切换、暂停、完成、查询、继续或并行任意 GSD 任务时必须触发，AutoUI 只是其上的一个专用分支。
---

# yiui-gsd - GSD 白话入口

## 何时使用

- 用户用白话描述 GSD 任务：启动、切换、暂停、完成、查进度、继续、列出任务
- 用户说「gsd 任务」「开新任务」「当前 gsd 到哪了」等，不要求用户记 `$gsd-*` 命令
- 新对话或上下文压缩后需要恢复 GSD 状态时（配合 AGENTS.md GSD 会话引导）
- 任何会创建、修改 `.gsd/`、`TRACKER.md`、项目根 `.planning/` workstream 路由的操作
- 用户说「用 AUTOUI 做…」「UI 全自动…」「继续 AutoUI」等（见 `extra-phrase-map.md` AutoUI 段）

## 固定认知

- Codex 官方 `gsd-*` skills 由 GSD 安装器统一管理在 `~/.agents/skills/gsd-*`；项目 `.agents/skills/` 只保留 `yiui-gsd`、`yiui-auto-ui` 等项目定制 skill
- GSD Core workflow、reference、template 与 CLI 按当前 runtime 加载：Codex=`~/.codex/gsd-core/`，Claude/GLM/Grok=`~/.claude/gsd-core/`；对应 agent 分别在 `~/.codex/agents/gsd-*` 与 `~/.claude/agents/gsd-*`
- 当前安装版本需同时核对 `~/.codex/gsd-core/VERSION` 和 `~/.claude/gsd-core/VERSION`；稳定通道使用 `$gsd-update`，预发布通道使用 `$gsd-update --next`
- 禁止把全局 `gsd-*` 复制回项目 `.agents/skills/`，也禁止继续引用旧的 Claude GSD2 安装路径
- GSD 原生 workflow 通过 `--ws <task-slug>` 解析**项目根** `.planning/workstreams/{task-slug}/`；多任务 canonical 存储在 `.gsd/{task-slug}/.planning/`
- 项目根 `.planning/` 是稳定路由目录；`.planning/workstreams/{task-slug}` 在 Unix 使用 symlink、Windows 使用 junction，指向 `.gsd/{task-slug}/.planning/`
- `.gsd/PROJECT.md` 是所有任务共享的项目级上下文，项目根 `.planning/PROJECT.md` 是它的硬链接；任务专属目标与游标不得写入共享 PROJECT
- `.gsd/` 是**独立本地 git 仓库**，不进 projectx 主仓库 git
- 全局跟踪入口：`.gsd/TRACKER.md`（新对话必须先读），只列 `运行中` / `已暂停` 的未完成任务
- 允许多个任务同时为「运行中」；状态只描述任务是否允许推进，不记录由哪个 AI 执行
- 本 skill 自建任务生命周期与 TRACKER；只复用 GSD 原生 workstream 的 `--ws` 路径隔离和 session-local 选择，不把 `$gsd-workstreams` 清单当作任务事实源
- 当前会话选择与任务状态分离；切换只绑定当前会话，不暂停其他运行中任务
- 主任务 provider/model/推理强度始终由用户当前飞书会话决定；GSD 子 agent 必须继承同 provider/model，禁止跨模型编排

## 优先级

```text
et-* / yiui-* 硬规则 > yiui-gsd 流程编排 > 原生 gsd-* 执行
```

## 默认流程

1. **首次使用前**：若不存在 `.gsd/.git`，在项目根执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs init-gsd-repo --project-root .`。
2. **每次 GSD 相关操作前**：读取 `.gsd/TRACKER.md`，确认目标 task_slug 与状态。
   - 当前会话暴露 `update_plan` 时，紧接着执行“Codex App 原生计划镜像”同步；App 计划栏不得成为第二状态源。
3. **识别用户白话意图**：对照本 skill 同目录下 `extra-phrase-map.md` 路由到具体动作。
   - 创建任务、进入讨论/计划阶段、处理“小改动/快速修一下”或用户要求自动推进时，必须先读取本 skill 同目录下的 `extra-planning-efficiency.md`，按其中的轻量/标准/重型条件选择路径。
4. **需要创建、继续或切换任务时**：执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs switch-active-task --project-root . --task-slug <slug>`，建立 workstream 路由、把目标任务恢复为运行中并设置当前会话 workstream；禁止改动其他任务状态。
5. **执行底层 GSD 命令**：由 agent 内部调用对应 `$gsd-*` skill，并始终追加 `--ws <task-slug>`；**禁止**要求用户手写 `$gsd-*`，向用户只回报中文阶段名。
6. **变更 TRACKER / TASK.md 后**：执行 Node helper 的 `update-gsd-tracker` 更新聚合表，再执行 `gsd-local-commit --task-slug <slug> --message "<message>"`；禁止 `git add -A` 把其他任务一起提交。

## 多任务状态与并行边界

- `运行中`：任务未暂停，允许任一已选择该 task_slug 的会话推进；不代表 AI 所有权或进程存活。
- `已暂停`：任务保留在 TRACKER，但任何会话都不得自动推进；用户说继续/切换到该任务时恢复为运行中。
- `已完成`：先完成终验与状态落盘，再从 TRACKER 未完成表删除；保留任务目录与 `.gsd` Git 历史，禁止把“从 TRACKER 删除”理解为删除证据。
- 同一 task_slug 同时只允许一个写入者。不同 task_slug 的 planning 状态由 `--ws` 隔离，但共享项目源码和 Unity/服务进程仍可能冲突；修改范围重叠时必须串行或使用独立 Git worktree。
- TRACKER、共享 PROJECT 与 `.gsd` Git 是共享写点。所有 TRACKER 更新走 Node helper 的 `update-gsd-tracker` 文件锁，所有本地提交走 `gsd-local-commit` 提交锁和 `TRACKER.md + task_slug` 限域；只有当前操作明确修改共享项目上下文时才传 `--include-shared-project`。
- 暂停或完成任务统一执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs set-gsd-task-status --project-root . --task-slug <slug> --status 已暂停|已完成`；完成操作内置 `--require-completed` 等价门禁。

## 规划效率与质量门禁

- 主编排 agent 只负责路由、状态持久化和结果收口，禁止在 `gsd-planner` 之外再独立生成一套实现计划或重复运行完整规划推理。
- 轻量阶段只能按 `extra-planning-efficiency.md` 的全部条件跳过研究；`gsd-planner` 与 `gsd-plan-checker` 仍然保留，禁止为了提速默认使用 `--skip-verify`。
- 已有覆盖当前范围且未被代码/需求变化失效的 `RESEARCH.md` 时直接复用，禁止无新问题地重复研究。
- `gsd-plan-review-convergence`、`gsd-ultraplan-phase`、`gsd-review` 与 plan `--bounce` 会离开当前飞书 provider/model，在 Lodestar 场景中一律禁用。`gsd-spec-phase`、discuss `--power`、`gsd-autonomous`、plan `--chunked` 与 quick `--full` 仍是显式重型入口，只有用户明确要求或当前 `TASK.md` / 阶段证据明确要求时才能启用。
- 本项目的 GSD canonical 状态位于独立 `.gsd` 仓库，且禁止自动提交项目 Git；不得把官方 `gsd-fast` / `gsd-quick` 当作活跃 GSD 的自动降级路径。非 GSD 的简单修改退出本 skill，按项目普通任务规则直接处理；活跃 GSD 内的小改动继续服从当前 `STATE.md` 单调游标。
- 不通过修改官方 GSD Core、官方 `gsd-*` skills 或安装器生成的 agent TOML 实现提速；更新持久性以项目 `yiui-gsd` 定制层和策略重放脚本为准。

## GSD 子 agent 质量与存活策略

- 首次执行 GSD 子 agent 前，读取并执行 `extra-codex-agent-policy.md`。
- GPT/Codex 会话的 GSD 子 agent 统一使用 `gpt-5.6-sol`：light 使用 `medium`，standard / heavy 使用 `high`；Claude/GLM/Grok 会话的 GSD 子 agent 统一继承飞书当前选定模型，不得按 tier 换模型。
- Lodestar spawn 必须按飞书 provider 设置 `GSD_RUNTIME=codex|claude`；Claude runtime 的四种模型 alias 与 agent frontmatter 必须锁为当前模型 / `inherit`。
- 飞书 continue/new 必须把目标 workstream 的 `runtime` 锁到当前 provider、使用 `model_profile=inherit`、清空所有显式/动态模型覆写，关闭 planner 前的 `pattern_mapper`、checker 后的非阻断 `post_planning_gaps` 与 `thinking_partner` 二次分析，显式关闭 GSD 1.8 的 `claude_orchestration`，并写入 30 分钟子 agent 诊断窗口；其它 workstream 配置保持不变。
- 只派发当前阶段不可替代的 GSD 职责；单个 PLAN 不超过两个任务时按 GSD 1.8 原地执行，不启动 executor 子 agent。更大计划按真实依赖决定并行度，禁止为制造并行而拆小任务或重复派发同一范围；顺序子 agent 使用最小上下文并只返回紧凑结论。
- 等待超时只触发存活性检查，不代表子 agent 失败；仍在工作的 agent 必须继续等待，禁止仅因超时重启或重复派发。
- 禁止 30-60 秒短轮询。正常等待窗口为 10-15 分钟；复杂任务可等待到全局 30 分钟诊断点，之后按状态和进展证据决定继续等待或处理卡死。
- GSD 更新后必须重新应用并验证本 skill 的 Codex agent 策略；不得把安装器生成的 TOML 当作长期事实源。

## 会话恢复（与 AGENTS.md 一致）

| 场景 | 行为 |
|------|------|
| **新对话开始** | 读 `TRACKER.md`；用户已点名任务时直接绑定，只有一个未完成任务时展示并询问是否继续，多个未完成任务时列出状态/阶段/简述并询问选择 |
| **同会话上下文压缩后** | 从 session-local workstream 或本会话已知 task_slug 恢复，读对应 TASK/STATE，**自动继续**当前 GSD，不再重复询问 |
| **无未完成任务** | 不主动跑 GSD，正常对话 |

## Codex App 原生计划镜像

Codex App 的计划栏是 GSD 状态的**只读镜像**，不属于 GSD canonical 状态。GSD 的唯一事实源仍是：

```text
.gsd/TRACKER.md -> 当前会话 task_slug/TASK.md -> task_slug/.planning/STATE.md -> PLAN/SUMMARY/验证证据
```

### 固定同步流程

1. 在项目根执行本 skill 同目录下：

   ```bash
   node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs render-codex-plan --project-root . --task-slug <task-slug>
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
2. 执行 Node helper 的 `new-gsd-task --project-root . --task-slug … --task-name … --summary …`；helper 创建 TASK/canonical planning、建立 workstream 路由、绑定当前会话、重建 TRACKER 并限域提交。
3. 保留其他任务原状态，禁止因为创建新任务自动暂停旧任务。
4. 脚本完成后从新任务进入 GSD 原生流程；底层调用始终附带 `--ws <task-slug>`。
7. 成熟老项目首次建立 GSD planning workspace 时优先执行 `$gsd-onboard`；只需要刷新代码图谱时执行 `$gsd-map-codebase`；已有完整 planning 基线时进入 `$gsd-discuss-phase 1` 并附带用户描述。

## 创建 AutoUI 任务（GSD 专用分支）

用户触发 `yiui-auto-ui` 时：

> AutoUI 不是独立于 GSD 的另一套编排，而是 GSD 上叠加的 UI 专用规则；只要用户说“执行 AutoUI / 用 AUTOUI 做 / 做这个 UI”，即使没有明确说“长任务”或“注意上下文压缩”，也按长任务处理。

1. 生成 `task-slug`（建议含 `-autoui`）。
2. **仅**执行 Node helper 的 `bootstrap-autoui-task --project-root . --task-slug … --task-name … --user-brief …`（helper 在 TASK 中记录 AutoUI 初始范围，创建 evidence/milestones/notes、TRACKER、workstream 路由与 `.gsd` commit，不改共享 PROJECT 和其他任务状态）。
3. 叠加 [`yiui-auto-ui`](../yiui-auto-ui/SKILL.md)：**discuss 必须先跑完 [`extra-ui-spec-intake.md`](../yiui-auto-ui/extra-ui-spec-intake.md)**，再读 strategies / learnings。
4. `$gsd-discuss-phase 1`。

**禁止**用 generic 创建流程替代 bootstrap；禁止只建 TASK 不写 TRACKER。

调用顺序：`yiui-gsd` 先接住通用 GSD 入口 → AutoUI 任务再走 bootstrap → `yiui-auto-ui` 规范 → `gsd-*` 执行。

## 进度查询（概要）

1. 读 `TRACKER.md`；查询全部任务时逐项读取对应 STATE，查询当前任务时读取当前会话 task_slug 的 STATE。
2. 按“Codex App 原生计划镜像”同步 `update_plan`（当前会话可用时）。
3. 用中文摘要：任务名、当前 phase、下一步建议、最后更新时间。
4. 用户要求继续/切换某任务时先运行 Node helper 的 `switch-active-task`，再使用带 `--ws <task-slug>` 的进度命令推进；用户只查看时不得改变其他任务状态。
5. 若 TRACKER 为空，明确回答「当前没有未完成的 GSD 任务」；若只是当前会话未选择任务，则列出未完成任务供选择。

## 终验代际门禁

1. 固定收口顺序：实现完成 → 阻断级审查收敛 → 冻结范围 → 最终验收一次 → 完成。
2. 进入收口前，按 `extra-finalization-gate.md` 在目标任务的 `STATE.md` 维护 `finalization`；缺字段不得靠聊天上下文补猜。
3. 最终验收前执行 Node helper 的 `assert-finalization-gate --project-root . --task-slug <task-slug>`。只有审查代际等于变更代际、范围已冻结且阻断项为零才允许继续。
4. 一个单调子游标内的交付物变更批次只增加一次 `change_generation`。产生新变化后，旧审查与旧终验自动失效；修复终验失败也必须进入新代际。
5. 只有违反当前 `TASK.md` 完成标准的 Critical / Important 才阻断。Moderate / Minor、额外强化与范围外改进进入延后清单。
6. GREEN / 已验证只能凭新鲜、可复现失败证据重开，并记录 `reopen_reason`。一次最终审查新增超过 3 个独立阻断项时，暂停当前收口并拆分新 GSD。
7. 同一代际的有效最终验收只运行一次；未形成测试结果的基础设施故障不计次数，但必须记录原因。验收失败后的修复属于新代际，不得直接重跑旧代际。

## GSD 更新

1. 读取 `~/.codex/gsd-core/VERSION`、`~/.claude/gsd-core/VERSION` 和 npm dist-tag，区分稳定版 `latest` 与预发布版 `next`。
2. 首次安装或全局 `$gsd-update` 不存在时，预发布版使用 `npx --yes @opengsd/gsd-core@next --codex --claude --global`；稳定版把 `@next` 改为 `@latest`。
3. 已安装时，稳定版执行 `$gsd-update`；用户明确要求最新版预发布时执行 `$gsd-update --next`。
4. 更新后验证 Codex 与 Claude 两套 core/skills/agents/hooks，确认项目 `.agents/skills/` 下没有官方 `gsd-*`。
5. 对 `codex`、`claude` 分别执行 Node helper 的 `apply-agent-policy --runtime <runtime>`，再用 `--verify-only` 复验模型、推理强度与 Flex/继承策略；生成文件只允许由该 helper 幂等重放，禁止手工逐个维护。
6. 对照新版命令复核本 skill 的白话映射与 `extra-planning-efficiency.md`，确认轻量判定、重型入口授权和官方更新边界仍有效；不得直接维护安装器生成的官方 `gsd-*` 文件。
7. Codex 需要在新任务中重新发现全局 skills；当前任务只做文件与配置验证，不把“文件已安装”等同于“当前任务已热加载”。

## 按需补读

- 白话意图与 `$gsd-*` 映射：读取本 skill 同目录下的 `extra-phrase-map.md`
- 创建任务、讨论/计划、自动推进或判断轻重路径：读取本 skill 同目录下的 `extra-planning-efficiency.md`
- `TRACKER.md` / `TASK.md` 字段与更新规则：读取本 skill 同目录下的 `extra-tracker-schema.md`
- 终验字段、代际推进和收口门禁：读取本 skill 同目录下的 `extra-finalization-gate.md`
- 跨平台 workstream 路由步骤：读取本 skill 同目录下的 `extra-junction-bridge.md`
- Codex 子 agent 模型、等待、上下文边界与更新重放：读取本 skill 同目录下的 `extra-codex-agent-policy.md`

## 禁止事项

- 禁止把 `.gsd/` 提交进 projectx 主仓库
- 禁止修改原生 `gsd-*` skill 文件；只在本 skill 层编排
- 禁止在项目 `.agents/skills/` 保留原生 `gsd-*` 副本
- 禁止让用户记忆或手写 `$gsd-*` 命令
- 禁止在未重建 `TRACKER.md` 的情况下切换当前会话任务
- 禁止把当前会话选择写成全局唯一任务，或在切换时自动暂停其他运行中任务
- 禁止调用底层 GSD 时遗漏 `--ws <task-slug>`，或让两个写入者同时推进同一 task_slug
- 禁止把 App 原生计划栏当作 GSD 状态源，或让子 agent 独立重建/改写该计划栏
- 禁止最终验收后再做常规设计终审，或在同一代际重复运行最终验收

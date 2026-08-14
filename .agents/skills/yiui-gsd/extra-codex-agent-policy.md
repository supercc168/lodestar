# GSD 子 agent 分层模型策略

## 固定质量策略

- 主任务模型与推理强度继承用户当前飞书会话，禁止修改用户全局 Codex/Claude 主模型设置。
- 飞书选择 GPT/Codex 时：`GSD_RUNTIME=codex`；**主会话保持 `gpt-5.6-sol` + `max`**（深思路径，不降）。
- 飞书选择 Claude 第一方登录档时，GSD 按官方 catalog tier 使用最新组合：heavy/`opus`=`claude-opus-5`，standard/`sonnet`=`claude-fable-5`，light/`haiku`=`claude-sonnet-5`，`fable` alias=`claude-fable-5`。
- 飞书选择 GLM、Grok 或其它第三方 API 路由时，Fable/Opus/Sonnet/Haiku 四个 alias 必须全部锁回当前选中的真实模型，禁止官方 Claude id 泄漏到第三方端点。
- 禁止跨 provider、外部 AI CLI 或跨 AI review；用户选 Claude 只走 Anthropic 登录态，选 GLM 只走 GLM，选 Grok 只走 Grok。
- **禁止 `ultra`、`service_tier=flex`**。深思路径用 `max`，不用模型内多智能体的 `ultra`。
- Claude runtime 的 agent frontmatter 必须按 catalog `adaptiveTierMap` 写入 `opus` / `sonnet` / `haiku`。

## Codex 分层（Phase B 已落地）

原则：**该深思的用 Sol+max；不该深思的别占旗舰。**

| 档位 | 模型 | effort | 范围 |
|------|------|--------|------|
| **D0 深思核** | `gpt-5.6-sol` | **`max`** | catalog `heavy` 全员；`gsd-executor` / `gsd-verifier` / `gsd-code-reviewer` / `gsd-code-fixer` |
| **D1 研究核** | `gpt-5.6-sol` | **`max`** | `gsd-phase-researcher`（规划上游事实源） |
| **D2 外围 standard** | `gpt-5.6-terra` | **`high`** | 其余 standard：外围 researcher、doc-writer/synthesizer、eval-auditor 等 |
| **D3 轻量** | `gpt-5.6-luna` | **`medium`** | catalog `light` 全员（含 `gsd-plan-checker`、mapper、各类 checker） |
| **未知 agent** | `gpt-5.6-sol` | **`max`** | 失败安全，偏质量 |

D0/D1 白名单双写：除静态 TOML bake 外，还写入 `~/.gsd/defaults.json` 的
`model_overrides`（executor/verifier/code-reviewer/code-fixer/phase-researcher
→ `gpt-5.6-sol`）。GSD 1.9 运行时 adaptive 解析先于 tier 映射命中
`model_overrides`，白名单不再只存在于静态文件（此前这五个 catalog
routingTier 为 standard 的深思核 agent 在运行时被解析到 sonnet→terra）。

### 临时 generic explorer / worker

- 纯读取、机械扫描 → Luna + `medium`
- 代码修改、规划、调试、审查、验证或不确定 → Sol + **`max`**

### 演进记录

- Phase A：light → Luna+medium；深思核 → Sol+max；外围 standard 仍 Sol+high
- Phase B：外围 standard → Terra+high；D0/D1/主会话仍 Sol+max
- Phase C（当前）：D0/D1 白名单双写到 `defaults.json.model_overrides`（运行时
  adaptive 解析生效，不再只靠静态 TOML）；新增只读 `check-policy` 命令，daemon
  在 codex 会话 GSD 注入前执行，漂移时在注入提示渲染自愈告警

## 应用与验证

在项目根或任意目录执行（Node.js >= 18；不依赖 pwsh）：

```bash
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime codex
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime codex --verify-only
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs check-policy --runtime codex   # 只读一致性检查,漂移 exit 1
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime claude
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime claude --verify-only
```

脚本负责：

- 合并 `~/.gsd/defaults.json`，保留无关键。
- Codex defaults：`runtime=codex`、`model_profile=adaptive`；`model_profile_overrides.codex` 为 opus=`gpt-5.6-sol`、sonnet=`gpt-5.6-terra`、haiku=`gpt-5.6-luna`；`effort.default=max`，`routing_tier_defaults` 为 light=`medium`、standard/heavy=`max`；D2 外围 agent 写入 `effort.agent_overrides=high`。Lodestar 子进程的 `GSD_RUNTIME` 按飞书 provider 覆盖该持久默认。
- 同时设置兼容投影与 GSD 1.8 canonical 路径的 `subagent_timeout=1800000`；飞书 continue/new 还会在当前 workstream 写入 `workflow.subagent_timeout=1800000`，避免项目配置遮住全局值。
- 固定 `workflow.inline_plan_threshold=2`：单个 PLAN 不超过两个任务时由当前 agent 原地执行，省去 executor 子 agent 的启动和报告往返；更复杂计划仍走隔离 agent。
- 强制关闭自动外部链路：`workflow.plan_bounce=false`、`workflow.plan_review_convergence=false`、`workflow.cross_ai_execution=false`、`workflow.code_review_command=null`；同时关闭非核心顺序开销：`workflow.pattern_mapper=false`、`workflow.post_planning_gaps=false`；GSD 1.8 的 `claude_orchestration.enabled=false` 且 `execution_backend=inline`；保留其它无关键。
- 飞书 workstream 额外锁定 `runtime`；Claude 使用 `model_profile=adaptive` + `resolve_model_ids=false`，确保 resolver 返回 alias 而不是 catalog 内可能过期的完整 ID；Codex 使用 `model_profile=inherit` + `resolve_model_ids=omit`。同时清空 `model_overrides`、`models`、`dynamic_routing`、`model_profile_overrides`、`model_policy`，关闭 `features.thinking_partner`，并再次锁闭 `claude_orchestration`。这样可防止旧项目配置绕过当前策略，也不会在 planner 前额外派 pattern mapper、在 checker 后追加非阻断 gap 扫描与架构分析，或启用 1.8 的嵌套 Workflow 编排。
- 按 catalog `routingTier` + 深思白名单 bake `~/.codex/agents/gsd-*.toml` 的 `model` / `model_reasoning_effort`，移除 `service_tier="flex"`。
- GSD 1.8 会用 defaults 与静态 Codex agent TOML 的 mtime 判断模型是否重新 bake；策略重放在验证全部 TOML 后统一同步其时间戳，`--verify-only` 只报告漂移、不修改文件，避免已正确锁定时反复出现无效重装告警。
- 按官方 catalog 的 `routingTier` + `adaptiveTierMap` 重放 `~/.claude/agents/gsd-*.md` 的模型 frontmatter；当前 GSD 1.8 对应 heavy=`opus`、standard=`sonnet`、light=`haiku`。
- 修改前备份 defaults 与发生变化的 Codex TOML / Claude Markdown。

首次启用、GSD 安装/更新后、或 `--verify-only` 报告漂移时执行应用模式。不要逐个手改生成文件。旧的 `.ps1` 入口会转发到同一个 Node helper。

## 并行与上下文隔离

- 不按固定数量凑 agent；单个 PLAN 不超过两个任务时原地执行，不启动 executor 子 agent。更大计划只按真实依赖决定并行度。
- 独立范围并行，有前后依赖的范围顺序执行。
- 禁止多个 agent 重复调查同一范围，除非任务明确要求独立交叉审查。
- 子 agent 默认不继承完整聊天上下文；只传职责、完成标准和必要文件入口。顺序子 agent 的主要价值是隔离大量读取与中间推理，只向主任务返回紧凑结论。
- 主编排 agent 收到 research/planner/checker 的结构化结果后只做契约检查和路由，不再完整重演同一轮头脑风暴或另写一套计划。

## 等待与卡死判断

`wait_agent` 的等待窗口不是子 agent 的完成期限。窗口到期后子 agent 仍可继续运行。

1. 禁止 30-60 秒短轮询。
2. 正常任务单次等待 10-15 分钟；已知复杂任务可直接等待到 30 分钟诊断点。
3. 等待窗口到期后只做一次状态检查：仍为 working、存在工具活动或有新进展证据时继续等待，不得重启或重复派发。
4. 连续两个诊断点都没有状态、工具、消息或产物变化时，才按疑似卡死处理；先定位阻塞点，再决定中断。
5. 主 agent 有独立工作可做时先继续该工作，不原地轮询。

`subagent_timeout=1800000` 是诊断点，不是无条件终止线。质量优先，真实执行时间可以超过该值。

## 熔断（质量回升）

- 同一 phase 内 `gsd-plan-checker` 连续 2 轮要求大改 → 该 phase 剩余 D2 agent 临时升 D0（Sol+max）。
- `gsd-verifier` 失败且像研究不足/实现跑偏 → 下轮 researcher + executor 强制 D0/D1。
- 用户说「这次全旗舰」→ 全员 D0。
- 用户说「这次尽量快」→ 仅允许压 D2/D3；**D0/D1 与主会话仍 max**。

## 上下文压缩边界

- 剩余上下文降到 35% 时，不再开启新的复杂步骤；完成当前原子步骤后持久化 STATE、TRACKER 与验证证据。
- 剩余降到 25% 时，不再开启新工作；在最近自然边界暂停，提交 `.gsd` 状态并告知用户新建 Codex 任务继续。
- 新任务通过 `$gsd-resume-work` 或用户白话“继续 GSD 任务”从磁盘恢复。它不自动压缩、不自动创建新任务。
- 如果同一任务仍发生压缩，严格执行 SKILL.md 的恢复和 App 计划镜像流程：先读磁盘状态，再执行唯一下一动作，禁止重新规划或重做 GREEN 项。

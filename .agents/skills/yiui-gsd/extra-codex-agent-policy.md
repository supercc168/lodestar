# GSD 子 agent 同模型策略

## 固定质量策略

- 主任务模型与推理强度继承用户当前飞书会话，禁止修改用户全局 Codex/Claude 主模型设置。
- 飞书选择 GPT/Codex 时，所有 GSD 子 agent 固定使用 `gpt-5.6-sol`；`GSD_RUNTIME=codex`。
- 飞书选择 Claude、GLM 或 Grok 时，所有 GSD 子 agent 继承当前选中的同一个真实模型；`GSD_RUNTIME=claude`，Fable/Opus/Sonnet/Haiku 四个 alias 必须全部锁到该模型。
- 禁止跨 provider、跨模型、外部 AI CLI 或跨 AI review；用户选 Claude 只走 Claude，选 GLM 只走 GLM，选 Grok 只走 Grok。
- 官方 `model-catalog.json` 中 `routingTier=light` 的 agent 使用 `medium`；`standard`、`heavy` 与无法识别的 GSD agent 使用 `high`。
- Codex GSD 流程内临时创建的 generic `explorer` / `worker` 也必须显式采用同一策略；纯读取、机械扫描可用 `medium`，代码修改、规划、调试、审查、验证或不确定场景使用 `high`。Claude runtime 的 agent frontmatter 统一 `model: inherit`。
- 禁止使用 `low`、`xhigh`、`ultra`，禁止把子 agent 降为 Terra 或 Luna。

## 应用与验证

在项目根或任意目录执行（Node.js >= 18；不依赖 pwsh）：

```bash
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime codex
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime codex --verify-only
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime claude
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs apply-agent-policy --runtime claude --verify-only
```

脚本负责：

- 合并 `~/.gsd/defaults.json`，保留无关键。
- Codex defaults 保留 `runtime=codex`、`model_profile=adaptive`、三档模型均为 Sol；Lodestar 子进程的 `GSD_RUNTIME` 按飞书 provider 覆盖该持久默认。
- 固定 `light=medium`、`standard/heavy=high`，并同时设置兼容投影与 GSD 1.8 canonical 路径的 `subagent_timeout=1800000`；飞书 continue/new 还会在当前 workstream 写入 `workflow.subagent_timeout=1800000`，避免项目配置遮住全局值。
- 固定 `workflow.inline_plan_threshold=2`：单个 PLAN 不超过两个任务时由当前 agent 原地执行，省去 executor 子 agent 的启动和报告往返；更复杂计划仍走隔离 agent。
- 强制关闭自动外部链路：`workflow.plan_bounce=false`、`workflow.plan_review_convergence=false`、`workflow.cross_ai_execution=false`、`workflow.code_review_command=null`；同时关闭非核心顺序开销：`workflow.pattern_mapper=false`、`workflow.post_planning_gaps=false`；GSD 1.8 的 `claude_orchestration.enabled=false` 且 `execution_backend=inline`；保留其它无关键。
- 飞书 workstream 额外锁定 `runtime` 与 `model_profile=inherit`，清空 `model_overrides`、`models`、`dynamic_routing`、`model_profile_overrides`、`model_policy`，关闭 `features.thinking_partner`，并再次锁闭 `claude_orchestration`。这样可防止旧项目配置绕过当前模型，也不会在 planner 前额外派 pattern mapper、在 checker 后追加非阻断 gap 扫描与架构分析，或启用 1.8 的嵌套 Workflow 编排。
- 按官方 catalog 重放 `~/.codex/agents/gsd-*.toml`，移除 `service_tier="flex"`。
- GSD 1.8 会用 defaults 与静态 Codex agent TOML 的 mtime 判断模型是否重新 bake；策略重放在验证全部 TOML 后统一同步其时间戳，`--verify-only` 只报告漂移、不修改文件，避免已正确锁定 Sol 时反复出现无效重装告警。
- 把 `~/.claude/agents/gsd-*.md` 的模型 frontmatter 统一为 `model: inherit`。
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

## 上下文压缩边界

- 剩余上下文降到 35% 时，不再开启新的复杂步骤；完成当前原子步骤后持久化 STATE、TRACKER 与验证证据。
- 剩余降到 25% 时，不再开启新工作；在最近自然边界暂停，提交 `.gsd` 状态并告知用户新建 Codex 任务继续。
- 新任务通过 `$gsd-resume-work` 或用户白话“继续 GSD 任务”从磁盘恢复。它不自动压缩、不自动创建新任务。
- 如果同一任务仍发生压缩，严格执行 SKILL.md 的恢复和 App 计划镜像流程：先读磁盘状态，再执行唯一下一动作，禁止重新规划或重做 GREEN 项。

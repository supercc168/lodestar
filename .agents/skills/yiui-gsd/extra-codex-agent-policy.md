# Codex GSD 子 agent 策略

## 固定质量策略

- 主任务模型与推理强度继承用户当前 Codex App 会话，禁止修改 `~/.codex/config.toml` 的主模型设置。
- 所有 GSD 子 agent 固定使用 `gpt-5.6-sol`。
- 官方 `model-catalog.json` 中 `routingTier=light` 的 agent 使用 `medium`；`standard`、`heavy` 与无法识别的 GSD agent 使用 `high`。
- GSD 流程内临时创建的 generic `explorer` / `worker` 也必须显式采用同一策略；纯读取、机械扫描可用 `medium`，代码修改、规划、调试、审查、验证或不确定场景使用 `high`。
- 禁止使用 `low`、`xhigh`、`ultra`，禁止把子 agent 降为 Terra 或 Luna。

## 应用与验证

在项目根或任意目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/yiui-gsd/scripts/apply-codex-agent-policy.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/yiui-gsd/scripts/apply-codex-agent-policy.ps1 -VerifyOnly
```

脚本负责：

- 合并 `~/.gsd/defaults.json`，保留无关键。
- 固定 `runtime=codex`、`model_profile=adaptive`、三档模型均为 Sol。
- 固定 `light=medium`、`standard/heavy=high`，并设置全局 `subagent_timeout=1800000`。
- 按官方 catalog 重放 `~/.codex/agents/gsd-*.toml`，移除 `service_tier="flex"`。
- 修改前备份 defaults 与发生变化的 agent TOML。

首次启用、GSD 安装/更新后、或 `-VerifyOnly` 报告漂移时执行应用模式。不要逐个手改生成文件。

## 并行与上下文隔离

- 不设置数量上限；按真实依赖决定并行度。
- 独立范围并行，有前后依赖的范围顺序执行。
- 禁止多个 agent 重复调查同一范围，除非任务明确要求独立交叉审查。
- 子 agent 默认不继承完整聊天上下文；只传职责、完成标准和必要文件入口。顺序子 agent 的主要价值是隔离大量读取与中间推理，只向主任务返回紧凑结论。

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

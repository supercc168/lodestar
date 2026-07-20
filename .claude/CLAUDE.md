# Lodestar project rules (Claude)

## GSD / 长任务规划
- 多阶段、长任务、需要 TRACKER/阶段推进时，**必须**使用项目 skill `yiui-gsd`（路径 `.agents/skills/yiui-gsd`，Claude 入口 `.claude/skills/yiui-gsd`）。
- 任何 GSD 操作前先读 `.gsd/TRACKER.md`；活跃任务 STATE 经项目根 `.planning/`。
- **禁止**使用 superpowers / oh-my-claudecode(OMC) / ralplan / ralph / ultrawork / “plan this” 作为规划入口。
- 飞书 Lodestar 场景：daemon 可能已更新 TRACKER/bridge；不要重复创建冲突任务；继续时以磁盘为准。
- 元数据（暂停/完成/切换活跃）若由用户在飞书 GSD 卡完成，agent 只推进 phase 内容。

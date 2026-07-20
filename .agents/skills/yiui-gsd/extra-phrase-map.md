# 白话 → GSD 动作映射

用户表述不必完全一致；按语义匹配最近一行。匹配后由 agent 执行「Skill 行为」，底层 GSD 命令由 agent 内部触发，不对用户展示 `$gsd-*` 原文（可展示中文阶段名）。

## AutoUI 入口（GSD 通用编排 + yiui-auto-ui 附加规则）

| 用户白话（示例） | Skill 行为 | 底层 GSD（agent 内部） |
|------------------|------------|------------------------|
| 用 AUTOUI 做… / UI 全自动… / AUTOUI 开发… / 撤回文档后执行 AutoUI | 先按通用 GSD 创建/切换任务；若判定为 AutoUI，则**仅**用 `bootstrap-autoui-task.ps1` 建档，再叠加 `yiui-auto-ui` 跑完 extra-ui-spec-intake（四表+边界+≥1轮确认）→ strategies + learnings | `$gsd-discuss-phase 1` + 策划/描述 |
| 继续 AutoUI / 接着做 UI 任务 / 恢复 AutoUI | 同「继续 gsd」；确认 TASK 为 autoui；叠加 yiui-auto-ui 恢复自检 | `$gsd-progress --next` |
| AutoUI 进度 / UI 任务到哪了 | 读 TRACKER+STATE+最近 SUMMARY/VERIFICATION | 可选 `$gsd-progress` |

## 任务生命周期

| 用户白话（示例） | Skill 行为 | 底层 GSD（agent 内部） |
|------------------|------------|------------------------|
| 启动一个新的 gsd 任务 / 开新任务 / 新建 gsd | 生成 slug → 建目录与 TASK.md → switch junction → TRACKER=运行中 → commit | 老项目首次建立 planning 基线用 `$gsd-onboard`；已有基线用 `$gsd-discuss-phase 1` + 用户描述 |
| 当前 gsd 进度 / gsd 到哪了 / 任务进度 | 读 TRACKER + STATE.md → 中文摘要 | 可选 `$gsd-progress` |
| 列出所有 gsd 任务 / 有哪些 gsd 任务 | 扫描 `.gsd/*/TASK.md` + TRACKER 索引表 | — |
| 切换 gsd 到 xxx / 换到 xxx 任务 / 切任务 | 暂停当前 → switch 到目标 slug → 更新 TRACKER → commit | 读目标 STATE 摘要 |
| 暂停当前 gsd / 先停一下 gsd | TRACKER 与 TASK 标「已暂停」，保留 junction | — |
| 完成当前 gsd / 这个 gsd 任务做完了 | 标「已完成」，清除活跃运行中，可选解除 junction | 若未 ship 可先 `$gsd-ship` |
| 继续 gsd / 接着做 gsd / 恢复 gsd | 若有 paused 任务则 switch 并标运行中；核对 STATE 单调游标后推进 | `$gsd-progress --next` |
| 删除 gsd 任务 xxx | 仅允许非运行中任务；删目录并更新索引（需用户确认） | — |

## Phase 五段循环

| 用户白话（示例） | 中文回报 | 底层 GSD |
|------------------|----------|----------|
| 讨论一下 / 先把需求聊清楚 / discuss | 正在进入讨论阶段 | `$gsd-discuss-phase {N}` |
| 做计划 / 写方案 / plan | 正在进入计划阶段 | `$gsd-plan-phase {N}` |
| 开始执行 / 开干 / execute | 正在进入执行阶段 | `$gsd-execute-phase {N}` |
| 验收 / 验证一下 / verify | 正在进入验证阶段 | `$gsd-verify-work {N}` |
| 交付 / 提 PR / ship | 正在进入交付阶段 | `$gsd-ship {N}` |

`{N}` 默认从 TRACKER 或 STATE.md 推断当前 phase 编号；用户明确说「phase 2」时用 2。

## 快捷与其它

| 用户白话（示例） | Skill 行为 | 底层 GSD |
|------------------|------------|----------|
| 小改动 / 快速修一下 | 确认有活跃任务后走 quick | `$gsd-quick` + 描述 |
| 扫描代码库 / 了解项目结构 | 确认 junction 指向正确任务 | `$gsd-map-codebase` |
| 把已有代码库接入 GSD / onboard | 确认目标 planning workspace 后执行已有项目接入 | `$gsd-onboard` |
| 下一步做什么 / 自动判断下一步 | 先核对 TRACKER 与 Junction，再读取 GSD 状态菜单 | `$gsd-next` |
| 更新 GSD / 升级 1.7 最新版 / 更新 RC | 读取 VERSION 与 npm next；未安装时用 `npx --yes @opengsd/gsd-core@next --codex --global`，已安装时走更新 skill；之后核对全局 skills、engine、agents、hooks，并同步本映射 | `$gsd-update --next` |
| 更新 GSD 稳定版 | 读取 VERSION 与 npm latest；更新后执行同样验证 | `$gsd-update` |
| gsd 帮助 / gsd 有哪些命令 | 用中文概述主循环，不 dump 全部命令 | 可选 `$gsd-help --brief` |

## 意图不明时

1. 先读 `TRACKER.md` 给出当前上下文。
2. 用一句话问用户：是要**新建**、**继续当前**、**切换**还是**查进度**。

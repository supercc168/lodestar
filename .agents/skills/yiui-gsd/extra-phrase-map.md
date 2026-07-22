# 白话 → GSD 动作映射

用户表述不必完全一致；按语义匹配最近一行。匹配后由 agent 执行「Skill 行为」，底层 GSD 命令由 agent 内部触发，不对用户展示 `$gsd-*` 原文（可展示中文阶段名）。

## AutoUI 入口（GSD 通用编排 + yiui-auto-ui 附加规则）

| 用户白话（示例） | Skill 行为 | 底层 GSD（agent 内部） |
|------------------|------------|------------------------|
| 用 AUTOUI 做… / UI 全自动… / AUTOUI 开发… / 撤回文档后执行 AutoUI | 先按通用 GSD 创建/切换任务；若判定为 AutoUI，则**仅**用 Node helper 的 `bootstrap-autoui-task` 建档，再叠加 `yiui-auto-ui` 跑完 extra-ui-spec-intake（四表+边界+≥1轮确认）→ strategies + learnings | `$gsd-discuss-phase 1 --ws <slug>` + 策划/描述 |
| 继续 AutoUI / 接着做 UI 任务 / 恢复 AutoUI | 同「继续 gsd」；确认 TASK 为 autoui；叠加 yiui-auto-ui 恢复自检 | `$gsd-progress --next` |
| AutoUI 进度 / UI 任务到哪了 | 读 TRACKER+STATE+最近 SUMMARY/VERIFICATION | 可选 `$gsd-progress` |

## 任务生命周期

| 用户白话（示例） | Skill 行为 | 底层 GSD（agent 内部） |
|------------------|------------|------------------------|
| 启动一个新的 gsd 任务 / 开新任务 / 新建 gsd | 生成 slug → 执行 Node helper 的 `new-gsd-task` 原子建档、路由、TRACKER 与限域提交；其他任务状态不变 | 老项目首次建立 planning 基线用 `$gsd-onboard --ws <slug>`；已有基线用 `$gsd-discuss-phase 1 --ws <slug>` + 用户描述 |
| 当前 gsd 进度 / gsd 到哪了 / 任务进度 | 用户已点名则读目标 TASK+STATE；否则解析当前会话 workstream；没有选择且有多个任务时列出后询问 | 可选 `$gsd-progress --ws <slug>` |
| 列出所有 gsd 任务 / 有哪些 gsd 任务 | 读 TRACKER 未完成表；只有用户明确查询历史时才扫描已完成 TASK | — |
| 切换 gsd 到 xxx / 换到 xxx 任务 / 切任务 | Node helper 的 `switch-active-task --task-slug <slug>` 绑定当前会话；目标已暂停则恢复为运行中；不得暂停其他任务 | 读目标 STATE 摘要，后续命令带 `--ws <slug>` |
| 暂停当前 gsd / 先停一下 gsd | 对当前会话目标执行 Node helper 的 `set-gsd-task-status --task-slug <slug> --status 已暂停`；其他任务状态不变 | — |
| 完成当前 gsd / 这个 gsd 任务做完了 | 对目标执行 Node helper 的 `set-gsd-task-status --task-slug <slug> --status 已完成`；helper 强制完成门禁，随后目标从未完成表消失但目录保留 | 若未 ship 可先 `$gsd-ship --ws <slug>` |
| 继续 gsd / 接着做 gsd / 恢复 gsd | 已点名则切换到目标；未点名且当前会话有选择则继续该任务；否则只有一个未完成任务时询问确认，多个时列出选择 | `$gsd-progress --next --ws <slug>` |
| 删除 gsd 任务 xxx | 这是删除历史证据，不等于“完成后从 TRACKER 移除”；仅允许已暂停/已完成任务，必须再次取得用户明确确认 | — |

## Phase 五段循环

| 用户白话（示例） | 中文回报 | 底层 GSD |
|------------------|----------|----------|
| 讨论一下 / 先把需求聊清楚 / discuss | 正在进入讨论阶段 | `$gsd-discuss-phase {N}` |
| 做计划 / 写方案 / plan | 先读 `extra-planning-efficiency.md`；仅全部满足轻量条件时跳过研究，否则走标准计划；始终保留计划检查 | `$gsd-plan-phase {N} --skip-research` 或 `$gsd-plan-phase {N}` |
| 开始执行 / 开干 / execute | 正在进入执行阶段 | `$gsd-execute-phase {N}` |
| 验收 / 验证一下 / verify | 正在进入验证阶段 | `$gsd-verify-work {N}` |
| 交付 / 提 PR / ship | 正在进入交付阶段 | `$gsd-ship {N}` |

`{N}` 从当前会话 task_slug 对应 STATE 推断；用户明确说「phase 2」时用 2。所有底层命令追加 `--ws <task-slug>`。

## 快捷与其它

| 用户白话（示例） | Skill 行为 | 底层 GSD |
|------------------|------------|----------|
| 小改动 / 快速修一下 | 先判断用户是否明确要求纳入 GSD。非 GSD 修改退出本 skill，按项目普通任务规则直接处理；活跃 GSD 内继续执行 STATE 当前游标，不得自动切到会提交项目 Git 的 fast/quick | — |
| 扫描代码库 / 了解项目结构 | 确认目标 workstream 路由存在 | `$gsd-map-codebase --ws <slug>` |
| 把已有代码库接入 GSD / onboard | 确认目标 planning workspace 后执行已有项目接入 | `$gsd-onboard` |
| 下一步做什么 / 自动判断下一步 | 先解析当前会话 task_slug，再核对 TRACKER 与对应路由 | `$gsd-next --ws <slug>` |
| 更新 GSD / 升级最新版 / 更新 RC | 读取 Codex/Claude 两套 VERSION 与 npm dist-tag；未安装时用 `npx --yes @opengsd/gsd-core@next --codex --claude --global`，已安装时走更新 skill；之后核对两套 core、skills、agents、hooks，并同步本映射 | `$gsd-update --next` |
| 更新 GSD 稳定版 | 读取 VERSION 与 npm latest；更新后执行同样验证 | `$gsd-update` |
| gsd 帮助 / gsd 有哪些命令 | 用中文概述主循环，不 dump 全部命令 | 可选 `$gsd-help --brief` |

## 重型规划入口

下列同 provider 入口不得因“更稳妥”“多想一步”或模型能力强而自动叠加；只有用户明确要求，或当前 `TASK.md` / 阶段证据写明需要时才允许内部触发：

- 需求规格深挖：`$gsd-spec-phase`
- 强力讨论：`$gsd-discuss-phase --power`
- 全阶段无人值守链：`$gsd-autonomous`
- 分块规划：`$gsd-plan-phase --chunked`
- Quick 全质量链：`$gsd-quick --full`

普通“继续”“下一步”“做计划”不构成上述入口的授权。完整判定规则见同目录 `extra-planning-efficiency.md`。

跨 AI 计划收敛、Ultraplan、Cross-AI Review 和 Plan Bounce 会离开飞书当前选择的 provider/model，在 Lodestar 场景中一律不路由；继续使用当前模型的标准 planner → checker → 定向修订链。

## 意图不明时

1. 先读 `TRACKER.md`，再尝试解析当前会话 session-local workstream。
2. 没有会话选择且只有一个未完成任务时展示该任务并询问是否继续；有多个时列出状态、阶段和简述并询问目标。
3. 用一句话问用户：是要**新建**、**继续所选任务**、**切换**还是**查进度**。

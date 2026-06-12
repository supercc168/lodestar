<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-06-12 -->

# cards

## Purpose
`src/cards/` 维护所有 Feishu Card Kit schema 2.0 模板和渲染辅助函数。它把一轮 Codex 对话、工具调用、权限请求、AskUserQuestion、控制台、状态卡、`model` 选择卡、`wt` worktree 卡和 `agy` 任务卡都格式化成 session 可以交给 `cardkit.ts` 写入的 JSON 结构。

## Key Files
| File | Description |
|------|-------------|
| `elements.ts` | 集中定义卡片 `element_id` 命名约定，例如 `user_input`、`footer`、`model_panel`、`tool_<i>`、`assistant_<i>`。 |
| `turn.ts` | 对话主卡、assistant 分段、工具折叠面板、权限按钮、AskUserQuestion 面板和工具输入/输出摘要。 |
| `agy.ts` | `agy <prompt>` 任务卡片，渲染 prompt、状态统计、执行结果、仓库变更和转发 Codex 按钮。 |
| `console.ts` | `hi` 控制台、状态卡、菜单卡、模型/effort 选择卡、额度/主机信息格式化和关闭 streaming 设置。 |
| `worktree.ts` | `wt` 列表卡和创建/加入提示卡，展示 `work/*` 分支状态、归档摘要并提供常驻删除按钮。 |
| `turn.test.ts` | Bun 测试，覆盖 turn card、模型选择、工具摘要、权限元素和 console/status card 的关键渲染。 |
| `agy.test.ts` | Bun 测试，覆盖 agy 卡片结构、状态行、输出清理、仓库摘要和转发按钮。 |
| `worktree.test.ts` | Bun 测试，覆盖 `wt` 卡片的归档隐藏和状态排序。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| _None_ | 此目录没有非排除子目录。 |

## For AI Agents

### Working In This Directory
- 保持 schema 2.0 JSON 结构清晰，所有共享 `element_id` 都从 `ELEMENTS` 取值，避免手写重复 ID。
- `turn.ts` 同时承载展示逻辑和工具摘要规则；新增工具类型时先更新摘要/正文渲染，再在 session 工具流程中接线。
- 模型选择卡使用单个可替换的 `model_panel`，流程是模型列表面板 → effort 面板 → 成功结果面板。
- Bash 工具摘要会解析第一行 shell 注释里的 `desc` / `说明`；修改这段逻辑会影响飞书卡片中 shell 命令的可读性。
- 控制台卡片中的 usage、context window、host info 都是传入快照的格式化结果，不要在卡片模板里发起网络或系统调用。
- `worktree.ts` 的列表卡要优先适配手机宽度，按钮文本保持短，避免把操作按钮藏进折叠面板；已合并且未挂载的分支只放入归档摘要。
- `agy.ts` 卡片风格要和既有卡片一致：prompt 折叠标题固定为 `📥 agy收到`，状态保持单行，结果正文不折叠，转发按钮放在结果后，按钮文案尽量短。
- Feishu 对空 markdown、元素数量和 streaming TTL 都比较敏感；模板变更要和 `cardkit.ts` 的空内容过滤、元素计数和关闭 streaming 设置配合。

### Testing Requirements
- 修改 `turn.ts` 或 `console.ts` 后运行 `bun test src/cards/turn.test.ts`。
- 修改 `agy.ts` 后运行 `bun test src/cards/agy.test.ts src/agy-task.test.ts`。
- 修改 `worktree.ts` 后运行 `bun test src/cards/worktree.test.ts src/worktree.test.ts`，必要时用 debug 注入在真实群里检查卡片渲染和按钮回调。
- 如果变更影响 `contextPercent`、usage 或控制台展示，也运行 `bun test src/context-window.test.ts`。
- 影响真实 Card Kit schema、按钮 action 或 streaming 设置时，需要在飞书群里做 smoke。

### Common Patterns
- 对话卡用顶部收起的 `user_input` 面板保存本轮收到的用户输入；工具和 assistant 片段按 Codex 事件顺序追加。
- 工具面板以折叠 panel 展示 header 摘要，正文按工具类型渲染命令、diff、网页搜索、MCP、图片生成或 agent 信息。
- AskUserQuestion 面板要保留历史回答、当前问题和自定义回答入口，并通过 action value 回到 session 权限流程。
- `agy` 卡片固定包含 prompt、stats、result、forward placeholder/button 和 repo 这几类元素；完成后用 `replaceElement` 更新结果、仓库变更和转发按钮。
- `model` 面板的按钮 action value 分别使用 `model_select` 和 `model_effort_select`，并带上 `panel_id` 防止旧卡回调污染当前选择。
- 控制台和状态卡统一通过 `streamingOffSettings` 在终态关闭 streaming 并写 summary。
- `wt` 列表使用 `column_set` 保持状态和删除按钮同屏可见；创建/加入提示使用轻量 notice card。

## Dependencies

### Internal
- `src/cards.ts` 统一 re-export 本目录导出，调用方通常 `import * as cards from './cards'`。
- `src/session.ts`、`src/session-tools.ts`、`src/session-permission.ts`、`src/session-ask.ts` 都依赖本目录生成卡片元素。
- `src/session.ts` 使用 `console.ts` 渲染 `model` 面板，使用 `worktree.ts` 渲染 `wt` 列表卡、创建提示卡和解散按钮，使用 `agy.ts` 渲染外部 agy 任务卡。
- `console.ts` 依赖 `src/sysinfo.ts`、`src/usage.ts` 和 `src/context-window.ts` 的类型与格式输入。

### External
- Feishu Card Kit schema 2.0：模板字段、按钮 action、markdown 和 streaming config 需要符合飞书接口约束。
- Bun test：执行 `turn.test.ts`、`agy.test.ts` 和 `worktree.test.ts`。

<!-- MANUAL: Add manually maintained notes below this line. -->

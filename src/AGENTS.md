<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-06-26 -->

# src

## Purpose
`src/` 是 Lodestar daemon 的核心实现层，封装飞书 API、统一 `AgentProcess` 后端接口及其 Codex / Claude 两类实现、每个群的 session 状态机、Card Kit 流式更新、模型/effort 持久选择、`wt` worktree 群编排、`agy <prompt>` 外部任务、`task` 飞书任务清单自动化、安装/停止/升级 CLI，以及 runtime state 路径和配置读取。session 默认 provider 为 Claude/GLM，可经 `model` 切到 Codex。

## Key Files
| File | Description |
|------|-------------|
| `session.ts` | 一个飞书群对应一个 `Session`；保留核心状态、Codex 生命周期、Feishu 入站消息、app-server 事件接线和 turn/card 流式状态机；具体命令和业务面板下沉到 `session-*` helper。 |
| `session-types.ts` | `TurnState`、`Status`、累计统计和 session option 类型定义。 |
| `session-util.ts` | session helper 共享的状态卡、生命周期选项、action result 类型和错误/超时小工具。 |
| `session-commands.ts` | 群内裸词控制命令路由：`hi`、`stop`、`kill`、`restart`、`clear`、`compact`、`model`、`task`、`wt` 和 `agy`。 |
| `session-agy.ts` | `agy <prompt>` 外部任务生命周期：进程启动/停止、stdout/stderr 捕获、状态卡更新、仓库快照和转发 Codex。 |
| `session-worktree.ts` | `wt` session 侧编排：项目名/目录约定、额外 worktree instructions 注入、列表卡、建群/入群和解散回调。 |
| `session-tasklist.ts` | `task` 面板的 session 回调：启用项目任务清单、删除确认和面板重绘。 |
| `session-model.ts` | `model` 面板流程：通过 Codex app-server 动态拉取模型列表、选择模型和 reasoning effort、持久化 session 选择。 |
| `session-compact.ts` | 手动 `compact` 命令流程：发起 app-server 上下文压缩、监听完成事件和 token usage 快照、更新状态卡。 |
| `session-tools.ts` | 工具调用面板、工具结果自动发文件和换卡后的工具面板重建逻辑。 |
| `session-ask.ts` | Codex `AskUserQuestion` 交互流程，处理按钮、自定义回答和权限 request 回填。 |
| `session-host-ask.ts` | 解析 assistant 输出中的 `[[askusr: ...]]` 主机澄清标记，创建独立问答卡并把用户答案回填到 session。 |
| `session-permission.ts` | 工具权限请求的卡片渲染与用户决策回传。 |
| `agy-task.ts` | 外部 agy CLI 辅助：解析可执行文件、构造 `agy --print` 参数、补 PATH、采集执行前后 Git 快照和 diff 摘要。 |
| `tasklist.ts` | `task` 项目清单绑定和状态存储；创建 `<project>[lodestar]` 清单、维护分组 GUID、记录自动化进程和每个任务的运行状态。 |
| `tasklist-worker.ts` | 任务清单轮询 worker；按 `设计中`、`[AI]待执行`、`[AI]执行中`、`[AI]待审核`、`已完成` 分组驱动 Codex/agy 规划、选择、执行、审核和本地合并。 |
| `tasklist-worker-git.ts` | `tasklist-worker` 的本地 Git worktree、artifact tag 和 local review ref 辅助逻辑。 |
| `agent-process.ts` | 统一 agent 后端接口：定义 `AgentProcess`（`EventEmitter`）、`AgentProvider = 'codex' \| 'claude'`、统一 `AgentProcessEventMap`、Claude reasoning effort 集合（`low`/`medium`/`high`/`xhigh`/`max`，默认 `max`）和 `providerFromModel` 等 provider 辅助；`CodexProcess` 与 `ClaudeAgentProcess` 都实现该接口。 |
| `codex-process.ts` | 实现 `AgentProcess` 的 Codex 后端：启动 `codex app-server --listen stdio://`，处理 JSON-RPC 请求、通知、工具权限、模型列表/settings、thread 启停和 app-server 事件映射。 |
| `codex-usage.ts` | 解析 app-server token usage payload，并计算 per-turn absolute total 差值与有效 token。 |
| `codex-compaction.ts` | 解析多种 app-server / raw response context compaction 事件，并输出统一 `ContextCompactedNotification`。 |
| `claude-agent-process.ts` | 实现 `AgentProcess` 的 Claude 后端：用 `@anthropic-ai/claude-agent-sdk` 的 `query({ prompt: AsyncIterable })` streaming-input 长驻进程，把 SDK message（`system/init`、assistant text/tool_use、`tool_result`、`result`、`compact_boundary`）映射为统一 Session 事件；`bypassPermissions` 全自动（旧飞书审批 UI 已清），`onUserDialog` 接现有 `AskUserQuestion` 卡片；启动前 `assertClaudeCodeAvailable` 检查 `claude` 可执行文件。 |
| `claude-models.ts` | Claude model profile：内置 `glm`（GLM-5.2）一项，可被 `config.toml` 的 `[claude.models.*]` 覆盖/新增；`resolveClaudeSdkModel` 把 `claude:glm` 映射为 SDK 主模型 `opus` alias，真实上游模型（GLM-5.2/4.7）由 `~/.claude/settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 路由。 |
| `card-action.ts` | Card action 回调响应辅助；生产 WS 路径用 `{ card: { type: "raw", data: newCard } }` 立即替换 JSON 卡片，避免 200672、裸卡片或提前 patch 导致模型/effort 面板闪退。 |
| `cardkit.ts` | Feishu Card Kit v1 封装；维护 per-card sequence、Promise queue、流式限流、元素计数和写失败回调。 |
| `cards.ts` | 卡片模板 barrel；统一导出 `src/cards/` 下的 turn、console、worktree、agy、task 和元素 ID 工具。 |
| `feishu.ts` | Lark client、tenant token 缓存、群名/会话映射、alive session 和模型选择持久 map、群创建/解散/成员拉取、消息发送、reaction、附件下载、文件上传和项目目录初始化；Task v2 API 由 `feishu-task.ts` re-export。 |
| `feishu-task.ts` | 飞书 Task v2 清单/分组/任务/评论 API 包装，以及 Task API 错误格式化。 |
| `worktree.ts` | `wt` 的 Git worktree 逻辑：按 `work/*` 分支扫描、创建同级 `<project>[name]` worktree、归档已合并分支、重新激活时更新到主线、干净检查和删除目录。 |
| `config.ts` | 同步读取 `config.toml`，解析 `[feishu]`、`[runtime]`、`[notify]` 和可选 `[codex.env]`。 |
| `paths.ts` | XDG/Windows runtime 路径解析，以及 PID、日志、session/chat/resume/model/alive/tasklist map、inbox、debug socket 路径常量。 |
| `notify.ts` | 本机 HTTP 通知服务，接收 `{project, text, level}` 并发送飞书 markdown 卡片。 |
| `notify-skill.ts` | 在本机 Codex skills 目录生成/维护 Feishu notify 技能说明。 |
| `instructions.ts` | 注入给每个 Codex thread 的 channel developer instructions。 |
| `setup.ts` | 交互式首次配置向导；安装/检查 Codex、校验 Feishu 凭据和 `wt` 所需群权限、写 `config.toml` 并拉起 daemon。 |
| `setup-cli.ts` | `lodestar-setup` 入口。 |
| `stop-cli.ts` | `lodestar-stop` 入口，通过 PID 文件确认并停止 daemon。 |
| `update-cli.ts` | `lodestar-update` 入口，封装 npm 更新逻辑并检查 daemon 状态。 |
| `version-cli.ts` | `lodestar-version` 入口，输出 Lodestar 和 Codex CLI 版本。 |
| `usage.ts` | 临时 app-server 请求 Codex/ChatGPT 使用额度；保留最新快照，只在收到新值时覆盖。 |
| `glm-usage.ts` | GLM Coding Plan 用量快照（给 `hi` console 的 Claude/GLM 后端用）：直打 GLM 官方 `quota/limit` monitor API，凭据从 `~/.claude/settings.json` 的 env 读 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 判平台（open.bigmodel.cn / api.z.ai）；无凭据/非 GLM/限流/网络各自显式 MISS，绝不假数据，与 `usage.ts` 的 snapshot 模式对齐。 |
| `sysinfo.ts` | 读取主机 CPU、内存、磁盘和 AI 相关 systemd service 状态，供控制台卡片展示。 |
| `pid-guard.ts` | PID 文件和进程 cmdline marker 校验，防止误认复用 PID。 |
| `context-window.ts` | 根据模型和 token usage 估算 context window 占用。 |
| `outbound-markers.ts` | 解析 assistant 输出中的 `[[send: /abs/path]]` 附件发送标记。 |
| `log.ts` | 按日滚动 logger：写 `daemon-YYYY-MM-DD.log`（本地日期），跨天与启动时清理超过 7 天的旧日志；启动把老 `daemon.log` 迁移成按日文件。 |
| `*.test.ts` | Bun 单元测试，覆盖 Card Kit、turn/agy/task card 渲染、tasklist worker、card action 回调返回、context window 展示、outbound marker、Codex 事件解析、usage 快照、session 行为和 worktree/agy Git 行为。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `cards/` | Feishu Card Kit schema 2.0 模板、元素 ID 约定、工具面板渲染和控制台卡片（见 `cards/AGENTS.md`）。 |

## For AI Agents

### Working In This Directory
- `config.ts` 在 import 时同步读取配置，缺配置会抛错；面向首次安装的延迟导入逻辑在根目录 `cli.ts`，不要在核心模块里吞掉配置错误。
- `Session` 的无 `private` 字段是 package-internal 约定，只应由 `session-*.ts` 辅助模块访问；新 helper 应遵循同一边界。
- 修改 `src/` 代码时，**不得**为了验证卡片/交互效果而去停止、重启、切换或并行接管 live daemon；用户若只说“测试”“预览”“发一张看看”，一律视为**未授权**。只有用户明确点名对应 daemon/service 操作时才能执行。
- `wt` 命令的 Git 操作集中在 `worktree.ts`；不要在 `session.ts` 里散写 `git` shell 命令。
- `agy <prompt>` 的 CLI 参数、PATH 和 Git 快照集中在 `agy-task.ts`；session 侧进程生命周期、输出收集、状态刷新和卡片接线集中在 `session-agy.ts`。
- `task` 面板按钮由 `session-tasklist.ts` 处理，持久状态集中在 `tasklist.ts`，后台自动化集中在 `tasklist-worker.ts`；不要把轮询、进程状态或 Git 产物逻辑塞进卡片模板。
- `model` 命令为固定二元选项(codex=gpt-5.5/xhigh、claude=claude:glm/max),effort 锁死一键生效,不动态拉取 `model/list`。
- Codex 子进程协议集中在 `codex-process.ts`；新增 app-server 方法或通知映射时要同时考虑 `Session` 事件处理和卡片展示。
- Card Kit 写操作必须经过 `cardkit.ts` 的队列和 sequence 逻辑；不要从 session 或脚本直接 `fetch` 修改同一张生产卡。
- 处理附件、文件返回和项目目录时使用 `feishu.ts` 里的 sanitizer、upload/download/provision helper。
- 不要把 runtime state 放回仓库；新状态文件应定义在 `paths.ts` 并落到 `DATA_DIR` 或 `CONFIG_DIR`。

### Testing Requirements
- 修改核心 TypeScript 后运行 `bun test`。
- 修改构建入口、CLI 或发布相关文件后运行 `bun run build`。
- 修改 session、Card Kit、Feishu 消息、权限或 AskUserQuestion 流程后，补充真实群 smoke：`bun scripts/smoke.ts "<group name>"` 或 `bun scripts/test-all.ts "<group name>"`。
- 真实群 smoke 若会触碰 live daemon/service，先单独征得用户明确许可；“我想先看看效果”或“发个测试卡”不足以授权 stop/restart/switch daemon。
- 修改 `model` 或 `wt` 创建/加入/解散流程后，用 debug 注入在真实群里验证 `model`、`wt`、`wt <name>` 和解散按钮；测试结束后清理临时 worktree、群和本地分支。
- 修改 `agy` 命令、外部进程、Git 快照或卡片结构后，至少运行 `bun test src/agy-task.test.ts src/cards/agy.test.ts`，共享 session 行为变更再运行全量 `bun test`。
- 修改 `task` 面板、清单分组、worker 调度、任务评论或本地审查/合并流程后，至少运行 `bun test src/tasklist-worker.test.ts src/cards/task.test.ts`；触及共享 session 或 Feishu API 包装时运行全量 `bun test`。
- 修改 `cards/` 渲染或工具摘要时至少运行相关 Bun 测试：`bun test src/cards/turn.test.ts src/cardkit.test.ts src/context-window.test.ts`。

### Common Patterns
- `daemon.ts` 负责把 Feishu WS 事件转成 `Session` 调用；`Session` 再把 Codex 事件转成 `cardkit` 操作。
- `wt` 复用群名等于目录名的约定：主项目群 `project` 创建同级 `project[name]`，分支固定为 `work/name`。
- `wt` 解散按钮不能删除仍有运行中 Codex session 的 worktree 群；先让对应群 `stop` 或 `kill`。
- 已合并且未挂载的 `work/*` 分支在 `wt` 卡片里折叠为归档摘要；再次 `wt <name>` 会挂载并 rebase 到当前项目 HEAD。
- `agy <prompt>` 使用 `agy --model "Gemini 3.1 Pro (High)" --dangerously-skip-permissions --print-timeout 180m0s -p <prompt>`，每个 session 同时只允许一个任务；`stop`/`kill`/`restart` 要清理正在运行的 agy 进程和状态刷新定时器。
- `agy` 卡片每 30 秒更新状态统计，stdout/stderr 用 `StringDecoder` 收集，空输出需要显式报错说明；完成后可用卡片按钮把结果幂等转发给 Codex。
- `task` 清单名固定为 `<project>[lodestar]`，分组固定为 `设计中`、`[AI]待执行`、`[AI]执行中`、`[AI]待审核`、`已完成`；默认分组会被重命名为 `设计中`，其他分组按缺失补齐。
- `tasklist-worker` 启动后延迟 15 秒首次扫描，此后每 30 秒扫描一次；同一时间只跑一个 scan，运行记录写入 `tasklist-map.json` 并在进程丢失时向任务评论暴露错误。
- 任务自动执行使用 `AI-AUTO`/`AI-REVIEW` 本地 worktree 和 `AI-AUTO/<task-guid>` tag 作为审查产物；人工在 `[AI]待审核` 中勾选完成是触发本地合并的信号。
- Assistant 正文和 footer 状态不再走 Card Kit `/content` 打字流；正文在完整 `agentMessage` 到达后一次性 `addElement`，footer 状态用 `replaceElement` 直接替换。`cardkit.flush` 仅等待同卡片已排队写操作完成。
- `card.action.trigger` 需要 3 秒内替换原 JSON 卡片时 return `{ card: { type: "raw", data: newCard } }`；不要 return 裸卡片 JSON 或 `{ card: newCard }`，也不要在回调 ACK 前调用 `message.patch`。延时更新才先 ACK 再用回调 token 调 `/interactive/v1/card/update`。
- `feishu.ts` 对 SDK 发送消息做 retry 和 UUID 去重；业务 API 错误要 log 并返回失败，而不是默默换用 raw API。
- `codex-process.ts` 保存最近模型、effort、usage、context window、context compaction 状态和 result meta，控制台和 footer 读取这些快照展示运行状态。
- `setup.ts` 写出的 TOML 转义逻辑要与 `config.ts` 的最小 TOML parser 保持一致。

## Dependencies

### Internal
- `session.ts` 经 `AgentProcess` 接口（`agent-process.ts`）持有当前 `proc`，按 `selectedProvider` 在 `ClaudeAgentProcess`（默认）和 `CodexProcess` 之间 spawn；并依赖 `cardkit.ts`、`cards.ts`、`feishu.ts` 和 `session-*` helper；业务面板/命令 helper 再依赖 `worktree.ts`、`tasklist.ts`、`agy-task.ts` 等领域模块。
- `claude-agent-process.ts` 依赖 `@anthropic-ai/claude-agent-sdk`、`agent-process.ts`、`claude-models.ts`、`codex-usage.ts`（token usage 解析复用）和 `config.ts`；`glm-usage.ts` 被 `session.ts`（console opts）和 `cards/console.ts` 消费。
- `tasklist-worker.ts` 依赖 `tasklist.ts`、`feishu.ts`、`agy-task.ts`、`codex-process.ts` 和 `tasklist-worker-git.ts`；本地 Git worktree、tag 与审查 diff 约定集中在 `tasklist-worker-git.ts`。
- `cardkit.ts` 依赖 `feishu.getTenantToken()` 获取 Card Kit API token。
- `feishu.ts` 依赖 `config.ts`、`paths.ts` 和 `codex-process.resolveCodexBin()`，并维护 session chat/resume/model/alive/tasklist runtime map。
- CLI 文件依赖 `paths.ts`、`pid-guard.ts`、`setup.ts` 和 Node/Bun process API。

### External
- `@larksuiteoapi/node-sdk`：Lark client、WS client、IM API、群管理和群成员 API。
- `codex` CLI：无头 app-server、ChatGPT 登录状态、模型使用量。
- `@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/sdk`：Claude 后端 `query()` streaming-input transport、模型档位路由、user dialog。
- `claude` CLI：Claude Code 本机可执行文件，`assertClaudeCodeAvailable` 启动前检查；模型路由真相源是其 `~/.claude/settings.json`。
- Feishu Card Kit v1、IM Open API 和 Task v2 Open API：卡片、消息、reaction、附件、urgent app、任务清单、分组、任务和评论。
- Bun test/build runtime，Node.js child process/fs/http/path/os API。
- systemd：`sysinfo.ts` 只读用户服务状态，用于控制台展示。

<!-- MANUAL: Add manually maintained notes below this line. -->

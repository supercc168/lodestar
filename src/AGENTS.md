<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-06-13 -->

# src

## Purpose
`src/` 是 Lodestar daemon 的核心实现层，封装飞书 API、Codex app-server 子进程、每个群的 session 状态机、Card Kit 流式更新、模型/effort 持久选择、`wt` worktree 群编排、`agy <prompt>` 外部任务、`task` 飞书任务清单自动化、安装/停止/升级 CLI，以及 runtime state 路径和配置读取。

## Key Files
| File | Description |
|------|-------------|
| `session.ts` | 一个飞书群对应一个 `Session`；管理 Codex 生命周期、每轮卡片、消息排队、裸词控制、`model` 选择、`wt` worktree 群命令、`agy` 任务生命周期、`task` 面板回调、运行中 worktree 解散保护和统计状态。 |
| `session-types.ts` | `TurnState`、`Status`、累计统计和 session option 类型定义。 |
| `session-tools.ts` | 工具调用面板、工具结果自动发文件和换卡后的工具面板重建逻辑。 |
| `session-ask.ts` | Codex `AskUserQuestion` 交互流程，处理按钮、自定义回答和权限 request 回填。 |
| `session-host-ask.ts` | 解析 assistant 输出中的 `[[askusr: ...]]` 主机澄清标记，创建独立问答卡并把用户答案回填到 session。 |
| `session-permission.ts` | 工具权限请求的卡片渲染与用户决策回传。 |
| `agy-task.ts` | 外部 agy CLI 辅助：解析可执行文件、构造 `agy --print` 参数、补 PATH、采集执行前后 Git 快照和 diff 摘要。 |
| `tasklist.ts` | `task` 项目清单绑定和状态存储；创建 `<project>[lodestar]` 清单、维护分组 GUID、记录自动化进程和每个任务的运行状态。 |
| `tasklist-worker.ts` | 任务清单轮询 worker；按 `设计中`、`[AI]待执行`、`[AI]执行中`、`[AI]待审核`、`已完成` 分组驱动 Codex/agy 规划、选择、执行、审核和本地合并。 |
| `codex-process.ts` | 启动 `codex app-server --listen stdio://`，处理 JSON-RPC 请求、通知、工具权限、模型列表/settings、context compaction 事件和使用量元数据。 |
| `card-action.ts` | Card action 回调响应辅助；生产 WS 路径用 `{ card: { type: "raw", data: newCard } }` 立即替换 JSON 卡片，避免 200672、裸卡片或提前 patch 导致模型/effort 面板闪退。 |
| `cardkit.ts` | Feishu Card Kit v1 封装；维护 per-card sequence、Promise queue、流式限流、元素计数和写失败回调。 |
| `cards.ts` | 卡片模板 barrel；统一导出 `src/cards/` 下的 turn、console、worktree、agy、task 和元素 ID 工具。 |
| `feishu.ts` | Lark client、tenant token 缓存、群名/会话映射、alive session 和模型选择持久 map、群创建/解散/成员拉取、消息发送、reaction、附件下载、文件上传、Task v2 清单/分组/任务/评论 API 和项目目录初始化。 |
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
| `sysinfo.ts` | 读取主机 CPU、内存、磁盘和 AI 相关 systemd service 状态，供控制台卡片展示。 |
| `pid-guard.ts` | PID 文件和进程 cmdline marker 校验，防止误认复用 PID。 |
| `context-window.ts` | 根据模型和 token usage 估算 context window 占用。 |
| `outbound-markers.ts` | 解析 assistant 输出中的 `[[send: /abs/path]]` 附件发送标记。 |
| `log.ts` | 追加写入 `daemon.log` 的轻量 logger。 |
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
- `agy <prompt>` 的 CLI 参数、PATH 和 Git 快照集中在 `agy-task.ts`；`Session` 只负责互斥、进程生命周期、输出收集、状态刷新和卡片接线。
- `task` 面板按钮由 `Session` 处理，持久状态集中在 `tasklist.ts`，后台自动化集中在 `tasklist-worker.ts`；不要把轮询、进程状态或 Git 产物逻辑塞进卡片模板。
- `model` 命令的模型列表来自 Codex app-server `model/list`，reasoning effort 必须来自对应模型返回值；不要写静态模型清单。
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
- `session.ts` 依赖 `codex-process.ts`、`cardkit.ts`、`cards.ts`、`feishu.ts`、`worktree.ts`、`agy-task.ts`、`tasklist.ts`、`session-tools.ts`、`session-ask.ts`、`session-host-ask.ts` 和 `session-permission.ts`。
- `tasklist-worker.ts` 依赖 `tasklist.ts`、`feishu.ts`、`agy-task.ts`、`codex-process.ts` 和本地 Git 命令，创建/检查自动化 worktree、tag 与审查 diff。
- `cardkit.ts` 依赖 `feishu.getTenantToken()` 获取 Card Kit API token。
- `feishu.ts` 依赖 `config.ts`、`paths.ts` 和 `codex-process.resolveCodexBin()`，并维护 session chat/resume/model/alive/tasklist runtime map。
- CLI 文件依赖 `paths.ts`、`pid-guard.ts`、`setup.ts` 和 Node/Bun process API。

### External
- `@larksuiteoapi/node-sdk`：Lark client、WS client、IM API、群管理和群成员 API。
- `codex` CLI：无头 app-server、ChatGPT 登录状态、模型使用量。
- Feishu Card Kit v1、IM Open API 和 Task v2 Open API：卡片、消息、reaction、附件、urgent app、任务清单、分组、任务和评论。
- Bun test/build runtime，Node.js child process/fs/http/path/os API。
- systemd：`sysinfo.ts` 只读用户服务状态，用于控制台展示。

<!-- MANUAL: Add manually maintained notes below this line. -->

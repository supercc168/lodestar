<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-05-31 -->

# src

## Purpose
`src/` 是 Lodestar daemon 的核心实现层，封装飞书 API、Codex app-server 子进程、每个群的 session 状态机、Card Kit 流式更新、安装/停止/升级 CLI，以及 runtime state 路径和配置读取。

## Key Files
| File | Description |
|------|-------------|
| `session.ts` | 一个飞书群对应一个 `Session`；管理 Codex 生命周期、每轮卡片、消息排队、控制命令和统计状态。 |
| `session-types.ts` | `TurnState`、`Status`、累计统计和 session option 类型定义。 |
| `session-tools.ts` | 工具调用面板、任务清单镜像、工具结果自动发文件和换卡后的工具面板重建逻辑。 |
| `session-ask.ts` | Codex `AskUserQuestion` 交互流程，处理按钮、自定义回答和权限 request 回填。 |
| `session-permission.ts` | 工具权限请求的卡片渲染与用户决策回传。 |
| `codex-process.ts` | 启动 `codex app-server --listen stdio://`，处理 JSON-RPC 请求、通知、工具权限和使用量元数据。 |
| `cardkit.ts` | Feishu Card Kit v1 封装；维护 per-card sequence、Promise queue、流式限流、元素计数和写失败回调。 |
| `cards.ts` | 卡片模板 barrel；统一导出 `src/cards/` 下的 turn、console 和元素 ID 工具。 |
| `feishu.ts` | Lark client、tenant token 缓存、群名/会话映射、消息发送、reaction、附件下载、文件上传和项目目录初始化。 |
| `config.ts` | 同步读取 `config.toml`，解析 `[feishu]`、`[runtime]`、`[notify]` 和可选 `[codex.env]`。 |
| `paths.ts` | XDG/Windows runtime 路径解析，以及 PID、日志、session map、inbox、debug socket 路径常量。 |
| `notify.ts` | 本机 HTTP 通知服务，接收 `{project, text, level}` 并发送飞书 markdown 卡片。 |
| `notify-skill.ts` | 在本机 Codex skills 目录生成/维护 Feishu notify 技能说明。 |
| `instructions.ts` | 注入给每个 Codex thread 的 channel developer instructions。 |
| `setup.ts` | 交互式首次配置向导；安装/检查 Codex、校验 Feishu 凭据、写 `config.toml` 并拉起 daemon。 |
| `setup-cli.ts` | `lodestar-setup` 入口。 |
| `stop-cli.ts` | `lodestar-stop` 入口，通过 PID 文件确认并停止 daemon。 |
| `update-cli.ts` | `lodestar-update` 入口，封装 npm 更新逻辑并检查 daemon 状态。 |
| `version-cli.ts` | `lodestar-version` 入口，输出 Lodestar 和 Codex CLI 版本。 |
| `usage.ts` | 临时 app-server 请求 Codex/ChatGPT 使用额度，并提供 stale fallback。 |
| `sysinfo.ts` | 读取主机 CPU、内存、磁盘和 AI 相关 systemd service 状态，供控制台卡片展示。 |
| `pid-guard.ts` | PID 文件和进程 cmdline marker 校验，防止误认复用 PID。 |
| `context-window.ts` | 根据模型和 token usage 估算 context window 占用。 |
| `log.ts` | 追加写入 `daemon.log` 的轻量 logger。 |
| `*.test.ts` | Bun 单元测试，覆盖 Card Kit、turn card 渲染和 context window 展示。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `cards/` | Feishu Card Kit schema 2.0 模板、元素 ID 约定、工具面板渲染和控制台卡片（见 `cards/AGENTS.md`）。 |

## For AI Agents

### Working In This Directory
- `config.ts` 在 import 时同步读取配置，缺配置会抛错；面向首次安装的延迟导入逻辑在根目录 `cli.ts`，不要在核心模块里吞掉配置错误。
- `Session` 的无 `private` 字段是 package-internal 约定，只应由 `session-*.ts` 辅助模块访问；新 helper 应遵循同一边界。
- Codex 子进程协议集中在 `codex-process.ts`；新增 app-server 方法或通知映射时要同时考虑 `Session` 事件处理和卡片展示。
- Card Kit 写操作必须经过 `cardkit.ts` 的队列和 sequence 逻辑；不要从 session 或脚本直接 `fetch` 修改同一张生产卡。
- 处理附件、文件返回和项目目录时使用 `feishu.ts` 里的 sanitizer、upload/download/provision helper。
- 不要把 runtime state 放回仓库；新状态文件应定义在 `paths.ts` 并落到 `DATA_DIR` 或 `CONFIG_DIR`。

### Testing Requirements
- 修改核心 TypeScript 后运行 `bun test`。
- 修改构建入口、CLI 或发布相关文件后运行 `bun run build`。
- 修改 session、Card Kit、Feishu 消息、权限或 AskUserQuestion 流程后，补充真实群 smoke：`bun scripts/smoke.ts "<group name>"` 或 `bun scripts/test-all.ts "<group name>"`。
- 修改 `cards/` 渲染或工具摘要时至少运行相关 Bun 测试：`bun test src/cards/turn.test.ts src/cardkit.test.ts src/context-window.test.ts`。

### Common Patterns
- `daemon.ts` 负责把 Feishu WS 事件转成 `Session` 调用；`Session` 再把 Codex 事件转成 `cardkit` 操作。
- `cardkit.streamTextThrottled` 缓冲完整文本帧，`flush` 在 turn 关闭前兜底；直接 `streamText` 只用于明确的终态写入。
- `feishu.ts` 对 SDK 发送消息做 retry 和 UUID 去重；业务 API 错误要 log 并返回失败，而不是默默换用 raw API。
- `codex-process.ts` 保存最近模型、usage、context window 和 result meta，控制台和 footer 读取这些快照展示运行状态。
- `setup.ts` 写出的 TOML 转义逻辑要与 `config.ts` 的最小 TOML parser 保持一致。

## Dependencies

### Internal
- `session.ts` 依赖 `codex-process.ts`、`cardkit.ts`、`cards.ts`、`feishu.ts`、`session-tools.ts`、`session-ask.ts` 和 `session-permission.ts`。
- `cardkit.ts` 依赖 `feishu.getTenantToken()` 获取 Card Kit API token。
- `feishu.ts` 依赖 `config.ts`、`paths.ts` 和 `codex-process.resolveCodexBin()`。
- CLI 文件依赖 `paths.ts`、`pid-guard.ts`、`setup.ts` 和 Node/Bun process API。

### External
- `@larksuiteoapi/node-sdk`：Lark client、WS client 和 IM API。
- `codex` CLI：无头 app-server、ChatGPT 登录状态、模型使用量。
- Feishu Card Kit v1 和 IM Open API：卡片、消息、reaction、附件、urgent app。
- Bun test/build runtime，Node.js child process/fs/http/path/os API。
- systemd：`sysinfo.ts` 只读用户服务状态，用于控制台展示。

<!-- MANUAL: Add manually maintained notes below this line. -->

<!-- Generated: 2026-05-15 | Updated: 2026-06-04 -->

# Lodestar 2.0

## Purpose
本仓库实现一个 Bun daemon，把飞书群消息桥接到无头 `codex app-server` 进程。运行时关系是一个飞书群对应一个 Lodestar session、一个 Codex thread，以及每轮对话中的一张流式 Feishu Card Kit 卡片；项目主群还可用 `model` 管理模型/effort，用 `wt` 自动创建/加入同级 Git worktree 群。

## Key Files
| File | Description |
|------|-------------|
| `daemon.ts` | daemon 主入口；负责 PID guard、Lark `WSClient`、事件分发、裸词控制命令和 debug socket。 |
| `cli.ts` | npm 分发入口；在缺少 `config.toml` 时触发安装向导，否则延迟导入 `daemon.ts`。 |
| `package.json` | Bun/Node 打包脚本、发布元数据、二进制入口和依赖声明。 |
| `README.md` | 用户安装、首次配置、群控裸词、`model` 选择、`wt` worktree 群和 HTTP 通知端点说明。 |
| `bun.lock` | Bun 依赖锁文件；更新依赖后同步提交。 |
| `LICENSE` | MIT 许可证。 |
| `promo.jpg` | README 顶部展示图。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | daemon 的核心 TypeScript 模块，包括 session、Codex 子进程、飞书 API、Card Kit 和 CLI 辅助逻辑（见 `src/AGENTS.md`）。 |
| `scripts/` | 面向真实飞书环境的 smoke、调试注入、Card Kit 探针和安装后向导脚本（见 `scripts/AGENTS.md`）。 |

## For AI Agents

### Working In This Directory
- Runtime 是 **Bun**；源码开发通常用 `bun daemon.ts` 或 `bun run start`，发布包通过 `bun build --target=node` 生成 Node 可执行文件。
- daemon 只驱动 `codex app-server --listen stdio://` 的 app-server JSON-RPC 协议；不要恢复 tmux、JSONL 队列或 1.x 传输机制。
- 运行状态全部在 XDG 目录外置：配置默认在 `~/.config/lodestar/config.toml`，日志和 runtime map 默认在 `~/.local/share/lodestar/`。凭据只应存在于 `config.toml`，不要写入仓库。
- 处理 Card Kit 流式文本时优先使用 `cardkit.streamTextThrottled`；事件处理路径不要直接高频调用 `streamText`。
- API 失败要记录并向用户暴露；不要静默切换传输、卡片或消息通道作为“兜底”。
- 不要主动重启正在运行的 daemon，除非用户在当前回合明确要求 `restart` / `重启` / reload。代码变更后只报告需要重启。
- 群内裸词控制是 `hi`、`stop`、`kill`、`restart`、`clear`、`model`、`wt` 和 `wt <name>`；这些词在 `Session.runCommand` 中作为保留字处理。
- `model` 通过 Card Kit 按钮先选 Codex 模型、再选 reasoning effort，并把选择按 session 持久化到 XDG data。
- `wt <name>` 约定创建同级目录 `<project>[<name>]` 和本地分支 `work/<name>`，并自动创建/加入同名飞书群；解散按钮会先拒绝仍在运行的对应 session，只在 worktree 干净时删除目录和解散群，保留分支；重新激活已合并归档分支时会更新到主线。
- 本地脚本可通过 `POST http://127.0.0.1:9876/notify` 发送 `{project, text, level}` 到绑定群。

### Testing Requirements
- 常规校验使用 `bun test` 和 `bun run build`。
- 涉及真实飞书、Codex 登录、卡片流式行为或 `wt` 建群/解散时，用 debug 注入、`bun scripts/smoke.ts "<group name>"` 或 `bun scripts/test-all.ts "<group name>"` 做人工 smoke。
- 发布前按项目惯例运行 `bun test`、`bun run build`，再执行版本 bump、tag、npm/GitHub Packages 发布和 GitHub Release 流程。

### Common Patterns
- 根入口保持很薄：`cli.ts` 处理首次配置和 PID guard，`daemon.ts` 负责 WS/event loop，核心业务下沉到 `src/`。
- `Session` 是一个群的状态机；跨群状态只通过 session registry、持久 map、Feishu chat 绑定、模型选择 map 和 `work/*` 分支约定协调。
- `cardkit` 负责每张卡的 sequence、队列、限流和写失败检测；session 负责什么时候开卡、换卡、关闭卡。
- 所有 shell 命令卡片展示依赖第一行 `# desc:` 风格说明，修改相关展示逻辑时同步看 `src/cards/turn.ts`。

## Dependencies

### Internal
- `daemon.ts` 依赖 `src/session.ts`、`src/feishu.ts`、`src/config.ts`、`src/paths.ts` 和 `src/notify.ts` 完成启动和事件路由。
- `src/cards.ts` 是卡片模板 barrel，`src/session.ts` 和 `src/session-*` 辅助模块都通过它访问 Card Kit schema。
- `scripts/` 直接导入 `src/` 模块执行真实环境测试，运行前需要有效 `config.toml`。

### External
- `@larksuiteoapi/node-sdk`：飞书/Lark `Client`、`WSClient` 和事件分发。
- Bun：源码运行、测试和构建。
- Node.js >= 18：发布包运行环境。
- `codex` CLI：需要已通过 ChatGPT 登录，daemon 会启动 `codex app-server`。
- Feishu Open Platform：IM、群创建/解散、群成员读写、reaction、附件、Card Kit v1、tenant token API。
- systemd user service：长期运行部署时常用，但只有用户明确要求时才操作。

<!-- MANUAL: Add manually maintained notes below this line. -->

## UI Design Notes
- Card Kit 里的操作按钮要优先按手机窄屏设计；高频、重复出现的选择类按钮文案必须尽量短，`model`/effort 这类选择按钮固定用单字 `选`，不要写成 `选择`、`重选` 等多字按钮。
- 生产路径使用 `WSClient + EventDispatcher` 接收 `card.action.trigger`，不要依赖 handler 的 return 值更新卡片；需要改卡片时用回调里的 `open_message_id` 调 `feishu.updateCard()` 主动 patch 原消息。

## Runtime Operation Notes
- 从 Lodestar 自己承载的对话里执行 `systemctl --user restart feishu-daemon.service` / `lodestar-stop` / `restart` 这类会重启或停止当前 daemon 的命令时，工具调用显示 `aborted` 通常只是宿主进程被 SIGTERM 中断了，不代表操作失败。恢复后先用 `systemctl --user status feishu-daemon.service`、`journalctl --user -u feishu-daemon.service` 或 PID/日志确认结果，不要直接向用户汇报“重启未完成”。

## Release Checklist
- 除非用户明确要求 minor 或 major 版本，否则只把 `package.json` 版本号按 patch 递增（`+0.0.1`）。不要根据变更范围自行推断 SemVer minor/major。
- 发布前用 `bun test` 和 `bun run build` 验证。
- 提交 release bump，创建 `vX.Y.Z` tag，push `main`，再 push tag。
- 用 `npm publish --access public` 发布 npm 包。
- 同一个版本也必须发布到 GitHub Packages。临时写入项目 `.npmrc`，内容包括 `@leviyuan:registry=https://npm.pkg.github.com` 和 `//npm.pkg.github.com/:_authToken=$GH_TOKEN`；运行 `npm publish --registry=https://npm.pkg.github.com --tag latest --access public` 后删除 `.npmrc`。不要跳过 GitHub Packages。
- 始终为 tag 创建对应的 GitHub Release。本机没有安装 `gh`；使用 GitHub REST API，从 `~/.git-credentials` 读取 token，并用 `jq -n --rawfile body /tmp/notes.md ...` 构造 JSON body。
- 写 release notes 前先读取最近的 GitHub Releases，并匹配现有风格。当前 notes 是中文，使用 `## 修复` / `## 改进` 这类短章节，并以 `**Full Changelog**: https://github.com/leviyuan/lodestar/compare/vA...vB` 结尾。
- 只有用户明确要求时才重启正在运行的 user service；重启前先用 `systemctl --user list-units --all` 确认实际 unit。

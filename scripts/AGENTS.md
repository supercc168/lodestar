<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-06-12 -->

# scripts

## Purpose
`scripts/` 存放面向开发、调试、真实飞书群 smoke 和 npm 安装后的辅助脚本。这些脚本通常直接导入 `src/` 模块并复用生产配置，因此会触达真实 Feishu API、真实 Codex 登录和本机 Lodestar runtime state。

## Key Files
| File | Description |
|------|-------------|
| `smoke.ts` | 最小 smoke 驱动；列出可见群，向目标群发送预告并直接调用 `Session.onUserMessage`。 |
| `test-all.ts` | 全流程人工测试；覆盖 `kill`、`hi`、流式工具调用、`[[send: ...]]`、中途消息、入站图片、`restart` 和 `clear`。 |
| `test-inject.ts` | 通过 daemon debug unix socket 注入消息，复用真实 Feishu message id 和 `handleMessage` 路径。 |
| `test-mid-turn-rotation.ts` | 复现中途换卡场景；注入消息后截取 `daemon.log` 中的相关日志。 |
| `cardkit-probe.ts` | 对 Card Kit 创建、`id_convert`、元素 PUT 等 API 组合做真实探针。 |
| `seed-debug-ctx.ts` | 查询目标群成员并写入 `debug-context.json`，用于 debug socket 注入前的上下文种子。 |
| `postinstall.cjs` | npm 安装后尝试在真实终端启动 `lodestar-setup`；Windows/macOS/Linux 分支各自处理终端继承。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| _None_ | 此目录没有非排除子目录。 |

## For AI Agents

### Working In This Directory
- 大多数 `.ts` 脚本以 `#!/usr/bin/env bun` 运行；`postinstall.cjs` 以 Node 执行，因为它是 npm lifecycle 脚本。
- 脚本会读取与生产 daemon 相同的 `config.toml` 和 XDG runtime state；不要在脚本里硬编码凭据或写入仓库内状态。
- 真实飞书群测试可能发送可见消息、reaction、卡片和文件；新增脚本前确认它是否会影响群成员。
- `test-inject.ts` 和 `test-mid-turn-rotation.ts` 依赖 `DEBUG_SOCK_FILE`，需要 daemon 已运行且 debug context 已由 `[DEBUG]...` 或 `seed-debug-ctx.ts` 建好。

### Testing Requirements
- 修改普通脚本后至少运行 `bun test`，并按脚本用途执行对应 smoke，例如 `bun scripts/smoke.ts "<group name>"`。
- 修改 `postinstall.cjs` 后要考虑 npm 生命周期 stdio 被捕获、Windows 新窗口、Unix `/dev/tty` 三条路径。
- `test-all.ts` 会操作真实 session，运行前确保同一群没有另一个 daemon session 并发抢占。

### Common Patterns
- 脚本优先复用 `src/feishu.ts`、`src/session.ts`、`src/paths.ts` 的生产实现，而不是重写 API 调用。
- 面向人工观测的测试会先向群里发送 `🧪` 预告，便于手机端和日志对应。
- 用 `process.argv` / `Bun.argv` 读取目标群和参数；默认目标常见为 `test1`，但调用方可以覆盖。

## Dependencies

### Internal
- `smoke.ts`、`test-all.ts` 直接依赖 `src/feishu.ts` 和 `src/session.ts`。
- `test-inject.ts`、`test-mid-turn-rotation.ts` 依赖 `src/paths.ts` 中的 debug socket 和日志路径。
- `postinstall.cjs` 依赖构建产物 `dist/lodestar-setup.js`，发布前必须先 `bun run build`。

### External
- Bun：运行 TypeScript 测试脚本。
- Node.js：运行 `postinstall.cjs` 和发布包。
- Feishu Open Platform：群列表、消息、Card Kit、成员查询等真实 API。
- `codex` CLI：`Session` smoke 会启动真实 `codex app-server`。

<!-- MANUAL: Add manually maintained notes below this line. -->

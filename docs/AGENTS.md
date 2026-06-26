<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-26 | Updated: 2026-06-26 -->

# docs

## Purpose
`docs/` 存放 Lodestar 的设计备忘录（memo）：记录某个功能在实现前后的架构决策、已确认事实、与旧行为的对照和验证结果。这些 memo 是**叙述性参考**，不是规范文档；代码永远是事实源，memo 与代码冲突时以代码为准。

## Key Files
| File | Description |
|------|-------------|
| `claude-agent-backend.md` | Claude Agent SDK 后端 memo：目标、已确认事实、`AgentProcess` 接口与 `CodexProcess`/`ClaudeAgentProcess` 双后端设计、Claude model profile（`claude:glm`）、SDK 事件到 Session 事件的映射、与 Codex 行为的逐项 parity audit、差异说明和本机 smoke 验证结果。修改 `src/agent-process.ts`、`src/claude-agent-process.ts`、`src/claude-models.ts` 或 `src/glm-usage.ts` 时先读它。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| _None_ | 此目录没有非排除子目录。 |

## For AI Agents

### Working In This Directory
- memo 只描述**已落地**的架构；不要把这里当成待实现的 spec 或任务清单。
- 新增 memo 时用 `X-agent-backend.md` 这类描述性文件名，保持「目标 / 已确认事实 / 设计 / 对照 / 验证结果」的结构。
- 不要在 memo 之上再叠一层第三方 spec 文档；`docs/` 与 `AGENTS.md` 一起构成项目的事实层。

### Testing Requirements
- 纯文档目录，无测试。改 memo 不触发 `bun test`；但 memo 描述的代码改动仍按对应 `src/` 模块的测试要求执行。

### Common Patterns
- memo 会保留「验证结果」小节，记录 `bun test` 通过数、`bun run build` 产物和本机 smoke 的真实输出（如 SDK `session_id`、ask 回填路径）。
- 与 Codex 旧行为的对照逐条列出，便于后续 reviewer 判断功能是否退化。

## Dependencies

### Internal
- `claude-agent-backend.md` 对应 `src/agent-process.ts`、`src/claude-agent-process.ts`、`src/claude-models.ts`、`src/codex-process.ts`、`src/session-model.ts` 和 `src/glm-usage.ts` 的实际实现。

### External
- _None_

<!-- MANUAL: Add manually maintained notes below this line. -->

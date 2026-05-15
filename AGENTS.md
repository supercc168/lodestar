<!-- Generated: 2026-05-15 -->

# Lodestar 2.0

## Purpose

A single Bun daemon that bridges Feishu group chats to headless Claude
Code processes. One group ↔ one Claude session ↔ one streaming Feishu
Card Kit card per turn.

## Key Files

| File | Description |
|------|-------------|
| `daemon.ts` | Entry: PID guard, Lark WSClient, EventDispatcher routes messages and card actions to Sessions |
| `src/session.ts` | One per chat. Owns the ClaudeProcess and the per-turn card state machine |
| `src/claude-process.ts` | Headless `claude` subprocess wrapper + NDJSON SDK control protocol |
| `src/cardkit.ts` | Feishu Card Kit v1 wrapper: per-card sequence, Promise queue, throttled text streaming |
| `src/cards.ts` | Schema 2.0 card templates: main / permission / console / menu |
| `src/feishu.ts` | Lark client, tenant token cache, chat directory, send / patch / react / download / provision |
| `src/instructions.ts` | The channel system-prompt fragment appended to every claude launch |
| `src/log.ts` | Tiny logger appending to `<data_dir>/daemon.log` |
| `src/paths.ts` | XDG-spec path resolution (config / data dirs) with env-var overrides |
| `src/config.ts` | Reads `config.toml` at import time; exports the typed `config` object |
| `package.json` | Bun runtime, single dep `@larksuiteoapi/node-sdk` |

## For AI Agents

### Working in this directory

- Runtime is **Bun**, not Node.
- The daemon spawns `~/.local/bin/claude -p --input-format=stream-json
  --output-format=stream-json …`. Do not reintroduce tmux, MCP, JSONL
  queues, or any 1.x mechanism.
- All state lives outside the repo, under XDG dirs (`~/.config/lodestar/`
  for `config.toml`, `~/.local/share/lodestar/` for runtime state).
  Credentials live in `config.toml` and must never be committed.
- `cardkit.streamText` is throttled by `streamTextThrottled` — call the
  throttled helper from event handlers, never the raw one.
- No fallbacks. On API failure, log + surface; do not silently switch
  transports.

### Testing

- Smoke: `bun daemon.ts` then send a text in a bound Feishu group.
- See `CLAUDE.md` for the manual smoke checklist.

## Dependencies

### External

- `@larksuiteoapi/node-sdk` — Lark Client + WSClient

### System

- Bun (≥ 1.0)
- `~/.local/bin/claude` (Claude Code CLI), authenticated via
  `claude auth login`

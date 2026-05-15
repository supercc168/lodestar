# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Lodestar 2.0** — a single Bun daemon that bridges Feishu (Lark) group
chats to headless Claude Code processes via the official `stream-json`
SDK control protocol on the Claude side and Feishu Card Kit v1 streaming
on the IM side.

This is a complete rewrite of Lodestar 1.x. There is no longer a `tmux`
session, no MCP server, no JSONL message queue, no screen-scraping, and
no email worker. If you find any reference to those, it is stale and
should be removed.

## Architecture in one paragraph

`daemon.ts` boots a Lark WebSocket, then for each Feishu group it owns a
`Session` (`src/session.ts`) which owns one `ClaudeProcess`
(`src/claude-process.ts`) and one streaming card per turn (rendered via
`src/cardkit.ts` + `src/cards.ts`). User messages go in as `user`
control-protocol messages on Claude's stdin. Claude's stdout flows
`assistant` text deltas, `tool_use`, `tool_result`, and
`control_request:can_use_tool` for permissions. Each turn opens a fresh
Card Kit entity in `streaming_mode`, gets typewriter-PUT updates, and
flips `streaming_mode` off on `result`.

## Conventions

- **Group name = working directory name = session name** under `$HOME`.
  This binding is load-bearing; do not change it.
- **One Feishu chat ↔ one Claude headless process** at a time. A new
  inbound message during an in-flight turn sends `Interrupt` and starts a
  new turn card.
- **No fallbacks.** When Card Kit or Claude or Lark fails, log it and
  surface the failure (red footer / error toast). Do not silently retry
  with a different transport. See the global no_fallbacks rule.
- **Card Kit `sequence` is monotonically increasing per `card_id`**.
  `src/cardkit.ts` enforces this with a per-card Promise queue; never
  bypass it.
- **Streaming text** is throttled in `src/cardkit.ts` (120ms window or
  32-char delta). Do not call `streamText` directly from Claude event
  handlers; use `streamTextThrottled`.

## Build / run

```bash
bun install
bun daemon.ts        # foreground, logs to stderr + <data_dir>/daemon.log
```

Bun is the runtime, not Node. There is no separate build step; the daemon
runs `daemon.ts` directly.

## State (XDG layout)

- **Config** — `~/.config/lodestar/config.toml` (overridable via
  `LODESTAR_CONFIG` or `LODESTAR_CONFIG_DIR`; honors `XDG_CONFIG_HOME`).
  Sections: `[feishu] app_id app_secret`, `[runtime] projects_root`.
- **Data dir** — `~/.local/share/lodestar/` (overridable via
  `LODESTAR_DATA_DIR`; honors `XDG_DATA_HOME`). Holds:
  - `daemon.pid` — single-instance lock
  - `daemon.log` — append-only run log
  - `session-chat-map.json` — sessionName → chat_id binding (handles
    duplicate group names)
  - `inbox/` — downloaded image / file attachments

Path resolution lives in `src/paths.ts`; config parsing in `src/config.ts`.
Do not hard-code paths elsewhere — always import from `paths.ts`.

## Dependencies

- `@larksuiteoapi/node-sdk` — Lark Client + WSClient + EventDispatcher

That is the entire production dependency list. The previous deps
(`@modelcontextprotocol/sdk`, `imapflow`, `nodemailer`, `mailparser`,
`zod`) are gone; do not reintroduce them.

## Tests / smoke

There is currently no test suite. The smoke test is:

1. `bun daemon.ts` — verify the WS handshake line in `daemon.log`.
2. Send `hi` (or any text) in a bound Feishu group → expect a streaming
   card with the standard four elements (user_input panel, thinking,
   assistant, footer).
3. Have Claude attempt a tool that needs permission (rare under the
   default `bypassPermissions` mode — try `permissionMode: 'default'`
   to force it). Expect the existing tool panel in the turn card to
   morph into a 🔐 awaiting-approval state with three inline buttons.
   Clicking one `replaceElement`-updates the same panel and forwards
   the decision via the `can_use_tool` control_response (schema:
   `{behavior:'allow', updatedInput:{}}` or `{behavior:'deny', message}`).

## Reference

The `stream-json` SDK control protocol is documented at
https://docs.anthropic.com/en/docs/claude-code/sdk — read it before
modifying `src/claude-process.ts`.

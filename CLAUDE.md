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

## Tests / debug injection

There is no automated test suite — the harness is a debug-inject path
that replays messages through the **same** `handleMessage` entry the
WS dispatcher uses, so behavior is identical to a real Feishu send.

**One-time seed** (per chat you want to test against): from that
Feishu group, send a single `[DEBUG]<anything>` text — e.g.
`[DEBUG]hi`. The daemon strips `[DEBUG]`, processes the remainder
normally, and writes `chat_id` + `sender_open_id` to
`~/.local/share/lodestar/debug-context.json`. This survives daemon
restarts; re-seed only when switching test groups.

**Inject from CLI** — `scripts/test-inject.ts` POSTs JSON to the
daemon's unix socket (`~/.local/share/lodestar/debug.sock`, mode
`0600`). Each call constructs a payload structurally identical to a
real `im.message.receive_v1` event (real chat_id + sender, synthetic
`message_id` like `om_DEBUG_<ts>_<rand>`) and the daemon routes it
through the exact same handler:

```bash
bun scripts/test-inject.ts "hi"                  # single message
bun scripts/test-inject.ts "1" "2" "3"           # 3 msgs, 200ms gap
bun scripts/test-inject.ts --delay 0 "a" "b"     # back-to-back (race test)
bun scripts/test-inject.ts --delay 50 "1" "2" "3" "4"   # rapid mid-turn
```

The standing test target is the **`test1`** group bound to
`/home/leviyuan/test1`. Use it instead of the `feishu` self-hosting
group to avoid disrupting the active dogfooding session.

Recommended scenarios to exercise (each catches a class of regressions):

- **mid-turn rotation** — send `"1"`, wait for assistant text to start,
  inject `"2"`. Expect: old card footer flips to `📨 转交新卡` on next
  `result`, new card opens on next `init` (SDK turn boundary).
- **batch dequeue** — `--delay 0 "1" "2" "3"`. SDK merges into one
  batch turn; expect a single new card carrying all three as separate
  `<u>...</u>` items.
- **bootstrap race** — kill the Claude subprocess (`kill` command in the
  group), then `--delay 50 "M0" "M1" "M2"`. First message spawns, next
  two arrive before `init`; expect all three to be recognized as
  mid-turn and wrapped in `<u>...</u>`.
- **abandoned-batch GC** — trigger `AskUserQuestion`, then while SDK
  is awaiting answer, inject another message that the SDK should drop
  (`QUEUE remove`). Expect `pendingUserMessageCount` to not get stuck
  at >0 — GC clears it on next `onUserMessage` when SDK is idle.

Watch `journalctl --user -u feishu-daemon -f` and the live card in
Feishu side-by-side; the daemon logs the inject (`debug: inject text=…
fake_id=om_DEBUG_…`) so you can correlate events.

Permission UX still needs a real Feishu click — flip
`permissionMode: 'default'` in `claude-process.ts` to force the
🔐 panel and tap one of the three inline buttons.

## Reference

The `stream-json` SDK control protocol is documented at
https://docs.anthropic.com/en/docs/claude-code/sdk — read it before
modifying `src/claude-process.ts`.

<!-- Generated: 2026-05-15 -->

# Lodestar 2.0

## Purpose

A single Bun daemon that bridges Feishu group chats to headless Codex
app-server processes. One group ↔ one Codex thread ↔ one streaming Feishu
Card Kit card per turn.

## Key Files

| File | Description |
|------|-------------|
| `daemon.ts` | Entry: PID guard, Lark WSClient, EventDispatcher routes messages and card actions to Sessions |
| `src/session.ts` | One per chat. Owns the CodexProcess and the per-turn card state machine |
| `src/codex-process.ts` | Headless `codex app-server` subprocess wrapper + JSON-RPC protocol |
| `src/cardkit.ts` | Feishu Card Kit v1 wrapper: per-card sequence, Promise queue, throttled text streaming |
| `src/cards.ts` | Schema 2.0 card templates: main / permission / console / menu |
| `src/feishu.ts` | Lark client, tenant token cache, chat directory, send / patch / react / download / provision |
| `src/instructions.ts` | The channel developer-instructions fragment sent to every Codex thread |
| `src/log.ts` | Tiny logger appending to `<data_dir>/daemon.log` |
| `src/paths.ts` | XDG-spec path resolution (config / data dirs) with env-var overrides |
| `src/config.ts` | Reads `config.toml` at import time; exports the typed `config` object |
| `package.json` | Bun runtime, single dep `@larksuiteoapi/node-sdk` |

## For AI Agents

### Working in this directory

- Runtime is **Bun**, not Node.
- The daemon spawns `codex app-server --listen stdio://` and drives the
  app-server JSON-RPC protocol. Do not reintroduce tmux, JSONL queues,
  or any 1.x mechanism.
- All state lives outside the repo, under XDG dirs (`~/.config/lodestar/`
  for `config.toml`, `~/.local/share/lodestar/` for runtime state).
  Credentials live in `config.toml` and must never be committed.
- `cardkit.streamText` is throttled by `streamTextThrottled` — call the
  throttled helper from event handlers, never the raw one.
- No fallbacks. On API failure, log + surface; do not silently switch
  transports.
- `lodestar-daemon` is the packaged daemon entry; local development normally
  runs `bun daemon.ts` or `bun run start`.
- Do not restart the running daemon unless the user explicitly asks for a
  restart/reload in that turn. After code changes, report that a restart is
  needed instead of doing it.
- Group bare-word controls are `hi`, `stop`, `kill`, `restart`, and `clear`.
- Local scripts can notify a group through `POST http://127.0.0.1:9876/notify`
  with `{project, text, level}`.

### Commands

- Install deps: `bun install`
- Start locally: `bun daemon.ts` or `bun run start`
- Build package binaries: `bun run build`
- Persistent local daemon:
  `systemd-run --user --unit=cc-feishu-lodestar --working-directory=/home/leviyuan/feishu -- /home/leviyuan/.bun/bin/bun daemon.ts`
- Inspect / stop persistent daemon:
  `systemctl --user status cc-feishu-lodestar`,
  `journalctl --user -u cc-feishu-lodestar -f`,
  `systemctl --user stop cc-feishu-lodestar`

### Release Checklist

- Bump both `package.json` version and `SERVER_INFO.version` in
  `src/mcp-server.ts`.
- Verify with `bun test` and `bun run build`.
- Commit the release bump, tag `vX.Y.Z`, push `main`, and push the tag.
- Publish npm with `npm publish --access public`.
- Also publish the same version to GitHub Packages. Temporarily write project
  `.npmrc` with `@leviyuan:registry=https://npm.pkg.github.com` and
  `//npm.pkg.github.com/:_authToken=$GH_TOKEN`, run
  `npm publish --registry=https://npm.pkg.github.com --tag latest --access public`,
  then remove `.npmrc`. Do not skip GitHub Packages.
- Always create the matching GitHub Release for the tag. `gh` is not
  installed here; use GitHub REST with the token from `~/.git-credentials`
  and build JSON bodies with `jq -n --rawfile body /tmp/notes.md ...`.
- Before writing release notes, read recent GitHub Releases and match the
  existing style. Current notes are Chinese, use short sections such as
  `## 修复` / `## 改进`, and end with
  `**Full Changelog**: https://github.com/leviyuan/lodestar/compare/vA...vB`.
- Restart the running user service only when requested; inspect the actual
  unit first with `systemctl --user list-units --all`.

### Testing

- Smoke: `bun daemon.ts` then send a text in a bound Feishu group.
- Manual smoke: send a short text, a command-running request, `hi`, and
  a `[[send: /abs/path]]` file-return request in a bound Feishu group.

## Dependencies

### External

- `@larksuiteoapi/node-sdk` — Lark Client + WSClient

### System

- Bun (≥ 1.0)
- `codex` CLI, authenticated via ChatGPT login (`codex login`)

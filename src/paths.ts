/**
 * Filesystem layout — XDG Base Directory spec, with env-var overrides.
 *
 *   Config:   $LODESTAR_CONFIG_DIR | $XDG_CONFIG_HOME/lodestar | ~/.config/lodestar
 *   Data:     $LODESTAR_DATA_DIR   | $XDG_DATA_HOME/lodestar   | ~/.local/share/lodestar
 *
 *   config.toml             — credentials + preferences (in CONFIG_DIR)
 *   daemon.pid              — single-instance lock          (in DATA_DIR)
 *   daemon.log              — append-only run log           (in DATA_DIR)
 *   session-chat-map.json   — duplicate-name routing        (in DATA_DIR)
 *   session-resume-map.json — last-known claude session_id  (in DATA_DIR)
 *   inbox/                  — downloaded attachments        (in DATA_DIR)
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()

function pickDir(envOverride: string | undefined, xdgVar: string | undefined, fallback: string): string {
  if (envOverride) return envOverride
  if (xdgVar) return join(xdgVar, 'lodestar')
  return fallback
}

export const CONFIG_DIR = pickDir(
  process.env.LODESTAR_CONFIG_DIR,
  process.env.XDG_CONFIG_HOME,
  join(HOME, '.config', 'lodestar'),
)

export const DATA_DIR = pickDir(
  process.env.LODESTAR_DATA_DIR,
  process.env.XDG_DATA_HOME,
  join(HOME, '.local', 'share', 'lodestar'),
)

export const CONFIG_FILE = process.env.LODESTAR_CONFIG ?? join(CONFIG_DIR, 'config.toml')
export const PID_FILE = join(DATA_DIR, 'daemon.pid')
export const LOG_FILE = join(DATA_DIR, 'daemon.log')
export const SESSION_CHAT_MAP_FILE = join(DATA_DIR, 'session-chat-map.json')
export const SESSION_RESUME_MAP_FILE = join(DATA_DIR, 'session-resume-map.json')
/** Marker file written at shutdown listing the session names that
 * were still alive. The next daemon boot reads it (and unlinks it)
 * to auto-revive those sessions via `restart(true)` — bridges the
 * gap between systemctl-restart killing every child Claude and
 * Lodestar's "you have to send a message to re-spawn it" default. */
export const ALIVE_MARKER_FILE = join(DATA_DIR, 'alive-on-shutdown.json')
export const INBOX_DIR = join(DATA_DIR, 'inbox')
/** Unix-socket endpoint the daemon listens on for debug message
 * injection (see scripts/test-inject.ts). A real Feishu user sends
 * a `[DEBUG]…` text once to seed `DEBUG_CTX_FILE` with chat_id +
 * sender_open_id; the injector then POSTs `{text}` here and the
 * daemon replays it through `handleMessage` as if WS had delivered
 * it. File mode 0600 — daemon-private, never network-exposed. */
export const DEBUG_SOCK_FILE = join(DATA_DIR, 'debug.sock')
export const DEBUG_CTX_FILE = join(DATA_DIR, 'debug-context.json')

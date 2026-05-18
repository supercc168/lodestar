/**
 * Read config.toml — minimal hand-rolled parser sufficient for the
 * three-section, scalar-value-only schema we expect:
 *
 *   [feishu]
 *   app_id = "cli_..."
 *   app_secret = "..."
 *
 *   [runtime]
 *   projects_root = "~/"      # optional, defaults to $HOME
 *
 *   [notify]                  # all optional
 *   bind = "127.0.0.1"        # default 127.0.0.1 (loopback only)
 *   port = 9876               # default 9876
 *
 * Loaded synchronously at import time; downstream modules read the
 * exported `config` object directly.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { CONFIG_FILE } from './paths'

export interface LodestarConfig {
  feishu: {
    app_id: string
    app_secret: string
  }
  runtime: {
    projects_root: string
  }
  notify: {
    bind: string
    port: number
  }
  /** Env vars injected into the spawned `claude` CLI subprocess.
   * Lets the setup wizard wire up DeepSeek / GLM / any anthropic-
   * compatible backend without making the user touch system env vars.
   * Empty record = no injection, claude runs under its own login. */
  claude: {
    env: Record<string, string>
  }
}

function expandTilde(v: string): string {
  return v.replace(/^~(?=\/|$)/, homedir())
}

function parseToml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { _: {} }
  let section = '_'
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|[^\\])#.*$/, '$1').trim()
    if (!line) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1].trim()
      out[section] ??= {}
      continue
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/)
    if (kv) {
      let v = kv[2].trim()
      const dq = v.startsWith('"') && v.endsWith('"')
      const sq = v.startsWith("'") && v.endsWith("'")
      if (dq || sq) {
        v = v.slice(1, -1)
        // TOML basic strings (double-quoted) get \\, \" unescaped;
        // single-quoted literal strings stay raw per TOML spec.
        // Mirror escapeTomlString() in src/setup.ts.
        if (dq) v = v.replace(/\\([\\"])/g, '$1')
      }
      out[section][kv[1]] = v
    }
  }
  return out
}

function loadConfig(): LodestarConfig {
  let raw: string
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch (e) {
    process.stderr.write(
      `lodestar: cannot read config at ${CONFIG_FILE}\n` +
      `  → 运行 \`lodestar-setup\` 走交互式向导生成 (Feishu / LLM / 工作目录)\n` +
      `  → 或手写: 设 LODESTAR_CONFIG=/path/to/config.toml 覆盖默认路径\n` +
      `    [feishu]\n    app_id = "cli_xxx"\n    app_secret = "xxx"\n\n`,
    )
    throw e
  }
  const t = parseToml(raw)
  const appId = t.feishu?.app_id
  const appSecret = t.feishu?.app_secret
  if (!appId || !appSecret) {
    throw new Error(`lodestar: ${CONFIG_FILE} is missing [feishu].app_id / [feishu].app_secret`)
  }
  const projectsRoot = expandTilde(t.runtime?.projects_root ?? homedir())
  const notifyBind = t.notify?.bind ?? '127.0.0.1'
  const notifyPortRaw = t.notify?.port ?? '9876'
  const notifyPort = Number.parseInt(notifyPortRaw, 10)
  if (!Number.isFinite(notifyPort) || notifyPort <= 0 || notifyPort > 65535) {
    throw new Error(`lodestar: [notify].port must be 1..65535, got "${notifyPortRaw}"`)
  }
  // [claude.env] 节可选 —— 空 record 就维持现状 (用户自己 claude login
  // 或从外部设过 ANTHROPIC_* env)。有内容就在 spawn claude 子进程时把
  // 这些键全部注入到子进程 env 里, 优先级覆盖 process.env。
  const claudeEnvSection = t['claude.env'] ?? {}
  const claudeEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(claudeEnvSection)) {
    if (typeof v === 'string' && v.length > 0) claudeEnv[k] = v
  }
  return {
    feishu: { app_id: appId, app_secret: appSecret },
    runtime: { projects_root: projectsRoot },
    notify: { bind: notifyBind, port: notifyPort },
    claude: { env: claudeEnv },
  }
}

export const config = loadConfig()

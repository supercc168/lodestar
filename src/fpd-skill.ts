/**
 * Auto-install the `fable-plan-dsh-exec` (fpd) skill into BOTH agent backends —
 * Codex (`~/.codex/skills/fable-plan-dsh-exec/`) and Claude Code
 * (`~/.claude/skills/fable-plan-dsh-exec/`) — plus a bare `fpd` helper command
 * under `DATA_DIR/bin`.
 *
 * fpd 是跨模型编排 skill(claude:fable 规划/审阅,deepseek dsh 执行),仓库源码
 * 位于 `.agents/skills/fable-plan-dsh-exec/`。设计镜像 imageread-skill.ts:
 *   - daemon 每次启动幂等同步,安装目录内容由 daemon 拥有(手改会被覆盖)
 *   - `LODESTAR_DISABLE_SKILL_SYNC=1` 可关闭
 *   - 内容源缺失时跳过并 log(registry 安装未随包分发 .agents 树,不报错)
 *
 * 与 imageread 的差异:
 *   - SKILL.md 无占位符,原样同步(helper 以裸命令 `fpd` 调用,路径差异交给
 *     PATH,不需要安装期替换)。
 *   - helper 是 node `.mjs` 而非 shell 脚本:bin 安装为 shim(`exec <runtime>
 *     <DATA_DIR>/bin/fpd.mjs`)+ helper 本体单一副本;skill 目录只收 SKILL.md,
 *     避免同一脚本两份副本漂移。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './log'
import { DATA_DIR } from './paths'

const SKILL_NAME = 'fable-plan-dsh-exec'
const SKILL_COMMAND = 'fpd'

export interface EnsureFpdSkillOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  /** 内容源覆盖(测试注入);缺省走 resolveFpdAssetRoot()。 */
  assetRoot?: string
  /** DATA_DIR 覆盖(测试注入);缺省走 paths.ts 的 DATA_DIR。 */
  dataDir?: string
  /** shim 的运行器(测试注入);缺省 process.execPath(daemon 的 node/bun)。 */
  runtime?: string
}

// ── paths ───────────────────────────────────────────────────────────────

export function fpdBinPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, 'bin', SKILL_COMMAND)
}

export function fpdHelperBinPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, 'bin', 'fpd.mjs')
}

function agentSkillRoots(homeDir: string): string[] {
  return [
    join(homeDir, '.codex', 'skills', SKILL_NAME),
    join(homeDir, '.claude', 'skills', SKILL_NAME),
  ]
}

/**
 * Locate the repo skill dir that ships the fpd content.
 * Dev: `<repo>/.agents/skills/fable-plan-dsh-exec` next to `src/`(或 bundle 的
 * `dist/` 侧——npm link 下两者同指向 repo 根)。
 * Registry install 不随包分发 .agents → 返回 null,调用方跳过。
 */
export function resolveFpdAssetRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // dev: src/fpd-skill.ts → ../.agents/skills/fable-plan-dsh-exec
    // bundled: dist/lodestar.js → ../.agents/skills/fable-plan-dsh-exec(package root)
    join(here, '..', '.agents', 'skills', SKILL_NAME),
    // cwd fallback (running from repo root / odd launchers)
    join(process.cwd(), '.agents', 'skills', SKILL_NAME),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'SKILL.md'))) return dir
  }
  return null
}

// ── shim body (pure, exported for tests) ────────────────────────────────

/** shim 只含路径与运行器,不含任何凭据(与 lodestar-agent wrapper 同口径)。 */
export function fpdShimBody(runtime: string, helperDest: string): string {
  return `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(helperDest)} "$@"\n`
}

// ── install helpers (mirror imageread-skill.ts) ─────────────────────────

function writeFileIfChanged(path: string, body: string, mode?: number): 'installed' | 'updated' | 'skipped' {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === body) return 'skipped'
  mkdirSync(dirname(path), { recursive: true })
  // Atomic-ish replace so a concurrent reader never sees a truncated file.
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, { mode: mode ?? 0o644 })
  if (mode != null) {
    try { chmodSync(tmp, mode) } catch { /* best-effort; Windows */ }
  }
  renameSync(tmp, path)
  if (mode != null) {
    try { chmodSync(path, mode) } catch { /* best-effort */ }
  }
  return current === null ? 'installed' : 'updated'
}

function filesEqual(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    if (sa.size !== sb.size) return false
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

function copyFileIfChanged(src: string, dest: string, mode?: number): 'installed' | 'updated' | 'skipped' {
  if (existsSync(dest) && filesEqual(src, dest)) {
    // Content matches; still ensure the executable bit is correct.
    if (mode != null) {
      try { chmodSync(dest, mode) } catch { /* best-effort */ }
    }
    return 'skipped'
  }
  mkdirSync(dirname(dest), { recursive: true })
  const existed = existsSync(dest)
  const tmp = `${dest}.tmp-${process.pid}`
  copyFileSync(src, tmp)
  if (mode != null) {
    try { chmodSync(tmp, mode) } catch { /* best-effort */ }
  }
  renameSync(tmp, dest)
  if (mode != null) {
    try { chmodSync(dest, mode) } catch { /* best-effort */ }
  }
  return existed ? 'updated' : 'installed'
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): void {
  const sep = process.platform === 'win32' ? ';' : ':'
  const current = env.PATH ?? env.Path ?? ''
  const parts = current.split(sep).filter(Boolean)
  if (parts[0] === dir) return
  env.PATH = [dir, ...parts.filter(part => part !== dir)].join(sep)
  if (process.platform === 'win32') env.Path = env.PATH
}

// ── install steps ───────────────────────────────────────────────────────

function writeSkillMd(assetRoot: string, destRoot: string): void {
  const src = join(assetRoot, 'SKILL.md')
  if (!existsSync(src)) {
    log(`fpd-skill: missing ${src}; skip SKILL.md`)
    return
  }
  const dest = join(destRoot, 'SKILL.md')
  const r = writeFileIfChanged(dest, readFileSync(src, 'utf8'))
  if (r !== 'skipped') log(`fpd-skill: ${r} ${dest}`)
}

function installBin(assetRoot: string, dataDir: string, runtime: string, env: NodeJS.ProcessEnv): void {
  const helperSrc = join(assetRoot, 'scripts', 'fpd.mjs')
  if (!existsSync(helperSrc)) {
    log(`fpd-skill: missing ${helperSrc}; skip fpd command`)
    return
  }
  const helperDest = fpdHelperBinPath(dataDir)
  const r = copyFileIfChanged(helperSrc, helperDest, 0o755)
  if (r !== 'skipped') log(`fpd-skill: ${r} helper ${helperDest}`)
  const shim = writeFileIfChanged(fpdBinPath(dataDir), fpdShimBody(runtime, helperDest), 0o700)
  if (shim !== 'skipped') log(`fpd-skill: ${shim} command ${fpdBinPath(dataDir)}`)
  prependPath(env, dirname(helperDest))
}

// ── entry ───────────────────────────────────────────────────────────────

/**
 * Sync fpd skill (SKILL.md only) into both agent backends + install the bare
 * `fpd` command. Safe to call every boot; no-op when
 * `LODESTAR_DISABLE_SKILL_SYNC=1` or the repo asset tree is absent.
 */
export function ensureFpdSkill(opts: EnsureFpdSkillOptions = {}): void {
  const env = opts.env ?? process.env
  if (env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    log('fpd-skill: sync disabled via LODESTAR_DISABLE_SKILL_SYNC, skip')
    return
  }
  const assetRoot = opts.assetRoot ?? resolveFpdAssetRoot()
  if (!assetRoot || !existsSync(join(assetRoot, 'SKILL.md'))) {
    log('fpd-skill: vendored assets not found (.agents/skills/fable-plan-dsh-exec); skip install')
    return
  }
  const home = opts.homeDir ?? homedir()
  for (const destRoot of agentSkillRoots(home)) {
    try {
      writeSkillMd(assetRoot, destRoot)
    } catch (error) {
      log(`fpd-skill: sync failed (${destRoot}): ${error}`)
    }
  }
  try {
    installBin(assetRoot, opts.dataDir ?? DATA_DIR, opts.runtime ?? process.execPath, env)
  } catch (error) {
    log(`fpd-skill: bin install failed: ${error}`)
  }
  log('fpd-skill: ready (fable-plan-dsh-exec skill + fpd command)')
}

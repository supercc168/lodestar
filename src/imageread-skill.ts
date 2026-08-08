/**
 * Auto-install the `imageread` skill into BOTH agent backends —
 * Codex (`~/.codex/skills/imageread/`) and Claude Code
 * (`~/.claude/skills/imageread/`) — plus a unified entry-point wrapper
 * at `~/.local/share/lodestar/bin/lodestar-imageread`.
 *
 * Unlike imagegen, imageread needs NO credential wrapper and NO venv:
 * it shells out to the user's already-configured `codex` CLI, whose auth
 * lives in `~/.codex/config.toml`. So this module only mirrors the
 * vendored skill tree (SKILL.md + scripts/imageread.sh + references/cli.md)
 * and copies the bash script to the unified bin path.
 *
 * Design mirrors imagegen-skill.ts / notify-skill.ts:
 *   - Idempotent sync on every daemon boot
 *   - Daemon owns installed content (hand-edits overwritten)
 *   - `LODESTAR_DISABLE_SKILL_SYNC=1` opts out
 *
 * SKILL.md is kept as a hand-authored markdown file in the repo
 * (`skills/imageread/SKILL.md`) carrying a `{{LODESTAR_IMAGEREAD_BIN}}`
 * placeholder, replaced at install time — avoids embedding a long
 * multi-mode markdown body (with CJK + backticks) inside a TS template
 * string. imagegen uses an inline skillBody() because it needs a runtime
 * `configured` status branch; imageread has no such branch.
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

const SKILL_NAME = 'imageread'

/** Placeholder in skills/imageread/SKILL.md replaced with the bin path. */
export const SKILL_BIN_PLACEHOLDER = '{{LODESTAR_IMAGEREAD_BIN}}'

/** Files mirrored verbatim from repo skills/imageread/ into each agent
 * skills dir. SKILL.md is handled separately (placeholder substitution). */
const VENDORED_RELATIVE_FILES = [
  'scripts/imageread.sh',
  'references/cli.md',
] as const

/** Vendored files that must be installed executable. */
const EXECUTABLE_RELATIVE_FILES = new Set<string>(['scripts/imageread.sh'])

// ── paths ───────────────────────────────────────────────────────────────

export function imagereadBinPath(): string {
  return join(DATA_DIR, 'bin', 'lodestar-imageread')
}

function agentSkillRoots(): string[] {
  return [
    join(homedir(), '.codex', 'skills', SKILL_NAME),
    join(homedir(), '.claude', 'skills', SKILL_NAME),
  ]
}

/**
 * Locate vendored skill assets shipped with the package.
 * Dev: `<repo>/skills/imageread` next to `src/`.
 * Installed: `<package>/skills/imageread` next to `dist/` (or cwd fallback).
 */
export function resolveImagereadAssetRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // dev: src/imageread-skill.ts → ../skills/imageread
    // bundled: dist/lodestar.js → ../skills/imageread (package root)
    join(here, '..', 'skills', 'imageread'),
    // cwd fallback (running from repo root / odd launchers)
    join(process.cwd(), 'skills', 'imageread'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'scripts', 'imageread.sh'))) return dir
  }
  return null
}

// ── skill body: read repo SKILL.md, substitute bin placeholder ──────────

/** Pure helper: substitute the bin placeholder in skill markdown source. */
export function applyImagereadSkillBody(srcMarkdown: string, binPath: string): string {
  return srcMarkdown.replaceAll(SKILL_BIN_PLACEHOLDER, binPath)
}

// ── install helpers (mirror imagegen-skill.ts, +mode support) ───────────

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

function syncTreeFromAssets(assetRoot: string, destRoot: string): number {
  let changes = 0
  for (const rel of VENDORED_RELATIVE_FILES) {
    const src = join(assetRoot, rel)
    if (!existsSync(src)) {
      log(`imageread-skill: missing vendored file ${src}`)
      continue
    }
    const dest = join(destRoot, rel)
    const mode = EXECUTABLE_RELATIVE_FILES.has(rel) ? 0o755 : undefined
    const r = copyFileIfChanged(src, dest, mode)
    if (r !== 'skipped') {
      changes++
      log(`imageread-skill: ${r} ${dest}`)
    }
  }
  return changes
}

function writeSkillMd(assetRoot: string, destRoot: string, binPath: string): void {
  const src = join(assetRoot, 'SKILL.md')
  if (!existsSync(src)) {
    log(`imageread-skill: missing ${src}; skip SKILL.md`)
    return
  }
  const body = applyImagereadSkillBody(readFileSync(src, 'utf8'), binPath)
  const dest = join(destRoot, 'SKILL.md')
  const r = writeFileIfChanged(dest, body)
  if (r !== 'skipped') log(`imageread-skill: ${r} ${dest}`)
}

function installBin(assetRoot: string): string {
  const src = join(assetRoot, 'scripts', 'imageread.sh')
  const binPath = imagereadBinPath()
  const r = copyFileIfChanged(src, binPath, 0o755)
  if (r !== 'skipped') log(`imageread-skill: ${r} bin ${binPath}`)
  return binPath
}

// ── entry ───────────────────────────────────────────────────────────────

/**
 * Sync imageread skill tree + unified bin. Safe to call every boot.
 * No-op when `LODESTAR_DISABLE_SKILL_SYNC=1`.
 */
export function ensureImagereadSkill(): void {
  if (process.env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    log('imageread-skill: sync disabled via LODESTAR_DISABLE_SKILL_SYNC, skip')
    return
  }

  const assetRoot = resolveImagereadAssetRoot()
  if (!assetRoot) {
    log('imageread-skill: vendored assets not found (skills/imageread); skip install')
    return
  }

  const binPath = imagereadBinPath()

  for (const destRoot of agentSkillRoots()) {
    try {
      syncTreeFromAssets(assetRoot, destRoot)
      writeSkillMd(assetRoot, destRoot, binPath)
    } catch (e) {
      log(`imageread-skill: sync failed (${destRoot}): ${e}`)
    }
  }

  try {
    installBin(assetRoot)
  } catch (e) {
    log(`imageread-skill: bin install failed: ${e}`)
  }

  log('imageread-skill: ready (shells out to user codex CLI; no credentials managed)')
}

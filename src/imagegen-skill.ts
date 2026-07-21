/**
 * Auto-install the Lodestar-adapted `imagegen` skill into BOTH agent
 * backends — Codex (`~/.codex/skills/imagegen/`) and Claude Code
 * (`~/.claude/skills/imagegen/`) — plus a credential-injecting wrapper
 * at `~/.local/share/lodestar/bin/lodestar-imagegen`.
 *
 * Why this exists (vs a chat model slot like `[codex.models.wuhen-img]`):
 *
 *   Main task model stays whatever the session selected (Claude / GLM /
 *   Codex). When the agent needs a bitmap, it runs the skill CLI against
 *   an *independent* Images API channel configured in `[imagegen]`.
 *   Chat traffic never routes through that channel.
 *
 * Design mirrors `notify-skill.ts`:
 *   - Idempotent sync on every daemon boot
 *   - Daemon owns installed content (hand-edits overwritten)
 *   - `LODESTAR_DISABLE_SKILL_SYNC=1` opts out of both skills
 *
 * Credential hygiene:
 *   - api_key / base_url live only in config.toml + the 0600 wrapper
 *   - NOT injected into Claude/Codex process env (avoids polluting chat
 *     OpenAI auth and leaking the image key into every Bash)
 */

import { spawnSync } from 'node:child_process'
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
import { config } from './config'
import { log } from './log'
import { DATA_DIR } from './paths'

const SKILL_NAME = 'imagegen'

/** Files mirrored from repo `skills/imagegen/` into each agent skills dir. */
const VENDORED_RELATIVE_FILES = [
  'scripts/image_gen.py',
  'scripts/remove_chroma_key.py',
  'references/cli.md',
  'references/image-api.md',
  'LICENSE.txt',
] as const

// ── paths ───────────────────────────────────────────────────────────────

export function imagegenWrapperPath(): string {
  return join(DATA_DIR, 'bin', 'lodestar-imagegen')
}

/** Dedicated venv for the imagegen CLI (`openai` SDK). Kept under DATA_DIR
 * so we never fight Homebrew/PEP 668 system Python. */
export function imagegenVenvDir(): string {
  return join(DATA_DIR, 'imagegen-venv')
}

export function imagegenVenvPython(): string {
  // Windows would be Scripts/python.exe; Lodestar imagegen wrapper is bash-first (unix).
  return join(imagegenVenvDir(), 'bin', 'python')
}

function agentSkillRoots(): string[] {
  return [
    join(homedir(), '.codex', 'skills', SKILL_NAME),
    join(homedir(), '.claude', 'skills', SKILL_NAME),
  ]
}

/**
 * Locate vendored skill assets shipped with the package.
 * Dev: `<repo>/skills/imagegen` next to `src/`.
 * Installed: `<package>/skills/imagegen` next to `dist/` (or cwd fallback).
 */
export function resolveImagegenAssetRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // dev: src/imagegen-skill.ts → ../skills/imagegen
    // bundled: dist/lodestar.js → ../skills/imagegen (package root)
    join(here, '..', 'skills', 'imagegen'),
    // cwd fallback (running from repo root / odd launchers)
    join(process.cwd(), 'skills', 'imagegen'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'scripts', 'image_gen.py'))) return dir
  }
  return null
}

// ── public status helpers ───────────────────────────────────────────────

export function imagegenConfigured(): boolean {
  return Boolean(config.imagegen.enabled && config.imagegen.apiKey)
}

// ── skill body (Lodestar-adapted, CLI-first) ────────────────────────────

function skillBody(opts: {
  wrapperPath: string
  defaultModel: string
  configured: boolean
}): string {
  const { wrapperPath, defaultModel, configured } = opts
  const statusLine = configured
    ? `Configured channel is ready (default model \`${defaultModel}\`). Credentials stay inside \`${wrapperPath}\` — do not export OPENAI_API_KEY yourself.`
    : `NOT configured yet. Tell the user to add \`[imagegen]\` (\`api_key\`, optional \`base_url\`, optional \`model\`) in \`~/.config/lodestar/config.toml\` and restart the daemon. Do not invent images or pretend generation succeeded.`

  return `---
name: ${SKILL_NAME}
description: "Generate or edit raster images via Lodestar's independent Images API channel (CLI). Use when the task needs AI-created bitmap visuals — photos, illustrations, textures, sprites, mockups, transparent cutouts, UI/product shots — and the output should be a bitmap file rather than repo-native SVG/HTML/CSS. Prefer this over switching the chat model. Do not use for extending existing SVG/icon systems or deterministic code-native graphics."
---

# imagegen (Lodestar)

Independent image generation for **any** main chat model (Claude / GLM / Codex).
Chat stays on the session's selected model; only this skill hits the Images API.

${statusLine}

## Entry point (always)

Use the Lodestar wrapper — it injects channel credentials and forwards to the
bundled \`image_gen.py\`. Never call OpenAI SDKs ad-hoc; never put keys in the shell.

\`\`\`bash
# desc: 用 lodestar-imagegen 生成图片
${wrapperPath} generate \\
  --prompt "A clean blue circle icon on white background" \\
  --size 1024x1024 \\
  --quality medium \\
  --out output/imagegen/blue-circle.png
\`\`\`

Edit an existing file:

\`\`\`bash
# desc: 用 lodestar-imagegen 编辑图片
${wrapperPath} edit \\
  --image path/to/source.png \\
  --prompt "Replace only the background with a warm sunset" \\
  --out output/imagegen/sunset-edit.png
\`\`\`

Dry-run (no network, validates args):

\`\`\`bash
# desc: dry-run 检查生图参数
${wrapperPath} generate --prompt "Test" --out /tmp/imagegen-dry.png --dry-run
\`\`\`

Defaults: model \`${defaultModel}\`, size \`auto\`, quality \`medium\`, format \`png\`.
Override model with \`--model gpt-image-1.5\` (etc.) only when needed.

## Feishu / Lodestar delivery

After a successful generate/edit:

1. Confirm the CLI printed \`Wrote <absolute-or-workspace-path>\`.
2. If the path is relative, resolve it against the project cwd to an **absolute** path.
3. Deliver with a sole-line marker (required for Feishu auto-send when not using Codex built-in ImageGeneration):

\`\`\`text
[[send: /absolute/path/to/image.png]]
\`\`\`

4. Briefly state what was generated and the saved path. Do not claim success if the CLI failed.

## When to use

- New raster assets (hero, icon draft, sprite, product shot, mockup, concept art)
- Edit an existing bitmap (background swap, object remove, style transfer)
- Transparent cutouts (see below)
- Multiple variants: one wrapper call per distinct asset (or CLI \`generate-batch\` only if user asked for batch/CLI controls)

## When not to use

- Extending existing SVG / vector icon or logo systems in-repo
- Simple shapes/diagrams better done in SVG, HTML/CSS, or canvas
- Small edits to already-editable native source files
- User clearly wants deterministic code output, not a generated bitmap

## Transparent backgrounds

Default path (no model switch):

1. Generate the subject on a flat chroma-key background (\`#00ff00\`, or \`#ff00ff\` if the subject is green).
2. Run the helper shipped next to this skill:

\`\`\`bash
# desc: 去色键得到透明底
python3 "\${HOME}/.claude/skills/imagegen/scripts/remove_chroma_key.py" \\
  --input output/imagegen/source-chroma.png \\
  --out output/imagegen/subject-alpha.png \\
  --auto-key border --soft-matte --despill
\`\`\`

(Codex sessions may use \`~/.codex/skills/imagegen/scripts/...\` — same file.)

3. Validate alpha corners; then \`[[send: ...]]\` the alpha PNG.

True native transparency (\`gpt-image-1.5 --background transparent\`) only after the user confirms, or when they already asked for native transparency / that model.

## Dependencies

- Python 3 with \`python3 -m venv\` (daemon bootstraps \`~/.local/share/lodestar/imagegen-venv\` + \`openai\` automatically)
- Network access for real generates (not for \`--dry-run\`)

If the wrapper errors about missing \`openai\` or venv, ask the user to restart the lodestar daemon (skill sync recreates the venv). Do not silently invent an image.

## Guardrails

- Prefer this skill over switching the whole session to a Codex image model slot.
- Do **not** create one-off \`gen_images.py\` runners.
- Do **not** modify \`scripts/image_gen.py\`.
- Do **not** read or print API keys from the wrapper or config.
- Project-bound assets: write under the workspace (e.g. \`output/imagegen/\`); never leave the only copy in a temp dir the user cannot find.
- Non-destructive: do not overwrite existing assets unless the user asked; use \`-v2\` / \`-edited\` siblings.
- This skill tree is daemon-managed. Hand-edits under \`~/.claude/skills/imagegen\` or \`~/.codex/skills/imagegen\` are overwritten on boot unless \`LODESTAR_DISABLE_SKILL_SYNC=1\`.

## References (installed beside this file)

- \`references/cli.md\` — full CLI flags
- \`references/image-api.md\` — Images API parameters / model sizes
- \`scripts/image_gen.py\` — implementation (invoked only via the wrapper)
`
}

// ── wrapper script (credentials stay here) ──────────────────────────────

function shellSingleQuote(value: string): string {
  // Safe for POSIX single-quoted strings: 'foo'bar' → 'foo'"'"'bar'
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function wrapperBody(opts: {
  scriptPath: string
  apiKey: string
  baseUrl?: string
  defaultModel: string
  venvPython: string
}): string {
  const { scriptPath, apiKey, baseUrl, defaultModel, venvPython } = opts
  const lines = [
    '#!/usr/bin/env bash',
    '# Auto-generated by lodestar daemon — do not hand-edit.',
    '# Injects [imagegen] credentials for scripts/image_gen.py only.',
    'set -euo pipefail',
    '',
    `SCRIPT=${shellSingleQuote(scriptPath)}`,
    `VENV_PY=${shellSingleQuote(venvPython)}`,
    `export OPENAI_API_KEY=${shellSingleQuote(apiKey)}`,
  ]
  if (baseUrl) {
    lines.push(`export OPENAI_BASE_URL=${shellSingleQuote(baseUrl)}`)
  } else {
    // Avoid inheriting a stale chat-proxy base_url from the parent shell.
    lines.push('unset OPENAI_BASE_URL || true')
  }
  lines.push(
    `export LODESTAR_IMAGEGEN_DEFAULT_MODEL=${shellSingleQuote(defaultModel)}`,
    '',
    'if [[ ! -f "$SCRIPT" ]]; then',
    '  echo "lodestar-imagegen: missing $SCRIPT (re-run lodestar daemon skill sync)" >&2',
    '  exit 127',
    'fi',
    '',
    '# Prefer the lodestar-managed venv (has `openai` SDK). Fall back to',
    '# python3 only if venv missing — may fail with ModuleNotFoundError.',
    'if [[ -x "$VENV_PY" ]]; then',
    '  PY=("$VENV_PY")',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  PY=(python3)',
    'elif command -v python >/dev/null 2>&1; then',
    '  PY=(python)',
    'else',
    '  echo "lodestar-imagegen: no python (install Python 3, restart daemon to bootstrap venv)" >&2',
    '  exit 127',
    'fi',
    '',
    '# If caller did not pass --model, prepend the configured default for',
    '# generate/edit/generate-batch. Keep it simple: only when first arg is',
    '# a known subcommand and --model is absent from argv.',
    'args=("$@")',
    'if [[ ${#args[@]} -gt 0 ]]; then',
    '  cmd="${args[0]}"',
    '  if [[ "$cmd" == "generate" || "$cmd" == "edit" || "$cmd" == "generate-batch" ]]; then',
    '    has_model=0',
    '    for a in "${args[@]}"; do',
    '      if [[ "$a" == "--model" || "$a" == --model=* ]]; then has_model=1; break; fi',
    '    done',
    '    if [[ $has_model -eq 0 ]]; then',
    '      args=("$cmd" "--model" "$LODESTAR_IMAGEGEN_DEFAULT_MODEL" "${args[@]:1}")',
    '    fi',
    '  fi',
    'fi',
    '',
    'exec "${PY[@]}" "$SCRIPT" "${args[@]}"',
    '',
  )
  return lines.join('\n')
}

/**
 * Ensure DATA_DIR/imagegen-venv exists with the `openai` package.
 * Best-effort: failures are logged; wrapper still installs and can fall
 * back to system python3.
 */
export function ensureImagegenVenv(): boolean {
  const venvDir = imagegenVenvDir()
  const py = imagegenVenvPython()
  try {
    if (!existsSync(py)) {
      log(`imagegen-skill: creating venv at ${venvDir}`)
      mkdirSync(dirname(venvDir), { recursive: true })
      // daemon 以 Node 运行(launchd → node dist/lodestar.js),不能用 Bun.spawnSync。
      const created = spawnSync('python3', ['-m', 'venv', venvDir], { encoding: 'utf8' })
      if (created.status !== 0) {
        log(
          `imagegen-skill: venv create failed code=${created.status}: ${(created.stderr || created.stdout || '').toString().trim()}`,
        )
        return false
      }
    }
    // Always try to ensure openai is present (cheap if already installed).
    const pip = spawnSync(
      py,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'openai>=1.0'],
      { encoding: 'utf8' },
    )
    if (pip.status !== 0) {
      log(
        `imagegen-skill: pip install openai failed code=${pip.status}: ${(pip.stderr || pip.stdout || '').toString().trim()}`,
      )
      return false
    }
    const check = spawnSync(py, ['-c', 'import openai; print(openai.__version__)'], {
      encoding: 'utf8',
    })
    if (check.status !== 0) {
      log(`imagegen-skill: openai import check failed: ${(check.stderr || '').toString().trim()}`)
      return false
    }
    log(`imagegen-skill: venv ok openai=${(check.stdout || '').toString().trim()} py=${py}`)
    return true
  } catch (e) {
    log(`imagegen-skill: venv bootstrap error: ${e}`)
    return false
  }
}

// ── install helpers ─────────────────────────────────────────────────────

function writeFileIfChanged(path: string, body: string, mode?: number): 'installed' | 'updated' | 'skipped' {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === body) return 'skipped'
  mkdirSync(dirname(path), { recursive: true })
  // Atomic-ish replace so a concurrent reader never sees a truncated script.
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

function copyFileIfChanged(src: string, dest: string): 'installed' | 'updated' | 'skipped' {
  if (existsSync(dest) && filesEqual(src, dest)) return 'skipped'
  mkdirSync(dirname(dest), { recursive: true })
  const existed = existsSync(dest)
  // copy via temp in dest dir
  const tmp = `${dest}.tmp-${process.pid}`
  copyFileSync(src, tmp)
  renameSync(tmp, dest)
  return existed ? 'updated' : 'installed'
}

function syncTreeFromAssets(assetRoot: string, destRoot: string): number {
  let changes = 0
  for (const rel of VENDORED_RELATIVE_FILES) {
    const src = join(assetRoot, rel)
    if (!existsSync(src)) {
      log(`imagegen-skill: missing vendored file ${src}`)
      continue
    }
    const dest = join(destRoot, rel)
    const r = copyFileIfChanged(src, dest)
    if (r !== 'skipped') {
      changes++
      log(`imagegen-skill: ${r} ${dest}`)
    }
  }
  return changes
}

function installWrapper(scriptPathForWrapper: string): string | null {
  if (!imagegenConfigured()) {
    // Still install a stub that fails loudly with config guidance —
    // so agents discover the entry point even before the user adds a key.
    const stub = [
      '#!/usr/bin/env bash',
      '# Auto-generated by lodestar daemon — [imagegen] not configured.',
      'echo "lodestar-imagegen: [imagegen] api_key not configured in ~/.config/lodestar/config.toml" >&2',
      'echo "Add:" >&2',
      'echo "  [imagegen]" >&2',
      'echo "  api_key  = \\"sk-...\\"" >&2',
      'echo "  base_url = \\"https://api.example.com\\"   # optional" >&2',
      'echo "  model    = \\"gpt-image-2\\"               # optional" >&2',
      'echo "Then restart the lodestar daemon." >&2',
      'exit 2',
      '',
    ].join('\n')
    const path = imagegenWrapperPath()
    const r = writeFileIfChanged(path, stub, 0o700)
    if (r !== 'skipped') log(`imagegen-skill: ${r} stub wrapper ${path}`)
    return path
  }

  const path = imagegenWrapperPath()
  const body = wrapperBody({
    scriptPath: scriptPathForWrapper,
    apiKey: config.imagegen.apiKey!,
    baseUrl: config.imagegen.baseUrl,
    defaultModel: config.imagegen.model,
    venvPython: imagegenVenvPython(),
  })
  const r = writeFileIfChanged(path, body, 0o700)
  if (r !== 'skipped') log(`imagegen-skill: ${r} wrapper ${path}`)
  return path
}

// ── entry ───────────────────────────────────────────────────────────────

/**
 * Sync imagegen skill + credential wrapper. Safe to call every boot.
 * No-op when `LODESTAR_DISABLE_SKILL_SYNC=1`.
 */
export function ensureImagegenSkill(): void {
  if (process.env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    log('imagegen-skill: sync disabled via LODESTAR_DISABLE_SKILL_SYNC, skip')
    return
  }

  const assetRoot = resolveImagegenAssetRoot()
  if (!assetRoot) {
    log('imagegen-skill: vendored assets not found (skills/imagegen); skip install')
    // Still try to keep wrapper honest if config exists.
    installWrapper(join(homedir(), '.claude', 'skills', SKILL_NAME, 'scripts', 'image_gen.py'))
    return
  }

  const wrapperPath = imagegenWrapperPath()
  // Canonical script path baked into wrapper: prefer claude skills copy
  // (always installed below); wrapper only needs one real path.
  const canonicalScript = join(homedir(), '.claude', 'skills', SKILL_NAME, 'scripts', 'image_gen.py')

  for (const destRoot of agentSkillRoots()) {
    try {
      syncTreeFromAssets(assetRoot, destRoot)
      const body = skillBody({
        wrapperPath,
        defaultModel: config.imagegen.model,
        configured: imagegenConfigured(),
      })
      const skillFile = join(destRoot, 'SKILL.md')
      const r = writeFileIfChanged(skillFile, body)
      if (r !== 'skipped') log(`imagegen-skill: ${r} ${skillFile}`)
    } catch (e) {
      log(`imagegen-skill: sync failed (${destRoot}): ${e}`)
    }
  }

  try {
    installWrapper(canonicalScript)
  } catch (e) {
    log(`imagegen-skill: wrapper install failed: ${e}`)
  }

  // Bootstrap venv whenever skill sync runs so first generate does not
  // depend on system site-packages (PEP 668 / Homebrew).
  ensureImagegenVenv()

  if (imagegenConfigured()) {
    log(
      `imagegen-skill: ready model=${config.imagegen.model}` +
        (config.imagegen.baseUrl ? ` base_url=${config.imagegen.baseUrl}` : ' base_url=(default)'),
    )
  } else {
    log('imagegen-skill: installed skill stubs; set [imagegen] api_key to enable')
  }
}

/** Test helper: build skill markdown without touching disk. */
export function buildImagegenSkillBodyForTest(opts: {
  wrapperPath: string
  defaultModel: string
  configured: boolean
}): string {
  return skillBody(opts)
}

/** Test helper: build wrapper script body without touching disk. */
export function buildImagegenWrapperBodyForTest(opts: {
  scriptPath: string
  apiKey: string
  baseUrl?: string
  defaultModel: string
  venvPython?: string
}): string {
  return wrapperBody({
    ...opts,
    venvPython: opts.venvPython ?? '/tmp/imagegen-venv/bin/python',
  })
}

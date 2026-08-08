import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyImagereadSkillBody,
  resolveImagereadAssetRoot,
  SKILL_BIN_PLACEHOLDER,
} from './imageread-skill'

describe('resolveImagereadAssetRoot', () => {
  test('finds vendored skills/imageread next to the repo src/', () => {
    const root = resolveImagereadAssetRoot()
    expect(root).toBeTruthy()
    expect(existsSync(join(root!, 'scripts', 'imageread.sh'))).toBe(true)
    expect(existsSync(join(root!, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root!, 'references', 'cli.md'))).toBe(true)
  })
})

describe('applyImagereadSkillBody', () => {
  test('substitutes the bin placeholder with the real bin path', () => {
    const body = applyImagereadSkillBody(
      `run ${SKILL_BIN_PLACEHOLDER} -i x.png`,
      '/home/u/.local/share/lodestar/bin/lodestar-imageread',
    )
    expect(body).not.toContain(SKILL_BIN_PLACEHOLDER)
    expect(body).toContain('/home/u/.local/share/lodestar/bin/lodestar-imageread -i x.png')
  })

  test('real SKILL.md carries the placeholder and renders all four modes after substitution', () => {
    const root = resolveImagereadAssetRoot()
    expect(root).toBeTruthy()
    const src = readFileSync(join(root!, 'SKILL.md'), 'utf8')
    // source ships the placeholder (proves install will inject the path)
    expect(src).toContain(SKILL_BIN_PLACEHOLDER)

    const rendered = applyImagereadSkillBody(src, '/tmp/lodestar-imageread')
    expect(rendered).not.toContain(SKILL_BIN_PLACEHOLDER)
    expect(rendered).toContain('name: imageread')
    expect(rendered).toContain('/tmp/lodestar-imageread')
    // all four preset modes present
    expect(rendered).toContain('-m ui-replicate')
    expect(rendered).toContain('-m ocr')
    expect(rendered).toContain('-m diff')
    // privacy reminder + codex mention
    expect(rendered).toMatch(/第三方|third-?party/i)
    expect(rendered).toContain('codex')
    // imageread returns text, NOT an image: description says so, and the body
    // explicitly tells the agent NOT to use imagegen's [[send:]] image marker.
    expect(rendered).toContain('Returns text analysis, NOT an image')
    expect(rendered).toContain('不产图片')
  })
})

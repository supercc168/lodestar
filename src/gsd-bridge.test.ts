import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearPlanningBridge,
  clearWorkstreamRoute,
  ensureWorkstreamRoute,
  normalizeTaskSlug,
  planningHealth,
  planningRoot,
  workstreamRoute,
} from './gsd-bridge'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gsd-bridge-'))
  mkdirSync(join(root, '.gsd', 'demo-task', '.planning'), { recursive: true })
  writeFileSync(join(root, '.gsd', 'PROJECT.md'), '# shared\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('gsd-bridge workstream routing', () => {
  test('rejects task slugs that could escape the workstream root', () => {
    expect(() => normalizeTaskSlug('../outside')).toThrow(/invalid GSD task slug/)
    expect(() => ensureWorkstreamRoute(root, '../outside')).toThrow(/invalid GSD task slug/)
    expect(existsSync(join(root, 'outside'))).toBe(false)
  })

  test('keeps root .planning stable and routes each task independently', () => {
    ensureWorkstreamRoute(root, 'demo-task')
    mkdirSync(join(root, '.gsd', 'other', '.planning'), { recursive: true })
    ensureWorkstreamRoute(root, 'other')

    expect(lstatSync(planningRoot(root)).isDirectory()).toBe(true)
    expect(lstatSync(planningRoot(root)).isSymbolicLink()).toBe(false)
    expect(planningHealth(root).kind).toBe('directory')
    expect(planningHealth(root, 'demo-task').ok).toBe(true)
    expect(planningHealth(root, 'other').ok).toBe(true)

    writeFileSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'), 'demo\n')
    writeFileSync(join(root, '.gsd', 'other', '.planning', 'STATE.md'), 'other\n')
    expect(readFileSync(join(workstreamRoute(root, 'demo-task'), 'STATE.md'), 'utf8')).toBe('demo\n')
    expect(readFileSync(join(workstreamRoute(root, 'other'), 'STATE.md'), 'utf8')).toBe('other\n')
  })

  test('exposes shared PROJECT.md as the same hard-linked file', () => {
    ensureWorkstreamRoute(root, 'demo-task')
    const canonical = statSync(join(root, '.gsd', 'PROJECT.md'))
    const route = statSync(join(root, '.planning', 'PROJECT.md'))
    expect(route.dev).toBe(canonical.dev)
    expect(route.ino).toBe(canonical.ino)
  })

  test('migrates a legacy root .planning link without deleting canonical data', () => {
    const canonical = join(root, '.gsd', 'demo-task', '.planning')
    writeFileSync(join(canonical, 'STATE.md'), 'keep\n')
    symlinkSync(canonical, planningRoot(root), process.platform === 'win32' ? 'junction' : 'dir')

    ensureWorkstreamRoute(root, 'demo-task')

    expect(lstatSync(planningRoot(root)).isDirectory()).toBe(true)
    expect(lstatSync(planningRoot(root)).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(canonical, 'STATE.md'), 'utf8')).toBe('keep\n')
    expect(planningHealth(root, 'demo-task').ok).toBe(true)
  })

  test('preserves a real root directory and rejects a conflicting shared PROJECT', () => {
    mkdirSync(planningRoot(root), { recursive: true })
    writeFileSync(join(planningRoot(root), 'keep.md'), 'keep\n')
    writeFileSync(join(planningRoot(root), 'PROJECT.md'), '# different\n')

    expect(() => ensureWorkstreamRoute(root, 'demo-task')).toThrow(/PROJECT\.md differs/)
    expect(readFileSync(join(planningRoot(root), 'keep.md'), 'utf8')).toBe('keep\n')
    expect(readFileSync(join(planningRoot(root), 'PROJECT.md'), 'utf8')).toBe('# different\n')
  })

  test('clearWorkstreamRoute removes only the requested route', () => {
    ensureWorkstreamRoute(root, 'demo-task')
    mkdirSync(join(root, '.gsd', 'other', '.planning'), { recursive: true })
    ensureWorkstreamRoute(root, 'other')

    clearWorkstreamRoute(root, 'demo-task')
    expect(existsSync(workstreamRoute(root, 'demo-task'))).toBe(false)
    expect(existsSync(workstreamRoute(root, 'other'))).toBe(true)
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning'))).toBe(true)
    expect(existsSync(planningRoot(root))).toBe(true)
  })

  test('legacy clearPlanningBridge leaves stable directories untouched', () => {
    ensureWorkstreamRoute(root, 'demo-task')
    clearPlanningBridge(root)
    expect(existsSync(planningRoot(root))).toBe(true)
    if (process.platform !== 'win32') {
      expect(readlinkSync(workstreamRoute(root, 'demo-task'))).toContain('.gsd/demo-task/.planning')
    }
  })
})

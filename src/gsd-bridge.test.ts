// src/gsd-bridge.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { platform, tmpdir } from 'node:os'
import {
  ensureTaskPlanningDir,
  switchActivePlanning,
  planningHealth,
  clearPlanningBridge,
} from './gsd-bridge'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gsd-bridge-'))
  mkdirSync(join(root, '.gsd', 'demo-task'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('gsd-bridge', () => {
  test('switchActivePlanning creates symlink to task .planning', () => {
    const health = switchActivePlanning(root, 'demo-task')
    expect(health.ok).toBe(true)
    expect(existsSync(join(root, '.planning'))).toBe(true)
    const st = lstatSync(join(root, '.planning'))
    if (platform() === 'win32') {
      // Junctions present as directories on Windows.
      expect(st.isDirectory()).toBe(true)
    } else {
      expect(st.isSymbolicLink()).toBe(true)
    }
    // canonical dir exists
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning'))).toBe(true)
    writeFileSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'), '# ok\n')
    expect(existsSync(join(root, '.planning', 'STATE.md'))).toBe(true)
  })

  test('switchActivePlanning replaces previous link', () => {
    switchActivePlanning(root, 'demo-task')
    mkdirSync(join(root, '.gsd', 'other'), { recursive: true })
    switchActivePlanning(root, 'other')
    writeFileSync(join(root, '.gsd', 'other', '.planning', 'STATE.md'), 'b\n')
    expect(existsSync(join(root, '.planning', 'STATE.md'))).toBe(true)
    // old canonical untouched
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning'))).toBe(true)
  })

  test('refuses to replace real non-link .planning directory', () => {
    mkdirSync(join(root, '.planning'))
    writeFileSync(join(root, '.planning', 'keep.md'), 'x')
    expect(() => switchActivePlanning(root, 'demo-task')).toThrow(/not a (symlink|junction|link)/i)
    expect(existsSync(join(root, '.planning', 'keep.md'))).toBe(true)
  })

  test('planningHealth reports missing', () => {
    expect(planningHealth(root).kind).toBe('missing')
  })

  test('clearPlanningBridge removes link only', () => {
    switchActivePlanning(root, 'demo-task')
    writeFileSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'), 's\n')
    clearPlanningBridge(root)
    expect(existsSync(join(root, '.planning'))).toBe(false)
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'))).toBe(true)
  })
})

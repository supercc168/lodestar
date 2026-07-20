import { describe, expect, test } from 'bun:test'
import {
  GSD_PANEL_STALE_MSG,
  isGsdBareword,
  validatePanelGen,
} from './session-gsd'
import type { Session } from './session'

function fakeSession(panelGen: string): Session {
  return { gsdPanelGen: panelGen } as Session
}

describe('isGsdBareword', () => {
  test('matches gsd and gsd status', () => {
    expect(isGsdBareword('gsd')).toBe(true)
    expect(isGsdBareword('GSD')).toBe(true)
    expect(isGsdBareword(' gsd ')).toBe(true)
    expect(isGsdBareword('gsd status')).toBe(true)
    expect(isGsdBareword('GSD STATUS')).toBe(true)
  })

  test('rejects non-bareword forms', () => {
    expect(isGsdBareword('gsd foo')).toBe(false)
    expect(isGsdBareword('task')).toBe(false)
    expect(isGsdBareword('')).toBe(false)
    expect(isGsdBareword('gsdstatus')).toBe(false)
  })
})

describe('validatePanelGen', () => {
  test('mismatch returns ok:false without throwing', () => {
    const s = fakeSession('gen-1')
    const result = validatePanelGen(s, 'gen-2')
    expect(result).toEqual({ ok: false, message: GSD_PANEL_STALE_MSG })
  })

  test('empty panel_gen is stale', () => {
    const s = fakeSession('gen-1')
    expect(validatePanelGen(s, '')).toEqual({ ok: false, message: GSD_PANEL_STALE_MSG })
  })

  test('match returns null', () => {
    const s = fakeSession('gen-1')
    expect(validatePanelGen(s, 'gen-1')).toBeNull()
  })
})

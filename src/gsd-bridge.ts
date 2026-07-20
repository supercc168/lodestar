import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { platform } from 'node:os'

export type BridgeHealth = {
  ok: boolean
  kind: 'symlink' | 'junction' | 'missing' | 'not-link' | 'broken'
  target?: string
}

export function planningCanonical(projectRoot: string, taskSlug: string): string {
  return join(projectRoot, '.gsd', taskSlug, '.planning')
}

export function ensureTaskPlanningDir(projectRoot: string, taskSlug: string): string {
  const dir = planningCanonical(projectRoot, taskSlug)
  mkdirSync(dir, { recursive: true })
  return dir
}

function linkPath(projectRoot: string): string {
  return join(projectRoot, '.planning')
}

function safeLstat(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function removeLinkOnly(link: string): void {
  const st = safeLstat(link)
  if (!st) return

  if (st.isSymbolicLink()) {
    unlinkSync(link)
    return
  }

  if (st.isDirectory()) {
    // Windows junction often appears as directory + reparse; try unlink first.
    // Never recursive-delete — that would wipe the canonical target.
    try {
      unlinkSync(link)
      return
    } catch {
      /* fallthrough */
    }
    try {
      rmSync(link, { recursive: false, force: true })
      return
    } catch {
      throw new Error('.planning exists and is not a symlink/junction/link')
    }
  }

  throw new Error('.planning exists and is not a symlink/junction/link')
}

export function switchActivePlanning(projectRoot: string, taskSlug: string): BridgeHealth {
  const canonical = ensureTaskPlanningDir(projectRoot, taskSlug)
  const link = linkPath(projectRoot)
  const existing = safeLstat(link)

  if (existing) {
    if (existing.isSymbolicLink()) {
      unlinkSync(link)
    } else if (existing.isDirectory()) {
      // Real directory (non-empty or empty) must not be clobbered on Unix.
      // On Windows a junction looks like a directory; removeLinkOnly tries unlink.
      if (platform() === 'win32') {
        removeLinkOnly(link)
      } else {
        throw new Error('.planning exists and is not a symlink/junction/link')
      }
    } else {
      throw new Error('.planning exists and is not a symlink/junction/link')
    }
  }

  // Prefer relative target for portability.
  let target = relative(projectRoot, canonical)
  if (!target || target === '') target = canonical

  try {
    symlinkSync(target, link, platform() === 'win32' ? 'junction' : 'dir')
  } catch {
    symlinkSync(canonical, link, platform() === 'win32' ? 'junction' : 'dir')
  }

  return planningHealth(projectRoot)
}

export function planningHealth(projectRoot: string): BridgeHealth {
  const link = linkPath(projectRoot)
  const st = safeLstat(link)
  if (!st) return { ok: false, kind: 'missing' }

  if (st.isSymbolicLink()) {
    let target: string | undefined
    try {
      target = readlinkSync(link)
    } catch {
      /* ignore */
    }
    const resolvedOk = existsSync(link) // follows link
    if (!resolvedOk) return { ok: false, kind: 'broken', target }
    return { ok: true, kind: 'symlink', target }
  }

  if (st.isDirectory()) {
    // Could be junction on win or accidental real dir.
    if (platform() === 'win32') return { ok: true, kind: 'junction' }
    return { ok: false, kind: 'not-link' }
  }

  return { ok: false, kind: 'not-link' }
}

export function clearPlanningBridge(projectRoot: string): void {
  const link = linkPath(projectRoot)
  if (!safeLstat(link)) return
  removeLinkOnly(link)
}

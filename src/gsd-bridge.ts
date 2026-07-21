import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { platform } from 'node:os'

export type BridgeHealth = {
  ok: boolean
  kind: 'symlink' | 'junction' | 'directory' | 'missing' | 'not-link' | 'broken'
  target?: string
}

export function normalizeTaskSlug(taskSlug: string): string {
  const slug = taskSlug.trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`invalid GSD task slug: ${slug || '(empty)'}`)
  }
  return slug
}

export function planningCanonical(projectRoot: string, taskSlug: string): string {
  return join(projectRoot, '.gsd', normalizeTaskSlug(taskSlug), '.planning')
}

export function ensureTaskPlanningDir(projectRoot: string, taskSlug: string): string {
  const dir = planningCanonical(projectRoot, taskSlug)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function planningRoot(projectRoot: string): string {
  return join(projectRoot, '.planning')
}

export function workstreamRoute(projectRoot: string, taskSlug: string): string {
  return join(planningRoot(projectRoot), 'workstreams', normalizeTaskSlug(taskSlug))
}

function safeLstat(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readLinkTarget(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

function isLink(path: string): boolean {
  const stat = safeLstat(path)
  return Boolean(stat?.isSymbolicLink() || readLinkTarget(path) != null)
}

function removeLinkOnly(path: string): void {
  const stat = safeLstat(path)
  if (!stat) return
  if (!isLink(path)) {
    throw new Error(`refusing to remove non-link planning route: ${path}`)
  }
  try {
    unlinkSync(path)
    return
  } catch {
    if (platform() !== 'win32') throw new Error(`failed to remove planning symlink: ${path}`)
  }
  // Windows junctions may require rmdir semantics. Never recurse through them.
  rmSync(path, { recursive: false, force: true })
}

function sameFile(left: string, right: string): boolean {
  try {
    const a = statSync(left)
    const b = statSync(right)
    if (a.dev === b.dev && a.ino === b.ino) return true
  } catch {
    return false
  }
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

function ensureSharedProjectRoute(projectRoot: string): void {
  const canonical = join(projectRoot, '.gsd', 'PROJECT.md')
  if (!existsSync(canonical)) {
    throw new Error(`shared GSD PROJECT.md missing: ${canonical}`)
  }
  const route = join(planningRoot(projectRoot), 'PROJECT.md')
  const existing = safeLstat(route)
  if (existing) {
    if (existing.isDirectory()) {
      throw new Error(`.planning/PROJECT.md exists and is a directory: ${route}`)
    }
    if (sameFile(route, canonical)) {
      // Recreate equal-but-independent files as a hard link so both paths stay one source.
      const routeStat = statSync(route)
      const canonicalStat = statSync(canonical)
      if (routeStat.dev === canonicalStat.dev && routeStat.ino === canonicalStat.ino) return
      unlinkSync(route)
    } else {
      throw new Error(`shared PROJECT.md differs from canonical: ${route}`)
    }
  }
  linkSync(canonical, route)
}

function resolvedLinkTarget(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function canonicalRealPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Ensure GSD 1.7 workstream routing for one task.
 *
 * Legacy layout migration is deliberately narrow: a root `.planning` link is
 * removed, but a real root directory is preserved because it may contain
 * shared GSD state. Canonical task data under `.gsd/<slug>/.planning` is never
 * recursively removed.
 */
export function ensureWorkstreamRoute(projectRoot: string, taskSlug: string): BridgeHealth {
  const slug = normalizeTaskSlug(taskSlug)
  const canonical = ensureTaskPlanningDir(projectRoot, slug)
  const root = planningRoot(projectRoot)
  const rootStat = safeLstat(root)
  if (rootStat && isLink(root)) removeLinkOnly(root)
  else if (rootStat && !rootStat.isDirectory()) {
    throw new Error(`.planning exists and is not a directory: ${root}`)
  }

  mkdirSync(join(root, 'workstreams'), { recursive: true })
  ensureSharedProjectRoute(projectRoot)

  const route = workstreamRoute(projectRoot, slug)
  const existing = safeLstat(route)
  if (existing) {
    if (!isLink(route)) {
      throw new Error(`workstream route exists and is not a link: ${route}`)
    }
    const actual = resolvedLinkTarget(route)
    const expected = canonicalRealPath(canonical)
    if (actual === expected) return planningHealth(projectRoot, slug)
    removeLinkOnly(route)
  }

  if (platform() === 'win32') {
    symlinkSync(canonical, route, 'junction')
  } else {
    const target = relative(dirname(route), canonical) || canonical
    symlinkSync(target, route, 'dir')
  }
  return planningHealth(projectRoot, slug)
}

/** Compatibility name retained for existing callers while semantics use workstreams. */
export function switchActivePlanning(projectRoot: string, taskSlug: string): BridgeHealth {
  return ensureWorkstreamRoute(projectRoot, taskSlug)
}

export function planningHealth(projectRoot: string, taskSlug = ''): BridgeHealth {
  const root = planningRoot(projectRoot)
  const rootStat = safeLstat(root)
  if (!rootStat) return { ok: false, kind: 'missing' }
  if (isLink(root)) {
    return { ok: false, kind: 'not-link', target: readLinkTarget(root) ?? undefined }
  }
  if (!rootStat.isDirectory()) return { ok: false, kind: 'not-link' }
  if (!taskSlug) return { ok: true, kind: 'directory', target: root }

  const slug = normalizeTaskSlug(taskSlug)
  const route = workstreamRoute(projectRoot, slug)
  const routeStat = safeLstat(route)
  if (!routeStat) return { ok: false, kind: 'missing', target: route }
  if (!isLink(route)) return { ok: false, kind: 'not-link', target: route }
  const target = readLinkTarget(route) ?? undefined
  const actual = resolvedLinkTarget(route)
  if (!actual) return { ok: false, kind: 'broken', target }
  const expected = canonicalRealPath(planningCanonical(projectRoot, slug))
  if (actual !== expected) return { ok: false, kind: 'broken', target }
  return {
    ok: true,
    kind: platform() === 'win32' ? 'junction' : 'symlink',
    target,
  }
}

export function clearWorkstreamRoute(projectRoot: string, taskSlug: string): void {
  const route = workstreamRoute(projectRoot, normalizeTaskSlug(taskSlug))
  if (!safeLstat(route)) return
  removeLinkOnly(route)
}

/**
 * Legacy compatibility: only removes a root link. A stable workstream-mode
 * `.planning` directory is intentionally retained.
 */
export function clearPlanningBridge(projectRoot: string): void {
  const root = planningRoot(projectRoot)
  if (!safeLstat(root) || !isLink(root)) return
  removeLinkOnly(root)
}

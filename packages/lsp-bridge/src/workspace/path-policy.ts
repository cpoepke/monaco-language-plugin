import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

/** True when `child` is `parent` or lies beneath it. Purely lexical: callers
 *  realpath both sides first so `..` and symlinks cannot escape. */
export function isPathInside(child: string, parent: string): boolean {
  const a = caseInsensitive ? child.toLowerCase() : child
  const b = caseInsensitive ? parent.toLowerCase() : parent
  const rel = relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * realpath that tolerates a missing tail: resolves the nearest existing
 * ancestor and re-appends the rest. Unsaved buffers and just-deleted files
 * still need a stable canonical location (macOS /tmp → /private/tmp etc.).
 */
export function realpathLenient(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return absolute
      }
      missing.push(basename(current))
      current = parent
    }
  }
}

/** The allowed root containing `realPath` (most specific wins), or null. */
export function findContainingRoot(realPath: string, roots: readonly string[]): string | null {
  let best: string | null = null
  for (const root of roots) {
    if (isPathInside(realPath, root) && (best === null || root.length > best.length)) {
      best = root
    }
  }
  return best
}

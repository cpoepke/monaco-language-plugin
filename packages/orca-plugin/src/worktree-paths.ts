import path from 'node:path'

/**
 * Pure path logic for turning an absolute file path into the
 * `{worktree: 'path:<root>', relativePath}` pair Orca's `files.open` expects.
 *
 * Why not just `path.relative`: Orca validates `relativePath` with
 * `isSafeMobileRelativePath` (no absolute paths, drive letters, empty, `.` or
 * `..` segments) and the worker may see Windows paths, so we pick the path
 * flavour from the path itself and always emit forward slashes.
 */

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/

export function isWindowsPath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value)
}

function apiFor(value: string): path.PlatformPath {
  return isWindowsPath(value) ? path.win32 : path.posix
}

/** Comparison key: normalized, no trailing separator, forward slashes; Windows
 *  paths case-folded (NTFS is case-insensitive, like Orca's own comparison). */
export function comparisonKey(value: string): string {
  const api = apiFor(value)
  let normalized = api.normalize(value.normalize('NFC'))
  if (normalized.length > 1 && /[\\/]$/.test(normalized) && !/^[A-Za-z]:[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  normalized = normalized.replace(/\\/g, '/')
  return isWindowsPath(value) ? normalized.toLowerCase() : normalized
}

/** True when `file` is strictly inside `root` (equal does not count). */
export function isInside(root: string, file: string): boolean {
  if (isWindowsPath(root) !== isWindowsPath(file)) {
    return false
  }
  const rootKey = comparisonKey(root)
  const fileKey = comparisonKey(file)
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
  return fileKey.startsWith(prefix) && fileKey.length > prefix.length
}

/** The longest root containing `file`, or null. Longest wins so a nested
 *  worktree (e.g. `repo/.worktrees/feature`) beats its parent checkout. */
export function findWorktreeRoot(file: string, roots: readonly string[]): string | null {
  let best: string | null = null
  let bestLength = -1
  for (const root of roots) {
    if (!isInside(root, file)) {
      continue
    }
    const length = comparisonKey(root).length
    if (length > bestLength) {
      best = root
      bestLength = length
    }
  }
  return best
}

/** `file` relative to `root` with `/` separators, or null when the result
 *  would not pass Orca's safe-relative-path check. */
export function toOrcaRelativePath(root: string, file: string): string | null {
  if (!isInside(root, file)) {
    return null
  }
  const api = apiFor(file)
  // Why: path.win32.relative compares case-insensitively but returns the
  // file's own casing, which is what Orca stats on disk.
  const relative = api.relative(api.normalize(root), api.normalize(file))
  const segments = relative.split(/[\\/]/)
  if (
    relative.length === 0 ||
    api.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null
  }
  return segments.join('/')
}

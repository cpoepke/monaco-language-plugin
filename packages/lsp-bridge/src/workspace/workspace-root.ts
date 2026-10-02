import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isPathInside } from './path-policy'

/** Filesystem probe, injectable so root detection stays a pure function of it. */
export type RootProbe = {
  exists(path: string): boolean
  readText(path: string): string | null
}

export const nodeRootProbe: RootProbe = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
}

export type DetectRootOptions = {
  /** Never walk above this directory (an allowed root). */
  boundary?: string
  probe?: RootProbe
}

const TS_MARKERS = ['tsconfig.json', 'jsconfig.json', 'package.json']
const PYTHON_MARKERS = [
  'pyproject.toml',
  'pyrightconfig.json',
  'setup.py',
  'setup.cfg',
  'requirements.txt'
]

/** Directories from the file's own dir upwards, stopping at the boundary
 *  (inclusive) or the filesystem root. */
function ancestors(filePath: string, boundary: string | undefined): string[] {
  const dirs: string[] = []
  let current = dirname(filePath)
  for (;;) {
    if (boundary !== undefined && !isPathInside(current, boundary)) {
      return dirs
    }
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return dirs
    }
    current = parent
  }
}

function nearestWith(dirs: readonly string[], markers: readonly string[], probe: RootProbe) {
  return dirs.find((dir) => markers.some((marker) => probe.exists(join(dir, marker)))) ?? null
}

/** Rust: a crate inside a workspace must be served from the workspace root, or
 *  rust-analyzer indexes the crate in isolation and misses sibling crates. */
function rustRoot(dirs: readonly string[], probe: RootProbe): string | null {
  let topWorkspace: string | null = null
  for (const dir of dirs) {
    const text = probe.readText(join(dir, 'Cargo.toml'))
    if (text !== null && /^\s*\[workspace\]/m.test(text)) {
      topWorkspace = dir
    }
  }
  return topWorkspace ?? nearestWith(dirs, ['Cargo.toml'], probe)
}

function languageRoot(languageId: string, dirs: readonly string[], probe: RootProbe) {
  switch (languageId) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      return nearestWith(dirs, TS_MARKERS, probe)
    case 'python':
      return nearestWith(dirs, PYTHON_MARKERS, probe)
    case 'go':
      // Why: a go.work anywhere above wins over the module's go.mod, so gopls
      // sees every module of the workspace in one session.
      return nearestWith(dirs, ['go.work'], probe) ?? nearestWith(dirs, ['go.mod'], probe)
    case 'rust':
      return rustRoot(dirs, probe)
    default:
      return null
  }
}

/**
 * Workspace root a language server should be started for, given an absolute
 * file path. Walks up from the file's directory looking for the language's
 * project markers; falls back to the nearest `.git` and then to the file's own
 * directory. Never returns a directory above `boundary`.
 */
export function detectWorkspaceRoot(
  filePath: string,
  languageId: string,
  options: DetectRootOptions = {}
): string {
  const probe = options.probe ?? nodeRootProbe
  const dirs = ancestors(filePath, options.boundary)
  return (
    languageRoot(languageId, dirs, probe) ??
    nearestWith(dirs, ['.git'], probe) ??
    dirs[0] ??
    dirname(filePath)
  )
}

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isPathInside, realpathLenient } from './path-policy'

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
  /** The user's home directory (realpath). Defaults to os.homedir(). */
  home?: string
}

let cachedHome: string | null = null

/** os.homedir(), realpath'd once (macOS/NixOS homes can be symlinks). */
export function realHomeDir(): string {
  cachedHome ??= realpathLenient(homedir())
  return cachedHome
}

/**
 * Directories a session must never be rooted at: the filesystem root, the
 * user's home directory and every ancestor of it (`/home`, `/Users`). A
 * server rooted there indexes everything the user owns, and the session root
 * doubles as the scope of `fs/readFile`, so a stray `~/package.json` or
 * `~/.git` must not widen it to the whole home directory.
 */
export function isForbiddenRoot(dir: string, home: string = realHomeDir()): boolean {
  return dirname(dir) === dir || isPathInside(home, dir)
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
 * directory. Never returns a directory above `boundary`, and never the
 * filesystem root, the home directory or an ancestor of it (markers there are
 * skipped, so the nearest marker below home wins). Null when even the file's
 * own directory is one of those.
 */
export function detectWorkspaceRoot(
  filePath: string,
  languageId: string,
  options: DetectRootOptions = {}
): string | null {
  const probe = options.probe ?? nodeRootProbe
  const home = options.home ?? realHomeDir()
  const dirs = ancestors(filePath, options.boundary).filter((dir) => !isForbiddenRoot(dir, home))
  return (
    languageRoot(languageId, dirs, probe) ?? nearestWith(dirs, ['.git'], probe) ?? dirs[0] ?? null
  )
}

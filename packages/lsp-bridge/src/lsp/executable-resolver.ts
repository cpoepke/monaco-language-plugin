import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ResolveExecutableOptions = {
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Defaults to process.env.PATH (or Path on Windows). */
  pathEnv?: string
  /** Defaults to process.env.PATHEXT; only used on Windows. */
  pathExt?: string
  /** Searched after PATH, in order. */
  extraDirs?: readonly string[]
  /** Injectable for tests; defaults to a stat + X_OK probe. */
  isExecutable?: (candidate: string, platform: NodeJS.Platform) => boolean
}

function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    // Why: Windows has no execute bit; PATHEXT already decided what runs.
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

function hasPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  return command.includes('/') || (platform === 'win32' && command.includes('\\'))
}

function windowsCandidates(base: string, pathExt: string): string[] {
  const extensions = pathExt
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
  const lowerBase = base.toLowerCase()
  // Why: `foo.cmd` given explicitly must be tried as-is; a bare `foo` only runs
  // through one of PATHEXT's extensions (an extensionless file is not runnable).
  if (extensions.some((ext) => lowerBase.endsWith(ext.toLowerCase()))) {
    return [base]
  }
  return extensions.map((ext) => base + ext.toLowerCase())
}

/**
 * Find `command` the way a shell would, without spawning one: absolute or
 * relative paths are checked directly, bare names are searched in PATH and then
 * in `extraDirs`. Returns the absolute path, or null when nothing runnable exists.
 */
export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  const isExecutable = options.isExecutable ?? defaultIsExecutable
  const pathExt = options.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  // Why: pick the path flavour from the target platform, not the host, so the
  // Windows rules are testable anywhere.
  const pathApi = platform === 'win32' ? win32 : posix
  const expand = (base: string): string[] =>
    platform === 'win32' ? windowsCandidates(base, pathExt) : [base]

  if (hasPathSeparator(command, platform)) {
    if (!pathApi.isAbsolute(command)) {
      return null
    }
    return expand(command).find((candidate) => isExecutable(candidate, platform)) ?? null
  }

  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? ''
  const separator = pathApi.delimiter
  const dirs = [
    ...pathEnv.split(separator).filter((dir) => dir.length > 0),
    ...(options.extraDirs ?? [])
  ]
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (seen.has(dir)) {
      continue
    }
    seen.add(dir)
    for (const candidate of expand(pathApi.join(dir, command))) {
      if (isExecutable(candidate, platform)) {
        return candidate
      }
    }
  }
  return null
}

/** Every `node_modules/.bin` from `startDir` up to the filesystem root, nearest
 *  first — the same lookup `npm run` performs. */
export function nodeModulesBinDirs(startDir: string): string[] {
  const dirs: string[] = []
  let current = startDir
  for (;;) {
    dirs.push(join(current, 'node_modules', '.bin'))
    const parent = dirname(current)
    if (parent === current) {
      return dirs
    }
    current = parent
  }
}

/** Where users commonly install servers without adding the dir to PATH
 *  (`go install`, `cargo install`/rustup). GUI-launched hosts often miss them. */
export function defaultExtraBinDirs(): string[] {
  const home = homedir()
  return [join(home, 'go', 'bin'), join(home, '.cargo', 'bin')]
}

/** The bridge's own node_modules/.bin chain, so servers installed as package
 *  dependencies (e.g. typescript-language-server) are found without PATH edits.
 *  Empty when the bridge is embedded somewhere without a node_modules tree. */
export function bridgeBinDirs(): string[] {
  try {
    return nodeModulesBinDirs(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return []
  }
}

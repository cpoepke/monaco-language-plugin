import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Extra directories to search for language-server binaries.
 *
 * Why: Orca launched from the macOS Dock/Finder (or a Linux desktop entry)
 * inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), and the
 * plugin worker only gets that PATH. Servers installed with Homebrew, npm -g,
 * go install, cargo, volta, bun… would be invisible, and Node-based servers
 * (typescript-language-server, pyright) also need `node` on PATH to start via
 * their `#!/usr/bin/env node` shebang. We append (never prepend) existing
 * directories so whatever PATH Orca did provide keeps priority.
 */
export type PathEnvironment = {
  platform: NodeJS.Platform
  homedir: string
  env: Readonly<Record<string, string | undefined>>
  exists?: (dir: string) => boolean
  listDir?: (dir: string) => string[]
}

export function candidateServerDirs(input: PathEnvironment): string[] {
  const listDir = input.listDir ?? safeReadDir
  const home = input.homedir
  if (input.platform === 'win32') {
    const w = path.win32
    const profile = input.env.USERPROFILE || home
    return [
      w.join(profile, 'AppData', 'Roaming', 'npm'),
      w.join(profile, 'AppData', 'Local', 'pnpm'),
      w.join(profile, 'go', 'bin'),
      // Go's MSI installer; gopls runs `go` itself to load packages.
      'C:\\Program Files\\Go\\bin',
      w.join(profile, '.cargo', 'bin'),
      w.join(profile, '.volta', 'bin'),
      w.join(profile, '.bun', 'bin'),
      w.join(profile, 'scoop', 'shims'),
      'C:\\Program Files\\nodejs'
    ]
  }
  const p = path.posix
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    p.join(home, '.local', 'bin'),
    p.join(home, 'go', 'bin'),
    // The official Go installer (macOS .pkg, Linux tarball). gopls lives in ~/go/bin but shells
    // out to `go` itself; without it every package fails to load and gopls answers nothing.
    '/usr/local/go/bin',
    p.join(home, '.cargo', 'bin'),
    p.join(home, '.volta', 'bin'),
    p.join(home, '.bun', 'bin'),
    p.join(home, '.deno', 'bin'),
    // npm global prefixes people commonly configure to avoid sudo.
    p.join(home, '.npm-global', 'bin'),
    p.join(home, '.npm-packages', 'bin'),
    p.join(home, '.local', 'share', 'pnpm'),
    p.join(home, 'Library', 'pnpm'),
    p.join(home, '.local', 'share', 'mise', 'shims'),
    p.join(home, '.asdf', 'shims'),
    p.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    '/snap/bin'
  ]
  // nvm installs one dir per Node version; take the newest.
  const nvmVersions = p.join(home, '.nvm', 'versions', 'node')
  const newestNvm = listDir(nvmVersions)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort(compareVersionsDesc)[0]
  if (newestNvm) {
    dirs.push(p.join(nvmVersions, newestNvm, 'bin'))
  }
  return dirs
}

/** PATH with every existing candidate dir appended, plus what was added. */
export function extendedPath(input: PathEnvironment): { path: string; added: string[] } {
  const exists = input.exists ?? existsSync
  const delimiter = input.platform === 'win32' ? ';' : ':'
  const current = input.env.PATH ?? input.env.Path ?? ''
  const present = new Set(current.split(delimiter).filter(Boolean))
  const added: string[] = []
  for (const dir of candidateServerDirs(input)) {
    if (!present.has(dir) && exists(dir)) {
      present.add(dir)
      added.push(dir)
    }
  }
  const parts = [current, ...added].filter((part) => part.length > 0)
  return { path: parts.join(delimiter), added }
}

/** Mutates `process.env.PATH` so both server resolution and the spawned
 *  servers (which inherit process.env) see the extra dirs. */
export function applyExtendedPath(): string[] {
  const { path: next, added } = extendedPath({
    platform: process.platform,
    homedir: homedir(),
    env: process.env
  })
  if (added.length > 0) {
    process.env.PATH = next
  }
  return added
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string): number[] => v.slice(1).split('.').map(Number)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

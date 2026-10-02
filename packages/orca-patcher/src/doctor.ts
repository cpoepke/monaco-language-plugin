import fs from 'node:fs'
import path from 'node:path'
import { type CommonOptions, createContext } from './context.js'
import { ExitCode, type ExitCodeValue } from './errors.js'

type Platform = NodeJS.Platform

export type ServerSpec = {
  language: string
  /** Executables the bridge accepts, in preference order. */
  binaries: string[]
  hint(platform: Platform): string
}

export const SERVERS: ServerSpec[] = [
  {
    language: 'TypeScript/JavaScript',
    binaries: ['typescript-language-server', 'tsgo'],
    hint: () =>
      'npm install -g typescript-language-server typescript   (or the native preview: npm install -g @typescript/native-preview)'
  },
  {
    language: 'Python',
    binaries: ['pyright-langserver', 'basedpyright-langserver'],
    hint: () => 'npm install -g pyright   (or: pipx install basedpyright)'
  },
  {
    language: 'Go',
    binaries: ['gopls'],
    hint: (p) =>
      `go install golang.org/x/tools/gopls@latest${
        p === 'darwin'
          ? '   (Go itself: brew install go)'
          : p === 'win32'
            ? '   (Go itself: winget install GoLang.Go)'
            : '   (Go itself: your distro package or https://go.dev/dl)'
      }`
  },
  {
    language: 'Rust',
    binaries: ['rust-analyzer'],
    hint: (p) =>
      `rustup component add rust-analyzer${p === 'darwin' ? '   (or: brew install rust-analyzer)' : ''}`
  }
]

export type DirInfo = { dir: string; searchedByBridge: boolean }

/**
 * Directories to look in: PATH plus the dirs the bridge adds itself (~/go/bin, ~/.cargo/bin), plus
 * common install dirs that are often missing from a GUI app's PATH (reported as a warning).
 */
export function searchDirs(platform: Platform, env: NodeJS.ProcessEnv, home: string): DirInfo[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  const pathVar = env.PATH ?? env.Path ?? ''
  const fromPath = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const bridgeExtra = [p.join(home, 'go', 'bin'), p.join(home, '.cargo', 'bin')]
  const common =
    platform === 'win32'
      ? [
          env.APPDATA ? p.join(env.APPDATA, 'npm') : null,
          env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'pnpm') : null,
          p.join(home, 'scoop', 'shims')
        ]
      : [
          p.join(home, '.local', 'bin'),
          p.join(home, '.npm-global', 'bin'),
          p.join(home, '.bun', 'bin'),
          p.join(home, '.volta', 'bin'),
          env.PNPM_HOME ?? null,
          env.GOBIN ?? null,
          env.GOPATH ? p.join(env.GOPATH, 'bin') : null,
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/home/linuxbrew/.linuxbrew/bin'
        ]
  const out: DirInfo[] = []
  const seen = new Set<string>()
  const add = (dir: string | null, searchedByBridge: boolean): void => {
    if (!dir) return
    const key = platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return
    seen.add(key)
    out.push({ dir, searchedByBridge })
  }
  for (const d of fromPath) add(d, true)
  for (const d of bridgeExtra) add(d, true)
  for (const d of common) add(d, false)
  return out
}

export function findExecutable(
  name: string,
  dirs: DirInfo[],
  platform: Platform,
  env: NodeJS.ProcessEnv,
  isFile: (p: string) => boolean = defaultIsExecutable
): { path: string; searchedByBridge: boolean } | null {
  const p = platform === 'win32' ? path.win32 : path.posix
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())]
      : ['']
  for (const { dir, searchedByBridge } of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext)
      if (isFile(candidate)) return { path: candidate, searchedByBridge }
    }
  }
  return null
}

function defaultIsExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export type DoctorEntry = {
  language: string
  found: { binary: string; path: string; searchedByBridge: boolean } | null
  hint: string
}

export type DoctorReport = {
  entries: DoctorEntry[]
  node: string | null
  exitCode: ExitCodeValue
}

export function doctor(
  options: CommonOptions & { isFile?: (p: string) => boolean } = {}
): DoctorReport {
  const ctx = createContext(options)
  const dirs = searchDirs(ctx.platform, ctx.env, ctx.homeDir)
  const entries = SERVERS.map((server): DoctorEntry => {
    for (const binary of server.binaries) {
      const hit = findExecutable(binary, dirs, ctx.platform, ctx.env, options.isFile)
      if (hit)
        return {
          language: server.language,
          found: { binary, ...hit },
          hint: server.hint(ctx.platform)
        }
    }
    return { language: server.language, found: null, hint: server.hint(ctx.platform) }
  })
  const node = findExecutable('node', dirs, ctx.platform, ctx.env, options.isFile)?.path ?? null
  const ok = entries.every((e) => e.found?.searchedByBridge)
  return { entries, node, exitCode: ok ? ExitCode.Ok : ExitCode.NeedsAction }
}

export function formatDoctor(report: DoctorReport): string {
  const lines = ['Language servers (the bridge searches PATH, ~/go/bin and ~/.cargo/bin):']
  for (const e of report.entries) {
    if (e.found?.searchedByBridge) {
      lines.push(`  ok       ${e.language.padEnd(22)} ${e.found.binary} → ${e.found.path}`)
    } else if (e.found) {
      lines.push(
        `  warning  ${e.language.padEnd(22)} ${e.found.path} is not on PATH; add ${path.dirname(e.found.path)} to PATH`
      )
    } else {
      lines.push(`  missing  ${e.language.padEnd(22)} install: ${e.hint}`)
    }
  }
  const nodeBased = report.entries.some(
    (e) =>
      e.found &&
      ['typescript-language-server', 'pyright-langserver', 'basedpyright-langserver'].includes(
        e.found.binary
      )
  )
  if (nodeBased && !report.node) {
    lines.push(
      '',
      'warning: typescript-language-server/pyright need `node` on PATH, which was not found.'
    )
  }
  lines.push(
    '',
    'Note: Orca started from the Dock/Start menu may see a shorter PATH than your terminal. If a server',
    'works here but not in Orca, install it into one of the directories above or start Orca from a shell.'
  )
  return lines.join('\n')
}

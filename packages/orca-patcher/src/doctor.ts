import fs from 'node:fs'
import path from 'node:path'
import { diagnoseServers, type ServerDiagnosis, type ServerProbe } from '@mlp/lsp-bridge'
import { type CommonOptions, createContext } from './context.js'
import { ExitCode, type ExitCodeValue } from '@mlp/orca-patch-core'

type Platform = NodeJS.Platform

/**
 * One row of the report per language. The servers themselves (commands, fallback order, probe
 * commands) come from the bridge's catalog; only labels and install hints live here.
 */
export type LanguageSpec = {
  language: string
  /** A language id from the bridge's catalog. */
  catalogLanguage: string
  /** How to install the server when it is missing. */
  hint(platform: Platform): string
}

export const LANGUAGES: LanguageSpec[] = [
  {
    language: 'TypeScript/JavaScript',
    catalogLanguage: 'typescript',
    hint: () =>
      'npm install -g typescript-language-server typescript   (or the native preview: npm install -g @typescript/native-preview)'
  },
  {
    language: 'Python',
    catalogLanguage: 'python',
    hint: () => 'npm install -g pyright   (or: pipx install basedpyright)'
  },
  {
    language: 'Go',
    catalogLanguage: 'go',
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
    catalogLanguage: 'rust',
    hint: (p) =>
      `rustup component add rust-analyzer${p === 'darwin' ? '   (or: brew install rust-analyzer)' : ''}`
  }
]

/** What to do when a server is on disk but its version command fails, per bridge server id. */
const BROKEN_HINTS: Record<string, (platform: Platform) => string> = {
  'typescript-language-server': () =>
    'reinstall it: npm install -g typescript-language-server typescript',
  tsgo: () => 'reinstall it: npm install -g @typescript/native-preview',
  pyright: () => 'reinstall it: npm install -g pyright',
  basedpyright: () => 'reinstall it: pipx reinstall basedpyright',
  gopls: () => 'reinstall it: go install golang.org/x/tools/gopls@latest',
  'rust-analyzer': (p) =>
    `rustup component add rust-analyzer${p === 'darwin' ? '   (or: brew install rust-analyzer)' : ''}`
}

export function brokenHint(serverId: string, command: string, platform: Platform): string {
  return (
    BROKEN_HINTS[serverId]?.(platform) ??
    `reinstall ${command}, then run \`${command} --version\` yourself to see the error`
  )
}

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

/**
 * ok: a server works (path + version line). broken: a binary exists but its version command fails.
 * off-path: nothing the bridge can find, but one exists in a common install dir outside PATH.
 * missing: nothing found.
 */
export type DoctorStatus = 'ok' | 'broken' | 'missing' | 'off-path'

export type DoctorCandidate = {
  serverId: string
  binary: string
  status: 'ok' | 'broken' | 'missing'
  path?: string
  version?: string
  reason?: string
}

export type DoctorEntry = {
  language: string
  status: DoctorStatus
  /** The server the bridge would use (ok), the broken binary (broken) or the off-PATH one. */
  found: { binary: string; path: string; searchedByBridge: boolean } | null
  /** First line of the version command's output (ok, when the server has one). */
  version?: string
  /** Why the version command failed, with its first stderr/stdout line (broken). */
  reason?: string
  /** How to install the server (missing) or repair it (broken). */
  hint: string
  /** Every server the bridge tries for this language, in order. */
  candidates: DoctorCandidate[]
}

export type DoctorReport = {
  entries: DoctorEntry[]
  node: string | null
  /** 0 when every language has a working server; 2 when any is missing, off PATH or broken. */
  exitCode: ExitCodeValue
}

export type DoctorOptions = CommonOptions & {
  isFile?: (p: string) => boolean
  /** Runs a server's version command (default: the bridge's cached probe); `false` skips it. */
  probe?: ServerProbe | false
}

export function doctor(options: DoctorOptions = {}): DoctorReport {
  const ctx = createContext(options)
  const dirs = searchDirs(ctx.platform, ctx.env, ctx.homeDir)
  // Why: the bridge searches PATH, ~/go/bin and ~/.cargo/bin; asking it with exactly those dirs
  // makes doctor report what the bridge would do, including its version-command probe.
  const pathEnv = dirs
    .filter((d) => d.searchedByBridge)
    .map((d) => d.dir)
    .join(ctx.platform === 'win32' ? ';' : ':')
  const diagnoses = diagnoseServers({
    pathEnv,
    extraDirs: [],
    platform: ctx.platform,
    ...(ctx.env.PATHEXT ? { pathExt: ctx.env.PATHEXT } : {}),
    ...(options.isFile ? { isExecutable: options.isFile } : {}),
    ...(options.probe !== undefined ? { probe: options.probe } : {})
  })
  const entries = LANGUAGES.map((spec): DoctorEntry => {
    const mine = diagnoses.filter((d) => d.languages.includes(spec.catalogLanguage))
    return entryFor(spec, mine, dirs, ctx.platform, ctx.env, options.isFile)
  })
  const node = findExecutable('node', dirs, ctx.platform, ctx.env, options.isFile)?.path ?? null
  const ok = entries.every((e) => e.status === 'ok')
  return { entries, node, exitCode: ok ? ExitCode.Ok : ExitCode.NeedsAction }
}

function entryFor(
  spec: LanguageSpec,
  diagnoses: ServerDiagnosis[],
  dirs: DirInfo[],
  platform: Platform,
  env: NodeJS.ProcessEnv,
  isFile: ((p: string) => boolean) | undefined
): DoctorEntry {
  const candidates = diagnoses.map((d): DoctorCandidate => ({
    serverId: d.serverId,
    binary: d.command,
    status: d.status,
    ...(d.path ? { path: d.path } : {}),
    ...(d.version ? { version: d.version } : {}),
    ...(d.reason ? { reason: d.reason } : {})
  }))
  const hint = spec.hint(platform)
  // Why: first working candidate wins, exactly like the bridge's resolution.
  const working = diagnoses.find((d) => d.status === 'ok')
  if (working?.path) {
    return {
      language: spec.language,
      status: 'ok',
      found: { binary: working.command, path: working.path, searchedByBridge: true },
      ...(working.version ? { version: working.version } : {}),
      hint,
      candidates
    }
  }
  const broken = diagnoses.find((d) => d.status === 'broken')
  if (broken?.path) {
    return {
      language: spec.language,
      status: 'broken',
      found: { binary: broken.command, path: broken.path, searchedByBridge: true },
      reason: broken.reason ?? 'the version command failed',
      hint: brokenHint(broken.serverId, broken.command, platform),
      candidates
    }
  }
  for (const d of diagnoses) {
    const hit = findExecutable(d.command, dirs, platform, env, isFile)
    if (hit) {
      return {
        language: spec.language,
        status: 'off-path',
        found: { binary: d.command, ...hit },
        hint,
        candidates
      }
    }
  }
  return { language: spec.language, status: 'missing', found: null, hint, candidates }
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    'Language servers (the bridge searches PATH, ~/go/bin and ~/.cargo/bin, and runs each',
    "server's version command to check that it works):"
  ]
  for (const e of report.entries) {
    const label = e.language.padEnd(22)
    const indent = ' '.repeat(2 + 9 + 22 + 1)
    if (e.status === 'ok' && e.found) {
      lines.push(
        `  ok       ${label} ${e.found.binary} → ${e.found.path}${e.version ? `  (${e.version})` : ''}`
      )
      for (const c of e.candidates) {
        if (c.status === 'broken' && c.path) {
          lines.push(`${indent}note: ${c.binary} at ${c.path} is not working (${c.reason ?? ''})`)
        }
      }
    } else if (e.status === 'broken' && e.found) {
      lines.push(
        `  broken   ${label} ${e.found.binary} → ${e.found.path}`,
        `${indent}${e.reason ?? ''}`,
        `${indent}fix: ${e.hint}`
      )
    } else if (e.found) {
      lines.push(
        `  warning  ${label} ${e.found.path} is not on PATH; add ${path.dirname(e.found.path)} to PATH`
      )
    } else {
      lines.push(`  missing  ${label} install: ${e.hint}`)
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

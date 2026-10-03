// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { join } from 'node:path'
import { bridgeBinDirs, defaultExtraBinDirs, resolveExecutable } from './executable-resolver'
import { defaultServerProbe, type ServerProbe } from './server-probe'

export type LspServerDescriptor = {
  serverId: string
  command: string
  args: readonly string[]
  /** Cheap command that exits 0 when the server is really installed (see server-probe). */
  probeArgs?: readonly string[]
}

/** A descriptor whose command was found on disk (absolute path). */
export type ResolvedLspServer = LspServerDescriptor & { executablePath: string }

export type ServerOverride = { command: string; args?: readonly string[] }
export type ServerOverrides = Readonly<Record<string, ServerOverride>>

type LspServerCatalogEntry = {
  languages: readonly string[]
  /** Tried in order; the first command found wins. */
  candidates: readonly LspServerDescriptor[]
}

/** Servers the bridge knows how to drive. Nothing is bundled: a server is used
 *  only when its binary is already installed somewhere we look. */
export const LSP_SERVER_CATALOG: readonly LspServerCatalogEntry[] = [
  {
    languages: ['typescript', 'javascript'],
    candidates: [
      // Why: typescript-language-server (tsserver) is the mature default and
      // understands TS 5.x projects; tsgo (TS 7 native preview) is the fallback
      // for machines/repos that only ship the native compiler.
      {
        serverId: 'typescript-language-server',
        command: 'typescript-language-server',
        args: ['--stdio'],
        probeArgs: ['--version']
      },
      { serverId: 'tsgo', command: 'tsgo', args: ['--lsp', '--stdio'] }
    ]
  },
  {
    languages: ['python'],
    candidates: [
      { serverId: 'pyright', command: 'pyright-langserver', args: ['--stdio'] },
      { serverId: 'basedpyright', command: 'basedpyright-langserver', args: ['--stdio'] }
    ]
  },
  {
    languages: ['go'],
    candidates: [{ serverId: 'gopls', command: 'gopls', args: [], probeArgs: ['version'] }]
  },
  {
    languages: ['rust'],
    candidates: [
      // Why: rustup ships a rust-analyzer proxy even without the component.
      { serverId: 'rust-analyzer', command: 'rust-analyzer', args: [], probeArgs: ['--version'] }
    ]
  }
]

export function catalogLanguages(): string[] {
  return LSP_SERVER_CATALOG.flatMap((entry) => entry.languages)
}

export function catalogServerIds(): string[] {
  return LSP_SERVER_CATALOG.flatMap((entry) => entry.candidates.map((c) => c.serverId))
}

export function isCatalogLanguage(languageId: string): boolean {
  return LSP_SERVER_CATALOG.some((entry) => entry.languages.includes(languageId))
}

export type ServerResolutionContext = {
  overrides?: ServerOverrides
  /** Workspace root of the document; its node_modules/.bin is searched too. */
  projectRoot?: string
  /** Replaces the default extra dirs (~/go/bin, ~/.cargo/bin, bridge bins). */
  extraDirs?: readonly string[]
  /** Replaces process.env.PATH (tests). */
  pathEnv?: string
  /** Checks that a found binary works; `false` skips probing (tests). */
  probe?: ServerProbe | false
}

function applyOverride(
  descriptor: LspServerDescriptor,
  overrides: ServerOverrides | undefined
): LspServerDescriptor {
  const override = overrides?.[descriptor.serverId]
  if (!override) {
    return descriptor
  }
  // Why: an override is the user's explicit choice of binary; don't second-guess it.
  return {
    serverId: descriptor.serverId,
    command: override.command,
    args: override.args ?? descriptor.args
  }
}

function searchDirs(context: ServerResolutionContext): string[] {
  const projectBins = context.projectRoot ? [join(context.projectRoot, 'node_modules', '.bin')] : []
  return [...projectBins, ...(context.extraDirs ?? [...defaultExtraBinDirs(), ...bridgeBinDirs()])]
}

type Lookup = { server: ResolvedLspServer } | { server: null; broken?: string }

function lookupServer(descriptor: LspServerDescriptor, context: ServerResolutionContext): Lookup {
  const effective = applyOverride(descriptor, context.overrides)
  const executablePath = resolveExecutable(effective.command, {
    extraDirs: searchDirs(context),
    ...(context.pathEnv !== undefined ? { pathEnv: context.pathEnv } : {})
  })
  if (!executablePath) {
    return { server: null }
  }
  const probe = context.probe === undefined ? defaultServerProbe : context.probe
  if (probe && effective.probeArgs) {
    const verdict = probe(executablePath, effective.probeArgs)
    if (!verdict.ok) {
      return { server: null, broken: `${executablePath} (${verdict.reason})` }
    }
  }
  return { server: { ...effective, executablePath } }
}

export function resolveServerDescriptor(
  descriptor: LspServerDescriptor,
  context: ServerResolutionContext = {}
): ResolvedLspServer | null {
  return lookupServer(descriptor, context).server
}

export type ServerResolution = { server: ResolvedLspServer } | { server: null; reason: string }

export function resolveLspServerForLanguage(
  languageId: string,
  context: ServerResolutionContext = {}
): ServerResolution {
  const entry = LSP_SERVER_CATALOG.find((candidate) => candidate.languages.includes(languageId))
  if (!entry) {
    return { server: null, reason: `unsupported language: ${languageId}` }
  }
  const broken: string[] = []
  for (const descriptor of entry.candidates) {
    const lookup = lookupServer(descriptor, context)
    if (lookup.server) {
      return { server: lookup.server }
    }
    if (lookup.broken) {
      broken.push(lookup.broken)
    }
  }
  const tried = entry.candidates.map((c) => applyOverride(c, context.overrides).command)
  const brokenNote = broken.length > 0 ? `; found but not working: ${broken.join(', ')}` : ''
  return {
    server: null,
    reason: `no language server found for ${languageId} (looked for: ${tried.join(', ')})${brokenNote}`
  }
}

/** serverId → resolved executable (or null), for `bridge/status`. */
export function resolveAllServers(
  context: ServerResolutionContext = {}
): Record<string, string | null> {
  const servers: Record<string, string | null> = {}
  for (const entry of LSP_SERVER_CATALOG) {
    for (const descriptor of entry.candidates) {
      servers[descriptor.serverId] =
        resolveServerDescriptor(descriptor, context)?.executablePath ?? null
    }
  }
  return servers
}

/** Languages with at least one installed server, for `bridge/hello`. */
export function availableLanguages(context: ServerResolutionContext = {}): string[] {
  return catalogLanguages().filter(
    (languageId) => resolveLspServerForLanguage(languageId, context).server !== null
  )
}

/** Monaco has no react language ids (.tsx shares 'typescript'), but LSP servers
 *  key script kind off the didOpen languageId — tsserver parses a 'typescript'
 *  .tsx as plain TS and errors on every JSX element. */
export function toLspDocumentLanguageId(languageId: string, filePath: string): string {
  if (languageId === 'typescript' && /\.tsx$/i.test(filePath)) {
    return 'typescriptreact'
  }
  if (languageId === 'javascript' && /\.jsx$/i.test(filePath)) {
    return 'javascriptreact'
  }
  return languageId
}

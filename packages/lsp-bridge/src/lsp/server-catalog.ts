// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { join } from 'node:path'
import { bridgeBinDirs, defaultExtraBinDirs, resolveExecutable } from './executable-resolver'

export type LspServerDescriptor = {
  serverId: string
  command: string
  args: readonly string[]
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
        args: ['--stdio']
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
  { languages: ['go'], candidates: [{ serverId: 'gopls', command: 'gopls', args: [] }] },
  {
    languages: ['rust'],
    candidates: [{ serverId: 'rust-analyzer', command: 'rust-analyzer', args: [] }]
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
}

function applyOverride(
  descriptor: LspServerDescriptor,
  overrides: ServerOverrides | undefined
): LspServerDescriptor {
  const override = overrides?.[descriptor.serverId]
  if (!override) {
    return descriptor
  }
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

export function resolveServerDescriptor(
  descriptor: LspServerDescriptor,
  context: ServerResolutionContext = {}
): ResolvedLspServer | null {
  const effective = applyOverride(descriptor, context.overrides)
  const executablePath = resolveExecutable(effective.command, {
    extraDirs: searchDirs(context),
    ...(context.pathEnv !== undefined ? { pathEnv: context.pathEnv } : {})
  })
  return executablePath ? { ...effective, executablePath } : null
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
  for (const descriptor of entry.candidates) {
    const resolved = resolveServerDescriptor(descriptor, context)
    if (resolved) {
      return { server: resolved }
    }
  }
  const tried = entry.candidates.map((c) => applyOverride(c, context.overrides).command)
  return {
    server: null,
    reason: `no language server found for ${languageId} (looked for: ${tried.join(', ')})`
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

// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import type * as Monaco from 'monaco-editor'
import type {
  CancellationToken,
  IDisposable,
  IPosition,
  IRange,
  editor,
  languages
} from 'monaco-editor'
import {
  BridgeMethods,
  JsonRpcErrorCodes,
  type LspRequestMethod,
  type LspRequestParams
} from '@mlp/protocol'
import type { BridgeConnection } from './connection'
import { RpcError, errorMessage } from './connection'
import {
  isSameFileUri,
  lspDocumentLinkToMonaco,
  lspDocumentLinksToMonaco,
  lspDocumentSymbolsToMonaco,
  lspHoverToMonaco,
  lspLocationsFromResult,
  lspRangeToMonaco,
  toLspPosition,
  type DocumentLinkShape
} from './conversion'
import type { DocumentEntry, DocumentManager, DocumentSession } from './documents'
import type { LocationModels } from './location-models'
import type { Logger } from './logger'
import type { TypeScriptWorkerFallback } from './typescript-builtin'

export type FeatureOptions = {
  definition?: boolean
  declaration?: boolean
  typeDefinition?: boolean
  implementation?: boolean
  references?: boolean
  hover?: boolean
  documentSymbols?: boolean
  documentLinks?: boolean
  /** Markers from push (`document/diagnostics`) and pull (`textDocument/diagnostic`) diagnostics. */
  diagnostics?: boolean
}

export const DEFAULT_FEATURES: Required<FeatureOptions> = {
  definition: true,
  declaration: true,
  typeDefinition: true,
  implementation: true,
  references: true,
  hover: true,
  documentSymbols: true,
  documentLinks: true,
  diagnostics: false
}

type Model = editor.ITextModel

export type ProviderContext = {
  monaco: typeof Monaco
  connection: BridgeConnection
  documents: DocumentManager<Model>
  locations: LocationModels<Monaco.Uri>
  features: Required<FeatureOptions>
  tsFallback: TypeScriptWorkerFallback | null
  logger: Logger
}

type MonacoLink = languages.ILink & {
  mlp?: { sessionId: string; lspLink: Record<string, unknown> }
}

function cancelled(token: CancellationToken | undefined): Promise<null> {
  return new Promise((resolve) => {
    if (!token) {
      return
    }
    if (token.isCancellationRequested) {
      resolve(null)
      return
    }
    token.onCancellationRequested(() => resolve(null))
  })
}

/**
 * Sends an allowlisted LSP request for `model`. Resolves `undefined` when the
 * model has no bridge session (so callers may fall back), `null` on any failure.
 * Never rejects.
 */
async function requestForModel(
  ctx: ProviderContext,
  model: Model,
  method: LspRequestMethod,
  buildParams: (session: DocumentSession) => unknown,
  token?: CancellationToken
): Promise<
  { entry: DocumentEntry<Model>; session: DocumentSession; result: unknown } | null | undefined
> {
  const entry = ctx.documents.get(model.uri.toString())
  if (!entry) {
    return undefined
  }
  const run = async (
    retry: boolean
  ): Promise<
    { entry: DocumentEntry<Model>; session: DocumentSession; result: unknown } | null | undefined
  > => {
    // Why: ensureSession flushes the debounced change before we ask, so the server sees current text.
    const session = await ctx.documents.ensureSession(entry)
    if (!session) {
      return undefined
    }
    const params: LspRequestParams = {
      sessionId: session.sessionId,
      method,
      params: buildParams(session)
    }
    try {
      const result = await ctx.connection.request(BridgeMethods.lspRequest, params)
      return { entry, session, result }
    } catch (error) {
      if (retry && error instanceof RpcError && error.code === JsonRpcErrorCodes.SessionNotFound) {
        ctx.documents.invalidateSession(entry)
        return run(false)
      }
      ctx.logger.debug?.(`[mlp] ${method} failed: ${errorMessage(error)}`)
      return null
    }
  }
  try {
    return await Promise.race([run(true), cancelled(token)])
  } catch {
    // Why: a dead or slow server must never break editing; features simply don't answer.
    return null
  }
}

function positionParams(model: Model, position: IPosition) {
  return (session: DocumentSession) => ({
    textDocument: { uri: session.uri },
    position: toLspPosition(position)
  })
}

/** LSP locations → Monaco locations; same-file hits use the live model's URI,
 *  other files an existing model or a peek model. */
async function toMonacoLocations(
  ctx: ProviderContext,
  model: Model,
  session: DocumentSession,
  result: unknown
): Promise<languages.Location[]> {
  const modelUri = model.uri.toString()
  const lspLocations = lspLocationsFromResult(result)
  const isLocal = lspLocations.map(
    (location) => isSameFileUri(location.uri, session.uri) || isSameFileUri(location.uri, modelUri)
  )
  const others = lspLocations.filter((_, index) => !isLocal[index])
  const resolved = others.length > 0 ? await ctx.locations.resolveEach(others) : []
  // Why: keep the server's order (usually the primary definition first).
  const locations: languages.Location[] = []
  let otherIndex = 0
  lspLocations.forEach((location, index) => {
    if (isLocal[index]) {
      locations.push({ uri: model.uri, range: lspRangeToMonaco(location.range) })
      return
    }
    const target = resolved[otherIndex++]
    if (target) {
      locations.push(target)
    }
  })
  return locations
}

/** Registers the bridge-backed providers for one Monaco language id. */
export function registerLanguageProviders(ctx: ProviderContext, languageId: string): IDisposable[] {
  const { monaco, features } = ctx
  const disposables: IDisposable[] = []
  const fallback = ctx.tsFallback

  const locationProvider = (
    method: LspRequestMethod,
    useFallback: boolean,
    extraParams?: Record<string, unknown>
  ) => {
    return async (model: Model, position: IPosition, token?: CancellationToken) => {
      try {
        const response = await requestForModel(
          ctx,
          model,
          method,
          (session) => ({ ...positionParams(model, position)(session), ...extraParams }),
          token
        )
        if (response === undefined) {
          if (useFallback && fallback) {
            return method === 'textDocument/references'
              ? fallback.references(model, position)
              : fallback.definition(model, position)
          }
          return null
        }
        if (response === null || token?.isCancellationRequested) {
          return null
        }
        return await toMonacoLocations(ctx, model, response.session, response.result)
      } catch (error) {
        ctx.logger.debug?.(`[mlp] ${method} provider failed: ${errorMessage(error)}`)
        return null
      }
    }
  }

  if (features.definition) {
    const provide = locationProvider('textDocument/definition', true)
    disposables.push(
      monaco.languages.registerDefinitionProvider(languageId, {
        provideDefinition: (model, position, token) => provide(model, position, token)
      })
    )
  }
  if (features.declaration) {
    const provide = locationProvider('textDocument/declaration', false)
    disposables.push(
      monaco.languages.registerDeclarationProvider(languageId, {
        provideDeclaration: (model, position, token) => provide(model, position, token)
      })
    )
  }
  if (features.typeDefinition) {
    const provide = locationProvider('textDocument/typeDefinition', false)
    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(languageId, {
        provideTypeDefinition: (model, position, token) => provide(model, position, token)
      })
    )
  }
  if (features.implementation) {
    const provide = locationProvider('textDocument/implementation', false)
    disposables.push(
      monaco.languages.registerImplementationProvider(languageId, {
        provideImplementation: (model, position, token) => provide(model, position, token)
      })
    )
  }
  if (features.references) {
    disposables.push(
      monaco.languages.registerReferenceProvider(languageId, {
        provideReferences: (model, position, context, token) =>
          locationProvider('textDocument/references', true, {
            context: { includeDeclaration: context?.includeDeclaration ?? true }
          })(model, position, token)
      })
    )
  }
  if (features.hover) {
    disposables.push(
      monaco.languages.registerHoverProvider(languageId, {
        provideHover: async (model, position, token) => {
          try {
            const response = await requestForModel(
              ctx,
              model,
              'textDocument/hover',
              positionParams(model, position),
              token
            )
            if (response === undefined) {
              return fallback ? await fallback.hover(model, position) : null
            }
            return response ? lspHoverToMonaco(response.result) : null
          } catch {
            return null
          }
        }
      })
    )
  }
  if (features.documentSymbols) {
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(languageId, {
        displayName: 'Language server',
        provideDocumentSymbols: async (model, token) => {
          try {
            const response = await requestForModel(
              ctx,
              model,
              'textDocument/documentSymbol',
              (session) => ({ textDocument: { uri: session.uri } }),
              token
            )
            if (response === undefined) {
              return fallback
                ? ((await fallback.documentSymbols(model)) as languages.DocumentSymbol[] | null)
                : null
            }
            if (!response) {
              return null
            }
            const modelUri = model.uri.toString()
            return lspDocumentSymbolsToMonaco(
              response.result,
              (uri) => isSameFileUri(uri, response.session.uri) || isSameFileUri(uri, modelUri)
            ) as languages.DocumentSymbol[]
          } catch {
            return null
          }
        }
      })
    )
  }
  if (features.documentLinks) {
    const toMonacoLink = (link: DocumentLinkShape, sessionId: string): MonacoLink => {
      const result: MonacoLink = { range: link.range, mlp: { sessionId, lspLink: link.lspLink } }
      if (link.url) {
        result.url = link.url
      }
      if (link.tooltip) {
        result.tooltip = link.tooltip
      }
      return result
    }
    disposables.push(
      monaco.languages.registerLinkProvider(languageId, {
        provideLinks: async (model, token) => {
          try {
            const response = await requestForModel(
              ctx,
              model,
              'textDocument/documentLink',
              (session) => ({ textDocument: { uri: session.uri } }),
              token
            )
            if (!response) {
              return null
            }
            return {
              links: lspDocumentLinksToMonaco(response.result).map((link) =>
                toMonacoLink(link, response.session.sessionId)
              )
            }
          } catch {
            return null
          }
        },
        resolveLink: async (link: MonacoLink, token) => {
          try {
            if (link.url || !link.mlp) {
              return link
            }
            const params: LspRequestParams = {
              sessionId: link.mlp.sessionId,
              method: 'documentLink/resolve',
              params: link.mlp.lspLink
            }
            const resolved = await Promise.race([
              ctx.connection.request(BridgeMethods.lspRequest, params),
              cancelled(token)
            ])
            if (!resolved || typeof resolved !== 'object') {
              return null
            }
            const shape = lspDocumentLinkToMonaco(resolved as Record<string, unknown>)
            return shape.url
              ? toMonacoLink({ ...shape, range: link.range }, link.mlp.sessionId)
              : null
          } catch {
            return null
          }
        }
      })
    )
  }
  return disposables
}

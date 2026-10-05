import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  BridgeMethods,
  isAllowedLspMethod,
  JsonRpcErrorCodes,
  languageIdForPath,
  PROTOCOL_VERSION
} from '@mlp/protocol'
import type {
  BridgeStatus,
  HelloResult,
  JsonRpcId,
  OpenDocumentResult,
  OpenLocationResult,
  ReadFileResult
} from '@mlp/protocol'
import {
  availableLanguages,
  isCatalogLanguage,
  resolveLspServerForLanguage,
  toLspDocumentLanguageId
} from '../lsp/server-catalog'
import type { ServerResolutionContext } from '../lsp/server-catalog'
import {
  expectNonNegativeInteger,
  expectRecord,
  expectString,
  readStringFields
} from '../rpc/params'
import { invalidParams, pathNotAllowed, RpcError } from '../rpc/rpc-error'
import type { SessionManager } from '../sessions/session-manager'
import type { ClientId } from '../sessions/session-types'
import { findContainingRoot, realpathLenient } from '../workspace/path-policy'
import { filePathFromUri, readFileForClient } from '../workspace/read-file'
import { detectWorkspaceRoot } from '../workspace/workspace-root'
import type { NormalizedBridgeOptions } from './bridge-options'
import { BRIDGE_VERSION } from '../version'

/** Per-connection state the handlers read and update. */
export type ClientState = {
  id: ClientId
  /** Set once `bridge/hello` succeeded; every other call is refused before. */
  greeted: boolean
  closed: boolean
  /** Realpath'd roots of every session this client opened a document in. */
  usedRoots: Set<string>
  /** In-flight `lsp/request` calls by the client's JSON-RPC id (lsp/cancel). */
  pendingRequests: Map<JsonRpcId, AbortController>
}

export type BridgeContext = {
  options: NormalizedBridgeOptions
  sessions: SessionManager
  resolution: ServerResolutionContext
  /** See BridgeOptions.trustProjectBinaries. */
  trustProjectBinaries: boolean
  status: () => BridgeStatus
}

export type ClientHandlers = {
  onRequest: (method: string, params: unknown, id: JsonRpcId) => unknown
  onNotification: (method: string, params: unknown) => void
}

export function createClientHandlers(context: BridgeContext, client: ClientState): ClientHandlers {
  const { options, sessions } = context

  function hello(params: unknown): HelloResult {
    const record = expectRecord(params)
    if (record.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        JsonRpcErrorCodes.InvalidParams,
        `Unsupported protocol version ${String(record.protocolVersion)}; bridge speaks ${PROTOCOL_VERSION}`,
        { expected: PROTOCOL_VERSION }
      )
    }
    client.greeted = true
    options.logger.info('client connected', {
      clientId: client.id,
      client: typeof record.client === 'string' ? record.client : null
    })
    return {
      protocolVersion: PROTOCOL_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      availableLanguages: availableLanguages({ ...context.resolution, probe: false }),
      hostNavigation: options.hostNavigator !== null
    }
  }

  /** The allowed root containing `realPath`; null when containment is off.
   *  Throws PathNotAllowed when containment is on and no root contains it. */
  async function containingAllowedRoot(realPath: string, uri: unknown): Promise<string | null> {
    if (!options.allowedRoots) {
      return null
    }
    const roots = await options.allowedRoots({ path: realPath })
    const root = findContainingRoot(realPath, roots)
    if (root === null) {
      throw pathNotAllowed(`Path is outside every allowed root: ${String(uri)}`)
    }
    return root
  }

  async function openDocument(params: unknown): Promise<OpenDocumentResult> {
    const record = expectRecord(params)
    const uri = expectString(record.uri, 'uri')
    const languageId = expectString(record.languageId, 'languageId')
    const text = expectString(record.text, 'text')
    const realFile = realpathLenient(filePathFromUri(uri))
    const boundary = await containingAllowedRoot(realFile, uri)
    // Why: clients may send react/variant ids (typescriptreact) the catalog
    // doesn't list; the extension still tells us which server family applies.
    const language = isCatalogLanguage(languageId)
      ? languageId
      : (languageIdForPath(realFile) ?? languageId)
    if (!isCatalogLanguage(language)) {
      return { sessionId: null, reason: `unsupported language: ${languageId}`, retryable: false }
    }
    // Why: a session is rooted next to the file and its root becomes readable
    // through fs/readFile, so a made-up path must not be able to pick one.
    const info = await stat(realFile).catch(() => null)
    if (!info?.isFile()) {
      throw invalidParams(`Not an existing file: ${uri}`)
    }
    const detected = detectWorkspaceRoot(realFile, language, boundary === null ? {} : { boundary })
    if (detected === null) {
      return {
        sessionId: null,
        reason:
          'refusing to start a language server for a file directly in the home directory or filesystem root',
        retryable: false
      }
    }
    const rootPath = realpathLenient(detected)
    const trusted = await options.trustedRoots({ path: rootPath })
    if (findContainingRoot(rootPath, trusted) === null) {
      return {
        sessionId: null,
        reason: `Workspace is not trusted for language-server execution: ${rootPath}. Explicitly trust this workspace, then reconnect.`,
        retryable: false
      }
    }
    const resolution = resolveLspServerForLanguage(
      language,
      context.trustProjectBinaries
        ? { ...context.resolution, projectRoot: rootPath }
        : context.resolution
    )
    if (!resolution.server) {
      return { sessionId: null, reason: resolution.reason, retryable: false }
    }
    const result = await sessions.openDocument({
      clientId: client.id,
      server: resolution.server,
      rootPath,
      clientUri: uri,
      serverUri: pathToFileURL(realFile).toString(),
      lspLanguageId: toLspDocumentLanguageId(language, realFile),
      text
    })
    if (result.sessionId !== null) {
      if (client.closed) {
        // Why: the socket dropped while the server was starting; nobody will
        // ever close this document, so release it right away.
        sessions.releaseClient(client.id)
      } else {
        client.usedRoots.add(result.rootPath)
      }
    }
    return result
  }

  async function lspRequest(params: unknown, id: JsonRpcId): Promise<unknown> {
    const record = expectRecord(params)
    const sessionId = expectString(record.sessionId, 'sessionId')
    const method = expectString(record.method, 'method')
    if (!isAllowedLspMethod(method)) {
      throw new RpcError(JsonRpcErrorCodes.MethodNotAllowed, `LSP method not allowed: ${method}`)
    }
    const controller = new AbortController()
    // Why: a client reusing an id while the first call is in flight is a
    // client bug; the newest call is the one a cancel refers to.
    client.pendingRequests.set(id, controller)
    try {
      return await sessions.request(client.id, sessionId, method, record.params, controller.signal)
    } finally {
      if (client.pendingRequests.get(id) === controller) {
        client.pendingRequests.delete(id)
      }
    }
  }

  async function readFile(params: unknown): Promise<ReadFileResult> {
    const record = expectRecord(params)
    const requested = filePathFromUri(record.uri)
    // Why: with containment on, the allowed roots alone decide (session roots
    // lie inside them anyway, and a root that was removed since must stop
    // being readable); without it, only roots of sessions this client used.
    const roots = options.allowedRoots
      ? await options.allowedRoots({ path: realpathLenient(requested) })
      : [...client.usedRoots]
    return readFileForClient(record.uri, roots)
  }

  async function openLocation(params: unknown): Promise<OpenLocationResult> {
    const record = expectRecord(params)
    const path = filePathFromUri(record.uri)
    await containingAllowedRoot(realpathLenient(path), record.uri)
    const range = expectRecord(record.range, 'range')
    const start = expectRecord(range.start, 'range.start')
    const line = expectNonNegativeInteger(start.line, 'range.start.line')
    const character = expectNonNegativeInteger(start.character, 'range.start.character')
    const navigator = options.hostNavigator
    if (!navigator) {
      return { opened: false, reason: 'no host navigator' }
    }
    try {
      const result = await navigator({ path, line, character })
      return result.opened
        ? { opened: true }
        : { opened: false, reason: result.reason ?? 'not opened' }
    } catch (error) {
      throw new RpcError(
        JsonRpcErrorCodes.HostUnavailable,
        `Host navigation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const requestHandlers: Record<string, (params: unknown, id: JsonRpcId) => unknown> = {
    [BridgeMethods.hello]: hello,
    [BridgeMethods.status]: () => context.status(),
    [BridgeMethods.openDocument]: openDocument,
    [BridgeMethods.lspRequest]: lspRequest,
    [BridgeMethods.readFile]: readFile,
    [BridgeMethods.openLocation]: openLocation
  }

  function onRequest(method: string, params: unknown, id: JsonRpcId): unknown {
    if (!client.greeted && method !== BridgeMethods.hello) {
      throw new RpcError(
        JsonRpcErrorCodes.InvalidRequest,
        `${BridgeMethods.hello} must be called first`
      )
    }
    const handler = Object.hasOwn(requestHandlers, method) ? requestHandlers[method] : undefined
    if (!handler) {
      throw new RpcError(JsonRpcErrorCodes.MethodNotFound, `Method not found: ${method}`)
    }
    return handler(params, id)
  }

  function onNotification(method: string, params: unknown): void {
    if (!client.greeted) {
      return
    }
    if (method === BridgeMethods.changeDocument) {
      const fields = readStringFields(params, ['sessionId', 'uri', 'text'] as const)
      if (fields) {
        sessions.changeDocument(client.id, fields.sessionId, fields.uri, fields.text)
      }
    } else if (method === BridgeMethods.closeDocument) {
      const fields = readStringFields(params, ['sessionId', 'uri'] as const)
      if (fields) {
        sessions.closeDocument(client.id, fields.sessionId, fields.uri)
      }
    } else if (method === BridgeMethods.cancelRequest) {
      const id = isRecord(params) ? params.id : undefined
      if (typeof id === 'string' || typeof id === 'number') {
        // Why: the pending lsp/request then fails with RequestCancelled
        // (-32800) and the server gets `$/cancelRequest`. Unknown or finished
        // ids are ignored, as LSP prescribes.
        client.pendingRequests.get(id)?.abort()
      }
    }
  }

  return { onRequest, onNotification }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

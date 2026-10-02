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
import { pathNotAllowed, RpcError } from '../rpc/rpc-error'
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
}

export type BridgeContext = {
  options: NormalizedBridgeOptions
  sessions: SessionManager
  resolution: ServerResolutionContext
  status: () => BridgeStatus
}

export type ClientHandlers = {
  onRequest: (method: string, params: unknown) => unknown
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
      availableLanguages: availableLanguages(context.resolution),
      hostNavigation: options.hostNavigator !== null
    }
  }

  async function openDocument(params: unknown): Promise<OpenDocumentResult> {
    const record = expectRecord(params)
    const uri = expectString(record.uri, 'uri')
    const languageId = expectString(record.languageId, 'languageId')
    const text = expectString(record.text, 'text')
    const realFile = realpathLenient(filePathFromUri(uri))

    let boundary: string | undefined
    if (options.allowedRoots.length > 0) {
      const root = findContainingRoot(realFile, options.allowedRoots)
      if (root === null) {
        throw pathNotAllowed(`Document is outside every allowed root: ${uri}`)
      }
      boundary = root
    }
    // Why: clients may send react/variant ids (typescriptreact) the catalog
    // doesn't list; the extension still tells us which server family applies.
    const language = isCatalogLanguage(languageId)
      ? languageId
      : (languageIdForPath(realFile) ?? languageId)
    if (!isCatalogLanguage(language)) {
      return { sessionId: null, reason: `unsupported language: ${languageId}` }
    }
    const rootPath = realpathLenient(
      detectWorkspaceRoot(realFile, language, boundary === undefined ? {} : { boundary })
    )
    const resolution = resolveLspServerForLanguage(language, {
      ...context.resolution,
      projectRoot: rootPath
    })
    if (!resolution.server) {
      return { sessionId: null, reason: resolution.reason }
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

  function lspRequest(params: unknown): Promise<unknown> {
    const record = expectRecord(params)
    const sessionId = expectString(record.sessionId, 'sessionId')
    const method = expectString(record.method, 'method')
    if (!isAllowedLspMethod(method)) {
      throw new RpcError(JsonRpcErrorCodes.MethodNotAllowed, `LSP method not allowed: ${method}`)
    }
    return sessions.request(client.id, sessionId, method, record.params)
  }

  function readFile(params: unknown): Promise<ReadFileResult> {
    const record = expectRecord(params)
    return readFileForClient(record.uri, [...client.usedRoots, ...options.allowedRoots])
  }

  async function openLocation(params: unknown): Promise<OpenLocationResult> {
    const record = expectRecord(params)
    const path = filePathFromUri(record.uri)
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

  const requestHandlers: Record<string, (params: unknown) => unknown> = {
    [BridgeMethods.hello]: hello,
    [BridgeMethods.status]: () => context.status(),
    [BridgeMethods.openDocument]: openDocument,
    [BridgeMethods.lspRequest]: lspRequest,
    [BridgeMethods.readFile]: readFile,
    [BridgeMethods.openLocation]: openLocation
  }

  function onRequest(method: string, params: unknown): unknown {
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
    return handler(params)
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
    }
  }

  return { onRequest, onNotification }
}

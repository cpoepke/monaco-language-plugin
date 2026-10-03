// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { BridgeMethods, JsonRpcErrorCodes } from '@mlp/protocol'
import type {
  DiagnosticsParams,
  OpenDocumentResult,
  ServerStatus,
  SessionClosedParams
} from '@mlp/protocol'
import type { BridgeLogger } from '../logger'
import { canonicalFileUriKey } from '../lsp/file-uri-key'
import { buildLspInitializeParams, workspaceFoldersFor } from '../lsp/initialize-params'
import { LspConnection, LspResponseError } from '../lsp/lsp-connection'
import type { LspExitInfo } from '../lsp/lsp-connection'
import type { ResolvedLspServer } from '../lsp/server-catalog'
import { replyToServerRequest } from '../lsp/server-requests'
import { spawnLspServer } from '../lsp/server-spawn'
import type { SpawnLspServer } from '../lsp/server-spawn'
import { invalidParams, RpcError } from '../rpc/rpc-error'
import { WatchedFilesService } from '../workspace/watched-files'
import type { ClientId, Session, SessionDocument } from './session-types'
import { derivePrefixMapping, rememberMapping, rewriteResultUris } from './uri-mapping'

const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 5 * 60_000
// Why: first start of a server can index before answering initialize (pyright
// scanning site-packages); the per-request timeout is too tight for that.
const MIN_INITIALIZE_TIMEOUT_MS = 60_000
const REASON_STDERR_CHARS = 1000

export type SessionManagerOptions = {
  requestTimeoutMs: number
  idleShutdownMs: number
  maxSessions: number
  logger: BridgeLogger
  spawnServer?: SpawnLspServer
  /** Delivers a bridge → client notification. */
  notifyClient: (clientId: ClientId, method: string, params: unknown) => void
}

export type OpenDocumentArgs = {
  clientId: ClientId
  server: ResolvedLspServer
  rootPath: string
  /** URI as the client sent it. */
  clientUri: string
  /** URI the server should see (realpath-based file URI). */
  serverUri: string
  /** languageId for didOpen (already mapped via toLspDocumentLanguageId). */
  lspLanguageId: string
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const WATCHED_FILES_METHOD = 'workspace/didChangeWatchedFiles'

type NoSession = Extract<OpenDocumentResult, { sessionId: null }>

function noSession(reason: string, retryable: boolean): NoSession {
  return { sessionId: null, reason, retryable }
}

function sessionNotFound(sessionId: string): RpcError {
  return new RpcError(JsonRpcErrorCodes.SessionNotFound, `Unknown session: ${sessionId}`)
}

/**
 * Owns language-server sessions keyed by (serverId, rootPath). Clients share
 * sessions; each document is reference-counted per client, so the server sees
 * one didOpen/didClose pair no matter how many clients view the file.
 */
export class SessionManager {
  private readonly sessionsByKey = new Map<string, Session>()
  private readonly sessionsById = new Map<string, Session>()
  /** Connections shutting down after leaving the maps; awaited by closeAll. */
  private readonly stopping = new Set<Promise<void>>()
  /** Detached connections whose process has not exited yet (pids()). */
  private readonly exiting = new Set<LspConnection>()
  private readonly crashesByKey = new Map<string, number[]>()
  private nextSessionNumber = 1
  private closed = false

  constructor(private readonly options: SessionManagerOptions) {}

  async openDocument(args: OpenDocumentArgs): Promise<OpenDocumentResult> {
    if (this.closed) {
      return noSession('bridge is shutting down', true)
    }
    const key = `${args.server.serverId}\0${args.rootPath}`
    let session = this.sessionsByKey.get(key)
    if (!session) {
      const crashReason = this.crashLoopReason(key, args.server.serverId, args.rootPath)
      if (crashReason) {
        return noSession(crashReason, false)
      }
      if (!this.makeRoomForSession()) {
        return noSession(
          `too many language servers running (max ${this.options.maxSessions})`,
          true
        )
      }
      session = this.createSession(args.server, args.rootPath, key)
    }
    // Why: until addOwner runs the session has no documents and would look
    // idle to makeRoomForSession / the idle timer of a concurrent open.
    session.pendingOpens++
    try {
      try {
        await session.initialization
      } catch (error) {
        return noSession(
          `${args.server.serverId} failed to start: ${
            error instanceof Error ? error.message : String(error)
          }${this.stderrSuffix(session)}`,
          this.isTransientStartFailure(session, error)
        )
      }
      if (session.state === 'stopped') {
        return noSession(
          `${args.server.serverId} exited during startup${this.stderrSuffix(session)}`,
          true
        )
      }
      this.cancelIdleShutdown(session)
      this.addOwner(session, args)
    } finally {
      session.pendingOpens--
    }
    return {
      sessionId: session.sessionId,
      uri: args.clientUri,
      serverId: session.serverId,
      rootPath: session.rootPath,
      pullDiagnostics: session.pullDiagnostics
    }
  }

  /** Timeouts and processes that died mid-handshake may work next time; a
   *  binary that cannot be spawned, or a server that rejected initialize,
   *  will not. */
  private isTransientStartFailure(session: Session, error: unknown): boolean {
    if (session.exitInfo?.error) {
      return false
    }
    if (error instanceof LspResponseError) {
      return false
    }
    return (
      error instanceof RpcError &&
      (error.code === JsonRpcErrorCodes.RequestTimeout ||
        error.code === JsonRpcErrorCodes.SessionNotFound)
    )
  }

  /** Full-text sync; ignored unless this client has the document open. */
  changeDocument(clientId: ClientId, sessionId: string, clientUri: string, text: string): boolean {
    const session = this.sessionsById.get(sessionId)
    const document = session && this.findDocument(session, clientUri)
    if (!session || !document?.owners.has(clientId)) {
      return false
    }
    if (document.text !== text) {
      this.sendDidChange(session, document, text)
    }
    return true
  }

  closeDocument(clientId: ClientId, sessionId: string, clientUri: string): boolean {
    const session = this.sessionsById.get(sessionId)
    const document = session && this.findDocument(session, clientUri)
    const owner = document?.owners.get(clientId)
    if (!session || !document || !owner) {
      return false
    }
    owner.refCount--
    if (owner.refCount <= 0) {
      document.owners.delete(clientId)
      this.releaseDocumentIfUnowned(session, document)
    }
    return true
  }

  /** Drop every document a disconnected client held. */
  releaseClient(clientId: ClientId): void {
    for (const session of this.sessionsById.values()) {
      session.clientMappings.delete(clientId)
      for (const document of [...session.documents.values()]) {
        if (document.owners.delete(clientId)) {
          this.releaseDocumentIfUnowned(session, document)
        }
      }
      if (session.documents.size === 0) {
        // Why: a client can disconnect while its open was still initializing
        // the session; without this the doc-less session would never idle out.
        this.scheduleIdleShutdown(session)
      }
    }
  }

  /** Forward an allowlisted request after checking the client owns the
   *  document. Result URIs come back in the client's spelling. */
  async request(
    clientId: ClientId,
    sessionId: string,
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const session = this.sessionsById.get(sessionId)
    if (!session) {
      throw sessionNotFound(sessionId)
    }
    const forwarded = this.rewriteDocumentParams(session, clientId, params)
    await session.initialization
    const result = await session.connection.request(
      method,
      forwarded,
      signal === undefined ? {} : { signal }
    )
    return rewriteResultUris(result, session.clientMappings.get(clientId) ?? [])
  }

  status(): ServerStatus[] {
    return [...this.sessionsById.values()].map((session) => ({
      sessionId: session.sessionId,
      serverId: session.serverId,
      rootPath: session.rootPath,
      openDocuments: session.documents.size,
      state: session.state
    }))
  }

  /** Pids of server processes that are still running, including those
   *  being shut down: a host killing everything on exit must see them. */
  pids(): number[] {
    const connections = new Set<LspConnection>(this.exiting)
    for (const session of this.sessionsById.values()) {
      connections.add(session.connection)
    }
    return [...connections]
      .filter((connection) => connection.isAlive)
      .map((connection) => connection.pid)
      .filter((pid): pid is number => pid !== undefined)
  }

  async closeAll(): Promise<void> {
    this.closed = true
    for (const session of [...this.sessionsById.values()]) {
      this.stopSession(session)
    }
    await Promise.all([...this.stopping])
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  private createSession(server: ResolvedLspServer, rootPath: string, key: string): Session {
    const spawned = (this.options.spawnServer ?? spawnLspServer)(server, rootPath)
    const workspaceFolders = workspaceFoldersFor(rootPath)
    const sessionId = `s${this.nextSessionNumber++}`
    const log = this.options.logger
    // Why: handlers need the session object, which needs the connection; the
    // holder breaks that cycle without a mutable `let` on the session itself.
    const holder: { session?: Session } = {}
    const connection = new LspConnection(
      spawned,
      {
        onNotification: (method, params) => {
          if (holder.session) {
            this.handleServerNotification(holder.session, method, params)
          }
        },
        onServerRequest: (method, params) => {
          if (holder.session) {
            this.trackRegistrations(holder.session, method, params)
          }
          return replyToServerRequest(method, params, workspaceFolders)
        },
        onExit: (info) => {
          if (holder.session) {
            this.handleExit(holder.session, info)
          }
        },
        onStderr: (text) => log.debug(`${server.serverId} stderr`, { sessionId, text })
      },
      this.options.requestTimeoutMs
    )
    const session: Session = {
      sessionId,
      key,
      serverId: server.serverId,
      rootPath,
      workspaceFolders,
      connection,
      state: 'starting',
      initialization: Promise.resolve(),
      pullDiagnostics: false,
      documents: new Map(),
      aliases: new Map(),
      idleTimer: null,
      pendingOpens: 0,
      clientMappings: new Map(),
      watchedFiles: null,
      exitInfo: null
    }
    holder.session = session
    this.sessionsByKey.set(key, session)
    this.sessionsById.set(sessionId, session)
    log.info('starting language server', {
      sessionId,
      serverId: server.serverId,
      command: server.executablePath,
      rootPath,
      pid: connection.pid
    })

    session.initialization = connection
      .request(
        'initialize',
        buildLspInitializeParams(rootPath),
        Math.max(this.options.requestTimeoutMs, MIN_INITIALIZE_TIMEOUT_MS)
      )
      .then((result) => {
        const capabilities = isRecord(result) ? result.capabilities : undefined
        session.pullDiagnostics = isRecord(capabilities) && Boolean(capabilities.diagnosticProvider)
        connection.notify('initialized', {})
        if (session.state === 'starting') {
          session.state = 'running'
        }
      })
    session.initialization.catch((error: unknown) => {
      // Why: a failed handshake leaves a process we can't talk to; count it as a
      // crash so a broken server isn't respawned on every open.
      log.warn('language server failed to initialize', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        stderr: connection.stderr
      })
      if (session.state !== 'stopped') {
        this.recordCrash(key)
        this.detach(session)
        connection.kill()
        this.trackExit(connection)
      }
    })
    return session
  }

  private handleExit(session: Session, info: LspExitInfo): void {
    session.exitInfo = info
    const wasLive = session.state !== 'stopped'
    const owners = new Set<ClientId>()
    for (const document of session.documents.values()) {
      for (const clientId of document.owners.keys()) {
        owners.add(clientId)
      }
    }
    this.detach(session)
    if (info.expected || !wasLive) {
      this.options.logger.info('language server stopped', { sessionId: session.sessionId })
      return
    }
    this.recordCrash(session.key)
    const how = info.error
      ? info.error.message
      : info.signal
        ? `signal ${info.signal}`
        : `code ${info.code ?? 'unknown'}`
    const reason = `${session.serverId} exited unexpectedly (${how})${this.stderrSuffix(session)}`
    this.options.logger.warn('language server crashed', {
      sessionId: session.sessionId,
      reason,
      stderr: session.connection.stderr
    })
    const params: SessionClosedParams = { sessionId: session.sessionId, reason }
    for (const clientId of owners) {
      this.options.notifyClient(clientId, BridgeMethods.sessionClosed, params)
    }
  }

  /** Remove the session from every map; it can no longer be found or reused. */
  private detach(session: Session): void {
    session.state = 'stopped'
    this.cancelIdleShutdown(session)
    if (this.sessionsByKey.get(session.key) === session) {
      this.sessionsByKey.delete(session.key)
    }
    this.sessionsById.delete(session.sessionId)
    session.documents.clear()
    session.aliases.clear()
    session.clientMappings.clear()
    session.watchedFiles?.close()
    session.watchedFiles = null
  }

  /** Keep a detached connection visible to pids() until its process is gone. */
  private trackExit(connection: LspConnection): void {
    if (!connection.isAlive) {
      return
    }
    this.exiting.add(connection)
    void connection.whenExited().then(() => this.exiting.delete(connection))
  }

  private stopSession(session: Session): void {
    this.detach(session)
    this.trackExit(session.connection)
    const stopped = session.connection.shutdown().catch((error: unknown) => {
      this.options.logger.error('failed to stop language server', {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    this.stopping.add(stopped)
    void stopped.finally(() => this.stopping.delete(stopped))
  }

  private scheduleIdleShutdown(session: Session): void {
    if (session.state === 'stopped' || session.idleTimer) {
      return
    }
    // Why: keep a doc-less server briefly for tab switches, but don't hold
    // memory-heavy servers (tsserver, rust-analyzer) open indefinitely.
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (
        session.documents.size === 0 &&
        session.pendingOpens === 0 &&
        session.state !== 'stopped'
      ) {
        this.options.logger.info('stopping idle language server', {
          sessionId: session.sessionId
        })
        this.stopSession(session)
      }
    }, this.options.idleShutdownMs)
    session.idleTimer.unref()
  }

  private cancelIdleShutdown(session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  /** At the session cap, evict an idle (document-less) session if there is one. */
  private makeRoomForSession(): boolean {
    if (this.sessionsByKey.size < this.options.maxSessions) {
      return true
    }
    const idle = [...this.sessionsByKey.values()].find(
      (session) =>
        session.state === 'running' && session.documents.size === 0 && session.pendingOpens === 0
    )
    if (!idle) {
      return false
    }
    this.stopSession(idle)
    return true
  }

  private recordCrash(key: string): void {
    const now = Date.now()
    const recent = (this.crashesByKey.get(key) ?? []).filter((t) => now - t < CRASH_WINDOW_MS)
    recent.push(now)
    this.crashesByKey.set(key, recent)
  }

  private crashLoopReason(key: string, serverId: string, rootPath: string): string | null {
    const now = Date.now()
    const recent = (this.crashesByKey.get(key) ?? []).filter((t) => now - t < CRASH_WINDOW_MS)
    this.crashesByKey.set(key, recent)
    if (recent.length < MAX_CRASHES) {
      return null
    }
    return `${serverId} crashed ${recent.length} times in the last 5 minutes for ${rootPath}; not restarting`
  }

  private stderrSuffix(session: Session): string {
    const tail = session.connection.stderr.trim()
    return tail ? `\n${tail.slice(-REASON_STDERR_CHARS)}` : ''
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  private findDocument(session: Session, uri: string): SessionDocument | undefined {
    const key = canonicalFileUriKey(uri)
    const direct = session.documents.get(key)
    if (direct) {
      return direct
    }
    const aliased = session.aliases.get(key)
    return aliased === undefined ? undefined : session.documents.get(aliased)
  }

  private addOwner(session: Session, args: OpenDocumentArgs): void {
    const documentKey = canonicalFileUriKey(args.serverUri)
    const clientKey = canonicalFileUriKey(args.clientUri)
    let document = session.documents.get(documentKey)
    if (!document) {
      document = {
        key: documentKey,
        serverUri: args.serverUri,
        version: 1,
        text: args.text,
        owners: new Map(),
        aliasKeys: new Set(),
        lastDiagnostics: null
      }
      session.documents.set(documentKey, document)
      session.connection.notify('textDocument/didOpen', {
        textDocument: {
          uri: args.serverUri,
          languageId: args.lspLanguageId,
          version: 1,
          text: args.text
        }
      })
    } else if (document.text !== args.text) {
      // Why: a second client can open the same file with different (unsaved)
      // text; last writer wins so the server tracks what was most recently shown.
      this.sendDidChange(session, document, args.text)
    } else if (document.lastDiagnostics !== null) {
      // Why: the server won't republish for unchanged text, so a client joining
      // an already-open document would otherwise never see its diagnostics.
      // setImmediate (not a microtask) so it lands after the open response.
      const diagnostics = document.lastDiagnostics
      setImmediate(() => {
        const params: DiagnosticsParams = {
          sessionId: session.sessionId,
          uri: args.clientUri,
          diagnostics: rewriteResultUris(
            diagnostics,
            session.clientMappings.get(args.clientId) ?? []
          ) as unknown[]
        }
        this.options.notifyClient(args.clientId, BridgeMethods.diagnostics, params)
      })
    }
    if (clientKey !== documentKey) {
      document.aliasKeys.add(clientKey)
      session.aliases.set(clientKey, documentKey)
    }
    const mapping = derivePrefixMapping(args.clientUri, args.serverUri)
    if (mapping) {
      const list = session.clientMappings.get(args.clientId) ?? []
      rememberMapping(list, mapping)
      session.clientMappings.set(args.clientId, list)
    }
    const owner = document.owners.get(args.clientId)
    if (owner) {
      owner.refCount++
      owner.clientUri = args.clientUri
    } else {
      document.owners.set(args.clientId, { clientUri: args.clientUri, refCount: 1 })
    }
  }

  private sendDidChange(session: Session, document: SessionDocument, text: string): void {
    document.version++
    document.text = text
    session.connection.notify('textDocument/didChange', {
      textDocument: { uri: document.serverUri, version: document.version },
      contentChanges: [{ text }]
    })
  }

  private releaseDocumentIfUnowned(session: Session, document: SessionDocument): void {
    if (document.owners.size > 0) {
      return
    }
    session.documents.delete(document.key)
    for (const alias of document.aliasKeys) {
      session.aliases.delete(alias)
    }
    session.connection.notify('textDocument/didClose', {
      textDocument: { uri: document.serverUri }
    })
    if (session.documents.size === 0) {
      this.scheduleIdleShutdown(session)
    }
  }

  private clientUsesSession(session: Session, clientId: ClientId): boolean {
    for (const document of session.documents.values()) {
      if (document.owners.has(clientId)) {
        return true
      }
    }
    return false
  }

  /** Enforce document ownership and swap in the server-side URI. */
  private rewriteDocumentParams(session: Session, clientId: ClientId, params: unknown): unknown {
    if (!isRecord(params)) {
      throw invalidParams('params must be an object')
    }
    const textDocument = params.textDocument
    if (isRecord(textDocument) && typeof textDocument.uri === 'string') {
      const document = this.findDocument(session, textDocument.uri)
      if (!document?.owners.has(clientId)) {
        throw invalidParams(
          `Document is not open on session ${session.sessionId}: ${textDocument.uri}`
        )
      }
      return { ...params, textDocument: { ...textDocument, uri: document.serverUri } }
    }
    if (textDocument !== undefined) {
      throw invalidParams('textDocument.uri must be a string')
    }
    // Why: requests without a document (documentLink/resolve) are still scoped
    // to sessions the client actually uses.
    if (!this.clientUsesSession(session, clientId)) {
      throw invalidParams(`No documents open on session ${session.sessionId}`)
    }
    return params
  }

  /**
   * Servers register `workspace/didChangeWatchedFiles` watchers dynamically;
   * the bridge then watches the session root and reports matching changes.
   */
  private trackRegistrations(session: Session, method: string, params: unknown): void {
    if (method === 'client/registerCapability') {
      const registrations = isRecord(params) ? params.registrations : undefined
      for (const registration of Array.isArray(registrations) ? registrations : []) {
        if (
          !isRecord(registration) ||
          registration.method !== WATCHED_FILES_METHOD ||
          typeof registration.id !== 'string' ||
          session.state === 'stopped'
        ) {
          continue
        }
        session.watchedFiles ??= new WatchedFilesService({
          root: session.rootPath,
          logger: this.options.logger,
          send: (changes) => {
            if (session.state !== 'stopped') {
              session.connection.notify(WATCHED_FILES_METHOD, { changes })
            }
          }
        })
        session.watchedFiles.register(registration.id, registration.registerOptions)
      }
    } else if (method === 'client/unregisterCapability') {
      // Why: the spec's field really is spelled `unregisterations`.
      const removals = isRecord(params) ? params.unregisterations : undefined
      for (const removal of Array.isArray(removals) ? removals : []) {
        if (isRecord(removal) && typeof removal.id === 'string') {
          session.watchedFiles?.unregister(removal.id)
        }
      }
    }
  }

  private handleServerNotification(session: Session, method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      if (!isRecord(params) || typeof params.uri !== 'string') {
        return
      }
      // Why: servers publish for files no client opened (project-wide scans);
      // forwarding only open documents keeps client marker state bounded, and
      // only owners get them so clients never see each other's files.
      const document = this.findDocument(session, params.uri)
      if (!document) {
        return
      }
      const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : []
      document.lastDiagnostics = diagnostics
      for (const [clientId, owner] of document.owners) {
        const mappings = session.clientMappings.get(clientId) ?? []
        const payload: DiagnosticsParams = {
          sessionId: session.sessionId,
          uri: owner.clientUri,
          // Why: relatedInformation locations name other files by realpath.
          diagnostics: rewriteResultUris(diagnostics, mappings) as unknown[]
        }
        this.options.notifyClient(clientId, BridgeMethods.diagnostics, payload)
      }
      return
    }
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const message = isRecord(params) && typeof params.message === 'string' ? params.message : ''
      this.options.logger.debug(`${session.serverId}: ${message}`, {
        sessionId: session.sessionId
      })
    }
  }
}

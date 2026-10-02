// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import {
  BridgeMethods,
  JsonRpcErrorCodes,
  type ChangeDocumentParams,
  type CloseDocumentParams,
  type DiagnosticsParams,
  type OpenDocumentParams,
  type OpenDocumentResult
} from '@mlp/protocol'
import type { BridgeConnection } from './connection'
import { RpcError, errorMessage, type CancellationTokenLike } from './connection'
import { fileUriKey, lspPullDiagnosticsToItems } from './conversion'
import type { Logger } from './logger'

// Why: batch keystrokes into one document/change without letting requests
// observe text older than this window (providers flush first).
export const CHANGE_DEBOUNCE_MS = 250

/** Backoff for re-opening a document after a retryable no-session result: 2 s doubling to 60 s. */
export const OPEN_RETRY_INITIAL_MS = 2_000
export const OPEN_RETRY_MAX_MS = 60_000
/** After this many retryable failures in a row the reason sticks until the next reconnect. */
export const OPEN_RETRY_LIMIT = 8

// Why: older bridges send no `retryable` flag; these reasons are transient (session cap,
// slow or crashing startup), everything else (unsupported language, binary missing) is not.
const RETRYABLE_REASON =
  /too many language servers|failed to start|exited during startup|timed? ?out/i

/**
 * Whether a null-session `document/open` result is worth retrying. Honours the
 * bridge's optional `retryable` flag; without it, falls back to known reasons.
 */
export function isRetryableNoSession(result: { reason?: unknown; retryable?: unknown }): boolean {
  if (typeof result.retryable === 'boolean') {
    return result.retryable
  }
  return typeof result.reason === 'string' && RETRYABLE_REASON.test(result.reason)
}

type Disposable = { dispose(): void }

/** The slice of Monaco's ITextModel the document sync needs. */
export type SyncModel = {
  uri: { toString(): string }
  getLanguageId(): string
  getValue(): string
  isDisposed(): boolean
  onDidChangeContent(listener: () => void): Disposable
}

export type DocumentSession = {
  sessionId: string
  /** Canonical file:// URI the bridge uses for this document. */
  uri: string
  serverId: string
  rootPath: string
  pullDiagnostics: boolean
}

export type DocumentState = 'pending' | 'opening' | 'open' | 'no-session'

export type DocumentEntry<M extends SyncModel = SyncModel> = {
  readonly key: string
  readonly model: M
  readonly languageId: string
  session: DocumentSession | null
  /** Why the bridge declined to attach a server (unsupported language, binary missing…). */
  noSessionReason: string | null
  /** Retryable failures in a row; the next open waits OPEN_RETRY_INITIAL_MS·2^n (capped). */
  openFailures: number
  /** When set, the earliest time (Date.now()) another open may be tried; null = sticky. */
  retryAt: number | null
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Cancels the in-flight `textDocument/diagnostic` pull (a newer one supersedes it). */
  cancelDiagnosticsPull: (() => void) | null
  opening: Promise<DocumentSession | null> | null
  /** Bumped whenever the server-side state is invalidated, so late opens are discarded. */
  generation: number
  changeTimer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  closed: boolean
  contentListener: Disposable
}

export type DocumentInfo = {
  uri: string
  languageId: string
  state: DocumentState
  sessionId: string | null
  serverId: string | null
  reason: string | null
}

export type DocumentManagerOptions<M extends SyncModel> = {
  connection: BridgeConnection
  logger: Logger
  /** Set markers (diagnostics) for a model; [] clears. Omit to disable diagnostics. */
  setMarkers?: ((model: M, diagnostics: unknown[]) => void) | null
  /** Called when the set of documents or their state changes. */
  onDidChange?: () => void
  /** Called when a session for a language becomes available (first successful open). */
  onSessionOpened?: (languageId: string, session: DocumentSession) => void
  changeDebounceMs?: number
  /** Backoff for retryable open failures. Defaults: 2 s → 60 s, 8 attempts. */
  openRetry?: { initialDelayMs?: number; maxDelayMs?: number; limit?: number }
}

/**
 * Mirrors attached Monaco models into bridge documents: full-text sync with a
 * debounced `document/change`, flushed before every request; re-opens documents
 * after a reconnect (eagerly) and after `session/closed` (lazily, on next use).
 */
export class DocumentManager<M extends SyncModel = SyncModel> {
  private readonly entries = new Map<string, DocumentEntry<M>>()

  constructor(private readonly options: DocumentManagerOptions<M>) {}

  get size(): number {
    return this.entries.size
  }

  get(key: string): DocumentEntry<M> | null {
    return this.entries.get(key) ?? null
  }

  list(): DocumentEntry<M>[] {
    return [...this.entries.values()]
  }

  info(): DocumentInfo[] {
    return this.list().map((entry) => ({
      uri: entry.key,
      languageId: entry.languageId,
      state: stateOf(entry),
      sessionId: entry.session?.sessionId ?? null,
      serverId: entry.session?.serverId ?? null,
      reason: entry.noSessionReason
    }))
  }

  attach(model: M): DocumentEntry<M> {
    const key = model.uri.toString()
    const existing = this.entries.get(key)
    if (existing) {
      return existing
    }
    const entry: DocumentEntry<M> = {
      key,
      model,
      languageId: model.getLanguageId(),
      session: null,
      noSessionReason: null,
      openFailures: 0,
      retryAt: null,
      retryTimer: null,
      cancelDiagnosticsPull: null,
      opening: null,
      generation: 0,
      changeTimer: null,
      dirty: false,
      closed: false,
      contentListener: model.onDidChangeContent(() => this.handleContentChange(entry))
    }
    this.entries.set(key, entry)
    this.changed()
    if (this.options.connection.isConnected) {
      void this.ensureSession(entry)
    }
    return entry
  }

  detach(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    this.entries.delete(key)
    entry.closed = true
    entry.generation++
    entry.contentListener.dispose()
    entry.cancelDiagnosticsPull?.()
    this.clearTimer(entry)
    this.clearRetry(entry)
    if (!entry.model.isDisposed()) {
      this.options.setMarkers?.(entry.model, [])
    }
    const session = entry.session
    entry.session = null
    if (session) {
      const params: CloseDocumentParams = { sessionId: session.sessionId, uri: session.uri }
      this.options.connection.notify(BridgeMethods.closeDocument, params)
    }
    this.changed()
  }

  detachAll(): void {
    for (const key of [...this.entries.keys()]) {
      this.detach(key)
    }
  }

  /**
   * Resolves the document's live session, opening it on the bridge if needed and
   * sending any pending change first. Null when the bridge has no server for it,
   * the connection is down, or the document was detached meanwhile. Never rejects.
   */
  async ensureSession(entry: DocumentEntry<M>): Promise<DocumentSession | null> {
    if (entry.closed || entry.model.isDisposed()) {
      return null
    }
    if (entry.session) {
      this.flush(entry)
      return entry.session
    }
    if (!this.options.connection.isConnected) {
      return null
    }
    if (entry.noSessionReason !== null) {
      // Why: sticky for "no server for this language"; retryable failures retry once due.
      if (entry.retryAt === null || Date.now() < entry.retryAt) {
        return null
      }
      this.clearRetry(entry)
      entry.noSessionReason = null
    }
    entry.opening ??= this.open(entry)
    return entry.opening
  }

  /** Sends a pending debounced change now. */
  flush(entry: DocumentEntry<M>): void {
    if (entry.dirty && entry.session) {
      this.sendChangeNow(entry)
    }
  }

  /** Connection dropped: every server-side document is gone. */
  handleDisconnect(): void {
    for (const entry of this.entries.values()) {
      this.reset(entry)
      this.clearNoSession(entry)
    }
    this.changed()
  }

  /** Connection (re)established: re-open every attached document. */
  handleConnect(): void {
    for (const entry of this.entries.values()) {
      this.reset(entry)
      this.clearNoSession(entry)
      void this.ensureSession(entry)
    }
    this.changed()
  }

  /** The bridge closed a session (server exited); its documents re-open on next use. */
  handleSessionClosed(sessionId: string): void {
    let touched = false
    for (const entry of this.entries.values()) {
      if (entry.session?.sessionId === sessionId) {
        this.reset(entry)
        if (!entry.model.isDisposed()) {
          this.options.setMarkers?.(entry.model, [])
        }
        touched = true
      }
    }
    if (touched) {
      this.changed()
    }
  }

  /** A request failed with SessionNotFound: forget the session so the next call re-opens. */
  invalidateSession(entry: DocumentEntry<M>): void {
    if (entry.session) {
      this.reset(entry)
      this.changed()
    }
  }

  handleDiagnostics(params: DiagnosticsParams): void {
    const setMarkers = this.options.setMarkers
    if (!setMarkers || !params || !Array.isArray(params.diagnostics)) {
      return
    }
    const key = fileUriKey(params.uri)
    for (const entry of this.entries.values()) {
      const session = entry.session
      if (
        session?.sessionId === params.sessionId &&
        (session.uri === params.uri || (key !== null && fileUriKey(session.uri) === key)) &&
        !entry.model.isDisposed()
      ) {
        setMarkers(entry.model, params.diagnostics)
      }
    }
  }

  private reset(entry: DocumentEntry<M>): void {
    entry.cancelDiagnosticsPull?.()
    entry.generation++
    entry.session = null
    entry.opening = null
    entry.dirty = false
    this.clearTimer(entry)
  }

  private async open(entry: DocumentEntry<M>): Promise<DocumentSession | null> {
    const generation = entry.generation
    const text = entry.model.getValue()
    const params: OpenDocumentParams = {
      uri: entry.key,
      languageId: entry.languageId,
      text
    }
    let result: OpenDocumentResult
    try {
      result = await this.options.connection.request<OpenDocumentResult>(
        BridgeMethods.openDocument,
        params
      )
    } catch (error) {
      this.options.logger.debug?.(`[mlp] document/open ${entry.key} failed: ${errorMessage(error)}`)
      if (entry.generation === generation) {
        entry.opening = null
        // Why: a dropped connection re-opens on reconnect; anything else (timeout, bridge
        // error) backs off instead of re-sending document/open on every provider request.
        if (this.options.connection.isConnected && !entry.closed) {
          const sticky =
            error instanceof RpcError &&
            (error.code === JsonRpcErrorCodes.PathNotAllowed ||
              error.code === JsonRpcErrorCodes.InvalidParams)
          this.setNoSession(entry, `document/open failed: ${errorMessage(error)}`, !sticky)
        }
      }
      return null
    }
    const stale = entry.generation !== generation || entry.closed
    if (!result || result.sessionId === null || typeof result.sessionId !== 'string') {
      if (stale) {
        return entry.closed ? null : this.ensureSession(entry)
      }
      entry.opening = null
      const declined = (result ?? {}) as { reason?: unknown; retryable?: unknown }
      this.setNoSession(
        entry,
        (typeof declined.reason === 'string' && declined.reason) || 'no language server',
        isRetryableNoSession(declined)
      )
      return null
    }
    const session: DocumentSession = {
      sessionId: result.sessionId,
      uri: result.uri || entry.key,
      serverId: result.serverId,
      rootPath: result.rootPath,
      pullDiagnostics: result.pullDiagnostics === true
    }
    if (stale) {
      // Why: the model was detached (or the connection reset) during the round-trip.
      if (entry.closed && this.options.connection.isConnected) {
        const close: CloseDocumentParams = { sessionId: session.sessionId, uri: session.uri }
        this.options.connection.notify(BridgeMethods.closeDocument, close)
      }
      // Why: a reconnect started a fresh open meanwhile; hand callers that one.
      return entry.closed ? null : this.ensureSession(entry)
    }
    entry.session = session
    entry.opening = null
    this.clearNoSession(entry)
    this.changed()
    this.options.onSessionOpened?.(entry.languageId, session)
    // Why: keystrokes during the open round-trip are not on the server yet.
    if (!entry.model.isDisposed() && entry.model.getValue() !== text) {
      this.sendChangeNow(entry)
    } else {
      entry.dirty = false
      void this.pullDiagnostics(entry)
    }
    return session
  }

  private handleContentChange(entry: DocumentEntry<M>): void {
    entry.dirty = true
    if (!entry.session) {
      // Sent after the in-flight open resolves (see open()).
      return
    }
    this.clearTimer(entry)
    entry.changeTimer = setTimeout(
      () => this.sendChangeNow(entry),
      this.options.changeDebounceMs ?? CHANGE_DEBOUNCE_MS
    )
  }

  private sendChangeNow(entry: DocumentEntry<M>): void {
    this.clearTimer(entry)
    const session = entry.session
    if (!session || entry.model.isDisposed()) {
      return
    }
    entry.dirty = false
    const params: ChangeDocumentParams = {
      sessionId: session.sessionId,
      uri: session.uri,
      text: entry.model.getValue()
    }
    this.options.connection.notify(BridgeMethods.changeDocument, params)
    void this.pullDiagnostics(entry)
  }

  private async pullDiagnostics(entry: DocumentEntry<M>): Promise<void> {
    const session = entry.session
    const setMarkers = this.options.setMarkers
    if (!session?.pullDiagnostics || !setMarkers) {
      return
    }
    // Why: pulls overlap while typing; an older answer arriving last must not win.
    entry.cancelDiagnosticsPull?.()
    const token = cancellationSource()
    entry.cancelDiagnosticsPull = token.cancel
    try {
      const result = await this.options.connection.request(
        BridgeMethods.lspRequest,
        {
          sessionId: session.sessionId,
          method: 'textDocument/diagnostic',
          params: { textDocument: { uri: session.uri } }
        },
        { token }
      )
      const items = lspPullDiagnosticsToItems(result)
      if (
        items &&
        !token.isCancellationRequested &&
        entry.session === session &&
        !entry.model.isDisposed()
      ) {
        setMarkers(entry.model, items)
      }
    } catch {
      // Superseded, or a dead/slow server: never break editing; markers just go stale.
    } finally {
      if (entry.cancelDiagnosticsPull === token.cancel) {
        entry.cancelDiagnosticsPull = null
      }
    }
  }

  /** Records why no session is attached; retryable reasons schedule a bounded re-open. */
  private setNoSession(entry: DocumentEntry<M>, reason: string, retryable: boolean): void {
    this.clearRetry(entry)
    entry.noSessionReason = reason
    const retry = this.options.openRetry
    const limit = retry?.limit ?? OPEN_RETRY_LIMIT
    if (retryable && entry.openFailures < limit) {
      const initial = retry?.initialDelayMs ?? OPEN_RETRY_INITIAL_MS
      const max = retry?.maxDelayMs ?? OPEN_RETRY_MAX_MS
      const delay = Math.min(max, initial * 2 ** entry.openFailures)
      entry.openFailures++
      entry.retryAt = Date.now() + delay
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null
        entry.retryAt = 0 // due now, even if the timer fired a little early
        // Lazily retried by ensureSession otherwise (e.g. while disconnected).
        if (!entry.closed && this.options.connection.isConnected) {
          void this.ensureSession(entry)
        }
      }, delay)
    } else {
      entry.retryAt = null
    }
    this.changed()
  }

  private clearNoSession(entry: DocumentEntry<M>): void {
    this.clearRetry(entry)
    entry.noSessionReason = null
    entry.openFailures = 0
  }

  private clearRetry(entry: DocumentEntry<M>): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
    entry.retryAt = null
  }

  private clearTimer(entry: DocumentEntry<M>): void {
    if (entry.changeTimer !== null) {
      clearTimeout(entry.changeTimer)
      entry.changeTimer = null
    }
  }

  private changed(): void {
    try {
      this.options.onDidChange?.()
    } catch (error) {
      this.options.logger.error?.(`[mlp] status listener failed: ${errorMessage(error)}`)
    }
  }
}

function cancellationSource(): CancellationTokenLike & { cancel(): void } {
  let cancelled = false
  const listeners = new Set<() => void>()
  return {
    get isCancellationRequested() {
      return cancelled
    },
    onCancellationRequested(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    cancel() {
      if (!cancelled) {
        cancelled = true
        for (const listener of [...listeners]) listener()
      }
    }
  }
}

function stateOf(entry: DocumentEntry): DocumentState {
  if (entry.session) {
    return 'open'
  }
  if (entry.noSessionReason !== null) {
    return 'no-session'
  }
  return entry.opening ? 'opening' : 'pending'
}

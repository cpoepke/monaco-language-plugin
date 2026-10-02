// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import {
  BridgeMethods,
  type ChangeDocumentParams,
  type CloseDocumentParams,
  type DiagnosticsParams,
  type OpenDocumentParams,
  type OpenDocumentResult
} from '@mlp/protocol'
import type { BridgeConnection } from './connection'
import { errorMessage } from './connection'
import { fileUriKey, lspPullDiagnosticsToItems } from './conversion'
import type { Logger } from './logger'

// Why: batch keystrokes into one document/change without letting requests
// observe text older than this window (providers flush first).
export const CHANGE_DEBOUNCE_MS = 250

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
    this.clearTimer(entry)
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
    if (entry.noSessionReason !== null || !this.options.connection.isConnected) {
      return null
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
      entry.noSessionReason = null
    }
    this.changed()
  }

  /** Connection (re)established: re-open every attached document. */
  handleConnect(): void {
    for (const entry of this.entries.values()) {
      this.reset(entry)
      entry.noSessionReason = null
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
      }
      return null
    }
    const stale = entry.generation !== generation || entry.closed
    if (!result || result.sessionId === null || typeof result.sessionId !== 'string') {
      if (stale) {
        return entry.closed ? null : this.ensureSession(entry)
      }
      entry.opening = null
      entry.noSessionReason =
        (result && 'reason' in result && result.reason) || 'no language server'
      this.changed()
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
    entry.noSessionReason = null
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
    try {
      const result = await this.options.connection.request(BridgeMethods.lspRequest, {
        sessionId: session.sessionId,
        method: 'textDocument/diagnostic',
        params: { textDocument: { uri: session.uri } }
      })
      const items = lspPullDiagnosticsToItems(result)
      if (items && entry.session === session && !entry.model.isDisposed()) {
        setMarkers(entry.model, items)
      }
    } catch {
      // A dead or slow server must never break editing; markers just go stale.
    }
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

function stateOf(entry: DocumentEntry): DocumentState {
  if (entry.session) {
    return 'open'
  }
  if (entry.noSessionReason !== null) {
    return 'no-session'
  }
  return entry.opening ? 'opening' : 'pending'
}

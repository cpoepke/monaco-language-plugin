import type * as Monaco from 'monaco-editor'
import type { IDisposable, editor } from 'monaco-editor'
import {
  BridgeMethods,
  SUPPORTED_LANGUAGE_IDS,
  type DiagnosticsParams,
  type HelloResult,
  type OpenLocationParams,
  type OpenLocationResult,
  type ReadFileParams,
  type ReadFileResult,
  type SessionClosedParams
} from '@mlp/protocol'
import {
  BridgeConnection,
  errorMessage,
  type BridgeUrlSource,
  type ConnectionState,
  type ReconnectOptions,
  type WebSocketFactory
} from './connection'
import { MARKER_OWNER, lspDiagnosticsToMonacoMarkers, monacoRangeToLsp } from './conversion'
import { DocumentManager, type DocumentInfo } from './documents'
import { LocationModels, PEEK_SCHEME } from './location-models'
import { consoleWarnLogger, type Logger } from './logger'
import { ModelTracker, type AttachMode } from './model-tracker'
import {
  registerOpeners,
  type HostAdapter,
  type OpenLocationSource,
  type OpenLocationTarget
} from './openers'
import {
  DEFAULT_FEATURES,
  registerLanguageProviders,
  type FeatureOptions,
  type ProviderContext
} from './providers'
import {
  createTypeScriptWorkerFallback,
  disableBuiltinTypeScriptNavigation,
  typescriptNamespace,
  type BuiltinNavigationState
} from './typescript-builtin'

export const CLIENT_NAME = 'monaco-lsp-client/0.1.0'
export const DEFAULT_DETACH_DELAY_MS = 30_000

export type MonacoLspClientOptions = {
  /**
   * Bridge WebSocket URL including the token, e.g. `bridgeUrl(port, token)`, or a
   * function called before every (re)connect, for hosts whose port/token can change.
   */
  url: BridgeUrlSource
  /** Monaco language ids to serve. Default: SUPPORTED_LANGUAGE_IDS. */
  languages?: readonly string[]
  /**
   * Opens cross-file navigation targets (go-to-definition, peek "open", file links).
   * Without one, the bridge's `host/openLocation` is used when it reports `hostNavigation`.
   */
  host?: HostAdapter
  /** Which models may be mirrored to the bridge. Default: `file:` models of a served language. */
  shouldAttachModel?: (model: editor.ITextModel) => boolean
  /** 'visible' (default): only models an editor shows; 'all': every eligible model. */
  attach?: AttachMode
  /** Grace period before a no-longer-visible model is closed on the bridge. Default 30 s. */
  detachDelayMs?: number
  features?: FeatureOptions
  /**
   * Turn off Monaco's TS/JS worker definitions, references, hovers and document
   * symbols so they don't duplicate the bridge's; the client serves them from the
   * worker itself for models without a bridge session. Default true.
   * Create the client before the first TS/JS model for this to take effect.
   */
  disableBuiltinTypeScriptNavigation?: boolean
  /** Exponential backoff between reconnect attempts; `false` disables reconnecting. */
  reconnect?: ReconnectOptions | false
  /** Client-side timeout for bridge requests. Default 30 s. */
  requestTimeoutMs?: number
  /** Debounce for `document/change`. Default 250 ms. */
  changeDebounceMs?: number
  /** Sent in `bridge/hello`. */
  clientName?: string
  /** WebSocket constructor override (default: the global WebSocket). */
  createWebSocket?: WebSocketFactory
  logger?: Logger
}

export type MonacoLspClientStatus = {
  connection: ConnectionState
  /** Last successful handshake (null before the first one). */
  hello: HelloResult | null
  lastError: string | null
  documents: DocumentInfo[]
}

export type MonacoLspClient = {
  /** Resolves with the first successful handshake; rejects if disposed before. */
  readonly ready: Promise<HelloResult>
  status(): MonacoLspClientStatus
  onDidChangeStatus(listener: (status: MonacoLspClientStatus) => void): IDisposable
  /** Keeps `model` attached (regardless of visibility) until the disposable is disposed. */
  attachModel(model: editor.ITextModel): IDisposable
  /**
   * Sends any bridge JSON-RPC request over the live connection (e.g. `host/openLocation`).
   * Rejects with RpcError when disconnected, on timeout or on a bridge error.
   */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  dispose(): void
}

type MonacoApi = typeof Monaco

export function createMonacoLspClient(
  monaco: MonacoApi,
  options: MonacoLspClientOptions
): MonacoLspClient {
  const logger = options.logger ?? consoleWarnLogger
  const languages = new Set<string>(options.languages ?? SUPPORTED_LANGUAGE_IDS)
  const features: Required<FeatureOptions> = { ...DEFAULT_FEATURES, ...options.features }
  const disposables: IDisposable[] = []
  const statusListeners = new Set<(status: MonacoLspClientStatus) => void>()
  let disposed = false

  const connection = new BridgeConnection({
    url: options.url,
    clientName: options.clientName ?? CLIENT_NAME,
    createWebSocket: options.createWebSocket,
    reconnect: options.reconnect,
    requestTimeoutMs: options.requestTimeoutMs,
    logger
  })

  let resolveReady!: (hello: HelloResult) => void
  let rejectReady!: (error: Error) => void
  let readySettled = false
  const ready = new Promise<HelloResult>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // Why: hosts that never await `ready` must not see an unhandled rejection on dispose.
  ready.catch(() => {})

  const status = (): MonacoLspClientStatus => ({
    connection: connection.state,
    hello: connection.hello,
    lastError: connection.lastError,
    documents: documents.info()
  })
  let statusQueued = false
  const emitStatus = (): void => {
    // Why: coalesce bursts (reconnect re-opens N documents) into one notification.
    if (statusQueued || disposed) {
      return
    }
    statusQueued = true
    queueMicrotask(() => {
      statusQueued = false
      if (disposed) {
        return
      }
      const snapshot = status()
      for (const listener of [...statusListeners]) {
        try {
          listener(snapshot)
        } catch (error) {
          logger.error?.(`[mlp] status listener failed: ${errorMessage(error)}`)
        }
      }
    })
  }

  const documents = new DocumentManager<editor.ITextModel>({
    connection,
    logger,
    changeDebounceMs: options.changeDebounceMs,
    setMarkers: features.diagnostics
      ? (model, diagnostics) =>
          monaco.editor.setModelMarkers(
            model,
            MARKER_OWNER,
            lspDiagnosticsToMonacoMarkers(diagnostics, monaco.MarkerSeverity)
          )
      : null,
    onDidChange: emitStatus
  })

  const readFile = async (uri: string) => {
    try {
      const params: ReadFileParams = { uri }
      const result = await connection.request<ReadFileResult>(BridgeMethods.readFile, params)
      return typeof result?.text === 'string'
        ? { text: result.text, languageId: result.languageId ?? null }
        : null
    } catch (error) {
      logger.debug?.(`[mlp] fs/readFile ${uri} failed: ${errorMessage(error)}`)
      return null
    }
  }
  const locations = new LocationModels<Monaco.Uri>(monaco, readFile)

  // --- built-in TypeScript navigation ------------------------------------------
  let tsFallback: ProviderContext['tsFallback'] = null
  if (options.disableBuiltinTypeScriptNavigation !== false) {
    let builtin: BuiltinNavigationState | null = null
    const disableBuiltin = (): void => {
      const ts = builtin || disposed ? null : typescriptNamespace(monaco)
      if (ts) {
        builtin = disableBuiltinTypeScriptNavigation(ts)
      }
    }
    if (
      monaco.editor
        .getModels()
        .some((model) => ['typescript', 'javascript'].includes(model.getLanguageId()))
    ) {
      logger.warn?.(
        '[mlp] TS/JS models existed before createMonacoLspClient; Monaco may keep its built-in navigation providers active'
      )
    }
    disableBuiltin()
    if (!builtin && typeof monaco.languages.onLanguage === 'function') {
      // Why: the TS contribution may load after us; Monaco reads the mode configuration
      // when the language first activates, and onLanguage listeners run synchronously
      // before its (async) mode setup.
      for (const languageId of ['typescript', 'javascript']) {
        disposables.push(monaco.languages.onLanguage(languageId, disableBuiltin))
      }
    }
    tsFallback = createTypeScriptWorkerFallback(monaco, () => builtin)
    disposables.push({ dispose: () => builtin?.restore() })
  }

  // --- providers ---------------------------------------------------------------
  const providerContext: ProviderContext = {
    monaco,
    connection,
    documents,
    locations,
    features,
    tsFallback,
    logger
  }
  for (const languageId of languages) {
    disposables.push(
      ...registerLanguageProviders(
        {
          ...providerContext,
          tsFallback: languageId === 'typescript' || languageId === 'javascript' ? tsFallback : null
        },
        languageId
      )
    )
  }

  // --- navigation --------------------------------------------------------------
  const openViaBridge = async (target: OpenLocationTarget): Promise<boolean> => {
    if (!connection.hello?.hostNavigation) {
      return false
    }
    const params: OpenLocationParams = { uri: target.uri, range: monacoRangeToLsp(target.range) }
    try {
      const result = await connection.request<OpenLocationResult>(
        BridgeMethods.openLocation,
        params
      )
      return result?.opened === true
    } catch (error) {
      logger.warn?.(`[mlp] host/openLocation failed: ${errorMessage(error)}`)
      return false
    }
  }
  const openLocation = async (
    target: OpenLocationTarget,
    source: OpenLocationSource
  ): Promise<boolean> => {
    try {
      if (options.host) {
        return (await options.host.openLocation(target, source)) === true
      }
      return await openViaBridge(target)
    } catch (error) {
      logger.warn?.(`[mlp] openLocation failed: ${errorMessage(error)}`)
      return false
    }
  }

  // --- model tracking ----------------------------------------------------------
  const shouldAttachModel =
    options.shouldAttachModel ??
    ((model: editor.ITextModel) =>
      model.uri.scheme === 'file' && languages.has(model.getLanguageId()))
  const tracker = new ModelTracker<editor.ITextModel, editor.ICodeEditor>(monaco, {
    mode: options.attach ?? 'visible',
    detachDelayMs: options.detachDelayMs ?? DEFAULT_DETACH_DELAY_MS,
    shouldAttach: (model) => {
      // Why: peek models mirror files the host has not opened; the bridge must never see them.
      if (model.uri.scheme === PEEK_SCHEME) {
        return false
      }
      try {
        return shouldAttachModel(model)
      } catch {
        return false
      }
    },
    attach: (model) => {
      const existing = documents.get(model.uri.toString())
      if (existing && existing.model !== model) {
        documents.detach(existing.key)
      }
      documents.attach(model)
    },
    detach: (key) => documents.detach(key)
  })

  disposables.push(
    ...registerOpeners(
      monaco,
      openLocation,
      () => tracker.focusedEditor,
      (uri) => logger.warn?.(`[mlp] refused to open link with an unsafe scheme: ${uri}`)
    )
  )

  // --- connection wiring -------------------------------------------------------
  connection.onConnect((hello) => {
    if (!readySettled) {
      readySettled = true
      resolveReady(hello)
    }
    documents.handleConnect()
    emitStatus()
  })
  connection.onDisconnect(() => {
    documents.handleDisconnect()
    emitStatus()
  })
  connection.onStateChange(emitStatus)
  connection.onNotification((method, params) => {
    if (method === BridgeMethods.sessionClosed) {
      const closed = params as SessionClosedParams
      if (closed && typeof closed.sessionId === 'string') {
        logger.info?.(`[mlp] session ${closed.sessionId} closed: ${closed.reason}`)
        documents.handleSessionClosed(closed.sessionId)
      }
    } else if (method === BridgeMethods.diagnostics) {
      documents.handleDiagnostics(params as DiagnosticsParams)
    }
  })

  tracker.start()
  connection.start()

  return {
    ready,
    status,
    onDidChangeStatus(listener) {
      statusListeners.add(listener)
      return { dispose: () => statusListeners.delete(listener) }
    },
    attachModel(model) {
      return tracker.retain(model)
    },
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      return connection.request<T>(method, params)
    },
    dispose() {
      if (disposed) {
        return
      }
      tracker.dispose()
      documents.detachAll()
      disposed = true
      statusListeners.clear()
      for (const disposable of disposables.splice(0)) {
        try {
          disposable.dispose()
        } catch {
          // Keep tearing down.
        }
      }
      locations.dispose()
      connection.dispose()
      if (!readySettled) {
        readySettled = true
        rejectReady(new Error('Monaco LSP client disposed before connecting'))
      }
    }
  }
}

/**
 * Wire contract between the browser-side Monaco client (`@mlp/monaco-lsp-client`)
 * and the Node-side language-server bridge (`@mlp/lsp-bridge`).
 *
 * Transport: JSON-RPC 2.0 over a WebSocket, one JSON message per text frame.
 * The client connects to `ws://127.0.0.1:<port>/?token=<token>`; the bridge
 * rejects the upgrade unless the token matches.
 *
 * The bridge owns language-server processes and their LSP handshake. The client
 * never speaks raw LSP framing: it opens/changes/closes documents through the
 * `document/*` methods and forwards allowlisted position requests through
 * `lsp/request`. Results are returned verbatim from the server (raw LSP shapes).
 *
 * All positions/ranges on the wire are LSP-style: 0-based line and UTF-16
 * character offsets.
 */

export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcError = { code: number; message: string; data?: unknown }

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Bridge-specific: the referenced session no longer exists (server exited). */
  SessionNotFound: -32001,
  /** Bridge-specific: request method is not on the LSP allowlist. */
  MethodNotAllowed: -32002,
  /** Bridge-specific: path is outside every allowed root. */
  PathNotAllowed: -32003,
  /** Bridge-specific: the language server did not answer in time. */
  RequestTimeout: -32004,
  /** Bridge-specific: the host (e.g. Orca) could not be reached. */
  HostUnavailable: -32005
} as const

// ---------------------------------------------------------------------------
// LSP primitives (subset; results are passed through untyped)
// ---------------------------------------------------------------------------

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }

// ---------------------------------------------------------------------------
// Method names
// ---------------------------------------------------------------------------

export const BridgeMethods = {
  /** client → bridge request. HelloParams → HelloResult. Must be the first call. */
  hello: 'bridge/hello',
  /** client → bridge request. void → BridgeStatus. */
  status: 'bridge/status',
  /** client → bridge request. OpenDocumentParams → OpenDocumentResult. */
  openDocument: 'document/open',
  /** client → bridge notification. ChangeDocumentParams. */
  changeDocument: 'document/change',
  /** client → bridge notification. CloseDocumentParams. */
  closeDocument: 'document/close',
  /** client → bridge request. LspRequestParams → raw LSP result (or null). */
  lspRequest: 'lsp/request',
  /** client → bridge request. ReadFileParams → ReadFileResult. */
  readFile: 'fs/readFile',
  /** client → bridge request. OpenLocationParams → OpenLocationResult. */
  openLocation: 'host/openLocation',
  /** bridge → client notification. DiagnosticsParams. */
  diagnostics: 'document/diagnostics',
  /** bridge → client notification. SessionClosedParams. */
  sessionClosed: 'session/closed'
} as const

export type BridgeMethod = (typeof BridgeMethods)[keyof typeof BridgeMethods]

/**
 * LSP methods the client may forward through `lsp/request`. Everything else is
 * rejected with MethodNotAllowed. Each takes standard LSP params whose
 * `textDocument.uri` must be a document opened on the same session
 * (except `documentLink/resolve`, which takes a DocumentLink).
 */
export const LSP_REQUEST_ALLOWLIST = [
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/hover',
  'textDocument/documentSymbol',
  'textDocument/documentLink',
  'documentLink/resolve',
  'textDocument/diagnostic'
] as const

export type LspRequestMethod = (typeof LSP_REQUEST_ALLOWLIST)[number]

export function isAllowedLspMethod(method: string): method is LspRequestMethod {
  return (LSP_REQUEST_ALLOWLIST as readonly string[]).includes(method)
}

/** Monaco language ids the bridge knows how to serve. */
export const SUPPORTED_LANGUAGE_IDS = ['typescript', 'javascript', 'python', 'go', 'rust'] as const
export type SupportedLanguageId = (typeof SUPPORTED_LANGUAGE_IDS)[number]

// ---------------------------------------------------------------------------
// Params / results
// ---------------------------------------------------------------------------

export type HelloParams = {
  protocolVersion: number
  /** Free-form client identifier, e.g. "orca-injector/0.1.0". */
  client: string
}

export type HelloResult = {
  protocolVersion: number
  bridgeVersion: string
  /** Language ids for which a server binary was found on this machine. */
  availableLanguages: string[]
  /** True when `host/openLocation` is backed by a real host (e.g. Orca runtime). */
  hostNavigation: boolean
}

export type ServerStatus = {
  sessionId: string
  serverId: string
  rootPath: string
  openDocuments: number
  state: 'starting' | 'running' | 'stopped'
}

export type BridgeStatus = {
  bridgeVersion: string
  clients: number
  sessions: ServerStatus[]
  /** serverId → resolved executable path, or null when not installed. */
  servers: Record<string, string | null>
}

export type OpenDocumentParams = {
  /** file:// URI of the document (what the client's Monaco model represents). */
  uri: string
  /** Monaco language id (e.g. 'typescript', 'python'). */
  languageId: string
  /** Full text currently in the client's buffer. */
  text: string
}

export type OpenDocumentResult =
  | {
      sessionId: string
      /** Canonical file:// URI the bridge uses for this document on the server. */
      uri: string
      serverId: string
      /** Workspace root the server was started for (absolute path). */
      rootPath: string
      /** True when the server uses pull diagnostics (`textDocument/diagnostic`). */
      pullDiagnostics: boolean
    }
  | {
      sessionId: null
      /** Why no session was attached (unsupported language, server missing, …). */
      reason: string
    }

export type ChangeDocumentParams = {
  sessionId: string
  uri: string
  /** Full new text (full-document sync). */
  text: string
}

export type CloseDocumentParams = {
  sessionId: string
  uri: string
}

export type LspRequestParams = {
  sessionId: string
  method: LspRequestMethod
  params: unknown
}

export type ReadFileParams = {
  /** file:// URI. Must be inside a root of one of this connection's sessions
   *  or an explicitly allowed root. */
  uri: string
}

export type ReadFileResult = {
  uri: string
  text: string
  /** Best-effort Monaco language id inferred from the extension, if known. */
  languageId: string | null
}

export type OpenLocationParams = {
  /** file:// URI of the target file. */
  uri: string
  /** Target range (0-based, LSP style). */
  range: LspRange
}

export type OpenLocationResult = {
  opened: boolean
  /** Present when opened === false. */
  reason?: string
}

export type DiagnosticsParams = {
  sessionId: string
  uri: string
  diagnostics: unknown[]
}

export type SessionClosedParams = {
  sessionId: string
  reason: string
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Default port the bridge listens on when none is configured. */
export const DEFAULT_BRIDGE_PORT = 47_831

/** Build the WebSocket URL a client connects to. */
export function bridgeUrl(port: number, token: string, host = '127.0.0.1'): string {
  return `ws://${host}:${port}/?token=${encodeURIComponent(token)}`
}

const EXTENSION_LANGUAGE: Record<string, SupportedLanguageId> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust'
}

/** Monaco language id for a path or URI, by extension. Null when unknown. */
export function languageIdForPath(pathOrUri: string): SupportedLanguageId | null {
  const match = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(pathOrUri)
  if (!match?.[1]) return null
  return EXTENSION_LANGUAGE[match[1].toLowerCase()] ?? null
}

// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import type { LspConnection, LspExitInfo } from '../lsp/lsp-connection'
import type { WorkspaceFolder } from '../lsp/initialize-params'
import type { WatchedFilesService } from '../workspace/watched-files'
import type { PrefixMapping } from './uri-mapping'

/** Identifies one WebSocket client connection inside the bridge. */
export type ClientId = number

/** One client's hold on a document. A client may open the same file from
 *  several editors, hence the per-client count. */
export type DocumentOwner = {
  /** The URI exactly as this client sent it, so notifications match its models. */
  clientUri: string
  refCount: number
}

export type SessionDocument = {
  /** canonicalFileUriKey(serverUri): the key servers' URIs are matched on. */
  key: string
  /** URI the server knows the document by (realpath-based). */
  serverUri: string
  version: number
  text: string
  owners: Map<ClientId, DocumentOwner>
  /** canonical client-URI keys that resolve to this document (symlinked paths). */
  aliasKeys: Set<string>
  /** Last pushed diagnostics, replayed to clients that join an open document. */
  lastDiagnostics: unknown[] | null
}

export type SessionState = 'starting' | 'running' | 'stopped'

export type Session = {
  sessionId: string
  /** `${serverId}\0${rootPath}`. */
  key: string
  serverId: string
  rootPath: string
  workspaceFolders: WorkspaceFolder[]
  connection: LspConnection
  state: SessionState
  initialization: Promise<void>
  // Why: pull-model servers (tsgo, TS7) advertise diagnosticProvider and never
  // push; the client must know which model this session speaks.
  pullDiagnostics: boolean
  documents: Map<string, SessionDocument>
  /** canonical client-URI key → document key. */
  aliases: Map<string, string>
  idleTimer: NodeJS.Timeout | null
  /** openDocument calls between lookup and addOwner; such a session is not
   *  idle even when it has no documents, so it must not be evicted. */
  pendingOpens: number
  /** Per client: how its URIs spell realpath directories (symlinked roots). */
  clientMappings: Map<ClientId, PrefixMapping[]>
  /** Created when the server registers didChangeWatchedFiles watchers. */
  watchedFiles: WatchedFilesService | null
  /** Set once the process is gone. */
  exitInfo: LspExitInfo | null
}

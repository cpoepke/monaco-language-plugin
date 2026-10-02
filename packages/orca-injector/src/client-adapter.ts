/**
 * The only module that touches `@mlp/monaco-lsp-client`. Everything else talks to the small
 * `LspClientLike` / `ClientFactory` surface, so tests can inject fakes.
 */
import type * as Monaco from 'monaco-editor'
import { createMonacoLspClient } from '@mlp/monaco-lsp-client'
import type { HelloResult } from '@mlp/protocol'
import type { AttachableModel, OpenSource, OpenTarget } from './host-adapter'

export type ClientStatusLike = {
  connection: string
  hello: HelloResult | null
  lastError: string | null
  documents?: readonly unknown[]
}

export type LspClientLike = {
  readonly ready: Promise<HelloResult>
  status(): ClientStatusLike
  onDidChangeStatus(listener: (status: ClientStatusLike) => void): { dispose(): void }
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  dispose(): void
}

export type ClientLogger = {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

export type ClientFactoryOptions = {
  url: () => Promise<string>
  host: { openLocation(target: OpenTarget, source: OpenSource): Promise<boolean> }
  shouldAttachModel: (model: AttachableModel) => boolean
  clientName: string
  logger: ClientLogger
}

export type ClientFactory = (monaco: unknown, options: ClientFactoryOptions) => LspClientLike

export const createClient: ClientFactory = (monaco, options) =>
  createMonacoLspClient(monaco as typeof Monaco, {
    url: options.url,
    host: {
      openLocation: (target, source) =>
        options.host.openLocation(target, {
          editor: source.editor as unknown as OpenSource['editor'],
          modelUri: source.modelUri,
          reason: source.reason
        })
    },
    shouldAttachModel: (model) => options.shouldAttachModel(model),
    // Created synchronously at capture time, before Orca creates any TS/JS model, so Monaco's
    // built-in TS navigation is switched off and served by the client's worker fallback instead.
    disableBuiltinTypeScriptNavigation: true,
    // The plugin worker may take a few seconds to (re)start; the URL resolver itself waits.
    reconnect: { initialDelayMs: 1_000, maxDelayMs: 30_000 },
    clientName: options.clientName,
    logger: options.logger
  })

// Adapted from stablyai/orca PR #24703 (MIT). See vendor/orca-lsp.
import type { IRange } from 'monaco-editor'
import { lspRangeToMonaco, type LspLocation } from './conversion'

/** URI scheme of the read-only models that back Peek / Ctrl+hover previews for files
 *  the host has not opened. Never attached to the bridge. */
export const PEEK_SCHEME = 'mlp-peek'
/** At most this many distinct files are read per result. */
export const MAX_LOCATION_FILES = 100
/** Detached peek models beyond this count are disposed (oldest first). */
export const MAX_PEEK_MODELS = 50

export type UriLike = { scheme: string; path: string; toString(): string }

type PeekModel = {
  isAttachedToEditor(): boolean
  dispose(): void
  isDisposed?(): boolean
  getValue(): string
  setValue(value: string): void
}

/** Generic over the Uri class so real Monaco (its Uri) and tests (the esm URI) both type-check. */
export type LocationModelMonaco<U extends UriLike> = {
  Uri: { parse(value: string): U; from(components: { scheme: string; path: string }): U }
  editor: {
    getModel(uri: U): PeekModel | null
    createModel(value: string, language: string | undefined, uri: U): PeekModel
  }
}

/** Reads a file:// URI through the bridge. Null when unreadable. */
export type ReadFile = (
  fileUri: string
) => Promise<{ text: string; languageId: string | null } | null>

/**
 * Turns LSP locations into Monaco locations that Monaco can actually render:
 * files with a host model keep their file:// URI; every other file gets a
 * `mlp-peek:` model filled from `fs/readFile`, so the host's file:// model
 * namespace is never touched.
 */
export class LocationModels<U extends UriLike> {
  private readonly peekModels: { key: string; model: PeekModel }[] = []

  constructor(
    private readonly monaco: LocationModelMonaco<U>,
    private readonly readFile: ReadFile
  ) {}

  async resolve(locations: LspLocation[]): Promise<{ uri: U; range: IRange }[]> {
    const resolved = await this.resolveEach(locations)
    return resolved.filter((location): location is { uri: U; range: IRange } => location !== null)
  }

  /** Like resolve(), but aligned with the input: null where a location cannot be shown. */
  async resolveEach(locations: LspLocation[]): Promise<({ uri: U; range: IRange } | null)[]> {
    const byFile = new Map<string, Promise<U | null>>()
    const pending: ({ fileKey: string; location: LspLocation } | null)[] = []
    // Why: start every read before awaiting any, so N files cost one round of latency.
    for (const location of locations) {
      let fileUri: U
      try {
        fileUri = this.monaco.Uri.parse(location.uri)
      } catch {
        pending.push(null)
        continue
      }
      const fileKey = fileUri.toString()
      if (!byFile.has(fileKey)) {
        if (byFile.size >= MAX_LOCATION_FILES) {
          pending.push(null)
          continue
        }
        byFile.set(fileKey, this.modelUriFor(fileUri, location.uri))
      }
      pending.push({ fileKey, location })
    }
    const resolved: ({ uri: U; range: IRange } | null)[] = []
    const keep = new Set<string>()
    for (const item of pending) {
      const uri = item ? await byFile.get(item.fileKey) : null
      if (item && uri) {
        resolved.push({ uri, range: lspRangeToMonaco(item.location.range) })
        keep.add(uri.toString())
      } else {
        resolved.push(null)
      }
    }
    this.prune(keep)
    return resolved
  }

  /** Disposes every peek model this instance created. */
  dispose(): void {
    for (const { model } of this.peekModels.splice(0)) {
      if (!model.isDisposed?.()) {
        model.dispose()
      }
    }
  }

  private async modelUriFor(fileUri: U, rawUri: string): Promise<U | null> {
    if (fileUri.scheme !== 'file') {
      // Not a local file (e.g. a server-internal URI): only usable if a model exists.
      return this.monaco.editor.getModel(fileUri) ? fileUri : null
    }
    if (this.monaco.editor.getModel(fileUri)) {
      return fileUri
    }
    // Why: peek needs a model per location; a separate scheme keeps the host's file-model ownership untouched.
    const peekUri = this.monaco.Uri.from({ scheme: PEEK_SCHEME, path: fileUri.path })
    const existing = this.monaco.editor.getModel(peekUri)
    if (existing?.isAttachedToEditor()) {
      return peekUri
    }
    const file = await this.readFile(rawUri).catch(() => null)
    const current = this.monaco.editor.getModel(peekUri)
    if (current) {
      // Why: a detached peek model may be stale; an attached one is left alone mid-peek.
      if (current.isAttachedToEditor()) {
        return peekUri
      }
      if (!file) {
        current.dispose()
        return null
      }
      if (current.getValue() !== file.text) {
        current.setValue(file.text)
      }
      return peekUri
    }
    if (!file) {
      return null
    }
    this.peekModels.push({
      key: peekUri.toString(),
      model: this.monaco.editor.createModel(file.text, file.languageId ?? undefined, peekUri)
    })
    return peekUri
  }

  // Why: models of the result being returned must survive until Monaco attaches them, even past the cap.
  private prune(keep: Set<string>): void {
    for (let i = this.peekModels.length - 1; i >= 0; i--) {
      if (this.peekModels[i]!.model.isDisposed?.()) {
        this.peekModels.splice(i, 1)
      }
    }
    for (let i = 0; i < this.peekModels.length && this.peekModels.length > MAX_PEEK_MODELS;) {
      const { key, model } = this.peekModels[i]!
      if (keep.has(key) || model.isAttachedToEditor()) {
        i++
        continue
      }
      this.peekModels.splice(i, 1)
      model.dispose()
    }
    // Why: LRU — entries used by this result move to the back so they are evicted last.
    if (keep.size > 0) {
      const used = this.peekModels.filter(({ key }) => keep.has(key))
      const rest = this.peekModels.filter(({ key }) => !keep.has(key))
      this.peekModels.splice(0, this.peekModels.length, ...rest, ...used)
    }
  }
}

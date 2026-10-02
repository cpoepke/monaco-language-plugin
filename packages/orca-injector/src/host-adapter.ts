import {
  BridgeMethods,
  SUPPORTED_LANGUAGE_IDS,
  type LspRange,
  type OpenLocationParams,
  type OpenLocationResult
} from '@mlp/protocol'
import {
  applyReveal,
  type EditorLike,
  isSameFile,
  type RangeLike,
  type RevealWatcher
} from './reveal'

export type OpenTarget = { uri: string; range: RangeLike }
export type OpenSource = { editor: EditorLike | null; modelUri: string | null; reason?: string }

export type HostAdapterDeps = {
  request(method: string, params: unknown): Promise<unknown>
  watcher: Pick<RevealWatcher, 'expect' | 'clear' | 'checkAll'>
  notify(title: string, body: string): void
  log?(message: string): void
}

/** 1-based Monaco range → 0-based LSP range. */
export function toLspRange(range: RangeLike): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  }
}

const basename = (uri: string): string => {
  const path = uri.replace(/[?#].*$/, '')
  try {
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || uri
  } catch {
    return uri
  }
}

/**
 * Orca host adapter: same file → reveal in the source editor; other file → ask the bridge to open it
 * in Orca (`host/openLocation` → runtime `files.open`) and reveal once Orca shows it.
 */
export function createOrcaHostAdapter(deps: HostAdapterDeps): {
  openLocation(target: OpenTarget, source: OpenSource): Promise<boolean>
} {
  return {
    async openLocation(target, source) {
      if (source.editor && source.modelUri && isSameFile(target.uri, source.modelUri)) {
        applyReveal(source.editor, target.range)
        return true
      }
      // Arm the watcher first: Orca may mount the editor before the request returns.
      const pending = deps.watcher.expect(target)
      const params: OpenLocationParams = { uri: target.uri, range: toLspRange(target.range) }
      let result: OpenLocationResult | null
      try {
        result = (await deps.request(BridgeMethods.openLocation, params)) as OpenLocationResult
      } catch (error) {
        deps.watcher.clear(pending)
        const message = error instanceof Error ? error.message : String(error)
        deps.log?.(`host/openLocation failed: ${message}`)
        deps.notify(`Could not open ${basename(target.uri)}`, message)
        return false
      }
      if (result?.opened === true) {
        deps.watcher.checkAll()
        return true
      }
      deps.watcher.clear(pending)
      deps.notify(
        `Could not open ${basename(target.uri)}`,
        result?.reason ?? 'Orca did not open the file.'
      )
      return false
    }
  }
}

export const MAX_ATTACH_BYTES = 2 * 1024 * 1024

export type AttachableModel = {
  uri: { scheme: string }
  getLanguageId(): string
  getValueLength(): number
}

/** Only `file:` models of a supported language, up to 2 MB. */
export function shouldAttachModel(model: AttachableModel): boolean {
  return (
    model.uri.scheme === 'file' &&
    (SUPPORTED_LANGUAGE_IDS as readonly string[]).includes(model.getLanguageId()) &&
    model.getValueLength() <= MAX_ATTACH_BYTES
  )
}

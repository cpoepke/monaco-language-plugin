// Adapted from stablyai/orca PR #24703 (MIT). See vendor/orca-lsp.
import type * as Monaco from 'monaco-editor'
import type { IPosition, IRange } from 'monaco-editor'
import { parseFileLink } from './link-fragment'
import { PEEK_SCHEME, type UriLike } from './location-models'

/** Where the host should navigate: a file:// URI and a 1-based Monaco range. */
export type OpenLocationTarget = { uri: string; range: IRange }

export type OpenLocationSource = {
  /** Editor the navigation started from (null when unknown, e.g. a link outside editors). */
  editor: Monaco.editor.ICodeEditor | null
  /** URI of that editor's model at the time of the request. */
  modelUri: string | null
  /** 'definition': go-to-definition / peek "open"; 'link': a clicked file link. */
  reason: 'definition' | 'link'
}

/** Implemented by the embedding application: open a file and reveal a range. */
export interface HostAdapter {
  /** Return true when the location was opened (or will be), false to let Monaco fall back. */
  openLocation(target: OpenLocationTarget, source: OpenLocationSource): boolean | Promise<boolean>
}

function toRange(value: IRange | IPosition | undefined): IRange {
  if (!value) {
    return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  }
  if ('startLineNumber' in value) {
    return {
      startLineNumber: value.startLineNumber,
      startColumn: value.startColumn,
      endLineNumber: value.endLineNumber,
      endColumn: value.endColumn
    }
  }
  return {
    startLineNumber: value.lineNumber,
    startColumn: value.column,
    endLineNumber: value.lineNumber,
    endColumn: value.column
  }
}

/**
 * Maps what Monaco wants to open (a `file:` or `mlp-peek:` resource plus a
 * selection) to a host navigation target. Null when Monaco should handle it
 * itself: other schemes, or the source editor already shows the resource.
 */
export function resolveEditorOpenTarget(
  resource: UriLike,
  selectionOrPosition: IRange | IPosition | undefined,
  sourceModelUri: string | null,
  toFileUri: (path: string) => string
): OpenLocationTarget | null {
  if (resource.scheme !== 'file' && resource.scheme !== PEEK_SCHEME) {
    return null
  }
  if (resource.scheme === 'file' && sourceModelUri === resource.toString()) {
    return null
  }
  const uri = resource.scheme === 'file' ? resource.toString() : toFileUri(resource.path)
  return { uri, range: toRange(selectionOrPosition) }
}

/** Schemes the link opener lets through to Monaco's default opener (opened externally). */
const EXTERNAL_LINK_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * What the link opener does with a clicked link: route `file:` links to the host,
 * pass http(s)/mailto through to Monaco, and swallow everything else.
 * Why: Monaco opens document links with `allowCommands: true`; refusing `command:`,
 * `javascript:`, `vscode:` and similar here keeps a hostile link from reaching the
 * command opener even if it slipped past provider-side filtering.
 */
export function classifyLink(resource: { scheme: string }): 'host' | 'external' | 'blocked' {
  const scheme = resource.scheme.toLowerCase()
  if (scheme === 'file') {
    return 'host'
  }
  return EXTERNAL_LINK_SCHEMES.has(scheme) ? 'external' : 'blocked'
}

/** Maps a clicked link to a host navigation target; null for non-file links. */
export function resolveLinkOpenTarget(resource: {
  scheme: string
  toString(skipEncoding?: boolean): string
}): OpenLocationTarget | null {
  if (resource.scheme !== 'file') {
    return null
  }
  return parseFileLink(resource.toString())
}

type OpenerMonaco = Pick<typeof Monaco, 'Uri'> & {
  editor: Pick<typeof Monaco.editor, 'registerEditorOpener' | 'registerLinkOpener'>
}

export function registerOpeners(
  monaco: OpenerMonaco,
  open: (target: OpenLocationTarget, source: OpenLocationSource) => Promise<boolean>,
  focusedEditor: () => Monaco.editor.ICodeEditor | null,
  onBlockedLink?: (uri: string) => void
): Monaco.IDisposable[] {
  const toFileUri = (path: string): string => monaco.Uri.from({ scheme: 'file', path }).toString()
  return [
    monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        const modelUri = source.getModel()?.uri.toString() ?? null
        const target = resolveEditorOpenTarget(resource, selectionOrPosition, modelUri, toFileUri)
        if (!target) {
          return false
        }
        return open(target, { editor: source, modelUri, reason: 'definition' })
      }
    }),
    monaco.editor.registerLinkOpener({
      open(resource) {
        const kind = classifyLink(resource)
        if (kind === 'blocked') {
          onBlockedLink?.(resource.toString())
          return true
        }
        const target = kind === 'host' ? resolveLinkOpenTarget(resource) : null
        if (!target) {
          // Why: http(s) and mailto fall through to Monaco's default opener.
          return false
        }
        const editor = focusedEditor()
        return open(target, {
          editor,
          modelUri: editor?.getModel()?.uri.toString() ?? null,
          reason: 'link'
        })
      }
    })
  ]
}

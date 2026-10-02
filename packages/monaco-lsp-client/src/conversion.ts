// Adapted from stablyai/orca PR #14873 and PR #24703 (MIT). See vendor/orca-lsp.
/** Pure LSP ↔ Monaco shape converters. LSP is 0-based, Monaco 1-based; both
 *  count UTF-16 code units, so only the off-by-one shift is needed. Monaco enum
 *  values are passed in by the caller so this module stays import-free and
 *  node-testable. */

import type { IMarkdownString, IRange } from 'monaco-editor'
import type { LspPosition, LspRange } from '@mlp/protocol'

export type { LspPosition, LspRange }
export type LspLocation = { uri: string; range: LspRange }

/** Monaco marker owner used for bridge diagnostics. */
export const MARKER_OWNER = 'mlp'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && typeof value.line === 'number' && typeof value.character === 'number'
}

export function isLspRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end)
}

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function lspRangeToMonaco(range: LspRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

export function monacoRangeToLsp(range: IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  }
}

function toLocation(value: unknown): LspLocation | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.uri === 'string' && isLspRange(value.range)) {
    return { uri: value.uri, range: value.range }
  }
  // Why: LocationLink's selection range is the symbol name; targetRange is the whole body.
  const target = isLspRange(value.targetSelectionRange)
    ? value.targetSelectionRange
    : value.targetRange
  if (typeof value.targetUri === 'string' && isLspRange(target)) {
    return { uri: value.targetUri, range: target }
  }
  return null
}

/** Location | Location[] | LocationLink[] | null → Location[] (malformed entries dropped). */
export function lspLocationsFromResult(result: unknown): LspLocation[] {
  if (result === null || result === undefined) {
    return []
  }
  const items = Array.isArray(result) ? result : [result]
  return items.map(toLocation).filter((location): location is LspLocation => location !== null)
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')
}

function toMarkdown(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!isRecord(content) || typeof content.value !== 'string') {
    return null
  }
  if (typeof content.language === 'string') {
    return `\`\`\`${content.language}\n${content.value}\n\`\`\``
  }
  return content.kind === 'plaintext' ? escapeMarkdown(content.value) : content.value
}

/** LSP Hover → Monaco hover shape. Markdown is never trusted (no command links, no HTML). */
export function lspHoverToMonaco(
  result: unknown
): { contents: IMarkdownString[]; range?: IRange } | null {
  if (!isRecord(result) || result.contents === undefined || result.contents === null) {
    return null
  }
  const parts = Array.isArray(result.contents) ? result.contents : [result.contents]
  const contents = parts
    .map(toMarkdown)
    .filter((value): value is string => value !== null && value.trim().length > 0)
    .map((value): IMarkdownString => ({ value, isTrusted: false, supportHtml: false }))
  if (contents.length === 0) {
    return null
  }
  return isLspRange(result.range)
    ? { contents, range: lspRangeToMonaco(result.range) }
    : { contents }
}

type LspDiagnostic = {
  range: LspRange
  message: string
  severity?: number
  code?: string | number | { value: string | number }
  source?: string
}

export type MarkerShape = IRange & {
  severity: number
  message: string
  code?: string
  source?: string
}

export type MarkerSeverities = { Error: number; Warning: number; Info: number; Hint: number }

export function lspDiagnosticsToMonacoMarkers(
  diagnostics: unknown[],
  severities: MarkerSeverities
): MarkerShape[] {
  const severityByLspCode = [severities.Error, severities.Warning, severities.Info, severities.Hint]
  return diagnostics
    .filter(
      (diagnostic): diagnostic is LspDiagnostic =>
        isRecord(diagnostic) &&
        isLspRange(diagnostic.range) &&
        typeof diagnostic.message === 'string'
    )
    .map((diagnostic) => {
      const code =
        typeof diagnostic.code === 'object' && diagnostic.code !== null
          ? diagnostic.code.value
          : diagnostic.code
      const marker: MarkerShape = {
        ...lspRangeToMonaco(diagnostic.range),
        severity: severityByLspCode[(diagnostic.severity ?? 1) - 1] ?? severities.Error,
        message: diagnostic.message
      }
      if (code !== undefined) {
        marker.code = String(code)
      }
      if (diagnostic.source) {
        marker.source = diagnostic.source
      }
      return marker
    })
}

/** Pull-diagnostics response (textDocument/diagnostic) → diagnostic items.
 *  Null means "keep the current markers" (kind: 'unchanged' or malformed). */
export function lspPullDiagnosticsToItems(result: unknown): unknown[] | null {
  if (isRecord(result) && result.kind === 'full' && Array.isArray(result.items)) {
    return result.items
  }
  return null
}

/** Structural twin of Monaco's languages.DocumentSymbol (enum values are numeric). */
export type DocumentSymbolShape = {
  name: string
  detail: string
  /** Monaco SymbolKind (LSP SymbolKind - 1; both enums share order). */
  kind: number
  tags: number[]
  containerName?: string
  range: IRange
  selectionRange: IRange
  children?: DocumentSymbolShape[]
}

function toSymbolKind(lspKind: unknown): number {
  // Why: LSP SymbolKind is 1-based (File = 1); Monaco's is 0-based in the same order.
  return typeof lspKind === 'number' && lspKind >= 1 && lspKind <= 26 ? lspKind - 1 : 12
}

function toSymbolTags(value: Record<string, unknown>): number[] {
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag) => tag === 1) : []
  // Why: `deprecated` is the pre-3.16 spelling of SymbolTag.Deprecated (1).
  if (value.deprecated === true && tags.length === 0) {
    tags.push(1)
  }
  return tags as number[]
}

function toDocumentSymbol(value: unknown): DocumentSymbolShape | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !isLspRange(value.range)) {
    return null
  }
  const range = lspRangeToMonaco(value.range)
  const symbol: DocumentSymbolShape = {
    name: value.name,
    detail: typeof value.detail === 'string' ? value.detail : '',
    kind: toSymbolKind(value.kind),
    tags: toSymbolTags(value),
    range,
    selectionRange: isLspRange(value.selectionRange)
      ? lspRangeToMonaco(value.selectionRange)
      : range
  }
  if (Array.isArray(value.children)) {
    symbol.children = value.children
      .map(toDocumentSymbol)
      .filter((child): child is DocumentSymbolShape => child !== null)
  }
  return symbol
}

/** DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat) → Monaco symbols.
 *  Flat entries pointing at another document are dropped. */
export function lspDocumentSymbolsToMonaco(
  result: unknown,
  isSameDocument: (uri: string) => boolean = () => true
): DocumentSymbolShape[] {
  if (!Array.isArray(result)) {
    return []
  }
  const symbols: DocumentSymbolShape[] = []
  for (const item of result) {
    if (!isRecord(item)) {
      continue
    }
    if (isRecord(item.location)) {
      const location = toLocation(item.location)
      if (!location || typeof item.name !== 'string' || !isSameDocument(location.uri)) {
        continue
      }
      const range = lspRangeToMonaco(location.range)
      const symbol: DocumentSymbolShape = {
        name: item.name,
        detail: '',
        kind: toSymbolKind(item.kind),
        tags: toSymbolTags(item),
        range,
        selectionRange: range
      }
      if (typeof item.containerName === 'string' && item.containerName) {
        symbol.containerName = item.containerName
      }
      symbols.push(symbol)
      continue
    }
    const symbol = toDocumentSymbol(item)
    if (symbol) {
      symbols.push(symbol)
    }
  }
  return symbols
}

/** Monaco ILink plus the raw LSP link, kept for `documentLink/resolve`. */
export type DocumentLinkShape = {
  range: IRange
  url?: string
  tooltip?: string
  lspLink: Record<string, unknown>
}

/** URI schemes a server-provided link target may use. */
export const SAFE_LINK_SCHEMES: readonly string[] = ['file', 'http', 'https']

/**
 * True when `target` is an absolute URI whose scheme is on SAFE_LINK_SCHEMES.
 * Why: Monaco opens document links with `allowCommands: true`, so a `command:`
 * (or `javascript:`, `vscode:`, …) target from a server would run host commands.
 */
export function isSafeLinkTarget(target: unknown): target is string {
  if (typeof target !== 'string') {
    return false
  }
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)
  return match !== null && SAFE_LINK_SCHEMES.includes(match[1]!.toLowerCase())
}

/** Monaco links for a `textDocument/documentLink` result. Links whose target uses an
 *  unsafe scheme are dropped (not merely stripped, so they are never resolved either). */
export function lspDocumentLinksToMonaco(result: unknown): DocumentLinkShape[] {
  if (!Array.isArray(result)) {
    return []
  }
  const links: DocumentLinkShape[] = []
  for (const item of result) {
    if (!isRecord(item) || !isLspRange(item.range)) {
      continue
    }
    if (item.target !== undefined && item.target !== null && !isSafeLinkTarget(item.target)) {
      continue
    }
    links.push(lspDocumentLinkToMonaco(item))
  }
  return links
}

/** One LSP DocumentLink → Monaco shape; an unsafe target is left out (no `url`). */
export function lspDocumentLinkToMonaco(item: Record<string, unknown>): DocumentLinkShape {
  const link: DocumentLinkShape = {
    range: isLspRange(item.range)
      ? lspRangeToMonaco(item.range)
      : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    lspLink: item
  }
  if (isSafeLinkTarget(item.target)) {
    link.url = item.target
  }
  if (typeof item.tooltip === 'string' && item.tooltip) {
    link.tooltip = item.tooltip
  }
  return link
}

/** file:// URI → local absolute path (posix or Windows). Null for anything else. */
export function fileUriToPath(uri: string): string | null {
  const match = /^file:\/\/(?<host>[^/]*)(?<path>\/[^?#]*)/i.exec(uri)
  if (!match?.groups) {
    return null
  }
  const host = match.groups.host
  if (host && host !== 'localhost') {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(match.groups.path ?? '')
  } catch {
    return null
  }
  const driveMatch = /^\/([A-Za-z]:)(\/.*)?$/.exec(decoded)
  if (driveMatch) {
    return `${driveMatch[1]}${(driveMatch[2] ?? '/').replace(/\//g, '\\')}`
  }
  return decoded
}

/** Comparison key for file URIs: decoded path, drive letter and separators normalized. */
export function fileUriKey(uri: string): string | null {
  const path = fileUriToPath(uri)
  if (path === null) {
    return null
  }
  const drive = /^([A-Za-z]):(.*)$/.exec(path)
  return drive ? `${drive[1]!.toLowerCase()}:${drive[2]!.replace(/\\/g, '/')}` : path
}

export function isSameFileUri(a: string, b: string): boolean {
  const keyA = fileUriKey(a)
  return keyA !== null && keyA === fileUriKey(b)
}

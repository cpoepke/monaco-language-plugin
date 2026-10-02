// Adapted from stablyai/orca PR #24703 (MIT). See vendor/orca-lsp.
/**
 * Monaco ships its own TypeScript/JavaScript worker with definition, reference,
 * hover and outline providers. Running them next to the bridge's providers
 * doubles every result (Ctrl+click then opens a peek instead of navigating).
 *
 * Monaco only reads `setModeConfiguration` once, when the TS mode activates
 * (first TS/JS model), so the built-in providers cannot be toggled at runtime.
 * Instead we switch them off up front and serve the same features from the
 * worker ourselves whenever a model has no bridge session — so navigation keeps
 * working while the bridge is down, and never duplicates while it is up.
 */
import type * as Monaco from 'monaco-editor'
import type { IRange } from 'monaco-editor'
import type { DocumentSymbolShape } from './conversion'

export const NAVIGATION_MODE_KEYS = [
  'definitions',
  'references',
  'hovers',
  'documentSymbols'
] as const
export type NavigationModeKey = (typeof NAVIGATION_MODE_KEYS)[number]

type ModeConfiguration = Record<string, boolean | undefined>
type LanguageServiceDefaults = {
  readonly modeConfiguration: ModeConfiguration
  setModeConfiguration(modeConfiguration: ModeConfiguration): void
}
type GetWorker = () => Promise<(...uris: Monaco.Uri[]) => Promise<TsWorker>>

export type TypeScriptNamespace = {
  typescriptDefaults?: LanguageServiceDefaults
  javascriptDefaults?: LanguageServiceDefaults
  getTypeScriptWorker?: GetWorker
  getJavaScriptWorker?: GetWorker
}

/** Finds Monaco's TypeScript contribution: `monaco.typescript` (≥ 0.55) or `monaco.languages.typescript`. */
export function typescriptNamespace(monaco: unknown): TypeScriptNamespace | null {
  const root = monaco as { typescript?: unknown; languages?: { typescript?: unknown } } | null
  const candidates = [root?.typescript, root?.languages?.typescript]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && 'typescriptDefaults' in candidate) {
      return candidate as TypeScriptNamespace
    }
  }
  return null
}

export type BuiltinNavigationState = {
  ts: TypeScriptNamespace
  /** Per language, the navigation features Monaco had on before we switched them off. */
  previouslyEnabled: Map<string, Set<NavigationModeKey>>
  restore: () => void
}

/**
 * Turns off the built-in navigation providers for 'typescript' and 'javascript'.
 * Returns the languages whose built-in features were on (the fallback serves only
 * those) and a restore function.
 */
export function disableBuiltinTypeScriptNavigation(
  ts: TypeScriptNamespace
): BuiltinNavigationState {
  const previouslyEnabled = new Map<string, Set<NavigationModeKey>>()
  const restores: (() => void)[] = []
  const pairs: [string, LanguageServiceDefaults | undefined][] = [
    ['typescript', ts.typescriptDefaults],
    ['javascript', ts.javascriptDefaults]
  ]
  for (const [languageId, defaults] of pairs) {
    if (!defaults || typeof defaults.setModeConfiguration !== 'function') {
      continue
    }
    const original = { ...defaults.modeConfiguration }
    const enabled = new Set(NAVIGATION_MODE_KEYS.filter((key) => original[key] !== false))
    previouslyEnabled.set(languageId, enabled)
    const next: ModeConfiguration = { ...original }
    for (const key of NAVIGATION_MODE_KEYS) {
      next[key] = false
    }
    defaults.setModeConfiguration(next)
    restores.push(() => {
      // Why: keep any changes the host made since, only put our four keys back.
      const current = { ...defaults.modeConfiguration }
      for (const key of NAVIGATION_MODE_KEYS) {
        current[key] = original[key]
      }
      defaults.setModeConfiguration(current)
    })
  }
  return {
    ts,
    previouslyEnabled,
    restore: () => {
      for (const restore of restores.splice(0)) {
        restore()
      }
    }
  }
}

type TsWorker = {
  getQuickInfoAtPosition(fileName: string, offset: number): Promise<unknown>
  getDefinitionAtPosition(fileName: string, offset: number): Promise<unknown>
  getReferencesAtPosition(fileName: string, offset: number): Promise<unknown>
  getNavigationTree(fileName: string): Promise<unknown>
}
type FallbackModel = Pick<
  Monaco.editor.ITextModel,
  'uri' | 'getLanguageId' | 'getOffsetAt' | 'getPositionAt' | 'isDisposed'
>
export type WorkerFallbackMonaco = {
  editor: { getModel(uri: Monaco.Uri): FallbackModel | null }
  Uri: { parse(value: string): Monaco.Uri }
}
type Position = { lineNumber: number; column: number }
type TextSpan = { start: number; length: number }
type Location = { uri: Monaco.Uri; range: IRange }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTextSpan(value: unknown): value is TextSpan {
  return isRecord(value) && typeof value.start === 'number' && typeof value.length === 'number'
}

function partsToString(parts: unknown): string {
  return Array.isArray(parts)
    ? parts
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('')
    : ''
}

function tagsToString(tags: unknown): string {
  if (!Array.isArray(tags)) {
    return ''
  }
  return tags
    .filter(isRecord)
    .map((tag) => {
      const text = typeof tag.text === 'string' ? tag.text : partsToString(tag.text)
      return text ? `*@${String(tag.name)}* — ${text}` : `*@${String(tag.name)}*`
    })
    .join('  \n\n')
}

function spanToRange(model: FallbackModel, span: TextSpan): IRange {
  const start = model.getPositionAt(span.start)
  const end = model.getPositionAt(span.start + span.length)
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  }
}

// TS ScriptElementKind → Monaco SymbolKind (numeric; see Monaco's OutlineAdapter).
const SYMBOL_KINDS: Record<string, number> = {
  module: 1,
  class: 4,
  enum: 9,
  interface: 10,
  method: 5,
  'construct signature': 8,
  constructor: 8,
  property: 6,
  getter: 6,
  setter: 6,
  'JSX attribute': 6,
  variable: 12,
  let: 12,
  const: 13,
  function: 11,
  'local function': 11,
  type: 25,
  alias: 25,
  'enum member': 21
}

/** Monaco's own TS/JS worker navigation, for models no language server owns. */
export function createTypeScriptWorkerFallback(
  monaco: WorkerFallbackMonaco,
  /** Null until the built-in navigation was switched off (it may happen lazily). */
  getState: () => BuiltinNavigationState | null
) {
  const withWorker = async <T>(
    feature: NavigationModeKey,
    model: FallbackModel,
    run: (worker: TsWorker, fileName: string) => Promise<T>
  ): Promise<T | null> => {
    const languageId = model.getLanguageId()
    const state = getState()
    if (!state?.previouslyEnabled.get(languageId)?.has(feature)) {
      return null
    }
    const { ts } = state
    const getWorker =
      languageId === 'typescript'
        ? ts.getTypeScriptWorker
        : languageId === 'javascript'
          ? ts.getJavaScriptWorker
          : undefined
    if (!getWorker) {
      return null
    }
    try {
      const worker = await (await getWorker())(model.uri)
      return model.isDisposed() ? null : await run(worker, model.uri.toString())
    } catch {
      return null
    }
  }

  const locations = (entries: unknown): Location[] => {
    const result: Location[] = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry) || typeof entry.fileName !== 'string' || !isTextSpan(entry.textSpan)) {
        continue
      }
      // Why: like Monaco's adapter, only files that already have a model can be shown.
      const target = monaco.editor.getModel(monaco.Uri.parse(entry.fileName))
      if (target) {
        result.push({ uri: target.uri, range: spanToRange(target, entry.textSpan) })
      }
    }
    return result
  }

  const toSymbols = (model: FallbackModel, item: unknown): DocumentSymbolShape[] => {
    if (!isRecord(item) || !Array.isArray(item.spans) || !isTextSpan(item.spans[0])) {
      return []
    }
    const range = spanToRange(model, item.spans[0])
    const children = Array.isArray(item.childItems)
      ? item.childItems.flatMap((child) => toSymbols(model, child))
      : []
    return [
      {
        name: typeof item.text === 'string' ? item.text : '',
        detail: '',
        kind: SYMBOL_KINDS[String(item.kind)] ?? 12,
        tags: [],
        range,
        selectionRange: isTextSpan(item.nameSpan) ? spanToRange(model, item.nameSpan) : range,
        children
      }
    ]
  }

  return {
    hover: (model: FallbackModel, position: Position) =>
      withWorker('hovers', model, async (worker, fileName) => {
        const info: unknown = await worker.getQuickInfoAtPosition(
          fileName,
          model.getOffsetAt(position)
        )
        if (!isRecord(info) || model.isDisposed()) {
          return null
        }
        const docs = [partsToString(info.documentation), tagsToString(info.tags)]
          .filter(Boolean)
          .join('\n\n')
        return {
          range: isTextSpan(info.textSpan) ? spanToRange(model, info.textSpan) : undefined,
          contents: [
            { value: `\`\`\`typescript\n${partsToString(info.displayParts)}\n\`\`\`\n` },
            ...(docs ? [{ value: docs }] : [])
          ]
        }
      }),
    definition: (model: FallbackModel, position: Position) =>
      withWorker('definitions', model, async (worker, fileName) =>
        locations(await worker.getDefinitionAtPosition(fileName, model.getOffsetAt(position)))
      ),
    references: (model: FallbackModel, position: Position) =>
      withWorker('references', model, async (worker, fileName) =>
        locations(await worker.getReferencesAtPosition(fileName, model.getOffsetAt(position)))
      ),
    documentSymbols: (model: FallbackModel) =>
      withWorker('documentSymbols', model, async (worker, fileName) => {
        const tree: unknown = await worker.getNavigationTree(fileName)
        if (!isRecord(tree) || model.isDisposed()) {
          return null
        }
        // Why: the root node is the file itself; its children are the outline.
        return Array.isArray(tree.childItems)
          ? tree.childItems.flatMap((child) => toSymbols(model, child))
          : []
      })
  }
}

export type TypeScriptWorkerFallback = ReturnType<typeof createTypeScriptWorkerFallback>

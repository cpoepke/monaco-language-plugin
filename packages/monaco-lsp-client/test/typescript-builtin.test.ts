import { describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import {
  NAVIGATION_MODE_KEYS,
  createTypeScriptWorkerFallback,
  disableBuiltinTypeScriptNavigation,
  typescriptNamespace,
  type BuiltinNavigationState,
  type TypeScriptNamespace
} from '../src/typescript-builtin'
import { FakeMonaco, type FakeModel } from './fake-monaco'

type Defaults = NonNullable<TypeScriptNamespace['typescriptDefaults']>

function defaults(initial: Record<string, boolean | undefined> = {}) {
  let configuration: Record<string, boolean | undefined> = {
    definitions: true,
    references: true,
    hovers: true,
    documentSymbols: true,
    completionItems: true,
    ...initial
  }
  const setModeConfiguration = vi.fn((next: Record<string, boolean | undefined>) => {
    configuration = next
  })
  const value: Defaults = {
    get modeConfiguration() {
      return configuration
    },
    setModeConfiguration
  }
  return { value, setModeConfiguration, current: () => configuration }
}

describe('typescriptNamespace', () => {
  it('finds monaco.typescript (>= 0.55) and monaco.languages.typescript', () => {
    const contribution = { typescriptDefaults: {} }
    expect(typescriptNamespace({ typescript: contribution })).toBe(contribution)
    expect(typescriptNamespace({ languages: { typescript: contribution } })).toBe(contribution)
  })

  it('prefers the top-level namespace and skips look-alikes', () => {
    const real = { typescriptDefaults: {} }
    expect(typescriptNamespace({ typescript: real, languages: { typescript: {} } })).toBe(real)
    // a deprecation stub without the defaults must not shadow the real one
    expect(
      typescriptNamespace({ typescript: { deprecated: true }, languages: { typescript: real } })
    ).toBe(real)
  })

  it('returns null when Monaco has no TypeScript contribution', () => {
    expect(typescriptNamespace(null)).toBeNull()
    expect(typescriptNamespace(undefined)).toBeNull()
    expect(typescriptNamespace({})).toBeNull()
    expect(typescriptNamespace({ typescript: 'nope', languages: { typescript: 1 } })).toBeNull()
    expect(typescriptNamespace({ languages: {} })).toBeNull()
  })
})

describe('disableBuiltinTypeScriptNavigation', () => {
  it('turns the four navigation features off for both languages and restores them', () => {
    const ts = defaults()
    const js = defaults()
    const state = disableBuiltinTypeScriptNavigation({
      typescriptDefaults: ts.value,
      javascriptDefaults: js.value
    })
    for (const defaultsOf of [ts, js]) {
      expect(defaultsOf.current()).toMatchObject({
        definitions: false,
        references: false,
        hovers: false,
        documentSymbols: false,
        completionItems: true
      })
    }
    expect([...(state.previouslyEnabled.get('typescript') ?? [])].sort()).toEqual(
      [...NAVIGATION_MODE_KEYS].sort()
    )
    state.restore()
    expect(ts.current()).toMatchObject({ definitions: true, hovers: true })
    expect(js.current()).toMatchObject({ references: true, documentSymbols: true })
  })

  it('remembers which features were already off (the fallback must not serve them)', () => {
    const ts = defaults({ hovers: false, references: undefined })
    const state = disableBuiltinTypeScriptNavigation({ typescriptDefaults: ts.value })
    // `undefined` counts as enabled (Monaco's default), an explicit false does not.
    expect([...(state.previouslyEnabled.get('typescript') ?? [])].sort()).toEqual([
      'definitions',
      'documentSymbols',
      'references'
    ])
    expect(state.previouslyEnabled.has('javascript')).toBe(false)
    state.restore()
    expect(ts.current().hovers).toBe(false)
    expect(ts.current().references).toBeUndefined()
  })

  it('keeps configuration changes the host made meanwhile, and restores only once', () => {
    const ts = defaults()
    const state = disableBuiltinTypeScriptNavigation({ typescriptDefaults: ts.value })
    ts.value.setModeConfiguration({ ...ts.current(), completionItems: false, hovers: false })
    ts.setModeConfiguration.mockClear()
    state.restore()
    expect(ts.current()).toMatchObject({ completionItems: false, hovers: true, definitions: true })
    expect(ts.setModeConfiguration).toHaveBeenCalledTimes(1)
    state.restore()
    expect(ts.setModeConfiguration).toHaveBeenCalledTimes(1)
  })

  it('ignores a language whose defaults cannot be configured', () => {
    const js = defaults()
    const state = disableBuiltinTypeScriptNavigation({
      typescriptDefaults: { modeConfiguration: {} } as unknown as Defaults,
      javascriptDefaults: js.value
    })
    expect([...state.previouslyEnabled.keys()]).toEqual(['javascript'])
    const empty = disableBuiltinTypeScriptNavigation({})
    expect(empty.previouslyEnabled.size).toBe(0)
    expect(() => empty.restore()).not.toThrow()
  })
})

type FallbackArg = Parameters<ReturnType<typeof createTypeScriptWorkerFallback>['hover']>[0]
/** FakeModel is structurally what the fallback needs, minus Monaco's full Position class. */
function createModel(monaco: FakeMonaco, value: string, language: string, uri: URI) {
  return monaco.createModel(value, language, uri) as unknown as FallbackArg & FakeModel
}

describe('createTypeScriptWorkerFallback', () => {
  const source = [
    'export function greet(name: string) {', // offsets 0..37
    '  return name',
    '}',
    ''
  ].join('\n')

  type Worker = {
    getQuickInfoAtPosition: ReturnType<typeof vi.fn>
    getDefinitionAtPosition: ReturnType<typeof vi.fn>
    getReferencesAtPosition: ReturnType<typeof vi.fn>
    getNavigationTree: ReturnType<typeof vi.fn>
  }

  function setup(options: { disabled?: Record<string, boolean>; language?: string } = {}) {
    const monaco = new FakeMonaco()
    const worker: Worker = {
      getQuickInfoAtPosition: vi.fn(async () => undefined),
      getDefinitionAtPosition: vi.fn(async () => []),
      getReferencesAtPosition: vi.fn(async () => []),
      getNavigationTree: vi.fn(async () => undefined)
    }
    const requestedFor: URI[] = []
    const getWorker = vi.fn(async () => async (...uris: URI[]) => {
      requestedFor.push(...uris)
      return worker
    })
    const ts = defaults(options.disabled)
    const namespace: TypeScriptNamespace = {
      typescriptDefaults: ts.value,
      javascriptDefaults: defaults().value,
      getTypeScriptWorker: getWorker as never,
      getJavaScriptWorker: getWorker as never
    }
    const state: BuiltinNavigationState = disableBuiltinTypeScriptNavigation(namespace)
    const fallback = createTypeScriptWorkerFallback(monaco.asMonaco() as never, () => state)
    const model = createModel(
      monaco,
      source,
      options.language ?? 'typescript',
      URI.file('/repo/a.ts')
    )
    return { monaco, worker, fallback, model, state, getWorker, requestedFor, namespace }
  }

  const at = { lineNumber: 1, column: 17 }

  describe('gating', () => {
    it('answers null until the built-in navigation was switched off', async () => {
      const monaco = new FakeMonaco()
      const fallback = createTypeScriptWorkerFallback(monaco.asMonaco() as never, () => null)
      const model = createModel(monaco, source, 'typescript', URI.file('/repo/a.ts'))
      expect(await fallback.hover(model, at)).toBeNull()
      expect(await fallback.definition(model, at)).toBeNull()
      expect(await fallback.references(model, at)).toBeNull()
      expect(await fallback.documentSymbols(model)).toBeNull()
    })

    it('does not serve features Monaco had off before we did', async () => {
      const { fallback, model, worker } = setup({ disabled: { hovers: false } })
      worker.getQuickInfoAtPosition.mockResolvedValue({ displayParts: [{ text: 'x' }] })
      expect(await fallback.hover(model, at)).toBeNull()
      expect(worker.getQuickInfoAtPosition).not.toHaveBeenCalled()
    })

    it('does not serve languages outside typescript/javascript', async () => {
      const { fallback, model, getWorker } = setup({ language: 'python' })
      expect(await fallback.definition(model, at)).toBeNull()
      expect(getWorker).not.toHaveBeenCalled()
    })

    it('answers null when the worker getter of the language is missing', async () => {
      const { fallback, model, namespace } = setup()
      delete namespace.getTypeScriptWorker
      expect(await fallback.definition(model, at)).toBeNull()
    })

    it('uses the JavaScript worker for javascript models', async () => {
      const { fallback, monaco, namespace, worker } = setup()
      const jsGetter = vi.fn(async () => async () => worker)
      namespace.getJavaScriptWorker = jsGetter as never
      const jsModel = createModel(monaco, source, 'javascript', URI.file('/repo/a.js'))
      await fallback.definition(jsModel, at)
      expect(jsGetter).toHaveBeenCalledTimes(1)
    })

    it('answers null when the worker fails to start or to answer', async () => {
      const { fallback, model, worker, namespace } = setup()
      worker.getDefinitionAtPosition.mockRejectedValue(new Error('worker crashed'))
      expect(await fallback.definition(model, at)).toBeNull()
      namespace.getTypeScriptWorker = (() => Promise.reject(new Error('no worker'))) as never
      expect(await fallback.references(model, at)).toBeNull()
    })

    it('answers null when the model is disposed while the worker boots', async () => {
      const { fallback, model, worker, namespace } = setup()
      namespace.getTypeScriptWorker = (async () => {
        model.dispose()
        return async () => worker
      }) as never
      expect(await fallback.definition(model, at)).toBeNull()
      expect(worker.getDefinitionAtPosition).not.toHaveBeenCalled()
    })

    it('passes the model URI as the worker file name and the offset of the position', async () => {
      const { fallback, model, worker, requestedFor } = setup()
      await fallback.definition(model, { lineNumber: 2, column: 3 })
      expect(requestedFor.map(String)).toEqual([model.uri.toString()])
      expect(worker.getDefinitionAtPosition).toHaveBeenCalledWith(
        model.uri.toString(),
        model.getOffsetAt({ lineNumber: 2, column: 3 })
      )
    })
  })

  describe('hover', () => {
    it('renders display parts, documentation and tags as markdown', async () => {
      const { fallback, model, worker } = setup()
      worker.getQuickInfoAtPosition.mockResolvedValue({
        textSpan: { start: 16, length: 5 },
        displayParts: [{ text: 'function ' }, { text: 'greet' }, 42, null],
        documentation: [{ text: 'Says hello.' }],
        tags: [
          { name: 'param', text: [{ text: 'name' }, { text: ' who' }] },
          { name: 'deprecated' },
          { name: 'see', text: 'plain string' },
          'not a tag'
        ]
      })
      expect(await fallback.hover(model, at)).toEqual({
        range: { startLineNumber: 1, startColumn: 17, endLineNumber: 1, endColumn: 22 },
        contents: [
          { value: '```typescript\nfunction greet\n```\n' },
          {
            value:
              'Says hello.\n\n*@param* — name who  \n\n*@deprecated*  \n\n*@see* — plain string'
          }
        ]
      })
    })

    it('omits the documentation block and the range when the worker has none', async () => {
      const { fallback, model, worker } = setup()
      worker.getQuickInfoAtPosition.mockResolvedValue({
        displayParts: [{ text: 'const x' }],
        documentation: 'not parts',
        tags: 'not tags',
        textSpan: { start: 'bad' }
      })
      expect(await fallback.hover(model, at)).toEqual({
        range: undefined,
        contents: [{ value: '```typescript\nconst x\n```\n' }]
      })
    })

    it('answers null for an empty or malformed quick-info', async () => {
      const { fallback, model, worker } = setup()
      expect(await fallback.hover(model, at)).toBeNull()
      worker.getQuickInfoAtPosition.mockResolvedValue('string')
      expect(await fallback.hover(model, at)).toBeNull()
    })

    it('answers null when the model is disposed during the request', async () => {
      const { fallback, model, worker } = setup()
      worker.getQuickInfoAtPosition.mockImplementation(async () => {
        model.dispose()
        return { displayParts: [{ text: 'x' }] }
      })
      expect(await fallback.hover(model, at)).toBeNull()
    })
  })

  describe('definition and references', () => {
    it('maps worker spans to models that exist and skips everything else', async () => {
      const { fallback, model, monaco, worker } = setup()
      const other = createModel(monaco, 'const other = 1\n', 'typescript', URI.file('/repo/b.ts'))
      worker.getDefinitionAtPosition.mockResolvedValue([
        { fileName: model.uri.toString(), textSpan: { start: 16, length: 5 } },
        { fileName: other.uri.toString(), textSpan: { start: 6, length: 5 } },
        // no model for this file: Monaco's own adapter cannot show it either
        { fileName: 'file:///repo/unopened.ts', textSpan: { start: 0, length: 1 } },
        { fileName: model.uri.toString() }, // no text span
        { textSpan: { start: 0, length: 1 } }, // no file name
        'garbage',
        null
      ])
      const result = (await fallback.definition(model, at)) as {
        uri: URI
        range: unknown
      }[]
      expect(result.map((location) => location.uri.toString())).toEqual([
        model.uri.toString(),
        other.uri.toString()
      ])
      expect(result[1]?.range).toEqual({
        startLineNumber: 1,
        startColumn: 7,
        endLineNumber: 1,
        endColumn: 12
      })
    })

    it('treats a non-array worker answer as no locations', async () => {
      const { fallback, model, worker } = setup()
      worker.getReferencesAtPosition.mockResolvedValue(undefined)
      expect(await fallback.references(model, at)).toEqual([])
      worker.getReferencesAtPosition.mockResolvedValue([
        { fileName: model.uri.toString(), textSpan: { start: 0, length: 6 } }
      ])
      expect(await fallback.references(model, at)).toHaveLength(1)
    })
  })

  describe('documentSymbols', () => {
    it('builds the outline from the navigation tree (root node skipped)', async () => {
      const { fallback, model, worker } = setup()
      worker.getNavigationTree.mockResolvedValue({
        text: '<global>',
        kind: 'script',
        spans: [{ start: 0, length: source.length }],
        childItems: [
          {
            text: 'greet',
            kind: 'function',
            spans: [{ start: 0, length: 40 }],
            nameSpan: { start: 16, length: 5 },
            childItems: [
              { text: 'inner', kind: 'const', spans: [{ start: 24, length: 11 }] },
              { text: 'broken', kind: 'const', spans: [] }
            ]
          },
          { text: 'Kind', kind: 'something new', spans: [{ start: 41, length: 1 }] },
          { kind: 'class', spans: [{ start: 0, length: 1 }] },
          { text: 'no spans' },
          'garbage'
        ]
      })
      const symbols = (await fallback.documentSymbols(model)) as {
        name: string
        kind: number
        selectionRange: unknown
        range: unknown
        children: { name: string; selectionRange: unknown; range: unknown }[]
      }[]
      expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
        ['greet', 11],
        ['Kind', 12], // unknown ScriptElementKind falls back to Variable
        ['', 4] // missing text becomes an empty name
      ])
      expect(symbols[0]?.selectionRange).toEqual({
        startLineNumber: 1,
        startColumn: 17,
        endLineNumber: 1,
        endColumn: 22
      })
      expect(symbols[1]?.selectionRange).toEqual(symbols[1]?.range)
      expect(symbols[0]?.children.map((child) => child.name)).toEqual(['inner'])
    })

    it('answers an empty outline for a tree without children and null for junk', async () => {
      const { fallback, model, worker } = setup()
      worker.getNavigationTree.mockResolvedValue({ text: '<global>' })
      expect(await fallback.documentSymbols(model)).toEqual([])
      worker.getNavigationTree.mockResolvedValue(7)
      expect(await fallback.documentSymbols(model)).toBeNull()
    })

    it('answers null when the model is disposed during the request', async () => {
      const { fallback, model, worker } = setup()
      worker.getNavigationTree.mockImplementation(async () => {
        model.dispose()
        return { childItems: [] }
      })
      expect(await fallback.documentSymbols(model)).toBeNull()
    })
  })
})

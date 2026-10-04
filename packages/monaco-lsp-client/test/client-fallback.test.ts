/**
 * The client against a scripted bridge: the fallback to Monaco's own TypeScript
 * worker for files without a language-server session, provider failure paths,
 * and lifecycle edges of the client facade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import {
  CLIENT_NAME,
  createMonacoLspClient,
  type MonacoLspClient,
  type MonacoLspClientOptions
} from '../src/client'
import { consoleWarnLogger } from '../src/logger'
import { FakeMonaco, waitFor } from './fake-monaco'
import { MockBridge, RpcFailure } from './mock-bridge'

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} })
}
const lspRange = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end }
})
const at = { lineNumber: 1, column: 8 }

let bridge: MockBridge
let monaco: FakeMonaco
let client: MonacoLspClient | null = null
const warnings: string[] = []

function start(options: Partial<MonacoLspClientOptions> = {}): MonacoLspClient {
  client = createMonacoLspClient(monaco.asMonaco(), {
    url: bridge.url,
    changeDebounceMs: 40,
    detachDelayMs: 60,
    reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    logger: { warn: (message) => warnings.push(message) },
    ...options
  })
  return client
}

function tsModel(path: string, text = 'export const x = 1\n') {
  return monaco.createModel(text, 'typescript', URI.file(path))
}

/** A fake Monaco TS worker; the quick-info/definition results are set per test. */
function installTsWorker(
  impl: Partial<{
    quickInfo: unknown
    definitions: unknown
    references: unknown
    tree: unknown
  }> = {}
) {
  const worker = {
    getQuickInfoAtPosition: vi.fn(async () => impl.quickInfo),
    getDefinitionAtPosition: vi.fn(async () => impl.definitions),
    getReferencesAtPosition: vi.fn(async () => impl.references),
    getNavigationTree: vi.fn(async () => impl.tree)
  }
  const ts = monaco.typescript!
  ts.getTypeScriptWorker = async () => async () => worker
  ts.getJavaScriptWorker = async () => async () => worker
  return worker
}

beforeEach(async () => {
  warnings.length = 0
  bridge = await MockBridge.start()
  monaco = new FakeMonaco()
})

afterEach(async () => {
  client?.dispose()
  client = null
  await bridge.close()
})

describe('fallback to Monaco’s TypeScript worker', () => {
  it('serves definitions, references, hovers and symbols for a model with no session', async () => {
    const model = tsModel('/repo/src/a.ts', 'export function greet() {}\n')
    const other = tsModel('/repo/src/b.ts', 'greet()\n')
    const worker = installTsWorker({
      quickInfo: {
        displayParts: [{ text: 'function greet(): void' }],
        documentation: [{ text: 'Says hello' }],
        textSpan: { start: 16, length: 5 }
      },
      definitions: [{ fileName: model.uri.toString(), textSpan: { start: 16, length: 5 } }],
      references: [
        { fileName: model.uri.toString(), textSpan: { start: 16, length: 5 } },
        { fileName: other.uri.toString(), textSpan: { start: 0, length: 5 } }
      ],
      tree: {
        childItems: [
          {
            text: 'greet',
            kind: 'function',
            spans: [{ start: 0, length: 25 }],
            nameSpan: { start: 16, length: 5 }
          }
        ]
      }
    })
    const lsp = start()
    await lsp.ready // connected, but this model was never attached (no editor shows it)
    expect(bridge.messages('document/open')).toHaveLength(0)

    const definition = (await monaco.provider('definition', 'typescript').provideDefinition!(
      model,
      at,
      token
    )) as { uri: URI; range: { startColumn: number } }[]
    expect(definition.map((d) => d.uri.toString())).toEqual([model.uri.toString()])
    expect(definition[0]?.range.startColumn).toBe(17)

    const references = (await monaco.provider('references', 'typescript').provideReferences!(
      model,
      at,
      { includeDeclaration: true },
      token
    )) as { uri: URI }[]
    expect(references.map((r) => r.uri.toString())).toEqual([
      model.uri.toString(),
      other.uri.toString()
    ])

    const hover = (await monaco.provider('hover', 'typescript').provideHover!(
      model,
      at,
      token
    )) as { contents: { value: string }[] }
    expect(hover.contents.map((c) => c.value)).toEqual([
      '```typescript\nfunction greet(): void\n```\n',
      'Says hello'
    ])

    const symbols = (await monaco.provider('documentSymbols', 'typescript').provideDocumentSymbols!(
      model,
      token
    )) as { name: string }[]
    expect(symbols.map((s) => s.name)).toEqual(['greet'])
    expect(worker.getDefinitionAtPosition).toHaveBeenCalledTimes(1)
    expect(bridge.messages('lsp/request')).toHaveLength(0)
  })

  it('also serves files whose server could not be started', async () => {
    bridge.handlers.set('document/open', () => ({
      sessionId: null,
      reason: 'typescript-language-server not found'
    }))
    const worker = installTsWorker({ definitions: [] })
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'no-session')
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toEqual([])
    expect(worker.getDefinitionAtPosition).toHaveBeenCalledTimes(1)
  })

  it('keeps navigating while the bridge is down', async () => {
    const url = bridge.url
    await bridge.close()
    const worker = installTsWorker({ definitions: [] })
    const lsp = start({ url })
    const model = tsModel('/repo/src/a.ts')
    monaco.createEditor(model)
    expect(lsp.status().connection).not.toBe('connected')
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toEqual([])
    expect(worker.getDefinitionAtPosition).toHaveBeenCalledTimes(1)
    lsp.dispose()
    bridge = await MockBridge.start()
  })

  it('serves JavaScript models from the JavaScript worker', async () => {
    const worker = installTsWorker({ quickInfo: { displayParts: [{ text: 'var x' }] } })
    const lsp = start({ languages: ['javascript'] })
    await lsp.ready
    const model = monaco.createModel('var x', 'javascript', URI.file('/repo/a.js'))
    const hover = (await monaco.provider('hover', 'javascript').provideHover!(
      model,
      at,
      token
    )) as { contents: unknown[] }
    expect(hover.contents).toHaveLength(1)
    expect(worker.getQuickInfoAtPosition).toHaveBeenCalledTimes(1)
  })

  it('never falls back for declaration, type definition and implementation', async () => {
    const worker = installTsWorker({ definitions: [] })
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    for (const [kind, method] of [
      ['declaration', 'provideDeclaration'],
      ['typeDefinition', 'provideTypeDefinition'],
      ['implementation', 'provideImplementation']
    ] as const) {
      expect(await monaco.provider(kind, 'typescript')[method]!(model, at, token)).toBeNull()
    }
    expect(worker.getDefinitionAtPosition).not.toHaveBeenCalled()
  })

  it('does not fall back for other languages', async () => {
    installTsWorker({ quickInfo: { displayParts: [{ text: 'x' }] } })
    const lsp = start({ languages: ['typescript', 'python'] })
    await lsp.ready
    const model = monaco.createModel('x = 1', 'python', URI.file('/repo/a.py'))
    expect(await monaco.provider('hover', 'python').provideHover!(model, at, token)).toBeNull()
    expect(
      await monaco.provider('documentSymbols', 'python').provideDocumentSymbols!(model, token)
    ).toBeNull()
    expect(
      await monaco.provider('definition', 'python').provideDefinition!(model, at, token)
    ).toBeNull()
  })

  it('has no fallback (and leaves Monaco alone) when built-in navigation is not disabled', async () => {
    const worker = installTsWorker({ quickInfo: { displayParts: [{ text: 'x' }] } })
    const lsp = start({ disableBuiltinTypeScriptNavigation: false })
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    expect(await monaco.provider('hover', 'typescript').provideHover!(model, at, token)).toBeNull()
    expect(
      await monaco.provider('documentSymbols', 'typescript').provideDocumentSymbols!(model, token)
    ).toBeNull()
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toBeNull()
    expect(worker.getQuickInfoAtPosition).not.toHaveBeenCalled()
    expect(monaco.modeConfiguration.hovers).toBe(true)
  })

  it('does not serve a feature Monaco had switched off itself', async () => {
    monaco.modeConfiguration = { ...monaco.modeConfiguration, hovers: false }
    ;(
      monaco.typescript!.typescriptDefaults as { setModeConfiguration(c: unknown): void }
    ).setModeConfiguration(monaco.modeConfiguration)
    const worker = installTsWorker({ quickInfo: { displayParts: [{ text: 'x' }] } })
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    expect(await monaco.provider('hover', 'typescript').provideHover!(model, at, token)).toBeNull()
    expect(worker.getQuickInfoAtPosition).not.toHaveBeenCalled()
  })

  it('serves nothing from the worker before the lazy TS contribution has loaded', async () => {
    const contribution = monaco.typescript
    monaco.typescript = undefined
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toBeNull()
    monaco.typescript = contribution
    const worker = installTsWorker({ definitions: [] })
    monaco.activateLanguage('typescript')
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toEqual([])
    expect(worker.getDefinitionAtPosition).toHaveBeenCalledTimes(1)
  })

  it('uses monaco.languages.typescript when the top-level namespace is absent', async () => {
    const contribution = monaco.typescript
    monaco.typescript = undefined
    ;(monaco.languages as Record<string, unknown>).typescript = contribution
    start()
    expect(monaco.modeConfiguration).toMatchObject({ definitions: false, hovers: false })
  })

  it('does not hook onLanguage twice once the namespace was found, and tolerates its absence', () => {
    const listenersBefore = monaco.languageListeners.size
    start()
    expect(monaco.languageListeners.size).toBe(listenersBefore)
    client?.dispose()
    const bare = new FakeMonaco()
    bare.typescript = undefined
    ;(bare.languages as Record<string, unknown>).onLanguage = undefined
    const lsp = createMonacoLspClient(bare.asMonaco(), { url: bridge.url, logger: {} })
    lsp.dispose()
  })

  it('warns when TS models existed before the client was created', () => {
    tsModel('/repo/src/early.ts')
    start()
    expect(warnings.some((w) => /existed before createMonacoLspClient/.test(w))).toBe(true)
  })

  it('does not disable navigation after dispose when a late language event fires', () => {
    const contribution = monaco.typescript
    monaco.typescript = undefined
    const lsp = start()
    lsp.dispose()
    monaco.typescript = contribution
    monaco.activateLanguage('typescript')
    expect(monaco.modeConfiguration.definitions).toBe(true)
  })
})

describe('provider failure paths', () => {
  async function opened(options: Partial<MonacoLspClientOptions> = {}) {
    const lsp = start(options)
    await lsp.ready
    const model = tsModel('/repo/src/app.ts', "import { greet } from './greeter'\ngreet('x')\n")
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    return { lsp, model }
  }

  it('answers null for every feature when the server errors', async () => {
    const { model } = await opened()
    bridge.handlers.set('lsp/request', () => {
      throw new RpcFailure(JsonRpcErrorCodes.InternalError, 'server crashed')
    })
    expect(
      await monaco.provider('documentSymbols', 'typescript').provideDocumentSymbols!(model, token)
    ).toBeNull()
    expect(await monaco.provider('links', 'typescript').provideLinks!(model, token)).toBeNull()
    expect(
      await monaco.provider('references', 'typescript').provideReferences!(
        model,
        at,
        undefined,
        token
      )
    ).toBeNull()
    expect(await monaco.provider('hover', 'typescript').provideHover!(model, at, token)).toBeNull()
    // The references provider defaults includeDeclaration to true.
    expect(bridge.messages('lsp/request').at(-2)?.params).toMatchObject({
      method: 'textDocument/references',
      params: { context: { includeDeclaration: true } }
    })
  })

  it('answers null when the request times out instead of hanging the editor', async () => {
    const { model } = await opened({ requestTimeoutMs: 50 })
    bridge.handlers.set('lsp/request', () => new Promise(() => {}))
    const startedAt = Date.now()
    expect(await monaco.provider('hover', 'typescript').provideHover!(model, at, token)).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  it('answers null when the connection drops mid-request', async () => {
    const { model } = await opened()
    bridge.handlers.set('lsp/request', () => {
      bridge.dropConnections()
      return new Promise(() => {})
    })
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toBeNull()
  })

  it('answers null for a result it cannot interpret', async () => {
    const { model } = await opened()
    bridge.handlers.set('lsp/request', () => ({ unexpected: true }))
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toEqual([])
    expect(await monaco.provider('hover', 'typescript').provideHover!(model, at, token)).toBeNull()
    expect(
      await monaco.provider('documentSymbols', 'typescript').provideDocumentSymbols!(model, token)
    ).toEqual([])
  })

  it('drops cross-file locations whose file the bridge cannot read', async () => {
    const { model } = await opened()
    bridge.handlers.set('fs/readFile', () => {
      throw new RpcFailure(JsonRpcErrorCodes.PathNotAllowed, 'outside the workspace')
    })
    bridge.handlers.set('lsp/request', () => [
      { uri: 'file:///etc/passwd', range: lspRange(0, 0, 1) },
      { uri: 'file:///repo/src/app.ts', range: lspRange(1, 0, 5) }
    ])
    const result = (await monaco.provider('definition', 'typescript').provideDefinition!(
      model,
      at,
      token
    )) as { uri: URI }[]
    expect(result.map((r) => r.uri.toString())).toEqual([model.uri.toString()])
  })

  it('answers null for a location result when the token was cancelled meanwhile', async () => {
    const { model } = await opened()
    let cancelled = false
    const lateToken = {
      get isCancellationRequested() {
        return cancelled
      },
      onCancellationRequested: () => ({ dispose() {} })
    }
    bridge.handlers.set('lsp/request', () => {
      cancelled = true // flips without the listener firing, as when a token races the answer
      return { uri: 'file:///repo/src/app.ts', range: lspRange(0, 0, 1) }
    })
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, lateToken)
    ).toBeNull()
  })

  it('maps document symbols of the session’s own document', async () => {
    const { model } = await opened()
    bridge.handlers.set('lsp/request', () => [
      {
        name: 'greet',
        kind: 12,
        range: lspRange(1, 0, 10),
        selectionRange: lspRange(1, 0, 5)
      },
      {
        name: 'elsewhere',
        kind: 12,
        location: { uri: 'file:///repo/src/other.ts', range: lspRange(0, 0, 1) }
      },
      {
        name: 'local',
        kind: 13,
        location: { uri: model.uri.toString(), range: lspRange(0, 0, 1) }
      }
    ])
    const symbols = (await monaco.provider('documentSymbols', 'typescript').provideDocumentSymbols!(
      model,
      token
    )) as { name: string }[]
    expect(symbols.map((s) => s.name)).toEqual(['greet', 'local'])
  })

  it('resolves only safe links and survives resolve failures', async () => {
    const { model } = await opened()
    const provider = monaco.provider('links', 'typescript')
    bridge.handlers.set('lsp/request', (params) => {
      const { method } = params as { method: string }
      if (method === 'textDocument/documentLink') {
        return [
          { range: lspRange(0, 0, 3), data: 1, tooltip: 'first' },
          { range: lspRange(0, 4, 6), data: 2 },
          { range: lspRange(0, 7, 9), data: 3 }
        ]
      }
      return null
    })
    const { links } = (await provider.provideLinks!(model, token)) as {
      links: { range: unknown; tooltip?: string }[]
    }
    expect(links[0]?.tooltip).toBe('first')
    // a link that already has a safe target is handed back untouched
    const safe = { range: links[0]!.range, url: 'https://example.com' }
    expect(await provider.resolveLink!(safe, token)).toBe(safe)
    // a link without bridge bookkeeping and without a url has nothing to resolve
    const bare = { range: links[0]!.range }
    expect(await provider.resolveLink!(bare, token)).toBe(bare)
    // null / non-object answers
    expect(await provider.resolveLink!(links[1], token)).toBeNull()
    bridge.handlers.set('lsp/request', () => 'junk')
    expect(await provider.resolveLink!(links[1], token)).toBeNull()
    // a resolve that carries no target at all
    bridge.handlers.set('lsp/request', () => ({ range: lspRange(0, 0, 1) }))
    expect(await provider.resolveLink!(links[2], token)).toBeNull()
    // a failing server
    bridge.handlers.set('lsp/request', () => {
      throw new RpcFailure(JsonRpcErrorCodes.InternalError, 'nope')
    })
    expect(await provider.resolveLink!(links[2], token)).toBeNull()
  })

  it('registers no providers for switched-off features', async () => {
    const lsp = start({
      features: {
        definition: false,
        declaration: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        hover: false,
        documentSymbols: false,
        documentLinks: false
      }
    })
    await lsp.ready
    expect([...monaco.providers.values()].flat()).toHaveLength(0)
    lsp.dispose()
    expect([...monaco.providers.values()].flat()).toHaveLength(0)
  })

  it('removes its providers on dispose', async () => {
    const lsp = start()
    await lsp.ready
    expect(monaco.providers.get('hover')).toHaveLength(5) // one per default language
    lsp.dispose()
    expect(monaco.providers.get('hover')).toHaveLength(0)
  })
})

describe('client facade', () => {
  it('reports its client name in the hello', async () => {
    const lsp = start()
    await lsp.ready
    expect(bridge.messages('bridge/hello')[0]?.params).toMatchObject({ client: CLIENT_NAME })
    lsp.dispose()
    client = start({ clientName: 'custom/1' })
    await client.ready
    expect(bridge.messages('bridge/hello').at(-1)?.params).toMatchObject({ client: 'custom/1' })
  })

  it('isolates a throwing status listener and stops notifying after dispose', async () => {
    const errors: string[] = []
    const lsp = start({ logger: { error: (m) => errors.push(m) } })
    const seen: string[] = []
    const bad = lsp.onDidChangeStatus(() => {
      throw new Error('status bug')
    })
    const good = lsp.onDidChangeStatus((status) => seen.push(status.connection))
    await lsp.ready
    await waitFor(() => seen.includes('connected'))
    expect(errors.some((e) => /status listener failed: status bug/.test(e))).toBe(true)
    bad.dispose()
    good.dispose()
    const count = seen.length
    bridge.dropConnections()
    await waitFor(() => lsp.status().connection !== 'connected')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toHaveLength(count)
  })

  it('does not notify listeners after dispose', async () => {
    const lsp = start()
    const seen: string[] = []
    lsp.onDidChangeStatus((status) => seen.push(status.connection))
    await lsp.ready
    await waitFor(() => seen.includes('connected'))
    lsp.dispose()
    lsp.dispose() // idempotent
    const count = seen.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toHaveLength(count)
    expect(lsp.status().connection).toBe('disposed')
    await expect(lsp.request('bridge/status')).rejects.toMatchObject({ code: -32900 })
  })

  it('resolves ready once, on the first handshake, even across reconnects', async () => {
    const lsp = start()
    const first = await lsp.ready
    bridge.dropConnections()
    await waitFor(() => bridge.messages('bridge/hello').length === 2)
    expect(await lsp.ready).toBe(first)
  })

  it('keeps a model attached while retained, regardless of visibility', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    const hold = lsp.attachModel(model as never)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    hold.dispose()
    await waitFor(() => lsp.status().documents.length === 0)
    // document/close is a notification: it reaches the bridge a moment after the local detach
    await waitFor(() => bridge.messages('document/close').length === 1)
  })

  it('attaches every eligible model in "all" mode, honouring shouldAttachModel', async () => {
    tsModel('/repo/src/a.ts')
    const lsp = start({
      attach: 'all',
      shouldAttachModel: (model) => !model.uri.path.endsWith('skip.ts')
    })
    await lsp.ready
    tsModel('/repo/src/b.ts')
    tsModel('/repo/src/skip.ts')
    await waitFor(() => lsp.status().documents.length === 2)
    expect(lsp.status().documents.map((d) => d.uri.slice(-5))).toEqual(['/a.ts', '/b.ts'])
  })

  it('treats a throwing shouldAttachModel as "do not attach"', async () => {
    const lsp = start({
      attach: 'all',
      shouldAttachModel: () => {
        throw new Error('predicate bug')
      }
    })
    await lsp.ready
    tsModel('/repo/src/a.ts')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lsp.status().documents).toEqual([])
  })

  it('replaces the entry when a new model takes over the uri of an attached one', async () => {
    const lsp = start()
    await lsp.ready
    const first = tsModel('/repo/src/a.ts')
    monaco.createEditor(first)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    // the host recreates the model for the same file without disposing the old one first
    const second = monaco.createModel('new', 'typescript', URI.file('/repo/src/a.ts'))
    monaco.createEditor(second)
    await waitFor(() => bridge.messages('document/open').length === 2)
    expect(lsp.status().documents).toHaveLength(1)
  })

  it('ignores session/closed notifications that carry no session id', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts')
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    bridge.notify('session/closed', null)
    bridge.notify('session/closed', { reason: 'x' })
    bridge.notify('document/diagnostics', null)
    bridge.notify('unknown/notification', {})
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lsp.status().documents[0]?.state).toBe('open')
    bridge.notify('session/closed', { sessionId: 's-typescript-1', reason: 'server exited' })
    await waitFor(() => lsp.status().documents[0]?.state !== 'open')
  })
})

describe('opening locations', () => {
  const target = {
    uri: 'file:///repo/src/b.ts',
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }
  }
  async function open(lsp: MonacoLspClient) {
    await lsp.ready
    const editor = monaco.createEditor(tsModel('/repo/src/a.ts'))
    return await monaco.editorOpeners[0]!.openCodeEditor(
      editor,
      URI.file('/repo/src/b.ts'),
      target.range
    )
  }

  it('reports false when the host adapter throws or declines', async () => {
    let lsp = start({
      host: {
        openLocation: () => {
          throw new Error('adapter bug')
        }
      }
    })
    expect(await open(lsp)).toBe(false)
    expect(warnings.some((w) => /openLocation failed: adapter bug/.test(w))).toBe(true)
    lsp.dispose()
    monaco = new FakeMonaco()
    lsp = start({ host: { openLocation: () => 'yes' as never } })
    expect(await open(lsp)).toBe(false)
  })

  it('reports false without host navigation, and when the bridge declines or fails', async () => {
    let lsp = start()
    expect(await open(lsp)).toBe(false)
    expect(bridge.messages('host/openLocation')).toHaveLength(0)
    lsp.dispose()

    monaco = new FakeMonaco()
    bridge.hello = { ...bridge.hello, hostNavigation: true }
    bridge.handlers.set('host/openLocation', () => ({ opened: false }))
    lsp = start()
    expect(await open(lsp)).toBe(false)
    lsp.dispose()

    monaco = new FakeMonaco()
    bridge.handlers.set('host/openLocation', () => {
      throw new RpcFailure(JsonRpcErrorCodes.HostUnavailable, 'Orca unreachable')
    })
    lsp = start()
    expect(await open(lsp)).toBe(false)
    expect(warnings.some((w) => /host\/openLocation failed: Orca unreachable/.test(w))).toBe(true)
  })

  it('refuses links with an unsafe scheme and says so', async () => {
    const lsp = start({ host: { openLocation: () => true } })
    await lsp.ready
    const handled = await monaco.linkOpeners[0]!.open(URI.parse('command:workbench.action.reload'))
    expect(handled).toBe(true) // swallowed, so Monaco does not run it
    expect(warnings.some((w) => /unsafe scheme/.test(w))).toBe(true)
  })
})

describe('readFile', () => {
  it('shows nothing for a peek target the bridge answers with junk', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/a.ts', 'x')
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    bridge.handlers.set('fs/readFile', () => ({ uri: 'x', text: 42 }))
    bridge.handlers.set('lsp/request', () => ({
      uri: 'file:///repo/src/missing.ts',
      range: lspRange(0, 0, 1)
    }))
    expect(
      await monaco.provider('definition', 'typescript').provideDefinition!(model, at, token)
    ).toEqual([])
  })
})

describe('consoleWarnLogger', () => {
  it('forwards warnings and errors to the console and drops the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnLogger.warn?.('w')
    consoleWarnLogger.error?.('e')
    expect(warn).toHaveBeenCalledWith('w')
    expect(error).toHaveBeenCalledWith('e')
    expect(consoleWarnLogger.debug).toBeUndefined()
    expect(consoleWarnLogger.info).toBeUndefined()
    warn.mockRestore()
    error.mockRestore()
  })
})

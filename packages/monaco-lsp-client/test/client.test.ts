import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { JsonRpcErrorCodes, PROTOCOL_VERSION } from '@mlp/protocol'
import {
  createMonacoLspClient,
  type MonacoLspClient,
  type MonacoLspClientOptions
} from '../src/client'
import { PEEK_SCHEME } from '../src/location-models'
import type { OpenLocationTarget } from '../src/openers'
import { FakeMonaco, waitFor } from './fake-monaco'
import { MockBridge, RpcFailure } from './mock-bridge'

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} })
}
/** Minimal CancellationTokenSource that counts live listeners. */
class TokenSource {
  private readonly handlers = new Set<() => void>()
  private cancelled = false
  readonly token: {
    readonly isCancellationRequested: boolean
    onCancellationRequested(listener: () => void): { dispose(): void }
  }
  constructor() {
    const handlers = this.handlers
    const isCancelled = () => this.cancelled
    this.token = {
      get isCancellationRequested() {
        return isCancelled()
      },
      onCancellationRequested(listener) {
        handlers.add(listener)
        return { dispose: () => handlers.delete(listener) }
      }
    }
  }
  get listeners(): number {
    return this.handlers.size
  }
  cancel(): void {
    this.cancelled = true
    for (const handler of [...this.handlers]) handler()
  }
}
const lspRange = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end }
})

let bridge: MockBridge
let monaco: FakeMonaco
let client: MonacoLspClient | null = null

function start(options: Partial<MonacoLspClientOptions> = {}): MonacoLspClient {
  client = createMonacoLspClient(monaco.asMonaco(), {
    url: bridge.url,
    changeDebounceMs: 40,
    detachDelayMs: 60,
    reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    logger: {},
    ...options
  })
  return client
}

function tsModel(path: string, text = 'export const x = 1\n') {
  return monaco.createModel(text, 'typescript', URI.file(path))
}

beforeEach(async () => {
  bridge = await MockBridge.start()
  monaco = new FakeMonaco()
})

afterEach(async () => {
  client?.dispose()
  client = null
  await bridge.close()
})

describe('connection', () => {
  it('handshakes with bridge/hello and reports status', async () => {
    const lsp = start()
    const hello = await lsp.ready
    expect(hello.bridgeVersion).toBe('mock')
    expect(bridge.messages('bridge/hello')[0]?.params).toMatchObject({
      protocolVersion: PROTOCOL_VERSION
    })
    expect(lsp.status()).toMatchObject({ connection: 'connected', hello })
  })

  it('reconnects with backoff, re-hellos and re-opens attached documents', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/app.ts')
    monaco.createEditor(model)
    await waitFor(() => bridge.messages('document/open').length === 1)

    bridge.dropConnections()
    await waitFor(() => bridge.messages('document/open').filter((m) => m.connection === 2).length)
    expect(bridge.messages('bridge/hello').map((m) => m.connection)).toEqual([1, 2])
    expect(bridge.messages('document/open')[1]?.params).toMatchObject({
      uri: model.uri.toString(),
      text: model.getValue()
    })
    await waitFor(() => lsp.status().documents[0]?.sessionId === 's-typescript-2')
  })

  it('resolves a function url before every (re)connect', async () => {
    const second = await MockBridge.start()
    const urls = [bridge.url, second.url]
    let calls = 0
    const lsp = start({ url: async () => urls[Math.min(calls++, 1)]! })
    await lsp.ready
    expect(calls).toBe(1)
    bridge.dropConnections()
    await waitFor(() => second.messages('bridge/hello').length === 1)
    expect(calls).toBe(2)
    await waitFor(() => lsp.status().connection === 'connected')
    lsp.dispose()
    await second.close()
  })

  it('exposes raw bridge requests over the live connection', async () => {
    bridge.handlers.set('host/openLocation', (params) => ({ opened: true, echo: params }))
    const lsp = start()
    await lsp.ready
    expect(await lsp.request('host/openLocation', { uri: 'file:///a.ts' })).toEqual({
      opened: true,
      echo: { uri: 'file:///a.ts' }
    })
    await expect(lsp.request('nope/missing')).rejects.toMatchObject({ code: -32601 })
    bridge.dropConnections()
    await waitFor(() => lsp.status().connection !== 'connected')
    await expect(lsp.request('bridge/status')).rejects.toMatchObject({ code: -32900 })
  })

  it('keeps retrying while the bridge is unreachable', async () => {
    const url = bridge.url
    await bridge.close()
    const states: string[] = []
    const lsp = start({ url })
    lsp.onDidChangeStatus((status) => states.push(status.connection))
    await waitFor(() => states.filter((state) => state === 'connecting').length >= 2)
    expect(lsp.status().connection).not.toBe('connected')
    lsp.dispose()
    await expect(lsp.ready).rejects.toThrow(/disposed/)
    bridge = await MockBridge.start()
  })
})

describe('document sync', () => {
  it('attaches only models shown in an editor, never peek or unsupported models', async () => {
    const lsp = start()
    await lsp.ready
    const hidden = tsModel('/repo/src/hidden.ts')
    const peek = monaco.createModel(
      'x',
      'typescript',
      URI.from({ scheme: PEEK_SCHEME, path: '/repo/p.ts' })
    )
    const plain = monaco.createModel('x', 'plaintext', URI.file('/repo/notes.txt'))
    const visible = tsModel('/repo/src/app.ts')
    monaco.createEditor(peek)
    monaco.createEditor(plain)
    monaco.createEditor(visible)
    await waitFor(() => bridge.messages('document/open').length === 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bridge.messages('document/open').map((m) => (m.params as { uri: string }).uri)).toEqual([
      visible.uri.toString()
    ])
    expect(hidden.isDisposed()).toBe(false)
  })

  it('debounces changes into one full-text change and flushes it before a request', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/app.ts', 'a')
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')

    model.setValue('ab')
    model.setValue('abc')
    model.setValue('abcd')
    const hover = monaco.provider('hover', 'typescript')
    await hover.provideHover!(model, { lineNumber: 1, column: 2 }, token)

    const methods = bridge.received
      .filter((m) => m.method === 'document/change' || m.method === 'lsp/request')
      .map((m) => m.method)
    expect(methods).toEqual(['document/change', 'lsp/request'])
    expect(bridge.messages('document/change')[0]?.params).toEqual({
      sessionId: 's-typescript-1',
      uri: model.uri.toString(),
      text: 'abcd'
    })
    expect(bridge.messages('lsp/request')[0]?.params).toMatchObject({
      sessionId: 's-typescript-1',
      method: 'textDocument/hover',
      params: { textDocument: { uri: model.uri.toString() }, position: { line: 0, character: 1 } }
    })
    // The debounce timer was consumed by the flush: no second change.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(bridge.messages('document/change')).toHaveLength(1)

    model.setValue('abcde')
    await waitFor(() => bridge.messages('document/change').length === 2)
  })

  it('sends edits made during the open round-trip right after it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const defaultOpen = bridge.handlers.get('document/open')!
    bridge.handlers.set('document/open', async (params, connection) => {
      await gate
      return defaultOpen(params, connection)
    })
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/app.ts', 'v1')
    monaco.createEditor(model)
    await waitFor(() => bridge.messages('document/open').length === 1)
    model.setValue('v2')
    release()
    await waitFor(() => bridge.messages('document/change').length === 1)
    expect((bridge.messages('document/change')[0]?.params as { text: string }).text).toBe('v2')
  })

  it('closes a document once no editor has shown it for the grace period', async () => {
    const lsp = start()
    await lsp.ready
    const first = tsModel('/repo/src/app.ts')
    const second = tsModel('/repo/src/greeter.ts')
    const editor = monaco.createEditor(first)
    await waitFor(() => lsp.status().documents.length === 1)
    editor.setModel(second)
    editor.setModel(first)
    editor.setModel(second)
    await waitFor(() => bridge.messages('document/close').length === 1, 1000)
    expect(bridge.messages('document/close')[0]?.params).toEqual({
      sessionId: 's-typescript-1',
      uri: first.uri.toString()
    })
    expect(lsp.status().documents.map((d) => d.uri)).toEqual([second.uri.toString()])
  })

  it('closes immediately when the model is disposed and re-opens on language change', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/app.ts')
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    model.setLanguage('javascript')
    await waitFor(() => bridge.messages('document/open').length === 2)
    expect(bridge.messages('document/close')).toHaveLength(1)
    expect(bridge.messages('document/open')[1]?.params).toMatchObject({ languageId: 'javascript' })
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    model.dispose()
    await waitFor(() => bridge.messages('document/close').length === 2)
    expect(lsp.status().documents).toEqual([])
  })

  it('re-opens lazily after session/closed', async () => {
    const lsp = start()
    await lsp.ready
    const model = tsModel('/repo/src/app.ts')
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')

    bridge.notify('session/closed', { sessionId: 's-typescript-1', reason: 'server exited' })
    await waitFor(() => lsp.status().documents[0]?.state === 'pending')
    expect(bridge.messages('document/open')).toHaveLength(1)

    bridge.handlers.set('document/open', (params) => ({
      sessionId: 'reborn',
      uri: (params as { uri: string }).uri,
      serverId: 'ts',
      rootPath: '/repo',
      pullDiagnostics: false
    }))
    await monaco.provider('hover', 'typescript').provideHover!(
      model,
      { lineNumber: 1, column: 1 },
      token
    )
    expect(bridge.messages('document/open')).toHaveLength(2)
    expect((bridge.messages('lsp/request')[0]?.params as { sessionId: string }).sessionId).toBe(
      'reborn'
    )
  })
})

describe('providers', () => {
  async function openApp(lsp: MonacoLspClient) {
    await lsp.ready
    const model = tsModel('/repo/src/app.ts', "import { greet } from './greeter'\ngreet('x')\n")
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'open')
    return model
  }

  it('maps cross-file definitions to peek models and same-file ones to the live model', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    bridge.handlers.set('lsp/request', () => [
      {
        targetUri: 'file:///repo/src/greeter.ts',
        targetRange: lspRange(4, 0, 30),
        targetSelectionRange: lspRange(4, 16, 21)
      },
      { uri: 'file:///repo/src/app.ts', range: lspRange(0, 9, 14) }
    ])
    const result = (await monaco.provider('definition', 'typescript').provideDefinition!(
      model,
      { lineNumber: 2, column: 2 },
      token
    )) as {
      uri: URI
      range: unknown
    }[]
    expect(result.map((location) => location.uri.toString())).toEqual([
      URI.from({ scheme: PEEK_SCHEME, path: '/repo/src/greeter.ts' }).toString(),
      model.uri.toString()
    ])
    expect(result[0]?.range).toEqual({
      startLineNumber: 5,
      startColumn: 17,
      endLineNumber: 5,
      endColumn: 22
    })
    expect(bridge.messages('fs/readFile')[0]?.params).toEqual({
      uri: 'file:///repo/src/greeter.ts'
    })
    const peek = monaco.models.get(result[0]!.uri.toString())
    expect(peek?.getValue()).toContain('contents of file:///repo/src/greeter.ts')
    // Peek models are never sent to the bridge.
    expect(bridge.messages('document/open')).toHaveLength(1)
  })

  it('reuses an existing file model for cross-file locations', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    const greeter = tsModel('/repo/src/greeter.ts')
    bridge.handlers.set('lsp/request', () => ({
      uri: 'file:///repo/src/greeter.ts',
      range: lspRange(4, 16, 21)
    }))
    const result = (await monaco.provider('references', 'typescript').provideReferences!(
      model,
      { lineNumber: 2, column: 2 },
      { includeDeclaration: false },
      token
    )) as {
      uri: URI
    }[]
    expect(result[0]?.uri.toString()).toBe(greeter.uri.toString())
    expect(bridge.messages('fs/readFile')).toHaveLength(0)
    expect(bridge.messages('lsp/request')[0]?.params).toMatchObject({
      method: 'textDocument/references',
      params: { context: { includeDeclaration: false } }
    })
  })

  it('returns null when a request fails, and retries once after SessionNotFound', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    bridge.handlers.set('lsp/request', () => {
      throw new RpcFailure(JsonRpcErrorCodes.RequestTimeout, 'too slow')
    })
    const definition = monaco.provider('definition', 'typescript')
    expect(
      await definition.provideDefinition!(model, { lineNumber: 1, column: 1 }, token)
    ).toBeNull()

    let calls = 0
    bridge.handlers.set('lsp/request', () => {
      calls++
      if (calls === 1) {
        throw new RpcFailure(JsonRpcErrorCodes.SessionNotFound, 'gone')
      }
      return { contents: { kind: 'markdown', value: 'Builds a friendly greeting.' } }
    })
    const hover = (await monaco.provider('hover', 'typescript').provideHover!(
      model,
      { lineNumber: 1, column: 1 },
      token
    )) as { contents: { value: string }[] }
    expect(hover.contents[0]?.value).toBe('Builds a friendly greeting.')
    expect(bridge.messages('document/open')).toHaveLength(2)
  })

  it('sends lsp/cancel for the in-flight request id when Monaco cancels, and answers null', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    let release!: () => void
    bridge.handlers.set(
      'lsp/request',
      () => new Promise<null>((resolve) => (release = () => resolve(null)))
    )
    const source = new TokenSource()
    const pending = monaco.provider('definition', 'typescript').provideDefinition!(
      model,
      { lineNumber: 1, column: 1 },
      source.token
    )
    await waitFor(() => bridge.messages('lsp/request').length === 1)
    source.cancel()
    expect(await pending).toBeNull()
    await waitFor(() => bridge.messages('lsp/cancel').length === 1)
    const requestId = bridge.messages('lsp/request')[0]!.id
    expect(requestId).toBeDefined()
    expect(bridge.messages('lsp/cancel')[0]).toMatchObject({ params: { id: requestId } })
    expect(bridge.messages('lsp/cancel')[0]!.id).toBeUndefined() // a notification
    // the cancellation listener was released once the request settled
    expect(source.listeners).toBe(0)
    // a late answer for the cancelled id is ignored
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // an already-cancelled token sends nothing at all
    const before = bridge.messages('lsp/request').length
    const done = new TokenSource()
    done.cancel()
    expect(
      await monaco.provider('hover', 'typescript').provideHover!(
        model,
        { lineNumber: 1, column: 1 },
        done.token
      )
    ).toBeNull()
    expect(bridge.messages('lsp/request')).toHaveLength(before)
    expect(bridge.messages('lsp/cancel')).toHaveLength(1)
  })

  it('releases cancellation listeners of requests that complete normally', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    bridge.handlers.set('lsp/request', () => ({ contents: 'doc' }))
    const source = new TokenSource()
    await monaco.provider('hover', 'typescript').provideHover!(
      model,
      { lineNumber: 1, column: 1 },
      source.token
    )
    expect(source.listeners).toBe(0)
    source.cancel()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bridge.messages('lsp/cancel')).toHaveLength(0)
  })

  it('answers null quickly for models without a session', async () => {
    const lsp = start({ languages: ['typescript', 'python'] })
    await lsp.ready
    bridge.handlers.set('document/open', () => ({ sessionId: null, reason: 'pyright missing' }))
    const model = monaco.createModel('x = 1', 'python', URI.file('/repo/a.py'))
    monaco.createEditor(model)
    await waitFor(() => lsp.status().documents[0]?.state === 'no-session')
    expect(lsp.status().documents[0]?.reason).toBe('pyright missing')
    const startedAt = Date.now()
    expect(
      await monaco.provider('definition', 'python').provideDefinition!(
        model,
        { lineNumber: 1, column: 1 },
        token
      )
    ).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(50)
    expect(bridge.messages('lsp/request')).toHaveLength(0)
  })

  it('resolves document links lazily through documentLink/resolve', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    bridge.handlers.set('lsp/request', (params) => {
      const { method, params: inner } = params as {
        method: string
        params: Record<string, unknown>
      }
      if (method === 'textDocument/documentLink') {
        return [{ range: lspRange(0, 22, 33), data: { id: 7 } }]
      }
      if (method === 'documentLink/resolve') {
        return { ...inner, target: 'file:///repo/src/greeter.ts' }
      }
      return null
    })
    const provider = monaco.provider('links', 'typescript')
    const { links } = (await provider.provideLinks!(model, token)) as { links: { url?: string }[] }
    expect(links[0]?.url).toBeUndefined()
    const resolved = (await provider.resolveLink!(links[0], token)) as { url?: string }
    expect(resolved.url).toBe('file:///repo/src/greeter.ts')
    expect(bridge.messages('lsp/request').at(-1)?.params).toMatchObject({
      method: 'documentLink/resolve',
      params: { data: { id: 7 } }
    })
  })

  it('never hands Monaco a command: (or other unsafe) link target', async () => {
    const lsp = start()
    const model = await openApp(lsp)
    bridge.handlers.set('lsp/request', (params) => {
      const { method, params: inner } = params as {
        method: string
        params: Record<string, unknown>
      }
      if (method === 'textDocument/documentLink') {
        return [
          { range: lspRange(0, 0, 3), target: 'command:workbench.action.terminal.sendSequence' },
          { range: lspRange(0, 4, 6), target: 'https://example.com' },
          { range: lspRange(0, 7, 9), data: { id: 1 } }
        ]
      }
      if (method === 'documentLink/resolve') {
        return { ...inner, target: 'command:editor.action.x' }
      }
      return null
    })
    const provider = monaco.provider('links', 'typescript')
    const { links } = (await provider.provideLinks!(model, token)) as {
      links: { url?: string; range: unknown }[]
    }
    expect(links.map((link) => link.url)).toEqual(['https://example.com', undefined])
    expect(await provider.resolveLink!(links[1], token)).toBeNull()
    expect(
      await provider.resolveLink!({ range: links[0]!.range, url: 'javascript:alert(1)' }, token)
    ).toBeNull()
  })

  it('sets markers from pushed diagnostics only when enabled', async () => {
    const lsp = start({ features: { diagnostics: true } })
    const model = await openApp(lsp)
    bridge.notify('document/diagnostics', {
      sessionId: 's-typescript-1',
      uri: model.uri.toString(),
      diagnostics: [{ range: lspRange(1, 0, 5), message: 'boom', severity: 1 }]
    })
    const markers = await waitFor(() => monaco.markers.get(`mlp ${model.uri.toString()}`))
    expect(markers).toEqual([
      {
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 6,
        severity: 8,
        message: 'boom'
      }
    ])
  })
})

describe('built-in TypeScript navigation', () => {
  it('is switched off while the client lives and restored on dispose', async () => {
    const lsp = start()
    expect(monaco.modeConfiguration).toMatchObject({
      definitions: false,
      references: false,
      hovers: false,
      documentSymbols: false,
      completionItems: true
    })
    lsp.dispose()
    expect(monaco.modeConfiguration).toMatchObject({ definitions: true, hovers: true })
  })

  it('is switched off on first language use when the TS contribution loads late', () => {
    const contribution = monaco.typescript
    monaco.typescript = undefined
    start()
    expect(monaco.modeConfiguration.definitions).toBe(true)
    monaco.typescript = contribution
    monaco.activateLanguage('typescript')
    expect(monaco.modeConfiguration).toMatchObject({ definitions: false, hovers: false })
    monaco.activateLanguage('javascript')
    client?.dispose()
    expect(monaco.modeConfiguration).toMatchObject({ definitions: true, hovers: true })
  })

  it('can be left alone', () => {
    start({ disableBuiltinTypeScriptNavigation: false })
    expect(monaco.modeConfiguration.definitions).toBe(true)
  })
})

describe('navigation', () => {
  it('sends Monaco open requests to the host adapter', async () => {
    const opened: OpenLocationTarget[] = []
    const lsp = start({
      host: {
        openLocation: (target) => {
          opened.push(target)
          return true
        }
      }
    })
    const model = tsModel('/repo/src/app.ts')
    const editor = monaco.createEditor(model)
    await lsp.ready
    const peek = URI.from({ scheme: PEEK_SCHEME, path: '/repo/src/greeter.ts' })
    const range = { startLineNumber: 5, startColumn: 17, endLineNumber: 5, endColumn: 22 }
    expect(await monaco.editorOpeners[0]!.openCodeEditor(editor, peek, range)).toBe(true)
    expect(opened).toEqual([{ uri: 'file:///repo/src/greeter.ts', range }])
  })

  it('falls back to the bridge host/openLocation when it has host navigation', async () => {
    bridge.hello = { ...bridge.hello, hostNavigation: true }
    bridge.handlers.set('host/openLocation', () => ({ opened: true }))
    const lsp = start()
    await lsp.ready
    const editor = monaco.createEditor(tsModel('/repo/src/app.ts'))
    const range = { startLineNumber: 5, startColumn: 17, endLineNumber: 5, endColumn: 22 }
    expect(
      await monaco.editorOpeners[0]!.openCodeEditor(editor, URI.file('/repo/src/greeter.ts'), range)
    ).toBe(true)
    expect(bridge.messages('host/openLocation')[0]?.params).toEqual({
      uri: 'file:///repo/src/greeter.ts',
      range: lspRange(4, 16, 21)
    })
  })
})

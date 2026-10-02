// @vitest-environment happy-dom
import { PROTOCOL_VERSION } from '@mlp/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boot, type BootDeps, type DebugHandle } from '../src/boot'
import type { ClientFactoryOptions, LspClientLike } from '../src/client-adapter'
import { FakeEditorApi } from './fakes'

type G = Record<string, any>

function fakeClient(): LspClientLike & { connection: string; disposed: boolean } {
  const c = {
    connection: 'connected',
    disposed: false,
    ready: new Promise<never>(() => {}),
    status: () => ({ connection: c.connection, hello: null, lastError: null }),
    onDidChangeStatus: () => ({ dispose() {} }),
    request: vi.fn(async () => ({ opened: true })) as LspClientLike['request'],
    dispose: () => {
      c.disposed = true
    }
  }
  return c
}

function setup(g: G = {}, storage: Record<string, string> = {}) {
  const clients: ReturnType<typeof fakeClient>[] = []
  const options: ClientFactoryOptions[] = []
  const deps: BootDeps = {
    global: g,
    document,
    localStorage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => {
        storage[k] = v
      }
    },
    sessionStorage: null,
    createClient: (_monaco, o) => {
      options.push(o)
      const c = fakeClient()
      clients.push(c)
      return c
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    requestAnimationFrame: null,
    console: { log() {}, warn() {} }
  }
  const handle: DebugHandle = boot(deps)
  return { g, handle, clients, options }
}

const fakeMonaco = () => ({ editor: new FakeEditorApi(), languages: {} })
const bridge = (port = 4000, token = 'tok') => ({
  port,
  token,
  protocolVersion: PROTOCOL_VERSION,
  pluginVersion: '0.1.0',
  hostNavigation: true
})

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
})

describe('injector boot', () => {
  it('exposes only __mlp and captures Monaco through the traps', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, handle, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    expect(g.__mlp).toBe(handle)
    expect(Object.keys(g).sort()).toEqual(['MonacoEnvironment', 'api', 'monaco'])
    expect(handle.status().monacoCaptured).toBe(false)
    expect(invokeCommand).not.toHaveBeenCalled()

    g.MonacoEnvironment = { getWorker: () => 'w' }
    expect(g.MonacoEnvironment.globalAPI).toBe(true)
    const monaco = fakeMonaco()
    g.monaco = monaco

    // client is created synchronously at capture (before Orca creates TS models)
    expect(clients).toHaveLength(1)
    expect(handle.monaco).toBe(monaco)
    expect(handle.status().monacoCaptured).toBe(true)
    expect(invokeCommand).toHaveBeenCalledWith({
      pluginKey: 'cpoepke.monaco-lsp',
      commandId: 'mlp.ensureBridge',
      args: { v: 1 }
    })
    await expect(options[0]!.url()).resolves.toBe('ws://127.0.0.1:4000/?token=tok')
    expect(handle.status().bridge).toMatchObject({ state: 'available', port: 4000 })
    expect(JSON.stringify(handle.status())).not.toContain('tok"')
  })

  it('shows one setup notice when the plugin API is missing, and keeps retrying', async () => {
    const { g, handle } = setup({})
    g.monaco = fakeMonaco()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.status().bridge.error?.kind).toBe('api-missing')
    expect(document.querySelectorAll('[data-mlp-notice]')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(document.querySelectorAll('[data-mlp-notice]')).toHaveLength(1)

    // Plugin system gets enabled later: the retry picks it up.
    g.api = { plugins: { invokeCommand: vi.fn(async () => bridge()) } }
    await vi.advanceTimersByTimeAsync(120_000)
    expect(handle.status().bridge.state).toBe('available')
  })

  it('recreates a connected client when the heartbeat sees a new endpoint', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    await options[0]!.url()
    invokeCommand.mockImplementation(async () => bridge(5000, 'other'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(clients).toHaveLength(2)
    expect(clients[0]!.disposed).toBe(true)
    await expect(options[1]!.url()).resolves.toBe('ws://127.0.0.1:5000/?token=other')
  })

  it('keeps the plugin worker alive while Orca is hidden and the client is connected', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    await options[0]!.url()
    const calls = invokeCommand.mock.calls.length
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(240_000)
      expect(invokeCommand).toHaveBeenCalledTimes(calls + 2)
      clients[0]!.connection = 'disconnected'
      await vi.advanceTimersByTimeAsync(240_000)
      expect(invokeCommand).toHaveBeenCalledTimes(calls + 2)
    } finally {
      visibility.mockRestore()
    }
  })

  it('cross-file navigation goes through host/openLocation', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    const ok = await options[0]!.host.openLocation(
      {
        uri: 'file:///repo/b.ts',
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }
      },
      { editor: null, modelUri: 'file:///repo/a.ts', reason: 'definition' }
    )
    expect(ok).toBe(true)
    expect(clients[0]!.request).toHaveBeenCalledWith('host/openLocation', {
      uri: 'file:///repo/b.ts',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }
    })
  })

  it('does nothing but expose __mlp when disabled via localStorage', () => {
    const { g, handle } = setup({}, { 'mlp.disabled': '1' })
    expect(handle.status().disabled).toBe(true)
    expect(Object.keys(g)).toEqual([])
    g.monaco = fakeMonaco()
    expect(handle.status().monacoCaptured).toBe(false)
  })
})

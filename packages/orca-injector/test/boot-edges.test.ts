// @vitest-environment happy-dom
/** Boot wiring under failure: broken globals, failing client creation, rAF vs. timer frames, notices. */
import { PROTOCOL_VERSION } from '@mlp/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boot, type BootDeps } from '../src/boot'
import type { ClientFactoryOptions, LspClientLike } from '../src/client-adapter'
import { FakeEditor, FakeEditorApi, FakeModel, flush, range } from './fakes'

type G = Record<string, any>

type TestClient = LspClientLike & {
  connection: string
  disposed: boolean
  statusError: boolean
  documents: unknown
  hello: (() => void) | null
}

function fakeClient(): TestClient {
  let resolveReady!: (hello: never) => void
  const c: TestClient = {
    connection: 'connected',
    disposed: false,
    statusError: false,
    documents: [{ uri: 'file:///repo/a.ts', state: 'open' }],
    hello: null,
    ready: new Promise<never>((resolve) => (resolveReady = resolve)),
    status: () => {
      if (c.statusError) throw new Error('status broke')
      return {
        connection: c.connection,
        hello: null,
        lastError: 'last',
        documents: c.documents as never
      }
    },
    onDidChangeStatus: () => ({ dispose() {} }),
    request: vi.fn(async () => ({ opened: true })) as LspClientLike['request'],
    dispose: () => {
      c.disposed = true
    }
  }
  c.hello = () =>
    resolveReady({ bridgeVersion: '0.1.0', availableLanguages: ['typescript', 'go'] } as never)
  return c
}

const bridge = (port = 4000, token = 'tok') => ({
  port,
  token,
  protocolVersion: PROTOCOL_VERSION,
  pluginVersion: '0.1.0',
  hostNavigation: true
})

const fakeMonaco = () => ({ editor: new FakeEditorApi(), languages: {} })

function setup(
  g: G = {},
  overrides: Partial<BootDeps> = {},
  storage: Record<string, string> = {},
  create?: (o: ClientFactoryOptions) => LspClientLike
) {
  const clients: TestClient[] = []
  const options: ClientFactoryOptions[] = []
  const logs: string[] = []
  const deps: BootDeps = {
    global: g,
    document,
    localStorage: { getItem: (k) => storage[k] ?? null, setItem: () => {} },
    sessionStorage: null,
    createClient: (_monaco, o) => {
      options.push(o)
      if (create) return create(o)
      const c = fakeClient()
      clients.push(c)
      return c
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    requestAnimationFrame: null,
    console: { log: (m) => logs.push(`log ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    ...overrides
  }
  const handle = boot(deps)
  return { g, handle, clients, options, logs }
}

const debug = { 'mlp.debug': '1' }

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
})

describe('status()', () => {
  it('survives a client whose status() throws and junk document lists', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, handle, clients } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    clients[0]!.statusError = true
    expect(handle.status().client).toEqual({
      created: true,
      connection: null,
      lastError: null,
      documents: []
    })
    clients[0]!.statusError = false
    clients[0]!.documents = 'not an array'
    expect(handle.status().client.documents).toEqual([])
    clients[0]!.documents = [null, { uri: 5 }, { state: 'open' }, { uri: 'file:///x.ts', state: 7 }]
    expect(handle.status().client.documents).toEqual([{ uri: 'file:///x.ts', state: '7' }])
  })

  it('reports a pending reveal and the bridge error without leaking the token', async () => {
    const { g, handle } = setup({})
    expect(handle.status()).toMatchObject({
      bridge: { state: 'idle', port: null, pluginVersion: null, hostNavigation: null, error: null },
      client: { created: false, connection: null, lastError: null, documents: [] },
      pendingReveal: null
    })
    g.monaco = fakeMonaco()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.status().bridge.error).toMatchObject({ kind: 'api-missing' })
  })
})

describe('client creation', () => {
  it('logs the bridge handshake in debug mode', async () => {
    const { g, clients, logs } = setup({}, {}, debug)
    g.monaco = fakeMonaco()
    clients[0]!.hello!()
    await flush()
    expect(
      logs.some((l) => l.includes('connected to bridge 0.1.0; languages: typescript, go'))
    ).toBe(true)
  })

  it('keeps going when the client cannot be created', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, handle, logs } = setup({ api: { plugins: { invokeCommand } } }, {}, debug, () => {
      throw new Error('monaco too old')
    })
    g.monaco = fakeMonaco()
    expect(logs).toContain('warn [mlp] client creation failed: Error: monaco too old')
    expect(handle.status().monacoCaptured).toBe(true)
    expect(handle.status().client.created).toBe(false)
    // the bridge connector and heartbeat still run
    await vi.advanceTimersByTimeAsync(120_000)
    expect(invokeCommand.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('reports a hook that fails during capture instead of throwing into Monaco', () => {
    const { g, handle, logs } = setup({}, {}, debug)
    expect(() => {
      g.monaco = { editor: {}, languages: {} } // no onDidCreateEditor: the reveal watcher cannot attach
    }).not.toThrow()
    expect(logs.some((l) => l.startsWith('warn [mlp] trap onCapture:'))).toBe(true)
    expect(handle.status().monacoCaptured).toBe(true)
  })

  it('answers host requests made before the client exists with a notice, not a crash', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g } = setup({ api: { plugins: { invokeCommand } } }, {}, {}, (options) => {
      // A host that navigates while the client is still being constructed.
      void options.host.openLocation(
        { uri: 'file:///repo/b.ts', range: range(1) },
        { editor: null, modelUri: null, reason: 'definition' }
      )
      return fakeClient()
    })
    g.monaco = fakeMonaco()
    await vi.advanceTimersByTimeAsync(0)
    const notice = document.querySelector('[data-mlp-notice]')
    expect(notice?.textContent).toContain('Could not open b.ts')
    expect(notice?.textContent).toContain('client not ready')
  })

  it('names the client after the injector version and forwards logger levels', async () => {
    const { g, options, logs } = setup({}, {}, debug)
    g.monaco = fakeMonaco()
    expect(options[0]!.clientName).toMatch(/^orca-injector\/\d+\.\d+\.\d+/)
    options[0]!.logger.debug?.('d')
    options[0]!.logger.info?.('i')
    options[0]!.logger.warn?.('w')
    options[0]!.logger.error?.('e')
    expect(logs).toEqual(
      expect.arrayContaining(['log [mlp] d', 'log [mlp] i', 'warn [mlp] w', 'warn [mlp] e'])
    )
    expect(
      options[0]!.shouldAttachModel({
        uri: { scheme: 'file' },
        getLanguageId: () => 'go',
        getValueLength: () => 1
      })
    ).toBe(true)
  })
})

describe('endpoint changes', () => {
  it('leaves a disconnected client alone: it picks the new endpoint up on its next retry', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    await options[0]!.url()
    clients[0]!.connection = 'disconnected'
    invokeCommand.mockImplementation(async () => bridge(5000, 'other'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(clients).toHaveLength(1)
    expect(clients[0]!.disposed).toBe(false)
    await expect(options[0]!.url()).resolves.toBe('ws://127.0.0.1:5000/?token=other')
  })

  it('treats a client whose status() throws as disconnected', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    await options[0]!.url()
    clients[0]!.statusError = true
    invokeCommand.mockImplementation(async () => bridge(5000, 'other'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(clients).toHaveLength(1)
  })

  it('still recreates the client when disposing the old one throws', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    await options[0]!.url()
    clients[0]!.dispose = () => {
      throw new Error('dispose broke')
    }
    invokeCommand.mockImplementation(async () => bridge(5000, 'other'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(clients).toHaveLength(2)
  })

  it('ignores a heartbeat that finds the same endpoint, or one the client already uses', async () => {
    const invokeCommand = vi.fn(async () => bridge())
    const { g, clients, options } = setup({ api: { plugins: { invokeCommand } } })
    g.monaco = fakeMonaco()
    await options[0]!.url()
    await vi.advanceTimersByTimeAsync(240_000)
    expect(clients).toHaveLength(1)
  })

  it('does not show the setup notice before Monaco was captured', async () => {
    const { handle } = setup({})
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.status().bridge.state).toBe('idle')
    expect(document.querySelector('[data-mlp-notice]')).toBeNull()
  })
})

describe('reveal frames', () => {
  async function openAndReveal(overrides: Partial<BootDeps>) {
    const api = new FakeEditorApi()
    const invokeCommand = vi.fn(async () => bridge())
    const { g, options } = setup({ api: { plugins: { invokeCommand } } }, overrides)
    g.monaco = { editor: api, languages: {} }
    const editor: FakeEditor = api.create()
    editor.setModel(new FakeModel('file:///repo/b.ts', 'a\nb\nc\n'))
    const opened = options[0]!.host.openLocation(
      { uri: 'file:///repo/b.ts', range: range(2) },
      { editor: null, modelUri: 'file:///repo/a.ts', reason: 'definition' }
    )
    return { editor, opened }
  }

  it('waits on animation frames when the window has them', async () => {
    const frames: (() => void)[] = []
    const { editor, opened } = await openAndReveal({
      requestAnimationFrame: (fn) => void frames.push(fn)
    })
    await opened
    await vi.advanceTimersByTimeAsync(0)
    expect(editor.revealed).toBeNull()
    for (let i = 0; i < 4; i++) {
      frames.splice(0).forEach((fn) => fn())
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(editor.revealed).toEqual(range(2))
  })

  it('falls back to a 50 ms timer in windows that never fire animation frames', async () => {
    const { editor, opened } = await openAndReveal({ requestAnimationFrame: () => undefined })
    await opened
    await vi.advanceTimersByTimeAsync(49)
    expect(editor.revealed).toBeNull()
    await vi.advanceTimersByTimeAsync(300)
    expect(editor.revealed).toEqual(range(2))
  })

  it('falls back to the timer when requestAnimationFrame throws', async () => {
    const { editor, opened } = await openAndReveal({
      requestAnimationFrame: () => {
        throw new Error('no frames in this window')
      }
    })
    await opened
    await vi.advanceTimersByTimeAsync(300)
    expect(editor.revealed).toEqual(range(2))
  })
})

describe('hostile environments', () => {
  it('does not throw on a frozen global object', () => {
    const g = Object.freeze({}) as G
    expect(() => setup(g)).not.toThrow()
  })

  it('ignores a document that refuses event listeners', () => {
    const doc = {
      visibilityState: 'visible',
      addEventListener() {
        throw new Error('sandboxed')
      }
    } as unknown as Document
    const { handle } = setup({}, { document: doc })
    expect(handle.version).toBeDefined()
  })

  it('boots without a document or storage', () => {
    const { handle } = setup({}, { document: null, localStorage: null, sessionStorage: null })
    expect(handle.status()).toMatchObject({ disabled: false, monacoCaptured: false })
  })

  it('treats a storage that throws as "no flags"', () => {
    const { handle } = setup(
      {},
      {
        localStorage: {
          getItem: () => {
            throw new Error('SecurityError')
          },
          setItem: () => {}
        }
      }
    )
    expect(handle.status().disabled).toBe(false)
  })
})

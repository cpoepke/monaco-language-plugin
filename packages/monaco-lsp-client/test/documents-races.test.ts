/**
 * DocumentManager races: models detached, disposed or reset while a
 * document/open round-trip is in flight, duplicate opens and broken listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeMethods,
  JsonRpcErrorCodes,
  type DiagnosticsParams,
  type OpenDocumentResult
} from '@mlp/protocol'
import { RpcError, type BridgeConnection } from '../src/connection'
import { DocumentManager, type DocumentManagerOptions, type SyncModel } from '../src/documents'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class TestModel implements SyncModel {
  value = 'one'
  disposed = false
  readonly listeners = new Set<() => void>()
  constructor(
    readonly path = '/repo/a.ts',
    private readonly language = 'typescript'
  ) {}
  readonly uri = { toString: () => `file://${this.path}` }
  getLanguageId(): string {
    return this.language
  }
  getValue(): string {
    return this.value
  }
  isDisposed(): boolean {
    return this.disposed
  }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener)
    return { dispose: () => void this.listeners.delete(listener) }
  }
  edit(value: string): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

const session = (id: string, path = '/repo/a.ts'): OpenDocumentResult => ({
  sessionId: id,
  uri: `file://${path}`,
  serverId: 'ts',
  rootPath: '/repo',
  pullDiagnostics: false
})

type Call = { method: string; params: unknown; options?: unknown; reply: Deferred<unknown> }

function setup(options: Partial<DocumentManagerOptions<TestModel>> = {}) {
  const calls: Call[] = []
  const notifications: { method: string; params: unknown }[] = []
  const state = { connected: true }
  const connection = {
    get isConnected() {
      return state.connected
    },
    request: vi.fn((method: string, params: unknown, requestOptions?: unknown) => {
      const reply = deferred<unknown>()
      calls.push({ method, params, options: requestOptions, reply })
      return reply.promise
    }),
    notify: vi.fn((method: string, params: unknown) => {
      notifications.push({ method, params })
      return true
    })
  } as unknown as BridgeConnection
  const logger = { debug: vi.fn(), error: vi.fn() }
  const documents = new DocumentManager<TestModel>({
    connection,
    logger,
    changeDebounceMs: 10,
    ...options
  })
  const opens = () => calls.filter((call) => call.method === BridgeMethods.openDocument)
  return { documents, calls, opens, notifications, state, logger }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('duplicate opens', () => {
  it('shares one document/open between concurrent callers and attach() of the same model', async () => {
    const t = setup()
    const model = new TestModel()
    const entry = t.documents.attach(model)
    expect(t.documents.attach(model)).toBe(entry)
    const [a, b] = [t.documents.ensureSession(entry), t.documents.ensureSession(entry)]
    expect(t.opens()).toHaveLength(1)
    t.opens()[0]!.reply.resolve(session('s1'))
    expect((await a)?.sessionId).toBe('s1')
    expect(await b).toBe(await a)
    expect(t.documents.size).toBe(1)
    // an open document answers from memory
    expect((await t.documents.ensureSession(entry))?.sessionId).toBe('s1')
    expect(t.opens()).toHaveLength(1)
  })

  it('does not open while the bridge is unreachable, and opens on connect', async () => {
    const t = setup()
    t.state.connected = false
    const entry = t.documents.attach(new TestModel())
    expect(await t.documents.ensureSession(entry)).toBeNull()
    expect(t.opens()).toHaveLength(0)
    t.state.connected = true
    t.documents.handleConnect()
    expect(t.opens()).toHaveLength(1)
  })
})

describe('dispose during open', () => {
  it('closes the server-side document when the model is detached mid-open', async () => {
    const t = setup()
    const model = new TestModel()
    const entry = t.documents.attach(model)
    const pending = t.documents.ensureSession(entry)
    t.documents.detach(entry.key)
    t.opens()[0]!.reply.resolve(session('s1'))
    expect(await pending).toBeNull()
    expect(t.notifications).toEqual([
      { method: BridgeMethods.closeDocument, params: { sessionId: 's1', uri: 'file:///repo/a.ts' } }
    ])
    expect(t.documents.size).toBe(0)
  })

  it('does not send document/close when the connection is gone too', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const pending = t.documents.ensureSession(entry)
    t.documents.detach(entry.key)
    t.state.connected = false
    t.opens()[0]!.reply.resolve(session('s1'))
    expect(await pending).toBeNull()
    expect(t.notifications).toEqual([])
  })

  it('answers null (and sets nothing) when a declined open returns for a detached model', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const pending = t.documents.ensureSession(entry)
    t.documents.detach(entry.key)
    t.opens()[0]!.reply.resolve({ sessionId: null, reason: 'unsupported language' })
    expect(await pending).toBeNull()
    expect(entry.noSessionReason).toBeNull()
  })

  it('swallows an open failure for a detached model', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const pending = t.documents.ensureSession(entry)
    t.documents.detach(entry.key)
    t.opens()[0]!.reply.reject(new Error('socket closed'))
    expect(await pending).toBeNull()
    expect(entry.noSessionReason).toBeNull()
  })

  it('keeps a model disposed during the open from being synced or probed', async () => {
    const t = setup()
    const model = new TestModel()
    const entry = t.documents.attach(model)
    const pending = t.documents.ensureSession(entry)
    model.edit('two')
    model.disposed = true
    t.opens()[0]!.reply.resolve(session('s1'))
    expect((await pending)?.sessionId).toBe('s1')
    expect(t.notifications.filter((n) => n.method === BridgeMethods.changeDocument)).toEqual([])
    expect(await t.documents.ensureSession(entry)).toBeNull()
  })

  it('does not sync a change that was queued for a model disposed before the timer fired', async () => {
    const t = setup()
    const model = new TestModel()
    const entry = t.documents.attach(model)
    const open = t.opens()[0]!
    open.reply.resolve(session('s1'))
    await vi.advanceTimersByTimeAsync(0)
    model.edit('two')
    model.disposed = true
    await vi.advanceTimersByTimeAsync(50)
    expect(t.notifications.filter((n) => n.method === BridgeMethods.changeDocument)).toEqual([])
    t.documents.flush(entry)
    expect(entry.session?.sessionId).toBe('s1')
  })
})

describe('reconnect during open', () => {
  it('re-opens when the connection was reset while an open was in flight', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const stale = t.documents.ensureSession(entry)
    t.documents.handleDisconnect()
    t.documents.handleConnect() // starts the fresh open
    expect(t.opens()).toHaveLength(2)
    t.opens()[0]!.reply.resolve(session('stale-session'))
    t.opens()[1]!.reply.resolve(session('fresh-session'))
    // callers of the stale open are handed the fresh session, and the stale one is never adopted
    expect((await stale)?.sessionId).toBe('fresh-session')
    expect(entry.session?.sessionId).toBe('fresh-session')
    expect(t.notifications).toEqual([])
  })

  it('follows a fresh open when a stale open was declined', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const stale = t.documents.ensureSession(entry)
    t.documents.handleDisconnect()
    t.documents.handleConnect()
    t.opens()[0]!.reply.resolve({ sessionId: null, reason: 'unsupported language' })
    t.opens()[1]!.reply.resolve(session('fresh'))
    expect((await stale)?.sessionId).toBe('fresh')
  })

  it('ignores a stale failure once the generation moved on', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const stale = t.documents.ensureSession(entry)
    t.documents.handleDisconnect()
    t.documents.handleConnect()
    t.opens()[0]!.reply.reject(new RpcError(-32902, 'Connection closed'))
    expect(await stale).toBeNull()
    expect(entry.noSessionReason).toBeNull()
    t.opens()[1]!.reply.resolve(session('fresh'))
    await vi.advanceTimersByTimeAsync(0)
    expect(entry.session?.sessionId).toBe('fresh')
  })

  it('does not back off a failed open when the connection dropped meanwhile', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const pending = t.documents.ensureSession(entry)
    t.state.connected = false
    t.opens()[0]!.reply.reject(new RpcError(-32902, 'Connection closed'))
    expect(await pending).toBeNull()
    expect(entry.noSessionReason).toBeNull()
    expect(entry.opening).toBeNull()
  })

  it('treats InvalidParams like PathNotAllowed: final, no retry timer', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    const pending = t.documents.ensureSession(entry)
    t.opens()[0]!.reply.reject(new RpcError(JsonRpcErrorCodes.InvalidParams, 'bad uri'))
    expect(await pending).toBeNull()
    expect(entry.noSessionReason).toMatch(/bad uri/)
    expect(entry.retryAt).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('session lifecycle', () => {
  it('forgets a session on invalidate and on session/closed, clearing markers', async () => {
    const setMarkers = vi.fn()
    const t = setup({ setMarkers })
    const model = new TestModel()
    const entry = t.documents.attach(model)
    t.opens()[0]!.reply.resolve(session('s1'))
    await vi.advanceTimersByTimeAsync(0)
    t.documents.invalidateSession(entry)
    expect(entry.session).toBeNull()
    t.documents.invalidateSession(entry) // nothing to forget
    t.documents.handleSessionClosed('unknown') // not ours: no-op

    const again = t.documents.ensureSession(entry)
    t.opens()[1]!.reply.resolve(session('s2'))
    await again
    t.documents.handleSessionClosed('s2')
    expect(entry.session).toBeNull()
    expect(setMarkers).toHaveBeenCalledWith(model, [])
    model.disposed = true
    const third = t.documents.ensureSession(entry)
    expect(await third).toBeNull()
  })

  it('does not touch the markers of a disposed model on session/closed or detach', async () => {
    const setMarkers = vi.fn()
    const t = setup({ setMarkers })
    const model = new TestModel()
    t.documents.attach(model)
    t.opens()[0]!.reply.resolve(session('s1'))
    await vi.advanceTimersByTimeAsync(0)
    model.disposed = true
    t.documents.handleSessionClosed('s1')
    t.documents.detachAll()
    expect(setMarkers).not.toHaveBeenCalled()
  })

  it('reports a throwing change listener instead of breaking document tracking', () => {
    const t = setup({
      onDidChange: () => {
        throw new Error('listener bug')
      }
    })
    const entry = t.documents.attach(new TestModel())
    expect(entry.key).toBe('file:///repo/a.ts')
    expect(t.logger.error).toHaveBeenCalledWith(expect.stringContaining('listener bug'))
  })

  it('lists documents with their state', async () => {
    const t = setup()
    t.documents.attach(new TestModel('/repo/a.ts'))
    t.documents.attach(new TestModel('/repo/b.py', 'python'))
    expect(t.documents.info().map((info) => info.state)).toEqual(['opening', 'opening'])
    t.opens()[0]!.reply.resolve(session('s1'))
    t.opens()[1]!.reply.resolve({ sessionId: null, reason: 'no language server for python' })
    await vi.advanceTimersByTimeAsync(0)
    expect(t.documents.info()).toMatchObject([
      { state: 'open', sessionId: 's1', serverId: 'ts', reason: null },
      { state: 'no-session', sessionId: null, reason: 'no language server for python' }
    ])
    expect(t.documents.list()).toHaveLength(2)
    expect(t.documents.get('file:///nope')).toBeNull()
  })

  it('does not start opening on attach while disconnected', () => {
    const t = setup()
    t.state.connected = false
    t.documents.attach(new TestModel())
    expect(t.documents.info()[0]?.state).toBe('pending')
  })

  it('names a missing decline reason', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    t.opens()[0]!.reply.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(entry.noSessionReason).toBe('no language server')
  })

  it('uses the entry key when the bridge omits the canonical uri', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    t.opens()[0]!.reply.resolve({ ...session('s1'), uri: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(entry.session?.uri).toBe('file:///repo/a.ts')
  })
})

describe('pushed diagnostics', () => {
  async function withSession(
    setMarkers: (model: TestModel, diagnostics: unknown[]) => void,
    sessionUri?: string
  ) {
    const t = setup({ setMarkers })
    const model = new TestModel()
    t.documents.attach(model)
    t.opens()[0]!.reply.resolve({ ...session('s1'), uri: sessionUri ?? 'file:///repo/a.ts' })
    await vi.advanceTimersByTimeAsync(0)
    return { t, model }
  }

  it('applies diagnostics for the session and uri, also across URI spellings', async () => {
    const setMarkers = vi.fn()
    const { t, model } = await withSession(setMarkers)
    const diagnostics = [{ message: 'x' }]
    t.documents.handleDiagnostics({ sessionId: 's1', uri: 'file:///repo/a.ts', diagnostics })
    t.documents.handleDiagnostics({ sessionId: 's1', uri: 'file:///repo/%61.ts', diagnostics })
    expect(setMarkers).toHaveBeenCalledTimes(2)
    expect(setMarkers).toHaveBeenLastCalledWith(model, diagnostics)
  })

  it('ignores other sessions, other files, junk and disposed models', async () => {
    const setMarkers = vi.fn()
    const { t, model } = await withSession(setMarkers)
    const base = { sessionId: 's1', uri: 'file:///repo/a.ts', diagnostics: [] }
    t.documents.handleDiagnostics({ ...base, sessionId: 'other' })
    t.documents.handleDiagnostics({ ...base, uri: 'file:///repo/b.ts' })
    t.documents.handleDiagnostics({ ...base, uri: 'http://example.com/a.ts' })
    t.documents.handleDiagnostics({ ...base, diagnostics: 'nope' } as unknown as DiagnosticsParams)
    t.documents.handleDiagnostics(null as unknown as DiagnosticsParams)
    model.disposed = true
    t.documents.handleDiagnostics(base)
    expect(setMarkers).not.toHaveBeenCalled()
  })

  it('does nothing when diagnostics are disabled', async () => {
    const t = setup()
    const entry = t.documents.attach(new TestModel())
    t.opens()[0]!.reply.resolve(session('s1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(() =>
      t.documents.handleDiagnostics({ sessionId: 's1', uri: entry.key, diagnostics: [] })
    ).not.toThrow()
  })
})

describe('pull diagnostics cancellation', () => {
  it('lets the request observe cancellation through its token and releases the listener', async () => {
    const setMarkers = vi.fn()
    const t = setup({ setMarkers })
    const model = new TestModel()
    t.documents.attach(model)
    t.opens()[0]!.reply.resolve({ ...session('s1'), pullDiagnostics: true })
    await vi.advanceTimersByTimeAsync(0)
    const pull = t.calls.find((call) => call.method === BridgeMethods.lspRequest)!
    const token = (
      pull.options as {
        token: {
          onCancellationRequested(l: () => void): { dispose(): void }
          isCancellationRequested: boolean
        }
      }
    ).token
    const fired = vi.fn()
    const registration = token.onCancellationRequested(fired)
    const disposed = token.onCancellationRequested(() => fired())
    disposed.dispose()
    // a newer change supersedes the pull
    model.edit('two')
    await vi.advanceTimersByTimeAsync(10)
    expect(token.isCancellationRequested).toBe(true)
    expect(fired).toHaveBeenCalledTimes(1)
    registration.dispose()
    // the cancelled pull's answer is discarded
    pull.reply.resolve({ kind: 'full', items: [{ message: 'stale' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(setMarkers).not.toHaveBeenCalled()
  })

  it('cancels an in-flight pull when the document is detached', async () => {
    const t = setup({ setMarkers: vi.fn() })
    const entry = t.documents.attach(new TestModel())
    t.opens()[0]!.reply.resolve({ ...session('s1'), pullDiagnostics: true })
    await vi.advanceTimersByTimeAsync(0)
    const pull = t.calls.find((call) => call.method === BridgeMethods.lspRequest)!
    t.documents.detach(entry.key)
    expect(
      (pull.options as { token: { isCancellationRequested: boolean } }).token
        .isCancellationRequested
    ).toBe(true)
    pull.reply.reject(new RpcError(-32903, 'cancelled'))
    await vi.advanceTimersByTimeAsync(0)
  })
})

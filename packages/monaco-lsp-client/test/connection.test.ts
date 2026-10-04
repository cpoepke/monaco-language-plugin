/**
 * BridgeConnection against an in-process fake socket and fake timers: backoff,
 * request timeouts, error mapping, cancellation and disposal while requests fly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeMethods, JsonRpcErrorCodes, PROTOCOL_VERSION } from '@mlp/protocol'
import {
  BridgeConnection,
  ClientErrorCodes,
  RpcError,
  errorMessage,
  type BridgeConnectionOptions,
  type WebSocketLike
} from '../src/connection'

type Sent = { jsonrpc: string; id?: number | string; method?: string; params?: unknown }

class FakeSocket implements WebSocketLike {
  readyState = 0
  sent: Sent[] = []
  closes: { code?: number; reason?: string }[] = []
  sendError: Error | null = null
  closeError: Error | null = null
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  onerror: WebSocketLike['onerror'] = null
  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.sendError) {
      throw this.sendError
    }
    this.sent.push(JSON.parse(data) as Sent)
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    if (this.closeError) {
      throw this.closeError
    }
  }

  // --- test controls ---
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) })
  }
  /** Peer closes the socket. */
  drop(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  find(method: string): Sent[] {
    return this.sent.filter((message) => message.method === method)
  }
  answer(request: Sent, result: unknown): void {
    this.receive({ jsonrpc: '2.0', id: request.id, result })
  }
  fail(request: Sent, code: number, message: string, data?: unknown): void {
    this.receive({ jsonrpc: '2.0', id: request.id, error: { code, message, data } })
  }
}

const HELLO = {
  protocolVersion: PROTOCOL_VERSION,
  bridgeVersion: 'test',
  availableLanguages: ['typescript'],
  hostNavigation: false
}

type Harness = {
  conn: BridgeConnection
  sockets: FakeSocket[]
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  /** Opens the newest socket and completes the hello handshake. */
  connect(): Promise<FakeSocket>
}

function harness(overrides: Partial<BridgeConnectionOptions> = {}): Harness {
  const sockets: FakeSocket[] = []
  const logger = { warn: vi.fn(), error: vi.fn() }
  const conn = new BridgeConnection({
    url: 'ws://127.0.0.1:1/?token=t',
    clientName: 'test',
    createWebSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    logger,
    ...overrides
  })
  return {
    conn,
    sockets,
    logger,
    async connect() {
      const socket = sockets.at(-1)!
      socket.open()
      const hello = socket.find(BridgeMethods.hello).at(-1)!
      socket.answer(hello, HELLO)
      await vi.advanceTimersByTimeAsync(0)
      return socket
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('handshake', () => {
  it('sends bridge/hello with the protocol version and the client name', async () => {
    const h = harness()
    h.conn.start()
    expect(h.conn.state).toBe('connecting')
    const socket = await h.connect()
    expect(socket.url).toBe('ws://127.0.0.1:1/?token=t')
    expect(socket.find(BridgeMethods.hello)[0]?.params).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      client: 'test'
    })
    expect(h.conn.state).toBe('connected')
    expect(h.conn.isConnected).toBe(true)
    expect(h.conn.hello).toEqual(HELLO)
    expect(h.conn.lastError).toBeNull()
  })

  it('notifies connect handlers, and a throwing handler cannot break the others', async () => {
    const h = harness()
    const seen: string[] = []
    h.conn.onConnect(() => {
      throw new Error('handler bug')
    })
    h.conn.onConnect((hello) => seen.push(hello.bridgeVersion))
    h.conn.start()
    await h.connect()
    expect(seen).toEqual(['test'])
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('handler bug'))
    expect(h.conn.state).toBe('connected')
  })

  it('rejects a bridge speaking another protocol version and reconnects', async () => {
    const h = harness({ reconnect: { initialDelayMs: 100 } })
    h.conn.start()
    const socket = h.sockets[0]!
    socket.open()
    socket.answer(socket.find(BridgeMethods.hello)[0]!, { ...HELLO, protocolVersion: 99 })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.conn.state).toBe('disconnected')
    expect(h.conn.lastError).toMatch(/protocol mismatch: bridge speaks v99/)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('protocol mismatch'))
    expect(socket.closes).toEqual([{ code: 1002, reason: 'hello failed' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(h.sockets).toHaveLength(2)
  })

  it('treats a missing hello result as a protocol mismatch', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = h.sockets[0]!
    socket.open()
    socket.answer(socket.find(BridgeMethods.hello)[0]!, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.conn.lastError).toMatch(/bridge speaks vundefined/)
  })

  it('fails the handshake when the bridge answers hello with an error', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = h.sockets[0]!
    socket.open()
    socket.fail(socket.find(BridgeMethods.hello)[0]!, JsonRpcErrorCodes.InvalidParams, 'bad client')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.conn.lastError).toBe('hello failed: bad client')
    expect(h.conn.state).toBe('disconnected')
  })

  it('fails the handshake when the bridge never answers hello', async () => {
    const h = harness({ requestTimeoutMs: 1000, reconnect: false })
    h.conn.start()
    h.sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.conn.lastError).toBe('hello failed: bridge/hello timed out')
    expect(h.sockets[0]!.closes[0]?.code).toBe(1002)
  })

  it('survives a socket that throws while closing after a failed hello', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = h.sockets[0]!
    socket.closeError = new Error('already closed')
    socket.open()
    socket.fail(socket.find(BridgeMethods.hello)[0]!, -32603, 'nope')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.conn.state).toBe('disconnected')
  })

  it('ignores a handshake that finishes after the socket was replaced or disposed', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = h.sockets[0]!
    socket.open()
    const hello = socket.find(BridgeMethods.hello)[0]!
    h.conn.dispose()
    socket.answer(hello, HELLO) // detached handlers: nothing happens
    await vi.advanceTimersByTimeAsync(0)
    expect(h.conn.state).toBe('disposed')
    expect(h.conn.hello).toBeNull()
  })

  it('only starts once, and not again after being disposed', () => {
    const h = harness()
    h.conn.start()
    h.conn.start()
    expect(h.sockets).toHaveLength(1)
    h.conn.dispose()
    h.conn.start()
    expect(h.sockets).toHaveLength(1)
  })
})

describe('creating the socket', () => {
  it('uses the global WebSocket by default', async () => {
    const created: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: string) {
          super(url)
          created.push(url)
        }
      }
    )
    const conn = new BridgeConnection({ url: 'ws://x/', clientName: 'c', logger: {} })
    conn.start()
    expect(created).toEqual(['ws://x/'])
    conn.dispose()
  })

  it('reports a missing global WebSocket instead of throwing, and keeps retrying', async () => {
    vi.stubGlobal('WebSocket', undefined)
    const warn = vi.fn()
    const conn = new BridgeConnection({
      url: 'ws://x/',
      clientName: 'c',
      logger: { warn },
      reconnect: { initialDelayMs: 50 }
    })
    conn.start()
    expect(conn.state).toBe('disconnected')
    expect(conn.lastError).toMatch(/No global WebSocket/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot create WebSocket'))
    await vi.advanceTimersByTimeAsync(50)
    expect(warn).toHaveBeenCalledTimes(2)
    conn.dispose()
  })

  it('backs off exponentially up to the maximum while the socket cannot be created', async () => {
    const delays: number[] = []
    let calls = 0
    const conn = new BridgeConnection({
      url: 'ws://x/',
      clientName: 'c',
      logger: {},
      reconnect: { initialDelayMs: 100, maxDelayMs: 350 },
      createWebSocket: () => {
        delays.push(Date.now())
        calls++
        throw new Error('boom')
      }
    })
    conn.start()
    await vi.advanceTimersByTimeAsync(10_000)
    const gaps = delays.slice(1, 6).map((at, index) => at - delays[index]!)
    expect(gaps).toEqual([100, 200, 350, 350, 350])
    expect(calls).toBeGreaterThan(5)
    conn.dispose()
  })

  it('does not reconnect at all when reconnecting is disabled', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = await h.connect()
    socket.drop(1006, 'gone')
    expect(h.conn.state).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sockets).toHaveLength(1)
  })
})

describe('url resolver', () => {
  it('connects to the resolved url', async () => {
    const h = harness({ url: async () => 'ws://resolved/' })
    h.conn.start()
    expect(h.sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sockets[0]?.url).toBe('ws://resolved/')
  })

  it('records a failing resolver and retries with backoff', async () => {
    let calls = 0
    const h = harness({
      url: () => {
        calls++
        if (calls < 3) {
          throw new Error('port file missing')
        }
        return 'ws://late/'
      },
      reconnect: { initialDelayMs: 100 }
    })
    h.conn.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.conn.lastError).toBe('cannot resolve bridge URL: port file missing')
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('port file missing'))
    expect(h.conn.state).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(100) // 2nd attempt fails
    await vi.advanceTimersByTimeAsync(200) // 3rd attempt resolves
    expect(h.sockets[0]?.url).toBe('ws://late/')
    expect(calls).toBe(3)
  })

  it('does not open a socket for a resolution that finishes after dispose', async () => {
    let resolveUrl!: (url: string) => void
    const h = harness({ url: () => new Promise<string>((resolve) => (resolveUrl = resolve)) })
    h.conn.start()
    await vi.advanceTimersByTimeAsync(0)
    h.conn.dispose()
    resolveUrl('ws://too-late/')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sockets).toHaveLength(0)
  })

  it('ignores a resolver failure that arrives after dispose', async () => {
    let rejectUrl!: (error: Error) => void
    const h = harness({
      url: () => new Promise<string>((_, reject) => (rejectUrl = reject))
    })
    h.conn.start()
    await vi.advanceTimersByTimeAsync(0)
    h.conn.dispose()
    rejectUrl(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.logger.warn).not.toHaveBeenCalled()
    expect(h.conn.lastError).toBeNull()
  })
})

describe('socket events', () => {
  it('treats a refused connection (error without close) as closed', async () => {
    const h = harness({ reconnect: { initialDelayMs: 100 } })
    h.conn.start()
    const socket = h.sockets[0]!
    socket.onerror?.({})
    expect(h.conn.lastError).toBe('WebSocket error')
    expect(h.conn.state).toBe('disconnected')
    expect(socket.closes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.sockets).toHaveLength(2)
  })

  it('survives close() throwing while handling a socket error', () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    h.sockets[0]!.closeError = new Error('x')
    h.sockets[0]!.onerror?.({})
    expect(h.conn.state).toBe('disconnected')
  })

  it('leaves an open socket to its close event after an error', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = await h.connect()
    socket.onerror?.({})
    expect(h.conn.state).toBe('connected')
    expect(h.conn.lastError).toBe('WebSocket error')
    socket.drop(1011, 'server error')
    expect(h.conn.state).toBe('disconnected')
    expect(h.conn.lastError).toBe('server error')
  })

  it('describes a close without a reason by its code, or as unknown', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    let socket = await h.connect()
    socket.drop(1006, '')
    expect(h.conn.lastError).toBe('closed (1006)')
    const second = harness({ reconnect: false })
    second.conn.start()
    socket = await second.connect()
    socket.onclose?.(undefined as never)
    expect(second.conn.lastError).toBe('closed (unknown)')
  })

  it('keeps the first error of a failed attempt, but reports why a live connection ended', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    h.sockets[0]!.onerror?.({})
    expect(h.conn.lastError).toBe('WebSocket error')
    const live = harness({ reconnect: false })
    live.conn.start()
    const socket = await live.connect()
    socket.drop(1001, 'going away')
    expect(live.conn.lastError).toBe('going away')
  })

  it('ignores events from a socket that is no longer current', async () => {
    const h = harness({ reconnect: { initialDelayMs: 100 } })
    h.conn.start()
    const first = await h.connect()
    const { onopen, onmessage, onerror, onclose } = first
    first.drop(1006, 'lost')
    await vi.advanceTimersByTimeAsync(100)
    const second = await h.connect()
    // Real sockets can still deliver events to handlers captured before detach();
    // they must not touch the new connection.
    expect(first.onopen).toBeNull()
    onopen?.({})
    onmessage?.({ data: '{}' })
    onerror?.({})
    onclose?.({ code: 1, reason: 'late' })
    expect(h.conn.state).toBe('connected')
    expect(h.sockets).toHaveLength(2)
    expect(second.sent.filter((m) => m.method === BridgeMethods.hello)).toHaveLength(1)
  })
})

describe('reconnect storms', () => {
  it('doubles the delay on each failed attempt and starts over after a successful hello', async () => {
    const h = harness({ reconnect: { initialDelayMs: 100, maxDelayMs: 1000 } })
    h.conn.start()
    const openedAt: number[] = [Date.now()]
    for (let i = 0; i < 5; i++) {
      h.sockets.at(-1)!.drop(1006, 'refused')
      const before = h.sockets.length
      // advance in small steps to measure the delay
      for (let t = 0; h.sockets.length === before && t < 5000; t += 10) {
        await vi.advanceTimersByTimeAsync(10)
      }
      openedAt.push(Date.now())
    }
    const gaps = openedAt.slice(1).map((at, index) => at - openedAt[index]!)
    expect(gaps).toEqual([100, 200, 400, 800, 1000])

    await h.connect()
    expect(h.conn.state).toBe('connected')
    h.sockets.at(-1)!.drop(1006, 'again')
    const count = h.sockets.length
    await vi.advanceTimersByTimeAsync(99)
    expect(h.sockets).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets).toHaveLength(count + 1)
  })

  it('never has more than one socket or timer outstanding', async () => {
    const h = harness({ reconnect: { initialDelayMs: 10, maxDelayMs: 10 } })
    h.conn.start()
    for (let i = 0; i < 50; i++) {
      h.sockets.at(-1)!.drop(1006, 'flap')
      h.conn.start() // a caller poking start() during the storm must not duplicate sockets
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(h.sockets).toHaveLength(51)
    h.conn.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('notifies disconnect handlers only for connections that were established', async () => {
    const h = harness({ reconnect: { initialDelayMs: 10 } })
    const reasons: string[] = []
    h.conn.onDisconnect((reason) => reasons.push(reason))
    h.conn.start()
    h.sockets[0]!.drop(1006, 'never connected')
    await vi.advanceTimersByTimeAsync(10)
    expect(reasons).toEqual([])
    const socket = await h.connect()
    socket.drop(1006, 'lost it')
    expect(reasons).toEqual(['lost it'])
  })

  it('reports state changes and survives a throwing state handler', async () => {
    const h = harness({ reconnect: false })
    const states: string[] = []
    h.conn.onStateChange(() => {
      throw new Error('ui bug')
    })
    h.conn.onStateChange(() => states.push(h.conn.state))
    h.conn.start()
    await h.connect()
    h.sockets[0]!.drop()
    expect(states).toEqual(['connecting', 'connected', 'disconnected'])
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('ui bug'))
  })

  it('lets handlers unsubscribe', async () => {
    const h = harness({ reconnect: false })
    const calls: string[] = []
    const off = [
      h.conn.onStateChange(() => calls.push('state')),
      h.conn.onConnect(() => calls.push('connect')),
      h.conn.onDisconnect(() => calls.push('disconnect')),
      h.conn.onNotification(() => calls.push('notification'))
    ]
    for (const unsubscribe of off) {
      unsubscribe()
    }
    h.conn.start()
    const socket = await h.connect()
    socket.receive({ jsonrpc: '2.0', method: 'x' })
    socket.drop()
    expect(calls).toEqual([])
  })
})

describe('requests', () => {
  async function connected(overrides: Partial<BridgeConnectionOptions> = {}) {
    const h = harness({ reconnect: false, ...overrides })
    h.conn.start()
    const socket = await h.connect()
    return { ...h, socket }
  }

  it('rejects with NotConnected before the handshake and after a drop', async () => {
    const h = harness({ reconnect: false })
    await expect(h.conn.request('x')).rejects.toMatchObject({ code: ClientErrorCodes.NotConnected })
    h.conn.start()
    const socket = await h.connect()
    socket.drop()
    const error = await h.conn.request('x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ code: ClientErrorCodes.NotConnected, name: 'RpcError' })
    expect((error as Error).message).toMatch(/Not connected to the bridge \(x\)/)
  })

  it('resolves with the result, and null when the result is absent', async () => {
    const { conn, socket } = await connected()
    const first = conn.request('a', { n: 1 })
    const second = conn.request('b')
    const [a, b] = socket.find('a').concat(socket.find('b'))
    expect(a?.params).toEqual({ n: 1 })
    socket.answer(b!, undefined)
    socket.answer(a!, { ok: true })
    expect(await first).toEqual({ ok: true })
    expect(await second).toBeNull()
  })

  it('maps a JSON-RPC error to an RpcError carrying code, message and data', async () => {
    const { conn, socket } = await connected()
    const pending = conn.request('lsp/request')
    socket.fail(socket.find('lsp/request')[0]!, JsonRpcErrorCodes.SessionNotFound, 'gone', {
      sessionId: 's1'
    })
    await expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCodes.SessionNotFound,
      message: 'gone',
      data: { sessionId: 's1' }
    })
  })

  it('times out with the default, a per-request and a numeric timeout; 0 disables it', async () => {
    const { conn, socket } = await connected({ requestTimeoutMs: 1000 })
    const slow = conn.request('slow')
    const quick = conn.request('quick', undefined, 50)
    const named = conn.request('named', undefined, { timeoutMs: 200 })
    const forever = conn.request('forever', undefined, { timeoutMs: 0 })
    const outcomes = [slow, quick, named].map((p) => p.catch((e: RpcError) => e.code))
    await vi.advanceTimersByTimeAsync(50)
    expect(await outcomes[1]).toBe(ClientErrorCodes.Timeout)
    await vi.advanceTimersByTimeAsync(150)
    expect(await outcomes[2]).toBe(ClientErrorCodes.Timeout)
    await vi.advanceTimersByTimeAsync(800)
    expect(await outcomes[0]).toBe(ClientErrorCodes.Timeout)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    socket.answer(socket.find('forever')[0]!, 'finally')
    expect(await forever).toBe('finally')
  })

  it('uses a 30 s default timeout', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    await h.connect()
    const pending = h.conn.request('slow').catch((e: RpcError) => e.code)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(ClientErrorCodes.Timeout)
  })

  it('ignores a late answer to a request that timed out', async () => {
    const { conn, socket } = await connected({ requestTimeoutMs: 10 })
    const pending = conn.request('slow').catch((e: RpcError) => e.code)
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toBe(ClientErrorCodes.Timeout)
    socket.answer(socket.find('slow')[0]!, 'late')
    expect(conn.state).toBe('connected')
  })

  it('clears the timeout timer once a request is answered', async () => {
    const { conn, socket } = await connected()
    const pending = conn.request('a')
    expect(vi.getTimerCount()).toBe(1)
    socket.answer(socket.find('a')[0]!, 1)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a request whose frame cannot be sent', async () => {
    const { conn, socket, logger } = await connected()
    socket.sendError = new Error('buffer full')
    await expect(conn.request('x')).rejects.toMatchObject({
      code: ClientErrorCodes.NotConnected,
      message: 'Cannot send x'
    })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('send failed: buffer full'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a request when the socket is not open although the state says connected', async () => {
    const { conn, socket } = await connected()
    socket.readyState = 2 // CLOSING
    await expect(conn.request('x')).rejects.toMatchObject({ code: ClientErrorCodes.NotConnected })
    expect(conn.notify('y')).toBe(false)
  })

  it('rejects every in-flight request when the connection drops', async () => {
    const { conn, socket } = await connected()
    const pending = [conn.request('a'), conn.request('b')].map((p) =>
      p.catch((e: RpcError) => [e.code, e.message])
    )
    socket.drop(1006, 'bridge crashed')
    expect(await Promise.all(pending)).toEqual([
      [ClientErrorCodes.ConnectionClosed, 'Connection closed: bridge crashed'],
      [ClientErrorCodes.ConnectionClosed, 'Connection closed: bridge crashed']
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends notifications only while connected', async () => {
    const h = harness({ reconnect: false })
    expect(h.conn.notify('a')).toBe(false)
    h.conn.start()
    const socket = await h.connect()
    expect(h.conn.notify('document/close', { x: 1 })).toBe(true)
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'document/close',
      params: { x: 1 }
    })
    expect(socket.sent.at(-1)?.id).toBeUndefined()
  })
})

describe('cancellation', () => {
  function tokenSource() {
    const listeners = new Set<() => void>()
    let cancelled = false
    return {
      token: {
        get isCancellationRequested() {
          return cancelled
        },
        onCancellationRequested(listener: () => void) {
          listeners.add(listener)
          return { dispose: () => listeners.delete(listener) }
        }
      },
      get listeners() {
        return listeners.size
      },
      cancel() {
        cancelled = true
        for (const listener of [...listeners]) listener()
      }
    }
  }

  async function connected() {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = await h.connect()
    return { ...h, socket }
  }

  it('rejects at once for a token that is already cancelled, sending nothing', async () => {
    const { conn, socket } = await connected()
    const source = tokenSource()
    source.cancel()
    const before = socket.sent.length
    await expect(conn.request('lsp/request', {}, { token: source.token })).rejects.toMatchObject({
      code: ClientErrorCodes.Cancelled
    })
    expect(socket.sent).toHaveLength(before)
  })

  it('checks cancellation before connectivity', async () => {
    const h = harness({ reconnect: false })
    const source = tokenSource()
    source.cancel()
    await expect(h.conn.request('x', {}, { token: source.token })).rejects.toMatchObject({
      code: ClientErrorCodes.Cancelled
    })
  })

  it('sends lsp/cancel with the request id for lsp/request and rejects with Cancelled', async () => {
    const { conn, socket } = await connected()
    const source = tokenSource()
    const pending = conn.request('lsp/request', { method: 'x' }, { token: source.token })
    const id = socket.find('lsp/request')[0]!.id
    source.cancel()
    await expect(pending).rejects.toMatchObject({ code: ClientErrorCodes.Cancelled })
    expect(socket.find('lsp/cancel')).toEqual([
      { jsonrpc: '2.0', method: 'lsp/cancel', params: { id } }
    ])
    expect(vi.getTimerCount()).toBe(0)
    // the bridge's late answer for the cancelled id is dropped
    socket.answer(socket.find('lsp/request')[0]!, 'late')
    expect(conn.state).toBe('connected')
  })

  it('does not send lsp/cancel for other methods', async () => {
    const { conn, socket } = await connected()
    const source = tokenSource()
    const pending = conn.request('fs/readFile', {}, { token: source.token })
    source.cancel()
    await expect(pending).rejects.toMatchObject({ code: ClientErrorCodes.Cancelled })
    expect(socket.find('lsp/cancel')).toHaveLength(0)
  })

  it('releases the token listener when the request is answered, failed or timed out', async () => {
    const { conn, socket } = await connected()
    const answered = tokenSource()
    const p1 = conn.request('a', {}, { token: answered.token })
    expect(answered.listeners).toBe(1)
    socket.answer(socket.find('a')[0]!, 1)
    await p1
    expect(answered.listeners).toBe(0)

    const failed = tokenSource()
    const p2 = conn.request('b', {}, { token: failed.token })
    socket.fail(socket.find('b')[0]!, -32603, 'x')
    await p2.catch(() => {})
    expect(failed.listeners).toBe(0)

    const timed = tokenSource()
    const p3 = conn.request('c', {}, { token: timed.token, timeoutMs: 5 }).catch(() => {})
    await vi.advanceTimersByTimeAsync(5)
    await p3
    expect(timed.listeners).toBe(0)
  })

  it('ignores a cancellation that races with the answer', async () => {
    const { conn, socket } = await connected()
    // a token whose dispose() does nothing, so its listener can fire after the answer
    let listener: (() => void) | null = null
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(fn: () => void) {
        listener = fn
        return { dispose() {} }
      }
    }
    const pending = conn.request('lsp/request', {}, { token })
    socket.answer(socket.find('lsp/request')[0]!, 'done')
    expect(await pending).toBe('done')
    listener!()
    expect(socket.find('lsp/cancel')).toHaveLength(0)
  })

  it('catches a token that fired while the listener was being registered', async () => {
    const { conn, socket } = await connected()
    let disposed = 0
    const token = {
      isCancellationRequested: false,
      onCancellationRequested() {
        // fires "synchronously" without ever calling the listener
        this.isCancellationRequested = true
        return { dispose: () => disposed++ }
      }
    }
    await expect(conn.request('lsp/request', {}, { token })).rejects.toMatchObject({
      code: ClientErrorCodes.Cancelled
    })
    expect(disposed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.find('lsp/cancel')).toHaveLength(0)
  })
})

describe('incoming frames', () => {
  async function connected() {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = await h.connect()
    return { ...h, socket }
  }

  it('drops binary and non-JSON frames without breaking the connection', async () => {
    const { conn, socket, logger } = await connected()
    socket.onmessage?.({ data: new ArrayBuffer(4) })
    expect(logger.warn).not.toHaveBeenCalled()
    socket.receive('{not json')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-JSON frame'))
    socket.receive('null')
    socket.receive('7')
    socket.receive('"str"')
    expect(conn.state).toBe('connected')
  })

  it('ignores responses without an id or for unknown ids', async () => {
    const { conn, socket } = await connected()
    const pending = conn.request('a')
    socket.receive({ jsonrpc: '2.0', result: 1 })
    socket.receive({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } })
    socket.receive({ jsonrpc: '2.0', id: 999, result: 1 })
    socket.answer(socket.find('a')[0]!, 'real')
    expect(await pending).toBe('real')
  })

  it('answers a bridge-to-client request with MethodNotFound instead of hanging the peer', async () => {
    const { socket } = await connected()
    socket.receive({ jsonrpc: '2.0', id: 'srv-1', method: 'window/showMessage', params: {} })
    expect(socket.sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'srv-1',
      error: {
        code: JsonRpcErrorCodes.MethodNotFound,
        message: 'Unknown method window/showMessage'
      }
    })
  })

  it('delivers notifications to every handler, even if one throws', async () => {
    const { conn, socket, logger } = await connected()
    const seen: unknown[] = []
    conn.onNotification(() => {
      throw new Error('broken listener')
    })
    conn.onNotification((method, params) => seen.push([method, params]))
    socket.receive({ jsonrpc: '2.0', method: 'document/diagnostics', params: { a: 1 } })
    expect(seen).toEqual([['document/diagnostics', { a: 1 }]])
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('broken listener'))
  })
})

describe('dispose', () => {
  it('rejects in-flight requests, closes the socket and cancels a pending reconnect', async () => {
    const h = harness({ reconnect: { initialDelayMs: 1000 } })
    h.conn.start()
    const socket = await h.connect()
    const pending = h.conn.request('lsp/request').catch((e: RpcError) => [e.code, e.message])
    h.conn.dispose()
    expect(await pending).toEqual([ClientErrorCodes.ConnectionClosed, 'Client disposed'])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'client disposed' }])
    expect(h.conn.state).toBe('disposed')
    expect(h.conn.isConnected).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await expect(h.conn.request('x')).rejects.toMatchObject({ code: ClientErrorCodes.NotConnected })

    const again = harness({ reconnect: { initialDelayMs: 1000 } })
    again.conn.start()
    again.sockets[0]!.drop(1006, 'x') // schedules a reconnect
    expect(vi.getTimerCount()).toBe(1)
    again.conn.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(again.sockets).toHaveLength(1)
  })

  it('is idempotent and tolerates a socket that throws on close', async () => {
    const h = harness({ reconnect: false })
    h.conn.start()
    const socket = await h.connect()
    socket.closeError = new Error('already closed')
    h.conn.dispose()
    h.conn.dispose()
    expect(socket.closes).toHaveLength(1)
  })

  it('notifies no handler about its own teardown and drops late socket events', async () => {
    const h = harness({ reconnect: false })
    const disconnects = vi.fn()
    h.conn.onDisconnect(disconnects)
    h.conn.start()
    const socket = await h.connect()
    h.conn.dispose()
    socket.drop(1000, 'client disposed')
    socket.receive({ jsonrpc: '2.0', method: 'x' })
    expect(disconnects).not.toHaveBeenCalled()
    expect(h.conn.state).toBe('disposed')
  })

  it('does not reconnect when the socket closes while the url is being re-resolved', async () => {
    let resolveUrl!: (url: string) => void
    let calls = 0
    const h = harness({
      url: () => {
        calls++
        return calls === 1 ? 'ws://one/' : new Promise<string>((resolve) => (resolveUrl = resolve))
      },
      reconnect: { initialDelayMs: 10 }
    })
    h.conn.start()
    await vi.advanceTimersByTimeAsync(0)
    const socket = await h.connect()
    socket.drop(1006, 'lost')
    await vi.advanceTimersByTimeAsync(10) // reconnect timer: resolver is pending now
    h.conn.dispose()
    resolveUrl('ws://two/')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sockets).toHaveLength(1)
  })
})

describe('errorMessage', () => {
  it('reads Error messages and stringifies everything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage({ a: 1 })).toBe('[object Object]')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

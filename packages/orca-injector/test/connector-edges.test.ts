/** BridgeConnector and its helpers under malformed answers, races and hostile listeners. */
import { PROTOCOL_VERSION } from '@mlp/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeConnector,
  BridgeError,
  FRESH_MS,
  HEARTBEAT_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  classifyBridgeError,
  noticeFor,
  parseBridgeInfo,
  sameEndpoint,
  type BridgeInfo,
  type ConnectorDeps,
  type InvokeCommand
} from '../src/connector'

const good = (port = 4000, token = 'tok'): Record<string, unknown> => ({
  port,
  token,
  protocolVersion: PROTOCOL_VERSION,
  pluginVersion: '0.1.0',
  hostNavigation: true
})

function make(invoke: InvokeCommand | null, overrides: Partial<ConnectorDeps> = {}) {
  const state = { visible: true, connected: false, invoke }
  const log = vi.fn()
  const connector = new BridgeConnector({
    getInvoke: () => state.invoke,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    isVisible: () => state.visible,
    isClientConnected: () => state.connected,
    log,
    ...overrides
  })
  return { connector, state, log }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('parseBridgeInfo', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a fractional port', { ...good(), port: 80.5 }],
    ['a negative port', { ...good(), port: -1 }],
    ['a port above 65535', { ...good(), port: 70_000 }],
    ['a string port', { ...good(), port: '4000' }],
    ['an empty token', { ...good(), token: '' }],
    ['a numeric token', { ...good(), token: 5 }]
  ])('rejects %s as a bad response', (_name, value) => {
    expect(() => parseBridgeInfo(value)).toThrowError(BridgeError)
    try {
      parseBridgeInfo(value)
    } catch (error) {
      expect((error as BridgeError).kind).toBe('bad-response')
    }
  })

  it('rejects a missing or foreign protocol version', () => {
    for (const protocolVersion of [undefined, 'one', Number.NaN, PROTOCOL_VERSION + 1]) {
      try {
        parseBridgeInfo({ ...good(), protocolVersion })
        throw new Error('accepted')
      } catch (error) {
        expect((error as BridgeError).kind).toBe('protocol-mismatch')
      }
    }
  })

  it('defaults the optional fields', () => {
    expect(parseBridgeInfo({ port: 1, token: 't', protocolVersion: PROTOCOL_VERSION })).toEqual({
      port: 1,
      token: 't',
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: null,
      hostNavigation: false
    })
    expect(parseBridgeInfo({ ...good(), hostNavigation: 'yes', pluginVersion: 3 })).toMatchObject({
      pluginVersion: null,
      hostNavigation: false
    })
  })
})

describe('classifyBridgeError / noticeFor / sameEndpoint', () => {
  it('keeps BridgeErrors, stringifies everything else', () => {
    const original = new BridgeError('plugin-outdated', 'x')
    expect(classifyBridgeError(original)).toBe(original)
    expect(classifyBridgeError('plain text')).toMatchObject({
      kind: 'error',
      message: 'plain text'
    })
    expect(classifyBridgeError(undefined).message).toBe('undefined')
    expect(classifyBridgeError(new Error('not declared in the manifest')).kind).toBe(
      'plugin-outdated'
    )
    expect(classifyBridgeError(new Error('the plugin system is off')).kind).toBe(
      'plugin-not-enabled'
    )
  })

  it('has a title and a fix for every kind', () => {
    const kinds = [
      'api-missing',
      'plugin-not-enabled',
      'plugin-outdated',
      'protocol-mismatch',
      'bad-response',
      'error'
    ] as const
    const titles = kinds.map((kind) => noticeFor(new BridgeError(kind, 'details')).title)
    expect(titles).toEqual([
      'Code navigation is not active',
      'Code navigation is not active',
      'Code navigation: version mismatch',
      'Code navigation: version mismatch',
      'Code navigation: bridge unavailable',
      'Code navigation: bridge unavailable'
    ])
    expect(noticeFor(new BridgeError('plugin-outdated', 'details')).body).toContain('(details)')
    expect(noticeFor(new BridgeError('error', 'boom')).body).toContain('boom')
  })

  it('compares endpoints by port and token', () => {
    const a = { port: 1, token: 't' } as BridgeInfo
    expect(sameEndpoint(a, { ...a })).toBe(true)
    expect(sameEndpoint(a, { ...a, token: 'u' })).toBe(false)
    expect(sameEndpoint(a, { ...a, port: 2 })).toBe(false)
    expect(sameEndpoint(a, null)).toBe(false)
    expect(sameEndpoint(null, null)).toBe(false)
  })
})

describe('refresh', () => {
  it('shares one in-flight invocation between concurrent callers', async () => {
    const invoke = vi.fn(async () => good())
    const { connector } = make(invoke)
    const [a, b, c] = await Promise.all([
      connector.refresh(),
      connector.refresh(),
      connector.refresh()
    ])
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('re-invokes once a cached result is older than the allowed age', async () => {
    const invoke = vi.fn(async () => good())
    const { connector } = make(invoke)
    await connector.refresh()
    vi.advanceTimersByTime(FRESH_MS)
    await connector.refresh(FRESH_MS) // exactly at the limit: still fresh
    expect(invoke).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await connector.refresh(FRESH_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    await connector.refresh(0) // age 0 always invokes
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('does not reuse a cached result while unavailable', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => good())
    const { connector } = make(invoke)
    await connector.refresh()
    invoke.mockRejectedValueOnce(new Error('boom'))
    await expect(connector.refresh()).rejects.toBeInstanceOf(BridgeError)
    expect(connector.state).toBe('unavailable')
    await expect(connector.refresh(FRESH_MS)).resolves.toMatchObject({ port: 4000 })
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('classifies malformed answers and a missing API', async () => {
    const malformed = make(async () => ({ port: 'x' }))
    await expect(malformed.connector.refresh()).rejects.toMatchObject({ kind: 'bad-response' })
    const noApi = make(null)
    await expect(noApi.connector.refresh()).rejects.toMatchObject({ kind: 'api-missing' })
    expect(noApi.log).toHaveBeenCalledWith(
      expect.stringContaining('ensureBridge failed (api-missing)')
    )
    const mismatch = make(async () => ({ ...good(), protocolVersion: 99 }))
    await expect(mismatch.connector.refresh()).rejects.toMatchObject({ kind: 'protocol-mismatch' })
  })

  it('rejects after dispose', async () => {
    const { connector } = make(async () => good())
    connector.dispose()
    await expect(connector.refresh()).rejects.toMatchObject({ message: 'disposed' })
  })

  it('start() only starts once and only from idle', async () => {
    const invoke = vi.fn(async () => good())
    const { connector } = make(invoke)
    connector.start()
    connector.start()
    await vi.advanceTimersByTimeAsync(0)
    connector.start()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('schedules a single retry per failure series and resets the backoff on success', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => {
      throw new Error('down')
    })
    const { connector } = make(invoke)
    connector.start()
    await vi.advanceTimersByTimeAsync(0)
    // extra refreshes during the series must not add timers
    await expect(connector.refresh()).rejects.toBeDefined()
    await expect(connector.refresh()).rejects.toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    const failures = invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4)
    expect(invoke.mock.calls.length).toBeGreaterThan(failures)

    invoke.mockImplementation(async () => good())
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS)
    expect(connector.state).toBe('available')
    invoke.mockImplementationOnce(async () => {
      throw new Error('down again')
    })
    const calls = invoke.mock.calls.length
    await expect(connector.refresh()).rejects.toBeDefined()
    // the series started over with the first delay
    await vi.advanceTimersByTimeAsync(RETRY_INITIAL_MS)
    expect(invoke.mock.calls.length).toBe(calls + 2)
  })

  it('does not schedule retries once disposed', async () => {
    const { connector } = make(async () => {
      throw new Error('down')
    })
    const failing = connector.refresh().catch(() => {})
    connector.dispose()
    await failing
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('waitForInfo', () => {
  it('resolves with a fresh result without invoking again', async () => {
    const invoke = vi.fn(async () => good())
    const { connector } = make(invoke)
    await connector.refresh()
    await expect(connector.waitForInfo()).resolves.toMatchObject({ port: 4000 })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('answers every waiter when the retry succeeds', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => {
      throw new Error('down')
    })
    const { connector } = make(invoke)
    const waiting = [connector.waitForInfo(), connector.waitForInfo(0)]
    await vi.advanceTimersByTimeAsync(0)
    invoke.mockImplementation(async () => good(4100, 'new'))
    await vi.advanceTimersByTimeAsync(RETRY_INITIAL_MS * 4)
    expect((await Promise.all(waiting)).map((info) => info.port)).toEqual([4100, 4100])
  })

  it('resolves immediately when the failed refresh raced a success', async () => {
    const { connector } = make(async () => good())
    await connector.refresh()
    // a failure report while info is available and state is available again
    connector.state = 'available'
    const spy = vi.spyOn(connector, 'refresh').mockRejectedValue(new Error('late failure'))
    await expect(connector.waitForInfo()).resolves.toMatchObject({ port: 4000 })
    spy.mockRestore()
  })
})

describe('heartbeat', () => {
  it('starts once, never after dispose, and stops with dispose', async () => {
    const invoke = vi.fn(async () => good())
    const { connector } = make(invoke)
    await connector.refresh()
    connector.startHeartbeat()
    connector.startHeartbeat()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(invoke).toHaveBeenCalledTimes(2)
    connector.dispose()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5)
    expect(invoke).toHaveBeenCalledTimes(2)
    connector.startHeartbeat()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('ignores visibility changes before it started, while hidden, or soon after a beat', async () => {
    const invoke = vi.fn(async () => good())
    const { connector, state } = make(invoke)
    connector.handleVisibilityChange() // not heartbeating yet
    await connector.refresh()
    connector.startHeartbeat()
    state.visible = false
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    connector.handleVisibilityChange() // hidden: nothing to catch up on
    state.visible = true
    vi.setSystemTime(Date.now() - HEARTBEAT_MS * 2 + 1_000) // only 1 s since the last beat
    connector.handleVisibilityChange()
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('treats a throwing connected-check as "not connected"', async () => {
    const invoke = vi.fn(async () => good())
    const { connector, state } = make(invoke, {
      isClientConnected: () => {
        throw new Error('client gone')
      }
    })
    await connector.refresh()
    connector.startHeartbeat()
    state.visible = false
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(invoke).toHaveBeenCalledTimes(1) // hidden and "disconnected": paused
    state.visible = true
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(invoke.mock.calls.length).toBeGreaterThan(1)
  })

  it('works without a connected-check', async () => {
    const invoke = vi.fn(async () => good())
    const { connector, state } = make(invoke, { isClientConnected: undefined })
    await connector.refresh()
    connector.startHeartbeat()
    state.visible = false
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe('listeners', () => {
  it('survive throwing listeners, support unsubscribing and report the previous info', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => good())
    const { connector } = make(invoke)
    const seen: [string, number | undefined][] = []
    connector.onChange(() => {
      throw new Error('listener bug')
    })
    const off = connector.onChange((c, previous) => seen.push([c.state, previous?.port]))
    await connector.refresh()
    invoke.mockImplementation(async () => good(5000, 'other'))
    await connector.refresh()
    expect(seen).toEqual([
      ['pending', undefined],
      ['available', undefined],
      ['available', 4000]
    ])
    off()
    await connector.refresh()
    expect(seen).toHaveLength(3)
    expect(connector.state).toBe('available')
  })
})

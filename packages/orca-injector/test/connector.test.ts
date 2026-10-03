import { PROTOCOL_VERSION } from '@mlp/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeConnector,
  classifyBridgeError,
  ENSURE_BRIDGE_COMMAND,
  type InvokeCommand,
  noticeFor,
  parseBridgeInfo,
  PLUGIN_KEY
} from '../src/connector'

const ok = (port = 4000, token = 'tok') => ({
  port,
  token,
  protocolVersion: PROTOCOL_VERSION,
  pluginVersion: '0.1.0',
  hostNavigation: true
})

function setup(invoke: InvokeCommand | null) {
  let visible = true
  let connected = false
  const holder = { invoke }
  const connector = new BridgeConnector({
    getInvoke: () => holder.invoke,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    isVisible: () => visible,
    isClientConnected: () => connected
  })
  return {
    connector,
    holder,
    setVisible(v: boolean) {
      visible = v
      connector.handleVisibilityChange()
    },
    setConnected(c: boolean) {
      connected = c
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('parseBridgeInfo / classifyBridgeError', () => {
  it('validates the ensureBridge result', () => {
    expect(parseBridgeInfo(ok())).toMatchObject({ port: 4000, token: 'tok', hostNavigation: true })
    expect(() => parseBridgeInfo({ port: 0, token: 'x', protocolVersion: 1 })).toThrow(/port/)
    expect(() => parseBridgeInfo(null)).toThrow()
    try {
      parseBridgeInfo({ ...ok(), protocolVersion: 999 })
    } catch (e) {
      expect(classifyBridgeError(e).kind).toBe('protocol-mismatch')
    }
  })

  it('maps Orca errors to fixes', () => {
    const notEnabled = classifyBridgeError(
      new Error(
        "Error invoking remote method 'plugins:invokeCommand': Error: plugin cpoepke.monaco-lsp is not enabled"
      )
    )
    expect(notEnabled.kind).toBe('plugin-not-enabled')
    expect(noticeFor(notEnabled).body).toMatch(/Plugin system/)
    expect(
      classifyBridgeError(new Error("No handler registered for 'plugins:invokeCommand'")).kind
    ).toBe('plugin-not-enabled')
    expect(
      classifyBridgeError(new Error('plugin x registered no handler for mlp.ensureBridge')).kind
    ).toBe('plugin-outdated')
    expect(classifyBridgeError(new Error('weird')).kind).toBe('error')
  })
})

describe('BridgeConnector', () => {
  it('calls the plugin command and stores the endpoint', async () => {
    const invoke = vi.fn(async () => ok())
    const { connector } = setup(invoke)
    await expect(connector.refresh()).resolves.toMatchObject({ port: 4000 })
    expect(invoke).toHaveBeenCalledWith({
      pluginKey: PLUGIN_KEY,
      commandId: ENSURE_BRIDGE_COMMAND,
      args: { v: 1 }
    })
    expect(connector.state).toBe('available')
    // fresh results are reused
    await connector.refresh(5_000)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('reports a missing plugin API and retries with backoff 5 s → 2 min', async () => {
    const { connector, holder } = setup(null)
    connector.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(connector.state).toBe('unavailable')
    expect(connector.lastError?.kind).toBe('api-missing')

    const invoke = vi.fn(async () => {
      throw new Error('plugin cpoepke.monaco-lsp is not enabled')
    })
    holder.invoke = invoke
    const delays = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]
    for (const [i, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(invoke).toHaveBeenCalledTimes(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(invoke).toHaveBeenCalledTimes(i + 1)
    }
    expect(connector.lastError?.kind).toBe('plugin-not-enabled')

    invoke.mockImplementation(async () => ok() as never)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connector.state).toBe('available')
    // no further retries once available
    const calls = invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invoke).toHaveBeenCalledTimes(calls)
  })

  it('waitForInfo resolves once a retry succeeds', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => {
      throw new Error('plugin cpoepke.monaco-lsp is not enabled')
    })
    const { connector } = setup(invoke)
    let resolved: unknown = null
    void connector.waitForInfo().then((info) => (resolved = info))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBeNull()
    invoke.mockImplementation(async () => ok(4100))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(resolved).toMatchObject({ port: 4100 })
  })

  it('heartbeats every 2 minutes while visible and reports endpoint changes', async () => {
    const invoke = vi.fn(async () => ok())
    const { connector, setVisible } = setup(invoke)
    const changes: [number | undefined, number | undefined][] = []
    connector.onChange((c, prev) => changes.push([prev?.port, c.info?.port]))
    await connector.refresh()
    connector.startHeartbeat()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(invoke).toHaveBeenCalledTimes(2)

    // worker restarted with a new port
    invoke.mockImplementation(async () => ok(5000, 'new'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(connector.info?.port).toBe(5000)
    expect(changes.at(-1)).toEqual([4000, 5000])

    // hidden: heartbeats pause
    setVisible(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invoke).toHaveBeenCalledTimes(3)
    // visible again after > 2 min: immediate catch-up heartbeat
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(invoke).toHaveBeenCalledTimes(5)
  })

  it('keeps heartbeating while hidden as long as the client is connected', async () => {
    const invoke = vi.fn(async () => ok())
    const { connector, setVisible, setConnected } = setup(invoke)
    await connector.refresh()
    connector.startHeartbeat()
    setConnected(true)
    setVisible(false)
    // minimized for 10 min: Orca's 5-min idle reap must never see a gap > 2 min
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invoke).toHaveBeenCalledTimes(1 + 5)

    // hidden and disconnected: paused
    setConnected(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(invoke).toHaveBeenCalledTimes(6)

    // the client reconnects while still hidden: heartbeats resume within one period
    setConnected(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(invoke).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(invoke).toHaveBeenCalledTimes(8)
  })

  it('a failed heartbeat switches to retrying', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ok())
    const { connector } = setup(invoke)
    await connector.refresh()
    connector.startHeartbeat()
    invoke.mockImplementation(async () => {
      throw new Error('boom')
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connector.state).toBe('unavailable')
    invoke.mockImplementation(async () => ok())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(connector.state).toBe('available')
  })
})

/** Shutdown failure paths of the CLI, with a bridge whose close() misbehaves. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeOptions } from '../src/bridge/bridge-options'
import { FORCE_EXIT_MS, runCli, type CliIo } from '../src/run-cli'

const mocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  created: [] as unknown[]
}))

vi.mock('../src/bridge/create-bridge', () => ({
  createBridge: (options: BridgeOptions) => {
    mocks.created.push(options)
    return {
      listen: async () => ({ port: 4321 }),
      close: () => mocks.close()
    }
  }
}))

function fakeIo() {
  const signals = new Map<string, (signal: NodeJS.Signals) => void>()
  const exits: number[] = []
  const out: string[] = []
  const io: CliIo = {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: () => true },
    onSignal: (signal, handler) => void signals.set(signal, handler),
    exit: (code) => void exits.push(code)
  }
  return { io, signals, exits, out }
}

const spyStderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
let stderrSpy: ReturnType<typeof spyStderr>

beforeEach(() => {
  vi.useFakeTimers()
  mocks.created.length = 0
  mocks.close.mockReset()
  stderrSpy = spyStderr()
})
afterEach(() => {
  vi.useRealTimers()
  stderrSpy.mockRestore()
})

describe('shutdown', () => {
  it('exits 1 and logs when closing the bridge fails', async () => {
    mocks.close.mockRejectedValue(new Error('server wedged'))
    const { io, signals, exits } = fakeIo()
    expect(await runCli(['--port', '0', '--token', 't'], {}, io)).toBeNull()
    signals.get('SIGTERM')!('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(exits).toEqual([1])
    const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join('')
    expect(logged).toContain('shutdown failed')
    expect(logged).toContain('server wedged')
  })

  it('forces the exit when closing hangs', async () => {
    mocks.close.mockReturnValue(new Promise(() => {}))
    const { io, signals, exits } = fakeIo()
    await runCli(['--port', '0', '--token', 't'], {}, io)
    signals.get('SIGINT')!('SIGINT')
    await vi.advanceTimersByTimeAsync(FORCE_EXIT_MS - 1)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(exits).toEqual([1])
    // later signals neither restart the shutdown nor schedule another timer
    signals.get('SIGTERM')!('SIGTERM')
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it('does not force the exit after a clean close', async () => {
    mocks.close.mockResolvedValue(undefined)
    const { io, signals, exits } = fakeIo()
    await runCli(['--port', '0', '--token', 't'], {}, io)
    signals.get('SIGTERM')!('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(exits).toEqual([0])
  })
})

describe('bridge options', () => {
  it('passes the flags through to the bridge', async () => {
    const { io } = fakeIo()
    await runCli(
      [
        '--port',
        '1234',
        '--token',
        'tok',
        '--host',
        '10.0.0.5',
        '--allow-remote',
        '--trust-project-binaries',
        '--root',
        '/a',
        '--root',
        '/b'
      ],
      {},
      io
    )
    expect(mocks.created[0]).toMatchObject({
      port: 1234,
      token: 'tok',
      host: '10.0.0.5',
      allowRemote: true,
      trustProjectBinaries: true
    })
    expect((mocks.created[0] as BridgeOptions).allowedRoots).toHaveLength(2)
  })

  it('defaults to a loopback host, no remote access and untrusted project binaries', async () => {
    const { io, out } = fakeIo()
    await runCli(['--token', 'tok', '--print-url'], {}, io)
    expect(mocks.created[0]).toMatchObject({
      host: '127.0.0.1',
      allowRemote: false,
      trustProjectBinaries: false,
      allowedRoots: []
    })
    expect(JSON.parse(out[0]!)).toEqual({
      url: 'ws://127.0.0.1:4321/?token=tok',
      port: 4321,
      token: 'tok'
    })
  })
})

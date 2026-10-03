import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@mlp/protocol'
import type { BridgeStatus } from '@mlp/protocol'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealBridge } from '../src/bridge-host'
import type { BridgeFactoryOptions, BridgeHandle } from '../src/bridge-host'
import type { OrcaWorkerApi } from '../src/orca-api'
import {
  createPluginController,
  IDLE_STOP_MS,
  killProcessGroup,
  summarize
} from '../src/plugin-controller'
import type { PluginControllerDeps } from '../src/plugin-controller'
import {
  FAKE_SERVER_PATH,
  isPidAlive,
  pollFor,
  TestClient
} from '../../lsp-bridge/test/helpers/test-client'

type FakeBridge = BridgeHandle & {
  options: BridgeFactoryOptions
  closed: boolean
  clients: number
  pids: number[]
}

function fakeBridgeFactory() {
  const bridges: FakeBridge[] = []
  let nextPort = 40_000
  const factory = vi.fn((options: BridgeFactoryOptions): BridgeHandle => {
    const port = nextPort++
    const bridge: FakeBridge = {
      options,
      closed: false,
      clients: 0,
      pids: [4242],
      listen: vi.fn(async () => ({ port })),
      close: vi.fn(async () => {
        bridge.closed = true
      }),
      status: (): BridgeStatus => ({
        bridgeVersion: '0.1.0',
        clients: bridge.clients,
        sessions: [],
        servers: { gopls: '/usr/bin/gopls', pyright: null }
      }),
      serverPids: () => bridge.pids
    }
    bridges.push(bridge)
    return bridge
  })
  return { factory, bridges }
}

function fakeOrca(capabilities: string[] = ['notifications:show']) {
  const handlers = new Map<string, (args: unknown) => unknown>()
  const events = new Map<string, ((payload: unknown) => unknown)[]>()
  const logs: string[] = []
  const hostCalls: { method: string; params: unknown }[] = []
  const orca: OrcaWorkerApi = {
    commands: { register: (id, handler) => void handlers.set(id, handler) },
    events: {
      on: (event, handler) => void events.set(event, [...(events.get(event) ?? []), handler])
    },
    host: {
      call: async (method, params) => {
        hostCalls.push({ method, params })
        return { delivered: true }
      }
    },
    grantedCapabilities: capabilities,
    log: (line) => void logs.push(line)
  }
  const invoke = async (id: string, args?: unknown): Promise<unknown> => {
    const handler = handlers.get(id)
    if (!handler) throw new Error(`no handler ${id}`)
    // Orca structured-clones the value across fork() IPC.
    return structuredClone(await handler(args))
  }
  const emit = (event: string): void => {
    for (const handler of events.get(event) ?? []) void handler({})
  }
  return { orca, handlers, logs, hostCalls, invoke, events, emit }
}

let fakes: ReturnType<typeof fakeBridgeFactory>
let host: ReturnType<typeof fakeOrca>
let tokenCounter = 0

function setup(overrides: Partial<PluginControllerDeps> = {}) {
  const controller = createPluginController({
    createBridge: fakes.factory,
    hostNavigator: async () => ({ opened: true }),
    hostNavigationAvailable: () => true,
    pluginVersion: '0.1.0',
    randomToken: () => `token-${++tokenCounter}`,
    ...overrides
  })
  controller.activate(host.orca)
  return controller
}

beforeEach(() => {
  tokenCounter = 0
  fakes = fakeBridgeFactory()
  host = fakeOrca()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('activate', () => {
  it('registers the manifest commands synchronously, without starting anything', () => {
    const started = performance.now()
    setup()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect([...host.handlers.keys()].sort()).toEqual([
      'mlp.ensureBridge',
      'mlp.repairPatch',
      'mlp.restart',
      'mlp.status',
      'mlp.stop'
    ])
    expect(fakes.factory).not.toHaveBeenCalled()
  })
})

describe('mlp.ensureBridge', () => {
  it('starts the bridge on 127.0.0.1:0 with a random token and returns connection info', async () => {
    const prepareEnvironment = vi.fn()
    setup({ prepareEnvironment })
    const result = await host.invoke('mlp.ensureBridge', { v: 1 })
    expect(result).toEqual({
      port: 40_000,
      token: 'token-1',
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: '0.1.0',
      hostNavigation: true
    })
    const options = fakes.bridges[0]!.options
    expect(options).toMatchObject({ port: 0, host: '127.0.0.1', token: 'token-1' })
    expect(options.trustProjectBinaries).toBe(false)
    expect(typeof options.hostNavigator).toBe('function')
    expect(prepareEnvironment).toHaveBeenCalledTimes(1)
  })

  it('uses a 32-byte hex token by default', async () => {
    const controller = createPluginController({
      createBridge: fakes.factory,
      hostNavigator: async () => ({ opened: true }),
      hostNavigationAvailable: () => false,
      pluginVersion: '0.1.0'
    })
    const result = await controller.ensureBridge()
    expect(result.token).toMatch(/^[0-9a-f]{64}$/)
    expect(result.hostNavigation).toBe(false)
  })

  it('is idempotent, including for concurrent callers', async () => {
    setup()
    const [a, b] = await Promise.all([
      host.invoke('mlp.ensureBridge'),
      host.invoke('mlp.ensureBridge')
    ])
    const c = await host.invoke('mlp.ensureBridge')
    expect(a).toEqual(b)
    expect(c).toEqual(a)
    expect(fakes.factory).toHaveBeenCalledTimes(1)
  })

  it('propagates listen failures and lets the next call retry', async () => {
    let fail = true
    const factory = vi.fn((options: BridgeFactoryOptions): BridgeHandle => {
      const bridge = fakes.factory(options)
      if (fail) {
        fail = false
        bridge.listen = async () => {
          throw new Error('EADDRINUSE')
        }
      }
      return bridge
    })
    setup({ createBridge: factory })
    await expect(host.invoke('mlp.ensureBridge')).rejects.toThrow('EADDRINUSE')
    expect(fakes.bridges[0]!.closed).toBe(true)
    await expect(host.invoke('mlp.ensureBridge')).resolves.toMatchObject({ port: 40_001 })
  })
})

describe('containment and worktree events', () => {
  it('passes the dynamic allowedRoots and explicit bin dirs to the bridge', async () => {
    const allowedRoots = vi.fn(() => ['/work/repo'])
    setup({ allowedRoots, extraBinDirs: ['/home/me/go/bin'] })
    await host.invoke('mlp.ensureBridge')
    const options = fakes.bridges[0]!.options
    expect(options.allowedRoots).toBe(allowedRoots)
    expect(options.extraBinDirs).toEqual(['/home/me/go/bin'])
  })

  it('refreshes worktrees on worktree.created/removed when events are granted', () => {
    const onWorktreesChanged = vi.fn()
    host = fakeOrca(['notifications:show', 'events:subscribe'])
    setup({ onWorktreesChanged })
    host.emit('worktree.removed')
    host.emit('worktree.created')
    host.emit('agent.status.changed')
    expect(onWorktreesChanged).toHaveBeenCalledTimes(2)
  })

  it('does not subscribe without the events capability', () => {
    const onWorktreesChanged = vi.fn()
    setup({ onWorktreesChanged })
    expect(host.events.size).toBe(0)
  })
})

describe('mlp.stop / mlp.restart / mlp.status', () => {
  it('stop closes the bridge; the next ensure starts a fresh one', async () => {
    setup()
    await host.invoke('mlp.ensureBridge')
    await expect(host.invoke('mlp.stop')).resolves.toEqual({ stopped: true })
    expect(fakes.bridges[0]!.closed).toBe(true)
    await expect(host.invoke('mlp.stop')).resolves.toEqual({ stopped: false })
    const next = (await host.invoke('mlp.ensureBridge')) as { port: number; token: string }
    expect(next.port).toBe(40_001)
    expect(next.token).toBe('token-2')
  })

  it('restart returns new connection info', async () => {
    setup()
    const first = (await host.invoke('mlp.ensureBridge')) as { token: string }
    const second = (await host.invoke('mlp.restart')) as { token: string; port: number }
    expect(second.token).not.toBe(first.token)
    expect(fakes.bridges[0]!.closed).toBe(true)
    expect(fakes.bridges).toHaveLength(2)
  })

  it('status reports the bridge and shows a notification when granted', async () => {
    setup()
    const stopped = (await host.invoke('mlp.status')) as { running: boolean; bridge: unknown }
    expect(stopped).toMatchObject({ running: false, bridge: null, port: null })
    await host.invoke('mlp.ensureBridge')
    const running = await host.invoke('mlp.status', { silent: true })
    expect(running).toMatchObject({
      running: true,
      port: 40_000,
      protocolVersion: PROTOCOL_VERSION,
      bridge: { clients: 0, servers: { gopls: '/usr/bin/gopls' } }
    })
    // One notification for the first (non-silent) call only.
    expect(host.hostCalls).toHaveLength(1)
    expect(host.hostCalls[0]).toMatchObject({
      method: 'notifications.show',
      params: { title: 'Code Navigation (LSP)' }
    })
  })

  it('status does not notify without the capability', async () => {
    host = fakeOrca([])
    setup()
    await host.invoke('mlp.status')
    expect(host.hostCalls).toHaveLength(0)
  })

  it('summarize lists installed and missing servers', () => {
    const text = summarize({
      running: true,
      port: 1234,
      protocolVersion: 1,
      pluginVersion: '0.1.0',
      hostNavigation: false,
      idleStopInMs: 1,
      bridge: {
        bridgeVersion: '0.1.0',
        clients: 2,
        sessions: [],
        servers: { gopls: '/x/gopls', pyright: null }
      },
      patch: {
        state: 'pending',
        orcaVersion: '1.4.215',
        injectorVersion: null,
        asarPath: '/opt/Orca/resources/app.asar',
        autoRepair: true,
        lastRepair: null
      }
    })
    expect(text).toContain('127.0.0.1:1234')
    expect(text).toContain('Installed: gopls')
    expect(text).toContain('Not found: pyright')
    expect(text).toContain('Orca runtime not found')
    expect(text).toContain('Editor patch: applied when you quit Orca (Orca 1.4.215)')
  })
})

describe('idle stop', () => {
  it('stops after 10 min without clients or heartbeat', async () => {
    vi.useFakeTimers()
    setup({ now: () => Date.now() })
    await host.invoke('mlp.ensureBridge')
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 60_000)
    expect(fakes.bridges[0]!.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fakes.bridges[0]!.closed).toBe(true)
  })

  it('heartbeats (ensureBridge calls) keep it running', async () => {
    vi.useFakeTimers()
    setup({ now: () => Date.now() })
    await host.invoke('mlp.ensureBridge')
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      await host.invoke('mlp.ensureBridge')
    }
    expect(fakes.bridges[0]!.closed).toBe(false)
    expect(fakes.factory).toHaveBeenCalledTimes(1)
  })

  it('connected clients keep it running', async () => {
    vi.useFakeTimers()
    setup({ now: () => Date.now() })
    await host.invoke('mlp.ensureBridge')
    fakes.bridges[0]!.clients = 1
    await vi.advanceTimersByTimeAsync(3 * IDLE_STOP_MS)
    expect(fakes.bridges[0]!.closed).toBe(false)
    // Once the last client leaves, the 10 min clock restarts from the last sighting.
    fakes.bridges[0]!.clients = 0
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS + 60_000)
    expect(fakes.bridges[0]!.closed).toBe(true)
  })
})

describe('shutdown', () => {
  it('deactivate closes the bridge', async () => {
    const controller = setup()
    await host.invoke('mlp.ensureBridge')
    await controller.deactivate()
    expect(fakes.bridges[0]!.closed).toBe(true)
  })

  it('deactivate kills servers when close overruns the 2 s grace budget', async () => {
    const killProcess = vi.fn()
    const controller = setup({ killProcess, shutdownBudgetMs: 50 })
    await host.invoke('mlp.ensureBridge')
    fakes.bridges[0]!.close = () => new Promise(() => {})
    await controller.deactivate()
    expect(killProcess).toHaveBeenCalledWith(4242)
  })

  it('killServersSync signals every server pid', async () => {
    const killProcess = vi.fn()
    const controller = setup({ killProcess })
    await host.invoke('mlp.ensureBridge')
    fakes.bridges[0]!.pids = [11, 12]
    controller.killServersSync()
    expect(killProcess.mock.calls).toEqual([[11], [12]])
  })
})

describe.skipIf(process.platform === 'win32')('killServersSync with a real bridge', () => {
  let project: string
  beforeAll(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'mlp-plugin-kill-')))
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'tsconfig.json'), '{}')
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
  })
  afterAll(() => rmSync(project, { recursive: true, force: true }))

  it('kills the server process group, grandchildren included', async () => {
    const controller = setup({
      createBridge: (options) =>
        createRealBridge({
          ...options,
          serverOverrides: {
            'typescript-language-server': {
              command: process.execPath,
              args: [FAKE_SERVER_PATH, '--spawn-grandchild']
            }
          }
        }),
      allowedRoots: () => [project]
    })
    const { port, token } = await controller.ensureBridge()
    const client = await TestClient.connectAndHello(port, token)
    try {
      const path = join(project, 'src', 'a.ts')
      const opened = await client.openDocument(path, 'typescript')
      if (opened.sessionId === null) throw new Error(opened.reason)
      const hover = await client.lsp<{ contents: { value: string } }>(
        opened.sessionId,
        'textDocument/hover',
        { textDocument: { uri: opened.uri }, position: { line: 0, character: 0 } }
      )
      const state = JSON.parse(hover.contents.value) as { pid: number; grandchildPid: number }
      expect(isPidAlive(state.grandchildPid)).toBe(true)
      // The default killProcess, as on process 'exit'.
      controller.killServersSync()
      await pollFor(
        () => (isPidAlive(state.pid) || isPidAlive(state.grandchildPid) ? null : true),
        5000,
        'server and grandchild to exit'
      )
    } finally {
      await client.close()
      await controller.stop()
    }
  })

  it('killProcessGroup falls back to the pid when it leads no group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (typeof pid === 'number' && pid < 0) throw new Error('ESRCH')
      return true
    })
    try {
      killProcessGroup(1234)
      expect(kill.mock.calls).toEqual([
        [-1234, 'SIGTERM'],
        [1234, 'SIGTERM']
      ])
    } finally {
      kill.mockRestore()
    }
  })
})

describe('logging', () => {
  it('never writes the token to orca.log', async () => {
    setup()
    const { token } = (await host.invoke('mlp.ensureBridge')) as { token: string }
    fakes.bridges[0]!.options.logger?.info(`client connected with ${token}`, { token })
    expect(host.logs.length).toBeGreaterThan(0)
    expect(host.logs.join('\n')).not.toContain(token)
    expect(host.logs.join('\n')).toContain('<redacted>')
  })
})

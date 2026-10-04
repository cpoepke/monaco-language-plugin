/**
 * Plugin controller edge cases: races between start/stop, failing hooks, the repair command
 * budget and the summary texts.
 */
import type { BridgeStatus } from '@mlp/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeFactoryOptions, BridgeHandle } from '../src/bridge-host'
import type { OrcaWorkerApi } from '../src/orca-api'
import {
  createPluginController,
  killProcessGroup,
  summarize,
  type PluginControllerDeps,
  type StatusResult
} from '../src/plugin-controller'
import type { RepairReport } from '../src/self-repair/decide'
import type { PatchStatus, SelfRepair } from '../src/self-repair/self-repair'

type FakeBridge = BridgeHandle & {
  options: BridgeFactoryOptions
  closeCalls: number
  clients: number
  pids: number[]
  listenGate?: Promise<void>
  closeGate?: Promise<void>
}

function makeBridges() {
  const bridges: FakeBridge[] = []
  let port = 41_000
  const factory = vi.fn((options: BridgeFactoryOptions): BridgeHandle => {
    const bridge: FakeBridge = {
      options,
      closeCalls: 0,
      clients: 0,
      pids: [777],
      listen: vi.fn(async () => {
        await bridge.listenGate
        return { port: port++ }
      }),
      close: vi.fn(async () => {
        bridge.closeCalls++
        await bridge.closeGate
      }),
      status: (): BridgeStatus => ({
        bridgeVersion: '0.1.0',
        clients: bridge.clients,
        sessions: [],
        servers: {}
      }),
      serverPids: () => bridge.pids
    }
    bridges.push(bridge)
    return bridge
  })
  return { factory, bridges }
}

function makeOrca(capabilities: string[] = ['notifications:show', 'events:subscribe']) {
  const commands = new Map<string, (args: unknown) => unknown>()
  const handlers = new Map<string, (payload: unknown) => unknown>()
  const logs: string[] = []
  const calls: { method: string; params: unknown }[] = []
  const state = { hostError: null as Error | null }
  const orca: OrcaWorkerApi = {
    commands: { register: (id, handler) => void commands.set(id, handler) },
    events: { on: (event, handler) => void handlers.set(event, handler) },
    host: {
      call: async (method, params) => {
        calls.push({ method, params })
        if (state.hostError) throw state.hostError
        return {}
      }
    },
    grantedCapabilities: capabilities,
    log: (line) => void logs.push(line)
  }
  return { orca, commands, handlers, logs, calls, state }
}

let fakes: ReturnType<typeof makeBridges>
let host: ReturnType<typeof makeOrca>

function setup(overrides: Partial<PluginControllerDeps> = {}, activate = true) {
  const controller = createPluginController({
    createBridge: fakes.factory,
    hostNavigator: async () => ({ opened: true }),
    hostNavigationAvailable: () => true,
    pluginVersion: '0.1.0',
    randomToken: (() => {
      let n = 0
      return () => `tok-${++n}`
    })(),
    ...overrides
  })
  if (activate) controller.activate(host.orca)
  return controller
}

beforeEach(() => {
  fakes = makeBridges()
  host = makeOrca()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('start and stop races', () => {
  it('stop waits for a start that is in flight, then stops what started', async () => {
    const gate = deferred()
    const controller = setup({
      createBridge: (options) => {
        const bridge = fakes.factory(options) as FakeBridge
        bridge.listenGate = gate.promise
        return bridge
      }
    })
    const starting = controller.ensureBridge()
    const stopping = controller.stop()
    await Promise.resolve()
    gate.resolve()
    await starting
    expect(await stopping).toEqual({ stopped: true })
    expect(fakes.bridges[0]!.closeCalls).toBe(1)
    expect(controller.status().running).toBe(false)
  })

  it('stop after a failed start has nothing to stop', async () => {
    const controller = setup({
      createBridge: (options) => {
        const bridge = fakes.factory(options)
        bridge.listen = async () => {
          throw new Error('EADDRINUSE')
        }
        return bridge
      }
    })
    const starting = controller.ensureBridge()
    const stopping = controller.stop()
    await expect(starting).rejects.toThrow('EADDRINUSE')
    expect(await stopping).toEqual({ stopped: false })
  })

  it('a second stop during a slow close reports stopped:false, and ensureBridge waits for the close', async () => {
    const gate = deferred()
    const controller = setup()
    await controller.ensureBridge()
    fakes.bridges[0]!.closeGate = gate.promise
    const first = controller.stop()
    const second = controller.stop()
    const ensure = controller.ensureBridge()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fakes.bridges).toHaveLength(1) // nothing new starts while the old one is closing
    gate.resolve()
    expect(await first).toEqual({ stopped: true })
    expect(await second).toEqual({ stopped: false })
    expect((await ensure).port).toBe(41_001)
    expect(fakes.bridges).toHaveLength(2)
  })

  it('logs a failing close and still reports the bridge as stopped', async () => {
    const controller = setup()
    await controller.ensureBridge()
    fakes.bridges[0]!.close = vi.fn(async () => {
      throw new Error('close exploded')
    })
    expect(await controller.stop()).toEqual({ stopped: true })
    expect(host.logs.join('\n')).toContain('bridge close failed')
    expect(host.logs.join('\n')).toContain('close exploded')
    expect(controller.status().running).toBe(false)
  })

  it('times out a listen that never completes and closes the half-started bridge', async () => {
    vi.useFakeTimers()
    const controller = setup({
      listenTimeoutMs: 100,
      createBridge: (options) => {
        const bridge = fakes.factory(options)
        bridge.listen = () => new Promise(() => {})
        return bridge
      }
    })
    const starting = controller.ensureBridge()
    const assertion = expect(starting).rejects.toThrow('timed out after 100 ms')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(fakes.bridges[0]!.closeCalls).toBe(1)
  })

  it('survives a close that also fails after a failed listen', async () => {
    const controller = setup({
      createBridge: (options) => {
        const bridge = fakes.factory(options)
        bridge.listen = async () => {
          throw new Error('listen failed')
        }
        bridge.close = async () => {
          throw new Error('close failed')
        }
        return bridge
      }
    })
    await expect(controller.ensureBridge()).rejects.toThrow('listen failed')
  })
})

describe('hooks that throw', () => {
  it('treats a throwing hostNavigationAvailable as "not available"', async () => {
    const controller = setup({
      hostNavigationAvailable: () => {
        throw new Error('fs error')
      }
    })
    expect((await controller.ensureBridge()).hostNavigation).toBe(false)
    expect(controller.status().hostNavigation).toBe(false)
  })

  it('logs the servers it found and survives a failing detection', async () => {
    const detected = setup({
      detectServers: () => ({ gopls: '/usr/bin/gopls', pyright: null, tsserver: '' })
    })
    await detected.ensureBridge()
    const line = host.logs.find((l) => l.includes('language servers'))
    expect(line).toContain('"found":{"gopls":"/usr/bin/gopls"}')
    expect(line).toContain('"missing":["pyright","tsserver"]')

    host = makeOrca()
    const failing = setup({
      detectServers: () => {
        throw new Error('probe failed')
      }
    })
    await failing.ensureBridge()
    expect(host.logs.join('\n')).toContain('server detection failed')
  })

  it('does not fail ensureBridge when the host refuses notifications', async () => {
    host.state.hostError = new Error('no capability')
    const controller = setup()
    controller.status({ notify: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(host.logs.join('\n')).toContain('notification failed')
  })

  it('swallows a throwing worktree-change handler', () => {
    const onWorktreesChanged = vi.fn(() => {
      throw new Error('cache bug')
    })
    setup({ onWorktreesChanged })
    host.handlers.get('worktree.created')!({})
    expect(onWorktreesChanged).toHaveBeenCalled()
    expect(host.logs.join('\n')).toContain('worktree change handler failed')
  })

  it('survives a bridge whose status() or serverPids() throws', async () => {
    vi.useFakeTimers()
    const killProcess = vi.fn()
    const controller = setup({ killProcess, idleStopMs: 1000, idleCheckIntervalMs: 500 })
    await controller.ensureBridge()
    fakes.bridges[0]!.status = () => {
      throw new Error('status broke')
    }
    fakes.bridges[0]!.serverPids = () => {
      throw new Error('pids broke')
    }
    // checkIdle reads clients=0 on error and eventually stops the bridge
    await vi.advanceTimersByTimeAsync(2000)
    expect(fakes.bridges[0]!.closeCalls).toBe(1)
    controller.killServersSync() // closing/closed bridge with a throwing serverPids
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('keeps killing the other servers when one cannot be signalled', async () => {
    const killProcess = vi.fn((pid: number) => {
      if (pid === 1) throw new Error('ESRCH')
    })
    const controller = setup({ killProcess })
    await controller.ensureBridge()
    fakes.bridges[0]!.pids = [1, 2, 3]
    controller.killServersSync()
    expect(killProcess.mock.calls).toEqual([[1], [2], [3]])
  })

  it('killServersSync is a no-op while nothing runs', () => {
    const killProcess = vi.fn()
    const controller = setup({ killProcess })
    controller.killServersSync()
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('can still kill the servers of a bridge that is being closed', async () => {
    const gate = deferred()
    const killProcess = vi.fn()
    const controller = setup({ killProcess })
    await controller.ensureBridge()
    fakes.bridges[0]!.closeGate = gate.promise
    const stopping = controller.stop()
    await Promise.resolve()
    controller.killServersSync()
    expect(killProcess).toHaveBeenCalledWith(777)
    gate.resolve()
    await stopping
    killProcess.mockClear()
    controller.killServersSync()
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('deactivate is a no-op without a bridge', async () => {
    const controller = setup()
    await expect(controller.deactivate()).resolves.toBeUndefined()
  })
})

describe('idle timer', () => {
  it('does not fire while a stop is already in progress, and a stopped bridge needs no timer', async () => {
    vi.useFakeTimers()
    const gate = deferred()
    const controller = setup({ idleStopMs: 1000, idleCheckIntervalMs: 500 })
    await controller.ensureBridge()
    fakes.bridges[0]!.closeGate = gate.promise
    void controller.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fakes.bridges[0]!.closeCalls).toBe(1)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the time left until the idle stop', async () => {
    vi.useFakeTimers()
    const controller = setup({
      idleStopMs: 10_000,
      idleCheckIntervalMs: 1000,
      now: () => Date.now()
    })
    expect(controller.status().idleStopInMs).toBeNull()
    await controller.ensureBridge()
    await vi.advanceTimersByTimeAsync(4000)
    expect(controller.status().idleStopInMs).toBe(6000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(controller.status().idleStopInMs).toBeNull() // stopped by then
  })
})

describe('self-repair integration', () => {
  function fakeRepair(check?: SelfRepair['check']) {
    const report: RepairReport = {
      state: 'patched',
      action: 'none',
      message: 'ok',
      notify: false,
      dedupeKey: null
    }
    return {
      attach: vi.fn<SelfRepair['attach']>(),
      check: vi.fn<SelfRepair['check']>(check ?? (async () => report)),
      autoCheck: vi.fn<SelfRepair['autoCheck']>(),
      idle: vi.fn<SelfRepair['idle']>(async () => {}),
      status: vi.fn<SelfRepair['status']>(() => patchStatus)
    }
  }
  const patchStatus: PatchStatus = {
    state: 'patched',
    orcaVersion: '1.4.215',
    injectorVersion: '0.1.0',
    asarPath: '/opt/Orca/resources/app.asar',
    autoRepair: true,
    lastRepair: null
  }

  it('answers mlp.repairPatch with a message when self-repair is unavailable', async () => {
    const controller = setup()
    expect(await controller.repairPatch()).toEqual({
      state: 'not-found',
      action: 'none',
      message: 'Self-repair is not available.'
    })
  })

  it('runs a forced check for mlp.repairPatch and trims the report', async () => {
    vi.useFakeTimers()
    const repair = fakeRepair()
    repair.check.mockResolvedValue({
      state: 'patched',
      action: 'patched',
      message: 'done',
      notify: true,
      dedupeKey: null
    })
    const controller = setup({ selfRepair: repair })
    const timersBefore = vi.getTimerCount() // the delayed automatic check
    expect(await controller.repairPatch()).toEqual({
      state: 'patched',
      action: 'patched',
      message: 'done'
    })
    expect(repair.check).toHaveBeenCalledWith({ forced: true, trigger: 'command' })
    expect(vi.getTimerCount()).toBe(timersBefore) // the budget timer was cleared
  })

  it('answers "busy" after the budget when the repair is still running', async () => {
    vi.useFakeTimers()
    const repair = fakeRepair(() => new Promise<RepairReport>(() => {}))
    const controller = setup({ selfRepair: repair, repairCommandBudgetMs: 5000 })
    const pending = controller.repairPatch()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({
      state: 'busy',
      action: 'none',
      message: expect.stringContaining('notification will show the outcome')
    })
  })

  it('attaches, schedules the automatic check and subscribes to agent events', () => {
    vi.useFakeTimers()
    const repair = fakeRepair()
    setup({ selfRepair: repair, autoRepairDelayMs: 300 })
    expect(repair.attach).toHaveBeenCalledWith(
      expect.objectContaining({ notify: expect.any(Function), log: expect.anything() })
    )
    expect(repair.autoCheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(repair.autoCheck).toHaveBeenCalledWith('activate')
    host.handlers.get('agent.status.changed')!({})
    expect(repair.autoCheck).toHaveBeenLastCalledWith('agent.status.changed')
  })

  it('does not subscribe to events without the capability', () => {
    host = makeOrca(['notifications:show'])
    const repair = fakeRepair()
    setup({ selfRepair: repair })
    expect(host.handlers.size).toBe(0)
  })

  it('reports the patch state in mlp.status, and null when self-repair breaks', async () => {
    const repair = fakeRepair()
    const controller = setup({ selfRepair: repair })
    expect(controller.status().patch).toEqual(patchStatus)
    repair.status.mockImplementation(() => {
      throw new Error('unreadable')
    })
    expect(controller.status().patch).toBeNull()
  })

  it('lets self-repair notify through the host, only with the capability', async () => {
    const repair = fakeRepair()
    setup({ selfRepair: repair })
    const io = repair.attach.mock.calls[0]![0] as { notify(body: string): void }
    io.notify('x'.repeat(2000))
    await Promise.resolve()
    expect(host.calls).toHaveLength(1)
    expect((host.calls[0]!.params as { body: string }).body).toHaveLength(1000)

    host = makeOrca([])
    const quiet = fakeRepair()
    setup({ selfRepair: quiet })
    const quietIo = quiet.attach.mock.calls[0]![0] as { notify(body: string): void }
    quietIo.notify('hello')
    expect(host.calls).toHaveLength(0)
  })
})

describe('summarize', () => {
  const patch = (
    state: PatchStatus['state'],
    orcaVersion: string | null = '1.4.215'
  ): PatchStatus => ({
    state,
    orcaVersion,
    injectorVersion: null,
    asarPath: null,
    autoRepair: true,
    lastRepair: null
  })
  const stopped = (patchStatus: PatchStatus | null): StatusResult => ({
    running: false,
    port: null,
    protocolVersion: 1,
    pluginVersion: '0.1.0',
    hostNavigation: false,
    bridge: null,
    idleStopInMs: null,
    patch: patchStatus
  })
  const running = (overrides: Partial<StatusResult> = {}): StatusResult => ({
    ...stopped(null),
    running: true,
    port: 5000,
    hostNavigation: true,
    bridge: {
      bridgeVersion: '0.1.0',
      clients: 1,
      sessions: [
        { sessionId: 's1', serverId: 'gopls', rootPath: '/r', openDocuments: 1, state: 'running' }
      ],
      servers: { gopls: '/bin/gopls' }
    },
    ...overrides
  })

  it('says "Stopped" with and without patch information', () => {
    expect(summarize(stopped(null))).toBe(
      'Stopped. It starts automatically when an editor needs it.'
    )
    expect(summarize(stopped(patch('patched')))).toBe(
      'Stopped. It starts automatically when an editor needs it.\nEditor patch: enabled (Orca 1.4.215)'
    )
  })

  it('labels every patch state, and hides states with nothing to say', () => {
    const line = (state: PatchStatus['state'], version: string | null = '1.4.215') =>
      summarize(stopped(patch(state, version))).split('\n')[1]
    expect(line('outdated')).toContain('older injector')
    expect(line('unpatched')).toContain('not patched')
    expect(line('pending')).toContain('applied when you quit Orca')
    expect(line('unknown', null)).toBe('Editor patch: unknown')
    expect(line('not-found')).toBeUndefined()
    expect(line('not-orca')).toBeUndefined()
  })

  it('lists running details and omits the sections that are empty', () => {
    const text = summarize(running())
    expect(text).toContain('Running on 127.0.0.1:5000')
    expect(text).toContain('1 client(s), 1 server session(s)')
    expect(text).toContain('Installed: gopls')
    expect(text).not.toContain('Not found')
    expect(text).not.toContain('Orca runtime not found')
    const none = summarize(
      running({
        bridge: { ...running().bridge!, servers: { pyright: null } },
        hostNavigation: false
      })
    )
    expect(none).toContain('Installed: none')
    expect(none).toContain('Not found: pyright')
    expect(none).toContain('Orca runtime not found')
    // a running status without a bridge object is treated as stopped
    expect(summarize(running({ bridge: null }))).toContain('Stopped.')
  })
})

describe('killProcessGroup', () => {
  it('signals only the pid on Windows', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      killProcessGroup(55)
      expect(kill.mock.calls).toEqual([[55, 'SIGTERM']])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('signals the group and returns when that works', () => {
    if (process.platform === 'win32') return // the POSIX group path is not taken on Windows
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    killProcessGroup(55, 'SIGKILL')
    expect(kill.mock.calls).toEqual([[-55, 'SIGKILL']])
  })
})

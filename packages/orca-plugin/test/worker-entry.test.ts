/**
 * The worker's entry: process hooks, lazy controller creation and the real wiring
 * (bridge, runtime client, worktree roots, self-repair) behind main.ts.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcErrorCodes, PROTOCOL_VERSION } from '@mlp/protocol'
import { TestClient } from '../../lsp-bridge/test/helpers/test-client'
import type { OrcaWorkerApi } from '../src/orca-api'
import type { PluginController } from '../src/plugin-controller'
import { createEntry, installProcessHooks, type ProcessLike } from '../src/worker-entry'

class FakeProcess extends EventEmitter implements ProcessLike {
  readonly exits: number[] = []
  exit(code?: number): void {
    this.exits.push(code ?? 0)
  }
}

function fakeController() {
  const deactivation = { resolve: () => {}, promise: Promise.resolve() }
  const controller = {
    activate: vi.fn(),
    deactivate: vi.fn(() => deactivation.promise),
    killServersSync: vi.fn()
  }
  return { controller: controller as unknown as PluginController, mocks: controller, deactivation }
}

function fakeOrca(capabilities: string[] = []) {
  const commands = new Map<string, (args: unknown) => unknown>()
  const events: string[] = []
  const logs: string[] = []
  const orca: OrcaWorkerApi = {
    commands: { register: (id, handler) => void commands.set(id, handler) },
    events: { on: (event) => void events.push(event) },
    host: { call: async () => ({}) },
    grantedCapabilities: capabilities,
    log: (line) => void logs.push(line)
  }
  return { orca, commands, events, logs }
}

describe('installProcessHooks', () => {
  it('kills servers synchronously on exit and when the IPC channel drops', () => {
    const proc = new FakeProcess()
    const { controller, mocks } = fakeController()
    installProcessHooks(controller, proc)
    proc.emit('exit')
    proc.emit('disconnect')
    proc.emit('disconnect') // once: a second disconnect is not handled again
    expect(mocks.killServersSync).toHaveBeenCalledTimes(2)
  })

  it('deactivates and then exits 0 on SIGTERM', async () => {
    const proc = new FakeProcess()
    const { controller, mocks } = fakeController()
    installProcessHooks(controller, proc)
    proc.emit('SIGTERM')
    expect(mocks.deactivate).toHaveBeenCalledTimes(1)
    expect(proc.exits).toEqual([]) // not before deactivate settled
    await Promise.resolve()
    await Promise.resolve()
    expect(proc.exits).toEqual([0])
  })

  it('exits 0 even when deactivate fails', async () => {
    const proc = new FakeProcess()
    const { controller, mocks } = fakeController()
    mocks.deactivate.mockRejectedValue(new Error('close failed'))
    installProcessHooks(controller, proc)
    proc.emit('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(proc.exits).toEqual([0])
  })

  it('deactivates when the event loop drains', () => {
    const proc = new FakeProcess()
    const { controller, mocks } = fakeController()
    installProcessHooks(controller, proc)
    proc.emit('beforeExit')
    expect(mocks.deactivate).toHaveBeenCalledTimes(1)
  })
})

describe('createEntry', () => {
  it('creates the controller and the hooks once, however often activate runs', () => {
    const proc = new FakeProcess()
    const { controller, mocks } = fakeController()
    const make = vi.fn(() => controller)
    const entry = createEntry(proc, make)
    expect(make).not.toHaveBeenCalled()
    const { orca } = fakeOrca()
    entry.activate(orca)
    entry.activate(orca)
    expect(make).toHaveBeenCalledTimes(1)
    expect(mocks.activate).toHaveBeenCalledTimes(2)
    expect(proc.listenerCount('exit')).toBe(1)
    expect(proc.listenerCount('SIGTERM')).toBe(1)
  })

  it('deactivate does nothing before activation, and delegates afterwards', async () => {
    const proc = new FakeProcess()
    const { controller, mocks } = fakeController()
    const entry = createEntry(proc, () => controller)
    await entry.deactivate()
    expect(mocks.deactivate).not.toHaveBeenCalled()
    entry.activate(fakeOrca().orca)
    await entry.deactivate()
    expect(mocks.deactivate).toHaveBeenCalledTimes(1)
  })
})

describe('main.ts with the real wiring', () => {
  let userData: string
  let project: string
  const savedPath = process.env.PATH
  const savedUserData = process.env.MLP_ORCA_USER_DATA

  beforeEach(() => {
    userData = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-main-')))
    project = path.join(userData, 'project')
    process.env.MLP_ORCA_USER_DATA = userData // an empty userData: no Orca runtime to find
  })

  afterEach(() => {
    process.env.PATH = savedPath
    if (savedUserData === undefined) delete process.env.MLP_ORCA_USER_DATA
    else process.env.MLP_ORCA_USER_DATA = savedUserData
    vi.restoreAllMocks()
    vi.useRealTimers()
    rmSync(userData, { recursive: true, force: true })
  })

  it('registers the commands, serves a bridge and confines it to Orca’s worktrees', async () => {
    // main.ts hooks the real process; capture instead of installing.
    const hooks: string[] = []
    vi.spyOn(process, 'on').mockImplementation(((event: string) => {
      hooks.push(`on:${event}`)
      return process
    }) as never)
    vi.spyOn(process, 'once').mockImplementation(((event: string) => {
      hooks.push(`once:${event}`)
      return process
    }) as never)
    vi.useFakeTimers({ toFake: ['setTimeout'] }) // keeps the delayed self-repair check from firing

    const main = await import('../src/main')
    const host = fakeOrca(['events:subscribe'])
    main.default(host.orca)
    main.default(host.orca) // idempotent hooks
    expect(hooks.filter((h) => h === 'on:exit')).toHaveLength(1)
    expect(hooks).toEqual(
      expect.arrayContaining(['on:exit', 'once:disconnect', 'once:SIGTERM', 'once:beforeExit'])
    )
    expect([...host.commands.keys()].sort()).toEqual([
      'mlp.ensureBridge',
      'mlp.repairPatch',
      'mlp.restart',
      'mlp.status',
      'mlp.stop'
    ])
    expect(host.events).toEqual(
      expect.arrayContaining(['agent.status.changed', 'worktree.created', 'worktree.removed'])
    )

    const call = async <T>(id: string, args?: unknown): Promise<T> =>
      (await host.commands.get(id)!(args)) as T

    vi.useRealTimers()
    const info = await call<{ port: number; token: string; hostNavigation: boolean }>(
      'mlp.ensureBridge'
    )
    try {
      expect(info.hostNavigation).toBe(false) // no orca-runtime.json in the empty userData
      expect(info.token).toMatch(/^[0-9a-f]{64}$/)
      const client = await TestClient.connect(info.port, info.token)
      const hello = await client.hello()
      expect(hello.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(hello.hostNavigation).toBe(true) // the plugin always offers host/openLocation
      // Orca reports no worktrees, so nothing is readable or openable.
      writeFileSync(path.join(userData, 'secret.ts'), 'export {}\n')
      const refusal = await client.requestRaw('document/open', {
        uri: pathToFileURL(path.join(userData, 'secret.ts')).toString(),
        languageId: 'typescript',
        text: 'export {}\n'
      })
      expect(refusal.error?.code).toBe(JsonRpcErrorCodes.PathNotAllowed)
      const read = await client.requestRaw('fs/readFile', {
        uri: pathToFileURL(path.join(userData, 'secret.ts')).toString()
      })
      expect(read.error?.code).toBe(JsonRpcErrorCodes.PathNotAllowed)
      // Navigation obeys the same worktree boundary as reads and document opens.
      const nav = await client.requestRaw('host/openLocation', {
        uri: pathToFileURL(path.join(project, 'a.ts')).toString(),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
      })
      expect(nav.error?.code).toBe(JsonRpcErrorCodes.PathNotAllowed)
      await client.close()
      expect(
        await call<{ running: boolean; port: number }>('mlp.status', { silent: true })
      ).toMatchObject({
        running: true,
        port: info.port
      })
    } finally {
      expect(await call('mlp.stop')).toEqual({ stopped: true })
      await main.deactivate()
    }
  })
})

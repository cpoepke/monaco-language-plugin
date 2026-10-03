/**
 * Parent side of the simulated plugin worker, ported from Orca's
 * - src/main/plugins/plugin-worker-env.ts (env allowlist + ELECTRON_RUN_AS_NODE),
 * - src/main/plugins/plugin-host-process.ts (fork with `execArgv: []`, `serialization:'advanced'`,
 *   init → ready within 10 s, invokeCommand with a 30 s timeout, shutdown → 2 s → SIGKILL),
 * - plugin-worker-manager.ts / plugin-supervisor.ts (lazy start on the first command, restart
 *   after an unexpected exit with 500/2000/5000 ms backoff, at most 3 restarts),
 * - plugin-service.ts `invokeCommand` (command must be declared in the manifest and not be an
 *   action; errors reach the renderer as a rejected `ipcRenderer.invoke`).
 */
import { fork, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_WORKER_READY_TIMEOUT_MS = 10_000
export const PLUGIN_WORKER_INVOKE_TIMEOUT_MS = 30_000
const PLUGIN_WORKER_SHUTDOWN_GRACE_MS = 2_000
const RESTART_BACKOFF_MS = [500, 2_000, 5_000]
const MAX_RESTARTS = 3

const ENTRY_PATH = fileURLToPath(new URL('./plugin-host-entry.mjs', import.meta.url))

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
] as const

export function buildPluginWorkerEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = baseEnv[key]
    if (value !== undefined) env[key] = value
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export type HostCallOutcome =
  { ok: true; value: unknown } | { ok: false; code: string; error: string }

export type PluginHostOptions = {
  pluginKey: string
  /** `<userData>/plugins/<pluginKey>/<contentHash>` */
  rootDir: string
  grantedCapabilities: string[]
  /** The Orca main process env the worker env is scrubbed from. */
  mainEnv: NodeJS.ProcessEnv
  executeHostCall?: (method: string, params: unknown) => Promise<HostCallOutcome>
  log?: (level: 'info' | 'warn' | 'error', line: string) => void
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Worker = {
  child: ChildProcess
  commands: string[]
  pending: Map<number, Pending>
  exited: boolean
  disposed: boolean
  nextCallId: number
}

type Manifest = {
  main?: string
  contributes?: { commands?: { id: string; action?: unknown }[] }
}

export class SimPluginHost {
  readonly logs: { level: string; line: string }[] = []
  readonly hostCalls: { method: string; params: unknown }[] = []
  /** Pids of every worker started, in order. */
  readonly workerPids: number[] = []
  restarts = 0
  private worker: Worker | null = null
  private starting: Promise<Worker> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private state: 'inactive' | 'running' | 'restarting' | 'errored' = 'inactive'
  private disposed = false
  private readonly manifest: Manifest

  constructor(private readonly options: PluginHostOptions) {
    this.manifest = JSON.parse(
      readFileSync(path.join(options.rootDir, 'orca-plugin.json'), 'utf8')
    ) as Manifest
  }

  get pid(): number | null {
    return this.worker && !this.worker.exited ? (this.worker.child.pid ?? null) : null
  }

  /** `window.api.plugins.invokeCommand` → main `plugins:invokeCommand`. */
  async invokeCommand(commandId: string, args?: unknown): Promise<unknown> {
    const declared = this.manifest.contributes?.commands?.find((c) => c.id === commandId)
    if (!declared || declared.action !== undefined) {
      throw new Error(`plugin ${this.options.pluginKey} has no worker command ${commandId}`)
    }
    const worker = await this.ensure()
    return this.invokeOn(worker, commandId, args)
  }

  private nextEventId = 0

  /** plugin-worker-manager deliverEvent: only to a running worker, acked by the worker. */
  deliverEvent(event: string, payload: unknown): void {
    const worker = this.worker
    if (!worker || worker.exited || !worker.child.connected) return
    worker.child.send({ type: 'deliverEvent', eventId: this.nextEventId++, event, payload })
  }

  /** Simulate a crash: SIGKILL the worker (the supervisor then restarts it). */
  kill(): number | null {
    const pid = this.pid
    this.worker?.child.kill('SIGKILL')
    return pid
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const worker = this.worker ?? (await this.starting?.catch(() => null)) ?? null
    this.worker = null
    if (!worker || worker.exited) return
    worker.disposed = true
    if (worker.child.connected) worker.child.send({ type: 'shutdown' })
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(
        () => worker.child.kill('SIGKILL'),
        PLUGIN_WORKER_SHUTDOWN_GRACE_MS
      )
      worker.child.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      if (worker.exited) {
        clearTimeout(killTimer)
        resolve()
      }
    })
  }

  private ensure(): Promise<Worker> {
    if (this.disposed) return Promise.reject(new Error('plugin workers are shut down'))
    if (this.state === 'errored') {
      return Promise.reject(
        new Error(`plugin ${this.options.pluginKey} is errored after repeated failures`)
      )
    }
    if (this.worker && !this.worker.exited) return Promise.resolve(this.worker)
    if (!this.starting) {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer)
        this.restartTimer = null
      }
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private log(level: 'info' | 'warn' | 'error', line: string): void {
    this.logs.push({ level, line })
    this.options.log?.(level, line)
  }

  private start(): Promise<Worker> {
    const tag = `[plugin:${this.options.pluginKey}]`
    const child = fork(ENTRY_PATH, [], {
      env: buildPluginWorkerEnv(this.options.mainEnv),
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    if (child.pid) this.workerPids.push(child.pid)
    child.stdout?.setEncoding('utf8').on('data', (d: string) => this.log('info', d.trimEnd()))
    child.stderr?.setEncoding('utf8').on('data', (d: string) => this.log('error', d.trimEnd()))
    const worker: Worker = {
      child,
      commands: [],
      pending: new Map(),
      exited: false,
      disposed: false,
      nextCallId: 0
    }
    const rejectAll = (reason: string): void => {
      for (const [id, entry] of worker.pending) {
        clearTimeout(entry.timer)
        worker.pending.delete(id)
        entry.reject(new Error(reason))
      }
    }
    child.on('exit', (code) => {
      worker.exited = true
      rejectAll(`${tag} worker exited before responding`)
      this.handleExit(worker, code)
    })
    child.on('disconnect', () => {
      rejectAll(`${tag} worker disconnected before responding`)
      if (!worker.exited) child.kill('SIGKILL')
    })
    return new Promise<Worker>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(
          new Error(`${tag} worker did not become ready within ${PLUGIN_WORKER_READY_TIMEOUT_MS}ms`)
        )
        child.kill('SIGKILL')
      }, PLUGIN_WORKER_READY_TIMEOUT_MS)
      child.on('error', (error) => {
        fail(new Error(`${tag} worker process error: ${error.message}`))
        child.kill('SIGKILL')
      })
      child.on('exit', (code) =>
        fail(new Error(`${tag} worker exited before ready (code ${code})`))
      )
      child.on('message', (raw: unknown) => {
        const message = raw as { type?: string } & Record<string, unknown>
        switch (message?.type) {
          case 'ready':
            if (!settled) {
              settled = true
              clearTimeout(timer)
              worker.commands = message.commands as string[]
              this.worker = worker
              this.state = 'running'
              resolve(worker)
            }
            return
          case 'commandResult': {
            const entry = worker.pending.get(message.callId as number)
            if (!entry) return
            clearTimeout(entry.timer)
            worker.pending.delete(message.callId as number)
            if (message.ok) entry.resolve(message.value)
            else entry.reject(new Error((message.error as string) ?? 'plugin command failed'))
            return
          }
          case 'hostCall': {
            const method = message.method as string
            this.hostCalls.push({ method, params: message.params })
            const execute =
              this.options.executeHostCall ??
              (async (): Promise<HostCallOutcome> => ({ ok: true, value: null }))
            void execute(method, message.params).then((outcome) => {
              if (!child.connected) return
              child.send(
                outcome.ok
                  ? { type: 'hostResult', callId: message.callId, ok: true, value: outcome.value }
                  : {
                      type: 'hostResult',
                      callId: message.callId,
                      ok: false,
                      errorCode: outcome.code,
                      error: outcome.error
                    }
              )
            })
            return
          }
          case 'eventAck':
            return
          case 'log':
            this.log((message.level as 'info') ?? 'info', String(message.message))
            return
          case 'fatal':
            fail(new Error(`${tag} worker crashed: ${String(message.error)}`))
            rejectAll(`${tag} worker crashed: ${String(message.error)}`)
            child.kill('SIGKILL')
            return
          default:
            this.log('warn', 'ignoring malformed worker message')
        }
      })
      child.send({
        type: 'init',
        pluginId: this.options.pluginKey,
        pluginRoot: this.options.rootDir,
        mainEntry: this.manifest.main ?? 'dist/main.mjs',
        grantedCapabilities: [...this.options.grantedCapabilities]
      })
    })
  }

  private invokeOn(worker: Worker, commandId: string, args: unknown): Promise<unknown> {
    const tag = `[plugin:${this.options.pluginKey}]`
    if (worker.exited || worker.disposed) {
      return Promise.reject(new Error(`${tag} worker is not running`))
    }
    const callId = worker.nextCallId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(callId)
        reject(
          new Error(`${tag} ${commandId} timed out after ${PLUGIN_WORKER_INVOKE_TIMEOUT_MS}ms`)
        )
      }, PLUGIN_WORKER_INVOKE_TIMEOUT_MS)
      worker.pending.set(callId, { resolve, reject, timer })
      worker.child.send({ type: 'invokeCommand', callId, commandId, args })
    })
  }

  /** plugin-worker-manager handleUnexpectedExit + supervisor.markExited({crashed:true}). */
  private handleExit(worker: Worker, code: number | null): void {
    if (this.worker !== worker) return
    this.worker = null
    if (worker.disposed || this.disposed) {
      this.state = 'inactive'
      return
    }
    this.log('warn', `worker exited unexpectedly (code ${code})`)
    if (this.restarts >= MAX_RESTARTS) {
      this.state = 'errored'
      return
    }
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!
    this.restarts += 1
    this.state = 'restarting'
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.disposed || this.worker || this.starting) return
      this.starting = this.start().finally(() => {
        this.starting = null
      })
      this.starting.catch((error: unknown) => this.log('error', String(error)))
    }, delay)
  }
}

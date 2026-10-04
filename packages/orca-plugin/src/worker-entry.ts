import type { OrcaWorkerApi } from './orca-api'
import type { PluginController } from './plugin-controller'

/** The slice of `process` the worker entry hooks into. */
export type ProcessLike = {
  on(event: 'exit', listener: () => void): unknown
  once(event: 'disconnect' | 'beforeExit' | 'SIGTERM', listener: () => void): unknown
  exit(code?: number): unknown
}

/**
 * Why these hooks: Orca's normal stop path is the `shutdown` message, which
 * awaits our `deactivate` export (2 s before SIGKILL). If Orca instead drops
 * the IPC channel, its plugin-host-entry calls `process.exit(0)` from its own
 * `disconnect` listener before ours could run anything async, so the reliable
 * place to stop language servers is the synchronous `exit` event.
 */
export function installProcessHooks(target: PluginController, proc: ProcessLike): void {
  proc.on('exit', () => target.killServersSync())
  proc.once('disconnect', () => target.killServersSync())
  proc.once('SIGTERM', () => {
    const exit = (): void => void proc.exit(0)
    // Why not finally(): a deactivate that rejects must still end the process, quietly.
    void target.deactivate().then(exit, exit)
  })
  proc.once('beforeExit', () => {
    void target.deactivate()
  })
}

/**
 * The worker's `activate` / `deactivate` pair over one lazily created controller.
 * The controller and the process hooks are created once, however often `activate` runs.
 */
export function createEntry(proc: ProcessLike, makeController: () => PluginController) {
  let controller: PluginController | null = null
  let processHooksInstalled = false
  return {
    activate(orca: OrcaWorkerApi): void {
      controller ??= makeController()
      if (!processHooksInstalled) {
        processHooksInstalled = true
        installProcessHooks(controller, proc)
      }
      controller.activate(orca)
    },
    async deactivate(): Promise<void> {
      await controller?.deactivate()
    }
  }
}

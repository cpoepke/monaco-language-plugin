/**
 * The object Orca hands to a plugin worker's default-exported `activate`.
 * Copied from Orca's `src/main/plugins/plugin-host-runtime.ts`
 * (`PluginWorkerOrcaApi`, pluginApi 1, EXPERIMENTAL upstream). We keep our own
 * copy because Orca publishes no SDK package.
 *
 * Semantics worth knowing (same file):
 * - `activate` must settle within 10 s (PLUGIN_WORKER_READY_TIMEOUT_MS).
 * - A command handler's return value is sent back over fork() IPC with
 *   `serialization: 'advanced'` (structured clone); a throw becomes a rejected
 *   `window.api.plugins.invokeCommand` in the renderer. 30 s invoke timeout.
 * - `host.call` is capability-gated host-side and rejects with `.code` set.
 * - On `{type:'shutdown'}` the runtime awaits our `deactivate` export, then
 *   exits; Orca SIGKILLs the worker 2 s after sending shutdown.
 */

export type OrcaPluginEventName = 'worktree.created' | 'worktree.removed' | 'agent.status.changed'

export type OrcaWorkerApi = {
  commands: {
    register(commandId: string, handler: (args: unknown) => unknown): void
  }
  events: {
    on(event: OrcaPluginEventName, handler: (payload: unknown) => void | Promise<void>): void
  }
  host: {
    call(method: string, params?: unknown): Promise<unknown>
  }
  grantedCapabilities: readonly string[]
  log(message: string): void
}

/** Command ids declared in `orca-plugin.json`. */
export const COMMANDS = {
  ensureBridge: 'mlp.ensureBridge',
  status: 'mlp.status',
  restart: 'mlp.restart',
  stop: 'mlp.stop'
} as const

export const PLUGIN_DISPLAY_NAME = 'Code Navigation (LSP)'

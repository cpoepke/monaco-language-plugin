import type { OrcaRuntimeClient } from './orca-runtime-client'
import { toOrcaRelativePath } from './worktree-paths'
import { createWorktreeRoots } from './worktree-roots'
import type { WorktreeRoots } from './worktree-roots'

export { extractWorktreeRoots } from './worktree-roots'

/** Same shapes as `@mlp/lsp-bridge`'s HostNavigator; restated so this module
 *  stays importable without the bridge. */
export type NavigationTarget = { path: string; line: number; character: number }
export type NavigationResult = { opened: boolean; reason?: string }
export type HostNavigator = (target: NavigationTarget) => Promise<NavigationResult>

export type HostNavigatorOptions = {
  runtime: Pick<OrcaRuntimeClient, 'call'>
  /** Shared worktree cache; created from `runtime` when absent. */
  worktrees?: WorktreeRoots
  /** How long a `worktree.list` answer is trusted. Default 10 s. */
  cacheMs?: number
  now?: () => number
}

/**
 * Opens a file in Orca's editor via the runtime RPC. Orca can only open files
 * that live inside a worktree it manages, so the absolute path is mapped to the
 * longest matching worktree root and sent as
 * `files.open {worktree:'path:<root>', relativePath, navigation:'host'}`.
 * Roots are matched both as Orca reports them and realpath'd, since language
 * servers answer with realpaths. `navigation:'host'` makes the main window
 * switch to that worktree and focus the tab. Line/column cannot be passed
 * through Orca; the renderer injector applies the reveal itself after this
 * resolves.
 *
 * Never throws: failures become `{opened:false, reason}` so the client can fall
 * back to its own peek/preview.
 */
export function createHostNavigator(options: HostNavigatorOptions): HostNavigator {
  const worktrees =
    options.worktrees ??
    createWorktreeRoots({
      runtime: options.runtime,
      ...(options.cacheMs !== undefined ? { cacheMs: options.cacheMs } : {}),
      ...(options.now ? { now: options.now } : {})
    })

  return async (target) => {
    try {
      const match = await worktrees.resolve(target.path)
      if (!match) {
        const failure = worktrees.lastError()
        if (failure) {
          throw failure
        }
        return { opened: false, reason: 'file is outside every Orca worktree' }
      }
      const relativePath = toOrcaRelativePath(match.matchedRoot, target.path)
      if (!relativePath) {
        return { opened: false, reason: 'file path cannot be expressed relative to its worktree' }
      }
      const result = await options.runtime.call<{ opened?: unknown }>('files.open', {
        worktree: `path:${match.root}`,
        relativePath,
        navigation: 'host'
      })
      if (result?.opened === true) {
        return { opened: true }
      }
      return { opened: false, reason: 'Orca declined to open the file (binary or unsupported)' }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const message = error instanceof Error ? error.message : String(error)
      return {
        opened: false,
        reason: `Orca runtime: ${typeof code === 'string' ? `${code}: ` : ''}${message}`
      }
    }
  }
}

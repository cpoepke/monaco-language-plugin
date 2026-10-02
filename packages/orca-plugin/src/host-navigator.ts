import type { OrcaRuntimeClient } from './orca-runtime-client'
import { findWorktreeRoot, toOrcaRelativePath } from './worktree-paths'

/** Same shapes as `@mlp/lsp-bridge`'s HostNavigator; restated so this module
 *  stays importable without the bridge. */
export type NavigationTarget = { path: string; line: number; character: number }
export type NavigationResult = { opened: boolean; reason?: string }
export type HostNavigator = (target: NavigationTarget) => Promise<NavigationResult>

export type HostNavigatorOptions = {
  runtime: Pick<OrcaRuntimeClient, 'call'>
  /** How long a `worktree.list` answer is trusted. Default 10 s. */
  cacheMs?: number
  now?: () => number
}

const DEFAULT_CACHE_MS = 10_000
/** Orca's default is 200; ask for more so big setups still map. */
const WORKTREE_LIST_LIMIT = 1000

/**
 * Opens a file in Orca's editor via the runtime RPC. Orca can only open files
 * that live inside a worktree it manages, so the absolute path is mapped to the
 * longest matching worktree root and sent as
 * `files.open {worktree:'path:<root>', relativePath, navigation:'host'}`.
 * `navigation:'host'` makes the main window switch to that worktree and focus
 * the tab. Line/column cannot be passed through Orca; the renderer injector
 * applies the reveal itself after this resolves.
 *
 * Never throws: failures become `{opened:false, reason}` so the client can fall
 * back to its own peek/preview.
 */
export function createHostNavigator(options: HostNavigatorOptions): HostNavigator {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const now = options.now ?? Date.now
  let roots: string[] = []
  let fetchedAt = Number.NEGATIVE_INFINITY

  async function listRoots(): Promise<string[]> {
    const result = await options.runtime.call<unknown>('worktree.list', {
      limit: WORKTREE_LIST_LIMIT
    })
    roots = extractWorktreeRoots(result)
    fetchedAt = now()
    return roots
  }

  async function resolveRoot(file: string): Promise<string | null> {
    const fresh = now() - fetchedAt < cacheMs
    const cachedRoot = fresh ? findWorktreeRoot(file, roots) : null
    if (cachedRoot) {
      return cachedRoot
    }
    // Why: a miss may just mean the worktree was added after we cached.
    return findWorktreeRoot(file, await listRoots())
  }

  return async (target) => {
    try {
      const root = await resolveRoot(target.path)
      if (!root) {
        return { opened: false, reason: 'file is outside every Orca worktree' }
      }
      const relativePath = toOrcaRelativePath(root, target.path)
      if (!relativePath) {
        return { opened: false, reason: 'file path cannot be expressed relative to its worktree' }
      }
      const result = await options.runtime.call<{ opened?: unknown }>('files.open', {
        worktree: `path:${root}`,
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

/** `worktree.list` → `{worktrees: [{path, ...}], totalCount, truncated}`. */
export function extractWorktreeRoots(result: unknown): string[] {
  const worktrees = (result as { worktrees?: unknown } | null)?.worktrees
  if (!Array.isArray(worktrees)) {
    return []
  }
  return worktrees
    .map((worktree) => (worktree as { path?: unknown } | null)?.path)
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
}

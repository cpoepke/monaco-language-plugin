import { realpathSync } from 'node:fs'
import type { OrcaRuntimeClient } from './orca-runtime-client'
import { findWorktreeRoot } from './worktree-paths'

/**
 * Orca's worktree roots (`worktree.list`), cached. Shared by the host
 * navigator (which worktree does a file belong to?) and the bridge's dynamic
 * `allowedRoots` (which files may the bridge open and read at all?).
 *
 * Failure policy: when the runtime cannot be reached the last known roots
 * stay in effect (never more), so the bridge fails closed for everything
 * outside worktrees it already knew about.
 */
export type WorktreeRoots = {
  /** Current roots, refreshed when older than the cache window. The same
   *  array instance is returned until the list changes. */
  list(): Promise<readonly string[]>
  /** Roots for a containment check of `path`: a miss triggers one refresh
   *  (rate-limited), since the worktree may have been created just now. */
  forPath(path: string): Promise<readonly string[]>
  /** Like forPath, for navigation: always refreshes on a miss. */
  resolve(path: string): Promise<WorktreeMatch | null>
  /** Forget the cache (worktree.created / worktree.removed). */
  invalidate(): void
  /** Why the last refresh failed, or null when it succeeded. */
  lastError(): unknown
}

/** `root` is how Orca names the worktree (for `path:<root>` selectors);
 *  `matchedRoot` is the spelling of it that contains the file. */
export type WorktreeMatch = { root: string; matchedRoot: string }

export type WorktreeRootsOptions = {
  runtime: Pick<OrcaRuntimeClient, 'call'>
  /** How long a `worktree.list` answer is trusted. Default 10 s. */
  cacheMs?: number
  /** Minimum gap between containment-miss refreshes. Default 1 s. */
  missRefreshMs?: number
  now?: () => number
  realpath?: (path: string) => string | null
}

const DEFAULT_CACHE_MS = 10_000
const DEFAULT_MISS_REFRESH_MS = 1_000
/** Orca's default is 200; ask for more so big setups still map. */
const WORKTREE_LIST_LIMIT = 1000

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

export function createWorktreeRoots(options: WorktreeRootsOptions): WorktreeRoots {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const missRefreshMs = options.missRefreshMs ?? DEFAULT_MISS_REFRESH_MS
  const now = options.now ?? Date.now
  const realpath = options.realpath ?? realpathOrNull
  let roots: readonly string[] = []
  /** matched spelling → Orca's root; both the reported and the realpath form. */
  let spellings = new Map<string, string>()
  let fetchedAt = Number.NEGATIVE_INFINITY
  let inFlight: Promise<readonly string[]> | null = null
  let lastError: unknown = null

  function store(next: string[]): void {
    const nextSpellings = new Map<string, string>()
    for (const root of next) {
      nextSpellings.set(root, root)
      const real = realpath(root)
      // Why: language servers answer with realpaths (macOS /tmp → /private/tmp,
      // symlinked checkouts), so match those too and map back to Orca's name.
      if (real !== null && !nextSpellings.has(real)) {
        nextSpellings.set(real, root)
      }
    }
    const flat = [...nextSpellings.keys()]
    const unchanged = flat.length === roots.length && flat.every((root, i) => root === roots[i])
    if (!unchanged) {
      roots = flat
    }
    spellings = nextSpellings
  }

  function refresh(): Promise<readonly string[]> {
    inFlight ??= options.runtime
      .call<unknown>('worktree.list', { limit: WORKTREE_LIST_LIMIT })
      .then(
        (result) => {
          store(extractWorktreeRoots(result))
          fetchedAt = now()
          lastError = null
          return roots
        },
        // Why: keep what we knew; an unreachable runtime grants nothing new.
        // Counting the failure as a fetch keeps every open/read from waiting
        // on a dead runtime; misses still retry (rate-limited).
        (error: unknown) => {
          lastError = error
          fetchedAt = now()
          return roots
        }
      )
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  async function list(): Promise<readonly string[]> {
    return now() - fetchedAt < cacheMs ? roots : refresh()
  }

  function match(path: string): WorktreeMatch | null {
    const matchedRoot = findWorktreeRoot(path, roots) ?? (spellings.has(path) ? path : null)
    if (matchedRoot === null) {
      return null
    }
    return { root: spellings.get(matchedRoot) ?? matchedRoot, matchedRoot }
  }

  let lastMissRefreshAt = Number.NEGATIVE_INFINITY

  return {
    list,
    async forPath(path) {
      const wasFresh = now() - fetchedAt < cacheMs
      const current = await list()
      if (!wasFresh || match(path) !== null || now() - lastMissRefreshAt < missRefreshMs) {
        return current
      }
      lastMissRefreshAt = now()
      return refresh()
    },
    async resolve(path) {
      const wasFresh = now() - fetchedAt < cacheMs
      await list()
      const cached = match(path)
      if (cached || !wasFresh) {
        return cached
      }
      // Why: a miss may just mean the worktree was added after we cached.
      await refresh()
      return match(path)
    },
    invalidate() {
      fetchedAt = Number.NEGATIVE_INFINITY
    },
    lastError: () => lastError
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

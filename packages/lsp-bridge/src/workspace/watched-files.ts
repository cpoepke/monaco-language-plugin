import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BridgeLogger } from '../logger'
import { globToRegExp } from './glob'
import { isPathInside } from './path-policy'

/**
 * `workspace/didChangeWatchedFiles` for one session root. Servers such as
 * gopls and rust-analyzer do not watch the disk themselves: they register glob
 * watchers through `client/registerCapability` and rely on the client to
 * report created/changed/deleted files (a `go.mod` edit, a branch switch, an
 * agent writing files). Without this their view goes stale.
 *
 * One watcher per root, shared by every registration. Events are debounced,
 * matched against the registered globs and sent in batches.
 */

/** Never reported, never descended into: VCS data, dependencies, build output. */
export const WATCH_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  '.venv',
  '__pycache__'
])
export const MAX_CHANGES_PER_BATCH = 1000
const DEFAULT_DEBOUNCE_MS = 200
/** A steady stream of events (a build, a checkout) still flushes this often. */
const MAX_DEBOUNCE_WAIT_MS = 1000
/** Upper bound on distinct paths buffered between flushes. */
const MAX_PENDING_PATHS = 20_000
/** Linux watches every directory separately (inotify); keep that bounded. */
const MAX_WATCHED_DIRS = 10_000

/** LSP FileChangeType. */
export const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const
/** LSP WatchKind bits; a watcher without `kind` gets all three. */
const WatchKind = { Create: 1, Change: 2, Delete: 4 } as const

export type FileEvent = { uri: string; type: number }

type CompiledWatcher = { matches(path: string): boolean; kind: number }
type RawEvent = 'rename' | 'change'

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

let liveTreeWatchers = 0
/** Open OS watchers across all sessions (tests and diagnostics). */
export function activeTreeWatchers(): number {
  return liveTreeWatchers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function baseUriPath(baseUri: unknown): string | null {
  const uri = isRecord(baseUri) ? baseUri.uri : baseUri
  if (typeof uri !== 'string') {
    return null
  }
  try {
    const url = new URL(uri)
    return url.protocol === 'file:' && url.host === '' ? fileURLToPath(url) : null
  } catch {
    return null
  }
}

/** Compile `registerOptions.watchers`; unparseable entries are dropped. */
export function compileWatchers(root: string, raw: unknown): CompiledWatcher[] {
  const watchers = isRecord(raw) && Array.isArray(raw.watchers) ? raw.watchers : []
  const compiled: CompiledWatcher[] = []
  for (const watcher of watchers) {
    if (!isRecord(watcher)) {
      continue
    }
    const kind =
      typeof watcher.kind === 'number' && watcher.kind > 0
        ? watcher.kind
        : WatchKind.Create | WatchKind.Change | WatchKind.Delete
    const pattern = watcher.globPattern
    if (typeof pattern === 'string' && pattern.length > 0) {
      const regex = globToRegExp(pattern, caseInsensitive)
      // Why: servers send both absolute-style (`**/*.go`) and root-relative
      // (`go.mod`) patterns; try the absolute path and the root-relative one.
      compiled.push({
        kind,
        matches: (path) =>
          regex.test(toPosix(path)) ||
          (isPathInside(path, root) && regex.test(toPosix(relative(root, path))))
      })
    } else if (isRecord(pattern) && typeof pattern.pattern === 'string') {
      const base = baseUriPath(pattern.baseUri)
      if (base === null) {
        continue
      }
      const regex = globToRegExp(pattern.pattern, caseInsensitive)
      compiled.push({
        kind,
        matches: (path) => isPathInside(path, base) && regex.test(toPosix(relative(base, path)))
      })
    }
  }
  return compiled
}

function hasIgnoredSegment(root: string, path: string): boolean {
  const rel = relative(root, path)
  if (rel === '' || isAbsolute(rel)) {
    return rel !== ''
  }
  return rel.split(sep).some((segment) => WATCH_IGNORED_DIRS.has(segment))
}

type TreeWatch = { close(): void }

/** macOS (FSEvents) and Windows (ReadDirectoryChangesW): one native recursive watch. */
function nativeRecursiveWatch(
  root: string,
  onEvent: (path: string, event: RawEvent) => void,
  log: BridgeLogger
): TreeWatch {
  const watcher = watch(root, { recursive: true, persistent: false }, (event, filename) => {
    if (filename) {
      onEvent(join(root, filename.toString()), event)
    }
  })
  watcher.on('error', (error) => log.warn('file watcher failed', { root, error: error.message }))
  return { close: () => watcher.close() }
}

/**
 * Linux: inotify has no recursive mode, and Node 22's emulation of
 * `recursive: true` walks the whole tree synchronously and opens one watch per
 * *file*, node_modules and target/ included — seconds of blocked event loop and
 * an exhausted inotify budget on a real repository. Watch directories
 * instead, skipping the ignored ones, and pick up new directories as they
 * appear.
 */
class DirectoryTreeWatch implements TreeWatch {
  private readonly watchers = new Map<string, FSWatcher>()
  private closed = false
  private warnedCap = false

  constructor(
    private readonly root: string,
    private readonly onEvent: (path: string, event: RawEvent) => void,
    private readonly log: BridgeLogger
  ) {
    void this.addTree(root, false)
  }

  close(): void {
    this.closed = true
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }

  /** Watch `dir` and every non-ignored directory below it. For directories
   *  that appeared after start, files already inside are reported as events
   *  too: they may have been written before the watch existed. */
  private async addTree(dir: string, reportContents: boolean): Promise<void> {
    const queue = [dir]
    while (queue.length > 0 && !this.closed) {
      const current = queue.shift() as string
      if (!this.watchDirectory(current)) {
        continue
      }
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const child = join(current, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (!WATCH_IGNORED_DIRS.has(entry.name)) {
            queue.push(child)
          }
        } else if (reportContents) {
          this.onEvent(child, 'rename')
        }
      }
    }
  }

  private watchDirectory(dir: string): boolean {
    if (this.closed || this.watchers.has(dir)) {
      return false
    }
    if (this.watchers.size >= MAX_WATCHED_DIRS) {
      if (!this.warnedCap) {
        this.warnedCap = true
        this.log.warn('file watcher directory cap reached; deeper changes are not reported', {
          root: this.root,
          max: MAX_WATCHED_DIRS
        })
      }
      return false
    }
    try {
      const watcher = watch(dir, { persistent: false }, (event, filename) => {
        if (!filename) {
          return
        }
        const path = join(dir, filename.toString())
        this.onEvent(path, event)
        if (event === 'rename') {
          void this.directoryRenamed(path)
        }
      })
      watcher.on('error', () => this.unwatch(dir))
      this.watchers.set(dir, watcher)
      return true
    } catch {
      return false
    }
  }

  private async directoryRenamed(path: string): Promise<void> {
    if (WATCH_IGNORED_DIRS.has(path.slice(path.lastIndexOf(sep) + 1))) {
      return
    }
    try {
      if ((await stat(path)).isDirectory()) {
        await this.addTree(path, true)
      }
    } catch {
      this.unwatch(path)
    }
  }

  /** Drop watchers for `dir` and everything below it (it was removed). */
  private unwatch(dir: string): void {
    for (const [watched, watcher] of this.watchers) {
      if (isPathInside(watched, dir)) {
        watcher.close()
        this.watchers.delete(watched)
      }
    }
  }
}

export type WatchedFilesOptions = {
  root: string
  send: (changes: FileEvent[]) => void
  logger: BridgeLogger
  debounceMs?: number
}

export class WatchedFilesService {
  private readonly registrations = new Map<string, CompiledWatcher[]>()
  private readonly pending = new Map<string, RawEvent>()
  private tree: TreeWatch | null = null
  private timer: NodeJS.Timeout | null = null
  private firstPendingAt = 0
  private closed = false

  constructor(private readonly options: WatchedFilesOptions) {}

  /** Add a registration's watchers; starts the OS watch on first use. */
  register(id: string, registerOptions: unknown): void {
    if (this.closed) {
      return
    }
    const watchers = compileWatchers(this.options.root, registerOptions)
    if (watchers.length === 0) {
      return
    }
    this.registrations.set(id, watchers)
    this.ensureWatching()
  }

  unregister(id: string): void {
    this.registrations.delete(id)
    if (this.registrations.size === 0) {
      this.stopWatching()
    }
  }

  close(): void {
    this.closed = true
    this.registrations.clear()
    this.stopWatching()
  }

  private ensureWatching(): void {
    if (this.tree) {
      return
    }
    const { root, logger } = this.options
    const onEvent = (path: string, event: RawEvent): void => this.record(path, event)
    try {
      this.tree =
        process.platform === 'linux'
          ? new DirectoryTreeWatch(root, onEvent, logger)
          : nativeRecursiveWatch(root, onEvent, logger)
      liveTreeWatchers++
      logger.debug('watching files for language server', { root })
    } catch (error) {
      logger.warn('could not watch files', {
        root,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private stopWatching(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    if (this.tree) {
      this.tree.close()
      this.tree = null
      liveTreeWatchers--
    }
  }

  private record(path: string, event: RawEvent): void {
    if (this.closed || hasIgnoredSegment(this.options.root, path)) {
      return
    }
    if (this.pending.size >= MAX_PENDING_PATHS && !this.pending.has(path)) {
      return
    }
    // Why: a rename seen in the window decides created/deleted; a later
    // content change must not downgrade it.
    if (this.pending.get(path) !== 'rename') {
      this.pending.set(path, event)
    }
    if (this.timer) {
      if (Date.now() - this.firstPendingAt < MAX_DEBOUNCE_WAIT_MS) {
        this.timer.refresh()
      }
    } else {
      this.firstPendingAt = Date.now()
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
      this.timer.unref()
    }
  }

  private async flush(): Promise<void> {
    const batch = [...this.pending]
    this.pending.clear()
    const watchers = [...this.registrations.values()].flat()
    const changes: FileEvent[] = []
    for (const [path, event] of batch) {
      if (changes.length >= MAX_CHANGES_PER_BATCH) {
        this.options.logger.debug('watched-file batch truncated', {
          root: this.options.root,
          dropped: batch.length - changes.length
        })
        break
      }
      const matching = watchers.filter((watcher) => watcher.matches(path))
      if (matching.length === 0) {
        continue
      }
      const type = await changeType(path, event)
      if (type === null) {
        continue
      }
      const bit =
        type === FileChangeType.Created
          ? WatchKind.Create
          : type === FileChangeType.Changed
            ? WatchKind.Change
            : WatchKind.Delete
      if (matching.some((watcher) => (watcher.kind & bit) !== 0)) {
        changes.push({ uri: pathToFileURL(path).toString(), type })
      }
    }
    if (changes.length > 0 && !this.closed) {
      this.options.send(changes)
    }
  }
}

/** Map a raw event to an LSP change via an existence check: fs.watch only
 *  says "rename" (appeared or vanished) or "change". Null for noise
 *  (a directory's own metadata changing). */
async function changeType(path: string, event: RawEvent): Promise<number | null> {
  try {
    const info = await stat(path)
    if (event === 'change') {
      return info.isDirectory() ? null : FileChangeType.Changed
    }
    return FileChangeType.Created
  } catch {
    return FileChangeType.Deleted
  }
}

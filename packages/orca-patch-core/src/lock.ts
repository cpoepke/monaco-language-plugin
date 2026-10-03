import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { LOCK_SUFFIX } from './constants.js'
import { errnoCode, ExitCode, PatcherError } from './errors.js'
import { fs } from './fs.js'

/** A lock whose file was not touched for this long is considered abandoned (crashed owner). */
export const LOCK_STALE_MS = 2 * 60_000
/** While held, the owner refreshes the lock's mtime this often so long repacks never go stale. */
const LOCK_HEARTBEAT_MS = 30_000

export type LockOwner = {
  pid: number
  /** `monaco-lsp-orca` (CLI), `cpoepke.monaco-lsp` (plugin) or `apply-pending` (helper). */
  tool: string
  host: string
  createdAt: string
  token: string
}

export type PatchLock = {
  path: string
  owner: LockOwner
  /** Idempotent. Removes the lock file only while it is still ours. */
  release(): void
}

export class LockBusyError extends PatcherError {
  readonly owner: LockOwner | null
  constructor(lockPath: string, owner: LockOwner | null) {
    super(
      `Another process is patching Orca right now (${
        owner ? `${owner.tool}, pid ${owner.pid}` : 'unknown owner'
      }; lock ${lockPath}). Try again in a minute.`,
      ExitCode.Error,
      'lock-busy'
    )
    this.name = 'LockBusyError'
    this.owner = owner
  }
}

export const lockPath = (asarPath: string): string => `${asarPath}${LOCK_SUFFIX}`

export function readLockOwner(file: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockOwner>
    return typeof parsed.pid === 'number' && typeof parsed.token === 'string'
      ? (parsed as LockOwner)
      : null
  } catch {
    return null
  }
}

export type LockOptions = {
  tool: string
  staleMs?: number
  heartbeatMs?: number
  now?: () => number
}

/**
 * Take the exclusive patch lock next to app.asar (`<asar>.mlp-lock`, created with O_EXCL). A lock
 * older than `staleMs` (by mtime) is taken over. Throws LockBusyError when someone else holds it,
 * and the raw fs error (EACCES/EROFS/EPERM…) when the directory is not writable.
 */
export function acquirePatchLock(asarPath: string, options: LockOptions): PatchLock {
  const file = lockPath(asarPath)
  const now = options.now ?? Date.now
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const owner: LockOwner = {
    pid: process.pid,
    tool: options.tool,
    host: hostname(),
    createdAt: new Date(now()).toISOString(),
    token: randomBytes(8).toString('hex')
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o644 })
      return holdLock(file, owner, options.heartbeatMs ?? LOCK_HEARTBEAT_MS)
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error
    }
    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      continue // released between our open and stat: retry
    }
    if (now() - mtimeMs < staleMs) break
    // Why: the owner crashed (or was SIGKILLed by Orca's shutdown) without releasing.
    try {
      fs.rmSync(file, { force: true })
    } catch {
      break
    }
  }
  throw new LockBusyError(file, readLockOwner(file))
}

/** Like acquirePatchLock, but polls while the lock is busy (up to `waitMs`). */
export async function acquirePatchLockWait(
  asarPath: string,
  options: LockOptions & {
    waitMs: number
    pollMs?: number
    onWait?: (owner: LockOwner | null) => void
  }
): Promise<PatchLock> {
  const deadline = Date.now() + options.waitMs
  let notified = false
  for (;;) {
    try {
      return acquirePatchLock(asarPath, options)
    } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error
      if (!notified) {
        notified = true
        options.onWait?.(error.owner)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1_000))
  }
}

function holdLock(file: string, owner: LockOwner, heartbeatMs: number): PatchLock {
  let released = false
  const timer = setInterval(() => {
    try {
      const t = new Date()
      fs.utimesSync(file, t, t)
    } catch {
      // Lock removed under us; release() handles it.
    }
  }, heartbeatMs)
  timer.unref?.()
  return {
    path: file,
    owner,
    release() {
      if (released) return
      released = true
      clearInterval(timer)
      if (readLockOwner(file)?.token === owner.token) fs.rmSync(file, { force: true })
    }
  }
}

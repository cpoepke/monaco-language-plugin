// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import type { JsonRpcError } from '@mlp/protocol'
import { RpcError } from '../rpc/rpc-error'
import { encodeLspMessage, LspMessageDecoder } from './message-framing'
import type { ServerRequestReply } from './server-requests'
import type { SpawnedServer } from './server-spawn'

const STDERR_TAIL_BYTES = 4096
const SHUTDOWN_STEP_MS = 2000

/** LSP's RequestCancelled. A cancelled `lsp/request` fails with this code. */
export const REQUEST_CANCELLED = -32800

export type LspRequestOptions = {
  timeoutMs?: number
  /** Aborting sends `$/cancelRequest` and rejects with REQUEST_CANCELLED. */
  signal?: AbortSignal
}

export type LspExitInfo = {
  code: number | null
  signal: NodeJS.Signals | null
  /** Spawn/pipe error, when the process never ran or its pipes broke. */
  error?: Error
  /** True when the exit was requested through shutdown(). */
  expected: boolean
}

export type LspConnectionHandlers = {
  onNotification: (method: string, params: unknown) => void
  onServerRequest: (method: string, params: unknown) => ServerRequestReply
  onExit: (info: LspExitInfo) => void
  onStderr?: (text: string) => void
}

type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type ServerMessage = {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

function cancelledError(method: string): RpcError {
  return new RpcError(REQUEST_CANCELLED, `Request cancelled: ${method}`)
}

/** Error the language server itself returned; forwarded to clients verbatim. */
export class LspResponseError extends RpcError {}

/**
 * One language-server process: Content-Length framing over stdio, request ids
 * and timeouts, replies to server→client requests, and the
 * shutdown → exit → SIGTERM → SIGKILL ladder.
 */
export class LspConnection {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly processGroup: boolean
  private readonly pending = new Map<number, PendingRequest>()
  private readonly exitPromise: Promise<void>
  private nextRequestId = 1
  private stderrTail = ''
  private stopping = false
  private exited = false

  constructor(
    spawned: SpawnedServer,
    private readonly handlers: LspConnectionHandlers,
    private readonly defaultTimeoutMs: number
  ) {
    this.child = spawned.child
    this.processGroup = spawned.processGroup
    const decoder = new LspMessageDecoder()
    let invalidStream = false
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (invalidStream) return
      try {
        for (const message of decoder.push(chunk)) {
          this.handleMessage(message as ServerMessage)
        }
      } catch {
        invalidStream = true
        this.stderrTail = 'Invalid or oversized language-server message'
        this.rejectAllPending(new Error(this.stderrTail))
        this.signal('SIGKILL')
      }
    })
    // Why: an undrained stderr pipe blocks the server once the OS buffer fills
    // (rust-analyzer and gopls log there routinely); keep only a tail for errors.
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES)
      handlers.onStderr?.(text)
    })
    // Why: writes racing a dying process raise EPIPE on stdin; the exit handler
    // below is the single place that reacts to the process going away.
    this.child.stdin.on('error', () => {})

    this.exitPromise = new Promise((resolve) => {
      let reported = false
      const finish = (info: Omit<LspExitInfo, 'expected'>): void => {
        if (reported) {
          return
        }
        reported = true
        this.exited = true
        this.rejectAllPending(
          new RpcError(JsonRpcErrorCodes.SessionNotFound, 'Language server exited')
        )
        this.killProcessGroup('SIGTERM')
        handlers.onExit({ ...info, expected: this.stopping })
        resolve()
      }
      this.child.on('exit', (code, signal) => finish({ code, signal }))
      // Why: spawn failures (ENOENT, EACCES) emit 'error' and never 'exit'.
      this.child.on('error', (error) => {
        if (this.child.exitCode === null && this.child.pid === undefined) {
          finish({ code: null, signal: null, error })
        }
      })
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get isAlive(): boolean {
    return !this.exited
  }

  get stderr(): string {
    return this.stderrTail
  }

  request(
    method: string,
    params: unknown,
    options: number | LspRequestOptions = {}
  ): Promise<unknown> {
    const { timeoutMs = this.defaultTimeoutMs, signal } =
      typeof options === 'number' ? { timeoutMs: options } : options
    if (this.exited) {
      return Promise.reject(
        new RpcError(JsonRpcErrorCodes.SessionNotFound, 'Language server exited')
      )
    }
    if (signal?.aborted) {
      return Promise.reject(cancelledError(method))
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const abandon = (error: RpcError): void => {
        if (!this.pending.delete(id)) {
          return
        }
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        // Why: tell the server to stop working on it; a slow server answering
        // late would otherwise burn CPU on a result nobody reads.
        this.notify('$/cancelRequest', { id })
        reject(error)
      }
      const onAbort = (): void => abandon(cancelledError(method))
      const timer = setTimeout(
        () =>
          abandon(
            new RpcError(JsonRpcErrorCodes.RequestTimeout, `Language server timed out: ${method}`)
          ),
        timeoutMs
      )
      timer.unref()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(result)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Resolves once the process has exited (or never started). */
  whenExited(): Promise<void> {
    return this.exitPromise
  }

  notify(method: string, params?: unknown): void {
    this.write(
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    )
  }

  /** Graceful stop: `shutdown` request, `exit` notification, then SIGTERM and
   *  finally SIGKILL, each step waiting up to 2 s for the process to leave. */
  async shutdown(): Promise<void> {
    if (this.exited) {
      return
    }
    this.stopping = true
    try {
      await this.request('shutdown', null, SHUTDOWN_STEP_MS)
    } catch {
      // Why: a wedged server still gets `exit` and then signals.
    }
    this.notify('exit')
    if (await this.waitForExit(SHUTDOWN_STEP_MS)) {
      return
    }
    this.signal('SIGTERM')
    if (await this.waitForExit(SHUTDOWN_STEP_MS)) {
      return
    }
    this.signal('SIGKILL')
    await this.waitForExit(SHUTDOWN_STEP_MS)
  }

  /** Immediate kill without the LSP handshake (used when initialize failed). */
  kill(): void {
    this.stopping = true
    this.signal('SIGKILL')
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      void this.exitPromise.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exited) {
      return
    }
    if (!this.killProcessGroup(signal)) {
      this.child.kill(signal)
    }
  }

  /** Signal the server's whole process group; false when not applicable. */
  private killProcessGroup(signal: NodeJS.Signals): boolean {
    const pid = this.child.pid
    if (!this.processGroup || pid === undefined) {
      return false
    }
    try {
      // Why: after the leader exits, helpers it started (tsserver, typingsInstaller)
      // can linger in the group; signalling -pid reaches them without tracking pids.
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }

  private write(message: object): void {
    if (this.exited || this.child.stdin.destroyed) {
      return
    }
    this.child.stdin.write(encodeLspMessage(message))
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleMessage(message: ServerMessage): void {
    if (typeof message !== 'object' || message === null) {
      return
    }
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (typeof message.method === 'string') {
      if (hasId) {
        const reply = this.handlers.onServerRequest(message.method, message.params)
        this.write({ jsonrpc: '2.0', id: message.id, ...reply })
      } else {
        this.handlers.onNotification(message.method, message.params)
      }
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(
        new LspResponseError(
          typeof message.error.code === 'number'
            ? message.error.code
            : JsonRpcErrorCodes.InternalError,
          message.error.message ?? `Language server failed: ${pending.method}`,
          message.error.data
        )
      )
    } else {
      pending.resolve(message.result ?? null)
    }
  }
}

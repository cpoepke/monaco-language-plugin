import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'

/**
 * Minimal client for Orca's local runtime RPC, mirroring Orca's own CLI
 * (`src/cli/runtime/transport.ts`):
 * - `<userData>/orca-runtime.json` (mode 0600) names the socket/pipe and the
 *   shared auth token;
 * - one connection per request; the request is one NDJSON line
 *   `{id, authToken, method, params}\n`;
 * - the server answers with `{id, ok:true, result, _meta:{runtimeId}}` or
 *   `{id, ok:false, error:{code, message, data?}, _meta?}` and closes the
 *   socket; it may interleave `{"_keepalive":true}` frames first.
 *
 * The auth token never leaves this module: it is not logged and never appears
 * in error messages.
 */

export const RUNTIME_METADATA_FILENAME = 'orca-runtime.json'
export const DEFAULT_RUNTIME_TIMEOUT_MS = 5_000
/** Responses we expect are small; anything larger is a confused peer. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export type RuntimeTransport = { kind: 'unix' | 'named-pipe' | 'websocket'; endpoint: string }

export type RuntimeMetadata = {
  runtimeId: string
  pid: number
  authToken: string | null
  transports: RuntimeTransport[]
}

export class OrcaRuntimeError extends Error {
  readonly code: string
  readonly data?: unknown
  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'OrcaRuntimeError'
    this.code = code
    this.data = data
  }
}

export type OrcaRuntimeClient = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /** Path of the metadata file that would be used, or null (sync, cheap). */
  metadataPath(): string | null
}

export type OrcaRuntimeClientOptions = {
  /** Ordered userData directories to probe (see orca-user-data.ts). */
  userDataCandidates: () => readonly string[]
  timeoutMs?: number
}

/**
 * Errors after which a fresh `orca-runtime.json` may help: Orca rewrites it
 * (new pid, socket path, token, runtimeId) on every launch.
 */
const STALE_METADATA_CODES = new Set(['unauthorized', 'runtime_unavailable', 'runtime_changed'])

export function createOrcaRuntimeClient(options: OrcaRuntimeClientOptions): OrcaRuntimeClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS
  let cached: { file: string; metadata: RuntimeMetadata } | null = null
  let nextId = 0
  const idPrefix = `mlp-${randomBytes(4).toString('hex')}`

  function metadataPath(): string | null {
    for (const dir of options.userDataCandidates()) {
      const file = path.join(dir, RUNTIME_METADATA_FILENAME)
      if (existsSync(file)) {
        return file
      }
    }
    return null
  }

  async function loadMetadata(force: boolean): Promise<RuntimeMetadata> {
    if (cached && !force) {
      return cached.metadata
    }
    cached = null
    const file = metadataPath()
    if (!file) {
      throw new OrcaRuntimeError(
        'runtime_not_found',
        `Orca runtime metadata (${RUNTIME_METADATA_FILENAME}) not found; is Orca running?`
      )
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      throw new OrcaRuntimeError(
        'runtime_unavailable',
        `could not read ${file}: ${(error as Error).message}`
      )
    }
    const metadata = parseRuntimeMetadata(raw)
    if (!metadata) {
      throw new OrcaRuntimeError('runtime_unavailable', `unrecognised runtime metadata in ${file}`)
    }
    cached = { file, metadata }
    return metadata
  }

  async function call<T>(method: string, params?: unknown): Promise<T> {
    const metadata = await loadMetadata(false)
    try {
      return (await sendRequest(metadata, method, params ?? null)) as T
    } catch (error) {
      if (!(error instanceof OrcaRuntimeError) || !STALE_METADATA_CODES.has(error.code)) {
        throw error
      }
      // Why: Orca was probably restarted since we cached the metadata; re-read
      // it once and retry. A second failure is reported as-is.
      const fresh = await loadMetadata(true)
      return (await sendRequest(fresh, method, params ?? null)) as T
    }
  }

  function sendRequest(metadata: RuntimeMetadata, method: string, params: unknown) {
    const transport = findSocketTransport(metadata)
    if (!transport) {
      return Promise.reject(
        new OrcaRuntimeError(
          'runtime_unavailable',
          'no unix-socket/named-pipe transport in metadata'
        )
      )
    }
    const id = `${idPrefix}-${nextId++}`
    const line = `${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`
    return exchange(transport.endpoint, line, id, metadata.runtimeId, timeoutMs)
  }

  return { call, metadataPath }
}

export function parseRuntimeMetadata(raw: unknown): RuntimeMetadata | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const transports = Array.isArray(record.transports)
    ? record.transports
    : record.transport // legacy single-transport field
      ? [record.transport]
      : []
  const validTransports = transports.filter(
    (t): t is RuntimeTransport =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as RuntimeTransport).endpoint === 'string' &&
      ['unix', 'named-pipe', 'websocket'].includes((t as RuntimeTransport).kind)
  )
  if (typeof record.runtimeId !== 'string') {
    return null
  }
  return {
    runtimeId: record.runtimeId,
    pid: typeof record.pid === 'number' ? record.pid : 0,
    authToken: typeof record.authToken === 'string' ? record.authToken : null,
    transports: validTransports
  }
}

export function findSocketTransport(metadata: RuntimeMetadata): RuntimeTransport | null {
  return metadata.transports.find((t) => t.kind === 'unix' || t.kind === 'named-pipe') ?? null
}

/** One request/response over a fresh connection. */
function exchange(
  endpoint: string,
  line: string,
  id: string,
  runtimeId: string,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    let settled = false

    const finish = (error: OrcaRuntimeError | null, value?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }

    const timer = setTimeout(() => {
      finish(
        new OrcaRuntimeError(
          'runtime_timeout',
          `Orca runtime did not answer within ${timeoutMs} ms`
        )
      )
    }, timeoutMs)

    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(line))
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        new OrcaRuntimeError(
          'runtime_unavailable',
          `cannot reach the Orca runtime (${error.code ?? error.message})`
        )
      )
    })
    socket.on('close', () => {
      finish(new OrcaRuntimeError('runtime_unavailable', 'Orca runtime closed the connection'))
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(new OrcaRuntimeError('invalid_runtime_response', 'response too large'))
        return
      }
      let newline: number
      while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
        const frame = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (frame.length === 0) {
          continue
        }
        const outcome = interpretFrame(frame, id, runtimeId)
        if (outcome === 'keepalive') {
          timer.refresh()
          continue
        }
        if (outcome.ok) {
          finish(null, outcome.result)
        } else {
          finish(outcome.error)
        }
      }
    })
  })
}

type FrameOutcome =
  'keepalive' | { ok: true; result: unknown } | { ok: false; error: OrcaRuntimeError }

export function interpretFrame(frame: string, id: string, runtimeId: string): FrameOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(frame)
  } catch {
    return invalid('runtime sent a non-JSON frame')
  }
  if (typeof raw !== 'object' || raw === null) {
    return invalid('runtime sent a non-object frame')
  }
  const envelope = raw as Record<string, unknown>
  if (envelope._keepalive === true) {
    return 'keepalive'
  }
  const meta = envelope._meta as { runtimeId?: unknown } | undefined
  if (envelope.ok === false) {
    const error = envelope.error as
      { code?: unknown; message?: unknown; data?: unknown } | undefined
    const code = typeof error?.code === 'string' ? error.code : 'runtime_error'
    const message = typeof error?.message === 'string' ? error.message : 'Orca runtime error'
    return { ok: false, error: new OrcaRuntimeError(code, message, error?.data) }
  }
  if (envelope.ok !== true) {
    return invalid('runtime sent an unrecognised frame')
  }
  if (envelope.id !== id) {
    return invalid('runtime answered a different request id')
  }
  if (typeof meta?.runtimeId === 'string' && meta.runtimeId !== runtimeId) {
    return {
      ok: false,
      error: new OrcaRuntimeError(
        'runtime_changed',
        'Orca restarted while the request was in flight'
      )
    }
  }
  return { ok: true, result: envelope.result }
}

function invalid(message: string): FrameOutcome {
  return { ok: false, error: new OrcaRuntimeError('invalid_runtime_response', message) }
}

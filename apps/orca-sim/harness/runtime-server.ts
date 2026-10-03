/**
 * Fake Orca runtime RPC server, following Orca's sources:
 * - transport: src/main/runtime/rpc/unix-socket-transport.ts — NDJSON, every `\n`-terminated line
 *   is dispatched, replies are written without closing the socket, 30 s idle timeout, 1 MB frames,
 *   socket chmod 0600;
 * - admission: src/main/runtime/runtime-rpc/runtime-rpc-request-admission.ts `parseAndAuth`;
 * - envelopes: src/main/runtime/rpc/errors.ts `successResponse` / `errorResponse` with
 *   `_meta: {runtimeId}`; unknown runtime errors map to `runtime_error`;
 * - `worktree.list` ({repo?, limit?} → {worktrees, totalCount, truncated});
 * - `files.open` ({worktree, relativePath, navigation?}) → `openMobileFile`: resolve the selector,
 *   check `isSafeMobileRelativePath`, stat (ENOENT fails the RPC), fire the renderer notification
 *   without waiting for it, return {worktree:<id>, relativePath, kind, opened:true};
 * - metadata: src/main/runtime/runtime-metadata.ts → `<userData>/orca-runtime.json` (0600).
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'

const MAX_MESSAGE_BYTES = 1024 * 1024
const SOCKET_IDLE_TIMEOUT_MS = 30_000

export type Worktree = { id: string; repoId: string; path: string; displayName: string }

export type RuntimeCall = {
  method: string
  params: unknown
  at: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type OpenFileNotification = {
  worktreeId: string
  filePath: string
  relativePath: string
  navigation: string | undefined
}

export type FakeOrcaRuntimeOptions = {
  userData: string
  worktreeRoots: string[]
  /** `notifier.openFile` → renderer `ui:openFileFromMobile`. Fire-and-forget like Orca's IPC send. */
  onOpenFile: (notification: OpenFileNotification) => void
}

class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const PASSTHROUGH_CODES = new Set([
  'selector_not_found',
  'selector_ambiguous',
  'invalid_relative_path',
  'runtime_unavailable'
])

/** shared/mobile-relative-path: not absolute, no drive letter, no empty/./.. segments. */
export function isSafeMobileRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return false
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(relativePath)) return false
  return relativePath.split(/[\\/]/).every((s) => s !== '' && s !== '.' && s !== '..')
}

export class FakeOrcaRuntime {
  readonly runtimeId = `sim-${randomBytes(6).toString('hex')}`
  readonly authToken = randomBytes(24).toString('hex')
  readonly calls: RuntimeCall[] = []
  readonly endpoint: string
  readonly worktrees: Worktree[]
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: FakeOrcaRuntimeOptions) {
    // Orca: `<userData>/o-<pid>-<suffix>.sock`
    this.endpoint = path.join(
      options.userData,
      `o-${process.pid}-${randomBytes(3).toString('hex')}.sock`
    )
    this.worktrees = options.worktreeRoots.map((root, index) => {
      const repoId = `repo-${index + 1}`
      return { id: `${repoId}::${root}`, repoId, path: root, displayName: path.basename(root) }
    })
  }

  get metadataPath(): string {
    return path.join(this.options.userData, 'orca-runtime.json')
  }

  async start(): Promise<void> {
    if (existsSync(this.endpoint)) rmSync(this.endpoint, { force: true })
    const server = createServer((socket) => this.handleConnection(socket))
    server.maxConnections = 32
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(this.endpoint, 0o600)
    this.server = server
    writeFileSync(
      this.metadataPath,
      `${JSON.stringify({
        runtimeId: this.runtimeId,
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint: this.endpoint }],
        authToken: this.authToken,
        startedAt: Date.now()
      })}\n`,
      { mode: 0o600 }
    )
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    for (const socket of this.sockets) socket.destroy()
    await closed
    rmSync(this.endpoint, { force: true })
  }

  callsTo(method: string): RuntimeCall[] {
    return this.calls.filter((call) => call.method === method)
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    let bytes = 0
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_MESSAGE_BYTES) {
        socket.write(
          `${JSON.stringify(this.failure('unknown', 'request_too_large', 'RPC request exceeds the maximum size'))}\n`
        )
        socket.end()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const raw = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (raw) {
          void this.dispatch(raw).then((response) => {
            if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(response)}\n`)
          })
        }
        newline = buffer.indexOf('\n')
      }
      bytes = Buffer.byteLength(buffer, 'utf8')
    })
  }

  private async dispatch(raw: string): Promise<unknown> {
    let request: { id?: unknown; authToken?: unknown; method?: unknown; params?: unknown }
    try {
      request = JSON.parse(raw) as typeof request
    } catch {
      return this.failure('unknown', 'bad_request', 'Invalid JSON request')
    }
    if (typeof request.id !== 'string' || request.id.length === 0) {
      return this.failure('unknown', 'bad_request', 'Missing request id')
    }
    const id = request.id
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return this.failure(id, 'bad_request', 'Missing RPC method')
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return this.failure(id, 'unauthorized', 'Missing auth token')
    }
    if (request.authToken !== this.authToken) {
      return this.failure(id, 'unauthorized', 'Invalid auth token')
    }
    const call: RuntimeCall = {
      method: request.method,
      params: request.params,
      at: Date.now(),
      ok: false
    }
    this.calls.push(call)
    try {
      const result = await this.invoke(request.method, request.params)
      call.ok = true
      call.result = result
      return { id, ok: true, result, _meta: { runtimeId: this.runtimeId } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code =
        error instanceof RpcError
          ? error.code
          : PASSTHROUGH_CODES.has(message)
            ? message
            : 'runtime_error'
      call.error = { code, message }
      return this.failure(id, code, message)
    }
  }

  private async invoke(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'worktree.list':
        return this.worktreeList(params)
      case 'files.open':
        return this.filesOpen(params)
      default:
        throw new RpcError('method_not_found', `Unknown method: ${method}`)
    }
  }

  private worktreeList(params: unknown): unknown {
    const p = (params ?? {}) as { repo?: unknown; limit?: unknown }
    if (p.limit !== undefined && (typeof p.limit !== 'number' || !Number.isFinite(p.limit))) {
      throw new RpcError('invalid_argument', 'limit: Expected number')
    }
    const limit = typeof p.limit === 'number' ? p.limit : 200
    const all = this.worktrees.map((w) => ({
      id: w.id,
      repoId: w.repoId,
      path: w.path,
      branch: 'main',
      displayName: w.displayName,
      isMainWorktree: true,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path: w.path, head: '0000000', branch: 'refs/heads/main', isBare: false }
    }))
    return {
      worktrees: all.slice(0, limit),
      totalCount: all.length,
      truncated: all.length > limit
    }
  }

  private resolveWorktree(selector: string): Worktree {
    const matches = (w: Worktree): boolean => {
      if (selector.startsWith('id:')) return w.id === selector.slice(3)
      if (selector.startsWith('path:'))
        return path.resolve(w.path) === path.resolve(selector.slice(5))
      if (selector.startsWith('name:')) return w.displayName === selector.slice(5)
      return w.id === selector || w.path === selector
    }
    const found = this.worktrees.filter(matches)
    if (found.length === 0) throw new Error('selector_not_found')
    if (found.length > 1) throw new Error('selector_ambiguous')
    return found[0]!
  }

  private filesOpen(params: unknown): unknown {
    const p = (params ?? {}) as { worktree?: unknown; relativePath?: unknown; navigation?: unknown }
    if (typeof p.worktree !== 'string' || p.worktree.length === 0) {
      throw new RpcError(
        'invalid_argument',
        'worktree: Too small: expected string to have >=1 characters'
      )
    }
    if (typeof p.relativePath !== 'string' || p.relativePath.length === 0) {
      throw new RpcError(
        'invalid_argument',
        'relativePath: Too small: expected string to have >=1 characters'
      )
    }
    const navigations = ['caller', 'host', 'clients', 'all']
    if (p.navigation !== undefined && !navigations.includes(String(p.navigation))) {
      throw new RpcError('invalid_argument', 'navigation: Invalid option')
    }
    const worktree = this.resolveWorktree(p.worktree)
    const relativePath = p.relativePath
    if (!isSafeMobileRelativePath(relativePath)) throw new Error('invalid_relative_path')
    const filePath = path.join(worktree.path, ...relativePath.split('/'))
    try {
      statSync(filePath)
    } catch {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
    }
    this.options.onOpenFile({
      worktreeId: worktree.id,
      filePath,
      relativePath,
      navigation: p.navigation as string | undefined
    })
    return { worktree: worktree.id, relativePath, kind: 'text', opened: true }
  }

  private failure(id: string, code: string, message: string): unknown {
    return { id, ok: false, error: { code, message }, _meta: { runtimeId: this.runtimeId } }
  }
}

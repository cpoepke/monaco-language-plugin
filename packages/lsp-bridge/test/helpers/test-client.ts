import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { bridgeUrl, BridgeMethods, PROTOCOL_VERSION } from '@mlp/protocol'
import type {
  HelloResult,
  JsonRpcError,
  JsonRpcResponse,
  LspRequestMethod,
  OpenDocumentResult
} from '@mlp/protocol'

export class RpcResponseError extends Error {
  constructor(readonly error: JsonRpcError) {
    super(`${error.code}: ${error.message}`)
  }
  get code(): number {
    return this.error.code
  }
}

type Notification = { method: string; params: unknown }
type Waiter = { match: (message: Notification) => boolean; resolve: (n: Notification) => void }

/** Minimal JSON-RPC-over-WebSocket client mirroring what a Monaco client does. */
export class TestClient {
  readonly notifications: Notification[] = []
  private readonly responses = new Map<number | string | null, (r: JsonRpcResponse) => void>()
  private readonly waiters = new Set<Waiter>()
  private readonly unmatchedResponses: JsonRpcResponse[] = []
  private nextId = 1

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (typeof message.method === 'string') {
        const notification = { method: message.method, params: message.params }
        this.notifications.push(notification)
        for (const waiter of [...this.waiters]) {
          if (waiter.match(notification)) {
            this.waiters.delete(waiter)
            waiter.resolve(notification)
          }
        }
        return
      }
      const response = message as JsonRpcResponse
      const pending = this.responses.get(response.id)
      if (pending) {
        this.responses.delete(response.id)
        pending(response)
      } else {
        this.unmatchedResponses.push(response)
      }
    })
  }

  static connect(port: number, token: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(bridgeUrl(port, token))
      socket.once('open', () => resolve(new TestClient(socket)))
      socket.once('error', reject)
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected response ${res.statusCode}`))
      )
    })
  }

  static async connectAndHello(port: number, token: string): Promise<TestClient> {
    const client = await TestClient.connect(port, token)
    await client.hello()
    return client
  }

  hello(): Promise<HelloResult> {
    return this.request(BridgeMethods.hello, {
      protocolVersion: PROTOCOL_VERSION,
      client: 'test'
    })
  }

  requestRaw(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.responses.set(id, resolve)
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const response = await this.requestRaw(method, params)
    if (response.error) {
      throw new RpcResponseError(response.error)
    }
    return response.result as T
  }

  /** Send arbitrary text and wait for the next response that has no pending id. */
  sendRawAndWait(text: string, timeoutMs = 2000): Promise<JsonRpcResponse> {
    const before = this.unmatchedResponses.length
    this.socket.send(text)
    return pollFor(() => this.unmatchedResponses[before] ?? null, timeoutMs, 'raw response')
  }

  notify(method: string, params: unknown): void {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  openDocument(path: string, languageId: string, text?: string): Promise<OpenDocumentResult> {
    return this.request(BridgeMethods.openDocument, {
      uri: pathToFileURL(path).toString(),
      languageId,
      text: text ?? readFileSync(path, 'utf8')
    })
  }

  lsp<T>(sessionId: string, method: LspRequestMethod, params: unknown): Promise<T> {
    return this.request(BridgeMethods.lspRequest, { sessionId, method, params })
  }

  waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean = () => true,
    timeoutMs = 5000
  ): Promise<Notification> {
    const match = (n: Notification): boolean => n.method === method && predicate(n.params)
    const existing = this.notifications.find(match)
    if (existing) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (n) => {
          clearTimeout(timer)
          resolve(n)
        }
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }
}

export async function pollFor<T>(
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  what: string,
  intervalMs = 25
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== null && value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (process.platform === 'linux') {
    // Why: an orphan reparented to a container's PID 1 may never be reaped; a
    // zombie has exited and holds no resources, so it counts as gone.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return fields[0] !== 'Z'
    } catch {
      return false
    }
  }
  return true
}

/** Linux-only: every descendant pid of `pid` (via /proc), for orphan checks. */
export function descendantPids(pid: number): number[] {
  if (process.platform !== 'linux') {
    return []
  }
  const childrenOf = (parent: number): number[] => {
    try {
      const text = readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8').trim()
      return text ? text.split(/\s+/).map(Number) : []
    } catch {
      return []
    }
  }
  const out: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const next = queue.shift() as number
    for (const child of childrenOf(next)) {
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

export const FAKE_SERVER_PATH = fileURLToPath(
  new URL('../fixtures/fake-lsp-server.mjs', import.meta.url)
)

import {
  BridgeMethods,
  JsonRpcErrorCodes,
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type JsonRpcError,
  type JsonRpcId
} from '@mlp/protocol'
import type { Logger } from './logger'

/** The subset of the WHATWG WebSocket API the client uses (browser, Node ≥ 22, `ws`). */
export type WebSocketLike = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike

export type ReconnectOptions = {
  /** Delay before the first reconnect attempt. Default 500 ms. */
  initialDelayMs?: number
  /** Upper bound for the exponential backoff. Default 10 s. */
  maxDelayMs?: number
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'disposed'

/** Client-side error codes (outside the JSON-RPC reserved range used by the bridge). */
export const ClientErrorCodes = {
  NotConnected: -32900,
  Timeout: -32901,
  ConnectionClosed: -32902
} as const

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: RpcError) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** A fixed URL, or a function resolved before every (re)connect. */
export type BridgeUrlSource = string | (() => string | Promise<string>)

export type BridgeConnectionOptions = {
  url: BridgeUrlSource
  clientName: string
  createWebSocket?: WebSocketFactory
  reconnect?: ReconnectOptions | false
  requestTimeoutMs?: number
  logger: Logger
}

const OPEN = 1

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!Ctor) {
    throw new Error('No global WebSocket; pass `createWebSocket` to createMonacoLspClient')
  }
  return new Ctor(url)
}

/**
 * JSON-RPC 2.0 over one WebSocket (one message per text frame) with the
 * `bridge/hello` handshake and exponential-backoff reconnect.
 */
export class BridgeConnection {
  private socket: WebSocketLike | null = null
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private urlAttempt = 0
  private stateValue: ConnectionState = 'disconnected'
  private helloValue: HelloResult | null = null
  private lastErrorValue: string | null = null
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>()
  private readonly connectHandlers = new Set<(hello: HelloResult) => void>()
  private readonly disconnectHandlers = new Set<(reason: string) => void>()
  private readonly stateHandlers = new Set<() => void>()
  private readonly createWebSocket: WebSocketFactory

  constructor(private readonly options: BridgeConnectionOptions) {
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory
  }

  get state(): ConnectionState {
    return this.stateValue
  }

  get hello(): HelloResult | null {
    return this.helloValue
  }

  get lastError(): string | null {
    return this.lastErrorValue
  }

  get isConnected(): boolean {
    return this.stateValue === 'connected'
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onConnect(handler: (hello: HelloResult) => void): () => void {
    this.connectHandlers.add(handler)
    return () => this.connectHandlers.delete(handler)
  }

  onDisconnect(handler: (reason: string) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  onStateChange(handler: () => void): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  start(): void {
    if (this.stateValue !== 'disconnected' || this.socket || this.reconnectTimer !== null) {
      return
    }
    this.connect()
  }

  /** Sends a request once connected (after hello). Rejects with RpcError. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.isConnected) {
      return Promise.reject(
        new RpcError(ClientErrorCodes.NotConnected, `Not connected to the bridge (${method})`)
      )
    }
    return this.sendRequest<T>(method, params, timeoutMs)
  }

  /** Sends a notification; returns false (and drops it) when not connected. */
  notify(method: string, params?: unknown): boolean {
    if (!this.isConnected) {
      return false
    }
    return this.sendRaw({ jsonrpc: '2.0', method, params })
  }

  dispose(): void {
    if (this.stateValue === 'disposed') {
      return
    }
    this.setState('disposed')
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    this.rejectAll(new RpcError(ClientErrorCodes.ConnectionClosed, 'Client disposed'))
    if (socket) {
      detach(socket)
      try {
        socket.close(1000, 'client disposed')
      } catch {
        // Already closed.
      }
    }
    this.notificationHandlers.clear()
    this.connectHandlers.clear()
    this.disconnectHandlers.clear()
    this.stateHandlers.clear()
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) {
      return
    }
    this.stateValue = state
    for (const handler of [...this.stateHandlers]) {
      safeCall(() => handler(), this.options.logger)
    }
  }

  private connect(): void {
    this.setState('connecting')
    const source = this.options.url
    if (typeof source === 'string') {
      this.open(source)
      return
    }
    // Why: hosts whose bridge port/token can change hand us a resolver instead of a URL.
    const attempt = ++this.urlAttempt
    Promise.resolve()
      .then(source)
      .then(
        (url) => {
          if (attempt === this.urlAttempt && this.stateValue === 'connecting') {
            this.open(url)
          }
        },
        (error: unknown) => {
          if (attempt !== this.urlAttempt || this.stateValue !== 'connecting') {
            return
          }
          this.lastErrorValue = `cannot resolve bridge URL: ${errorMessage(error)}`
          this.options.logger.warn?.(`[mlp] ${this.lastErrorValue}`)
          this.scheduleReconnect()
        }
      )
  }

  private open(url: string): void {
    let socket: WebSocketLike
    try {
      socket = this.createWebSocket(url)
    } catch (error) {
      this.lastErrorValue = errorMessage(error)
      this.options.logger.warn?.(`[mlp] cannot create WebSocket: ${this.lastErrorValue}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) {
        return
      }
      void this.handshake(socket)
    }
    socket.onmessage = (event) => {
      if (this.socket === socket) {
        this.handleMessage(event.data)
      }
    }
    socket.onerror = () => {
      if (this.socket !== socket) {
        return
      }
      this.lastErrorValue = 'WebSocket error'
      // Why: some implementations (Node's undici) report a refused connection with
      // `error` only and never fire `close`; treat a failed handshake as closed.
      if (socket.readyState !== OPEN) {
        try {
          socket.close()
        } catch {
          // ignore
        }
        this.handleClose('connection failed')
      }
    }
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.handleClose(event?.reason || `closed (${event?.code ?? 'unknown'})`)
      }
    }
  }

  private async handshake(socket: WebSocketLike): Promise<void> {
    const params: HelloParams = {
      protocolVersion: PROTOCOL_VERSION,
      client: this.options.clientName
    }
    try {
      const hello = await this.sendRequest<HelloResult>(BridgeMethods.hello, params)
      if (this.socket !== socket) {
        return
      }
      if (hello?.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `protocol mismatch: bridge speaks v${String(hello?.protocolVersion)}, client v${PROTOCOL_VERSION}`
        )
      }
      this.helloValue = hello
      this.lastErrorValue = null
      this.attempt = 0
      this.setState('connected')
      for (const handler of [...this.connectHandlers]) {
        safeCall(() => handler(hello), this.options.logger)
      }
    } catch (error) {
      if (this.socket !== socket) {
        return
      }
      this.lastErrorValue = `hello failed: ${errorMessage(error)}`
      this.options.logger.warn?.(`[mlp] ${this.lastErrorValue}`)
      try {
        socket.close(1002, 'hello failed')
      } catch {
        // ignore
      }
      this.handleClose(this.lastErrorValue)
    }
  }

  private handleClose(reason: string): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      detach(socket)
    }
    const wasConnected = this.stateValue === 'connected'
    this.rejectAll(new RpcError(ClientErrorCodes.ConnectionClosed, `Connection closed: ${reason}`))
    if (this.stateValue === 'disposed') {
      return
    }
    if (!this.lastErrorValue || wasConnected) {
      this.lastErrorValue = reason
    }
    this.setState('disconnected')
    if (wasConnected) {
      for (const handler of [...this.disconnectHandlers]) {
        safeCall(() => handler(reason), this.options.logger)
      }
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stateValue === 'disposed' || this.options.reconnect === false) {
      this.setState(this.stateValue === 'disposed' ? 'disposed' : 'disconnected')
      return
    }
    this.setState('disconnected')
    const initial = this.options.reconnect?.initialDelayMs ?? 500
    const max = this.options.reconnect?.maxDelayMs ?? 10_000
    const delay = Math.min(max, initial * 2 ** this.attempt)
    this.attempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stateValue !== 'disposed') {
        this.connect()
      }
    }, delay)
  }

  private sendRequest<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer:
          timeout > 0
            ? setTimeout(() => {
                this.pending.delete(id)
                reject(new RpcError(ClientErrorCodes.Timeout, `${method} timed out`))
              }, timeout)
            : null
      }
      this.pending.set(id, entry)
      if (!this.sendRaw({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id)
        if (entry.timer !== null) {
          clearTimeout(entry.timer)
        }
        reject(new RpcError(ClientErrorCodes.NotConnected, `Cannot send ${method}`))
      }
    })
  }

  private sendRaw(message: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) {
      return false
    }
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch (error) {
      this.options.logger.warn?.(`[mlp] send failed: ${errorMessage(error)}`)
      return false
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data) as Record<string, unknown>
    } catch {
      this.options.logger.warn?.('[mlp] dropped a non-JSON frame from the bridge')
      return
    }
    if (!message || typeof message !== 'object') {
      return
    }
    const id = message.id as JsonRpcId | undefined | null
    const method = typeof message.method === 'string' ? message.method : null
    if (method !== null) {
      if (id !== undefined && id !== null) {
        // Why: the contract defines no bridge → client requests; answer instead of hanging the peer.
        this.sendRaw({
          jsonrpc: '2.0',
          id,
          error: { code: JsonRpcErrorCodes.MethodNotFound, message: `Unknown method ${method}` }
        })
        return
      }
      for (const handler of [...this.notificationHandlers]) {
        safeCall(() => handler(method, message.params), this.options.logger)
      }
      return
    }
    if (id === undefined || id === null) {
      return
    }
    const entry = this.pending.get(id)
    if (!entry) {
      return
    }
    this.pending.delete(id)
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
    }
    const error = message.error as JsonRpcError | undefined
    if (error) {
      entry.reject(new RpcError(error.code, error.message, error.data))
    } else {
      entry.resolve(message.result ?? null)
    }
  }

  private rejectAll(error: RpcError): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer)
      }
      entry.reject(error)
    }
  }
}

function detach(socket: WebSocketLike): void {
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = null
  socket.onclose = null
}

function safeCall(run: () => void, logger: Logger): void {
  try {
    run()
  } catch (error) {
    logger.error?.(`[mlp] listener failed: ${errorMessage(error)}`)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

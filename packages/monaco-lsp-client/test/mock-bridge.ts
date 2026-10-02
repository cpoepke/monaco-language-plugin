/** A scripted JSON-RPC peer on a real `ws` server, standing in for the bridge. */
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { PROTOCOL_VERSION, bridgeUrl, type HelloResult } from '@mlp/protocol'

export type Received = { method: string; params: unknown; id?: number | string; connection: number }

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

type Handler = (params: unknown, connection: number) => unknown

export class MockBridge {
  readonly received: Received[] = []
  readonly handlers = new Map<string, Handler>()
  private readonly sockets = new Set<WebSocket>()
  private connections = 0
  private sessionCounter = 0
  hello: HelloResult = {
    protocolVersion: PROTOCOL_VERSION,
    bridgeVersion: 'mock',
    availableLanguages: ['typescript', 'python'],
    hostNavigation: false
  }

  private constructor(
    private readonly server: WebSocketServer,
    readonly url: string
  ) {
    server.on('connection', (socket) => this.accept(socket))
    this.handlers.set('bridge/hello', () => this.hello)
    this.handlers.set('document/open', (params) => {
      const { uri, languageId } = params as { uri: string; languageId: string }
      if (languageId === 'plaintext') {
        return { sessionId: null, reason: 'unsupported language' }
      }
      return {
        sessionId: `s-${languageId}-${this.connections}`,
        uri,
        serverId: `${languageId}-server`,
        rootPath: '/repo',
        pullDiagnostics: false
      }
    })
    this.handlers.set('lsp/request', () => null)
    this.handlers.set('fs/readFile', (params) => ({
      uri: (params as { uri: string }).uri,
      text: `// contents of ${(params as { uri: string }).uri}\n`,
      languageId: 'typescript'
    }))
  }

  static async start(): Promise<MockBridge> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    return new MockBridge(server, bridgeUrl(port, 'test-token'))
  }

  get connectionCount(): number {
    return this.connections
  }

  messages(method: string): Received[] {
    return this.received.filter((message) => message.method === method)
  }

  notify(method: string, params: unknown): void {
    for (const socket of this.sockets) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
    }
  }

  /** Drops every client connection (simulates a bridge restart). */
  dropConnections(): void {
    for (const socket of this.sockets) {
      socket.terminate()
    }
    this.sockets.clear()
  }

  async close(): Promise<void> {
    this.dropConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  nextSessionId(): string {
    return `fresh-${++this.sessionCounter}`
  }

  private accept(socket: WebSocket): void {
    const connection = ++this.connections
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('message', async (data) => {
      const message = JSON.parse(String(data)) as {
        id?: number | string
        method?: string
        params?: unknown
      }
      if (!message.method) {
        return
      }
      this.received.push({
        method: message.method,
        params: message.params,
        id: message.id,
        connection
      })
      if (message.id === undefined) {
        return
      }
      const handler = this.handlers.get(message.method)
      try {
        if (!handler) {
          throw new RpcFailure(-32601, `no handler for ${message.method}`)
        }
        const result = await handler(message.params, connection)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
      } catch (error) {
        const failure = error instanceof RpcFailure ? error : new RpcFailure(-32603, String(error))
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: failure.code, message: failure.message }
          })
        )
      }
    })
  }
}

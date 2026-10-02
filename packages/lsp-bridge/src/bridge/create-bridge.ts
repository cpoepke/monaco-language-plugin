import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import type { BridgeStatus } from '@mlp/protocol'
import { resolveAllServers } from '../lsp/server-catalog'
import type { ServerResolutionContext } from '../lsp/server-catalog'
import { JsonRpcPeer } from '../rpc/json-rpc-peer'
import { SessionManager } from '../sessions/session-manager'
import type { ClientId } from '../sessions/session-types'
import { BRIDGE_VERSION } from '../version'
import { tokensEqual } from './auth'
import { normalizeBridgeOptions } from './bridge-options'
import type { BridgeOptions } from './bridge-options'
import { createClientHandlers } from './client-handlers'
import type { BridgeContext, ClientState } from './client-handlers'

export type Bridge = {
  /** Start listening. Resolves with the bound port (useful with port 0). */
  listen(): Promise<{ port: number }>
  /** Disconnect clients, stop every language server, stop listening. */
  close(): Promise<void>
  status(): BridgeStatus
  /** Pids of running language-server processes (diagnostics and tests). */
  serverPids(): number[]
}

type ConnectedClient = { state: ClientState; socket: WebSocket; peer: JsonRpcPeer }

const CLOSE_GRACE_MS = 1000

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export function createBridge(bridgeOptions: BridgeOptions): Bridge {
  const options = normalizeBridgeOptions(bridgeOptions)
  const log = options.logger
  const clients = new Map<ClientId, ConnectedClient>()
  let nextClientId = 1
  let httpServer: Server | null = null
  let closing: Promise<void> | null = null

  const sessions = new SessionManager({
    requestTimeoutMs: options.requestTimeoutMs,
    idleShutdownMs: options.idleShutdownMs,
    maxSessions: options.maxSessions,
    logger: log,
    notifyClient: (clientId, method, params) => clients.get(clientId)?.peer.notify(method, params)
  })

  const resolution: ServerResolutionContext = { overrides: options.serverOverrides }

  function status(): BridgeStatus {
    return {
      bridgeVersion: BRIDGE_VERSION,
      clients: clients.size,
      sessions: sessions.status(),
      servers: resolveAllServers(resolution)
    }
  }

  const context: BridgeContext = { options, sessions, resolution, status }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxMessageBytes,
    // Why: compression buys nothing on loopback and costs CPU + zip-bomb risk.
    perMessageDeflate: false
  })

  function onConnection(socket: WebSocket): void {
    const state: ClientState = {
      id: nextClientId++,
      greeted: false,
      closed: false,
      usedRoots: new Set()
    }
    const handlers = createClientHandlers(context, state)
    const peer = new JsonRpcPeer({
      send: (text) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(text)
        }
      },
      onRequest: handlers.onRequest,
      onNotification: handlers.onNotification,
      onInternalError: (error, method) =>
        log.error('handler failed', {
          clientId: state.id,
          method,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error)
        })
    })
    clients.set(state.id, { state, socket, peer })

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: JsonRpcErrorCodes.InvalidRequest,
              message: 'Binary frames are not supported'
            }
          })
        )
        return
      }
      void peer.handleText(data.toString())
    })
    socket.on('close', () => {
      state.closed = true
      peer.close()
      clients.delete(state.id)
      sessions.releaseClient(state.id)
      log.debug('client disconnected', { clientId: state.id })
    })
    // Why: oversize frames and protocol violations surface here; ws closes the
    // socket itself afterwards, so logging is all that's left to do.
    socket.on('error', (error) =>
      log.warn('client socket error', { clientId: state.id, error: error.message })
    )
  }

  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {})
    if (closing) {
      rejectUpgrade(socket, '503 Service Unavailable')
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!tokensEqual(options.token, url.searchParams.get('token'))) {
      log.warn('rejected connection with a bad token', { remote: request.socket.remoteAddress })
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    wss.handleUpgrade(request, socket, head, onConnection)
  }

  async function listen(): Promise<{ port: number }> {
    if (httpServer) {
      throw new Error('bridge is already listening')
    }
    const server = createServer((_request, response) => {
      // Why: plain HTTP has nothing to serve; say so without revealing more.
      response.writeHead(426, { Connection: 'close', 'Content-Type': 'text/plain' })
      response.end('WebSocket upgrade required\n')
    })
    server.on('upgrade', onUpgrade)
    httpServer = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : options.port
    log.info('listening', { host: options.host, port })
    return { port }
  }

  async function shutdown(): Promise<void> {
    for (const { socket } of clients.values()) {
      socket.close(1001, 'bridge shutting down')
    }
    await sessions.closeAll()
    // Why: give close frames a moment, then cut sockets that never answered.
    const deadline = Date.now() + CLOSE_GRACE_MS
    while (clients.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    for (const { socket } of clients.values()) {
      socket.terminate()
    }
    wss.close()
    const server = httpServer
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    log.info('bridge closed')
  }

  return {
    listen,
    close: () => {
      closing ??= shutdown()
      return closing
    },
    status,
    serverPids: () => sessions.pids()
  }
}

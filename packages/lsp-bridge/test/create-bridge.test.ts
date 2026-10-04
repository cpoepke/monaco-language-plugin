/** Edges of the bridge's HTTP/WebSocket front: plain HTTP, binary frames, shutdown races, internal errors. */
import { createServer, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { JsonRpcErrorCodes, PROTOCOL_VERSION, bridgeUrl } from '@mlp/protocol'
import { createBridge, type Bridge } from '../src/bridge/create-bridge'
import { silentLogger, type BridgeLogger } from '../src/logger'
import { TestClient, pollFor } from './helpers/test-client'

const TOKEN = 'secret-token'
const bridges: Bridge[] = []
const sockets: Socket[] = []

function make(logger: BridgeLogger = silentLogger, port = 0): Bridge {
  const bridge = createBridge({ port, token: TOKEN, logger })
  bridges.push(bridge)
  return bridge
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const bridge of bridges.splice(0)) await bridge.close()
})

/** A WebSocket handshake by hand, so the client can stay silent when the server says "close". */
function rawUpgrade(port: number, token = TOKEN): Promise<{ socket: Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    sockets.push(socket)
    let received = ''
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      const end = received.indexOf('\r\n\r\n')
      if (end !== -1) {
        socket.removeAllListeners('data')
        resolve({ socket, status: Number(received.split(' ')[1]) })
      }
    })
    socket.on('connect', () => {
      socket.write(
        `GET /?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
      )
    })
  })
}

describe('plain HTTP', () => {
  it('answers 426 and reveals nothing else', async () => {
    const { port } = await make().listen()
    const response = await new Promise<{
      status: number
      body: string
      headers: Record<string, unknown>
    }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: `/?token=${TOKEN}` }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(response.status).toBe(426)
    expect(response.body).toBe('WebSocket upgrade required\n')
    expect(response.headers['content-type']).toBe('text/plain')
    expect(JSON.stringify(response.headers)).not.toMatch(/express|node|server/i)
  })
})

describe('frames', () => {
  it('refuses binary frames with InvalidRequest and keeps the connection', async () => {
    const { port } = await make().listen()
    const client = await TestClient.connectAndHello(port, TOKEN)
    const reply = new Promise<Record<string, unknown>>((resolve) =>
      client.socket.once('message', (data) => resolve(JSON.parse(data.toString())))
    )
    client.socket.send(Buffer.from([1, 2, 3]), { binary: true })
    expect(await reply).toMatchObject({
      id: null,
      error: { code: JsonRpcErrorCodes.InvalidRequest, message: 'Binary frames are not supported' }
    })
    expect((await client.hello()).protocolVersion).toBe(PROTOCOL_VERSION)
    await client.close()
  })

  it('logs and answers InternalError when a handler throws something that is not an RpcError', async () => {
    const error = vi.fn()
    const logger: BridgeLogger = {
      ...silentLogger,
      error,
      info: (message) => {
        if (message === 'client connected') {
          throw new Error('logger exploded')
        }
      }
    }
    const { port } = await make(logger).listen()
    const client = await TestClient.connect(port, TOKEN)
    const response = await client.requestRaw('bridge/hello', {
      protocolVersion: PROTOCOL_VERSION,
      client: 'x'
    })
    expect(response.error).toMatchObject({
      code: JsonRpcErrorCodes.InternalError,
      message: 'logger exploded'
    })
    expect(error).toHaveBeenCalledWith(
      'handler failed',
      expect.objectContaining({
        method: 'bridge/hello',
        error: expect.stringContaining('logger exploded')
      })
    )
    await client.close()
  })
})

describe('listening', () => {
  it('refuses to listen twice', async () => {
    const bridge = make()
    await bridge.listen()
    await expect(bridge.listen()).rejects.toThrow('bridge is already listening')
  })

  it('can listen again after the port turned out to be taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as { port: number }
    const bridge = make(silentLogger, port)
    await expect(bridge.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await new Promise((resolve) => blocker.close(resolve))
    expect(await bridge.listen()).toEqual({ port })
    const client = await TestClient.connectAndHello(port, TOKEN)
    await client.close()
  })

  it('closes cleanly even when it never listened, and closing twice is fine', async () => {
    const bridge = make()
    await bridge.close()
    await bridge.close()
  })

  it('reports clients and the resolved servers in status()', async () => {
    const bridge = make()
    const { port } = await bridge.listen()
    expect(bridge.status().clients).toBe(0)
    const client = await TestClient.connectAndHello(port, TOKEN)
    expect(bridge.status().clients).toBe(1)
    expect(Object.keys(bridge.status().servers)).toContain('typescript-language-server')
    expect(bridge.serverPids()).toEqual([])
    await client.close()
    await pollFor(() => (bridge.status().clients === 0 ? true : null), 3000, 'client to leave')
  })
})

describe('shutdown', () => {
  it('turns away new connections while closing, and cuts a client that ignores the close frame', async () => {
    const bridge = make()
    const { port } = await bridge.listen()
    const silent = await rawUpgrade(port)
    expect(silent.status).toBe(101)
    await pollFor(() => (bridge.status().clients === 1 ? true : null), 3000, 'client to connect')

    const startedAt = Date.now()
    const closing = bridge.close()
    // The silent client never answers the close frame, so the bridge keeps listening for its grace period.
    const during = await rawUpgrade(port).catch(() => ({ status: 0 }))
    expect(during.status).toBe(503)
    await closing
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
    await pollFor(() => (bridge.status().clients === 0 ? true : null), 3000, 'client to be dropped')
    // the port is closed afterwards
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(bridgeUrl(port, TOKEN))
        socket.once('open', () => reject(new Error('still accepting')))
        socket.once('error', resolve)
      })
    ).resolves.toBeDefined()
  })

  it('closes quickly when clients answer the close frame', async () => {
    const bridge = make()
    const { port } = await bridge.listen()
    const client = await TestClient.connectAndHello(port, TOKEN)
    const closed = new Promise((resolve) => client.socket.once('close', (code) => resolve(code)))
    const startedAt = Date.now()
    await bridge.close()
    expect(await closed).toBe(1001)
    expect(Date.now() - startedAt).toBeLessThan(900)
  })
})

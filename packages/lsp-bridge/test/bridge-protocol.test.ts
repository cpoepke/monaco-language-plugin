import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { BridgeMethods, bridgeUrl, JsonRpcErrorCodes, PROTOCOL_VERSION } from '@mlp/protocol'
import type { BridgeStatus, OpenLocationResult } from '@mlp/protocol'
import { createBridge } from '../src/index'
import type { Bridge, BridgeOptions, HostNavigationTarget } from '../src/index'
import { FAKE_SERVER_PATH, RpcResponseError, TestClient } from './helpers/test-client'

const TOKEN = 'protocol-test-token'
let workspace: string
let outsideDir: string
const bridges: Bridge[] = []
const clients: TestClient[] = []

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mlp-protocol-')))
  workspace = join(base, 'ws')
  outsideDir = join(base, 'outside')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(outsideDir)
  writeFileSync(join(workspace, 'package.json'), '{}')
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(outsideDir, 'b.ts'), 'export const b = 2\n')
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(bridges.splice(0).map((b) => b.close()))
})

afterAll(() => rmSync(join(workspace, '..'), { recursive: true, force: true }))

async function startBridge(
  overrides: Partial<BridgeOptions> = {}
): Promise<{ bridge: Bridge; port: number }> {
  const bridge = createBridge({
    port: 0,
    token: TOKEN,
    serverOverrides: {
      'typescript-language-server': { command: process.execPath, args: [FAKE_SERVER_PATH] }
    },
    ...overrides
  })
  bridges.push(bridge)
  const { port } = await bridge.listen()
  return { bridge, port }
}

async function connect(port: number, hello = true): Promise<TestClient> {
  const client = hello
    ? await TestClient.connectAndHello(port, TOKEN)
    : await TestClient.connect(port, TOKEN)
  clients.push(client)
  return client
}

function upgradeStatus(port: number, token: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const path = token === null ? '/' : `/?token=${encodeURIComponent(token)}`
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
      }
    })
    req.on('response', (res) => resolve(res.statusCode ?? 0))
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

async function expectRpcError(promise: Promise<unknown>, code: number): Promise<RpcResponseError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RpcResponseError)
    expect((error as RpcResponseError).code).toBe(code)
    return error as RpcResponseError
  }
  throw new Error(`expected error ${code}`)
}

describe('authentication', () => {
  it('rejects upgrades without the right token with 401', async () => {
    const { port } = await startBridge()
    expect(await upgradeStatus(port, null)).toBe(401)
    expect(await upgradeStatus(port, 'wrong')).toBe(401)
    expect(await upgradeStatus(port, `${TOKEN}x`)).toBe(401)
    expect(await upgradeStatus(port, TOKEN)).toBe(101)
    await expect(TestClient.connect(port, 'wrong')).rejects.toThrow(/401/)
  })

  it('answers plain HTTP with 426 and refuses non-loopback hosts', async () => {
    const { port } = await startBridge()
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/' }, (res) => resolve(res.statusCode ?? 0))
        .on('error', reject)
        .end()
    })
    expect(status).toBe(426)
    expect(() => createBridge({ port: 0, token: TOKEN, host: '0.0.0.0' })).toThrow(/non-loopback/)
  })
})

describe('JSON-RPC handling', () => {
  it('requires bridge/hello first and checks the protocol version', async () => {
    const { port } = await startBridge()
    const client = await connect(port, false)
    await expectRpcError(client.request(BridgeMethods.status), JsonRpcErrorCodes.InvalidRequest)
    await expectRpcError(
      client.request(BridgeMethods.hello, { protocolVersion: PROTOCOL_VERSION + 1, client: 't' }),
      JsonRpcErrorCodes.InvalidParams
    )
    const hello = await client.hello()
    expect(hello).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      hostNavigation: false
    })
    expect(hello.availableLanguages).toEqual(expect.arrayContaining(['typescript', 'javascript']))
    const status = await client.request<BridgeStatus>(BridgeMethods.status)
    expect(status.clients).toBe(1)
    expect(status.servers['typescript-language-server']).toBe(process.execPath)
    expect(Object.keys(status.servers)).toEqual(
      expect.arrayContaining(['tsgo', 'pyright', 'basedpyright', 'gopls', 'rust-analyzer'])
    )
  })

  it('answers malformed JSON, invalid requests and unknown methods', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    const parse = await client.sendRawAndWait('{not json')
    expect(parse).toMatchObject({ id: null, error: { code: JsonRpcErrorCodes.ParseError } })
    const invalid = await client.sendRawAndWait('{"jsonrpc":"2.0","id":5}')
    expect(invalid).toMatchObject({ id: 5, error: { code: JsonRpcErrorCodes.InvalidRequest } })
    await expectRpcError(client.request('nope/nothing'), JsonRpcErrorCodes.MethodNotFound)
  })

  it('closes connections that exceed the maximum message size', async () => {
    const { port } = await startBridge({ maxMessageBytes: 1024 })
    const socket = new WebSocket(bridgeUrl(port, TOKEN))
    await new Promise((resolve) => socket.once('open', resolve))
    const code = await new Promise<number>((resolve) => {
      socket.once('close', (closeCode) => resolve(closeCode))
      socket.send('x'.repeat(4096))
    })
    expect(code).toBe(1009)
  })
})

describe('request validation', () => {
  it('rejects LSP methods outside the allowlist', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    const opened = await client.openDocument(join(workspace, 'src', 'a.ts'), 'typescript')
    if (opened.sessionId === null) throw new Error(opened.reason)
    await expectRpcError(
      client.request(BridgeMethods.lspRequest, {
        sessionId: opened.sessionId,
        method: 'workspace/executeCommand',
        params: { command: 'rm' }
      }),
      JsonRpcErrorCodes.MethodNotAllowed
    )
  })

  it('rejects documents and reads outside allowedRoots', async () => {
    const { port } = await startBridge({ allowedRoots: [workspace] })
    const client = await connect(port)
    await expectRpcError(
      client.openDocument(join(outsideDir, 'b.ts'), 'typescript'),
      JsonRpcErrorCodes.PathNotAllowed
    )
    await expectRpcError(
      client.request(BridgeMethods.readFile, { uri: pathToFileURL(join(outsideDir, 'b.ts')).href }),
      JsonRpcErrorCodes.PathNotAllowed
    )
    const read = await client.request<{ text: string; languageId: string }>(
      BridgeMethods.readFile,
      {
        uri: pathToFileURL(join(workspace, 'src', 'a.ts')).href
      }
    )
    expect(read).toMatchObject({ text: 'export const a = 1\n', languageId: 'typescript' })
  })

  it('without allowedRoots, reads are limited to roots of sessions the client used', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    const uri = pathToFileURL(join(workspace, 'src', 'a.ts')).href
    await expectRpcError(
      client.request(BridgeMethods.readFile, { uri }),
      JsonRpcErrorCodes.PathNotAllowed
    )
    await client.openDocument(join(workspace, 'src', 'a.ts'), 'typescript')
    await expect(client.request(BridgeMethods.readFile, { uri })).resolves.toMatchObject({ uri })
    // A second client that opened nothing still can't read it.
    const other = await connect(port)
    await expectRpcError(
      other.request(BridgeMethods.readFile, { uri }),
      JsonRpcErrorCodes.PathNotAllowed
    )
  })

  it('reports unsupported languages and invalid params', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    const result = await client.request(BridgeMethods.openDocument, {
      uri: pathToFileURL(join(workspace, 'README.md')).href,
      languageId: 'markdown',
      text: '# hi'
    })
    expect(result).toEqual({ sessionId: null, reason: 'unsupported language: markdown' })
    await expectRpcError(
      client.request(BridgeMethods.openDocument, {
        uri: 'https://x/a.ts',
        languageId: 'typescript',
        text: ''
      }),
      JsonRpcErrorCodes.InvalidParams
    )
    await expectRpcError(
      client.request(BridgeMethods.openDocument, []),
      JsonRpcErrorCodes.InvalidParams
    )
  })
})

describe('host/openLocation', () => {
  const params = {
    uri: pathToFileURL('/tmp/x.ts').href,
    range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } }
  }

  it('reports no navigator when none is configured', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    await expect(client.request(BridgeMethods.openLocation, params)).resolves.toEqual({
      opened: false,
      reason: 'no host navigator'
    })
  })

  it('delegates to the host navigator', async () => {
    const targets: HostNavigationTarget[] = []
    const { port } = await startBridge({
      hostNavigator: async (target) => {
        targets.push(target)
        return { opened: true }
      }
    })
    const client = await connect(port)
    const hello = await client.hello()
    expect(hello.hostNavigation).toBe(true)
    await expect(
      client.request<OpenLocationResult>(BridgeMethods.openLocation, params)
    ).resolves.toEqual({ opened: true })
    expect(targets).toEqual([{ path: '/tmp/x.ts', line: 3, character: 4 }])
  })

  it('maps navigator failures to HostUnavailable', async () => {
    const { port } = await startBridge({
      hostNavigator: async () => {
        throw new Error('host is down')
      }
    })
    const client = await connect(port)
    await expectRpcError(
      client.request(BridgeMethods.openLocation, params),
      JsonRpcErrorCodes.HostUnavailable
    )
  })
})

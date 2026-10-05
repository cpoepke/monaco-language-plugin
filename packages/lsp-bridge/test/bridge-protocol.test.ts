import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { BridgeMethods, bridgeUrl, JsonRpcErrorCodes, PROTOCOL_VERSION } from '@mlp/protocol'
import type { BridgeStatus, OpenLocationResult } from '@mlp/protocol'
import { createBridge } from '../src/index'
import type { Bridge, BridgeOptions, HostNavigationTarget } from '../src/index'
import { FAKE_SERVER_PATH, pollFor, RpcResponseError, TestClient } from './helpers/test-client'

const TOKEN = 'protocol-test-token'
let workspace: string
let outsideDir: string
const bridges: Bridge[] = []
const clients: TestClient[] = []

beforeAll(() => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mlp-protocol-')))
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
    trustedRoots: [workspace],
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

function upgradeStatus(
  port: number,
  token: string | null,
  extraHeaders: Record<string, string> = {},
  requestTarget?: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const path = token === null ? '/' : `/?token=${encodeURIComponent(token)}`
    const req = request({
      host: '127.0.0.1',
      port,
      path: requestTarget ?? path,
      headers: {
        ...extraHeaders,
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
  it('does not start a server until the workspace is explicitly trusted', async () => {
    const { port, bridge } = await startBridge({ trustedRoots: undefined })
    const client = await connect(port)
    const result = await client.openDocument(join(workspace, 'src', 'a.ts'), 'typescript')
    expect(result).toMatchObject({
      sessionId: null,
      reason: expect.stringContaining('not trusted')
    })
    expect(bridge.serverPids()).toEqual([])
  })

  it('fails closed when the workspace trust provider cannot answer', async () => {
    const { port, bridge } = await startBridge({
      trustedRoots: () => {
        throw new Error('unavailable')
      }
    })
    const client = await connect(port)
    expect(await client.openDocument(join(workspace, 'src', 'a.ts'), 'typescript')).toMatchObject({
      sessionId: null
    })
    expect(bridge.serverPids()).toEqual([])
  })

  it('does not delegate navigation outside allowed roots to a host', async () => {
    let called = false
    const { port } = await startBridge({
      allowedRoots: [workspace],
      hostNavigator: async () => {
        called = true
        return { opened: true }
      }
    })
    const client = await connect(port)
    await expectRpcError(
      client.request(BridgeMethods.openLocation, {
        uri: pathToFileURL(join(outsideDir, 'b.ts')).href,
        range: { start: { line: 0, character: 0 } }
      }),
      JsonRpcErrorCodes.PathNotAllowed
    )
    expect(called).toBe(false)
  })

  it('rejects malformed upgrade URLs before authentication without crashing', async () => {
    const { port } = await startBridge()
    expect(await upgradeStatus(port, null, {}, 'http://[')).toBe(400)
    expect(await upgradeStatus(port, TOKEN)).toBe(101)
  })

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

describe('Origin and Host checks', () => {
  it('accepts no Origin, null, file:// and loopback http(s) origins', async () => {
    const { port } = await startBridge()
    for (const origin of [
      null,
      'null',
      'file://',
      `http://127.0.0.1:5173`,
      'http://localhost:3000',
      'https://[::1]:8443'
    ]) {
      const headers: Record<string, string> = origin === null ? {} : { Origin: origin }
      expect({ origin, status: await upgradeStatus(port, TOKEN, headers) }).toEqual({
        origin,
        status: 101
      })
    }
  })

  it('rejects foreign origins even with the right token', async () => {
    const { port } = await startBridge()
    for (const origin of [
      'https://evil.example',
      'http://127.0.0.1.evil.example',
      'chrome-extension://abc',
      'garbage'
    ]) {
      expect({ origin, status: await upgradeStatus(port, TOKEN, { Origin: origin }) }).toEqual({
        origin,
        status: 403
      })
    }
  })

  it('rejects non-loopback Host headers (DNS rebinding) unless allowRemote', async () => {
    const { port } = await startBridge()
    expect(await upgradeStatus(port, TOKEN, { Host: `evil.example:${port}` })).toBe(403)
    expect(await upgradeStatus(port, TOKEN, { Host: `localhost:${port}` })).toBe(101)
    expect(await upgradeStatus(port, TOKEN, { Host: `[::1]:${port}` })).toBe(101)
    const remote = await startBridge({ allowRemote: true })
    expect(await upgradeStatus(remote.port, TOKEN, { Host: `devbox:${remote.port}` })).toBe(101)
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
    expect(result).toEqual({
      sessionId: null,
      reason: 'unsupported language: markdown',
      retryable: false
    })
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

describe('containment', () => {
  it('refuses to open files that do not exist, so they cannot pick a session root', async () => {
    // Reviewer repro: opening file:///mlp-nonexistent.ts rooted a session at
    // `/`, after which fs/readFile served /etc/passwd.
    const { port } = await startBridge()
    const client = await connect(port)
    await expectRpcError(
      client.request(BridgeMethods.openDocument, {
        uri: 'file:///mlp-nonexistent.ts',
        languageId: 'typescript',
        text: ''
      }),
      JsonRpcErrorCodes.InvalidParams
    )
    await expectRpcError(
      client.request(BridgeMethods.readFile, { uri: pathToFileURL('/etc/passwd').href }),
      JsonRpcErrorCodes.PathNotAllowed
    )
  })

  it('rejects remote (UNC) file URIs before touching the filesystem', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    for (const uri of ['file://attacker.example/share/a.ts', 'file://192.168.0.9/c$/a.ts']) {
      const open = await expectRpcError(
        client.request(BridgeMethods.openDocument, { uri, languageId: 'typescript', text: '' }),
        JsonRpcErrorCodes.InvalidParams
      )
      expect(open.message).toMatch(/Remote file URIs/)
      await expectRpcError(
        client.request(BridgeMethods.readFile, { uri }),
        JsonRpcErrorCodes.InvalidParams
      )
    }
  })

  it('evaluates a dynamic allowedRoots provider on every open and read', async () => {
    let roots: string[] = []
    const queries: string[] = []
    const { port } = await startBridge({
      allowedRoots: async ({ path }) => {
        queries.push(path)
        return roots
      }
    })
    const client = await connect(port)
    const aPath = join(workspace, 'src', 'a.ts')
    const aUri = pathToFileURL(aPath).href
    // No roots yet: everything is refused (fail closed).
    await expectRpcError(client.openDocument(aPath, 'typescript'), JsonRpcErrorCodes.PathNotAllowed)
    roots = [workspace]
    const opened = await client.openDocument(aPath, 'typescript')
    expect(opened).toMatchObject({ rootPath: workspace })
    await expect(client.request(BridgeMethods.readFile, { uri: aUri })).resolves.toMatchObject({
      uri: aUri
    })
    await expectRpcError(
      client.request(BridgeMethods.readFile, { uri: pathToFileURL(join(outsideDir, 'b.ts')).href }),
      JsonRpcErrorCodes.PathNotAllowed
    )
    // The root goes away (worktree removed): reads stop even though the
    // client still has a session there.
    roots = []
    await expectRpcError(
      client.request(BridgeMethods.readFile, { uri: aUri }),
      JsonRpcErrorCodes.PathNotAllowed
    )
    expect(queries).toContain(aPath)
  })

  // Regression (Windows): tmpdir() spells the profile as an 8.3 short name (RUNNER~1) while
  // realpaths use the long one (runneradmin); macOS has /var vs /private/var. Roots and files
  // named either way must meet in the same canonical form.
  it('accepts roots and files named through a non-canonical spelling', async () => {
    const spelledWorkspace = join(tmpdir(), basename(join(workspace, '..')), 'ws')
    const { port } = await startBridge({ allowedRoots: [spelledWorkspace] })
    const client = await connect(port)
    const aPath = join(spelledWorkspace, 'src', 'a.ts')
    const opened = await client.openDocument(aPath, 'typescript')
    expect(opened).toMatchObject({ rootPath: workspace })
    const aUri = pathToFileURL(aPath).href
    await expect(client.request(BridgeMethods.readFile, { uri: aUri })).resolves.toMatchObject({
      uri: aUri,
      text: 'export const a = 1\n'
    })
    await expectRpcError(
      client.request(BridgeMethods.readFile, {
        uri: pathToFileURL(join(spelledWorkspace, '..', 'outside', 'b.ts')).href
      }),
      JsonRpcErrorCodes.PathNotAllowed
    )
  })

  it('fails closed when the provider throws', async () => {
    const { port } = await startBridge({
      allowedRoots: () => {
        throw new Error('runtime down')
      }
    })
    const client = await connect(port)
    await expectRpcError(
      client.openDocument(join(workspace, 'src', 'a.ts'), 'typescript'),
      JsonRpcErrorCodes.PathNotAllowed
    )
  })
})

describe('lsp/cancel', () => {
  it('cancels a pending lsp/request with RequestCancelled and tells the server', async () => {
    const { port } = await startBridge({ requestTimeoutMs: 10_000 })
    const client = await connect(port)
    const aPath = join(workspace, 'src', 'a.ts')
    const uri = pathToFileURL(aPath).href
    const opened = await client.openDocument(aPath, 'typescript')
    if (opened.sessionId === null) throw new Error(opened.reason)
    // The fake server never answers references.
    const pending = client.requestTracked(BridgeMethods.lspRequest, {
      sessionId: opened.sessionId,
      method: 'textDocument/references',
      params: {
        textDocument: { uri },
        position: { line: 0, character: 0 },
        context: { includeDeclaration: true }
      }
    })
    const serverState = async (): Promise<{ cancelled: number[]; events: string[] }> => {
      const hover = await client.lsp<{ contents: { value: string } }>(
        opened.sessionId as string,
        'textDocument/hover',
        { textDocument: { uri }, position: { line: 0, character: 0 } }
      )
      return JSON.parse(hover.contents.value) as { cancelled: number[]; events: string[] }
    }
    // Cancel once the server is actually working on it.
    await pollFor(
      async () => ((await serverState()).events.includes('textDocument/references') ? true : null),
      5000,
      'references to reach the server'
    )
    const started = Date.now()
    client.notify(BridgeMethods.cancelRequest, { id: pending.id })
    const response = await pending.response
    expect(response.error?.code).toBe(-32800)
    expect(Date.now() - started).toBeLessThan(5_000)
    // Unknown ids are ignored; the connection keeps working.
    client.notify(BridgeMethods.cancelRequest, { id: 'nope' })
    const hover = await client.lsp<{ contents: { value: string } }>(
      opened.sessionId,
      'textDocument/hover',
      { textDocument: { uri }, position: { line: 0, character: 0 } }
    )
    const state = JSON.parse(hover.contents.value) as { cancelled: number[] }
    expect(state.cancelled).toHaveLength(1)
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
    // On Windows pathToFileURL('/tmp/x.ts') lies on the current drive (D:\tmp\x.ts).
    expect(targets).toEqual([{ path: fileURLToPath(params.uri), line: 3, character: 4 }])
    if (process.platform !== 'win32') {
      expect(targets[0]?.path).toBe('/tmp/x.ts')
    }
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

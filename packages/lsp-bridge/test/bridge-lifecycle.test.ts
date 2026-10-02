import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BridgeMethods, JsonRpcErrorCodes } from '@mlp/protocol'
import type { BridgeStatus, DiagnosticsParams, OpenDocumentResult } from '@mlp/protocol'
import { createBridge } from '../src/index'
import type { Bridge, BridgeOptions } from '../src/index'
import {
  FAKE_SERVER_PATH,
  isPidAlive,
  pollFor,
  RpcResponseError,
  TestClient
} from './helpers/test-client'

const TOKEN = 'lifecycle-token'
let base: string
let projectA: string
let projectB: string
const bridges: Bridge[] = []
const clients: TestClient[] = []

type FakeState = {
  pid: number
  grandchildPid: number | null
  initializeParams: {
    processId: number
    rootUri: string
    workspaceFolders: { uri: string; name: string }[]
    capabilities: { textDocument: Record<string, Record<string, unknown>> }
  }
  serverRequestReplies: Record<string, { result?: unknown; error?: { code: number } }>
  open: Record<string, { version: number; languageId: string; text: string }>
  events: string[]
  cancelled: number[]
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mlp-lifecycle-')))
  projectA = join(base, 'a')
  projectB = join(base, 'b')
  for (const project of [projectA, projectB]) {
    mkdirSync(join(project, 'src'), { recursive: true })
    writeFileSync(join(project, 'tsconfig.json'), '{}')
    writeFileSync(join(project, 'src', 'one.ts'), 'export const one = 1\n')
    writeFileSync(join(project, 'src', 'two.ts'), 'export const two = 2\n')
  }
  writeFileSync(join(projectA, 'src', 'view.tsx'), 'export const v = <div />\n')
  if (process.platform !== 'win32') {
    symlinkSync(projectA, join(base, 'a-link'))
  }
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(bridges.splice(0).map((b) => b.close()))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

async function startBridge(
  flags: string[] = [],
  options: Partial<BridgeOptions> = {}
): Promise<{ bridge: Bridge; port: number }> {
  const bridge = createBridge({
    port: 0,
    token: TOKEN,
    serverOverrides: {
      'typescript-language-server': {
        command: process.execPath,
        args: [FAKE_SERVER_PATH, ...flags]
      }
    },
    ...options
  })
  bridges.push(bridge)
  const { port } = await bridge.listen()
  return { bridge, port }
}

async function connect(port: number): Promise<TestClient> {
  const client = await TestClient.connectAndHello(port, TOKEN)
  clients.push(client)
  return client
}

function uriOf(path: string): string {
  return pathToFileURL(path).toString()
}

async function open(
  client: TestClient,
  path: string,
  text?: string,
  languageId = 'typescript'
): Promise<Extract<OpenDocumentResult, { sessionId: string }>> {
  const result = await client.openDocument(path, languageId, text)
  if (result.sessionId === null) {
    throw new Error(`open failed: ${result.reason}`)
  }
  return result
}

async function fakeState(client: TestClient, sessionId: string, uri: string): Promise<FakeState> {
  const hover = await client.lsp<{ contents: { value: string } }>(sessionId, 'textDocument/hover', {
    textDocument: { uri },
    position: { line: 0, character: 0 }
  })
  return JSON.parse(hover.contents.value) as FakeState
}

function diagnosticsFor(client: TestClient, uri: string): DiagnosticsParams[] {
  return client.notifications
    .filter((n) => n.method === BridgeMethods.diagnostics)
    .map((n) => n.params as DiagnosticsParams)
    .filter((p) => p.uri === uri)
}

function messages(params: DiagnosticsParams): string[] {
  return (params.diagnostics as { message: string }[]).map((d) => d.message)
}

describe('session lifecycle (fake server)', () => {
  it('initializes with the expected params and answers server→client requests', async () => {
    const { port } = await startBridge()
    const client = await connect(port)
    const one = uriOf(join(projectA, 'src', 'one.ts'))
    const opened = await open(client, join(projectA, 'src', 'one.ts'))
    expect(opened).toMatchObject({
      uri: one,
      serverId: 'typescript-language-server',
      rootPath: projectA,
      pullDiagnostics: false
    })
    const state = await pollFor(
      async () => {
        const s = await fakeState(client, opened.sessionId, one)
        return Object.keys(s.serverRequestReplies).length === 4 ? s : null
      },
      5000,
      'server request replies'
    )
    expect(state.initializeParams.processId).toBe(process.pid)
    expect(state.initializeParams.rootUri).toBe(uriOf(projectA))
    expect(state.initializeParams.workspaceFolders).toEqual([{ uri: uriOf(projectA), name: 'a' }])
    const td = state.initializeParams.capabilities.textDocument
    for (const method of ['definition', 'declaration', 'typeDefinition', 'implementation']) {
      expect(td[method]?.linkSupport).toBe(true)
    }
    expect(td.documentSymbol?.hierarchicalDocumentSymbolSupport).toBe(true)
    expect(td.hover?.contentFormat).toEqual(['markdown', 'plaintext'])
    expect(td.diagnostic).toBeDefined()
    expect(td.documentLink).toBeDefined()
    expect(state.serverRequestReplies).toEqual({
      'workspace/configuration': { result: [null, null] },
      'workspace/workspaceFolders': { result: [{ uri: uriOf(projectA), name: 'a' }] },
      'client/registerCapability': { result: null },
      'custom/unknownRequest': {
        error: expect.objectContaining({ code: JsonRpcErrorCodes.MethodNotFound })
      }
    })
    expect(state.open[one]).toMatchObject({ version: 1, languageId: 'typescript' })
  })

  it('shares sessions across clients and refcounts documents', async () => {
    const { bridge, port } = await startBridge()
    const alice = await connect(port)
    const bob = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const one = uriOf(onePath)
    const a = await open(alice, onePath)
    const b = await open(bob, onePath)
    expect(b.sessionId).toBe(a.sessionId)
    expect(bridge.status().sessions).toEqual([
      expect.objectContaining({ sessionId: a.sessionId, openDocuments: 1, state: 'running' })
    ])

    // Alice closes; Bob still holds it, so the server never sees didClose.
    alice.notify(BridgeMethods.closeDocument, { sessionId: a.sessionId, uri: one })
    let state = await fakeState(bob, a.sessionId, one)
    expect(state.open[one]).toBeDefined()
    expect(state.events).not.toContain('textDocument/didClose')
    // Alice may no longer query a document she closed.
    await expect(fakeState(alice, a.sessionId, one)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })

    // Bob disconnecting releases his hold: last close sends didClose.
    const twoPath = join(projectA, 'src', 'two.ts')
    await open(alice, twoPath)
    await bob.close()
    state = await pollFor(
      async () => {
        const s = await fakeState(alice, a.sessionId, uriOf(twoPath))
        return s.open[one] === undefined ? s : null
      },
      5000,
      'didClose after disconnect'
    )
    expect(state.events.filter((e) => e === 'textDocument/didOpen')).toHaveLength(2)
    expect(state.events.filter((e) => e === 'textDocument/didClose')).toHaveLength(1)
    expect(bridge.status().clients).toBe(1)
  })

  it('routes diagnostics only to clients that have the document open', async () => {
    const { port } = await startBridge()
    const alice = await connect(port)
    const bob = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const twoPath = join(projectA, 'src', 'two.ts')
    const one = uriOf(onePath)
    const two = uriOf(twoPath)
    const a = await open(alice, onePath)
    await open(bob, twoPath)
    await alice.waitForNotification(
      BridgeMethods.diagnostics,
      (p) => (p as DiagnosticsParams).uri === one
    )
    await bob.waitForNotification(
      BridgeMethods.diagnostics,
      (p) => (p as DiagnosticsParams).uri === two
    )
    expect(diagnosticsFor(alice, two)).toEqual([])
    expect(diagnosticsFor(bob, one)).toEqual([])
    expect(diagnosticsFor(alice, one)[0]).toMatchObject({ sessionId: a.sessionId })
    expect(messages(diagnosticsFor(alice, one)[0] as DiagnosticsParams)).toEqual(['open v1'])

    // Bob joins one.ts with identical text: he gets the cached diagnostics.
    await open(bob, onePath)
    await bob.waitForNotification(
      BridgeMethods.diagnostics,
      (p) => (p as DiagnosticsParams).uri === one
    )

    // A change from Alice bumps the version and reaches both owners.
    alice.notify(BridgeMethods.changeDocument, {
      sessionId: a.sessionId,
      uri: one,
      text: 'changed'
    })
    const isV2 = (p: unknown): boolean =>
      (p as DiagnosticsParams).uri === one && messages(p as DiagnosticsParams)[0] === 'change v2'
    await alice.waitForNotification(BridgeMethods.diagnostics, isV2)
    await bob.waitForNotification(BridgeMethods.diagnostics, isV2)

    // Bob can't change a document he doesn't own.
    bob.notify(BridgeMethods.changeDocument, {
      sessionId: a.sessionId,
      uri: two + 'x',
      text: 'nope'
    })
    const state = await fakeState(alice, a.sessionId, one)
    expect(state.open[one]).toMatchObject({ version: 2, text: 'changed' })
  })

  it('enforces document ownership and session existence on lsp/request', async () => {
    const { port } = await startBridge()
    const alice = await connect(port)
    const bob = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const a = await open(alice, onePath)
    await open(bob, join(projectA, 'src', 'two.ts'))
    const params = { textDocument: { uri: uriOf(onePath) }, position: { line: 0, character: 0 } }
    await expect(bob.lsp(a.sessionId, 'textDocument/definition', params)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(alice.lsp('s999', 'textDocument/definition', params)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.SessionNotFound
    })
    const definition = await alice.lsp<{ uri: string }[]>(
      a.sessionId,
      'textDocument/definition',
      params
    )
    expect(definition[0]?.uri).toBe(uriOf(onePath))
  })

  it('forwards server errors and times out unanswered requests', async () => {
    const { port } = await startBridge([], { requestTimeoutMs: 300 })
    const client = await connect(port)
    const one = uriOf(join(projectA, 'src', 'one.ts'))
    const opened = await open(client, join(projectA, 'src', 'one.ts'))
    const symbolError = await client
      .lsp(opened.sessionId, 'textDocument/documentSymbol', { textDocument: { uri: one } })
      .catch((error: unknown) => error)
    expect(symbolError).toBeInstanceOf(RpcResponseError)
    expect((symbolError as RpcResponseError).error).toEqual({
      code: -32803,
      message: 'fake failure',
      data: { why: 'test' }
    })
    await expect(
      client.lsp(opened.sessionId, 'textDocument/references', {
        textDocument: { uri: one },
        position: { line: 0, character: 0 },
        context: { includeDeclaration: true }
      })
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.RequestTimeout })
    const state = await fakeState(client, opened.sessionId, one)
    expect(state.cancelled.length).toBe(1)
  })

  it('reports pull diagnostics and maps .tsx to typescriptreact', async () => {
    const { port } = await startBridge(['--pull'])
    const client = await connect(port)
    const viewPath = join(projectA, 'src', 'view.tsx')
    const opened = await open(client, viewPath)
    expect(opened.pullDiagnostics).toBe(true)
    const state = await fakeState(client, opened.sessionId, uriOf(viewPath))
    expect(state.open[uriOf(viewPath)]?.languageId).toBe('typescriptreact')
  })

  it.skipIf(process.platform === 'win32')(
    'opens symlinked paths under the realpath but answers with the client URI',
    async () => {
      const { port } = await startBridge()
      const client = await connect(port)
      const linkPath = join(base, 'a-link', 'src', 'one.ts')
      const linkUri = uriOf(linkPath)
      const opened = await open(client, linkPath)
      expect(opened.uri).toBe(linkUri)
      expect(opened.rootPath).toBe(projectA)
      await client.waitForNotification(
        BridgeMethods.diagnostics,
        (p) => (p as DiagnosticsParams).uri === linkUri
      )
      const state = await fakeState(client, opened.sessionId, linkUri)
      expect(Object.keys(state.open)).toEqual([uriOf(join(projectA, 'src', 'one.ts'))])
    }
  )

  it('stops idle sessions after idleShutdownMs and restarts on the next open', async () => {
    const { bridge, port } = await startBridge([], { idleShutdownMs: 150 })
    const client = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const first = await open(client, onePath)
    const [pid] = bridge.serverPids()
    expect(pid).toBeDefined()
    client.notify(BridgeMethods.closeDocument, { sessionId: first.sessionId, uri: uriOf(onePath) })
    await pollFor(() => (bridge.status().sessions.length === 0 ? true : null), 5000, 'idle stop')
    await pollFor(() => (isPidAlive(pid as number) ? null : true), 5000, 'server exit')
    // Graceful idle stops are not crashes: no session/closed is sent.
    expect(client.notifications.some((n) => n.method === BridgeMethods.sessionClosed)).toBe(false)
    const second = await open(client, onePath)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('notifies session/closed on a crash, restarts, and gives up after 3 crashes', async () => {
    const { bridge, port } = await startBridge()
    const alice = await connect(port)
    const bob = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const one = uriOf(onePath)
    const previous = new Set<string>()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const opened = await open(alice, onePath, 'export const one = 1\n')
      expect(previous.has(opened.sessionId)).toBe(false)
      previous.add(opened.sessionId)
      alice.notify(BridgeMethods.changeDocument, {
        sessionId: opened.sessionId,
        uri: one,
        text: 'CRASH'
      })
      const closed = await alice.waitForNotification(
        BridgeMethods.sessionClosed,
        (p) => (p as { sessionId: string }).sessionId === opened.sessionId
      )
      const reason = (closed.params as { reason: string }).reason
      expect(reason).toContain('exited unexpectedly (code 3)')
      expect(reason).toContain('crashing on purpose')
      expect(bridge.status().sessions).toEqual([])
    }
    // Bob never had a document in those sessions, so he was not notified.
    expect(bob.notifications.some((n) => n.method === BridgeMethods.sessionClosed)).toBe(false)
    const refused = await alice.openDocument(onePath, 'typescript')
    expect(refused.sessionId).toBeNull()
    expect(refused.sessionId === null && refused.reason).toMatch(/crashed 3 times/)
  })

  it('caps concurrent sessions, evicting idle ones first', async () => {
    const { bridge, port } = await startBridge([], { maxSessions: 1 })
    const client = await connect(port)
    const aPath = join(projectA, 'src', 'one.ts')
    const a = await open(client, aPath)
    const refused = await client.openDocument(join(projectB, 'src', 'one.ts'), 'typescript')
    expect(refused).toEqual({
      sessionId: null,
      reason: 'too many language servers running (max 1)'
    })
    client.notify(BridgeMethods.closeDocument, { sessionId: a.sessionId, uri: uriOf(aPath) })
    await pollFor(
      () => (bridge.status().sessions[0]?.openDocuments === 0 ? true : null),
      2000,
      'document close'
    )
    const b = await open(client, join(projectB, 'src', 'one.ts'))
    expect(b.rootPath).toBe(projectB)
    expect(bridge.status().sessions.map((s) => s.sessionId)).toEqual([b.sessionId])
  })

  it('reports a server that dies during startup, with its stderr', async () => {
    const bridge = createBridge({
      port: 0,
      token: TOKEN,
      serverOverrides: {
        'typescript-language-server': {
          command: process.execPath,
          args: ['-e', 'process.stderr.write("no tsserver here\\n"); process.exit(5)']
        }
      }
    })
    bridges.push(bridge)
    const { port } = await bridge.listen()
    const client = await connect(port)
    const result = await client.openDocument(join(projectA, 'src', 'one.ts'), 'typescript')
    expect(result.sessionId).toBeNull()
    expect(result.sessionId === null && result.reason).toMatch(/failed to start|exited/)
    expect(result.sessionId === null && result.reason).toContain('no tsserver here')
    expect(bridge.status().sessions).toEqual([])
  })
})

describe('process cleanup', () => {
  it('close() stops servers and their process group', async () => {
    const { bridge, port } = await startBridge(['--spawn-grandchild'])
    const client = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const opened = await open(client, onePath)
    const state = await fakeState(client, opened.sessionId, uriOf(onePath))
    expect(bridge.serverPids()).toEqual([state.pid])
    expect(state.grandchildPid).not.toBeNull()
    expect(isPidAlive(state.pid)).toBe(true)
    expect(isPidAlive(state.grandchildPid as number)).toBe(true)
    await bridge.close()
    expect(isPidAlive(state.pid)).toBe(false)
    if (process.platform !== 'win32') {
      await pollFor(
        () => (isPidAlive(state.grandchildPid as number) ? null : true),
        3000,
        'grandchild exit'
      )
    }
    const status: BridgeStatus = bridge.status()
    expect(status.sessions).toEqual([])
  })

  it('escalates to signals when a server ignores shutdown and SIGTERM', async () => {
    const { bridge, port } = await startBridge(['--ignore-shutdown'])
    const client = await connect(port)
    const onePath = join(projectA, 'src', 'one.ts')
    const opened = await open(client, onePath)
    const state = await fakeState(client, opened.sessionId, uriOf(onePath))
    const started = Date.now()
    await bridge.close()
    expect(isPidAlive(state.pid)).toBe(false)
    // shutdown (2 s) + exit wait (2 s) + SIGTERM wait (2 s), then SIGKILL.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5500)
  }, 15_000)
})

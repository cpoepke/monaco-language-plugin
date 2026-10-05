/**
 * The per-client request handlers against a fake SessionManager: parameter
 * validation, containment, the hello gate, cancellation and host navigation.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeMethods, JsonRpcErrorCodes, PROTOCOL_VERSION } from '@mlp/protocol'
import { normalizeBridgeOptions, type BridgeOptions } from '../src/bridge/bridge-options'
import {
  createClientHandlers,
  type BridgeContext,
  type ClientHandlers,
  type ClientState
} from '../src/bridge/client-handlers'
import { silentLogger } from '../src/logger'
import type { SessionManager } from '../src/sessions/session-manager'

let base: string
let project: string

const fileUri = (file: string) => pathToFileURL(file).toString()

function setup(options: Partial<BridgeOptions> = {}, greeted = true) {
  const openDocument = vi.fn(async (args: { clientUri: string }) => ({
    sessionId: 's1',
    uri: args.clientUri,
    serverId: 'typescript-language-server',
    rootPath: project,
    pullDiagnostics: false
  }))
  const request = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }))
  const sessions = {
    openDocument,
    request,
    changeDocument: vi.fn(() => true),
    closeDocument: vi.fn(() => true),
    releaseClient: vi.fn()
  }
  const client: ClientState = {
    id: 7,
    greeted,
    closed: false,
    usedRoots: new Set(),
    pendingRequests: new Map()
  }
  const context: BridgeContext = {
    options: normalizeBridgeOptions({
      port: 0,
      token: 't',
      trustedRoots: [project],
      logger: silentLogger,
      ...options
    }),
    sessions: sessions as unknown as SessionManager,
    // Why: process.execPath stands in for an installed typescript-language-server.
    resolution: {
      overrides: { 'typescript-language-server': { command: process.execPath } },
      extraDirs: [],
      pathEnv: '',
      probe: false
    },
    trustProjectBinaries: false,
    status: () => ({ bridgeVersion: 'test', clients: 1, sessions: [], servers: {} })
  }
  const handlers: ClientHandlers = createClientHandlers(context, client)
  const call = (method: string, params?: unknown, id: number | string = 1) =>
    Promise.resolve().then(() => handlers.onRequest(method, params, id))
  return { handlers, client, sessions, openDocument, request, context, call }
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-handlers-')))
  project = path.join(base, 'project')
  mkdirSync(project)
  writeFileSync(path.join(project, 'package.json'), '{}')
  writeFileSync(path.join(project, 'a.ts'), 'export const a = 1\n')
  writeFileSync(path.join(project, 'b.tsx'), 'export const b = <div />\n')
  writeFileSync(path.join(project, 'notes.txt'), 'hello\n')
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('the hello gate', () => {
  it('refuses everything but bridge/hello until the client greeted', async () => {
    const { call, handlers } = setup({}, false)
    await expect(call(BridgeMethods.status)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidRequest,
      message: expect.stringContaining('must be called first')
    })
    await expect(call(BridgeMethods.openDocument, {})).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidRequest
    })
    // notifications before the greeting are dropped silently
    expect(() =>
      handlers.onNotification(BridgeMethods.changeDocument, { sessionId: 's', uri: 'u', text: 't' })
    ).not.toThrow()
  })

  it('does not forward notifications from a client that never greeted', () => {
    const { handlers, sessions } = setup({}, false)
    handlers.onNotification(BridgeMethods.changeDocument, { sessionId: 's', uri: 'u', text: 't' })
    handlers.onNotification(BridgeMethods.closeDocument, { sessionId: 's', uri: 'u' })
    expect(sessions.changeDocument).not.toHaveBeenCalled()
    expect(sessions.closeDocument).not.toHaveBeenCalled()
  })

  it('answers MethodNotFound for unknown methods, including inherited object keys', async () => {
    const { call } = setup()
    for (const method of [
      'nope/method',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty'
    ]) {
      await expect(call(method)).rejects.toMatchObject({ code: JsonRpcErrorCodes.MethodNotFound })
    }
  })
})

describe('bridge/hello', () => {
  it('greets, reports host navigation and the languages with a server', async () => {
    const hosted = setup({ hostNavigator: async () => ({ opened: true }) }, false)
    const result = (await hosted.call(BridgeMethods.hello, {
      protocolVersion: PROTOCOL_VERSION,
      client: 'tests'
    })) as { protocolVersion: number; hostNavigation: boolean; availableLanguages: string[] }
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(result.hostNavigation).toBe(true)
    expect(result.availableLanguages).toEqual(['typescript', 'javascript'])
    expect(hosted.client.greeted).toBe(true)

    const plain = setup({}, false)
    expect(
      (await plain.call(BridgeMethods.hello, { protocolVersion: PROTOCOL_VERSION })) as {
        hostNavigation: boolean
      }
    ).toMatchObject({ hostNavigation: false })
  })

  it('rejects another protocol version and leaves the client ungreeted', async () => {
    const t = setup({}, false)
    await expect(t.call(BridgeMethods.hello, { protocolVersion: 99 })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      data: { expected: PROTOCOL_VERSION }
    })
    await expect(t.call(BridgeMethods.hello, 'nope')).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    expect(t.client.greeted).toBe(false)
  })

  it('serves bridge/status', async () => {
    const t = setup()
    expect(await t.call(BridgeMethods.status)).toMatchObject({ bridgeVersion: 'test', clients: 1 })
  })
})

describe('document/open', () => {
  const open = (t: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) =>
    t.call(BridgeMethods.openDocument, {
      uri: fileUri(path.join(project, 'a.ts')),
      languageId: 'typescript',
      text: 'export const a = 1\n',
      ...overrides
    })

  it('validates its parameters', async () => {
    const t = setup()
    for (const bad of [
      null,
      { languageId: 'typescript', text: '' },
      { uri: fileUri(path.join(project, 'a.ts')), text: '' },
      { uri: fileUri(path.join(project, 'a.ts')), languageId: 'typescript' },
      { uri: 5, languageId: 'typescript', text: '' }
    ]) {
      await expect(t.call(BridgeMethods.openDocument, bad)).rejects.toMatchObject({
        code: JsonRpcErrorCodes.InvalidParams
      })
    }
    expect(t.openDocument).not.toHaveBeenCalled()
  })

  it('refuses non-file and remote file URIs before touching the file system', async () => {
    const t = setup()
    await expect(open(t, { uri: 'http://example.com/a.ts' })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(open(t, { uri: 'file://attacker.example/share/a.ts' })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: expect.stringContaining('Remote file URIs')
    })
    await expect(open(t, { uri: 'not a uri' })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
  })

  it('refuses files that do not exist and directories', async () => {
    const t = setup()
    await expect(open(t, { uri: fileUri(path.join(project, 'missing.ts')) })).rejects.toMatchObject(
      { code: JsonRpcErrorCodes.InvalidParams }
    )
    await expect(open(t, { uri: fileUri(project) })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
  })

  it('answers "no session" for languages without a server, without starting anything', async () => {
    const t = setup()
    expect(
      await open(t, { languageId: 'plaintext', uri: fileUri(path.join(project, 'notes.txt')) })
    ).toEqual({
      sessionId: null,
      reason: 'unsupported language: plaintext',
      retryable: false
    })
    // a known language whose server is not installed
    const result = (await open(t, {
      languageId: 'python',
      uri: fileUri(path.join(project, 'a.ts'))
    })) as {
      sessionId: null
      reason: string
      retryable: boolean
    }
    expect(result.sessionId).toBeNull()
    expect(result.retryable).toBe(false)
    expect(t.openDocument).not.toHaveBeenCalled()
  })

  it('maps variant language ids through the file extension and starts the session', async () => {
    const t = setup()
    const tsx = fileUri(path.join(project, 'b.tsx'))
    const result = await open(t, { languageId: 'typescriptreact', uri: tsx })
    expect(result).toMatchObject({ sessionId: 's1' })
    expect(t.openDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 7,
        clientUri: tsx,
        serverUri: tsx,
        lspLanguageId: 'typescriptreact',
        rootPath: project
      })
    )
    expect(t.client.usedRoots.has(project)).toBe(true)
  })

  it('reports a missing server with the list of what was looked for', async () => {
    const t = setup()
    t.context.resolution.overrides = {
      'typescript-language-server': { command: path.join(base, 'missing-binary') }
    }
    const result = (await open(t)) as { sessionId: null; reason: string }
    expect(result.sessionId).toBeNull()
    expect(result.reason).toMatch(/no language server found for typescript/)
  })

  it('releases the document right away when the client left while the server started', async () => {
    const t = setup()
    t.openDocument.mockImplementationOnce(async (args: { clientUri: string }) => {
      t.client.closed = true
      return {
        sessionId: 's1',
        uri: args.clientUri,
        serverId: 'x',
        rootPath: project,
        pullDiagnostics: false
      }
    })
    await open(t)
    expect(t.sessions.releaseClient).toHaveBeenCalledWith(7)
    expect(t.client.usedRoots.size).toBe(0)
  })

  it('does not record a root for a declined open', async () => {
    const t = setup()
    t.openDocument.mockResolvedValueOnce({
      sessionId: null,
      reason: 'busy',
      retryable: true
    } as never)
    await open(t)
    expect(t.client.usedRoots.size).toBe(0)
  })

  it('refuses documents outside the allowed roots, also when the provider fails', async () => {
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'x.ts'), 'x')
    const confined = setup({ allowedRoots: [project] })
    await expect(
      open(confined, { uri: fileUri(path.join(outside, 'x.ts')) })
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.PathNotAllowed
    })
    expect(await open(confined)).toMatchObject({ sessionId: 's1' })

    const failing = setup({
      allowedRoots: () => {
        throw new Error('worktree list unavailable')
      }
    })
    await expect(open(failing)).rejects.toMatchObject({ code: JsonRpcErrorCodes.PathNotAllowed })

    const none = setup({ allowedRoots: () => [] })
    await expect(open(none)).rejects.toMatchObject({ code: JsonRpcErrorCodes.PathNotAllowed })
  })

  it('does not follow a symlink out of the allowed roots', async () => {
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.ts'), 'x')
    try {
      const { symlinkSync } = await import('node:fs')
      symlinkSync(path.join(outside, 'secret.ts'), path.join(project, 'link.ts'))
    } catch {
      // Creating symlinks needs a privilege on some Windows setups; nothing to test then.
      return
    }
    const t = setup({ allowedRoots: [project] })
    await expect(open(t, { uri: fileUri(path.join(project, 'link.ts')) })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.PathNotAllowed
    })
  })
})

describe('lsp/request and lsp/cancel', () => {
  it('validates params and the method allowlist', async () => {
    const t = setup()
    await expect(t.call(BridgeMethods.lspRequest, null)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(
      t.call(BridgeMethods.lspRequest, { method: 'textDocument/hover' })
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(t.call(BridgeMethods.lspRequest, { sessionId: 's1' })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    for (const method of ['workspace/executeCommand', 'textDocument/rename', 'shutdown', 'exit']) {
      await expect(
        t.call(BridgeMethods.lspRequest, { sessionId: 's1', method, params: {} })
      ).rejects.toMatchObject({ code: JsonRpcErrorCodes.MethodNotAllowed })
    }
    expect(t.request).not.toHaveBeenCalled()
  })

  it('forwards allowlisted requests with the client id and an abort signal, then forgets the id', async () => {
    const t = setup()
    const result = await t.call(
      BridgeMethods.lspRequest,
      { sessionId: 's1', method: 'textDocument/hover', params: { a: 1 } },
      42
    )
    expect(result).toEqual({ ok: true })
    expect(t.request).toHaveBeenCalledWith(
      7,
      's1',
      'textDocument/hover',
      { a: 1 },
      expect.any(AbortSignal)
    )
    expect(t.client.pendingRequests.size).toBe(0)
  })

  it('forgets the id when the request fails', async () => {
    const t = setup()
    t.request.mockRejectedValueOnce(new Error('server died'))
    await expect(
      t.call(BridgeMethods.lspRequest, { sessionId: 's1', method: 'textDocument/hover' }, 5)
    ).rejects.toThrow('server died')
    expect(t.client.pendingRequests.size).toBe(0)
  })

  it('aborts the in-flight request for lsp/cancel and ignores unknown or malformed ids', async () => {
    const t = setup()
    let signal!: AbortSignal
    let finish!: () => void
    t.request.mockImplementationOnce((...args: unknown[]) => {
      signal = args[4] as AbortSignal
      return new Promise((resolve) => (finish = () => resolve('done')))
    })
    const pending = t.call(
      BridgeMethods.lspRequest,
      { sessionId: 's1', method: 'textDocument/definition' },
      'req-1'
    )
    await vi.waitFor(() => expect(t.client.pendingRequests.has('req-1')).toBe(true))
    for (const id of [999, 'other', null, undefined, {}, [1]]) {
      t.handlers.onNotification(BridgeMethods.cancelRequest, { id })
    }
    t.handlers.onNotification(BridgeMethods.cancelRequest, null)
    expect(signal.aborted).toBe(false)
    t.handlers.onNotification(BridgeMethods.cancelRequest, { id: 'req-1' })
    expect(signal.aborted).toBe(true)
    finish()
    await pending
    expect(t.client.pendingRequests.size).toBe(0)
    // cancelling after completion is a no-op
    t.handlers.onNotification(BridgeMethods.cancelRequest, { id: 'req-1' })
  })

  it('lets the newest call own a reused id', async () => {
    const t = setup()
    const finishers: (() => void)[] = []
    t.request.mockImplementation(
      () => new Promise((resolve) => finishers.push(() => resolve('done')))
    )
    const params = { sessionId: 's1', method: 'textDocument/hover' }
    const first = t.call(BridgeMethods.lspRequest, params, 3)
    const second = t.call(BridgeMethods.lspRequest, params, 3)
    await vi.waitFor(() => expect(finishers).toHaveLength(2))
    const newest = t.client.pendingRequests.get(3)
    finishers[0]!()
    await first
    // the first call finishing must not drop the entry of the second
    expect(t.client.pendingRequests.get(3)).toBe(newest)
    finishers[1]!()
    await second
    expect(t.client.pendingRequests.size).toBe(0)
  })
})

describe('document change and close notifications', () => {
  it('forward well-formed notifications and drop malformed ones', () => {
    const t = setup()
    t.handlers.onNotification(BridgeMethods.changeDocument, {
      sessionId: 's1',
      uri: 'u',
      text: 'x'
    })
    t.handlers.onNotification(BridgeMethods.changeDocument, { sessionId: 's1', uri: 'u' })
    t.handlers.onNotification(BridgeMethods.changeDocument, 'junk')
    t.handlers.onNotification(BridgeMethods.closeDocument, { sessionId: 's1', uri: 'u' })
    t.handlers.onNotification(BridgeMethods.closeDocument, { sessionId: 1, uri: 'u' })
    t.handlers.onNotification('unknown/notification', {})
    expect(t.sessions.changeDocument).toHaveBeenCalledTimes(1)
    expect(t.sessions.changeDocument).toHaveBeenCalledWith(7, 's1', 'u', 'x')
    expect(t.sessions.closeDocument).toHaveBeenCalledTimes(1)
    expect(t.sessions.closeDocument).toHaveBeenCalledWith(7, 's1', 'u')
  })
})

describe('fs/readFile', () => {
  it('reads inside the roots of sessions the client opened, and nowhere else', async () => {
    const t = setup()
    const target = fileUri(path.join(project, 'a.ts'))
    await expect(t.call(BridgeMethods.readFile, { uri: target })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.PathNotAllowed
    })
    t.client.usedRoots.add(project)
    expect(await t.call(BridgeMethods.readFile, { uri: target })).toMatchObject({
      uri: target,
      text: 'export const a = 1\n',
      languageId: 'typescript'
    })
    await expect(
      t.call(BridgeMethods.readFile, { uri: fileUri(path.join(base, 'elsewhere.ts')) })
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.PathNotAllowed })
  })

  it('lets allowed roots alone decide when containment is on', async () => {
    let roots: string[] = [project]
    const t = setup({ allowedRoots: () => roots })
    const target = fileUri(path.join(project, 'a.ts'))
    expect(await t.call(BridgeMethods.readFile, { uri: target })).toMatchObject({ uri: target })
    // a root removed since the session started stops being readable ...
    roots = []
    t.client.usedRoots.add(project)
    await expect(t.call(BridgeMethods.readFile, { uri: target })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.PathNotAllowed
    })
  })

  it('validates the uri', async () => {
    const t = setup()
    await expect(t.call(BridgeMethods.readFile, null)).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(t.call(BridgeMethods.readFile, { uri: 3 })).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
    await expect(
      t.call(BridgeMethods.readFile, { uri: 'file://evil/share/x' })
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams
    })
  })
})

describe('host/openLocation', () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    uri: fileUri(path.join(project, 'a.ts')),
    range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } },
    ...overrides
  })

  it('validates the location', async () => {
    const t = setup({ hostNavigator: async () => ({ opened: true }) })
    for (const bad of [
      null,
      params({ uri: 'http://x/y' }),
      params({ range: null }),
      params({ range: { start: null } }),
      params({ range: { start: { line: -1, character: 0 } } }),
      params({ range: { start: { line: 1.5, character: 0 } } }),
      params({ range: { start: { line: 1, character: '0' } } })
    ]) {
      await expect(t.call(BridgeMethods.openLocation, bad)).rejects.toMatchObject({
        code: JsonRpcErrorCodes.InvalidParams
      })
    }
  })

  it('says so when there is no host navigator', async () => {
    const t = setup()
    expect(await t.call(BridgeMethods.openLocation, params())).toEqual({
      opened: false,
      reason: 'no host navigator'
    })
  })

  it('asks the host to open the file at the position', async () => {
    const navigator = vi.fn(async () => ({ opened: true }))
    const t = setup({ hostNavigator: navigator })
    expect(await t.call(BridgeMethods.openLocation, params())).toEqual({ opened: true })
    expect(navigator).toHaveBeenCalledWith({
      path: path.join(project, 'a.ts'),
      line: 4,
      character: 2
    })
  })

  it('passes on the host’s reason, or a default one', async () => {
    const withReason = setup({
      hostNavigator: async () => ({ opened: false, reason: 'no such tab' })
    })
    expect(await withReason.call(BridgeMethods.openLocation, params())).toEqual({
      opened: false,
      reason: 'no such tab'
    })
    const withoutReason = setup({ hostNavigator: async () => ({ opened: false }) })
    expect(await withoutReason.call(BridgeMethods.openLocation, params())).toEqual({
      opened: false,
      reason: 'not opened'
    })
  })

  it('maps a throwing host to HostUnavailable', async () => {
    const failing = setup({
      hostNavigator: async () => {
        throw new Error('Orca runtime not reachable')
      }
    })
    await expect(failing.call(BridgeMethods.openLocation, params())).rejects.toMatchObject({
      code: JsonRpcErrorCodes.HostUnavailable,
      message: 'Host navigation failed: Orca runtime not reachable'
    })
    const odd = setup({
      hostNavigator: async () => {
        throw 'plain string'
      }
    })
    await expect(odd.call(BridgeMethods.openLocation, params())).rejects.toMatchObject({
      code: JsonRpcErrorCodes.HostUnavailable,
      message: 'Host navigation failed: plain string'
    })
  })
})

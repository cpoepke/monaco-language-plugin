import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostNavigator } from '../src/host-navigator'
import {
  OrcaRuntimeError,
  createOrcaRuntimeClient,
  interpretFrame,
  parseRuntimeMetadata
} from '../src/orca-runtime-client'
import { FakeOrcaRuntime } from './fake-orca-runtime'

let fake: FakeOrcaRuntime

beforeEach(async () => {
  fake = new FakeOrcaRuntime()
  await fake.start()
})

afterEach(async () => {
  await fake.dispose()
})

function client(timeoutMs = 2_000) {
  return createOrcaRuntimeClient({ userDataCandidates: () => [fake.userData], timeoutMs })
}

describe('createOrcaRuntimeClient', () => {
  it('sends {id, authToken, method, params} and returns the result', async () => {
    fake.handler = (request) => ({ result: { echo: request.params } })
    const result = await client().call('worktree.list', { limit: 5 })
    expect(result).toEqual({ echo: { limit: 5 } })
    expect(fake.requests).toHaveLength(1)
    const [request] = fake.requests
    expect(request?.method).toBe('worktree.list')
    expect(request?.authToken).toBe(fake.authToken)
    expect(typeof request?.id).toBe('string')
  })

  it('skips keepalive frames', async () => {
    fake.handler = () => ({ keepaliveThen: { result: 'late' } })
    await expect(client().call('x')).resolves.toBe('late')
  })

  it('surfaces Orca error envelopes as OrcaRuntimeError with the code', async () => {
    fake.handler = () => ({ error: { code: 'selector_not_found', message: 'no worktree' } })
    const error = await client()
      .call('files.open', {})
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OrcaRuntimeError)
    expect((error as OrcaRuntimeError).code).toBe('selector_not_found')
    expect((error as OrcaRuntimeError).message).toBe('no worktree')
  })

  it('times out when the runtime never answers', async () => {
    fake.handler = () => ({ silent: true })
    const started = Date.now()
    const error = await client(200)
      .call('worktree.list')
      .catch((e: unknown) => e)
    expect((error as OrcaRuntimeError).code).toBe('runtime_timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('reports a missing metadata file', async () => {
    const missing = createOrcaRuntimeClient({ userDataCandidates: () => ['/nonexistent/orca'] })
    expect(missing.metadataPath()).toBeNull()
    await expect(missing.call('worktree.list')).rejects.toMatchObject({ code: 'runtime_not_found' })
  })

  it('re-reads orca-runtime.json after Orca restarts (new token and socket)', async () => {
    fake.handler = () => ({ result: 'ok' })
    const c = client()
    await expect(c.call('a')).resolves.toBe('ok')
    await fake.restart()
    await expect(c.call('b')).resolves.toBe('ok')
    // The last request carried the new token.
    expect(fake.requests.at(-1)?.authToken).toBe(fake.authToken)
  })

  it('re-reads metadata on an auth failure', async () => {
    fake.handler = () => ({ result: 'ok' })
    const c = client()
    await c.call('warm-up')
    // Same socket, rotated token: the cached token is now wrong.
    fake.authToken = 'rotated'
    fake.writeMetadata()
    await expect(c.call('again')).resolves.toBe('ok')
    const codes = fake.requests.map((r) => r.authToken)
    expect(codes.slice(-2)).toEqual([expect.not.stringMatching(/^rotated$/), 'rotated'])
  })

  it('never puts the auth token into error messages', async () => {
    fake.handler = () => ({ error: { code: 'internal', message: 'boom' } })
    const error = (await client()
      .call('x')
      .catch((e: unknown) => e)) as Error
    expect(String(error.message)).not.toContain(fake.authToken)
    expect(JSON.stringify(error)).not.toContain(fake.authToken)
  })
})

describe('frame parsing', () => {
  it('accepts legacy single-transport metadata', () => {
    const parsed = parseRuntimeMetadata({
      runtimeId: 'r',
      pid: 1,
      authToken: 't',
      transport: { kind: 'unix', endpoint: '/tmp/x.sock' }
    })
    expect(parsed?.transports).toEqual([{ kind: 'unix', endpoint: '/tmp/x.sock' }])
  })

  it('rejects mismatched ids and flags runtime changes', () => {
    expect(
      interpretFrame('{"id":"b","ok":true,"result":1,"_meta":{"runtimeId":"r"}}', 'a', 'r')
    ).toMatchObject({ ok: false })
    expect(
      interpretFrame('{"id":"a","ok":true,"result":1,"_meta":{"runtimeId":"other"}}', 'a', 'r')
    ).toMatchObject({ ok: false, error: { code: 'runtime_changed' } })
    expect(interpretFrame('not json', 'a', 'r')).toMatchObject({
      ok: false,
      error: { code: 'invalid_runtime_response' }
    })
  })
})

describe('host navigator over the fake runtime', () => {
  it('maps a file to its worktree and sends files.open with a path: selector', async () => {
    const root = '/work/repo'
    fake.handler = (request) => {
      if (request.method === 'worktree.list') {
        return { result: { worktrees: [{ path: root, id: 'r::/work/repo' }], totalCount: 1 } }
      }
      return {
        result: { worktree: 'r::/work/repo', relativePath: 'src/a.ts', kind: 'text', opened: true }
      }
    }
    const navigate = createHostNavigator({ runtime: client() })
    await expect(navigate({ path: '/work/repo/src/a.ts', line: 3, character: 1 })).resolves.toEqual(
      {
        opened: true
      }
    )
    expect(fake.requests.map((r) => r.method)).toEqual(['worktree.list', 'files.open'])
    expect(fake.requests[0]?.params).toEqual({ limit: 1000 })
    expect(fake.requests[1]?.params).toEqual({
      worktree: 'path:/work/repo',
      relativePath: 'src/a.ts',
      navigation: 'host'
    })
  })

  it('returns opened:false with a reason when the runtime is unreachable', async () => {
    await fake.stopServer()
    const navigate = createHostNavigator({ runtime: client(500) })
    const result = await navigate({ path: '/work/repo/a.ts', line: 0, character: 0 })
    expect(result.opened).toBe(false)
    expect(result.reason).toMatch(/runtime_unavailable/)
  })
})

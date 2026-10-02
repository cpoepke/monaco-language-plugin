import { describe, expect, it } from 'vitest'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import { replyToServerRequest } from '../lsp/server-requests'
import { windowsSpawnArgs } from '../lsp/server-spawn'
import { isLoopbackHost, tokensEqual } from './auth'
import { normalizeBridgeOptions } from './bridge-options'

describe('tokensEqual', () => {
  it('accepts only the exact token', () => {
    expect(tokensEqual('s3cret', 's3cret')).toBe(true)
    expect(tokensEqual('s3cret', 's3cre')).toBe(false)
    expect(tokensEqual('s3cret', 's3cret ')).toBe(false)
    expect(tokensEqual('s3cret', '')).toBe(false)
    expect(tokensEqual('s3cret', null)).toBe(false)
    expect(tokensEqual('s3cret', undefined)).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('recognizes loopback forms', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      'localhost',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1'
    ]) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.2', 'example.com', '128.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('normalizeBridgeOptions', () => {
  it('requires a non-empty token', () => {
    expect(() => normalizeBridgeOptions({ port: 0, token: '' })).toThrow(/token/)
  })

  it('refuses non-loopback hosts unless allowRemote', () => {
    expect(() => normalizeBridgeOptions({ port: 0, token: 't', host: '0.0.0.0' })).toThrow(
      /non-loopback/
    )
    expect(
      normalizeBridgeOptions({ port: 0, token: 't', host: '0.0.0.0', allowRemote: true }).host
    ).toBe('0.0.0.0')
  })

  it('requires absolute allowed roots and applies defaults', () => {
    expect(() => normalizeBridgeOptions({ port: 0, token: 't', allowedRoots: ['rel'] })).toThrow(
      /absolute/
    )
    const normalized = normalizeBridgeOptions({ port: 0, token: 't' })
    expect(normalized).toMatchObject({
      host: '127.0.0.1',
      idleShutdownMs: 180_000,
      requestTimeoutMs: 15_000,
      maxSessions: 8,
      hostNavigator: null
    })
  })
})

describe('replyToServerRequest', () => {
  const folders = [{ uri: 'file:///w', name: 'w' }]

  it('answers configuration with one null per item and folders with the root', () => {
    expect(
      replyToServerRequest('workspace/configuration', { items: [{}, {}, {}] }, folders)
    ).toEqual({ result: [null, null, null] })
    expect(replyToServerRequest('workspace/workspaceFolders', null, folders)).toEqual({
      result: folders
    })
  })

  it('acknowledges registrations/progress and refuses everything else', () => {
    expect(replyToServerRequest('client/registerCapability', {}, folders)).toEqual({ result: null })
    expect(replyToServerRequest('window/showMessageRequest', {}, folders)).toEqual({
      result: null
    })
    const refused = replyToServerRequest('workspace/applyEdit', {}, folders)
    expect('error' in refused && refused.error.code).toBe(JsonRpcErrorCodes.MethodNotFound)
  })
})

describe('windowsSpawnArgs', () => {
  it('routes batch shims through cmd.exe with quoted arguments', () => {
    expect(windowsSpawnArgs('C:\\x\\tsls.cmd', ['--stdio', 'a b'], 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\x\\tsls.cmd --stdio "a b""'],
      verbatim: true
    })
  })

  it('spawns executables directly', () => {
    expect(windowsSpawnArgs('C:\\x\\gopls.exe', [])).toEqual({
      command: 'C:\\x\\gopls.exe',
      args: [],
      verbatim: false
    })
  })
})

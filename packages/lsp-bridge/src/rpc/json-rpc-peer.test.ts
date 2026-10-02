import { describe, expect, it } from 'vitest'
import { JsonRpcErrorCodes } from '@mlp/protocol'
import { JsonRpcPeer } from './json-rpc-peer'
import { RpcError } from './rpc-error'

function setup() {
  const sent: Record<string, unknown>[] = []
  const notifications: [string, unknown][] = []
  const internalErrors: unknown[] = []
  const peer = new JsonRpcPeer({
    send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
    onRequest: async (method, params) => {
      switch (method) {
        case 'echo':
          return params
        case 'nothing':
          return undefined
        case 'rpcFail':
          throw new RpcError(JsonRpcErrorCodes.PathNotAllowed, 'nope', { path: '/x' })
        case 'bug':
          throw new Error('boom')
        default:
          throw new RpcError(JsonRpcErrorCodes.MethodNotFound, `Method not found: ${method}`)
      }
    },
    onNotification: (method, params) => {
      if (method === 'throws') {
        throw new Error('notification bug')
      }
      notifications.push([method, params])
    },
    onInternalError: (error) => internalErrors.push(error)
  })
  return { peer, sent, notifications, internalErrors }
}

describe('JsonRpcPeer', () => {
  it('answers requests with their result (undefined becomes null)', async () => {
    const { peer, sent } = setup()
    await peer.handleText(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: [1] }))
    await peer.handleText(JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'nothing' }))
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, result: [1] },
      { jsonrpc: '2.0', id: 'b', result: null }
    ])
  })

  it('replies ParseError with a null id to malformed JSON', async () => {
    const { peer, sent } = setup()
    await peer.handleText('{"jsonrpc": "2.0", "id": 1, "method": ')
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCodes.ParseError, message: 'Parse error' }
      }
    ])
  })

  it('replies InvalidRequest to non-objects, batches, wrong versions and bad ids', async () => {
    const { peer, sent } = setup()
    await peer.handleText('42')
    await peer.handleText('[{"jsonrpc":"2.0","id":1,"method":"echo"}]')
    await peer.handleText('{"jsonrpc":"1.0","id":3,"method":"echo"}')
    await peer.handleText('{"jsonrpc":"2.0","id":{"x":1},"method":"echo"}')
    await peer.handleText('{"jsonrpc":"2.0","id":4,"method":7}')
    expect(sent.map((m) => [m.id, (m.error as { code: number }).code])).toEqual([
      [null, JsonRpcErrorCodes.InvalidRequest],
      [null, JsonRpcErrorCodes.InvalidRequest],
      [3, JsonRpcErrorCodes.InvalidRequest],
      [null, JsonRpcErrorCodes.InvalidRequest],
      [4, JsonRpcErrorCodes.InvalidRequest]
    ])
  })

  it('maps handler errors: RpcError keeps its code/data, anything else is InternalError', async () => {
    const { peer, sent, internalErrors } = setup()
    await peer.handleText('{"jsonrpc":"2.0","id":1,"method":"unknown"}')
    await peer.handleText('{"jsonrpc":"2.0","id":2,"method":"rpcFail"}')
    await peer.handleText('{"jsonrpc":"2.0","id":3,"method":"bug"}')
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: JsonRpcErrorCodes.MethodNotFound, message: 'Method not found: unknown' }
      },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: JsonRpcErrorCodes.PathNotAllowed, message: 'nope', data: { path: '/x' } }
      },
      { jsonrpc: '2.0', id: 3, error: { code: JsonRpcErrorCodes.InternalError, message: 'boom' } }
    ])
    expect(internalErrors).toHaveLength(1)
  })

  it('delivers notifications without replying, and survives a throwing handler', async () => {
    const { peer, sent, notifications, internalErrors } = setup()
    await peer.handleText('{"jsonrpc":"2.0","method":"note","params":{"a":1}}')
    await peer.handleText('{"jsonrpc":"2.0","method":"throws"}')
    expect(notifications).toEqual([['note', { a: 1 }]])
    expect(sent).toEqual([])
    expect(internalErrors).toHaveLength(1)
  })

  it('ignores stray responses and stops sending after close', async () => {
    const { peer, sent } = setup()
    await peer.handleText('{"jsonrpc":"2.0","id":9,"result":true}')
    peer.notify('hello', { x: 1 })
    peer.close()
    peer.notify('dropped')
    await peer.handleText('{"jsonrpc":"2.0","id":1,"method":"echo"}')
    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'hello', params: { x: 1 } }])
  })
})

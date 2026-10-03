import { JsonRpcErrorCodes } from '@mlp/protocol'
import type { JsonRpcError, JsonRpcId, JsonRpcResponse } from '@mlp/protocol'
import { RpcError } from './rpc-error'

/** `id` is the request's JSON-RPC id (for cancellation bookkeeping). */
export type RpcRequestHandler = (method: string, params: unknown, id: JsonRpcId) => unknown
export type RpcNotificationHandler = (method: string, params: unknown) => void

export type JsonRpcPeerOptions = {
  /** Sends one serialized message (one WebSocket text frame). */
  send: (text: string) => void
  /** Returns the result (or a promise of it); throw RpcError to choose the code. */
  onRequest: RpcRequestHandler
  onNotification: RpcNotificationHandler
  /** Called with errors from handlers that are not RpcErrors (bugs). */
  onInternalError?: (error: unknown, method: string) => void
}

type Incoming =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId | null; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function classify(message: unknown): Incoming {
  if (!isRecord(message)) {
    // Why: batches are legal JSON-RPC but not part of this contract (one
    // message per frame), so they get the same answer as any non-object.
    return { kind: 'invalid', id: null, message: 'Expected a single JSON-RPC message object' }
  }
  const id = isValidId(message.id) ? message.id : null
  if (message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id, message: 'jsonrpc must be "2.0"' }
  }
  if (message.method === undefined) {
    if ('result' in message || 'error' in message) {
      return { kind: 'response' }
    }
    return { kind: 'invalid', id, message: 'Missing method' }
  }
  if (typeof message.method !== 'string') {
    return { kind: 'invalid', id, message: 'method must be a string' }
  }
  if (!('id' in message)) {
    return { kind: 'notification', method: message.method, params: message.params }
  }
  if (!isValidId(message.id)) {
    return { kind: 'invalid', id: null, message: 'id must be a string or number' }
  }
  return { kind: 'request', id: message.id, method: message.method, params: message.params }
}

/**
 * Minimal JSON-RPC 2.0 endpoint for one connection. The bridge only answers
 * requests and emits notifications — it never sends requests to clients — so
 * there is no outgoing-request bookkeeping here.
 */
export class JsonRpcPeer {
  private closed = false

  constructor(private readonly options: JsonRpcPeerOptions) {}

  /** Handle one incoming frame. Resolves once any response has been sent. */
  async handleText(text: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.sendError(null, { code: JsonRpcErrorCodes.ParseError, message: 'Parse error' })
      return
    }
    const incoming = classify(parsed)
    switch (incoming.kind) {
      case 'invalid':
        this.sendError(incoming.id, {
          code: JsonRpcErrorCodes.InvalidRequest,
          message: incoming.message
        })
        return
      case 'response':
        // Why: we never issue requests, so a stray response has nothing to settle.
        return
      case 'notification':
        try {
          this.options.onNotification(incoming.method, incoming.params)
        } catch (error) {
          // Why: notifications have no reply channel; a bad one must not take
          // down the connection.
          this.options.onInternalError?.(error, incoming.method)
        }
        return
      case 'request':
        await this.dispatchRequest(incoming.id, incoming.method, incoming.params)
    }
  }

  notify(method: string, params?: unknown): void {
    this.write(
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    )
  }

  /** Stop sending: replies to in-flight requests are dropped after close. */
  close(): void {
    this.closed = true
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params, id)
      // Why: `result` is required on success; undefined would be dropped by JSON.
      this.write({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
    } catch (error) {
      if (error instanceof RpcError) {
        this.sendError(id, error.toJson())
        return
      }
      this.options.onInternalError?.(error, method)
      this.sendError(id, {
        code: JsonRpcErrorCodes.InternalError,
        message: error instanceof Error ? error.message : 'Internal error'
      })
    }
  }

  private sendError(id: JsonRpcId | null, error: JsonRpcError): void {
    this.write({ jsonrpc: '2.0', id, error })
  }

  private write(
    message: JsonRpcResponse | { jsonrpc: '2.0'; method: string; params?: unknown }
  ): void {
    if (this.closed) {
      return
    }
    this.options.send(JSON.stringify(message))
  }
}

import { JsonRpcErrorCodes } from '@mlp/protocol'
import type { JsonRpcError } from '@mlp/protocol'

/** An error that maps 1:1 onto a JSON-RPC error object. Handlers throw these
 *  to choose the code; any other thrown value becomes InternalError. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }

  toJson(): JsonRpcError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data }
  }
}

export function invalidParams(message: string): RpcError {
  return new RpcError(JsonRpcErrorCodes.InvalidParams, message)
}

export function pathNotAllowed(message: string): RpcError {
  return new RpcError(JsonRpcErrorCodes.PathNotAllowed, message)
}

// Adapted from stablyai/orca PR #24703 (MIT). See vendor/orca-lsp.
import { JsonRpcErrorCodes } from '@mlp/protocol'
import type { JsonRpcError } from '@mlp/protocol'
import type { WorkspaceFolder } from './initialize-params'

/** Server→client requests that only need an acknowledgement. Servers block on
 *  some of these (progress tokens, capability registration), so answering null
 *  is what keeps them moving. */
const NULL_RESULT_SERVER_REQUESTS = new Set([
  'client/registerCapability',
  'client/unregisterCapability',
  'window/workDoneProgress/create',
  'window/showMessageRequest',
  'workspace/diagnostic/refresh',
  'workspace/semanticTokens/refresh',
  'workspace/inlayHint/refresh',
  'workspace/inlineValue/refresh',
  'workspace/codeLens/refresh',
  'workspace/foldingRange/refresh'
])

export type ServerRequestReply = { result: unknown } | { error: JsonRpcError }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The bridge is a read-only client: it never applies edits or runs commands,
 *  so anything beyond acknowledgements is refused with MethodNotFound. */
export function replyToServerRequest(
  method: string,
  params: unknown,
  workspaceFolders: readonly WorkspaceFolder[]
): ServerRequestReply {
  if (method === 'workspace/configuration') {
    // Why: one entry per requested item — pyright hangs on a bare null.
    const items = isRecord(params) && Array.isArray(params.items) ? params.items : []
    return { result: items.map(() => null) }
  }
  if (method === 'workspace/workspaceFolders') {
    return { result: workspaceFolders }
  }
  if (NULL_RESULT_SERVER_REQUESTS.has(method)) {
    return { result: null }
  }
  return {
    error: {
      code: JsonRpcErrorCodes.MethodNotFound,
      message: `Unsupported server request: ${method}`
    }
  }
}

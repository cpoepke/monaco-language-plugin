import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { languageIdForPath } from '@mlp/protocol'
import type { ReadFileResult } from '@mlp/protocol'
import { invalidParams, pathNotAllowed } from '../rpc/rpc-error'
import { findContainingRoot, realpathLenient } from './path-policy'

export const MAX_READ_FILE_BYTES = 4 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024

/** Absolute path for a `file:` URI, or an InvalidParams error. */
export function filePathFromUri(uri: unknown): string {
  if (typeof uri !== 'string') {
    throw invalidParams('uri must be a string')
  }
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw invalidParams(`Invalid URI: ${uri}`)
  }
  if (url.protocol !== 'file:') {
    throw invalidParams(`Only file: URIs are supported: ${uri}`)
  }
  // Why: on Windows `file://server/share/x` becomes the UNC path
  // \\server\share\x, and merely touching it (realpath, stat) makes Windows
  // authenticate to that server over SMB, leaking NTLM credentials. Refuse
  // remote hosts before any fs call. (WHATWG URL already folds `localhost`
  // to an empty host.)
  if (url.host !== '' && url.hostname.toLowerCase() !== 'localhost') {
    throw invalidParams(`Remote file URIs are not supported: ${uri}`)
  }
  try {
    return fileURLToPath(url)
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : `Invalid file URI: ${uri}`)
  }
}

function assertReadableFile(info: Stats, requestedPath: string): void {
  if (info.isDirectory()) {
    throw invalidParams(`Not a file: ${requestedPath}`)
  }
  if (!info.isFile()) {
    throw invalidParams(`Not a regular file: ${requestedPath}`)
  }
  if (info.size > MAX_READ_FILE_BYTES) {
    throw invalidParams(`File too large (${info.size} bytes): ${requestedPath}`)
  }
}

/**
 * Read a text file for "peek"/navigation targets the client has no model for.
 * The path is realpath'd before the containment check so neither `..` segments
 * nor symlinks can reach outside `allowedRoots` (which must be realpaths too).
 */
export async function readFileForClient(
  uri: unknown,
  allowedRoots: readonly string[]
): Promise<ReadFileResult> {
  const requestedPath = filePathFromUri(uri)
  // Why native: it expands Windows 8.3 short names (C:\Users\RUNNER~1 → runneradmin) the
  // same way realpathLenient does for the roots; fs.realpathSync's JS version does not.
  const realPath = await realpath(requestedPath).catch(() => null)
  // Why containment first, also for missing files: whether a file outside the roots exists is
  // none of the client's business, and every OS then answers alike (PathNotAllowed).
  if (findContainingRoot(realPath ?? realpathLenient(requestedPath), allowedRoots) === null) {
    throw pathNotAllowed(`Path is outside every allowed root: ${requestedPath}`)
  }
  if (realPath === null) {
    throw invalidParams(`File not found: ${requestedPath}`)
  }
  // Why: stat before open — opening a FIFO for reading would block forever,
  // and opening a directory fails differently per platform.
  assertReadableFile(await stat(realPath), requestedPath)
  const handle = await open(
    realPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = await handle.stat()
    assertReadableFile(opened, requestedPath)
    // Recheck after open: an ancestor directory can be replaced with a symlink
    // between the original realpath check and open. Validate the handle's identity
    // against the newly authorized path before reading any bytes.
    const currentPath = await realpath(realPath)
    if (findContainingRoot(currentPath, allowedRoots) === null) {
      throw pathNotAllowed(`Path changed outside every allowed root: ${requestedPath}`)
    }
    const current = await stat(currentPath)
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw pathNotAllowed(`File changed during authorization: ${requestedPath}`)
    }
    // Bound the actual read as well as stat: a regular file can grow after stat.
    const bytes = Buffer.alloc(MAX_READ_FILE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_READ_FILE_BYTES) {
      throw invalidParams(`File too large: ${requestedPath}`)
    }
    const buffer = bytes.subarray(0, length)
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw invalidParams(`Binary file: ${requestedPath}`)
    }
    return {
      uri: uri as string,
      text: buffer.toString('utf8'),
      languageId: languageIdForPath(realPath)
    }
  } finally {
    await handle.close()
  }
}

import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPathInside } from '../workspace/path-policy'

/**
 * Language servers only ever see realpath URIs (the bridge opens documents
 * under their canonical path), so their results name files by realpath too.
 * A client that opened a document through a symlinked root (or macOS
 * `/tmp` → `/private/tmp`) would then get results that look like other files:
 * same-file jumps open a second tab and host navigation fails to match the
 * worktree. Each opened document tells us how the client's spelling relates to
 * the real one; results are rewritten back with that mapping.
 */
export type PrefixMapping = {
  /** Real directory (a path) that the client reaches under another name. */
  realPrefix: string
  /** The client's URI for that same directory, without a trailing slash. */
  clientPrefixUri: string
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
const MAX_DEPTH = 64
const URI_KEYS = new Set(['uri', 'targetUri', 'target'])

function plainFilePath(uri: string): string | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.protocol !== 'file:' || url.host !== '' || url.search !== '' || url.hash !== '') {
    return null
  }
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

function sameSegment(a: string, b: string): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The directory-level mapping implied by one document opened as `clientUri`
 * and served as `serverUri`. Their common trailing path segments are
 * stripped; what remains are two spellings of one directory. A shared
 * directory *name* does not prove a shared directory (`/w/proj` → `/data/proj`
 * shares `proj`, but `/w` is not `/data`), so the widest candidate whose client
 * side really resolves to the real side wins. Null when both name the same
 * path or no candidate checks out (e.g. a symlinked file rather than a
 * directory: there is nothing below it to map).
 */
export function derivePrefixMapping(
  clientUri: string,
  serverUri: string,
  realpath: (path: string) => string | null = realpathOrNull
): PrefixMapping | null {
  const clientPath = plainFilePath(clientUri)
  const realPath = plainFilePath(serverUri)
  if (clientPath === null || realPath === null || sameSegment(clientPath, realPath)) {
    return null
  }
  const clientSegments = clientPath.split(sep)
  const realSegments = realPath.split(sep)
  // Why: stop before the first non-empty segment so neither prefix collapses
  // to the filesystem root (`/tmp/x` vs `/private/tmp/x` maps /tmp ↔
  // /private/tmp, not / ↔ /private).
  let common = 0
  while (
    common < clientSegments.length - 2 &&
    common < realSegments.length - 2 &&
    sameSegment(
      clientSegments[clientSegments.length - 1 - common] as string,
      realSegments[realSegments.length - 1 - common] as string
    )
  ) {
    common++
  }
  // Why: keep the client's own URI spelling (its percent-encoding, drive
  // letter case) for the prefix; path segments and URI segments line up 1:1.
  const uriParts = clientUri.split('/')
  for (let strip = common; strip >= 1; strip--) {
    const clientPrefix = clientSegments.slice(0, clientSegments.length - strip).join(sep)
    const realPrefix = realSegments.slice(0, realSegments.length - strip).join(sep)
    const resolved = realpath(clientPrefix)
    if (resolved === null || !sameSegment(resolved, realPrefix)) {
      continue
    }
    if (uriParts.length - strip < 4 || uriParts.slice(-strip).some((part) => part === '')) {
      return null
    }
    return { realPrefix, clientPrefixUri: uriParts.slice(0, uriParts.length - strip).join('/') }
  }
  return null
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/** Add or replace (by realPrefix) a mapping in a client's list. */
export function rememberMapping(list: PrefixMapping[], mapping: PrefixMapping): void {
  const index = list.findIndex((m) => m.realPrefix === mapping.realPrefix)
  if (index === -1) {
    list.push(mapping)
  } else {
    list[index] = mapping
  }
}

/** `uri` in the client's spelling, or unchanged when no mapping covers it. */
export function toClientUri(uri: string, mappings: readonly PrefixMapping[]): string {
  if (mappings.length === 0 || !uri.startsWith('file:')) {
    return uri
  }
  const path = plainFilePath(uri)
  if (path === null) {
    return uri
  }
  let best: PrefixMapping | null = null
  for (const mapping of mappings) {
    if (
      isPathInside(path, mapping.realPrefix) &&
      (best === null || mapping.realPrefix.length > best.realPrefix.length)
    ) {
      best = mapping
    }
  }
  if (best === null) {
    return uri
  }
  const rel = relative(best.realPrefix, path)
  if (rel === '') {
    return best.clientPrefixUri
  }
  const relSegments = rel.split(sep)
  // Why: reuse the server's own encoding of the tail when it lines up.
  const uriParts = uri.split('/')
  const tail = uriParts.slice(-relSegments.length)
  const tailText = tail.every((part) => part !== '')
    ? tail.join('/')
    : relSegments.map((segment) => encodeURIComponent(segment)).join('/')
  return `${best.clientPrefixUri}/${tailText}`
}

/** Copy of an LSP result with every `uri`/`targetUri`/`target` file URI
 *  rewritten to the client's spelling. */
export function rewriteResultUris(
  value: unknown,
  mappings: readonly PrefixMapping[],
  depth = 0
): unknown {
  if (mappings.length === 0 || depth > MAX_DEPTH || typeof value !== 'object' || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteResultUris(item, mappings, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      typeof item === 'string' && URI_KEYS.has(key)
        ? toClientUri(item, mappings)
        : rewriteResultUris(item, mappings, depth + 1)
  }
  return out
}

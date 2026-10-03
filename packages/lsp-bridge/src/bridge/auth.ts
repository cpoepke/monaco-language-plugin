import { createHash, timingSafeEqual } from 'node:crypto'

/** Constant-time token comparison. Hashing first makes both inputs the same
 *  length, so neither the comparison nor an early length check leaks how
 *  long the expected token is. */
export function tokensEqual(expected: string, provided: string | null | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) {
    return false
  }
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(provided, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** Hosts that only accept connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

/** The hostname part of a `Host` header (`[::1]:8080` → `::1`). */
function hostnameOfHostHeader(header: string): string {
  const trimmed = header.trim()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    return close === -1 ? trimmed : trimmed.slice(1, close)
  }
  const colon = trimmed.lastIndexOf(':')
  // Why: a bare IPv6 address has several colons and no port.
  return colon !== -1 && trimmed.indexOf(':') === colon ? trimmed.slice(0, colon) : trimmed
}

/** True for a `Host` header naming this machine. A request whose Host is a
 *  public name that resolved to 127.0.0.1 (DNS rebinding) fails this. */
export function isLoopbackHostHeader(header: string | undefined): boolean {
  return typeof header === 'string' && isLoopbackHost(hostnameOfHostHeader(header))
}

/**
 * Browsers attach `Origin` to every WebSocket handshake. Accept none (non-
 * browser clients), `null` (opaque origins), `file://` (Orca's renderer and
 * other local Electron pages) and http(s) pages served from loopback (dev
 * servers). Anything else is some website the user happens to visit.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true
  }
  const value = origin.trim()
  if (value === 'null' || value === 'file://') {
    return true
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname)
}

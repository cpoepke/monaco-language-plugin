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

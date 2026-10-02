import { invalidParams } from './rpc-error'

/** Tiny runtime guards for client params: the wire is untrusted input. */

export function expectRecord(value: unknown, name = 'params'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidParams(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

export function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw invalidParams(`${name} must be a string`)
  }
  return value
}

export function expectNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidParams(`${name} must be a non-negative integer`)
  }
  return value
}

/** Non-throwing variant for notifications, which have no error channel. */
export function readStringFields<K extends string>(
  value: unknown,
  keys: readonly K[]
): Record<K, string> | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const out = {} as Record<K, string>
  for (const key of keys) {
    const field = record[key]
    if (typeof field !== 'string') {
      return null
    }
    out[key] = field
  }
  return out
}

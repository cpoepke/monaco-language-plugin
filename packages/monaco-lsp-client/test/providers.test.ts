import { describe, expect, it } from 'vitest'
import type { CancellationToken } from 'monaco-editor'
import { raceCancellation } from '../src/providers'

function tokenSource() {
  const handlers = new Set<() => void>()
  let cancelled = false
  const token = {
    get isCancellationRequested() {
      return cancelled
    },
    onCancellationRequested(listener: () => void) {
      handlers.add(listener)
      return { dispose: () => handlers.delete(listener) }
    }
  } as unknown as CancellationToken
  return {
    token,
    handlers,
    cancel() {
      cancelled = true
      for (const handler of [...handlers]) handler()
    }
  }
}

describe('raceCancellation', () => {
  it('is the promise itself without a token (nothing left pending)', async () => {
    const promise = Promise.resolve(1)
    expect(raceCancellation(promise, undefined)).toBe(promise)
    await expect(raceCancellation(Promise.reject(new Error('x')), undefined)).rejects.toThrow('x')
  })

  it('settles with the value and disposes its listener', async () => {
    const source = tokenSource()
    expect(await raceCancellation(Promise.resolve('v'), source.token)).toBe('v')
    expect(source.handlers.size).toBe(0)
    await expect(raceCancellation(Promise.reject(new Error('e')), source.token)).rejects.toThrow()
    expect(source.handlers.size).toBe(0)
  })

  it('resolves null on cancellation and disposes its listener', async () => {
    const source = tokenSource()
    const never = new Promise<string>(() => {})
    const raced = raceCancellation(never, source.token)
    expect(source.handlers.size).toBe(1)
    source.cancel()
    expect(await raced).toBeNull()
    expect(source.handlers.size).toBe(0)
    // already cancelled: no listener at all
    expect(await raceCancellation(Promise.reject(new Error('late')), source.token)).toBeNull()
    expect(source.handlers.size).toBe(0)
  })
})

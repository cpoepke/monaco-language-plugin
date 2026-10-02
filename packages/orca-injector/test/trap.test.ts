import { describe, expect, it, vi } from 'vitest'
import { installMonacoTrap, isMonacoApi, withGlobalApi } from '../src/trap'

type G = Record<string, any>

const fakeMonaco = () => ({ editor: {}, languages: {} })
const sync = (fn: () => void) => fn()

describe('MonacoEnvironment trap', () => {
  it('merges globalAPI into an env assigned after the trap and keeps getWorker', () => {
    const g: G = {}
    installMonacoTrap(g, { onCapture() {} }, { schedule: sync })
    expect(g.MonacoEnvironment.globalAPI).toBe(true)
    const getWorker = () => 'worker'
    g.MonacoEnvironment = { getWorker }
    expect(g.MonacoEnvironment.getWorker).toBe(getWorker)
    expect(g.MonacoEnvironment.globalAPI).toBe(true)
    // later mutations of the assigned object persist
    g.MonacoEnvironment.getWorkerUrl = () => 'url'
    expect(g.MonacoEnvironment.getWorkerUrl()).toBe('url')
    expect(g.MonacoEnvironment.getWorker()).toBe('worker')
  })

  it('keeps an env assigned before the trap (worst-case order) and later reassignments', () => {
    const g: G = {}
    const getWorker = () => 'w1'
    const env = { getWorker }
    g.MonacoEnvironment = env
    installMonacoTrap(g, { onCapture() {} }, { schedule: sync })
    expect(g.MonacoEnvironment).toBe(env)
    expect(g.MonacoEnvironment.getWorker).toBe(getWorker)
    expect(g.MonacoEnvironment.globalAPI).toBe(true)
    const getWorker2 = () => 'w2'
    g.MonacoEnvironment = { getWorker: getWorker2, baseUrl: 'x' }
    expect(g.MonacoEnvironment).toMatchObject({
      getWorker: getWorker2,
      baseUrl: 'x',
      globalAPI: true
    })
  })

  it('copies frozen envs instead of mutating them', () => {
    const getWorker = () => 'w'
    const frozen = Object.freeze({ getWorker })
    const merged = withGlobalApi(frozen)
    expect(merged).not.toBe(frozen)
    expect(merged.getWorker).toBe(getWorker)
    expect(merged.globalAPI).toBe(true)
    expect(withGlobalApi(undefined)).toEqual({ globalAPI: true })
  })

  it('survives a non-configurable MonacoEnvironment', () => {
    const g: G = {}
    Object.defineProperty(g, 'MonacoEnvironment', {
      value: { getWorker: () => 1 },
      writable: true,
      configurable: false
    })
    const handle = installMonacoTrap(g, { onCapture() {} }, { schedule: sync })
    expect(handle.envTrapped).toBe(false)
    expect(g.MonacoEnvironment.globalAPI).toBe(true)
  })
})

describe('globalThis.monaco setter trap', () => {
  it('captures the first API object synchronously and calls onReady later', () => {
    const g: G = {}
    const scheduled: (() => void)[] = []
    const onCapture = vi.fn()
    const onReady = vi.fn()
    const handle = installMonacoTrap(
      g,
      { onCapture, onReady },
      { schedule: (fn) => scheduled.push(fn) }
    )
    g.monaco = 42 // not an API object
    expect(onCapture).not.toHaveBeenCalled()
    const first = fakeMonaco()
    g.monaco = first
    expect(onCapture).toHaveBeenCalledWith(first)
    expect(onReady).not.toHaveBeenCalled()
    const second = fakeMonaco()
    g.monaco = second // Monaco assigns twice; first wins
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(g.monaco).toBe(second) // the global still behaves like a normal property
    expect(handle.captured).toBe(first)
    scheduled.forEach((fn) => fn())
    expect(onReady).toHaveBeenCalledWith(first)
  })

  it('captures an already published monaco immediately', () => {
    const g: G = { monaco: fakeMonaco() }
    const onCapture = vi.fn()
    installMonacoTrap(g, { onCapture }, { schedule: sync })
    expect(onCapture).toHaveBeenCalledWith(g.monaco)
  })

  it('is idempotent', () => {
    const g: G = {}
    const a = vi.fn()
    const b = vi.fn()
    const h1 = installMonacoTrap(g, { onCapture: a }, { schedule: sync })
    const h2 = installMonacoTrap(g, { onCapture: b }, { schedule: sync })
    expect(h2).toBe(h1)
    g.monaco = fakeMonaco()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('never throws out of the setter when hooks fail', () => {
    const g: G = {}
    const onError = vi.fn()
    installMonacoTrap(
      g,
      {
        onCapture() {
          throw new Error('boom')
        },
        onReady() {
          throw new Error('later')
        }
      },
      { schedule: sync, onError }
    )
    expect(() => {
      g.monaco = fakeMonaco()
    }).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('recognizes Monaco API objects', () => {
    expect(isMonacoApi(fakeMonaco())).toBe(true)
    expect(isMonacoApi({ editor: {} })).toBe(false)
    expect(isMonacoApi(null)).toBe(false)
  })
})

// @vitest-environment happy-dom
/** Smaller injector modules under unusual inputs: config flags, traps, notices, host adapter. */
import { describe, expect, it, vi } from 'vitest'
import { INJECTOR_VERSION, createLog, readConfig } from '../src/config'
import { createOrcaHostAdapter, MAX_ATTACH_BYTES, shouldAttachModel } from '../src/host-adapter'
import { createNotifier } from '../src/notice'
import { installMonacoTrap, isMonacoApi, withGlobalApi } from '../src/trap'
import { FakeEditor, FakeModel, range } from './fakes'

type G = Record<string, any>

describe('config', () => {
  it('reads the two flags and treats a missing or throwing store as "off"', () => {
    expect(readConfig(null)).toEqual({ disabled: false, debug: false })
    expect(readConfig({ getItem: (k) => (k === 'mlp.debug' ? '1' : null) })).toEqual({
      disabled: false,
      debug: true
    })
    expect(readConfig({ getItem: (k) => (k === 'mlp.disabled' ? '1' : '0') })).toEqual({
      disabled: true,
      debug: false
    })
    expect(
      readConfig({
        getItem: () => {
          throw new Error('SecurityError')
        }
      })
    ).toEqual({ disabled: false, debug: false })
    expect(INJECTOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is silent unless debugging, then prefixes every line', () => {
    const sink = { log: vi.fn(), warn: vi.fn() }
    const quiet = createLog(false, sink)
    quiet.debug('d')
    quiet.warn('w')
    expect(sink.log).not.toHaveBeenCalled()
    expect(sink.warn).not.toHaveBeenCalled()
    const loud = createLog(true, sink)
    loud.debug('d')
    loud.warn('w')
    expect(sink.log).toHaveBeenCalledWith('[mlp] d')
    expect(sink.warn).toHaveBeenCalledWith('[mlp] w')
  })

  it('defaults to the real console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLog(true).debug('hello')
    expect(spy).toHaveBeenCalledWith('[mlp] hello')
    spy.mockRestore()
  })
})

describe('trap', () => {
  const sync = (fn: () => void) => fn()
  const monaco = () => ({ editor: {}, languages: {} })

  it('rejects non-API values', () => {
    expect(isMonacoApi({ editor: null, languages: {} })).toBe(false)
    expect(isMonacoApi({ editor: {}, languages: 'x' })).toBe(false)
    expect(isMonacoApi(undefined)).toBe(false)
    expect(isMonacoApi(5)).toBe(false)
  })

  it('merges globalAPI into non-extensible envs by copying and keeps read-only globalAPI flags false-safe', () => {
    const sealed = Object.seal({ getWorker: () => 1 })
    const merged = withGlobalApi(sealed)
    expect(merged).not.toBe(sealed)
    expect(merged.globalAPI).toBe(true)
    expect(typeof merged.getWorker).toBe('function')
    // an env whose globalAPI is already true is kept as it is
    const already = { globalAPI: true }
    expect(withGlobalApi(already)).toBe(already)
    // a read-only globalAPI:false forces a copy instead of failing
    const readOnly = Object.defineProperty({}, 'globalAPI', { value: false, writable: false })
    expect(withGlobalApi(readOnly).globalAPI).toBe(true)
    expect(withGlobalApi(null)).toEqual({ globalAPI: true })
    expect(withGlobalApi('string')).toEqual({ globalAPI: true })
  })

  it('reports a MonacoEnvironment accessor that throws on read, and still traps monaco', () => {
    const g: G = {}
    Object.defineProperty(g, 'MonacoEnvironment', {
      configurable: true,
      get() {
        throw new Error('hostile getter')
      }
    })
    const onCapture = vi.fn()
    const handle = installMonacoTrap(g, { onCapture }, { schedule: sync })
    expect(handle.envTrapped).toBe(true) // reading it threw inside currentValue(), not fatal
    g.monaco = monaco()
    expect(onCapture).toHaveBeenCalledTimes(1)
  })

  it('does not trap a non-configurable monaco property but captures a published one', () => {
    const published = monaco()
    const g: G = {}
    Object.defineProperty(g, 'monaco', { value: published, configurable: false, writable: false })
    const onCapture = vi.fn()
    installMonacoTrap(g, { onCapture }, { schedule: sync })
    expect(onCapture).toHaveBeenCalledWith(published)
  })

  it('survives a frozen global and a throwing error reporter', () => {
    const g = Object.freeze({}) as G
    const onError = vi.fn(() => {
      throw new Error('reporter bug')
    })
    expect(() =>
      installMonacoTrap(g, { onCapture() {} }, { schedule: sync, onError })
    ).not.toThrow()
    expect(onError).toHaveBeenCalled()
  })

  it('uses a zero-delay timer for onReady by default', () => {
    vi.useFakeTimers()
    try {
      const g: G = {}
      const onReady = vi.fn()
      installMonacoTrap(g, { onCapture() {}, onReady })
      g.monaco = monaco()
      expect(onReady).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(onReady).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes the capture through the handle', () => {
    const g: G = {}
    const handle = installMonacoTrap(g, { onCapture() {} }, { schedule: sync })
    expect(handle.captured).toBeNull()
    const api = monaco()
    g.monaco = api
    expect(handle.captured).toBe(api)
  })
})

describe('notices', () => {
  const notices = () => document.querySelectorAll('[data-mlp-notice]')

  it('tolerates corrupt or throwing session storage', () => {
    document.body.innerHTML = ''
    const corrupt = { getItem: () => '{not json', setItem: () => {} }
    expect(createNotifier(document, corrupt).show({ once: 'a', title: 'A' })).toBe(true)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    const notifier = createNotifier(document, throwing)
    expect(notifier.show({ once: 'b', title: 'B' })).toBe(true)
    expect(notifier.show({ once: 'b', title: 'B again' })).toBe(false) // remembered in memory
  })

  it('waits for the body when the document is still loading', () => {
    const doc = document.implementation.createHTMLDocument('x')
    doc.body.remove()
    const notifier = createNotifier(doc, null)
    expect(notifier.show({ title: 'early', timeoutMs: 100 })).toBe(true)
    expect(doc.querySelectorAll('[data-mlp-notice]')).toHaveLength(0)
    doc.documentElement.appendChild(doc.createElement('body'))
    doc.dispatchEvent(new Event('DOMContentLoaded'))
    expect(doc.querySelectorAll('[data-mlp-notice]')).toHaveLength(1)
  })

  it('renders title only, dismissAll clears sticky and transient notices alike', () => {
    document.body.innerHTML = ''
    const notifier = createNotifier(document, null, () => undefined)
    notifier.show({ once: 'sticky', title: 'T' })
    notifier.show({ title: 'transient', body: 'body', timeoutMs: 1 })
    expect(notices()).toHaveLength(2)
    expect(notices()[0]!.children).toHaveLength(2) // title + dismiss button
    expect(notices()[1]!.children).toHaveLength(3) // title + body + dismiss button
    notifier.dismissAll()
    expect(notices()).toHaveLength(0)
  })

  it('removes a transient notice by its own timer only once', () => {
    document.body.innerHTML = ''
    const timers: (() => void)[] = []
    const notifier = createNotifier(document, null, (fn) => timers.push(fn))
    notifier.show({ title: 'x', timeoutMs: 10 })
    notifier.dismissAll()
    expect(() => timers.forEach((fn) => fn())).not.toThrow()
    expect(notices()).toHaveLength(0)
  })

  it('uses real timers by default', () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = ''
      createNotifier(document, null).show({ title: 'x', timeoutMs: 500 })
      expect(notices()).toHaveLength(1)
      vi.advanceTimersByTime(500)
      expect(notices()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('host adapter', () => {
  function adapter(request: (method: string, params: unknown) => Promise<unknown>) {
    const watcher = {
      expect: vi.fn((t: { uri: string }) => ({ uri: t.uri, key: t.uri, range: range(1), at: 0 })),
      clear: vi.fn(),
      checkAll: vi.fn()
    }
    const notify = vi.fn()
    const log = vi.fn()
    return {
      watcher,
      notify,
      log,
      adapter: createOrcaHostAdapter({ request, watcher, notify, log })
    }
  }

  it('shows a generic reason when Orca declines without one, and for a null answer', async () => {
    const declined = adapter(async () => ({ opened: false }))
    expect(
      await declined.adapter.openLocation(
        { uri: 'file:///repo/b.ts', range: range(1) },
        { editor: null, modelUri: null }
      )
    ).toBe(false)
    expect(declined.notify).toHaveBeenCalledWith(
      'Could not open b.ts',
      'Orca did not open the file.'
    )
    const empty = adapter(async () => null)
    expect(
      await empty.adapter.openLocation(
        { uri: 'file:///repo/c.ts', range: range(1) },
        { editor: null, modelUri: null }
      )
    ).toBe(false)
    expect(empty.notify).toHaveBeenCalledWith('Could not open c.ts', 'Orca did not open the file.')
  })

  it('stringifies non-Error failures and logs them', async () => {
    const failing = adapter(async () => {
      throw 'socket closed'
    })
    await failing.adapter.openLocation(
      { uri: 'file:///repo/b.ts', range: range(1) },
      { editor: null, modelUri: null }
    )
    expect(failing.log).toHaveBeenCalledWith('host/openLocation failed: socket closed')
    expect(failing.notify).toHaveBeenCalledWith('Could not open b.ts', 'socket closed')
  })

  it('names files from decoded uri tails, falling back to the uri', async () => {
    const names: string[] = []
    const failing = adapter(async () => ({ opened: false, reason: 'no' }))
    failing.notify.mockImplementation((title: string) => names.push(title))
    for (const uri of [
      'file:///repo/my%20file.ts?x=1#L4',
      'file:///repo/bad%ZZname.ts',
      'file:///repo/'
    ]) {
      await failing.adapter.openLocation({ uri, range: range(1) }, { editor: null, modelUri: null })
    }
    expect(names).toEqual([
      'Could not open my file.ts',
      'Could not open file:///repo/bad%ZZname.ts',
      'Could not open file:///repo/'
    ])
  })

  it('reveals same-file targets even without a log', async () => {
    const { adapter: bare } = (() => {
      const watcher = { expect: vi.fn(), clear: vi.fn(), checkAll: vi.fn() }
      return {
        adapter: createOrcaHostAdapter({ request: async () => null, watcher, notify: vi.fn() })
      }
    })()
    const editor = new FakeEditor()
    editor.setModel(new FakeModel('file:///repo/a.ts', 'a\nb'))
    expect(
      await bare.openLocation(
        { uri: 'file:///repo/a.ts', range: range(2) },
        { editor, modelUri: 'file:///repo/a.ts' }
      )
    ).toBe(true)
    expect(editor.revealed).toEqual(range(2))
  })

  it('does not treat a missing editor or model uri as "same file"', async () => {
    const { adapter: a, watcher } = adapter(async () => ({ opened: true }))
    const editor = new FakeEditor()
    await a.openLocation({ uri: 'file:///repo/a.ts', range: range(1) }, { editor, modelUri: null })
    await a.openLocation(
      { uri: 'file:///repo/a.ts', range: range(1) },
      { editor: null, modelUri: 'file:///repo/a.ts' }
    )
    expect(watcher.expect).toHaveBeenCalledTimes(2)
  })
})

describe('shouldAttachModel', () => {
  it('allows exactly the size limit', () => {
    const model = (length: number) => ({
      uri: { scheme: 'file' },
      getLanguageId: () => 'typescript',
      getValueLength: () => length
    })
    expect(shouldAttachModel(model(MAX_ATTACH_BYTES))).toBe(true)
    expect(shouldAttachModel(model(MAX_ATTACH_BYTES + 1))).toBe(false)
  })
})

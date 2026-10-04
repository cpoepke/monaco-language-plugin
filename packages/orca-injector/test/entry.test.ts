// @vitest-environment happy-dom
/** `src/index.ts` (the injector's entry script) and the real client factory behind it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { FakeMonaco } from '../../monaco-lsp-client/test/fake-monaco'
import { createClient } from '../src/client-adapter'

const g = globalThis as Record<PropertyKey, unknown>
const TRAP_KEY = Symbol.for('mlp.monacoTrap')

function cleanGlobals(): void {
  for (const key of ['__mlp', 'MonacoEnvironment', 'monaco', TRAP_KEY]) {
    try {
      Reflect.deleteProperty(g, key)
    } catch {
      // not configurable: nothing more to do
    }
  }
}

beforeEach(() => {
  cleanGlobals()
  localStorage.clear()
  vi.resetModules()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../src/boot')
  cleanGlobals()
  localStorage.clear()
})

describe('dist/injector.js entry', () => {
  it('boots against the page globals and exposes only __mlp', async () => {
    await import('../src/index')
    const handle = g.__mlp as {
      version: string
      status(): { disabled: boolean; envTrapped: boolean }
    }
    expect(handle.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(handle.status()).toMatchObject({ disabled: false, envTrapped: true })
    // the traps are live: publishing Monaco is noticed
    expect((g.MonacoEnvironment as { globalAPI?: boolean }).globalAPI).toBe(true)
  })

  it('stays off with mlp.disabled=1', async () => {
    localStorage.setItem('mlp.disabled', '1')
    await import('../src/index')
    expect((g.__mlp as { status(): { disabled: boolean } }).status().disabled).toBe(true)
    expect(g.MonacoEnvironment).toBeUndefined()
  })

  it('never throws out of the script when boot fails, and says so only in debug mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('../src/boot', () => ({
      boot: () => {
        throw new Error('boot exploded')
      }
    }))
    await expect(import('../src/index')).resolves.toBeDefined()
    expect(warn).not.toHaveBeenCalled()

    vi.resetModules()
    localStorage.setItem('mlp.debug', '1')
    vi.doMock('../src/boot', () => ({
      boot: () => {
        throw new Error('boot exploded')
      }
    }))
    await import('../src/index')
    expect(warn).toHaveBeenCalledWith('[mlp] boot failed', expect.any(Error))
  })

  it('also survives a localStorage that throws while reporting the failure', async () => {
    vi.doMock('../src/boot', () => ({
      boot: () => {
        throw new Error('boot exploded')
      }
    }))
    const getter = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is disabled')
      }
    })
    try {
      await expect(import('../src/index')).resolves.toBeDefined()
    } finally {
      if (getter) Object.defineProperty(globalThis, 'localStorage', getter)
    }
  })

  it('boots without storage when reading it throws', async () => {
    const getter = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      }
    })
    try {
      await import('../src/index')
      expect((g.__mlp as { version: string }).version).toBeDefined()
    } finally {
      if (getter) Object.defineProperty(globalThis, 'sessionStorage', getter)
    }
  })

  it('works in a page without requestAnimationFrame', async () => {
    const raf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
    try {
      await import('../src/index')
      expect(g.__mlp).toBeDefined()
    } finally {
      if (raf) Object.defineProperty(globalThis, 'requestAnimationFrame', raf)
    }
  })
})

describe('createClient (the real @mlp/monaco-lsp-client)', () => {
  it('creates a client that keeps Monaco’s built-in TypeScript navigation switched off', async () => {
    const monaco = new FakeMonaco()
    const client = createClient(monaco.asMonaco(), {
      url: async () => 'ws://127.0.0.1:1/?token=none',
      host: { openLocation: async () => true },
      shouldAttachModel: () => true,
      clientName: 'orca-injector/test',
      logger: {}
    })
    try {
      expect(monaco.modeConfiguration).toMatchObject({ definitions: false, hovers: false })
      expect(client.status().connection).toBeDefined()
      expect(typeof client.request).toBe('function')
    } finally {
      client.dispose()
    }
    expect(monaco.modeConfiguration).toMatchObject({ definitions: true, hovers: true })
  })

  it('hands editor-open requests to the host with the source editor and model', async () => {
    const monaco = new FakeMonaco()
    const calls: unknown[] = []
    const client = createClient(monaco.asMonaco(), {
      url: async () => 'ws://127.0.0.1:1/?token=none',
      host: {
        openLocation: async (target, source) => {
          calls.push({ target, source })
          return true
        }
      },
      shouldAttachModel: () => true,
      clientName: 'orca-injector/test',
      logger: {}
    })
    try {
      const model = monaco.createModel('x', 'typescript', URI.file('/repo/a.ts'))
      const editor = monaco.createEditor(model)
      const range = { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 }
      const handled = await monaco.editorOpeners[0]!.openCodeEditor(
        editor,
        URI.file('/repo/b.ts'),
        range
      )
      expect(handled).toBe(true)
      expect(calls).toEqual([
        {
          target: { uri: 'file:///repo/b.ts', range },
          source: { editor, modelUri: model.uri.toString(), reason: expect.anything() }
        }
      ])
    } finally {
      client.dispose()
    }
  })

  it('only attaches the models the injector allows', async () => {
    const monaco = new FakeMonaco()
    const asked: string[] = []
    const client = createClient(monaco.asMonaco(), {
      url: async () => 'ws://127.0.0.1:1/?token=none',
      host: { openLocation: async () => false },
      shouldAttachModel: (model) => {
        asked.push(model.uri.toString())
        return false
      },
      clientName: 'orca-injector/test',
      logger: {}
    })
    try {
      monaco.createEditor(monaco.createModel('x', 'typescript', URI.file('/repo/a.ts')))
      expect(asked).toEqual(['file:///repo/a.ts'])
      expect(client.status().documents).toEqual([])
    } finally {
      client.dispose()
    }
  })
})

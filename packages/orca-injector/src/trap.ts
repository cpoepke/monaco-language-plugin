/**
 * Capture Orca's Monaco instance from a classic script that runs before Orca's module bundle.
 *
 * monaco-editor (0.55 ESM) publishes `globalThis.monaco` when `MonacoEnvironment.globalAPI` is truthy
 * at module-evaluation time (docs/spikes.md Q1). Orca assigns its own `MonacoEnvironment` (with
 * `getWorker`) afterwards — or, in the worst case, before monaco evaluates. An accessor property
 * keeps `globalAPI: true` merged into whatever Orca assigns, and a setter trap on `globalThis.monaco`
 * tells us the moment the API is published.
 */

export type MonacoLike = {
  editor: object
  languages: object
}

export type TrapHooks<M> = {
  /** Called synchronously inside Monaco's assignment (before Orca creates any model). */
  onCapture(monaco: M): void
  /** Called one task later, when `editor.main.js` has added `languages.typescript` & co. */
  onReady?(monaco: M): void
}

export type TrapHandle<M> = {
  readonly captured: M | null
  /** Whether the MonacoEnvironment accessor is in place (false → fell back to a plain value). */
  readonly envTrapped: boolean
}

type Schedule = (fn: () => void) => void

const TRAP_KEY = Symbol.for('mlp.monacoTrap')

export function isMonacoApi(value: unknown): value is MonacoLike {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<MonacoLike>
  return typeof v.editor === 'object' && v.editor !== null && typeof v.languages === 'object'
}

/** Ensure `globalAPI: true` on an environment value while keeping its identity, getWorker etc. */
export function withGlobalApi(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    const env = value as Record<string, unknown>
    if (env.globalAPI === true) return env
    if (Object.isExtensible(env)) {
      try {
        env.globalAPI = true
        if (env.globalAPI === true) return env
      } catch {
        // read-only property → copy below
      }
    }
    const copy = Object.create(Object.getPrototypeOf(env) as object | null) as Record<
      string,
      unknown
    >
    for (const key of Reflect.ownKeys(env)) {
      const desc = Object.getOwnPropertyDescriptor(env, key)
      if (desc) Object.defineProperty(copy, key, { ...desc, configurable: true })
    }
    Object.defineProperty(copy, 'globalAPI', {
      value: true,
      writable: true,
      enumerable: true,
      configurable: true
    })
    return copy
  }
  return { globalAPI: true }
}

function currentValue(g: object, key: string): unknown {
  try {
    return (g as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Install the traps on `g` (globalThis). Idempotent: a second call returns the first handle.
 * Never throws; hook errors are reported through `onError`.
 */
export function installMonacoTrap<M extends MonacoLike>(
  g: object,
  hooks: TrapHooks<M>,
  options: { schedule?: Schedule; onError?: (error: unknown, where: string) => void } = {}
): TrapHandle<M> {
  const store = g as Record<symbol, unknown>
  const existing = store[TRAP_KEY] as TrapHandle<M> | undefined
  if (existing) return existing

  const schedule: Schedule = options.schedule ?? ((fn) => setTimeout(fn, 0))
  const report = (error: unknown, where: string): void => {
    try {
      options.onError?.(error, where)
    } catch {
      // never throw out of the trap
    }
  }

  let captured: M | null = null
  let envTrapped = false

  const capture = (value: unknown): void => {
    if (captured || !isMonacoApi(value)) return
    captured = value as M
    try {
      hooks.onCapture(captured)
    } catch (error) {
      report(error, 'onCapture')
    }
    const ready = hooks.onReady
    if (ready) {
      schedule(() => {
        try {
          ready(captured as M)
        } catch (error) {
          report(error, 'onReady')
        }
      })
    }
  }

  // 1) MonacoEnvironment accessor that merges globalAPI into every assignment.
  try {
    let env = withGlobalApi(currentValue(g, 'MonacoEnvironment'))
    const desc = Object.getOwnPropertyDescriptor(g, 'MonacoEnvironment')
    if (!desc || desc.configurable) {
      Object.defineProperty(g, 'MonacoEnvironment', {
        configurable: true,
        enumerable: true,
        get: () => env,
        set: (value: unknown) => {
          env = withGlobalApi(value)
        }
      })
      envTrapped = true
    } else {
      ;(g as Record<string, unknown>).MonacoEnvironment = env
    }
  } catch (error) {
    report(error, 'MonacoEnvironment')
  }

  // 2) Setter trap on globalThis.monaco (Monaco assigns it twice; the first API object wins).
  try {
    let current = currentValue(g, 'monaco')
    const desc = Object.getOwnPropertyDescriptor(g, 'monaco')
    if (!desc || desc.configurable) {
      Object.defineProperty(g, 'monaco', {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value: unknown) => {
          current = value
          capture(value)
        }
      })
    }
    // Monaco already published (injector loaded late): capture right away.
    capture(current)
  } catch (error) {
    report(error, 'monaco')
  }

  const handle: TrapHandle<M> = {
    get captured() {
      return captured
    },
    get envTrapped() {
      return envTrapped
    }
  }
  try {
    Object.defineProperty(g, TRAP_KEY, { value: handle, configurable: true })
  } catch {
    // ignore
  }
  return handle
}

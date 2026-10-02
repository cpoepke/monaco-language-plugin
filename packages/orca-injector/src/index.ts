/**
 * Entry of `dist/injector.js`: a classic script that Orca's patched index.html loads before its
 * module bundle. It must never throw or break Orca.
 */
import { boot } from './boot'
import { createClient } from './client-adapter'

const safeStorage = (name: 'localStorage' | 'sessionStorage'): Storage | null => {
  try {
    return globalThis[name] ?? null
  } catch {
    return null
  }
}

try {
  boot({
    global: globalThis,
    document: typeof document === 'undefined' ? null : document,
    localStorage: safeStorage('localStorage'),
    sessionStorage: safeStorage('sessionStorage'),
    createClient,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    requestAnimationFrame:
      typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : null,
    console
  })
} catch (error) {
  try {
    if (globalThis.localStorage?.getItem('mlp.debug') === '1')
      console.warn('[mlp] boot failed', error)
  } catch {
    // ignore
  }
}

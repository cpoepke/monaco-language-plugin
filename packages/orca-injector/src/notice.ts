/** Minimal, dismissible toast-like notices (no dependencies, inline styles). */

export type NoticeOptions = {
  /** Notices with the same `once` key are shown at most once per session. */
  once?: string
  title: string
  body?: string
  /** Auto-dismiss after this many ms (default: stays until dismissed). */
  timeoutMs?: number
}

export type Notifier = {
  show(options: NoticeOptions): boolean
  dismissAll(): void
}

const SESSION_KEY = 'mlp.notices'

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>

function readShown(store: SessionStore | null): Set<string> {
  try {
    const raw = store?.getItem(SESSION_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function createNotifier(
  doc: Document | null,
  sessionStore: SessionStore | null,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)
): Notifier {
  const shown = readShown(sessionStore)
  const live = new Set<HTMLElement>()

  const remove = (el: HTMLElement): void => {
    live.delete(el)
    el.remove()
  }

  const mount = (el: HTMLElement): void => {
    if (!doc) return
    const attach = (): void => {
      ;(doc.body ?? doc.documentElement).appendChild(el)
    }
    if (doc.body) attach()
    else doc.addEventListener('DOMContentLoaded', attach, { once: true })
  }

  return {
    show(options) {
      if (!doc) return false
      if (options.once) {
        if (shown.has(options.once)) return false
        shown.add(options.once)
        try {
          sessionStore?.setItem(SESSION_KEY, JSON.stringify([...shown]))
        } catch {
          // storage unavailable: in-memory only
        }
      }
      // Transient notices replace each other.
      for (const el of [...live]) if (!el.dataset.mlpSticky) remove(el)

      const el = doc.createElement('div')
      el.setAttribute('data-mlp-notice', options.once ?? 'transient')
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      if (options.timeoutMs == null) el.dataset.mlpSticky = '1'
      el.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:2147483000',
        'max-width:380px',
        'padding:10px 32px 10px 12px',
        'border-radius:8px',
        'background:rgba(30,30,34,0.94)',
        'color:#f2f2f2',
        'font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
        'box-shadow:0 4px 18px rgba(0,0,0,0.35)',
        'border:1px solid rgba(255,255,255,0.12)'
      ].join(';')
      const title = doc.createElement('div')
      title.style.cssText = 'font-weight:600;margin-bottom:2px'
      title.textContent = options.title
      el.appendChild(title)
      if (options.body) {
        const body = doc.createElement('div')
        body.style.cssText = 'opacity:0.85'
        body.textContent = options.body
        el.appendChild(body)
      }
      const close = doc.createElement('button')
      close.type = 'button'
      close.setAttribute('aria-label', 'Dismiss')
      close.textContent = '×'
      close.style.cssText =
        'position:absolute;top:4px;right:6px;border:0;background:none;color:inherit;' +
        'font-size:16px;line-height:1;cursor:pointer;opacity:0.7;padding:2px 4px'
      close.addEventListener('click', () => remove(el))
      el.appendChild(close)
      live.add(el)
      mount(el)
      if (options.timeoutMs != null) setTimer(() => remove(el), options.timeoutMs)
      return true
    },
    dismissAll() {
      for (const el of [...live]) remove(el)
    }
  }
}

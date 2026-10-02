// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { createNotifier } from '../src/notice'

const notices = () => document.querySelectorAll('[data-mlp-notice]')

beforeEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
})

describe('notices', () => {
  it('shows a keyed notice once per session and can be dismissed', () => {
    const n = createNotifier(document, sessionStorage)
    expect(n.show({ once: 'setup', title: 'Code navigation is not active', body: 'Fix it' })).toBe(
      true
    )
    expect(n.show({ once: 'setup', title: 'again' })).toBe(false)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.textContent).toContain('Fix it')
    ;(notices()[0]!.querySelector('button') as HTMLButtonElement).click()
    expect(notices()).toHaveLength(0)
    // a new notifier in the same session (e.g. after a reload) remembers it
    expect(createNotifier(document, sessionStorage).show({ once: 'setup', title: 'x' })).toBe(false)
  })

  it('auto-dismisses transient notices and replaces older ones', () => {
    const timers: (() => void)[] = []
    const n = createNotifier(document, null, (fn) => timers.push(fn))
    n.show({ once: 'sticky', title: 'sticky' })
    n.show({ title: 'Could not open a.ts', timeoutMs: 6000 })
    n.show({ title: 'Could not open b.ts', timeoutMs: 6000 })
    expect([...notices()].map((e) => e.getAttribute('data-mlp-notice'))).toEqual([
      'sticky',
      'transient'
    ])
    timers.forEach((fn) => fn())
    expect(notices()).toHaveLength(1)
  })

  it('does nothing without a document', () => {
    expect(createNotifier(null, null).show({ title: 'x' })).toBe(false)
  })
})

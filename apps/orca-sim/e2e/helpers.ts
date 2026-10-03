import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page } from '@playwright/test'
import type { OrcaSim } from '../harness/orca-sim.ts'

// Monaco picks Cmd vs Ctrl from the user agent ('Desktop Chrome' is not macOS).
export const MODIFIER = 'Control'

type EditorLike = {
  getModel(): {
    uri: { toString(): string; scheme: string; path: string }
    getLineContent(line: number): string
    getValueLength(): number
  } | null
  getPosition(): { lineNumber: number; column: number } | null
  getSelection(): {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  } | null
  setPosition(p: { lineNumber: number; column: number }): void
  revealLineInCenter(line: number): void
  getScrolledVisiblePosition(p: { lineNumber: number; column: number }): {
    left: number
    top: number
    height: number
  } | null
  getDomNode(): HTMLElement | null
  focus(): void
  trigger(source: string, handlerId: string, payload: unknown): void
}

export type SimWindow = {
  __sim: {
    openFile(filePath: string): void
    closeFile(filePath: string): void
    activateFile(filePath: string): void
    state(): { openFiles: string[]; active: string | null; loaded: string[] }
    editor(): EditorLike | null
    editorFilePath(): string | null
    events(): { type: string; path: string | null; at: number }[]
  }
  __mlp: {
    status(): {
      monacoCaptured: boolean
      bridge: { state: string; port: number | null; hostNavigation: boolean | null }
      client: {
        connection: string | null
        lastError: string | null
        documents: { uri: string; state: string }[]
      }
      pendingReveal: string | null
    }
    monaco: {
      editor: {
        getModels(): {
          uri: { scheme: string; path: string; toString(): string }
          isAttachedToEditor(): boolean
        }[]
      }
    } | null
  }
}

export const fileUri = (abs: string): string => pathToFileURL(abs).href

export async function simState(page: Page): Promise<ReturnType<SimWindow['__sim']['state']>> {
  return page.evaluate(() => (window as unknown as SimWindow).__sim.state())
}

export async function mlpStatus(page: Page): Promise<ReturnType<SimWindow['__mlp']['status']>> {
  return page.evaluate(() => (window as unknown as SimWindow).__mlp.status())
}

/** Open a file the way a user does in Orca (file tree click → store.openFile). */
export async function openFile(page: Page, abs: string): Promise<void> {
  await page.evaluate((p) => (window as unknown as SimWindow).__sim.openFile(p), abs)
  await waitForEditor(page, abs)
}

export async function activateFile(page: Page, abs: string): Promise<void> {
  await page.evaluate((p) => (window as unknown as SimWindow).__sim.activateFile(p), abs)
  await waitForEditor(page, abs)
}

export async function closeFile(page: Page, abs: string): Promise<void> {
  await page.evaluate((p) => (window as unknown as SimWindow).__sim.closeFile(p), abs)
}

/** The active tab's editor shows `abs` with its content loaded. */
export async function waitForEditor(page: Page, abs: string, timeout = 20_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((p) => {
          const sim = (window as unknown as SimWindow).__sim
          const editor = sim.editor()
          return (
            sim.editorFilePath() === p &&
            sim.state().active === p &&
            (editor?.getModel()?.getValueLength() ?? 0) > 0
          )
        }, abs),
      { timeout, message: `editor for ${abs}` }
    )
    .toBe(true)
}

/** Injector connected and the file mirrored to the bridge with a server session. */
export async function waitForAttached(page: Page, abs: string, timeout = 60_000): Promise<void> {
  const uri = fileUri(abs)
  await expect
    .poll(
      async () => {
        const status = await mlpStatus(page)
        const doc = status.client.documents.find((d) => d.uri === uri)
        return `${status.client.connection}/${doc?.state ?? 'none'}`
      },
      { timeout, message: `document ${uri} attached` }
    )
    .toBe('connected/open')
}

export type Cursor = {
  path: string
  line: number
  column: number
  selection: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  } | null
}

export async function cursor(page: Page): Promise<Cursor> {
  return page.evaluate(() => {
    const sim = (window as unknown as SimWindow).__sim
    const editor = sim.editor()
    const position = editor?.getPosition()
    return {
      path: sim.editorFilePath() ?? '',
      line: position?.lineNumber ?? 0,
      column: position?.column ?? 0,
      selection: editor?.getSelection() ?? null
    }
  })
}

/** Viewport coordinates of the middle of `text` on `line` of the active editor. */
export async function locate(page: Page, line: number, text: string) {
  return page.evaluate(
    ({ line, text }) => {
      const editor = (window as unknown as SimWindow).__sim.editor()
      const model = editor?.getModel()
      if (!editor || !model) throw new Error('no active editor')
      const index = model.getLineContent(line).indexOf(text)
      if (index < 0) throw new Error(`"${text}" not found on line ${line}`)
      const column = index + 1 + Math.floor((text.length - 1) / 2)
      editor.revealLineInCenter(line)
      const visible = editor.getScrolledVisiblePosition({ lineNumber: line, column })!
      const box = editor.getDomNode()!.getBoundingClientRect()
      return {
        x: box.left + visible.left + 1,
        y: box.top + visible.top + visible.height / 2,
        position: { lineNumber: line, column }
      }
    },
    { line, text }
  )
}

export async function ctrlClick(page: Page, line: number, text: string): Promise<void> {
  const target = await locate(page, line, text)
  await page.mouse.move(target.x, target.y)
  await page.keyboard.down(MODIFIER)
  await page.mouse.move(target.x + 1, target.y)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up(MODIFIER)
}

/** Put the cursor on `text` and focus the editor. */
export async function placeCursor(page: Page, line: number, text: string): Promise<void> {
  const target = await locate(page, line, text)
  await page.evaluate((position) => {
    const editor = (window as unknown as SimWindow).__sim.editor()!
    editor.setPosition(position)
    editor.focus()
  }, target.position)
}

export async function setCursor(page: Page, lineNumber: number, column: number): Promise<void> {
  await page.evaluate(
    (position) => {
      const editor = (window as unknown as SimWindow).__sim.editor()!
      editor.setPosition(position)
      editor.focus()
    },
    { lineNumber, column }
  )
}

export async function trigger(page: Page, action: string): Promise<void> {
  await page.evaluate((id) => {
    const editor = (window as unknown as SimWindow).__sim.editor()!
    editor.focus()
    editor.trigger('e2e', id, null)
  }, action)
}

export async function modelSchemes(page: Page): Promise<{ uri: string; attached: boolean }[]> {
  return page.evaluate(() =>
    ((window as unknown as SimWindow).__mlp.monaco?.editor.getModels() ?? []).map((m) => ({
      uri: m.uri.toString(),
      attached: m.isAttachedToEditor()
    }))
  )
}

export function lastFilesOpen(sim: OrcaSim) {
  const calls = sim.runtime.callsTo('files.open')
  return calls.at(-1) ?? null
}

export const join = path.join

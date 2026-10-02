/**
 * Cross-file navigation through the real bridge: Ctrl/Cmd+click, hover docs and
 * Peek Definition for every fixture language whose server is installed.
 * Skips (with a message) when the bridge has not been built.
 */
import { existsSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { BRIDGE_CLI } from '../server/demo-api'

type Case = {
  language: string
  root: string
  entry: string
  /** 1-based line of the call in the entry file, and the call text to locate. */
  line: number
  call: string
  target: string
  definitionLine: number
  hoverText: string
}

const CASES: Case[] = [
  {
    language: 'typescript',
    root: 'fixtures/ts',
    entry: 'src/app.ts',
    line: 6,
    call: 'greet(',
    target: 'src/greeter.ts',
    definitionLine: 5,
    hoverText: 'Builds a friendly greeting'
  },
  {
    language: 'python',
    root: 'fixtures/py',
    entry: 'app/main.py',
    line: 4,
    call: 'greet(',
    target: 'app/greeter.py',
    definitionLine: 4,
    hoverText: 'Build a friendly greeting'
  },
  {
    language: 'go',
    root: 'fixtures/go',
    entry: 'main.go',
    line: 11,
    call: 'Greet(',
    target: 'greet/greet.go',
    definitionLine: 7,
    hoverText: 'Greet builds a friendly greeting'
  },
  {
    language: 'rust',
    root: 'fixtures/rust',
    entry: 'src/main.rs',
    line: 7,
    call: 'greet(',
    target: 'src/greeter.rs',
    definitionLine: 4,
    hoverText: 'Builds a friendly greeting'
  }
]

// Line shared by every fixture's definition body; proves the peek shows the other file.
const PEEK_TEXT = 'Hello, '
// Monaco picks Cmd vs Ctrl from the browser's user agent ('Desktop Chrome' is not macOS).
const MODIFIER = 'Control'
const bridgeBuilt = Boolean(process.env.MLP_BRIDGE_URL) || existsSync(BRIDGE_CLI)

type DemoWindow = {
  __demo: {
    editor: import('monaco-editor').editor.IStandaloneCodeEditor
    client: import('@mlp/monaco-lsp-client').MonacoLspClient | null
  }
}

async function openDemo(page: Page, root: string, file: string): Promise<void> {
  await page.goto(`/?root=${encodeURIComponent(root)}&file=${encodeURIComponent(file)}`)
  await expect(page.locator('body[data-ready="true"]')).toBeAttached({ timeout: 120_000 })
}

async function availableLanguages(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { client } = (window as unknown as DemoWindow).__demo
    if (!client) {
      return []
    }
    const hello = await client.ready
    return hello.availableLanguages
  })
}

async function currentDocumentState(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const { client, editor } = (window as unknown as DemoWindow).__demo
    const uri = editor.getModel()?.uri.toString()
    return client?.status().documents.find((doc) => doc.uri === uri)?.state ?? null
  })
}

/** Viewport coordinates of the middle of the called symbol, and its Monaco position. */
async function locateCall(page: Page, line: number, call: string) {
  return page.evaluate(
    ({ line, call }) => {
      const { editor } = (window as unknown as DemoWindow).__demo
      const model = editor.getModel()!
      const index = model.getLineContent(line).indexOf(call)
      if (index < 0) {
        throw new Error(`"${call}" not found on line ${line}`)
      }
      const column = index + 1 + Math.floor((call.length - 1) / 2)
      editor.revealLineInCenter(line)
      const visible = editor.getScrolledVisiblePosition({ lineNumber: line, column })!
      const box = editor.getDomNode()!.getBoundingClientRect()
      return {
        x: box.left + visible.left + 1,
        y: box.top + visible.top + visible.height / 2,
        position: { lineNumber: line, column }
      }
    },
    { line, call }
  )
}

async function editorLocation(page: Page) {
  return page.evaluate(() => {
    const { editor } = (window as unknown as DemoWindow).__demo
    return { path: editor.getModel()?.uri.path ?? '', line: editor.getPosition()?.lineNumber ?? 0 }
  })
}

test.describe('cross-file navigation', () => {
  test.skip(
    !bridgeBuilt,
    `bridge not built (${BRIDGE_CLI} missing): run \`pnpm --filter @mlp/lsp-bridge build\` first`
  )

  for (const testCase of CASES) {
    test(`${testCase.language}: hover, peek and Ctrl+click into ${testCase.target}`, async ({
      page
    }) => {
      await openDemo(page, testCase.root, testCase.entry)
      const languages = await availableLanguages(page)
      test.skip(
        !languages.includes(testCase.language),
        `${testCase.language} language server not installed (bridge reports: ${languages.join(', ') || 'none'})`
      )
      await expect.poll(() => currentDocumentState(page), { timeout: 60_000 }).toBe('open')

      // Hover: the doc comment of the definition in the other file. Servers that are
      // still indexing (gopls, rust-analyzer) may answer empty at first, so re-hover.
      const hover = page.locator('.monaco-hover:not(.hidden)')
      await expect(async () => {
        await page.mouse.move(5, 5)
        await expect(hover).toBeHidden({ timeout: 5_000 })
        const target = await locateCall(page, testCase.line, testCase.call)
        await page.mouse.move(target.x, target.y)
        await expect(hover).toContainText(testCase.hoverText, { timeout: 10_000 })
      }).toPass({ timeout: 180_000, intervals: [1_000, 2_000, 5_000] })
      await page.mouse.move(5, 5)

      // Peek Definition: an inline widget showing the other file's text.
      const peek = page.locator('.peekview-widget')
      await expect(async () => {
        const target = await locateCall(page, testCase.line, testCase.call)
        await page.evaluate((position) => {
          const { editor } = (window as unknown as DemoWindow).__demo
          editor.setPosition(position)
          editor.focus()
          editor.trigger('e2e', 'editor.action.peekDefinition', null)
        }, target.position)
        await expect(peek).toBeVisible({ timeout: 10_000 })
      }).toPass({ timeout: 60_000 })
      const fileName = testCase.target.split('/').pop()!
      await expect(peek.locator('.peekview-title')).toContainText(fileName)
      await expect
        .poll(async () =>
          (await peek.locator('.view-lines').first().innerText()).replace(/ /g, ' ')
        )
        .toContain(PEEK_TEXT)
      await page.keyboard.press('Escape')
      await expect(peek).toBeHidden()

      // Ctrl/Cmd+click: the host adapter opens the definition file at the definition line.
      await expect(async () => {
        const current = await editorLocation(page)
        if (!current.path.endsWith(`/${testCase.entry}`)) {
          await openDemo(page, testCase.root, testCase.entry)
        }
        const target = await locateCall(page, testCase.line, testCase.call)
        await page.mouse.move(target.x, target.y)
        await page.keyboard.down(MODIFIER)
        await page.mouse.move(target.x + 1, target.y)
        await page.mouse.down()
        await page.mouse.up()
        await page.keyboard.up(MODIFIER)
        await expect
          .poll(async () => (await editorLocation(page)).path, { timeout: 10_000 })
          .toMatch(new RegExp(`/${testCase.target.replace(/[.]/g, '\\.')}$`))
      }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] })
      await expect.poll(async () => (await editorLocation(page)).line).toBe(testCase.definitionLine)
      await expect(page.locator('#tree button[aria-current="true"]')).toHaveText(fileName)
      expect(new URL(page.url()).searchParams.get('file')).toBe(testCase.target)
    })
  }
})

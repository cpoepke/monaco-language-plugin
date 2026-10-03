import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BridgeMethods } from '@mlp/protocol'
import type { LspPosition, LspRequestMethod } from '@mlp/protocol'
import { createBridge, resolveLspServerForLanguage } from '../src/index'
import { descendantPids, isPidAlive, pollFor, TestClient } from './helpers/test-client'

/**
 * End-to-end against real language servers and the repo's fixtures. Each case
 * is skipped when its server binary is not installed, so CI without servers
 * stays green. Servers index lazily, so requests are retried (never slept on
 * inside the bridge) until they produce an answer.
 */

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url))
const TOKEN = 'integration-token'
const INDEX_TIMEOUT_MS = 60_000

type Case = {
  language: string
  entry: string
  definitionFile: string
  /** A substring identifying the line with the call, and the token to click. */
  callLine: string
  token: string
  definitionLine: number
  /** Doc comment text expected in hover, or null to skip the hover check. */
  hoverText: string | null
}

const CASES: Case[] = [
  {
    language: 'typescript',
    entry: 'ts/src/app.ts',
    definitionFile: 'ts/src/greeter.ts',
    callLine: "console.log(greet('world'))",
    token: 'greet',
    definitionLine: 4,
    hoverText: 'Builds a friendly greeting'
  },
  {
    language: 'python',
    entry: 'py/app/main.py',
    definitionFile: 'py/app/greeter.py',
    callLine: 'print(greet("world"))',
    token: 'greet',
    definitionLine: 3,
    hoverText: 'Build a friendly greeting'
  },
  {
    language: 'go',
    entry: 'go/main.go',
    definitionFile: 'go/greet/greet.go',
    callLine: 'greet.Greet("world")',
    token: 'Greet(',
    definitionLine: 6,
    hoverText: 'Greet builds a friendly greeting'
  },
  {
    language: 'rust',
    entry: 'rust/src/main.rs',
    definitionFile: 'rust/src/greeter.rs',
    callLine: 'greet("world")',
    token: 'greet(',
    definitionLine: 3,
    hoverText: 'Builds a friendly greeting'
  }
]

const availability = new Map(
  CASES.map((c) => [c.language, resolveLspServerForLanguage(c.language).server])
)
const skipped = CASES.filter((c) => !availability.get(c.language)).map((c) => c.language)
if (skipped.length > 0) {
  console.log(`[lsp-bridge integration] skipped (server not found): ${skipped.join(', ')}`)
}

function positionOf(text: string, lineNeedle: string, token: string): LspPosition {
  const lines = text.split('\n')
  const line = lines.findIndex((l) => l.includes(lineNeedle))
  if (line === -1) throw new Error(`line not found: ${lineNeedle}`)
  const start = (lines[line] as string).indexOf(lineNeedle)
  const character = (lines[line] as string).indexOf(token, start)
  // Click one character into the identifier, like a user would.
  return { line, character: character + 1 }
}

type LocationLike = {
  uri?: string
  range?: { start: LspPosition }
  targetUri?: string
  targetSelectionRange?: { start: LspPosition }
}

function firstLocation(result: unknown): { uri: string; line: number } | null {
  const items = (Array.isArray(result) ? result : result ? [result] : []) as LocationLike[]
  const item = items[0]
  if (!item) return null
  const uri = item.targetUri ?? item.uri
  const start = (item.targetSelectionRange ?? item.range)?.start
  return uri && start ? { uri, line: start.line } : null
}

function hoverMarkdown(result: unknown): string {
  const contents = (result as { contents?: unknown } | null)?.contents
  const parts = Array.isArray(contents) ? contents : contents ? [contents] : []
  return parts
    .map((part) => (typeof part === 'string' ? part : ((part as { value?: string }).value ?? '')))
    .join('\n')
}

/** Retry `request` until `accept` returns a value; servers answer empty (or
 *  "content modified") while they are still indexing. */
async function retryUntil<T>(
  request: () => Promise<unknown>,
  accept: (result: unknown) => T | null,
  what: string
): Promise<T> {
  let last: unknown = null
  return pollFor(
    async () => {
      try {
        last = await request()
        return accept(last)
      } catch (error) {
        last = error
        return null
      }
    },
    INDEX_TIMEOUT_MS,
    `${what} (last: ${JSON.stringify(last instanceof Error ? last.message : last)})`,
    500
  )
}

describe('integration with real language servers', () => {
  for (const testCase of CASES) {
    const server = availability.get(testCase.language)
    it.skipIf(!server)(
      `${testCase.language}: go-to-definition across files and hover (${server?.serverId ?? 'missing'})`,
      async () => {
        const bridge = createBridge({ port: 0, token: TOKEN, allowedRoots: [FIXTURES] })
        const { port } = await bridge.listen()
        let pids: number[] = []
        try {
          const client = await TestClient.connectAndHello(port, TOKEN)
          const entryPath = join(FIXTURES, testCase.entry)
          const text = readFileSync(entryPath, 'utf8')
          const opened = await client.openDocument(entryPath, testCase.language, text)
          if (opened.sessionId === null) throw new Error(opened.reason)
          expect(opened.serverId).toBe(server?.serverId)
          expect(opened.rootPath).toBe(join(FIXTURES, testCase.entry.split('/')[0] as string))
          const sessionId = opened.sessionId
          const params = {
            textDocument: { uri: pathToFileURL(entryPath).toString() },
            position: positionOf(text, testCase.callLine, testCase.token)
          }
          const lsp = (method: LspRequestMethod) => () =>
            client.request(BridgeMethods.lspRequest, { sessionId, method, params })

          const location = await retryUntil(
            lsp('textDocument/definition'),
            (result) => {
              const loc = firstLocation(result)
              return loc && loc.uri.endsWith(testCase.definitionFile) ? loc : null
            },
            `${testCase.language} definition`
          )
          expect(decodeURIComponent(location.uri)).toMatch(
            new RegExp(`${testCase.definitionFile}$`)
          )
          expect(location.line).toBe(testCase.definitionLine)

          if (testCase.hoverText) {
            const markdown = await retryUntil(
              lsp('textDocument/hover'),
              (result) => {
                const value = hoverMarkdown(result)
                return value.includes(testCase.hoverText as string) ? value : null
              },
              `${testCase.language} hover`
            )
            expect(markdown).toContain(testCase.hoverText)
          }

          // The definition target can be read back for a peek view.
          const read = await client.request<{ text: string; languageId: string }>(
            BridgeMethods.readFile,
            { uri: location.uri }
          )
          expect(read.languageId).toBe(testCase.language)
          await client.close()
        } finally {
          pids = bridge.serverPids()
          const descendants = pids.flatMap((pid) => descendantPids(pid))
          await bridge.close()
          for (const pid of pids) {
            expect(isPidAlive(pid)).toBe(false)
          }
          // Helpers (tsserver, gopls workers) leave with their process group.
          await pollFor(
            () => (descendants.some((pid) => isPidAlive(pid)) ? null : true),
            5000,
            `descendants of ${testCase.language} server to exit`
          )
        }
        expect(pids.length).toBe(1)
      },
      INDEX_TIMEOUT_MS * 2
    )
  }
})

const tsServer = availability.get('typescript')

describe.skipIf(!tsServer || process.platform === 'win32')('symlinked roots (real server)', () => {
  it(
    'answers definitions in the client spelling of a symlinked project',
    async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'mlp-symlink-int-')))
      const real = join(base, 'real-ts')
      const link = join(base, 'linked-ts')
      cpSync(join(FIXTURES, 'ts'), real, { recursive: true })
      symlinkSync(real, link)
      const bridge = createBridge({ port: 0, token: TOKEN })
      const { port } = await bridge.listen()
      try {
        const client = await TestClient.connectAndHello(port, TOKEN)
        const entryPath = join(link, 'src', 'app.ts')
        const text = readFileSync(entryPath, 'utf8')
        const opened = await client.openDocument(entryPath, 'typescript', text)
        if (opened.sessionId === null) throw new Error(opened.reason)
        expect(opened.rootPath).toBe(real)
        const sessionId = opened.sessionId
        const params = {
          textDocument: { uri: pathToFileURL(entryPath).toString() },
          position: positionOf(text, "console.log(greet('world'))", 'greet')
        }
        const location = await retryUntil(
          () =>
            client.request(BridgeMethods.lspRequest, {
              sessionId,
              method: 'textDocument/definition',
              params
            }),
          (result) => {
            const loc = firstLocation(result)
            return loc && loc.uri.endsWith('greeter.ts') ? loc : null
          },
          'definition through a symlinked root'
        )
        expect(location.uri).toBe(pathToFileURL(join(link, 'src', 'greeter.ts')).toString())
        await client.close()
      } finally {
        await bridge.close()
        rmSync(base, { recursive: true, force: true })
      }
    },
    INDEX_TIMEOUT_MS * 2
  )
})

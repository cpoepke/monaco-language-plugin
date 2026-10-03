/**
 * End-to-end navigation through the whole shipped chain inside the Orca simulation:
 * patched index.html → injector → window.api.plugins.invokeCommand → plugin worker (real
 * dist/main.mjs in a child process with Orca's env) → bridge → language server → host navigator →
 * runtime RPC `files.open` → renderer opens a tab → injector reveals the range.
 */
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { OrcaSim } from '../harness/orca-sim.ts'
import { CASES, hostHasBinary } from './cases.ts'
import {
  activateFile,
  closeFile,
  ctrlClick,
  cursor,
  fileUri,
  lastFilesOpen,
  locate,
  modelSchemes,
  openFile,
  placeCursor,
  setCursor,
  simState,
  trigger,
  waitForAttached,
  waitForEditor
} from './helpers.ts'

// Line shared by every fixture's definition body; proves a preview shows the other file.
const DEFINITION_BODY_TEXT = 'Hello, '

for (const c of CASES) {
  test.describe(`${c.language}`, () => {
    test.describe.configure({ mode: 'serial' })
    test.skip(!hostHasBinary(c.binary), `${c.binary} is not installed on this machine`)

    const entry = path.join(c.root, c.entry)
    const target = path.join(c.root, c.target)
    const targetName = path.basename(c.target)
    let sim: OrcaSim

    test.beforeAll(async ({ browser }) => {
      sim = await OrcaSim.launch(browser, { verbose: process.env.ORCA_SIM_VERBOSE === '1' })
    })

    test.afterAll(async () => {
      await sim?.close()
    })

    test.afterEach(async ({}, testInfo) => {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('orca-sim', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              invokes: sim.invokes,
              runtimeCalls: sim.runtime.calls,
              pluginLogs: sim.pluginHost.logs.slice(-80),
              pageErrors: sim.pageErrorStacks,
              console: sim.consoleLines.slice(-80),
              events: await sim.page
                .evaluate(() =>
                  (window as unknown as { __sim: { events(): unknown } }).__sim.events()
                )
                .catch(() => null)
            },
            null,
            2
          )
        })
      }
    })

    test('connects through the plugin and shows hover docs from the other file', async () => {
      const page = sim.page
      await openFile(page, entry)
      await waitForAttached(page, entry, 120_000)
      expect(sim.invokes[0]).toMatchObject({ commandId: 'mlp.ensureBridge', ok: true })

      const hover = page.locator('.monaco-hover:not(.hidden)')
      await expect(async () => {
        await page.mouse.move(5, 5)
        await expect(hover).toBeHidden({ timeout: 5_000 })
        const at = await locate(page, c.line, c.call)
        await page.mouse.move(at.x, at.y)
        await expect(hover).toContainText(c.hoverText, { timeout: 10_000 })
      }).toPass({ timeout: 120_000, intervals: [1_000, 2_000, 5_000] })
      await page.mouse.move(5, 5)
    })

    test('Peek Definition previews the unopened file through an mlp-peek model', async () => {
      const page = sim.page
      const peek = page.locator('.peekview-widget')
      await expect(async () => {
        await placeCursor(page, c.line, c.call)
        await trigger(page, 'editor.action.peekDefinition')
        await expect(peek).toBeVisible({ timeout: 10_000 })
      }).toPass({ timeout: 60_000 })
      await expect(peek.locator('.peekview-title')).toContainText(targetName)
      await expect
        .poll(async () =>
          (await peek.locator('.view-lines').first().innerText()).replace(/ /g, ' ')
        )
        .toContain(DEFINITION_BODY_TEXT)
      const models = await modelSchemes(page)
      expect(models.map((m) => m.uri)).toContain(`mlp-peek:${new URL(fileUri(target)).pathname}`)
      expect(models.map((m) => m.uri)).not.toContain(fileUri(target))
      // Opening from the peek (double-click in its preview) goes through Orca like Ctrl+click.
      const opensBefore = sim.runtime.callsTo('files.open').length
      const preview = peek.locator('.preview .view-lines').first()
      await preview.locator('.view-line', { hasText: DEFINITION_BODY_TEXT }).first().dblclick()
      await expect.poll(async () => (await simState(page)).active).toBe(target)
      expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore + 1)
      await waitForEditor(page, target)
      await expect(peek).toBeHidden()
      // Back to the entry file; close the target so the next test opens it fresh.
      await closeFile(page, target)
      await activateFile(page, entry)
    })

    test('Ctrl+click opens the definition file through files.open and reveals the symbol', async () => {
      const page = sim.page
      const opensBefore = sim.runtime.callsTo('files.open').length
      await expect(async () => {
        if ((await simState(page)).active !== entry) await activateFile(page, entry)
        await ctrlClick(page, c.line, c.call)
        await expect
          .poll(async () => (await simState(page)).active, { timeout: 10_000 })
          .toBe(target)
      }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] })

      const call = lastFilesOpen(sim)
      expect(call?.params).toEqual({
        worktree: `path:${c.root}`,
        relativePath: c.target,
        navigation: 'host'
      })
      expect(call?.ok).toBe(true)
      expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore + 1)
      expect(sim.runtime.callsTo('worktree.list').length).toBeGreaterThan(0)

      await waitForEditor(page, target)
      await expect.poll(async () => (await cursor(page)).line).toBe(c.definitionLine)
      // Still there after Orca's post-mount work has settled (the reveal wins).
      await page.waitForTimeout(400)
      const after = await cursor(page)
      expect(after.path).toBe(target)
      expect(after.line).toBe(c.definitionLine)
      expect(after.selection?.startLineNumber).toBe(c.definitionLine)
      expect((await simState(page)).openFiles).toEqual([entry, target])
    })

    test('same-file definition reveals in the same editor without calling files.open', async () => {
      const page = sim.page
      const opensBefore = sim.runtime.callsTo('files.open').length
      await waitForAttached(page, target)
      await setCursor(page, 1, 1)
      await expect(async () => {
        await ctrlClick(page, c.sameFileLine, c.sameFileCall)
        await expect
          .poll(async () => (await cursor(page)).line, { timeout: 5_000 })
          .toBe(c.definitionLine)
      }).toPass({ timeout: 60_000 })
      expect((await cursor(page)).path).toBe(target)
      expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore)
    })

    test('F12 focuses the existing tab and the reveal beats Orca restoring the saved cursor', async () => {
      const page = sim.page
      // Leave the target at 1:1; Orca snapshots that selection when its editor unmounts and
      // restores it one frame after the next mount.
      await setCursor(page, 1, 1)
      await activateFile(page, entry)
      const opensBefore = sim.runtime.callsTo('files.open').length
      await placeCursor(page, c.line, c.call)
      await page.keyboard.press('F12')
      await expect.poll(async () => (await simState(page)).active).toBe(target)
      expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore + 1)
      expect((await simState(page)).openFiles).toEqual([entry, target])
      await waitForEditor(page, target)
      await expect.poll(async () => (await cursor(page)).line).toBe(c.definitionLine)
      await page.waitForTimeout(400)
      expect((await cursor(page)).line).toBe(c.definitionLine)
    })

    test('after closing the target tab, Ctrl+click opens it again', async () => {
      const page = sim.page
      await closeFile(page, target)
      await waitForEditor(page, entry)
      // Orca disposes the closed tab's model.
      await expect
        .poll(async () => (await modelSchemes(page)).some((m) => m.uri === fileUri(target)))
        .toBe(false)
      const opensBefore = sim.runtime.callsTo('files.open').length
      await expect(async () => {
        await ctrlClick(page, c.line, c.call)
        await expect
          .poll(async () => (await simState(page)).active, { timeout: 10_000 })
          .toBe(target)
      }).toPass({ timeout: 30_000 })
      expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore + 1)
      await waitForEditor(page, target)
      await expect.poll(async () => (await cursor(page)).line).toBe(c.definitionLine)
      await page.waitForTimeout(400)
      expect((await cursor(page)).line).toBe(c.definitionLine)
      expect(sim.pageErrors).toEqual([])
    })
  })
}

/**
 * Orca-specific behaviour on the TypeScript fixture: the plugin worker's environment, Monaco's
 * built-in TS navigation being replaced (not stacked), opening from the peek tree, and recovery
 * after the plugin worker dies.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { OrcaSim } from '../harness/orca-sim.ts'
import { CASES, hostHasBinary } from './cases.ts'
import {
  activateFile,
  closeFile,
  ctrlClick,
  cursor,
  locate,
  mlpStatus,
  openFile,
  placeCursor,
  simState,
  trigger,
  waitForAttached,
  waitForEditor,
  type SimWindow
} from './helpers.ts'

const c = CASES.find((x) => x.language === 'typescript')!
const entry = path.join(c.root, c.entry)
const target = path.join(c.root, c.target)

test.describe('orca integration (typescript)', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!hostHasBinary(c.binary), `${c.binary} is not installed on this machine`)

  let sim: OrcaSim

  test.beforeAll(async ({ browser }) => {
    sim = await OrcaSim.launch(browser, { verbose: process.env.ORCA_SIM_VERBOSE === '1' })
    await openFile(sim.page, entry)
    await waitForAttached(sim.page, entry, 120_000)
  })

  test.afterAll(async () => {
    await sim?.close()
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      console.log(
        'FAILDIAG',
        JSON.stringify({
          runtimeCalls: sim.runtime.calls.slice(-6),
          events: await sim.page.evaluate(() =>
            (window as unknown as SimWindow).__sim.events().slice(-12)
          ),
          console: sim.consoleLines.slice(-20),
          errors: sim.pageErrorStacks
        })
      )
    }
  })

  test('the plugin runs in a worker with Orca’s scrubbed environment and finds the runtime', async () => {
    const pid = sim.pluginHost.pid
    expect(pid).not.toBeNull()
    if (process.platform === 'linux') {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      const keys = env.map((entry) => entry.slice(0, entry.indexOf('=')))
      expect(env).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(keys).not.toContain('SECRET_TOKEN')
      expect(keys).not.toContain('XDG_CONFIG_HOME')
      expect(keys).not.toContain('ORCA_USER_DATA_PATH')
      expect(keys).not.toContain('MLP_ORCA_USER_DATA')
    }
    const status = await mlpStatus(sim.page)
    expect(status.monacoCaptured).toBe(true)
    // hostNavigation: the worker found <userData>/orca-runtime.json three levels above its root.
    expect(status.bridge).toMatchObject({ state: 'available', hostNavigation: true })
    expect(sim.invokes.every((i) => i.commandId === 'mlp.ensureBridge' && i.ok)).toBe(true)
  })

  test('Monaco’s built-in TS navigation is off: one hover and one definition', async () => {
    const page = sim.page
    // With greeter.ts loaded as a model the TS worker could resolve the import itself.
    await openFile(page, target)
    await activateFile(page, entry)
    const mode = await page.evaluate(() => {
      const m = (window as unknown as SimWindow).__mlp.monaco as unknown as {
        languages: {
          typescript?: { typescriptDefaults: { modeConfiguration: Record<string, boolean> } }
        }
      }
      return m.languages.typescript?.typescriptDefaults.modeConfiguration ?? null
    })
    expect(mode).toMatchObject({ definitions: false, references: false, hovers: false })

    const hover = page.locator('.monaco-hover:not(.hidden)')
    await expect(async () => {
      await page.mouse.move(5, 5)
      const at = await locate(page, c.line, c.call)
      await page.mouse.move(at.x, at.y)
      await expect(hover).toContainText(c.hoverText, { timeout: 10_000 })
    }).toPass({ timeout: 60_000 })
    const hoverText = await hover.innerText()
    expect(hoverText.split(c.hoverText).length - 1).toBe(1)
    await page.mouse.move(5, 5)

    const peek = page.locator('.peekview-widget')
    await placeCursor(page, c.line, c.call)
    await trigger(page, 'editor.action.peekDefinition')
    await expect(peek).toBeVisible()
    await expect(peek.locator('.peekview-title')).toContainText('(1)')
    await expect(peek.locator('.ref-tree .monaco-list-row')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(peek).toBeHidden()
  })

  test('double-clicking the peek result opens the file in Orca and reveals it', async () => {
    const page = sim.page
    await closeFile(page, target)
    await waitForEditor(page, entry)
    const peek = page.locator('.peekview-widget')
    await placeCursor(page, c.line, c.call)
    await trigger(page, 'editor.action.peekDefinition')
    await expect(peek).toBeVisible()
    const opensBefore = sim.runtime.callsTo('files.open').length
    await peek.locator('.ref-tree .monaco-list-row').first().dblclick()
    await expect.poll(async () => (await simState(page)).active).toBe(target)
    expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore + 1)
    await waitForEditor(page, target)
    await expect.poll(async () => (await cursor(page)).line).toBe(c.definitionLine)
    await expect(peek).toBeHidden()
  })

  test('after the plugin worker dies, the injector reconnects and navigation works again', async () => {
    const page = sim.page
    await activateFile(page, entry)
    const before = await mlpStatus(page)
    const invokesBefore = sim.invokes.length
    const killedPid = sim.pluginHost.kill()
    expect(killedPid).not.toBeNull()

    // The bridge (and its servers) died with the worker: the client reconnects, which re-invokes
    // mlp.ensureBridge; Orca restarted the worker, which starts a new bridge on a new port.
    await expect
      .poll(
        async () => {
          const status = await mlpStatus(page)
          return (
            status.client.connection === 'connected' && status.bridge.port !== before.bridge.port
          )
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    expect(sim.pluginHost.pid).not.toBe(killedPid)
    expect(
      sim.invokes.slice(invokesBefore).some((i) => i.commandId === 'mlp.ensureBridge' && i.ok)
    ).toBe(true)
    await waitForAttached(page, entry)

    await closeFile(page, target)
    await waitForEditor(page, entry)
    const opensBefore = sim.runtime.callsTo('files.open').length
    await expect(async () => {
      await ctrlClick(page, c.line, c.call)
      await expect.poll(async () => (await simState(page)).active, { timeout: 10_000 }).toBe(target)
    }).toPass({ timeout: 60_000 })
    expect(sim.runtime.callsTo('files.open').length).toBe(opensBefore + 1)
    await expect.poll(async () => (await cursor(page)).line).toBe(c.definitionLine)
  })
})

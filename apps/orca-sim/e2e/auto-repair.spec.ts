/**
 * Self-repair after an Orca update: the update replaces app.asar with a pristine (unpatched)
 * build, so the renderer starts without the injector and nothing calls the plugin. Orca starts the
 * worker for the manifest's `agent.status.changed` event; the worker finds its own install,
 * re-patches app.asar in place and tells the user to restart. After the "restart" (loading the
 * re-patched renderer) Ctrl+click navigation works again.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as asar from '@electron/asar'
import { expect, test } from '@playwright/test'
import { OrcaSim } from '../harness/orca-sim.ts'
import { ASAR_PATH, UPDATE_ASAR, UPDATE_ORCA_VERSION } from '../harness/paths.ts'
import { CASES, hostHasBinary } from './cases.ts'
import { ctrlClick, cursor, openFile, simState, waitForAttached, waitForEditor } from './helpers.ts'

const c = CASES.find((x) => x.language === 'typescript')!
const entry = path.join(c.root, c.entry)
const target = path.join(c.root, c.target)

type VersionJson = { injectorVersion: string; orcaVersion: string; patchedBy?: string }

function readPatch(asarPath: string): { blocks: number; version: VersionJson | null } {
  asar.uncache(asarPath)
  const html = asar.extractFile(asarPath, 'out/renderer/index.html').toString('utf8')
  let version: VersionJson | null = null
  try {
    version = JSON.parse(asar.extractFile(asarPath, 'out/renderer/mlp/version.json').toString())
  } catch {
    version = null
  }
  return { blocks: html.split('<!-- mlp:begin -->').length - 1, version }
}

function extractRenderer(asarPath: string, dest: string): string {
  asar.uncache(asarPath)
  fs.rmSync(dest, { recursive: true, force: true })
  asar.extractAll(asarPath, dest)
  return path.join(dest, 'out', 'renderer', 'index.html')
}

test.describe('auto-repair after an Orca update', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!hostHasBinary(c.binary), `${c.binary} is not installed on this machine`)

  let root: string
  let install: string
  let asarPath: string
  let sim: OrcaSim

  test.beforeAll(async ({ browser }) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-sim-update-'))
    // The patched sim install (app.asar + the CLI's backup), as `monaco-lsp-orca install` left it.
    install = path.join(root, 'Orca')
    fs.cpSync(path.dirname(ASAR_PATH), path.join(install, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(install, 'orca-ide'), '#!/bin/sh\n')
    asarPath = path.join(install, 'resources', 'app.asar')
    expect(readPatch(asarPath).blocks).toBe(1)
    // Orca auto-update: a fresh, unpatched 1.4.215 app.asar.
    fs.copyFileSync(UPDATE_ASAR, asarPath)
    expect(readPatch(asarPath)).toEqual({ blocks: 0, version: null })

    sim = await OrcaSim.launch(browser, {
      verbose: process.env.ORCA_SIM_VERBOSE === '1',
      indexHtml: extractRenderer(asarPath, path.join(root, 'renderer-unpatched')),
      workerEnvExtra: {
        // The sim's worker runs under plain node; this stands in for Orca's process.execPath.
        MLP_ORCA_EXEC_PATH: path.join(install, 'orca-ide'),
        // Keep config.json / self-repair.json out of the real home.
        MONACO_LSP_ORCA_HOME: path.join(root, 'home')
      }
    })
  })

  test.afterAll(async () => {
    await sim?.close()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      console.log(
        'FAILDIAG',
        JSON.stringify({
          pluginLogs: sim.pluginHost.logs.slice(-40),
          hostCalls: sim.pluginHost.hostCalls,
          invokes: sim.invokes,
          console: sim.consoleLines.slice(-20)
        })
      )
    }
  })

  test('an agent event starts the worker, which re-patches app.asar and asks for a restart', async () => {
    // The updated renderer has no injector: the plugin is never called and no worker runs.
    expect(await sim.page.evaluate(() => '__mlp' in window)).toBe(false)
    await sim.page.waitForTimeout(500)
    expect(sim.invokes).toEqual([])
    expect(sim.pluginHost.pid).toBeNull()

    await sim.pluginHost.dispatchEvent('agent.status.changed', {
      worktreeId: null,
      paneKey: 'pane-1',
      state: 'working',
      receivedAt: Date.now()
    })
    expect(sim.pluginHost.pid).not.toBeNull()

    await expect
      .poll(() => readPatch(asarPath).blocks, { timeout: 60_000, message: 'app.asar re-patched' })
      .toBe(1)
    expect(readPatch(asarPath).version).toMatchObject({
      orcaVersion: UPDATE_ORCA_VERSION,
      patchedBy: 'cpoepke.monaco-lsp'
    })
    const shipped = fs.readFileSync(path.join(sim.pluginRoot, 'assets', 'injector.js'), 'utf8')
    expect(readPatch(asarPath).version?.injectorVersion).toBe(
      /@mlp\/orca-injector v([^\s*]+)/.exec(shipped)?.[1]
    )
    await expect
      .poll(() => sim.pluginHost.hostCalls.filter((call) => call.method === 'notifications.show'))
      .toEqual([
        {
          method: 'notifications.show',
          params: {
            title: 'Code Navigation (LSP)',
            body: `Code navigation was re-enabled after the Orca update (v${UPDATE_ORCA_VERSION}). Restart Orca to activate it.`
          }
        }
      ])
    // The backup now holds the pristine 1.4.215, so `uninstall` would restore the new version.
    const backupMeta = JSON.parse(fs.readFileSync(`${asarPath}.mlp-backup.json`, 'utf8'))
    expect(backupMeta.orcaVersion).toBe(UPDATE_ORCA_VERSION)
    expect(fs.existsSync(`${asarPath}.mlp-lock`)).toBe(false)
  })

  test('after a restart onto the re-patched app.asar, Ctrl+click navigation works again', async () => {
    const page = sim.page
    await sim.loadRenderer(extractRenderer(asarPath, path.join(root, 'renderer-patched')))
    await openFile(page, entry)
    await waitForAttached(page, entry, 120_000)
    await expect(async () => {
      if ((await simState(page)).active !== entry) await openFile(page, entry)
      await ctrlClick(page, c.line, c.call)
      await expect.poll(async () => (await simState(page)).active, { timeout: 10_000 }).toBe(target)
    }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] })
    await waitForEditor(page, target)
    await expect.poll(async () => (await cursor(page)).line).toBe(c.definitionLine)
    const status = (await sim.pluginHost.invokeCommand('mlp.status', { silent: true })) as {
      patch: { state: string; orcaVersion: string; lastRepair: { action: string } | null }
    }
    expect(status.patch).toMatchObject({
      state: 'patched',
      orcaVersion: UPDATE_ORCA_VERSION,
      lastRepair: { action: 'patched' }
    })
  })

  test('mlp.repairPatch on an already patched install is a no-op', async () => {
    asar.uncache(asarPath)
    const before = fs.readFileSync(asarPath)
    const result = await sim.pluginHost.invokeCommand('mlp.repairPatch')
    expect(result).toMatchObject({ state: 'patched', action: 'none' })
    expect((result as { message: string }).message).toMatch(/nothing to repair/)
    expect(fs.readFileSync(asarPath).equals(before)).toBe(true)
    expect(sim.pluginHost.hostCalls.at(-1)).toMatchObject({
      method: 'notifications.show',
      params: { body: expect.stringMatching(/nothing to repair/) }
    })
  })
})

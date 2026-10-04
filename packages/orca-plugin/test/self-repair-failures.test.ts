/**
 * Self-repair failure paths: unreadable installs, elevation, lock and backup errors, unsupported
 * builds, signing failures, stale pending archives. Effects run against a fake Orca install;
 * the few failures a real file system cannot produce on demand are injected through the core.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inspectAsar,
  pendingPaths,
  readPending,
  sha256File,
  writePending,
  writeUserConfig
} from '@mlp/orca-patch-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeOrca, makeFakeOrca, packFakeOrca } from '../../orca-patcher/test/fake-orca'
import {
  createSelfRepair,
  spawnDetachedHelper,
  type HelperLaunch,
  type SelfRepairDeps
} from '../src/self-repair/self-repair'
import { pollFor } from '../../lsp-bridge/test/helpers/test-client'

const hooks = vi.hoisted(() => ({
  current: {} as Record<string, ((...args: never[]) => unknown) | undefined>
}))

vi.mock('@mlp/orca-patch-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mlp/orca-patch-core')>()
  const wrap = <K extends keyof typeof actual>(name: K) =>
    ((...args: unknown[]) => {
      const override = hooks.current[name as string]
      return (override ?? (actual[name] as (...a: unknown[]) => unknown))(...(args as never[]))
    }) as (typeof actual)[K]
  return {
    ...actual,
    acquirePatchLock: wrap('acquirePatchLock'),
    ensureBackup: wrap('ensureBackup'),
    buildPatchedArchive: wrap('buildPatchedArchive'),
    adHocSign: wrap('adHocSign'),
    writeJsonAtomic: wrap('writeJsonAtomic'),
    loadInjector: wrap('loadInjector'),
    readAppPackage: wrap('readAppPackage')
  }
})

const fakes: FakeOrca[] = []
beforeEach(() => {
  hooks.current = {}
})
afterEach(() => {
  hooks.current = {}
  for (const f of fakes.splice(0)) fs.rmSync(f.root, { recursive: true, force: true })
})

type Harness = {
  f: FakeOrca
  notes: string[]
  logs: string[]
  launches: HelperLaunch[]
  deps: SelfRepairDeps
}

async function harness(
  opts: Parameters<typeof makeFakeOrca>[0] = {},
  overrides: Partial<SelfRepairDeps> = {}
): Promise<Harness> {
  const f = await makeFakeOrca(opts)
  fakes.push(f)
  writeUserConfig(f.stateDir, { autoRepair: true })
  const pluginRoot = path.join(f.root, 'userData', 'plugins', 'cpoepke.monaco-lsp', 'abc')
  fs.mkdirSync(path.join(pluginRoot, 'assets'), { recursive: true })
  fs.copyFileSync(f.injectorPath, path.join(pluginRoot, 'assets', 'injector.js'))
  const launches: HelperLaunch[] = []
  const deps: SelfRepairDeps = {
    execPath: path.join(f.appDir, 'orca-ide'),
    platform: 'linux',
    env: {},
    homedir: path.join(f.root, 'home'),
    pluginRoot,
    parentPid: 1,
    pluginVersion: '0.1.0',
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawnHelper: (launch) => {
      launches.push(launch)
      return 4242
    },
    ...overrides
  }
  return { f, notes: [], logs: [], launches, deps }
}

function start(h: Harness, overrides: Partial<SelfRepairDeps> = {}, attach = true) {
  const repair = createSelfRepair({ ...h.deps, ...overrides })
  const line = (level: string) => (message: string, meta?: Record<string, unknown>) =>
    void h.logs.push(`${level}: ${message} ${meta ? JSON.stringify(meta) : ''}`)
  if (attach) {
    repair.attach({
      notify: (body) => void h.notes.push(body),
      log: { debug: () => {}, info: line('info'), warn: line('warn'), error: line('error') }
    })
  }
  return repair
}

const errno = (code: string, message = code) => Object.assign(new Error(message), { code })

describe('status()', () => {
  it('reports an install it cannot find', async () => {
    const h = await harness()
    const status = start(h, { execPath: path.join(h.f.root, 'elsewhere', 'node') }).status()
    expect(status).toMatchObject({
      state: 'not-found',
      orcaVersion: null,
      injectorVersion: null,
      autoRepair: true,
      lastRepair: null
    })
    expect(status.asarPath).toBe(path.join(h.f.root, 'elsewhere', 'resources', 'app.asar'))
    const none = start(h, { execPath: 'orca-ide' }).status()
    expect(none).toMatchObject({ state: 'not-found', asarPath: null })
  })

  it('recognises other Electron apps', async () => {
    const h = await harness({ name: 'electron', version: '33.0.0' })
    expect(start(h).status()).toMatchObject({ state: 'not-orca', orcaVersion: '33.0.0' })
  })

  it('tells a current patch from an outdated one and a pending one from none', async () => {
    const h = await harness()
    const { install } = await import('../../orca-patcher/src/install')
    fs.writeFileSync(h.f.injectorPath, '/*! @mlp/orca-injector v9.9.8 */\n;0\n')
    await install(h.f.options)
    fs.writeFileSync(h.f.injectorPath, '/*! @mlp/orca-injector v9.9.9 */\n;0\n')
    fs.copyFileSync(h.f.injectorPath, path.join(h.deps.pluginRoot!, 'assets', 'injector.js'))
    expect(start(h).status()).toMatchObject({ state: 'outdated', injectorVersion: '9.9.8' })

    // unpatched with a parked archive: pending
    const fresh = await harness()
    expect(start(fresh).status().state).toBe('unpatched')
    writePending(fresh.f.asarPath, fresh.f.asarPath, {
      baseSha256: await sha256File(fresh.f.asarPath),
      orcaVersion: '1.4.214',
      injectorVersion: '9.9.9',
      waitPid: 1,
      createdAt: new Date().toISOString()
    })
    expect(start(fresh).status().state).toBe('pending')
  })

  it('degrades to "unknown" instead of throwing when the archive is unreadable', async () => {
    const h = await harness()
    hooks.current.readAppPackage = () => {
      throw new Error('EIO')
    }
    expect(start(h).status()).toMatchObject({ state: 'unknown', asarPath: null, orcaVersion: null })
  })

  it('shows the last repair after a manual check', async () => {
    const h = await harness()
    const repair = start(h)
    await repair.check({ forced: true, trigger: 'command' })
    expect(repair.status().lastRepair).toMatchObject({ trigger: 'command', action: 'patched' })
  })
})

describe('checks that cannot proceed', () => {
  it('works before the host attached a log and notifier', async () => {
    const h = await harness({ name: 'electron' })
    const report = await start(h, {}, false).check({ forced: true, trigger: 'command' })
    expect(report.state).toBe('not-orca')
    expect(h.notes).toEqual([])
  })

  it('skips when the plugin folder has no usable injector', async () => {
    const noRoot = await harness({}, { pluginRoot: null })
    expect(await start(noRoot).check({ forced: true, trigger: 'command' })).toMatchObject({
      state: 'no-injector',
      action: 'none',
      message: expect.stringContaining('no assets/injector.js')
    })

    const unknown = await harness()
    hooks.current.loadInjector = () => ({ version: 'unknown', source: '' })
    expect((await start(unknown).check({ forced: false, trigger: 'activate' })).state).toBe(
      'no-injector'
    )

    const broken = await harness()
    hooks.current.loadInjector = () => {
      throw errno('ENOENT')
    }
    expect((await start(broken).check({ forced: false, trigger: 'activate' })).state).toBe(
      'no-injector'
    )
    expect(inspectAsar(broken.f.asarPath).injectedBlocks).toBe(0)
  })

  it('treats a file that is no asar archive as "not Orca" and leaves it alone', async () => {
    const h = await harness()
    fs.writeFileSync(h.f.asarPath, 'this is not an asar archive')
    const report = await start(h).check({ forced: true, trigger: 'command' })
    expect(report.state).toBe('not-orca')
    expect(fs.readFileSync(h.f.asarPath, 'utf8')).toBe('this is not an asar archive')
  })

  it('reports an archive that throws while being read as a failure, once per Orca version', async () => {
    const h = await harness()
    hooks.current.readAppPackage = () => {
      throw new Error('EIO: read failed')
    }
    const report = await start(h).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'error', action: 'failed' })
    expect(report.message).toContain(
      'could not be re-enabled automatically (Error: EIO: read failed)'
    )
    expect(h.notes).toHaveLength(1)
    // the failure is remembered, not repeated on every start
    await start(h).check({ forced: false, trigger: 'activate' })
    expect(h.notes).toHaveLength(1)
    hooks.current.readAppPackage = undefined
    expect(start(h).status().lastRepair).toMatchObject({ state: 'error', action: 'failed' })
  })

  it('does not lose the repair when the state file cannot be written', async () => {
    const h = await harness()
    hooks.current.writeJsonAtomic = () => {
      throw errno('EROFS')
    }
    const report = await start(h).check({ forced: true, trigger: 'command' })
    expect(report).toMatchObject({ state: 'patched', action: 'patched' })
    expect(h.logs.some((l) => l.includes('could not save state'))).toBe(true)
  })
})

describe('write failures', () => {
  it.each(['EACCES', 'EROFS', 'EPERM'])(
    '%s on the patch lock asks for an elevated install',
    async (code) => {
      const h = await harness()
      hooks.current.acquirePatchLock = () => {
        throw errno(code)
      }
      const report = await start(h).check({ forced: false, trigger: 'activate' })
      expect(report).toMatchObject({ state: 'unpatched', action: 'needs-elevation' })
      expect(report.message).toContain('monaco-lsp-orca install --app')
    }
  )

  it('any other lock error is a failure', async () => {
    const h = await harness()
    hooks.current.acquirePatchLock = () => {
      throw new Error('ENOSPC: no space left')
    }
    const report = await start(h).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'error', action: 'failed' })
    expect(report.message).toContain('ENOSPC')
  })

  it('a read-only backup location asks for an elevated install and leaves no lock behind', async () => {
    const h = await harness()
    hooks.current.ensureBackup = async () => {
      throw errno('EACCES')
    }
    const report = await start(h).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ action: 'needs-elevation' })
    expect(fs.existsSync(`${h.f.asarPath}.mlp-lock`)).toBe(false)
    expect(inspectAsar(h.f.asarPath).injectedBlocks).toBe(0)
  })

  it('a backup that fails otherwise is a failure, reported with its first line only', async () => {
    const h = await harness()
    hooks.current.ensureBackup = async () => {
      throw new Error('disk full\nat stack frame one\nat stack frame two')
    }
    const report = await start(h).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'error', action: 'failed' })
    expect(report.message).toContain('(disk full)')
    expect(report.message).not.toContain('stack frame')
  })

  it('an archive that cannot be rebuilt is a failure; a missing anchor means unsupported', async () => {
    const failed = await harness()
    hooks.current.buildPatchedArchive = async () => {
      throw 'plain string failure'
    }
    expect(await start(failed).check({ forced: false, trigger: 'activate' })).toMatchObject({
      action: 'failed',
      message: expect.stringContaining('plain string failure')
    })

    const unsupported = await harness()
    const { PatcherError } = await import('@mlp/orca-patch-core')
    hooks.current.buildPatchedArchive = async () => {
      throw new PatcherError('anchor gone', 1 as never, 'anchor-missing')
    }
    expect(await start(unsupported).check({ forced: false, trigger: 'activate' })).toMatchObject({
      state: 'unsupported',
      action: 'none'
    })
  })

  it('a replace that fails for another reason is a failure and keeps the old archive', async () => {
    const h = await harness()
    const before = await sha256File(h.f.asarPath)
    const report = await start(h, {
      replaceAsar: () => {
        throw errno('EIO', 'EIO: i/o error')
      }
    }).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'error', action: 'failed' })
    expect(await sha256File(h.f.asarPath)).toBe(before)
    expect(fs.existsSync(`${h.f.asarPath}.mlp-lock`)).toBe(false)
  })

  it('EROFS on the final replace asks for an elevated install', async () => {
    const h = await harness()
    const report = await start(h, {
      replaceAsar: () => {
        throw errno('EROFS')
      }
    }).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ action: 'needs-elevation' })
  })
})

describe('macOS signing', () => {
  async function macHarness() {
    const h = await harness()
    const bundle = path.join(h.f.root, 'Orca.app')
    const resources = path.join(bundle, 'Contents', 'Resources')
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
    fs.cpSync(path.join(h.f.appDir, 'resources'), resources, { recursive: true })
    return {
      h,
      overrides: {
        platform: 'darwin' as const,
        execPath: path.join(bundle, 'Contents', 'MacOS', 'Orca')
      }
    }
  }

  it('reports a failed ad-hoc signature in the notification, using its first line', async () => {
    const { h, overrides } = await macHarness()
    hooks.current.adHocSign = async () => {
      throw new Error('codesign: object file format unrecognized\nmore detail')
    }
    const report = await start(h, overrides).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'patched', action: 'patched' })
    expect(report.message).toContain(
      'Re-signing Orca.app failed (codesign: object file format unrecognized)'
    )
    expect(report.message).not.toContain('more detail')
  })

  it('stringifies a signing failure that is not an Error', async () => {
    const { h, overrides } = await macHarness()
    hooks.current.adHocSign = async () => {
      throw 'denied'
    }
    const report = await start(h, overrides).check({ forced: false, trigger: 'activate' })
    expect(report.message).toContain('Re-signing Orca.app failed (denied)')
  })
})

describe('pending archives', () => {
  async function park(h: Harness) {
    const report = await start(h, {
      replaceAsar: () => {
        throw errno('EBUSY')
      }
    }).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'pending' })
    expect(h.launches).toHaveLength(1)
  }

  it('starts a new helper when a valid pending archive has none running', async () => {
    const h = await harness()
    await park(h)
    // the first helper died: a later worker finds the archive without a helper lock
    const report = await start(h).check({ forced: false, trigger: 'agent.status.changed' })
    expect(report).toMatchObject({ state: 'pending', action: 'none' })
    expect(h.launches).toHaveLength(2)
    expect(h.logs.some((l) => l.includes('pending archive has no helper; starting one'))).toBe(true)
    expect(readPending(h.f.asarPath)).not.toBeNull()
  })

  it('drops a pending archive that Orca outgrew and patches the new version', async () => {
    const h = await harness()
    await park(h)
    await packFakeOrca(h.f.root, h.f.appDir, { version: '1.4.216' }) // Orca updated again
    const report = await start(h).check({ forced: false, trigger: 'activate' })
    expect(report).toMatchObject({ state: 'patched', action: 'patched' })
    expect(h.logs.some((l) => l.includes('dropping a stale pending archive'))).toBe(true)
    expect(fs.existsSync(pendingPaths(h.f.asarPath).archive)).toBe(false)
    expect(inspectAsar(h.f.asarPath)).toMatchObject({ injectedBlocks: 1, orcaVersion: '1.4.216' })
  })
})

describe('spawnDetachedHelper', () => {
  it('starts the script with Orca’s binary in Node mode and the documented arguments', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-spawn-'))
    try {
      const out = path.join(dir, 'out.json')
      const script = path.join(dir, 'helper.mjs')
      fs.writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }))
`
      )
      const pid = spawnDetachedHelper({
        script,
        asarPath: path.join(dir, 'app.asar'),
        waitPid: 1234,
        logFile: path.join(dir, 'helper.log')
      })
      expect(typeof pid).toBe('number')
      const written = await pollFor(
        () =>
          fs.existsSync(out) && fs.readFileSync(out, 'utf8') ? fs.readFileSync(out, 'utf8') : null,
        10_000,
        'helper output'
      )
      expect(JSON.parse(written)).toEqual({
        argv: [
          '--asar',
          path.join(dir, 'app.asar'),
          '--wait-pid',
          '1234',
          '--log',
          path.join(dir, 'helper.log')
        ],
        node: '1'
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

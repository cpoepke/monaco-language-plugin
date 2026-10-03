import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/orca-api'
import { PLUGIN_KEY, PLUGIN_VERSION } from '../src/version'
import { pluginManifestSchema, satisfiesOrcaEngineRange } from './orca-manifest-schema'

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Record<string, unknown>

const manifestRaw = readJson('../orca-plugin.json')
const packageJson = readJson('../package.json')

describe('orca-plugin.json', () => {
  it("validates against Orca's manifest schema", () => {
    const parsed = pluginManifestSchema.safeParse(manifestRaw)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  it('has the expected identity and entry point', () => {
    const manifest = pluginManifestSchema.parse(manifestRaw)
    expect(`${manifest.publisher}.${manifest.id}`).toBe(PLUGIN_KEY)
    expect(manifest.name).toBe('Code Navigation (LSP)')
    expect(manifest.main).toBe('dist/main.mjs')
    expect(manifest.pluginApi).toBe(1)
    expect(satisfiesOrcaEngineRange('1.4.214', manifest.engines.orca)).toBe(true)
  })

  it('keeps versions in sync', () => {
    expect(manifestRaw.version).toBe(PLUGIN_VERSION)
    expect(packageJson.version).toBe(PLUGIN_VERSION)
  })

  it('declares exactly the commands the worker registers', () => {
    const manifest = pluginManifestSchema.parse(manifestRaw)
    expect(manifest.contributes.commands.map((command) => command.id).sort()).toEqual(
      Object.values(COMMANDS).sort()
    )
    // Why: a command with `action` is a declarative alias and never reaches the worker.
    expect(manifest.contributes.commands.every((command) => command.action === undefined)).toBe(
      true
    )
  })

  it('asks only for notifications and worktree events', () => {
    const manifest = pluginManifestSchema.parse(manifestRaw)
    expect(manifest.capabilities).toEqual([
      { kind: 'notifications:show' },
      { kind: 'events:subscribe' }
    ])
    // Why: worktree.removed must revoke the bridge's access to that tree.
    expect(manifest.contributes.events).toEqual([
      { on: 'worktree.created' },
      { on: 'worktree.removed' }
    ])
  })

  it('rejects broken manifests (schema sanity)', () => {
    expect(pluginManifestSchema.safeParse({ ...manifestRaw, id: 'Monaco_LSP' }).success).toBe(false)
    expect(pluginManifestSchema.safeParse({ ...manifestRaw, main: '../escape.mjs' }).success).toBe(
      false
    )
    expect(
      pluginManifestSchema.safeParse({ ...manifestRaw, engines: { orca: '^1.4.0' } }).success
    ).toBe(false)
    expect(
      pluginManifestSchema.safeParse({ ...manifestRaw, capabilities: [{ kind: 'net:fetch' }] })
        .success
    ).toBe(false)
    const { main: _main, ...withoutMain } = manifestRaw
    expect(pluginManifestSchema.safeParse(withoutMain).success).toBe(false)
  })
})

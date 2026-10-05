import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readTrustedWorkspaces, setWorkspaceTrust } from '../src/workspace-trust.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'mlp-trust-')))
  dirs.push(base)
  const workspace = path.join(base, 'workspace')
  const state = path.join(base, 'state')
  mkdirSync(workspace)
  mkdirSync(state)
  return { base, workspace, state }
}
it('requires explicit trust and supports revocation', () => {
  const { state, workspace } = fixture()
  expect(readTrustedWorkspaces(state)).toEqual([])
  setWorkspaceTrust(state, workspace, true)
  expect(readTrustedWorkspaces(state)).toEqual([workspace])
  setWorkspaceTrust(state, workspace, false)
  expect(readTrustedWorkspaces(state)).toEqual([])
})
it('fails closed on malformed storage', () => {
  const { state } = fixture()
  for (const data of ['{', '{}', '[".",1,null]']) {
    writeFileSync(path.join(state, 'trusted-workspaces.json'), data)
    expect(readTrustedWorkspaces(state)).toEqual([])
  }
})
it.skipIf(process.platform === 'win32')(
  'does not transfer trust through a replaced symlink',
  () => {
    const { state, workspace, base } = fixture()
    setWorkspaceTrust(state, workspace, true)
    renameSync(workspace, path.join(base, 'old'))
    mkdirSync(path.join(base, 'other'))
    symlinkSync(path.join(base, 'other'), workspace)
    expect(readTrustedWorkspaces(state)).toEqual([])
  }
)

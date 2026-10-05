import path from 'node:path'
import { fs } from './fs.js'
import { readJson, writeJsonAtomic } from './fsutil.js'

const TRUST_FILE = 'trusted-workspaces.json'

/** Kept outside repositories. Malformed/missing trust storage grants nothing. */
export function readTrustedWorkspaces(stateDir: string): string[] {
  const raw = readJson<unknown>(path.join(stateDir, TRUST_FILE))
  if (!Array.isArray(raw)) return []
  return raw.filter((root): root is string => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return false
    try {
      // A formerly trusted directory replaced with a symlink must not transfer
      // its trust to another repository.
      return fs.realpathSync(root) === root && fs.statSync(root).isDirectory()
    } catch {
      return false
    }
  })
}

export function setWorkspaceTrust(stateDir: string, workspace: string, trusted: boolean): string {
  const requested = path.resolve(workspace)
  const root = trusted ? fs.realpathSync(requested) : requested
  if (trusted && !fs.statSync(root).isDirectory())
    throw new Error('Workspace must be an existing directory')
  const roots = new Set(readTrustedWorkspaces(stateDir))
  if (trusted) roots.add(root)
  else {
    roots.delete(root)
    try {
      roots.delete(fs.realpathSync(root))
    } catch {
      /* Removed directories can still be revoked. */
    }
  }
  writeJsonAtomic(path.join(stateDir, TRUST_FILE), [...roots])
  return root
}

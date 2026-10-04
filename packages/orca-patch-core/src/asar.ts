import { fs } from './fs.js'
import path from 'node:path'
import * as asar from '@electron/asar'
import { PatcherError } from './errors.js'

export type AsarEntry = {
  /** Posix path relative to the archive root. */
  path: string
  type: 'file' | 'directory' | 'link'
  unpacked: boolean
  size?: number
  executable?: boolean
  link?: string
}

type HeaderNode = {
  files?: Record<string, HeaderNode>
  link?: string
  size?: number
  unpacked?: boolean
  executable?: boolean
}

/** Drop @electron/asar's per-path header cache (it would serve stale data after we replace a file). */
export function uncache(asarPath: string): void {
  try {
    asar.uncache(asarPath)
  } catch {
    // not cached
  }
}

/** All entries of an archive keyed by posix path, read from its header (no extraction). */
export function readEntries(asarPath: string): Map<string, AsarEntry> {
  uncache(asarPath)
  let header: HeaderNode
  try {
    header = (asar.getRawHeader(asarPath) as unknown as { header: HeaderNode }).header
  } catch (error) {
    // Why: a truncated or non-asar file otherwise surfaces as a bare RangeError/stack trace.
    throw new PatcherError(
      `${asarPath} is not a readable asar archive (${error instanceof Error ? error.message : String(error)}). ` +
        'The file may be truncated or damaged; reinstall Orca, or run `monaco-lsp-orca uninstall` ' +
        'to restore a backup. Nothing was changed.',
      undefined,
      'unexpected-layout'
    )
  }
  const out = new Map<string, AsarEntry>()
  const walk = (node: HeaderNode, prefix: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const rel = prefix ? `${prefix}/${name}` : name
      if (child.files) {
        out.set(rel, { path: rel, type: 'directory', unpacked: child.unpacked === true })
        walk(child, rel)
      } else if (typeof child.link === 'string') {
        out.set(rel, {
          path: rel,
          type: 'link',
          unpacked: child.unpacked === true,
          link: child.link
        })
      } else {
        out.set(rel, {
          path: rel,
          type: 'file',
          unpacked: child.unpacked === true,
          size: child.size ?? 0,
          executable: child.executable === true
        })
      }
    }
  }
  walk(header, '')
  return out
}

/**
 * An archive-internal posix path in the form @electron/asar's lookups expect: they split on the
 * host's `path.sep`, so on Windows `out/renderer/index.html` must be passed as
 * `out\renderer\index.html` (the header itself is separator-free: one node per segment).
 */
export function toAsarLookupPath(relPosix: string, sep: string = path.sep): string {
  return relPosix.split('/').join(sep)
}

/** Read one file from the archive (packed or unpacked); null when missing or not a file. */
export function readAsarFile(asarPath: string, rel: string): Buffer | null {
  uncache(asarPath)
  try {
    return asar.extractFile(asarPath, toAsarLookupPath(rel))
  } catch {
    return null
  }
}

export function extractArchive(asarPath: string, dest: string): void {
  uncache(asarPath)
  try {
    asar.extractAll(asarPath, dest)
  } catch (error) {
    throw new PatcherError(
      `Could not extract ${asarPath}: ${error instanceof Error ? error.message : String(error)}\n` +
        `(is ${asarPath}.unpacked complete?)`
    )
  }
}

/**
 * Pack `srcDir` into `destAsar`, marking exactly the given paths as unpacked (unpacked files are
 * written to `${destAsar}.unpacked`). Using per-entry flags (instead of an `unpack` glob) reproduces
 * an electron-builder archive's unpacked set exactly.
 */
export async function packDirectory(
  srcDir: string,
  destAsar: string,
  isUnpacked: (relPosix: string, type: AsarEntry['type']) => boolean
): Promise<void> {
  const streams: asar.AsarStreamType[] = []
  const walk = (absDir: string, relDir: string): void => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const archivePath = toAsarLookupPath(rel)
      if (entry.isSymbolicLink()) {
        const stat = fs.lstatSync(abs)
        streams.push({
          type: 'link',
          path: archivePath,
          unpacked: isUnpacked(rel, 'link'),
          symlink: fs.readlinkSync(abs),
          stat: { mode: stat.mode, size: stat.size },
          streamGenerator: () => fs.createReadStream(abs)
        })
      } else if (entry.isDirectory()) {
        streams.push({
          type: 'directory',
          path: archivePath,
          unpacked: isUnpacked(rel, 'directory')
        })
        walk(abs, rel)
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs)
        streams.push({
          type: 'file',
          path: archivePath,
          unpacked: isUnpacked(rel, 'file'),
          stat: { mode: stat.mode, size: stat.size },
          streamGenerator: () => fs.createReadStream(abs)
        })
      }
    }
  }
  walk(srcDir, '')
  await asar.createPackageFromStreams(destAsar, streams)
  uncache(destAsar)
}

/**
 * Compare a repacked archive with the original: every entry must survive with the same type,
 * unpacked flag and (for files) size, except `touched` paths, which may be added, removed or changed
 * (as may directories that only exist to hold touched paths).
 */
export function diffArchives(
  original: Map<string, AsarEntry>,
  repacked: Map<string, AsarEntry>,
  touched: ReadonlySet<string>
): string[] {
  const problems: string[] = []
  const isTouched = (p: string): boolean =>
    touched.has(p) || [...touched].some((t) => t.startsWith(`${p}/`))
  for (const [p, before] of original) {
    const after = repacked.get(p)
    if (!after) {
      if (!isTouched(p)) problems.push(`missing after repack: ${p}`)
      continue
    }
    if (after.type !== before.type) problems.push(`type changed: ${p}`)
    if (after.unpacked !== before.unpacked) {
      problems.push(`unpacked flag changed (${before.unpacked} → ${after.unpacked}): ${p}`)
    }
    if (before.type === 'file' && !touched.has(p) && after.size !== before.size) {
      problems.push(`size changed: ${p}`)
    }
  }
  for (const p of repacked.keys()) {
    if (!original.has(p) && !isTouched(p)) problems.push(`unexpected new entry: ${p}`)
  }
  return problems
}

/** Check that every unpacked file of the archive exists in `<asar>.unpacked` with the right size. */
export function checkUnpackedDir(asarPath: string, entries: Map<string, AsarEntry>): string[] {
  const root = `${asarPath}.unpacked`
  const problems: string[] = []
  for (const entry of entries.values()) {
    if (!entry.unpacked || entry.type === 'directory') continue
    const abs = path.join(root, ...entry.path.split('/'))
    try {
      const st = fs.lstatSync(abs)
      if (entry.type === 'file' && st.size !== entry.size) {
        problems.push(`size mismatch in ${path.basename(root)}: ${entry.path}`)
      }
    } catch {
      problems.push(`missing from ${path.basename(root)}: ${entry.path}`)
    }
  }
  return problems
}

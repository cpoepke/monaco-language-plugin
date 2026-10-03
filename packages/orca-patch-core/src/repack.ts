import path from 'node:path'
import {
  type AsarEntry,
  checkUnpackedDir,
  diffArchives,
  extractArchive,
  packDirectory,
  readEntries
} from './asar.js'
import { PatcherError } from './errors.js'

/**
 * Extract `asarPath` into `workDir`, let `mutate` edit the tree, and pack it to `workDir/out/app.asar`
 * keeping every originally-unpacked entry unpacked. The rebuilt archive is verified against the
 * original (only `touched` paths may differ) and against the existing `<asar>.unpacked` directory,
 * which is reused as-is. Returns the path of the rebuilt archive; nothing outside workDir is written.
 */
export async function rebuildArchive(options: {
  asarPath: string
  workDir: string
  originalEntries: Map<string, AsarEntry>
  touched: ReadonlySet<string>
  mutate: (extractedDir: string) => void
}): Promise<{ asar: string; entries: Map<string, AsarEntry> }> {
  const { asarPath, workDir, originalEntries, touched } = options
  for (const p of touched) {
    if (originalEntries.get(p)?.unpacked) {
      throw new PatcherError(`${p} is unpacked in this Orca build; refusing to modify it.`)
    }
  }
  const extracted = path.join(workDir, 'app')
  extractArchive(asarPath, extracted)
  options.mutate(extracted)

  const rebuilt = path.join(workDir, 'out', 'app.asar')
  const isUnpacked = (rel: string): boolean => originalEntries.get(rel)?.unpacked === true
  await packDirectory(extracted, rebuilt, isUnpacked)

  const entries = readEntries(rebuilt)
  const problems = [
    ...diffArchives(originalEntries, entries, touched),
    ...checkUnpackedDir(asarPath, entries)
  ]
  if (problems.length > 0) {
    const shown = problems.slice(0, 20).join('\n  ')
    const more = problems.length > 20 ? `\n  … and ${problems.length - 20} more` : ''
    throw new PatcherError(
      `Rebuilt archive failed verification; nothing was changed:\n  ${shown}${more}`
    )
  }
  return { asar: rebuilt, entries }
}

import path from 'node:path'
import { readAsarFile, readEntries, uncache } from './asar.js'
import {
  INJECTOR_ASAR_PATH,
  MONACO_GLOBAL_API_ANCHOR,
  RENDERER_ASSETS_DIR,
  RENDERER_INDEX,
  TMP_SUFFIX,
  VERSION_ASAR_PATH
} from './constants.js'
import { PatcherError } from './errors.js'
import { fs } from './fs.js'
import { atomicReplace } from './fsutil.js'
import { countInjectedBlocks, injectScriptBlock } from './html.js'
import type { InjectorAsset } from './injector.js'
import { type AsarInspection, inspectAsar } from './inspect.js'
import { rebuildArchive } from './repack.js'

/** Renderer chunks (relative paths) of an extracted app tree containing the Monaco anchor. */
export function findAnchorFiles(extractedDir: string): string[] {
  const assetsDir = path.join(extractedDir, ...RENDERER_ASSETS_DIR.split('/'))
  let names: string[]
  try {
    names = fs.readdirSync(assetsDir).filter((n) => n.endsWith('.js'))
  } catch {
    return []
  }
  return names
    .filter((n) =>
      fs.readFileSync(path.join(assetsDir, n), 'utf8').includes(MONACO_GLOBAL_API_ANCHOR)
    )
    .map((n) => `${RENDERER_ASSETS_DIR}/${n}`)
}

/**
 * The same check on the archive itself, without extracting it: reads only the renderer's
 * top-level `assets/*.js` chunks. Lets the self-repair tell "unsupported Orca" apart cheaply.
 */
export function findAnchorFilesInArchive(asarPath: string): string[] {
  const prefix = `${RENDERER_ASSETS_DIR}/`
  const chunks = [...readEntries(asarPath).values()].filter(
    (e) =>
      e.type === 'file' &&
      e.path.startsWith(prefix) &&
      !e.path.slice(prefix.length).includes('/') &&
      e.path.endsWith('.js')
  )
  return chunks
    .filter((e) =>
      readAsarFile(asarPath, e.path)?.toString('utf8').includes(MONACO_GLOBAL_API_ANCHOR)
    )
    .map((e) => e.path)
}

export const anchorMissingMessage = (): string =>
  `None of ${RENDERER_ASSETS_DIR}/*.js contains the Monaco anchor\n` +
  `  ${MONACO_GLOBAL_API_ANCHOR}\n` +
  'This Orca version bundles Monaco differently, so the injector could not capture it. ' +
  'Nothing was changed. Please report this together with your Orca version.'

export type PatchedArchive = {
  /** The rebuilt archive inside workDir (nothing outside workDir was written). */
  asar: string
  anchorFiles: string[]
  orcaVersion: string | null
  /** The archive as it was before patching. */
  before: AsarInspection
}

/**
 * Build a patched copy of `asarPath` in `workDir`: inject the `<script>` block into the renderer's
 * index.html, add the injector and `version.json`, repack keeping every unpacked entry, verify.
 * Throws PatcherError (reason `unexpected-layout` / `anchor-missing` / `verification-failed`)
 * without touching the original.
 */
export async function buildPatchedArchive(options: {
  asarPath: string
  workDir: string
  injector: InjectorAsset
  /** Recorded in version.json. */
  patcherVersion: string
  patchedBy: string
  now?: () => Date
}): Promise<PatchedArchive> {
  const { asarPath, injector } = options
  const originalEntries = readEntries(asarPath)
  const index = originalEntries.get(RENDERER_INDEX)
  if (!index || index.type !== 'file') {
    throw new PatcherError(
      `${RENDERER_INDEX} not found in ${asarPath}. This Orca build has an unexpected layout; ` +
        'nothing was changed.',
      undefined,
      'unexpected-layout'
    )
  }
  const before = inspectAsar(asarPath)
  const orcaVersion = before.orcaVersion
  let anchorFiles: string[] = []
  const touched = new Set([RENDERER_INDEX, INJECTOR_ASAR_PATH, VERSION_ASAR_PATH])
  const rebuilt = await rebuildArchive({
    asarPath,
    workDir: options.workDir,
    originalEntries,
    touched,
    mutate: (dir) => {
      anchorFiles = findAnchorFiles(dir)
      if (anchorFiles.length === 0) {
        throw new PatcherError(anchorMissingMessage(), undefined, 'anchor-missing')
      }
      const indexAbs = path.join(dir, ...RENDERER_INDEX.split('/'))
      const html = fs.readFileSync(indexAbs, 'utf8')
      fs.writeFileSync(indexAbs, injectScriptBlock(html))
      const injectorAbs = path.join(dir, ...INJECTOR_ASAR_PATH.split('/'))
      fs.mkdirSync(path.dirname(injectorAbs), { recursive: true })
      fs.writeFileSync(injectorAbs, injector.source)
      fs.writeFileSync(
        path.join(dir, ...VERSION_ASAR_PATH.split('/')),
        `${JSON.stringify(
          {
            injectorVersion: injector.version,
            orcaVersion,
            patcherVersion: options.patcherVersion,
            patchedBy: options.patchedBy,
            patchedAt: (options.now?.() ?? new Date()).toISOString()
          },
          null,
          2
        )}\n`
      )
    }
  })
  const newHtml = readAsarFile(rebuilt.asar, RENDERER_INDEX)?.toString('utf8') ?? ''
  if (countInjectedBlocks(newHtml) !== 1 || !readAsarFile(rebuilt.asar, INJECTOR_ASAR_PATH)) {
    throw new PatcherError(
      'Rebuilt archive is missing the injection; nothing was changed.',
      undefined,
      'verification-failed'
    )
  }
  return { asar: rebuilt.asar, anchorFiles, orcaVersion, before }
}

/**
 * Atomically replace `asarPath` with `source` (copy to `<asar>.mlp-tmp` in the same directory,
 * fsync, rename). Errors keep their errno `code` (EBUSY/EPERM on Windows while Orca runs, EACCES/
 * EROFS for read-only installs); the original is untouched in that case.
 */
export function replaceAsar(source: string, asarPath: string): void {
  atomicReplace(source, asarPath, `${asarPath}${TMP_SUFFIX}`)
  uncache(asarPath)
}

/** After writing: exactly one injected block (and the expected injector version, if given). */
export function verifyPatched(asarPath: string, injectorVersion?: string): AsarInspection {
  uncache(asarPath)
  const after = inspectAsar(asarPath)
  if (
    after.injectedBlocks !== 1 ||
    (injectorVersion !== undefined && after.versionInfo?.injectorVersion !== injectorVersion)
  ) {
    throw new PatcherError(
      `Verification after writing failed (found ${after.injectedBlocks} injected blocks, injector ` +
        `${after.versionInfo?.injectorVersion ?? 'none'}). Run \`monaco-lsp-orca uninstall\` to ` +
        'restore the backup.',
      undefined,
      'verification-failed'
    )
  }
  return after
}

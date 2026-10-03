import { INJECTOR_SCRIPT_SRC, MARKER_BEGIN, MARKER_END } from './constants.js'
import { PatcherError } from './errors.js'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches one injected block including the line break + indentation we insert before it. */
const BLOCK_RE = new RegExp(
  `(?:\\r?\\n[ \\t]*)?${escapeRe(MARKER_BEGIN)}[\\s\\S]*?${escapeRe(MARKER_END)}`,
  'g'
)

export function buildScriptBlock(src: string = INJECTOR_SCRIPT_SRC): string {
  return `${MARKER_BEGIN}<script src="${src}"></script>${MARKER_END}`
}

/** Number of `mlp:begin` markers in the document. */
export function countInjectedBlocks(html: string): number {
  return html.split(MARKER_BEGIN).length - 1
}

/** Removes every injected block. Restores the original bytes for HTML produced by `injectScriptBlock`. */
export function removeScriptBlocks(html: string): string {
  return html.replace(BLOCK_RE, '')
}

/**
 * Inserts the injector `<script>` as the first child of `<head>`, so it runs before Orca's module
 * scripts (which are deferred). Idempotent: any existing block is replaced.
 */
export function injectScriptBlock(html: string, src: string = INJECTOR_SCRIPT_SRC): string {
  const clean = removeScriptBlocks(html)
  const head = /<head\b[^>]*>/i.exec(clean)
  if (!head) {
    throw new PatcherError(
      'out/renderer/index.html has no <head> element; this Orca build has an unexpected layout.'
    )
  }
  const at = head.index + head[0].length
  return `${clean.slice(0, at)}\n    ${buildScriptBlock(src)}${clean.slice(at)}`
}

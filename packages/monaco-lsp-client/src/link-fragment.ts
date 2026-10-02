import type { IRange } from 'monaco-editor'

/**
 * Parses the location fragment of a file link into a 1-based Monaco range.
 * Accepts the shapes Monaco itself understands (`L12`, `12`, `L12,5`, `L12,5-L14,2`)
 * plus the common `12:5` and GitHub-style `L12C5` spellings. A leading `#` is ignored.
 * Returns null when the fragment carries no line information.
 */
export function parseLinkFragment(fragment: string): IRange | null {
  const match = /^#?L?(\d+)(?:[,:C](\d+))?(?:-L?(\d+)(?:[,:C](\d+))?)?$/i.exec(fragment.trim())
  if (!match) {
    return null
  }
  const startLineNumber = Math.max(1, Number(match[1]))
  const startColumn = match[2] ? Math.max(1, Number(match[2])) : 1
  if (!match[3]) {
    return { startLineNumber, startColumn, endLineNumber: startLineNumber, endColumn: startColumn }
  }
  const endLineNumber = Math.max(startLineNumber, Number(match[3]))
  const endColumn = match[4] ? Math.max(1, Number(match[4])) : 1
  return { startLineNumber, startColumn, endLineNumber, endColumn }
}

/** Splits a link (`file:///a.ts#L3,4`) into the fragment-free URI and its target range
 *  (line 1, column 1 when the fragment has no location). */
export function parseFileLink(link: string): { uri: string; range: IRange } {
  const hash = link.indexOf('#')
  const uri = hash === -1 ? link : link.slice(0, hash)
  let fragment = hash === -1 ? '' : link.slice(hash + 1)
  try {
    fragment = decodeURIComponent(fragment)
  } catch {
    // Keep the raw fragment; the parser rejects anything that is not a location.
  }
  const range = fragment ? parseLinkFragment(fragment) : null
  return {
    uri,
    range: range ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  }
}

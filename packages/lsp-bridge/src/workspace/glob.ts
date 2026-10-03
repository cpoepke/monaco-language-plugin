/**
 * LSP glob patterns (`workspace/didChangeWatchedFiles` watchers) as regular
 * expressions. Supports the syntax the spec lists: `*` (within a segment),
 * `**` (any number of segments), `?`, `{a,b}` (nestable) and `[...]` /
 * `[!...]` character ranges. Paths are matched with `/` separators.
 */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let source = ''
  let braceDepth = 0
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string
    switch (char) {
      case '*': {
        if (glob[i + 1] === '*') {
          i++
          if (glob[i + 1] === '/') {
            // `**/` matches zero or more whole segments.
            i++
            source += '(?:[^/]*/)*'
          } else {
            source += '.*'
          }
        } else {
          source += '[^/]*'
        }
        break
      }
      case '?':
        source += '[^/]'
        break
      case '{':
        braceDepth++
        source += '(?:'
        break
      case '}':
        if (braceDepth > 0) {
          braceDepth--
          source += ')'
        } else {
          source += '\\}'
        }
        break
      case ',':
        source += braceDepth > 0 ? '|' : ','
        break
      case '[': {
        const close = glob.indexOf(']', i + 2)
        if (close === -1) {
          source += '\\['
          break
        }
        let body = glob.slice(i + 1, close)
        const negated = body.startsWith('!')
        if (negated) {
          body = body.slice(1)
        }
        source += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
        i = close
        break
      }
      default:
        source += char.replace(/[.+^$()|\\\]/]/g, '\\$&')
    }
  }
  // An unbalanced `{` would leave the expression open; close it literally.
  source += ')'.repeat(braceDepth)
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '')
}

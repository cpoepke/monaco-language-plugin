// Copy of Orca's components/editor/editor-model-uri.ts.
// @ts-expect-error -- deep ESM import without typings (Orca imports it the same way)
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'

type UriStatic = {
  file(path: string): { toString(): string }
  parse(value: string): { fsPath: string }
}

const FILE_SCHEME = /^file:/i

export function toEditorModelUri(filePath: string): string {
  const uri = URI as UriStatic
  return uri.file(FILE_SCHEME.test(filePath) ? uri.parse(filePath).fsPath : filePath).toString()
}

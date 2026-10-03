import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FIXTURES_DIR, LSP_BRIDGE_BIN } from '../harness/paths.ts'

export type LanguageCase = {
  language: string
  /** Server binary looked up on the host to decide whether the language can be tested. */
  binary: string
  root: string
  entry: string
  /** 1-based line of the cross-file call in the entry file and the call text. */
  line: number
  call: string
  target: string
  definitionLine: number
  /** The defined identifier (the reveal must select it or put the cursor on its line). */
  symbol: string
  hoverText: string
  /** A call of the same symbol inside the definition file (same-file navigation). */
  sameFileLine: number
  sameFileCall: string
}

export const CASES: LanguageCase[] = [
  {
    language: 'typescript',
    binary: 'typescript-language-server',
    root: path.join(FIXTURES_DIR, 'ts'),
    entry: 'src/app.ts',
    line: 6,
    call: 'greet(',
    target: 'src/greeter.ts',
    definitionLine: 5,
    symbol: 'greet',
    hoverText: 'Builds a friendly greeting',
    sameFileLine: 20,
    sameFileCall: 'greet('
  },
  {
    language: 'python',
    binary: 'pyright-langserver',
    root: path.join(FIXTURES_DIR, 'py'),
    entry: 'app/main.py',
    line: 4,
    call: 'greet(',
    target: 'app/greeter.py',
    definitionLine: 4,
    symbol: 'greet',
    hoverText: 'Build a friendly greeting',
    sameFileLine: 17,
    sameFileCall: 'greet('
  },
  {
    language: 'go',
    binary: 'gopls',
    root: path.join(FIXTURES_DIR, 'go'),
    entry: 'main.go',
    line: 11,
    call: 'Greet(',
    target: 'greet/greet.go',
    definitionLine: 7,
    symbol: 'Greet',
    hoverText: 'Greet builds a friendly greeting',
    sameFileLine: 18,
    sameFileCall: 'Greet('
  },
  {
    language: 'rust',
    binary: 'rust-analyzer',
    root: path.join(FIXTURES_DIR, 'rust'),
    entry: 'src/main.rs',
    line: 7,
    call: 'greet(',
    target: 'src/greeter.rs',
    definitionLine: 4,
    symbol: 'greet',
    hoverText: 'Builds a friendly greeting',
    sameFileLine: 16,
    sameFileCall: 'greet('
  }
]

/** Whether the host has the server at all (the plugin itself must still find it). */
export function hostHasBinary(binary: string): boolean {
  const home = os.homedir()
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    LSP_BRIDGE_BIN,
    path.join(home, '.local', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, '.cargo', 'bin')
  ]
  return dirs.some((dir) => {
    try {
      accessSync(path.join(dir, binary), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

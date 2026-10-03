import { PatcherError } from './errors.js'
import { fs } from './fs.js'

/** The injector bundle starts with `/*! @mlp/orca-injector v<version> *\/`. */
export function parseInjectorVersion(source: string): string | null {
  return /@mlp\/orca-injector v([0-9A-Za-z.+-]+)/.exec(source.slice(0, 500))?.[1] ?? null
}

export type InjectorAsset = { path: string; source: Buffer; version: string }

export function loadInjector(file: string): InjectorAsset {
  let source: Buffer
  try {
    source = fs.readFileSync(file)
  } catch {
    throw new PatcherError(
      `Injector bundle not found at ${file}. Build it first: pnpm --filter @mlp/orca-injector build ` +
        '&& pnpm --filter monaco-lsp-orca build'
    )
  }
  return { path: file, source, version: parseInjectorVersion(source.toString('utf8')) ?? 'unknown' }
}

/**
 * Compare dotted versions numerically (`0.10.0` > `0.9.1`); a pre-release/build suffix is ignored.
 * Returns <0, 0 or >0. Unparseable parts compare as 0.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split(/[-+]/, 1)[0]!
      .split('.')
      .map((n) => (/^\d+$/.test(n) ? Number(n) : 0))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

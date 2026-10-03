import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { globToRegExp } from './glob'
import { compileWatchers } from './watched-files'

const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

describe('globToRegExp', () => {
  it('supports *, ** and ?', () => {
    expect(matches('*.go', 'main.go')).toBe(true)
    expect(matches('*.go', 'cmd/main.go')).toBe(false)
    expect(matches('**/*.go', 'main.go')).toBe(true)
    expect(matches('**/*.go', '/abs/deep/pkg/main.go')).toBe(true)
    expect(matches('**/*.go', 'main.gox')).toBe(false)
    expect(matches('src/**', 'src/a/b.ts')).toBe(true)
    expect(matches('src/**/x.ts', 'src/x.ts')).toBe(true)
    expect(matches('src/**/x.ts', 'src/a/b/x.ts')).toBe(true)
    expect(matches('?.rs', 'a.rs')).toBe(true)
    expect(matches('?.rs', 'ab.rs')).toBe(false)
  })

  it('supports {a,b} (nested) and character ranges', () => {
    const glob = '**/*.{go,mod,sum,work}'
    expect(matches(glob, 'a/go.mod')).toBe(true)
    expect(matches(glob, 'go.work')).toBe(true)
    expect(matches(glob, 'a/b.ts')).toBe(false)
    expect(matches('**/{Cargo.{toml,lock},*.rs}', 'crates/a/Cargo.lock')).toBe(true)
    expect(matches('file[0-9].ts', 'file7.ts')).toBe(true)
    expect(matches('file[!0-9].ts', 'file7.ts')).toBe(false)
    expect(matches('file[!0-9].ts', 'filex.ts')).toBe(true)
  })

  it('escapes regex metacharacters', () => {
    expect(matches('a.b(c)+$.ts', 'a.b(c)+$.ts')).toBe(true)
    expect(matches('a.b', 'axb')).toBe(false)
  })
})

describe('compileWatchers', () => {
  const root = join('/', 'repo')

  it('matches string globs against absolute and root-relative paths', () => {
    const [absolute, relative] = compileWatchers(root, {
      watchers: [{ globPattern: '**/*.go' }, { globPattern: 'go.mod' }]
    })
    expect(absolute?.matches(join(root, 'pkg', 'a.go'))).toBe(true)
    expect(relative?.matches(join(root, 'go.mod'))).toBe(true)
    expect(relative?.matches(join(root, 'sub', 'go.mod'))).toBe(false)
    expect(absolute?.kind).toBe(7)
  })

  it('matches relative patterns against their base and keeps kind', () => {
    const base = join(root, 'crates')
    const [watcher] = compileWatchers(root, {
      watchers: [
        { globPattern: { baseUri: pathToFileURL(base).href, pattern: '*/Cargo.toml' }, kind: 4 }
      ]
    })
    expect(watcher?.matches(join(base, 'a', 'Cargo.toml'))).toBe(true)
    expect(watcher?.matches(join(root, 'a', 'Cargo.toml'))).toBe(false)
    expect(watcher?.kind).toBe(4)
  })

  it('drops junk', () => {
    expect(
      compileWatchers(root, {
        watchers: [null, { globPattern: 3 }, { globPattern: { baseUri: 'http://x', pattern: '*' } }]
      })
    ).toEqual([])
    expect(compileWatchers(root, null)).toEqual([])
  })
})

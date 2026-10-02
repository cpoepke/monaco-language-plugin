import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectWorkspaceRoot } from './workspace-root'

let base: string

function touch(relative: string, content = ''): string {
  const path = join(base, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mlp-root-')))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('detectWorkspaceRoot', () => {
  it('TS/JS: nearest tsconfig.json, jsconfig.json or package.json', () => {
    touch('repo/package.json', '{}')
    touch('repo/packages/app/tsconfig.json', '{}')
    const file = touch('repo/packages/app/src/deep/index.ts')
    expect(detectWorkspaceRoot(file, 'typescript')).toBe(join(base, 'repo/packages/app'))

    touch('repo/web/jsconfig.json', '{}')
    expect(detectWorkspaceRoot(touch('repo/web/a.js'), 'javascript')).toBe(join(base, 'repo/web'))
    expect(detectWorkspaceRoot(touch('repo/scripts/b.ts'), 'typescript')).toBe(join(base, 'repo'))
  })

  it('Python: nearest project marker', () => {
    touch('py/pyproject.toml')
    touch('py/sub/requirements.txt')
    expect(detectWorkspaceRoot(touch('py/app/main.py'), 'python')).toBe(join(base, 'py'))
    expect(detectWorkspaceRoot(touch('py/sub/x/y.py'), 'python')).toBe(join(base, 'py/sub'))
    touch('cfg/setup.cfg')
    expect(detectWorkspaceRoot(touch('cfg/z.py'), 'python')).toBe(join(base, 'cfg'))
  })

  it('Go: go.work above wins over the nearer go.mod', () => {
    touch('gows/go.work')
    touch('gows/mod/go.mod')
    expect(detectWorkspaceRoot(touch('gows/mod/pkg/a.go'), 'go')).toBe(join(base, 'gows'))
    touch('gomod/go.mod')
    expect(detectWorkspaceRoot(touch('gomod/cmd/main.go'), 'go')).toBe(join(base, 'gomod'))
  })

  it('Rust: top-most [workspace] Cargo.toml, else nearest Cargo.toml', () => {
    touch('rs/Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n')
    touch('rs/crates/a/Cargo.toml', '[package]\nname = "a"\n')
    expect(detectWorkspaceRoot(touch('rs/crates/a/src/lib.rs'), 'rust')).toBe(join(base, 'rs'))

    touch('single/Cargo.toml', '[package]\nname = "single"\n')
    touch('single/nested/Cargo.toml', '[package]\nname = "nested"\n')
    expect(detectWorkspaceRoot(touch('single/nested/src/main.rs'), 'rust')).toBe(
      join(base, 'single/nested')
    )
  })

  it('falls back to the nearest .git, then to the file directory', () => {
    mkdirSync(join(base, 'gitrepo/.git'), { recursive: true })
    expect(detectWorkspaceRoot(touch('gitrepo/src/x.go'), 'go')).toBe(join(base, 'gitrepo'))
    // A worktree's .git is a file, not a directory.
    touch('worktree/.git', 'gitdir: elsewhere')
    expect(detectWorkspaceRoot(touch('worktree/a/b.rs'), 'rust')).toBe(join(base, 'worktree'))
    expect(detectWorkspaceRoot(touch('loose/dir/c.py'), 'python')).toBe(join(base, 'loose/dir'))
  })

  it('never walks above the boundary', () => {
    touch('outer/tsconfig.json', '{}')
    mkdirSync(join(base, 'outer/.git'))
    touch('outer/inner/src/a.ts')
    const file = join(base, 'outer/inner/src/a.ts')
    expect(detectWorkspaceRoot(file, 'typescript')).toBe(join(base, 'outer'))
    expect(detectWorkspaceRoot(file, 'typescript', { boundary: join(base, 'outer/inner') })).toBe(
      join(base, 'outer/inner/src')
    )
    // A [workspace] above the boundary is ignored too.
    touch('ws/Cargo.toml', '[workspace]\n')
    touch('ws/member/Cargo.toml', '[package]\n')
    const rs = touch('ws/member/src/lib.rs')
    expect(detectWorkspaceRoot(rs, 'rust', { boundary: join(base, 'ws/member') })).toBe(
      join(base, 'ws/member')
    )
  })

  it('uses an injectable probe (pure function)', () => {
    const existing = new Set(['/v/proj/go.mod'])
    const probe = { exists: (p: string) => existing.has(p), readText: () => null }
    expect(detectWorkspaceRoot('/v/proj/a/b/c.go', 'go', { probe })).toBe('/v/proj')
  })
})

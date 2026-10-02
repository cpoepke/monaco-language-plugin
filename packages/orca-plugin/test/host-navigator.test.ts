import { describe, expect, it, vi } from 'vitest'
import { createHostNavigator, extractWorktreeRoots } from '../src/host-navigator'
import { findWorktreeRoot, isInside, toOrcaRelativePath } from '../src/worktree-paths'

describe('worktree path mapping', () => {
  const roots = ['/work/repo', '/work/repo/.worktrees/feature', '/work/repo-other']

  it('picks the longest matching root', () => {
    expect(findWorktreeRoot('/work/repo/.worktrees/feature/src/a.ts', roots)).toBe(
      '/work/repo/.worktrees/feature'
    )
    expect(findWorktreeRoot('/work/repo/src/a.ts', roots)).toBe('/work/repo')
  })

  it('does not treat a sibling with a shared prefix as inside', () => {
    expect(findWorktreeRoot('/work/repo-other/x.ts', ['/work/repo'])).toBeNull()
    expect(isInside('/work/repo', '/work/repo')).toBe(false)
  })

  it('rejects files outside every worktree', () => {
    expect(findWorktreeRoot('/usr/lib/node_modules/typescript/lib/lib.d.ts', roots)).toBeNull()
  })

  it('tolerates trailing slashes on roots', () => {
    expect(findWorktreeRoot('/work/repo/a.ts', ['/work/repo/'])).toBe('/work/repo/')
    expect(toOrcaRelativePath('/work/repo/', '/work/repo/a.ts')).toBe('a.ts')
  })

  it('emits posix separators and never `..`', () => {
    expect(toOrcaRelativePath('/work/repo', '/work/repo/src/deep/a.ts')).toBe('src/deep/a.ts')
    expect(toOrcaRelativePath('/work/repo', '/work/repo/../etc/passwd')).toBeNull()
    expect(toOrcaRelativePath('/work/repo', '/work/other/a.ts')).toBeNull()
  })

  it('handles Windows paths (path.win32, case-insensitive, forward slashes out)', () => {
    const winRoots = ['C:\\Users\\me\\repo', 'C:\\Users\\me\\repo\\packages\\app']
    const file = 'c:\\users\\me\\REPO\\packages\\app\\src\\Main.ts'
    expect(findWorktreeRoot(file, winRoots)).toBe('C:\\Users\\me\\repo\\packages\\app')
    expect(toOrcaRelativePath('C:\\Users\\me\\repo', 'C:\\Users\\me\\repo\\src\\a.ts')).toBe(
      'src/a.ts'
    )
    expect(toOrcaRelativePath('C:/Users/me/repo', 'C:\\Users\\me\\repo\\src\\a.ts')).toBe(
      'src/a.ts'
    )
    expect(findWorktreeRoot('D:\\repo\\a.ts', winRoots)).toBeNull()
    // A posix root never matches a Windows file and vice versa.
    expect(findWorktreeRoot('C:\\work\\repo\\a.ts', ['/work/repo'])).toBeNull()
  })
})

describe('extractWorktreeRoots', () => {
  it('reads worktrees[].path and ignores junk', () => {
    expect(
      extractWorktreeRoots({ worktrees: [{ path: '/a' }, { path: 3 }, null, { path: '' }] })
    ).toEqual(['/a'])
    expect(extractWorktreeRoots(null)).toEqual([])
  })
})

describe('createHostNavigator', () => {
  function fakeRuntime(rootsByCall: string[][]) {
    let listCalls = 0
    const call = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'worktree.list') {
        const roots = rootsByCall[Math.min(listCalls++, rootsByCall.length - 1)] ?? []
        return { worktrees: roots.map((path) => ({ path })), totalCount: roots.length }
      }
      return { opened: true, kind: 'text' }
    }) as unknown as <T>(method: string, params?: unknown) => Promise<T>
    return { call, listCalls: () => listCalls }
  }

  it('caches worktree.list for 10 s and refreshes on a miss', async () => {
    let clock = 0
    const runtime = fakeRuntime([['/a'], ['/a', '/b']])
    const navigate = createHostNavigator({ runtime, now: () => clock })
    await navigate({ path: '/a/x.ts', line: 0, character: 0 })
    await navigate({ path: '/a/y.ts', line: 0, character: 0 })
    expect(runtime.listCalls()).toBe(1)
    // Unknown root → refresh immediately, even within the cache window.
    await expect(navigate({ path: '/b/z.ts', line: 0, character: 0 })).resolves.toEqual({
      opened: true
    })
    expect(runtime.listCalls()).toBe(2)
    clock = 11_000
    await navigate({ path: '/a/x.ts', line: 0, character: 0 })
    expect(runtime.listCalls()).toBe(3)
  })

  it('returns a reason for files outside every worktree', async () => {
    const navigate = createHostNavigator({ runtime: fakeRuntime([['/a']]) })
    await expect(navigate({ path: '/elsewhere/x.ts', line: 0, character: 0 })).resolves.toEqual({
      opened: false,
      reason: 'file is outside every Orca worktree'
    })
  })

  it('reports opened:false when Orca declines (binary)', async () => {
    const call = (async (method: string) =>
      method === 'worktree.list'
        ? { worktrees: [{ path: '/a' }] }
        : { opened: false, kind: 'binary' }) as unknown as <T>(
      method: string,
      params?: unknown
    ) => Promise<T>
    const result = await createHostNavigator({ runtime: { call } })({
      path: '/a/img.bin',
      line: 0,
      character: 0
    })
    expect(result.opened).toBe(false)
  })
})

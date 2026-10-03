import { describe, expect, it, vi } from 'vitest'
import { createWorktreeRoots } from '../src/worktree-roots'

function fakeRuntime(answers: (string[] | Error)[]) {
  let calls = 0
  const call = vi.fn(async (method: string) => {
    if (method !== 'worktree.list') throw new Error(`unexpected ${method}`)
    const answer = answers[Math.min(calls++, answers.length - 1)] ?? []
    if (answer instanceof Error) throw answer
    return { worktrees: answer.map((path) => ({ path })) }
  }) as unknown as <T>(method: string, params?: unknown) => Promise<T>
  return { call, calls: () => calls }
}

describe('createWorktreeRoots', () => {
  it('lists both the reported and the realpath spelling of each root', async () => {
    const worktrees = createWorktreeRoots({
      runtime: fakeRuntime([['/tmp/wt', '/work/repo']]),
      realpath: (path) => (path === '/tmp/wt' ? '/private/tmp/wt' : path)
    })
    expect(await worktrees.list()).toEqual(['/tmp/wt', '/private/tmp/wt', '/work/repo'])
    expect(await worktrees.resolve('/private/tmp/wt/src/a.ts')).toEqual({
      root: '/tmp/wt',
      matchedRoot: '/private/tmp/wt'
    })
    expect(await worktrees.resolve('/tmp/wt/src/a.ts')).toEqual({
      root: '/tmp/wt',
      matchedRoot: '/tmp/wt'
    })
  })

  it('caches for 10 s, returns a stable array, and refreshes a containment miss at most once a second', async () => {
    let clock = 0
    const runtime = fakeRuntime([['/a'], ['/a', '/b']])
    const worktrees = createWorktreeRoots({ runtime, now: () => clock, realpath: (p) => p })
    const first = await worktrees.forPath('/a/x.ts')
    expect(await worktrees.forPath('/a/y.ts')).toBe(first)
    expect(runtime.calls()).toBe(1)
    clock = 2_000
    expect(await worktrees.forPath('/b/new.ts')).toEqual(['/a', '/b'])
    expect(runtime.calls()).toBe(2)
    // Misses within a second of the last miss refresh are answered from cache.
    clock = 2_500
    await worktrees.forPath('/nowhere/x.ts')
    expect(runtime.calls()).toBe(2)
    clock = 13_000
    await worktrees.forPath('/a/x.ts')
    expect(runtime.calls()).toBe(3)
  })

  it('keeps only the last known roots when the runtime is unreachable (fail closed)', async () => {
    let clock = 0
    const down = Object.assign(new Error('cannot reach the Orca runtime'), {
      code: 'runtime_unavailable'
    })
    const runtime = fakeRuntime([['/a'], down])
    const worktrees = createWorktreeRoots({ runtime, now: () => clock, realpath: (p) => p })
    expect(await worktrees.forPath('/a/x.ts')).toEqual(['/a'])
    clock = 20_000
    expect(await worktrees.forPath('/b/x.ts')).toEqual(['/a'])
    expect(worktrees.lastError()).toBe(down)
    // Never reachable: nothing is allowed.
    const never = createWorktreeRoots({ runtime: fakeRuntime([down]), realpath: (p) => p })
    expect(await never.forPath('/a/x.ts')).toEqual([])
  })

  it('invalidate() forces the next lookup to refresh (worktree removed)', async () => {
    const runtime = fakeRuntime([['/a', '/b'], ['/a']])
    const worktrees = createWorktreeRoots({ runtime, realpath: (p) => p })
    expect(await worktrees.list()).toEqual(['/a', '/b'])
    worktrees.invalidate()
    expect(await worktrees.forPath('/b/x.ts')).toEqual(['/a'])
  })
})

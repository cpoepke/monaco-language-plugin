/** WatchedFilesService on a real directory (inotify / FSEvents / ReadDirectoryChangesW). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../src/logger'
import {
  FileChangeType,
  WATCH_IGNORED_DIRS,
  WatchedFilesService,
  activeTreeWatchers,
  compileWatchers,
  type FileEvent
} from '../src/workspace/watched-files'
import { pollFor } from './helpers/test-client'

const uriOf = (file: string) => pathToFileURL(file).toString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('compileWatchers', () => {
  const root = path.resolve('/proj')

  it('compiles plain glob strings against absolute and root-relative paths', () => {
    const [watcher] = compileWatchers(root, { watchers: [{ globPattern: '**/*.go' }] })
    expect(watcher?.matches(path.join(root, 'cmd', 'main.go'))).toBe(true)
    expect(watcher?.matches(path.join(root, 'main.go'))).toBe(true)
    expect(watcher?.matches(path.join(root, 'main.rs'))).toBe(false)
    const [exact] = compileWatchers(root, { watchers: [{ globPattern: 'go.mod' }] })
    expect(exact?.matches(path.join(root, 'go.mod'))).toBe(true)
    expect(exact?.matches(path.join(root, 'sub', 'go.mod'))).toBe(false)
  })

  it('defaults to all event kinds and keeps an explicit one', () => {
    const watchers = compileWatchers(root, {
      watchers: [
        { globPattern: 'a' },
        { globPattern: 'b', kind: 1 },
        { globPattern: 'c', kind: 0 },
        { globPattern: 'd', kind: 'bad' }
      ]
    })
    expect(watchers.map((w) => w.kind)).toEqual([7, 1, 7, 7])
  })

  it('compiles relative patterns against their base uri (string or object form)', () => {
    const base = path.resolve('/other/base')
    const [asObject, asString] = compileWatchers(root, {
      watchers: [
        { globPattern: { baseUri: { uri: uriOf(base) }, pattern: '**/*.toml' } },
        { globPattern: { baseUri: uriOf(base), pattern: '*.lock' } }
      ]
    })
    expect(asObject?.matches(path.join(base, 'a', 'b.toml'))).toBe(true)
    expect(asObject?.matches(path.join(root, 'b.toml'))).toBe(false)
    expect(asString?.matches(path.join(base, 'x.lock'))).toBe(true)
    expect(asString?.matches(path.join(base, 'sub', 'x.lock'))).toBe(false)
  })

  it('drops everything it cannot interpret', () => {
    expect(compileWatchers(root, null)).toEqual([])
    expect(compileWatchers(root, { watchers: 'nope' })).toEqual([])
    expect(
      compileWatchers(root, {
        watchers: [
          null,
          'x',
          {},
          { globPattern: '' },
          { globPattern: 42 },
          { globPattern: { pattern: '*.x' } }, // no base uri
          { globPattern: { baseUri: 'http://example.com/', pattern: '*.x' } },
          { globPattern: { baseUri: 'file://server/share/', pattern: '*.x' } },
          { globPattern: { baseUri: '::not a uri::', pattern: '*.x' } },
          { globPattern: { baseUri: 7, pattern: '*.x' } },
          { globPattern: { baseUri: uriOf(root), pattern: 5 } }
        ]
      })
    ).toEqual([])
  })

  it('ignores VCS data, dependencies and build output', () => {
    expect([...WATCH_IGNORED_DIRS].sort()).toEqual(
      ['.git', '.venv', '__pycache__', 'dist', 'node_modules', 'target'].sort()
    )
  })
})

describe('WatchedFilesService', () => {
  let root: string
  let sent: FileEvent[]
  let services: WatchedFilesService[]
  const baseline = activeTreeWatchers()

  function service(debounceMs = 20): WatchedFilesService {
    const created = new WatchedFilesService({
      root,
      send: (changes) => sent.push(...changes),
      logger: silentLogger,
      debounceMs
    })
    services.push(created)
    return created
  }

  const seen = (file: string, type?: number) =>
    sent.some(
      (change) => change.uri === uriOf(file) && (type === undefined || change.type === type)
    )

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'mlp-watch-')))
    sent = []
    services = []
  })

  afterEach(() => {
    for (const created of services) created.close()
    expect(activeTreeWatchers()).toBe(baseline)
    rmSync(root, { recursive: true, force: true })
  })

  it('reports created, changed and deleted files that match a registration', async () => {
    const watched = service()
    watched.register('r1', { watchers: [{ globPattern: '**/*.go' }] })
    expect(activeTreeWatchers()).toBe(baseline + 1)
    await sleep(100)
    const file = path.join(root, 'main.go')
    writeFileSync(file, 'package main\n')
    await pollFor(() => (seen(file) ? true : null), 5000, 'create event')

    sent.length = 0
    await sleep(150)
    writeFileSync(file, 'package main // changed\n')
    await pollFor(() => (seen(file) ? true : null), 5000, 'change event')
    expect(sent.find((c) => c.uri === uriOf(file))?.type).toBeOneOf([
      FileChangeType.Created, // some platforms report a rewrite as a rename
      FileChangeType.Changed
    ])

    sent.length = 0
    await sleep(150)
    unlinkSync(file)
    await pollFor(() => (seen(file, FileChangeType.Deleted) ? true : null), 5000, 'delete event')
  })

  it('does not report files no registration matches, and skips ignored directories', async () => {
    const watched = service()
    watched.register('r1', { watchers: [{ globPattern: '**/*.go' }] })
    mkdirSync(path.join(root, 'node_modules'))
    mkdirSync(path.join(root, '.git'))
    await sleep(150)
    const ignored = path.join(root, 'node_modules', 'dep.go')
    const git = path.join(root, '.git', 'objects.go')
    const unmatched = path.join(root, 'notes.txt')
    const sentinel = path.join(root, 'sentinel.go')
    writeFileSync(ignored, 'x')
    writeFileSync(git, 'x')
    writeFileSync(unmatched, 'x')
    writeFileSync(sentinel, 'x')
    await pollFor(() => (seen(sentinel) ? true : null), 5000, 'sentinel event')
    await sleep(100)
    expect(seen(ignored)).toBe(false)
    expect(seen(git)).toBe(false)
    expect(seen(unmatched)).toBe(false)
  })

  it('honours the watch kind of a registration', async () => {
    const watched = service()
    watched.register('deletes-only', { watchers: [{ globPattern: '**/*.go', kind: 4 }] })
    const file = path.join(root, 'a.go')
    writeFileSync(file, 'x')
    await sleep(200)
    expect(seen(file)).toBe(false) // creation is not subscribed
    unlinkSync(file)
    await pollFor(() => (seen(file, FileChangeType.Deleted) ? true : null), 5000, 'delete event')
  })

  it('reports files in directories created after the watch started', async () => {
    const watched = service()
    watched.register('r1', { watchers: [{ globPattern: '**/*.go' }] })
    await sleep(100)
    const dir = path.join(root, 'pkg', 'inner')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'x.go')
    writeFileSync(file, 'x')
    await pollFor(() => (seen(file) ? true : null), 5000, 'event for a file in a new directory')
  })

  it('stops watching when the last registration goes away, and keeps going while one remains', async () => {
    const watched = service()
    watched.register('a', { watchers: [{ globPattern: '**/*.go' }] })
    watched.register('b', { watchers: [{ globPattern: '**/*.rs' }] })
    expect(activeTreeWatchers()).toBe(baseline + 1) // one OS watch shared by both
    watched.unregister('a')
    expect(activeTreeWatchers()).toBe(baseline + 1)
    watched.unregister('unknown')
    watched.unregister('b')
    expect(activeTreeWatchers()).toBe(baseline)
    // re-registering starts a fresh watch
    watched.register('c', { watchers: [{ globPattern: '**/*.go' }] })
    expect(activeTreeWatchers()).toBe(baseline + 1)
  })

  it('starts no OS watch for registrations without usable watchers', () => {
    const watched = service()
    watched.register('empty', { watchers: [] })
    watched.register('junk', null)
    expect(activeTreeWatchers()).toBe(baseline)
  })

  it('ignores registrations after close, and close() is idempotent', () => {
    const watched = service()
    watched.register('a', { watchers: [{ globPattern: '*' }] })
    watched.close()
    watched.close()
    watched.register('b', { watchers: [{ globPattern: '*' }] })
    expect(activeTreeWatchers()).toBe(baseline)
  })

  it('sends nothing for events that arrive after close', async () => {
    const watched = service(100)
    watched.register('a', { watchers: [{ globPattern: '**/*.go' }] })
    await sleep(50)
    writeFileSync(path.join(root, 'late.go'), 'x')
    await sleep(10)
    watched.close()
    await sleep(300)
    expect(sent).toEqual([])
  })

  it('warns instead of throwing when the root cannot be watched', () => {
    const warn = vi.fn()
    const missing = new WatchedFilesService({
      root: path.join(root, 'does-not-exist'),
      send: () => {},
      logger: { ...silentLogger, warn },
      debounceMs: 10
    })
    services.push(missing)
    missing.register('a', { watchers: [{ globPattern: '**/*.go' }] })
    // Linux watches lazily (a failing directory is skipped silently); macOS and
    // Windows throw from fs.watch and must be reported, not propagated.
    if (process.platform !== 'linux') {
      expect(warn).toHaveBeenCalledWith('could not watch files', expect.anything())
      expect(activeTreeWatchers()).toBe(baseline)
    }
  })
})

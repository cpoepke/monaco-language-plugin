import { bridgeUrl } from '@mlp/protocol'
import type { ClientFactory, LspClientLike } from './client-adapter'
import { createLog, INJECTOR_VERSION, readConfig } from './config'
import {
  type BridgeInfo,
  BridgeConnector,
  type InvokeCommand,
  noticeFor,
  sameEndpoint
} from './connector'
import { createOrcaHostAdapter, shouldAttachModel } from './host-adapter'
import { createNotifier, type Notifier } from './notice'
import { type EditorApiLike, RevealWatcher } from './reveal'
import { installMonacoTrap, type MonacoLike } from './trap'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export type BootDeps = {
  /** globalThis / window. */
  global: object
  document: Document | null
  localStorage: StorageLike | null
  sessionStorage: StorageLike | null
  createClient: ClientFactory
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  requestAnimationFrame: ((fn: () => void) => unknown) | null
  console: Pick<Console, 'log' | 'warn'>
}

export type InjectorStatus = {
  version: string
  disabled: boolean
  monacoCaptured: boolean
  envTrapped: boolean
  bridge: {
    state: string
    port: number | null
    pluginVersion: string | null
    hostNavigation: boolean | null
    error: { kind: string; message: string } | null
  }
  client: {
    created: boolean
    connection: string | null
    lastError: string | null
    /** Documents mirrored to the bridge (uri + attach state: pending/opening/open/no-session). */
    documents: { uri: string; state: string }[]
  }
  pendingReveal: string | null
}

function documentSummaries(
  documents: readonly unknown[] | undefined
): { uri: string; state: string }[] {
  if (!Array.isArray(documents)) return []
  return documents.flatMap((doc) => {
    const d = doc as { uri?: unknown; state?: unknown } | null
    return typeof d?.uri === 'string' ? [{ uri: d.uri, state: String(d.state) }] : []
  })
}

export type DebugHandle = {
  readonly version: string
  status(): InjectorStatus
  readonly monaco: unknown
}

type MonacoCaptured = MonacoLike & { editor: EditorApiLike }

const SETUP_NOTICE = 'bridge-setup'

export function boot(deps: BootDeps): DebugHandle {
  const g = deps.global as Record<string, unknown> & {
    api?: { plugins?: { invokeCommand?: InvokeCommand } }
  }
  const config = readConfig(deps.localStorage)
  const log = createLog(config.debug, deps.console)

  let monaco: MonacoCaptured | null = null
  let envTrapped = false
  let client: LspClientLike | null = null
  let lastUrlInfo: BridgeInfo | null = null
  let watcher: RevealWatcher | null = null
  let connector: BridgeConnector | null = null
  let notifier: Notifier | null = null

  const handle: DebugHandle = {
    version: INJECTOR_VERSION,
    get monaco() {
      return monaco
    },
    status(): InjectorStatus {
      const clientStatus = (() => {
        try {
          return client?.status() ?? null
        } catch {
          return null
        }
      })()
      const info = connector?.info ?? null
      return {
        version: INJECTOR_VERSION,
        disabled: config.disabled,
        monacoCaptured: monaco !== null,
        envTrapped,
        bridge: {
          state: connector?.state ?? 'idle',
          port: info?.port ?? null,
          pluginVersion: info?.pluginVersion ?? null,
          hostNavigation: info?.hostNavigation ?? null,
          error: connector?.lastError
            ? { kind: connector.lastError.kind, message: connector.lastError.message }
            : null
        },
        client: {
          created: client !== null,
          connection: clientStatus?.connection ?? null,
          lastError: clientStatus?.lastError ?? null,
          documents: documentSummaries(clientStatus?.documents)
        },
        pendingReveal: watcher?.pending?.uri ?? null
      }
    }
  }
  try {
    Object.defineProperty(g, '__mlp', { value: handle, configurable: true, writable: true })
  } catch {
    // ignore
  }
  if (config.disabled) {
    log.debug('disabled via localStorage mlp.disabled')
    return handle
  }

  notifier = createNotifier(deps.document, deps.sessionStorage, deps.setTimeout)
  const isVisible = (): boolean => deps.document?.visibilityState !== 'hidden'

  connector = new BridgeConnector({
    getInvoke: () => {
      const plugins = g.api?.plugins
      const fn = plugins?.invokeCommand
      return typeof fn === 'function' ? (args) => fn.call(plugins, args) : null
    },
    now: deps.now,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    isVisible,
    log: log.debug
  })

  const showSetupNotice = (): void => {
    const error = connector?.lastError
    if (!error || !monaco) return
    const { title, body } = noticeFor(error)
    notifier?.show({ once: SETUP_NOTICE, title, body })
  }

  const createClient = (): void => {
    if (!monaco || !watcher) return
    const reveal = watcher
    const host = createOrcaHostAdapter({
      request: (method, params) =>
        client ? client.request(method, params) : Promise.reject(new Error('client not ready')),
      watcher: reveal,
      notify: (title, body) => notifier?.show({ title, body, timeoutMs: 6_000 }),
      log: log.debug
    })
    // A second url() call from the same client is a reconnect: the endpoint it got before failed or
    // dropped (worker crashed or was reaped), so ask the plugin again instead of reusing a cached
    // ensureBridge result that still points at the dead bridge.
    let handedOut = false
    client = deps.createClient(monaco, {
      url: async () => {
        const reconnect = handedOut
        handedOut = true
        const info = await connector!.waitForInfo(reconnect ? 0 : undefined)
        lastUrlInfo = info
        return bridgeUrl(info.port, info.token)
      },
      host,
      shouldAttachModel,
      clientName: `orca-injector/${INJECTOR_VERSION}`,
      logger: {
        debug: log.debug,
        info: log.debug,
        warn: log.warn,
        error: log.warn
      }
    })
    client.ready.then(
      (hello) =>
        log.debug(
          `connected to bridge ${hello.bridgeVersion}; languages: ${hello.availableLanguages.join(', ')}`
        ),
      () => {}
    )
  }

  connector.onChange((c, previous) => {
    if (c.state === 'unavailable') {
      showSetupNotice()
      return
    }
    if (c.state !== 'available' || !client) return
    // Heartbeat found a different endpoint (worker restarted): a connected client is talking to a
    // stale bridge, so rebuild it; a disconnected client picks the new URL up on its next retry.
    if (previous && !sameEndpoint(previous, c.info) && !sameEndpoint(lastUrlInfo, c.info)) {
      let connected = false
      try {
        connected = client.status().connection === 'connected'
      } catch {
        connected = false
      }
      if (connected) {
        log.debug('bridge endpoint changed; recreating client')
        try {
          client.dispose()
        } catch {
          // ignore
        }
        client = null
        createClient()
      }
    }
  })

  const frame = (): Promise<void> =>
    new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (!done) {
          done = true
          resolve()
        }
      }
      try {
        deps.requestAnimationFrame?.(finish)
      } catch {
        // fall through to the timer
      }
      // rAF does not fire in hidden windows.
      deps.setTimeout(finish, 50)
    })

  const trap = installMonacoTrap<MonacoCaptured>(
    g,
    {
      onCapture: (m) => {
        monaco = m
        log.debug('Monaco captured')
        watcher = new RevealWatcher(m.editor, {
          now: deps.now,
          frame,
          log: log.debug,
          setTimeout: deps.setTimeout,
          clearTimeout: deps.clearTimeout
        })
        connector!.start()
        try {
          createClient()
        } catch (error) {
          log.warn(`client creation failed: ${String(error)}`)
        }
        connector!.startHeartbeat()
      }
    },
    { onError: (error, where) => log.warn(`trap ${where}: ${String(error)}`) }
  )
  envTrapped = trap.envTrapped

  try {
    deps.document?.addEventListener('visibilitychange', () => connector?.handleVisibilityChange())
  } catch {
    // ignore
  }
  return handle
}

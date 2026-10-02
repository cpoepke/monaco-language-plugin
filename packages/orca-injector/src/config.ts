export const INJECTOR_VERSION = '0.1.0'

export type InjectorConfig = { disabled: boolean; debug: boolean }

type StorageLike = Pick<Storage, 'getItem'>

const flag = (store: StorageLike | null, key: string): boolean => {
  try {
    return store?.getItem(key) === '1'
  } catch {
    return false
  }
}

/** `localStorage['mlp.disabled']='1'` turns the injector off; `['mlp.debug']='1'` logs to the console. */
export function readConfig(store: StorageLike | null): InjectorConfig {
  return { disabled: flag(store, 'mlp.disabled'), debug: flag(store, 'mlp.debug') }
}

export type Log = {
  debug(message: string): void
  warn(message: string): void
}

export function createLog(debug: boolean, sink: Pick<Console, 'log' | 'warn'> = console): Log {
  return {
    debug: (m) => {
      if (debug) sink.log(`[mlp] ${m}`)
    },
    warn: (m) => {
      // Warnings are only printed in debug mode too: the injector must stay quiet inside Orca.
      if (debug) sink.warn(`[mlp] ${m}`)
    }
  }
}

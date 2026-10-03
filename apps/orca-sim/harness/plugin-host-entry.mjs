// Child-process entry of the simulated plugin worker. A plain-JS port of Orca's
// src/main/plugins/plugin-host-entry.ts + plugin-host-runtime.ts (message loop, the `orca` API
// handed to `activate`, command results, host calls, shutdown → deactivate → exit). The zod
// schema validation of parent messages is reduced to a type check.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function send(message) {
  process.send?.(message)
}

function toErrorMessage(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

const commandHandlers = new Map()
const eventHandlers = new Map()
const pendingHostCalls = new Map()
let nextHostCallId = 0
let initialized = false
let shuttingDown = false
let deactivate = null

async function handleInit(input) {
  if (initialized) {
    send({ type: 'log', level: 'warn', message: 'ignoring duplicate init message' })
    return
  }
  initialized = true
  const entryUrl = pathToFileURL(join(input.pluginRoot, ...input.mainEntry.split(/[\\/]/))).href
  const module = await import(entryUrl)
  const activate = module?.default
  if (typeof activate !== 'function') {
    throw new Error(`plugin entry ${input.mainEntry} has no default-exported activate function`)
  }
  if (module.deactivate !== undefined && typeof module.deactivate !== 'function') {
    throw new Error(`plugin entry ${input.mainEntry} has a non-function deactivate export`)
  }
  deactivate = module.deactivate ?? null
  const orca = {
    commands: {
      register(commandId, handler) {
        commandHandlers.set(commandId, handler)
      }
    },
    events: {
      on(event, handler) {
        const handlers = eventHandlers.get(event) ?? []
        handlers.push(handler)
        eventHandlers.set(event, handlers)
      }
    },
    host: {
      call(method, params) {
        const callId = nextHostCallId++
        return new Promise((resolve, reject) => {
          pendingHostCalls.set(callId, { resolve, reject })
          send({ type: 'hostCall', callId, method, params })
        })
      }
    },
    grantedCapabilities: input.grantedCapabilities,
    log(message) {
      send({ type: 'log', level: 'info', message: String(message).slice(0, 8192) })
    }
  }
  await activate(orca)
  send({ type: 'ready', commands: [...commandHandlers.keys()] })
}

const PARENT_TYPES = new Set(['init', 'invokeCommand', 'deliverEvent', 'hostResult', 'shutdown'])

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || !PARENT_TYPES.has(message.type)) {
    send({ type: 'log', level: 'warn', message: 'ignoring malformed parent message' })
    return
  }
  try {
    switch (message.type) {
      case 'init': {
        await handleInit(message)
        return
      }
      case 'invokeCommand': {
        const handler = commandHandlers.get(message.commandId)
        if (!handler) {
          send({
            type: 'commandResult',
            callId: message.callId,
            ok: false,
            error: `no handler registered for command ${message.commandId}`
          })
          return
        }
        try {
          const value = await handler(message.args)
          send({ type: 'commandResult', callId: message.callId, ok: true, value })
        } catch (error) {
          send({
            type: 'commandResult',
            callId: message.callId,
            ok: false,
            error: toErrorMessage(error)
          })
        }
        return
      }
      case 'deliverEvent': {
        for (const handler of eventHandlers.get(message.event) ?? []) {
          try {
            await handler(message.payload)
          } catch (error) {
            send({ type: 'log', level: 'error', message: toErrorMessage(error) })
          }
        }
        send({ type: 'eventAck', eventId: message.eventId })
        return
      }
      case 'hostResult': {
        const pending = pendingHostCalls.get(message.callId)
        if (!pending) return
        pendingHostCalls.delete(message.callId)
        if (message.ok) {
          pending.resolve(message.value)
        } else {
          const error = new Error(message.error ?? 'host call failed')
          error.code = message.errorCode
          pending.reject(error)
        }
        return
      }
      case 'shutdown': {
        if (shuttingDown) return
        shuttingDown = true
        try {
          await deactivate?.()
        } catch (error) {
          send({ type: 'log', level: 'error', message: toErrorMessage(error).slice(0, 8192) })
        }
        process.exit(0)
      }
    }
  } catch (error) {
    send({ type: 'fatal', error: toErrorMessage(error) })
    process.exit(1)
  }
}

process.on('message', (raw) => {
  void handleMessage(raw)
})

function dieFatally(error) {
  try {
    send({
      type: 'fatal',
      error: error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
  } catch {
    // Channel already gone.
  }
  process.exit(1)
}

process.on('uncaughtException', dieFatally)
process.on('unhandledRejection', dieFatally)
process.on('disconnect', () => {
  process.exit(0)
})

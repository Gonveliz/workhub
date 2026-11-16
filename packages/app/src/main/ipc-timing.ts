import { performance } from 'node:perf_hooks'
import { redactText } from '@workhub/core'
import type { IpcRegistrar } from './ipc-guard'
import type { Activity } from './lag-monitor'
import type { Logger } from './log-file'

export interface IpcTimingOptions {
  log: Logger
  /** Every handler runs as a span named after its channel, so a stall can name it. */
  activity?: Activity
  /** A handler slower than this is logged (300 ms by default). */
  slowMs?: number
  now?: () => number
}

/**
 * Wraps the IPC registrar so every handler is timed: one slower than `slowMs` is logged with its
 * channel, its total time and the part it spent blocking the event loop before it first awaited;
 * one that throws is logged with its error. Never its arguments or result: they carry prompts,
 * messages and secrets.
 */
export function timeIpc(ipc: IpcRegistrar, options: IpcTimingOptions): IpcRegistrar {
  const now = options.now ?? (() => performance.now())
  const slowMs = options.slowMs ?? 300
  const report = (channel: string, start: number, syncMs: number) => {
    const totalMs = now() - start
    if (totalMs >= slowMs) options.log.warn(`ipc slow ${channel} total=${Math.round(totalMs)}ms sync=${Math.round(syncMs)}ms`)
  }
  const failed = (channel: string, err: unknown) => options.log.error(`ipc error ${channel}: ${describeError(err)}`)
  return {
    handle(channel, listener) {
      ipc.handle(channel, async (event, ...args) => {
        const end = options.activity?.begin(`ipc ${channel}`)
        const start = now()
        let syncMs = 0
        try {
          const pending = listener(event, ...args)
          syncMs = now() - start
          return await pending
        } catch (err) {
          failed(channel, err)
          throw err
        } finally {
          end?.()
          report(channel, start, syncMs || now() - start)
        }
      })
    },
    on(channel, listener) {
      ipc.on(channel, (event, ...args) => {
        const end = options.activity?.begin(`ipc ${channel}`)
        const start = now()
        try {
          listener(event, ...args)
        } catch (err) {
          failed(channel, err)
          throw err
        } finally {
          end?.()
          const ms = now() - start
          report(channel, start, ms)
        }
      })
    }
  }
}

/** The text with anything that looks like a token replaced, cut to `max` characters. */
export const redact = redactText

/** An error as one short, redacted line: its class and message, never its data. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return redact(`${err.name}: ${err.message}`)
  return redact(typeof err === 'string' ? err : 'non-error thrown')
}

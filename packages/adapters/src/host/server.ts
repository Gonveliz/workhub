// Host side of the host protocol: says hello, answers requests from a handler map, emits events.
import { hostErrorCodeSchema, type HostErrorCode, type HostHello, type HostMessage, type HostRequest } from '@workhub/core'
import type { HostChannel } from './channel'

/** Throw from a handler to answer with a specific code (`bad_params`, ...) instead of `internal`. */
export class HostHandlerError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'HostHandlerError'
  }
}

export interface HostHandlerContext {
  id: number
  /** Aborted when the channel closes, so long work can stop early. */
  signal: AbortSignal
}

export type HostHandler = (params: unknown, ctx: HostHandlerContext) => Promise<unknown> | unknown
export type HostHandlers = Record<string, HostHandler>

export type HostServerNotice = { kind: 'unexpected_message'; t: HostMessage['t'] }

export interface HostServerOptions {
  hello: Omit<HostHello, 't'>
  handlers: HostHandlers
  onNotice?: (notice: HostServerNotice) => void
}

// Any error whose `code` is a protocol code keeps it (a HostHandlerError, or one relayed from a
// nested host call); everything else is `internal`. Only the message crosses the wire, never a stack.
function toWireError(err: unknown): { code: HostErrorCode; message: string } {
  const code = hostErrorCodeSchema.safeParse((err as { code?: unknown } | null)?.code)
  const message = err instanceof Error ? err.message : String(err)
  return { code: code.success ? code.data : 'internal', message }
}

export class HostServer {
  private readonly inFlight = new Set<AbortController>()

  constructor(
    private readonly channel: HostChannel,
    private readonly options: HostServerOptions
  ) {
    channel.onMessage((msg) => {
      if (msg.t === 'req') void this.dispatch(msg)
      else options.onNotice?.({ kind: 'unexpected_message', t: msg.t })
    })
    channel.onClose(() => {
      for (const controller of this.inFlight) controller.abort(new Error('the host channel closed'))
      this.inFlight.clear()
    })
    channel.send({ t: 'hello', ...options.hello })
  }

  /** Sends an event to the app; false when closed or when the output is backed up (see HostChannel.send). */
  emit(event: string, payload?: unknown): boolean {
    return this.channel.send({ t: 'ev', ev: event, ...(payload === undefined ? {} : { p: payload }) })
  }

  close(): void {
    this.channel.close()
  }

  private async dispatch(req: HostRequest): Promise<void> {
    const handlers = this.options.handlers
    // Own properties only, so a method named `toString` is unknown rather than Object's.
    if (!Object.hasOwn(handlers, req.m)) return this.reply(req.id, { code: 'unknown_method', message: `unknown method: ${req.m}` })
    const controller = new AbortController()
    this.inFlight.add(controller)
    try {
      const result = await handlers[req.m]!(req.p, { id: req.id, signal: controller.signal })
      if (!controller.signal.aborted) this.reply(req.id, undefined, result)
    } catch (err) {
      if (!controller.signal.aborted) this.reply(req.id, toWireError(err))
    } finally {
      this.inFlight.delete(controller)
    }
  }

  private reply(id: number, error: { code: HostErrorCode; message: string } | undefined, result?: unknown): void {
    if (this.channel.closed) return
    try {
      this.channel.send(error ? { t: 'res', id, e: error } : { t: 'res', id, ...(result === undefined ? {} : { r: result }) })
    } catch (err) {
      // The result did not fit on one line: answer with an error the client can act on.
      this.channel.send({ t: 'res', id, e: { code: 'too_large', message: (err as Error).message } })
    }
  }
}

import type { AgentEvent } from '@workhub/core'

/** How long output waits for more before it goes out: about one frame, so a flood is one message per frame. */
export const OUTPUT_FLUSH_MS = 16
/** Characters after which pending output goes out without waiting for the timer. */
export const OUTPUT_FLUSH_CHARS = 64 * 1024

/** Whether the event is raw terminal output (`<session>:console`, `<session>:shell`), the only kind that is batched. */
const isTerminalOutput = (e: AgentEvent): e is Extract<AgentEvent, { type: 'output' }> => e.type === 'output' && e.sessionId.includes(':')

/**
 * Batches the raw output of terminal channels. A PTY under a flood (`yes`, a build log) emits
 * hundreds of chunks a second, and each one used to cost a message to every window. Here the chunks
 * of a channel are joined and sent at most every `OUTPUT_FLUSH_MS`, or at once when `OUTPUT_FLUSH_CHARS`
 * are pending. Order is kept per channel, and any other event of a channel (its exit) flushes the
 * channel's pending output first, so nothing is delivered after the event that ends it.
 * Every other event passes straight through.
 */
export class OutputCoalescer {
  private readonly pending = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deliver: (e: AgentEvent) => void,
    private readonly options: { flushMs?: number; flushChars?: number } = {}
  ) {}

  push(e: AgentEvent): void {
    if (!isTerminalOutput(e)) {
      if (e.sessionId.includes(':')) this.flush(e.sessionId)
      this.deliver(e)
      return
    }
    const data = (this.pending.get(e.sessionId) ?? '') + e.data
    this.pending.set(e.sessionId, data)
    if (data.length >= (this.options.flushChars ?? OUTPUT_FLUSH_CHARS)) this.flush(e.sessionId)
    else if (!this.timer) this.timer = setTimeout(() => this.flushAll(), this.options.flushMs ?? OUTPUT_FLUSH_MS)
  }

  /** Sends what one channel holds. */
  flush(channel: string): void {
    const data = this.pending.get(channel)
    if (data === undefined) return
    this.pending.delete(channel)
    if (this.pending.size === 0) this.stopTimer()
    this.deliver({ sessionId: channel, type: 'output', data })
  }

  /** Sends everything pending (the timer, and a session that is going away). */
  flushAll(): void {
    this.stopTimer()
    for (const channel of [...this.pending.keys()]) this.flush(channel)
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
